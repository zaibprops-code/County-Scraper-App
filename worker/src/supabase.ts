// ============================================================
// Supabase client — Railway worker
// Explicit schema, full diagnostic logging, ws transport.
// ============================================================

import { createClient, SupabaseClient } from "@supabase/supabase-js";
import { WebSocket as WsWebSocket } from "ws";

let _client: SupabaseClient | null = null;

export const RESOLVED_SUPABASE_URL =
  process.env.SUPABASE_URL ||
  process.env.NEXT_PUBLIC_SUPABASE_URL ||
  "";

export function getSupabase(): SupabaseClient {
  if (_client) return _client;

  const url = RESOLVED_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || "";

  if (!url) {
    throw new Error(
      "[DB] FATAL: No Supabase URL found.\n" +
        "  Set SUPABASE_URL in Railway → Variables.\n" +
        "  Value must match your Vercel NEXT_PUBLIC_SUPABASE_URL exactly."
    );
  }
  if (!key) {
    throw new Error(
      "[DB] FATAL: SUPABASE_SERVICE_ROLE_KEY is not set.\n" +
        "  Set it in Railway → Variables."
    );
  }

  const projectRef =
    url.match(/https?:\/\/([^.]+)\.supabase\.co/)?.[1] ?? "unknown";
  console.log(`[DB] ── Supabase project ref : ${projectRef}`);
  console.log(`[DB] ── Full URL             : ${url}`);
  console.log(`[DB] ── Service key prefix   : ${key.slice(0, 20)}...`);
  console.log(`[DB] ── Schema               : public (explicit)`);

  _client = createClient(url, key, {
    db: {
      schema: "public",
    },
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
    realtime: {
      transport: WsWebSocket as unknown as new (
        url: string,
        protocols?: string | string[]
      ) => WebSocket,
    },
    global: {
      fetch: fetch,
    },
  });

  console.log("[DB] ── Supabase client created ✓");
  return _client;
}

export interface ProbateLead {
  id: number;
  case_number: string;
  deceased_name: string | null;
  property_match_status: string | null;
}

export interface DbDiagnostic {
  url: string;
  projectRef: string;
  serviceKeyPrefix: string;
  rawCountResult: number | null;
  rawCountError: string | null;
  tableListResult: string[];
  tableListError: string | null;
  sampleRows: ProbateLead[];
  sampleError: string | null;
  currentRole: string | null;
  roleError: string | null;
}

export async function runDbDiagnostic(): Promise<DbDiagnostic> {
  const db = getSupabase();
  const url = RESOLVED_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
  const projectRef =
    url.match(/https?:\/\/([^.]+)\.supabase\.co/)?.[1] ?? "unknown";

  const diag: DbDiagnostic = {
    url,
    projectRef,
    serviceKeyPrefix: key.slice(0, 20) + "...",
    rawCountResult: null,
    rawCountError: null,
    tableListResult: [],
    tableListError: null,
    sampleRows: [],
    sampleError: null,
    currentRole: null,
    roleError: null,
  };

  console.log("[DiagDB] Querying: SELECT count(*) FROM public.probate_leads");
  const { count, error: countErr } = await db
    .from("probate_leads")
    .select("*", { count: "exact", head: true });

  if (countErr) {
    diag.rawCountError = JSON.stringify(countErr);
    console.error("[DiagDB] Count error:", diag.rawCountError);
  } else {
    diag.rawCountResult = count ?? 0;
    console.log(`[DiagDB] probate_leads row count: ${diag.rawCountResult}`);
  }

  console.log("[DiagDB] Querying information_schema.tables WHERE schema=public");
  const { data: tables, error: tableErr } = await db
    .from("information_schema.tables" as unknown as "probate_leads")
    .select("table_name")
    .eq("table_schema", "public")
    .eq("table_type", "BASE TABLE");

  if (tableErr) {
    diag.tableListError = JSON.stringify(tableErr);
    console.error("[DiagDB] Table list error:", diag.tableListError);
  } else {
    diag.tableListResult = (tables ?? []).map(
      (t: Record<string, string>) => t["table_name"] ?? ""
    );
    console.log(
      "[DiagDB] Tables in public schema:",
      diag.tableListResult.join(", ")
    );
    if (!diag.tableListResult.includes("probate_leads")) {
      console.error(
        "[DiagDB] ⚠ probate_leads NOT in table list — " +
          "check you are connected to the correct Supabase project!"
      );
    }
  }

  console.log("[DiagDB] Fetching first 5 rows from probate_leads...");
  const { data: sample, error: sampleErr } = await db
    .from("probate_leads")
    .select("id,case_number,deceased_name,property_match_status")
    .order("id", { ascending: true })
    .limit(5);

  if (sampleErr) {
    diag.sampleError = JSON.stringify(sampleErr);
    console.error("[DiagDB] Sample fetch error:", diag.sampleError);
  } else {
    diag.sampleRows = (sample ?? []) as ProbateLead[];
    console.log(`[DiagDB] Sample rows returned: ${diag.sampleRows.length}`);
    diag.sampleRows.forEach((r) =>
      console.log(
        `[DiagDB]   id=${r.id} case=${r.case_number} deceased="${r.deceased_name}" status="${r.property_match_status}"`
      )
    );
  }

  const { data: roleData, error: roleErr } = await db.rpc("current_user");
  if (roleErr) {
    diag.roleError = JSON.stringify(roleErr);
    console.log("[DiagDB] Role check not available:", diag.roleError);
  } else {
    diag.currentRole = String(roleData);
    console.log(`[DiagDB] Current DB role: ${diag.currentRole}`);
  }

  return diag;
}

