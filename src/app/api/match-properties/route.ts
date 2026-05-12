// ============================================================
// /api/match-properties — Property matching for probate leads
//
// Processes ALL probate rows that have a deceased_name,
// regardless of current property_match_status.
// Logs every row — fetched, eligible, skipped, processed.
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
    // ---- Step 1: Fetch ALL probate rows (no filter on match status) ----
    console.log("[MatchRoute] Fetching ALL probate_leads rows...");

    const { data: allRows, error: fetchErr, count } = await admin
      .from("probate_leads")
      .select("id,case_number,deceased_name,property_match_status", { count: "exact" })
      .order("id", { ascending: true });

    if (fetchErr) {
      console.error("[MatchRoute] Fetch error:", JSON.stringify(fetchErr));
      throw new Error(fetchErr.message);
    }

    const rows = (allRows ?? []) as ProbateRow[];
    console.log(`[MatchRoute] DB total probate rows (count from query): ${count ?? "unknown"}`);
    console.log(`[MatchRoute] Rows returned in data array: ${rows.length}`);

    // ---- Step 2: Log every row and classify ----
    const eligible: ProbateRow[] = [];
    const skippedNoName: ProbateRow[] = [];
    const skippedAlreadyMatched: ProbateRow[] = [];

    for (const row of rows) {
      const hasName = row.deceased_name && row.deceased_name.trim().length > 0;
      const alreadyMatched = row.property_match_status === "matched";

      console.log(
        `[MatchRoute] Row id=${row.id} case=${row.case_number} deceased="${row.deceased_name}" status="${row.property_match_status}" hasName=${hasName} alreadyMatched=${alreadyMatched}`
      );

      if (!hasName) {
        skippedNoName.push(row);
        console.log(`[MatchRoute]   → SKIP: no deceased_name`);
        continue;
      }

      if (alreadyMatched) {
        skippedAlreadyMatched.push(row);
        console.log(`[MatchRoute]   → SKIP: already matched`);
        continue;
      }

      eligible.push(row);
      console.log(`[MatchRoute]   → ELIGIBLE for matching`);
    }

    console.log(`[MatchRoute] Summary:`);
    console.log(`[MatchRoute]   Total rows fetched:        ${rows.length}`);
    console.log(`[MatchRoute]   Skipped (no name):         ${skippedNoName.length}`);
    console.log(`[MatchRoute]   Skipped (already matched): ${skippedAlreadyMatched.length}`);
    console.log(`[MatchRoute]   Eligible to process:       ${eligible.length}`);

    if (eligible.length === 0) {
      const msg =
        rows.length === 0
          ? "No probate leads in DB. Run ingestion first."
          : skippedAlreadyMatched.length === rows.length - skippedNoName.length
          ? "All eligible leads already matched."
          : "No eligible leads found (all have no deceased_name or are already matched).";

      console.log(`[MatchRoute] Nothing to process: ${msg}`);
      return NextResponse.json({
        success: true,
        totalProcessed: 0,
        matched: 0,
        noMatch: 0,
        errors: 0,
        message: msg,
      } satisfies PropertyMatchResult);
    }

    // ---- Step 3: Process eligible rows ----
    let matched = 0;
    let noMatch = 0;
    let errors = 0;

    for (let i = 0; i < eligible.length; i++) {
      const lead = eligible[i];
      console.log(
        `[MatchRoute] Processing ${i + 1}/${eligible.length}: id=${lead.id} case=${lead.case_number} deceased="${lead.deceased_name}"`
      );

      try {
        const property = await findPropertyForDecedent(lead.deceased_name, lead.id);

        if (property) {
          const { error: updateErr } = await admin
            .from("probate_leads")
            .update({
              matched_property_address: property.address,
              matched_property_city: property.city,
              matched_property_state: property.state,
              matched_property_zip: property.zip,
              property_match_status: "matched",
            })
            .eq("id", lead.id);

          if (updateErr) {
            console.error(`[MatchRoute] Update error lead ${lead.id}:`, JSON.stringify(updateErr));
            errors++;
          } else {
            console.log(`[MatchRoute] ✓ MATCHED lead ${lead.id}: "${property.address}, ${property.city}"`);
            matched++;
          }
        } else {
          const { error: noMatchErr } = await admin
            .from("probate_leads")
            .update({ property_match_status: "no_match" })
            .eq("id", lead.id);

          if (noMatchErr) {
            console.error(`[MatchRoute] no_match update error lead ${lead.id}:`, JSON.stringify(noMatchErr));
          }
          console.log(`[MatchRoute] ✗ no_match lead ${lead.id}`);
          noMatch++;
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[MatchRoute] EXCEPTION lead ${lead.id}: ${msg}`);

        await admin
          .from("probate_leads")
          .update({ property_match_status: "error" })
          .eq("id", lead.id)
          .then(({ error: e }) => { if (e) console.error(`[MatchRoute] error-status update failed:`, e); });

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
      message: `Completed in ${elapsed}s. Fetched=${rows.length} Eligible=${eligible.length} SkippedNoName=${skippedNoName.length} SkippedAlreadyMatched=${skippedAlreadyMatched.length}`,
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
