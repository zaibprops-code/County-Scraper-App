// ============================================================
// Database Storage — batch upsert into Supabase.
// Deduplicates on case_number globally across all source files.
// Requires migration 002 (UNIQUE constraint on case_number alone).
// ============================================================

import { getSupabaseAdmin } from "./supabase";
import type { ProbateLead, ForeclosureLead } from "@/types/leads";

const BATCH_SIZE = 50;

export async function storeProbateLeads(leads: ProbateLead[]): Promise<number> {
  if (leads.length === 0) {
    console.log("[Storage] No probate leads to insert");
    return 0;
  }

  const admin = getSupabaseAdmin();
  let inserted = 0;

  console.log(`[Storage] Inserting ${leads.length} probate leads in batches of ${BATCH_SIZE}`);

  for (let i = 0; i < leads.length; i += BATCH_SIZE) {
    const batch = leads.slice(i, i + BATCH_SIZE);
    const batchNum = Math.floor(i / BATCH_SIZE) + 1;

    console.log(
      `[Storage] Probate batch ${batchNum}: ${batch.length} records (cases: ${batch.map((l) => l.case_number).join(", ")})`
    );

    const { data, error } = await admin
      .from("probate_leads")
      .upsert(batch, {
        onConflict: "case_number",
        ignoreDuplicates: true,
      })
      .select("id");

    if (error) {
      console.error(`[Storage] Probate batch ${batchNum} ERROR:`, JSON.stringify(error));
    } else {
      const count = data?.length ?? 0;
      inserted += count;
      console.log(`[Storage] Probate batch ${batchNum}: inserted ${count} new records`);
    }
  }

  console.log(`[Storage] Probate total inserted: ${inserted} of ${leads.length}`);
  return inserted;
}

export async function storeForeclosureLeads(
  leads: ForeclosureLead[]
): Promise<number> {
  if (leads.length === 0) {
    console.log("[Storage] No foreclosure leads to insert");
    return 0;
  }

  const admin = getSupabaseAdmin();
  let inserted = 0;

  console.log(
    `[Storage] Inserting ${leads.length} foreclosure leads in batches of ${BATCH_SIZE}`
  );

  for (let i = 0; i < leads.length; i += BATCH_SIZE) {
    const batch = leads.slice(i, i + BATCH_SIZE);
    const batchNum = Math.floor(i / BATCH_SIZE) + 1;

    console.log(
      `[Storage] Foreclosure batch ${batchNum}: ${batch.length} records (cases: ${batch.map((l) => l.case_number).join(", ")})`
    );

    const { data, error } = await admin
      .from("foreclosure_leads")
      .upsert(batch, {
        onConflict: "case_number",
        ignoreDuplicates: true,
      })
      .select("id");

    if (error) {
      console.error(
        `[Storage] Foreclosure batch ${batchNum} ERROR:`,
        JSON.stringify(error)
      );
    } else {
      const count = data?.length ?? 0;
      inserted += count;
      console.log(
        `[Storage] Foreclosure batch ${batchNum}: inserted ${count} new records`
      );
    }
  }

  console.log(`[Storage] Foreclosure total inserted: ${inserted} of ${leads.length}`);
  return inserted;
}