export async function fetchEligibleLeads(): Promise<ProbateLead[]> {
  const db = getSupabase();

  console.log(
    "[DB] Fetching ALL rows from probate_leads (no server-side filter)..."
  );
  console.log(`[DB] Using URL: ${RESOLVED_SUPABASE_URL}`);

  const { data, error, count } = await db
    .from("probate_leads")
    .select("id,case_number,deceased_name,property_match_status", {
      count: "exact",
    })
    .order("id", { ascending: true });

  if (error) {
    console.error("[DB] Fetch error code    :", error.code);
    console.error("[DB] Fetch error message :", error.message);
    console.error("[DB] Fetch error details :", error.details);
    console.error("[DB] Fetch error hint    :", error.hint);
    throw new Error(`Supabase fetch failed: ${error.message}`);
  }

  const all = (data ?? []) as ProbateLead[];
  console.log(`[DB] ── Total rows returned : ${count ?? all.length}`);

  if (all.length === 0) {
    console.warn(
      "[DB] ── Zero rows returned from probate_leads.\n" +
        "[DB]    Possible causes:\n" +
        "[DB]    1. Railway SUPABASE_URL points to a DIFFERENT project than Vercel\n" +
        "[DB]    2. RLS is blocking reads (check Supabase → Auth → Policies)\n" +
        "[DB]    3. Table is in a non-public schema\n" +
        "[DB]    4. Ingestion has not been run yet\n" +
        `[DB]    Active URL: ${RESOLVED_SUPABASE_URL}`
    );
    return [];
  }

  const statusMap: Record<string, number> = {};
  for (const row of all) {
    const k =
      row.property_match_status === null
        ? "NULL"
        : `"${row.property_match_status}"`;
    statusMap[k] = (statusMap[k] ?? 0) + 1;
  }
  console.log(
    "[DB] ── Status breakdown     :",
    JSON.stringify(statusMap)
  );

  const withName = all.filter(
    (r) =>
      r.deceased_name !== null &&
      r.deceased_name !== undefined &&
      r.deceased_name.trim().length > 0
  );
  console.log(`[DB] ── With deceased_name   : ${withName.length}`);
  console.log(
    `[DB] ── Without name (skip)  : ${all.length - withName.length}`
  );

  const alreadyMatched = withName.filter(
    (r) => r.property_match_status === "matched"
  );
  console.log(`[DB] ── Already matched      : ${alreadyMatched.length}`);

  const eligible = withName.filter(
    (r) => r.property_match_status !== "matched"
  );
  console.log(`[DB] ── Final eligible       : ${eligible.length}`);

  eligible.slice(0, 5).forEach((r) =>
    console.log(
      `[DB]    id=${r.id} case=${r.case_number} ` +
        `status=${
          r.property_match_status === null
            ? "NULL"
            : `"${r.property_match_status}"`
        } ` +
        `deceased="${r.deceased_name}"`
    )
  );

  return eligible;
}

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
