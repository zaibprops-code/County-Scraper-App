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
// Pass ws.WebSocket as the transport inside the `realtime`
// option of createClient(). This gives supabase-js a valid
// WebSocket constructor and suppresses the warning entirely.
//
// FILTERING FIX:
// We fetch ALL rows and filter in JavaScript so NULL values
// are handled correctly.
// ============================================================

import { createClient, SupabaseClient } from "@supabase/supabase-js";
import { WebSocket as WsWebSocket } from "ws";

let _client: SupabaseClient | null = null;

export function getSupabase(): SupabaseClient {
  if (_client) return _client;

  // Accept both naming conventions
  const url =
    process.env.SUPABASE_URL ||
    process.env.NEXT_PUBLIC_SUPABASE_URL;

  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url) {
    throw new Error(
      "Missing env var: SUPABASE_URL (or NEXT_PUBLIC_SUPABASE_URL)"
    );
  }

  if (!key) {
    throw new Error(
      "Missing env var: SUPABASE_SERVICE_ROLE_KEY"
    );
  }

  console.log(`[DB] Connecting to Supabase at: ${url}`);

  _client = createClient(url, key, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },

    realtime: {
      // FIXED: simpler transport typing
      transport: WsWebSocket as any,
    },

    global: {
      fetch: fetch,
    },
  });

  console.log(
    "[DB] Supabase client ready (ws transport supplied)"
  );

  return _client;
}

// ============================================================
// Types
// ============================================================

export interface ProbateLead {
  id: number;
  case_number: string;
  deceased_name: string | null;
  property_match_status: string | null;
}

// ============================================================
// Fetch Eligible Leads
// ============================================================

export async function fetchEligibleLeads(): Promise<ProbateLead[]> {
  const db = getSupabase();

  console.log("[DB] Fetching ALL probate rows...");

  const { data, error, count } = await db
    .from("probate_leads")
    .select(
      "id,case_number,deceased_name,property_match_status",
      { count: "exact" }
    )
    .order("id", { ascending: true });

  if (error) {
    console.error("[DB] Fetch error:", JSON.stringify(error));
    throw new Error(error.message);
  }

  const all = (data ?? []) as ProbateLead[];

  console.log(
    `[DB] Total rows in probate_leads: ${count ?? all.length}`
  );

  if (all.length === 0) {
    console.warn("[DB] No probate rows found.");
    return [];
  }

  // ----------------------------------------------------------
  // Status breakdown logging
  // ----------------------------------------------------------

  const statusMap: Record<string, number> = {};

  for (const row of all) {
    const key =
      row.property_match_status === null
        ? "NULL"
        : `"${row.property_match_status}"`;

    statusMap[key] = (statusMap[key] ?? 0) + 1;
  }

  console.log(
    "[DB] property_match_status breakdown:",
    JSON.stringify(statusMap)
  );

  // ----------------------------------------------------------
  // Filter rows WITH deceased_name
  // ----------------------------------------------------------

  const withName = all.filter(
    (r) =>
      r.deceased_name !== null &&
      r.deceased_name !== undefined &&
      r.deceased_name.trim().length > 0
  );

  console.log(
    `[DB] Rows with deceased_name: ${withName.length}`
  );

  console.log(
    `[DB] Rows without deceased_name: ${
      all.length - withName.length
    }`
  );

  // ----------------------------------------------------------
  // Exclude ONLY matched rows
  // ----------------------------------------------------------

  const alreadyMatched = withName.filter(
    (r) => r.property_match_status === "matched"
  );

  console.log(
    `[DB] Rows excluded as matched: ${alreadyMatched.length}`
  );

  const eligible = withName.filter(
    (r) => r.property_match_status !== "matched"
  );

  console.log(
    `[DB] Final eligible rows: ${eligible.length}`
  );

  eligible.slice(0, 5).forEach((r) => {
    console.log(
      `[DB] Lead => id=${r.id} case=${r.case_number} deceased="${r.deceased_name}" status="${r.property_match_status}"`
    );
  });

  return eligible;
}

// ============================================================
// Update Matched Property
// ============================================================

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
    `[DB] ✓ Matched id=${id}: ${address}, ${city}, ${state} ${zip ?? ""}`
  );
}

// ============================================================
// Update Match Status
// ============================================================

export async function updateMatchStatus(
  id: number,
  status: "no_match" | "error"
): Promise<void> {
  const db = getSupabase();

  const { error } = await db
    .from("probate_leads")
    .update({
      property_match_status: status,
    })
    .eq("id", id);

  if (error) {
    console.error(
      `[DB] updateMatchStatus error id=${id}:`,
      JSON.stringify(error)
    );
  } else {
    console.log(
      `[DB] Set status="${status}" for id=${id}`
    );
  }
}
