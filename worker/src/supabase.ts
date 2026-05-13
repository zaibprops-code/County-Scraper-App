// ============================================================
// Supabase client for the Railway worker.
// Uses service role key — always bypasses RLS.
//
// FIXES:
// 1. Accepts both SUPABASE_URL and NEXT_PUBLIC_SUPABASE_URL
//    so Railway env vars don't need to match Vercel naming exactly.
// 2. Replaces .neq("property_match_status", "matched") with an
//    explicit OR filter that includes NULL rows — PostgREST's neq
//    operator excludes NULLs in SQL, so rows never yet attempted
//    (status = NULL) were silently dropped.
// ============================================================

import { createClient, SupabaseClient } from "@supabase/supabase-js";

let _client: SupabaseClient | null = null;

export function getSupabase(): SupabaseClient {
  if (_client) return _client;

  // Accept either naming convention so Railway and Vercel both work
  const url =
    process.env.SUPABASE_URL ||
    process.env.NEXT_PUBLIC_SUPABASE_URL;

  const key =
    process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url) {
    throw new Error(
      "Missing env: SUPABASE_URL (or NEXT_PUBLIC_SUPABASE_URL). " +
      "Set this in Railway → Variables."
    );
  }
  if (!key) {
    throw new Error(
      "Missing env: SUPABASE_SERVICE_ROLE_KEY. " +
      "Set this in Railway → Variables."
    );
  }

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
 * Eligible = deceased_name is NOT NULL
 *            AND property_match_status is NOT 'matched'
 *
 * IMPORTANT: We use .or("property_match_status.is.null,...") instead of
 * .neq("property_match_status","matched") because PostgREST's neq translates
 * to SQL != which excludes NULLs — rows with status=NULL (never attempted)
 * would be silently dropped, returning 0 eligible rows even when leads exist.
 */
export async function fetchEligibleLeads(): Promise<ProbateLead[]> {
  const db = getSupabase();

  // Step 1: log raw total with NO filters to verify connection + table
  const { count: rawCount, error: rawErr } = await db
    .from("probate_leads")
    .select("*", { count: "exact", head: true });

  if (rawErr) {
    console.error("[DB] Raw count error:", JSON.stringify(rawErr));
    throw new Error(rawErr.message);
  }
  console.log(`[DB] Total rows in probate_leads (no filter): ${rawCount ?? "error"}`);

  if ((rawCount ?? 0) === 0) {
    console.warn(
      "[DB] probate_leads table is empty. " +
      "Run ingestion on the Vercel dashboard first, then trigger matching."
    );
    return [];
  }

  // Step 2: log how many have a deceased_name
  const { count: nameCount, error: nameErr } = await db
    .from("probate_leads")
    .select("*", { count: "exact", head: true })
    .not("deceased_name", "is", null);

  if (nameErr) {
    console.error("[DB] Name count error:", JSON.stringify(nameErr));
  } else {
    console.log(`[DB] Rows with non-null deceased_name: ${nameCount ?? "error"}`);
  }

  // Step 3: log how many are already matched
  const { count: matchedCount, error: matchedErr } = await db
    .from("probate_leads")
    .select("*", { count: "exact", head: true })
    .eq("property_match_status", "matched");

  if (matchedErr) {
    console.error("[DB] Matched count error:", JSON.stringify(matchedErr));
  } else {
    console.log(`[DB] Rows already matched: ${matchedCount ?? "error"}`);
  }

  // Step 4: fetch eligible rows
  // Use .or() to correctly handle NULL status alongside other non-matched values.
  // SQL equivalent:
  //   WHERE deceased_name IS NOT NULL
  //   AND (property_match_status IS NULL
  //        OR property_match_status = 'no_match'
  //        OR property_match_status = 'error')
  const { data, error, count } = await db
    .from("probate_leads")
    .select("id,case_number,deceased_name,property_match_status", {
      count: "exact",
    })
    .not("deceased_name", "is", null)
    .or(
      "property_match_status.is.null," +
      "property_match_status.eq.no_match," +
      "property_match_status.eq.error"
    )
    .order("id", { ascending: true });

  if (error) {
    console.error("[DB] fetchEligibleLeads error:", JSON.stringify(error));
    throw new Error(error.message);
  }

  const rows = (data ?? []) as ProbateLead[];
  console.log(`[DB] Eligible leads (null/no_match/error status + has name): ${count ?? rows.length}`);

  // Log first few for verification
  rows.slice(0, 3).forEach((r) =>
    console.log(
      `[DB]   id=${r.id} case=${r.case_number} deceased="${r.deceased_name}" status="${r.property_match_status ?? "null"}"`
    )
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
    `[DB] ✓ Updated lead id=${id}: "${address}, ${city}, ${state} ${zip ?? ""}"`
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
