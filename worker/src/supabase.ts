// ============================================================
// Supabase client — Railway worker (pure CRUD, no realtime).
//
// WHY THE WEBSOCKET ERROR HAPPENED:
// @supabase/supabase-js v2 always constructs a RealtimeClient
// inside createClient(), even if you never call .channel().
// RealtimeClient tries to open a WebSocket connection on first use.
// Node 20 does not have a global WebSocket (it was added in Node 21),
// so supabase-js logs: "Using the ws package is deprecated..."
// and may fail if ws is not installed.
//
// THE FIX:
// 1. Install ws@8 (required by supabase-js for Node < 21).
// 2. Pass ws as the realtime transport in createClient options.
// 3. Disable auth persistence — not needed in a worker.
// 4. Use Node 20 built-in fetch explicitly.
// 5. Fetch all rows in JS and filter client-side to avoid
//    PostgREST NULL-handling bugs with .neq()/.or().
// ============================================================

import { createClient, SupabaseClient } from "@supabase/supabase-js";
import * as ws from "ws";

let _client: SupabaseClient | null = null;

export function getSupabase(): SupabaseClient {
  if (_client) return _client;

  const url =
    process.env.SUPABASE_URL ||
    process.env.NEXT_PUBLIC_SUPABASE_URL;

  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

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
    auth: {
      // Worker never needs an authenticated session
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
    realtime: {
      // Provide ws so Node 20 does not complain about missing WebSocket.
      // We never call .channel() so this connection is never actually opened.
      transport: ws.WebSocket as unknown as new (
        url: string,
        protocols?: string | string[]
      ) => WebSocket,
    },
    global: {
      // Use Node 20 built-in fetch (available since Node 18)
      fetch: fetch,
    },
  });

  console.log("[DB] Supabase client created (realtime transport=ws, no sessions)");
  return _client;
}

export interface ProbateLead {
  id: number;
  case_number: string;
  deceased_name: string | null;
  property_match_status: string | null;
}

/**
 * Fetch ALL probate rows, then filter eligibles in JavaScript.
 *
 * WHY JS FILTERING (not PostgREST):
 * PostgREST .neq("col","val") translates to SQL `col != 'val'`
 * which silently excludes NULLs (SQL NULL != anything = NULL/false).
 * .or() with .is.null has also been observed to drop rows in some
 * supabase-js/PostgREST version combinations.
 * Fetching all and filtering in JS is the only 100% reliable approach.
 *
 * Eligible = deceased_name is not null/empty
 *            AND property_match_status is NOT exactly "matched"
 *
 * Included statuses: null, "", "no_match", "error", "pending",
 *                    "processing", any other non-"matched" value.
 */
export async function fetchEligibleLeads(): Promise<ProbateLead[]> {
  const db = getSupabase();

  // ---- Step 1: Fetch ALL rows with no filter ----
  console.log("[DB] Fetching ALL probate_leads (no server-side filter)...");

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
    console.warn("[DB] Table is empty — run ingestion first.");
    return [];
  }

  // ---- Step 2: Log status breakdown ----
  const statusMap: Record<string, number> = {};
  for (const row of all) {
    const key = row.property_match_status === null ? "NULL" : `"${row.property_match_status}"`;
    statusMap[key] = (statusMap[key] ?? 0) + 1;
  }
  console.log("[DB] ── Status breakdown:", JSON.stringify(statusMap));

  // ---- Step 3: Filter — must have deceased_name ----
  const withName = all.filter(
    (r) =>
      r.deceased_name !== null &&
      r.deceased_name !== undefined &&
      r.deceased_name.trim().length > 0
  );
  console.log(`[DB] ── Rows with deceased_name: ${withName.length}`);

  // ---- Step 4: Exclude already matched ----
  const alreadyMatched = withName.filter(
    (r) => r.property_match_status === "matched"
  );
  console.log(`[DB] ── Rows excluded (status === "matched"): ${alreadyMatched.length}`);

  // ---- Step 5: Final eligible set ----
  // Include everything that is NOT exactly the string "matched"
  // This covers: null, "no_match", "error", "pending", "", undefined, etc.
  const eligible = withName.filter(
    (r) => r.property_match_status !== "matched"
  );
  console.log(`[DB] ── Final eligible rows: ${eligible.length}`);

  // Log first 5 for verification
  eligible.slice(0, 5).forEach((r) =>
    console.log(
      `[DB]    id=${r.id} case=${r.case_number} ` +
        `status=${r.property_match_status === null ? "NULL" : `"${r.property_match_status}"`} ` +
        `deceased="${r.deceased_name}"`
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

  console.log(
    `[DB] ✓ Updated id=${id}: "${address}, ${city}, ${state} ${zip ?? ""}"`
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
      `[DB] updateMatchStatus error id=${id}:`,
      JSON.stringify(error)
    );
  } else {
    console.log(`[DB] Set status="${status}" for id=${id}`);
  }
}
