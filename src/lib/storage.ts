// ============================================================
// Database Storage
// Batch-inserts cleaned lead records into Supabase.
// Uses upsert with onConflict to silently skip duplicates.
// ============================================================

import { getSupabaseAdmin } from "./supabase";
import type { ProbateLead, ForeclosureLead } from "@/types/leads";

const BATCH_SIZE = 100;

/**
 * Insert probate leads in batches. Returns total inserted count.
 */
export async function storeProbateLeads(
  leads: ProbateLead[]
): Promise<number> {
  if (leads.length === 0) return 0;

  const admin = getSupabaseAdmin();
  let inserted = 0;

  for (let i = 0; i < leads.length; i += BATCH_SIZE) {
    const batch = leads.slice(i, i + BATCH_SIZE);

    const { data, error } = await admin
      .from("probate_leads")
      .upsert(batch, {
        onConflict: "case_number,source_file",
        ignoreDuplicates: true,
      })
      .select("id");

    if (error) {
      console.error(
        `[Storage] Probate batch ${i}–${i + batch.length} error:`,
        error
      );
    } else {
      inserted += data?.length ?? 0;
    }
  }

  console.log(`[Storage] Inserted ${inserted} probate leads`);
  return inserted;
}

/**
 * Insert foreclosure leads in batches. Returns total inserted count.
 */
export async function storeForeclosureLeads(
  leads: ForeclosureLead[]
): Promise<number> {
  if (leads.length === 0) return 0;

  const admin = getSupabaseAdmin();
  let inserted = 0;

  for (let i = 0; i < leads.length; i += BATCH_SIZE) {
    const batch = leads.slice(i, i + BATCH_SIZE);

    const { data, error } = await admin
      .from("foreclosure_leads")
      .upsert(batch, {
        onConflict: "case_number,source_file",
        ignoreDuplicates: true,
      })
      .select("id");

    if (error) {
      console.error(
        `[Storage] Foreclosure batch ${i}–${i + batch.length} error:`,
        error
      );
    } else {
      inserted += data?.length ?? 0;
    }
  }

  console.log(`[Storage] Inserted ${inserted} foreclosure leads`);
  return inserted;
}
