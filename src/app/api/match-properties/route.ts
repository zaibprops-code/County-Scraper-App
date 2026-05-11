// ============================================================
// /api/match-properties — Property matching for probate leads
//
// GET /api/match-properties
//
// Behavior:
//   1. Fetch all probate leads from DB that have a deceased_name
//      and have NOT already been matched (property_match_status IS NULL)
//   2. For each lead: search HCPA by last name
//   3. Update matched_property_address columns
//   4. Return summary of matches
//
// Does NOT clear data. Does NOT re-ingest. Only updates.
// ============================================================

import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase";
import {
  findPropertyForDecedent,
  sleep,
  DELAY_MS,
} from "@/lib/propertyMatcher";
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
  console.log("[MatchProperties] ▶ Start property matching");
  const t0 = Date.now();
  const admin = getSupabaseAdmin();

  try {
    // Fetch all probate leads that haven't been matched yet
    const { data: leads, error: fetchErr } = await admin
      .from("probate_leads")
      .select("id,case_number,deceased_name,property_match_status")
      .is("property_match_status", null)
      .not("deceased_name", "is", null)
      .order("id", { ascending: true });

    if (fetchErr) {
      console.error("[MatchProperties] Fetch error:", fetchErr);
      throw new Error(fetchErr.message);
    }

    const rows = (leads ?? []) as ProbateRow[];
    console.log(`[MatchProperties] ${rows.length} unmatched probate lead(s) to process`);

    if (rows.length === 0) {
      return NextResponse.json({
        success: true,
        totalProcessed: 0,
        matched: 0,
        noMatch: 0,
        errors: 0,
        message: "No unmatched probate leads found. Run ingestion first, or all leads already matched.",
      } satisfies PropertyMatchResult);
    }

    let matched = 0;
    let noMatch = 0;
    let errors = 0;

    for (let i = 0; i < rows.length; i++) {
      const lead = rows[i];
      console.log(
        `[MatchProperties] Processing ${i + 1}/${rows.length}: lead id=${lead.id} case=${lead.case_number} deceased="${lead.deceased_name}"`
      );

      try {
        const property = await findPropertyForDecedent(lead.deceased_name, lead.id);

        if (property) {
          // Update with matched property address
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
            console.error(`[MatchProperties] Update error for lead ${lead.id}:`, updateErr);
            errors++;
          } else {
            console.log(`[MatchProperties] ✓ Matched lead ${lead.id}: ${property.address}, ${property.city}`);
            matched++;
          }
        } else {
          // Mark as no_match so we don't retry it endlessly
          await admin
            .from("probate_leads")
            .update({ property_match_status: "no_match" })
            .eq("id", lead.id);

          console.log(`[MatchProperties] ✗ No match for lead ${lead.id}`);
          noMatch++;
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[MatchProperties] Error processing lead ${lead.id}: ${msg}`);

        // Mark as error so we can retry later if needed
        await admin
          .from("probate_leads")
          .update({ property_match_status: "error" })
          .eq("id", lead.id);

        errors++;
      }

      // Rate limit: pause between requests to avoid hammering HCPA server
      if (i < rows.length - 1) {
        await sleep(DELAY_MS);
      }
    }

    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    const result: PropertyMatchResult = {
      success: true,
      totalProcessed: rows.length,
      matched,
      noMatch,
      errors,
      message: `Completed in ${elapsed}s`,
    };

    console.log("[MatchProperties] ✓ Done:", result);
    return NextResponse.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[MatchProperties] ✗ Fatal:", message);
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
