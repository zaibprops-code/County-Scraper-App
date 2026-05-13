// ============================================================
// Supabase client for the Railway worker.
// Uses service role key — always bypasses RLS.
// Fixed for Node.js 20 websocket support.
// ============================================================

import { createClient, SupabaseClient } from "@supabase/supabase-js";
import ws from "ws";

let _client: SupabaseClient | null = null;

export function getSupabase(): SupabaseClient {
  if (_client) return _client;

  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url) throw new Error("Missing env: SUPABASE_URL");
  if (!key) throw new Error("Missing env: SUPABASE_SERVICE_ROLE_KEY");

  _client = createClient(url, key, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
    realtime: {
      transport: ws as any,
    },
  });

  return _client;
}

export interface ProbateLead {
  id: number;
  case_number: string;
  deceased_name: string | null;
  property_match_status: string | null;
}

/**
 * Fetch all probate leads that are eligible for property matching.
 * Eligible = has deceased_name AND is NOT already "matched".
 */
export async function fetchEligibleLeads(): Promise<ProbateLead[]> {
  const db = getSupabase();

  const { data, error, count } = await db
    .from("probate_leads")
    .select("id,case_number,deceased_name,property_match_status", {
      count: "exact",
    })
    .not("deceased_name", "is", null)
    .neq("property_match_status", "matched")
    .order("id", { ascending: true });

  if (error) {
    console.error("[DB] fetchEligibleLeads error:", JSON.stringify(error));
    throw new Error(error.message);
  }

  const rows = (data ?? []) as ProbateLead[];

  console.log(`[DB] Total probate rows (count): ${count ?? "unknown"}`);
  console.log(
    `[DB] Eligible for matching (not-null name, not matched): ${rows.length}`
  );

  return rows;
}

/**
 * Update a probate lead with matched property address.
 */
export async function updateMatchedProperty(
  id: number,
  address: string,
  city: string,
  state: string,
  zip: string | null
): Promise<void> {
  const db = getSupabase();

  const { error } = await db
    .from("probate_leads")
    .update({
      matched_property_address: address,
      matched_property_city: city,
      matched_property_state: state,
      matched_property_zip: zip,
      property_match_status: "matched",
    })
    .eq("id", id);

  if (error) {
    console.error(
      `[DB] updateMatchedProperty error for id=${id}:`,
      JSON.stringify(error)
    );
    throw new Error(error.message);
  }

  console.log(
    `[DB] Updated lead id=${id}: ${address}, ${city}, ${state} ${zip}`
  );
}

/**
 * Mark a lead as no_match or error.
 */
export async function updateMatchStatus(
  id: number,
  status: "no_match" | "error"
): Promise<void> {
  const db = getSupabase();

  const { error } = await db
    .from("probate_leads")
    .update({ property_match_status: status })
    .eq("id", id);

  if (error) {
    console.error(
      `[DB] updateMatchStatus error for id=${id}:`,
      JSON.stringify(error)
    );
  } else {
    console.log(`[DB] Set status="${status}" for lead id=${id}`);
  }
}
