// ============================================================
// Supabase client — Railway worker (pure CRUD, no realtime).
//
// ROOT CAUSE OF "Node.js 20 detected without native WebSocket":
// @supabase/supabase-js v2 always constructs a RealtimeClient
// inside createClient(), even when you never use .channel().
// RealtimeClient needs a WebSocket constructor. Node 20 does NOT
// have a global `WebSocket` (added in Node 21). So supabase-js
// emits the warning and realtime silently breaks.
//
// THE PERMANENT FIX:
// Pass `ws.WebSocket` as the `transport` inside the `realtime`
// option of createClient(). This gives supabase-js a valid
// WebSocket constructor and suppresses the warning entirely.
// ws@8 is the correct version for supabase-js v2.
//
// FILTERING FIX:
// PostgREST .neq("col","val") maps to SQL `col != 'val'`
// which silently drops NULL rows (SQL: NULL != 'x' = NULL = false).
// We fetch ALL rows and filter in JavaScript to guarantee NULLs
// are included in the eligible set.
// ============================================================

import { createClient, SupabaseClient } from "@supabase/supabase-js";
import { WebSocket as WsWebSocket } from "ws";

let _client: SupabaseClient | null = null;

export function getSupabase(): SupabaseClient {
  if (_client) return _client;

  // Accept both naming conventions (Railway = SUPABASE_URL, Vercel = NEXT_PUBLIC_*)
  const url =
    process.env.SUPABASE_URL ||
    process.env.NEXT_PUBLIC_SUPABASE_URL;

  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url) {
    throw new Error(
      "Missing env var: SUPABASE_URL (or NEXT_PUBLIC_SUPABASE_URL). " +
        "Add it in Railway → Variables."
    );
  }
  if (!key) {
    throw new Error(
      "Missing env var: SUPABASE_SERVICE_ROLE_KEY. " +
        "Add it in Railway → Variables."
    );
  }

  console.log(`[DB] Connecting to Supabase at: ${url}`);

  _client = createClient(url, key, {
    auth: {
      // Worker has no user session — disable all auth state management
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
    realtime: {
      // Provide ws.WebSocket as the transport constructor.
      // This resolves "Node.js 20 detected without native WebSocket support".
      // We never call .channel() so no actual socket connection is opened.
      transport: WsWebSocket as unknown as new (
        url: string,
        protocols?: string | string[]
      ) => WebSocket,
    },
    global: {
      // Use Node 18+ built-in fetch — no polyfill needed
      fetch: fetch,
    },
  });

  console.log(
    "[DB] Supabase client ready (ws transport supplied, realtime never used)"
  );
  return _client;
}

// ---- Types -------------------------------------------------

export interface ProbateLead {
  id: number;
  case_number: string;
  deceased_name: string | null;
  property_match_status: string | null;
}

// ---- Queries -----------------------------------------------

/**
 * Fetch ALL probate rows from Supabase, then filter eligible
 * rows entirely in JavaScript.
 *
 * Eligible = deceased_name is not null/empty
 *            AND property_match_status is NOT exactly "matched"
 *
 * Included statuses (all non-"matched"):
 *   null, "no_match", "error", "pending", "processing", ""
 *
 * Debug logs printed at every filtering step.
 */
export async function fetchEligibleLeads(): Promise<ProbateLead[]> {
  const db = getSupabase();

  console.log("[DB] Fetching ALL rows from probate_leads (no server filter)...");

  const { data, error, count } = await db
    .from("probate_leads")
    .select("id,case_number,deceased_name,property_match_status", {
      count: "exact",
    })
    .order("id", { ascending: true });

  if (error) {
    console.error("[DB] Fetch error:", JSON.stringify(error));
    throw new Error(`Supabase fetch failed: ${error.message}`);
  }

  const all = (data ?? []) as ProbateLead[];

  // ── Log 1: total rows ──────────────────────────────────────
  console.log(`[DB] ── Total rows in probate_leads: ${count ?? all.length}`);

  if (all.length === 0) {
    console.warn(
      "[DB] probate_leads is empty. Run ingestion from the Vercel dashboard first."
    );
    return [];
  }

  // ── Log 2: status breakdown ────────────────────────────────
  const statusMap: Record<string, number> = {};
  for (const row of all) {
    const key =
      row.property_match_status === null
        ? "NULL"
        : `"${row.property_match_status}"`;
    statusMap[key] = (statusMap[key] ?? 0) + 1;
  }
  console.log("[DB] ── property_match_status breakdown:", JSON.stringify(statusMap));

  // ── Filter 1: must have a deceased_name ───────────────────
  const withName = all.filter(
    (r) =>
      r.deceased_name !== null &&
      r.deceased_name !== undefined &&
      r.deceased_name.trim().length > 0
  );

  // ── Log 3: rows with deceased_name ─────────────────────────
  console.log(`[DB] ── Rows with deceased_name: ${withName.length}`);
  console.log(
    `[DB] ── Rows WITHOUT deceased_name (skipped): ${all.length - withName.length}`
  );

  // ── Filter 2: exclude only status === "matched" ───────────
  const alreadyMatched = withName.filter(
    (r) => r.property_match_status === "matched"
  );

  // ── Log 4: excluded as matched ─────────────────────────────
  console.log(
    `[DB] ── Rows excluded (status === "matched"): ${alreadyMatched.length}`
  );

  const eligible = withName.filter(
    (r) => r.property_match_status !== "matched"
  );

  // ── Log 5: final eligible count ────────────────────────────
  console.log(`[DB] ── Final eligible rows to process: ${eligible.length}`);

  // Print first 5 rows for verification
  eligible.slice(0, 5).forEach((r) =>
    console.log(
      `[DB]    id=${r.id} ` +
        `case=${r.case_number} ` +
        `status=${r.property_match_status === null ? "NULL" : `"${r.property_match_status}"`} ` +
        `deceased="${r.deceased_name}"`
    )
  );

  return eligible;
}

/**
 * Write matched property address columns back to Supabase.
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
      `[DB] updateMatchedProperty error id=${id}:`,
      JSON.stringify(error)
    );
    throw new Error(error.message);
  }

  console.log(
    `[DB] ✓ Matched id=${id}: "${address}, ${city}, ${state} ${zip ?? ""}"`
  );
}

/**
 * Set property_match_status to "no_match" or "error".
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
