// ============================================================
// Database Storage — batch insert and full clear.
// ============================================================

import { getSupabaseAdmin } from "./supabase";
import type { ProbateLead, ForeclosureLead } from "@/types/leads";

const BATCH_SIZE = 50;

// ---- Insert probate leads ------------------------------------

export async function storeProbateLeads(leads: ProbateLead[]): Promise<number> {
  if (leads.length === 0) {
    console.log("[Storage] No probate leads to insert");
    return 0;
  }

  const admin = getSupabaseAdmin();
  let inserted = 0;

  console.log(`[Storage] Inserting ${leads.length} probate leads`);

  for (let i = 0; i < leads.length; i += BATCH_SIZE) {
    const batch = leads.slice(i, i + BATCH_SIZE);
    const batchNum = Math.floor(i / BATCH_SIZE) + 1;

    const { data, error } = await admin
      .from("probate_leads")
      .upsert(batch, { onConflict: "case_number", ignoreDuplicates: true })
      .select("id");

    if (error) {
      console.error(`[Storage] Probate batch ${batchNum} error:`, JSON.stringify(error));
    } else {
      const count = data?.length ?? 0;
      inserted += count;
      console.log(`[Storage] Probate batch ${batchNum}: ${count} inserted`);
    }
  }

  console.log(`[Storage] Probate done: ${inserted}/${leads.length}`);
  return inserted;
}

// ---- Insert foreclosure leads --------------------------------

export async function storeForeclosureLeads(
  leads: ForeclosureLead[]
): Promise<number> {
  if (leads.length === 0) {
    console.log("[Storage] No foreclosure leads to insert");
    return 0;
  }

  const admin = getSupabaseAdmin();
  let inserted = 0;

  console.log(`[Storage] Inserting ${leads.length} foreclosure leads`);

  for (let i = 0; i < leads.length; i += BATCH_SIZE) {
    const batch = leads.slice(i, i + BATCH_SIZE);
    const batchNum = Math.floor(i / BATCH_SIZE) + 1;

    const { data, error } = await admin
      .from("foreclosure_leads")
      .upsert(batch, { onConflict: "case_number", ignoreDuplicates: true })
      .select("id");

    if (error) {
      console.error(`[Storage] Foreclosure batch ${batchNum} error:`, JSON.stringify(error));
    } else {
      const count = data?.length ?? 0;
      inserted += count;
      console.log(`[Storage] Foreclosure batch ${batchNum}: ${count} inserted`);
    }
  }

  console.log(`[Storage] Foreclosure done: ${inserted}/${leads.length}`);
  return inserted;
}

// ---- Clear all leads (session reset) -------------------------

export async function clearAllLeads(): Promise<void> {
  const admin = getSupabaseAdmin();

  console.log("[Storage] Clearing all tables...");

  const [p, f, pf] = await Promise.all([
    admin.from("probate_leads").delete().neq("id", 0),
    admin.from("foreclosure_leads").delete().neq("id", 0),
    admin.from("processed_files").delete().neq("id", 0),
  ]);

  if (p.error) console.error("[Storage] Clear probate_leads error:", p.error);
  else console.log("[Storage] probate_leads cleared");

  if (f.error) console.error("[Storage] Clear foreclosure_leads error:", f.error);
  else console.log("[Storage] foreclosure_leads cleared");

  if (pf.error) console.error("[Storage] Clear processed_files error:", pf.error);
  else console.log("[Storage] processed_files cleared");
}
