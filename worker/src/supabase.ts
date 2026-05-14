// ============================================================
// Supabase client for the Railway worker.
// Uses service role key — always bypasses RLS.
//
// fetchEligibleLeads fetches ALL probate rows then filters
// in JavaScript to avoid PostgREST NULL-handling quirks where
// .neq() and .or() both silently drop NULL rows in some versions.
// ============================================================

import { createClient, SupabaseClient } from "@supabase/supabase-js";

let _client: SupabaseClient | null = null;

export function getSupabase(): SupabaseClient {
  if (_client) return _client;

  const url =
    process.env.SUPABASE_URL ||
    process.env.NEXT_PUBLIC_SUPABASE_URL;

  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url) throw new Error("Missing env: SUPABASE_URL (or NEXT_PUBLIC_SUPABASE_URL)");
  if (!key) throw new Error("Missing env: SUPABASE_SERVICE_ROLE_KEY");

  console.log(`[DB] Connecting to Supabase: ${url}`);

  _client = createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
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
 * Fetch all probate leads eligible for property matching.
 *
 * Eligible = deceased_name is NOT NULL/empty
 *            AND property_match_status is NOT exactly "matched"
 *
 * Includes rows with status: null, "", "no_match", "error",
 * "pending", "processing", or any other non-"matched" value.
 *
 * Filtering is done in JavaScript (not PostgREST) to avoid
 * the well-known issue where .neq() and .or() silently exclude
 * NULL rows in PostgREST SQL translation.
 */
export async function fetchEligibleLeads(): Promise<ProbateLead[]> {
  const db = getSupabase();

  // Fetch ALL rows — no server-side filter at all
  console.log("[DB] Fetching ALL probate_leads rows (no filter)...");

  const { data, error, count } = await db
    .from("probate_leads")
    .select("id,case_number,deceased_name,property_match_status", {
      count: "exact",
    })
    .order("id", { ascending: true });

  if (error) {
    console.error("[DB] Fetch error:", JSON.stringify(error));
    throw new Error(error.message);
  }

  const all = (data ?? []) as ProbateLead[];
  console.log(`[DB] ── Total rows in probate_leads: ${count ?? all.length}`);

  if (all.length === 0) {
    console.warn("[DB] Table is empty. Run ingestion first.");
    return [];
  }

  // Log all statuses for visibility
  const statusCounts: Record<string, number> = {};
  for (const row of all) {
    const s = row.property_match_status ?? "NULL";
    statusCounts[s] = (statusCounts[s] ?? 0) + 1;
  }
  console.log("[DB] ── Status breakdown:", JSON.stringify(statusCounts));

  // Filter 1: must have a deceased_name
  const withName = all.filter(
    (r) => r.deceased_name !== null && r.deceased_name !== undefined && r.deceased_name.trim().length > 0
  );
  console.log(`[DB] ── Rows with deceased_name: ${withName.length}`);

  // Filter 2: exclude only rows where status === "matched" (exact string match)
  const alreadyMatched = withName.filter((r) => r.property_match_status === "matched");
  console.log(`[DB] ── Rows excluded (already matched): ${alreadyMatched.length}`);

  const eligible = withName.filter((r) => r.property_match_status !== "matched");
  console.log(`[DB] ── Final eligible rows: ${eligible.length}`);

  // Log first 5 eligible rows for verification
  eligible.slice(0, 5).forEach((r) =>
    console.log(
      `[DB]    id=${r.id} case=${r.case_number} status="${r.property_match_status ?? "NULL"}" deceased="${r.deceased_name}"`
    )
  );

  return eligible;
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
    console.error(`[DB] updateMatchedProperty error id=${id}:`, JSON.stringify(error));
    throw new Error(error.message);
  }

  console.log(`[DB] ✓ Updated id=${id}: "${address}, ${city}, ${state} ${zip ?? ""}"`);
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
    console.error(`[DB] updateMatchStatus error id=${id}:`, JSON.stringify(error));
  } else {
    console.log(`[DB] Set status="${status}" for id=${id}`);
  }
}
