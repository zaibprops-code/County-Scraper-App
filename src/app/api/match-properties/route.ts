// ============================================================
// /api/match-properties — Probate property matching
//
// STAGE 1: Fetches ALL probate rows (no status filter on fetch).
// Logs every row: fetched, skip reason, eligible count.
// Skips only rows with no deceased_name OR already "matched".
// Rows with status "no_match" / "error" / null are re-processed.
// STAGE 5: Logs every Supabase update response.
// ============================================================

import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase";
import { findPropertyForDecedent, sleep, DELAY_MS } from "@/lib/propertyMatcher";
import type { PropertyMatchResult } from "@/types/leads";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

interface ProbateRow {
  id: number;
  case_number: string;
  deceased_name: string | null;
  property_match_status: string | null;
}

export async function GET(): Promise<NextResponse> {
  console.log("[MatchRoute] ===== START =====");
  const t0 = Date.now();
  const admin = getSupabaseAdmin();

  try {
    // ---- STAGE 1: Fetch ALL probate rows with no row limit ----
    console.log("[MatchRoute] STAGE1: fetching ALL probate_leads rows...");

    const { data: allRows, error: fetchErr, count } = await admin
      .from("probate_leads")
      .select("id,case_number,deceased_name,property_match_status", {
        count: "exact",
      })
      .order("id", { ascending: true });
    // NOTE: No .limit(), no .is() filter — fetch everything.

    if (fetchErr) {
      console.error("[MatchRoute] STAGE1 fetch error:", JSON.stringify(fetchErr));
      throw new Error(fetchErr.message);
    }

    const rows = (allRows ?? []) as ProbateRow[];

    console.log(`[MatchRoute] STAGE1: Supabase count=${count ?? "unknown"}`);
    console.log(`[MatchRoute] STAGE1: rows in data array: ${rows.length}`);

    if (rows.length === 0) {
      return NextResponse.json({
        success: true,
        totalProcessed: 0,
        matched: 0,
        noMatch: 0,
        errors: 0,
        message: "No probate leads in DB. Run ingestion first.",
      } satisfies PropertyMatchResult);
    }

    // ---- Classify every row ----
    const eligible: ProbateRow[] = [];
    let skippedNoName = 0;
    let skippedAlreadyMatched = 0;

    for (const row of rows) {
      const hasName =
        row.deceased_name !== null &&
        row.deceased_name !== undefined &&
        row.deceased_name.trim().length > 0;
      const alreadyMatched = row.property_match_status === "matched";

      console.log(
        `[MatchRoute] STAGE1 row id=${row.id} case=${row.case_number} ` +
          `deceased="${row.deceased_name ?? "NULL"}" status="${row.property_match_status ?? "null"}" ` +
          `hasName=${hasName} alreadyMatched=${alreadyMatched}`
      );

      if (!hasName) {
        skippedNoName++;
        console.log(`[MatchRoute]   → SKIP: no deceased_name`);
        continue;
      }
      if (alreadyMatched) {
        skippedAlreadyMatched++;
        console.log(`[MatchRoute]   → SKIP: already matched`);
        continue;
      }

      eligible.push(row);
      console.log(`[MatchRoute]   → ELIGIBLE`);
    }

    console.log(`[MatchRoute] STAGE1 summary:`);
    console.log(`[MatchRoute]   Total fetched:          ${rows.length}`);
    console.log(`[MatchRoute]   Skipped (no name):      ${skippedNoName}`);
    console.log(`[MatchRoute]   Skipped (matched):      ${skippedAlreadyMatched}`);
    console.log(`[MatchRoute]   Eligible to process:    ${eligible.length}`);

    if (eligible.length === 0) {
      const detail =
        skippedAlreadyMatched > 0
          ? "All eligible leads already matched."
          : "All probate leads lack a deceased_name — check parser.";
      console.log(`[MatchRoute] Nothing to process: ${detail}`);
      return NextResponse.json({
        success: true,
        totalProcessed: 0,
        matched: 0,
        noMatch: 0,
        errors: 0,
        message: detail,
      } satisfies PropertyMatchResult);
    }

    // ---- STAGE 2-4: Process each eligible row ----
    let matched = 0;
    let noMatch = 0;
    let errors = 0;

    for (let i = 0; i < eligible.length; i++) {
      const lead = eligible[i];
      console.log(
        `[MatchRoute] Processing ${i + 1}/${eligible.length}: ` +
          `id=${lead.id} case=${lead.case_number} deceased="${lead.deceased_name}"`
      );

      try {
        const property = await findPropertyForDecedent(
          lead.deceased_name,
          lead.id
        );

        if (property) {
          // ---- STAGE 5: Update matched address ----
          console.log(
            `[MatchRoute] STAGE5 updating lead ${lead.id} with: ` +
              `addr="${property.address}" city="${property.city}" zip="${property.zip}"`
          );

          const { data: updateData, error: updateErr } = await admin
            .from("probate_leads")
            .update({
              matched_property_address: property.address,
              matched_property_city: property.city,
              matched_property_state: property.state,
              matched_property_zip: property.zip,
              property_match_status: "matched",
            })
            .eq("id", lead.id)
            .select("id");

          if (updateErr) {
            console.error(
              `[MatchRoute] STAGE5 update ERROR lead ${lead.id}:`,
              JSON.stringify(updateErr)
            );
            errors++;
          } else {
            console.log(
              `[MatchRoute] STAGE5 update OK lead ${lead.id}: ` +
                `rows affected=${updateData?.length ?? 0}`
            );
            matched++;
          }
        } else {
          // Mark no_match
          const { error: nmErr } = await admin
            .from("probate_leads")
            .update({ property_match_status: "no_match" })
            .eq("id", lead.id);

          if (nmErr) {
            console.error(
              `[MatchRoute] no_match update error lead ${lead.id}:`,
              JSON.stringify(nmErr)
            );
          } else {
            console.log(`[MatchRoute] ✗ no_match lead ${lead.id}`);
          }
          noMatch++;
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[MatchRoute] EXCEPTION lead ${lead.id}: ${msg}`);

        await admin
          .from("probate_leads")
          .update({ property_match_status: "error" })
          .eq("id", lead.id);

        errors++;
      }

      if (i < eligible.length - 1) {
        await sleep(DELAY_MS);
      }
    }

    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    const result: PropertyMatchResult = {
      success: true,
      totalProcessed: eligible.length,
      matched,
      noMatch,
      errors,
      message:
        `Done in ${elapsed}s — ` +
        `Fetched=${rows.length} Eligible=${eligible.length} ` +
        `SkippedNoName=${skippedNoName} SkippedAlreadyMatched=${skippedAlreadyMatched}`,
    };

    console.log("[MatchRoute] ✓ Done:", result);
    console.log("[MatchRoute] ===== END =====");
    return NextResponse.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[MatchRoute] ✗ FATAL:", message);
    return NextResponse.json(
      {
        success: false,
        totalProcessed: 0,
        matched: 0,
        noMatch: 0,
        errors: 1,
        error: message,
      } satisfies PropertyMatchResult,
      { status: 500 }
    );
  }
}
