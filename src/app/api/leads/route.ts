// ============================================================
// /api/leads — Paginated, filtered lead query
// GET /api/leads?type=all&search=&dateFrom=&dateTo=&page=1
//
// IMPORTANT: Uses supabaseAdmin (service role key) for reads.
// The anon key is blocked by Supabase RLS on these tables.
// Inserts already use service role — reads must too.
// ============================================================

import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase";

export const dynamic = "force-dynamic";

const PAGE_SIZE = 50;

export async function GET(request: NextRequest): Promise<NextResponse> {
  const { searchParams } = new URL(request.url);

  const type = (searchParams.get("type") ?? "all").trim();
  const search = (searchParams.get("search") ?? "").trim();
  const dateFrom = (searchParams.get("dateFrom") ?? "").trim();
  const dateTo = (searchParams.get("dateTo") ?? "").trim();
  const page = Math.max(1, parseInt(searchParams.get("page") ?? "1", 10));
  const offset = (page - 1) * PAGE_SIZE;

  console.log(
    `[LeadsAPI] Request: type=${type} search="${search}" dateFrom="${dateFrom}" dateTo="${dateTo}" page=${page} offset=${offset}`
  );

  // Use admin client so RLS does not silently block reads
  const admin = getSupabaseAdmin();

  try {
    // Quick sanity check — log total row counts before filtering
    const [probateSanity, foreclosureSanity] = await Promise.all([
      admin.from("probate_leads").select("id", { count: "exact", head: true }),
      admin.from("foreclosure_leads").select("id", { count: "exact", head: true }),
    ]);

    console.log(
      `[LeadsAPI] DB totals (unfiltered): probate=${probateSanity.count ?? "err"} foreclosure=${foreclosureSanity.count ?? "err"}`
    );

    if (probateSanity.error) {
      console.error("[LeadsAPI] Sanity check probate error:", JSON.stringify(probateSanity.error));
    }
    if (foreclosureSanity.error) {
      console.error("[LeadsAPI] Sanity check foreclosure error:", JSON.stringify(foreclosureSanity.error));
    }

    // Run filtered queries
    const [probateResult, foreclosureResult] = await Promise.all([
      type === "all" || type === "probate"
        ? queryProbate(admin, search, dateFrom, dateTo, offset, PAGE_SIZE)
        : { data: [], count: 0 },
      type === "all" || type === "foreclosure"
        ? queryForeclosure(admin, search, dateFrom, dateTo, offset, PAGE_SIZE)
        : { data: [], count: 0 },
    ]);

    const response = {
      probate: probateResult.data,
      foreclosure: foreclosureResult.data,
      probateTotal: probateResult.count,
      foreclosureTotal: foreclosureResult.count,
      page,
      pageSize: PAGE_SIZE,
    };

    console.log(
      `[LeadsAPI] Response: probateTotal=${response.probateTotal} (${response.probate.length} rows) foreclosureTotal=${response.foreclosureTotal} (${response.foreclosure.length} rows)`
    );

    return NextResponse.json(response);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error("[LeadsAPI] Fatal error:", msg);
    return NextResponse.json(
      {
        error: msg,
        probate: [],
        foreclosure: [],
        probateTotal: 0,
        foreclosureTotal: 0,
        page,
        pageSize: PAGE_SIZE,
      },
      { status: 500 }
    );
  }
}

// ---- Query helpers --------------------------------------------

type AdminClient = ReturnType<typeof getSupabaseAdmin>;

async function queryProbate(
  admin: AdminClient,
  search: string,
  dateFrom: string,
  dateTo: string,
  offset: number,
  limit: number
): Promise<{ data: unknown[]; count: number }> {
  let q = admin
    .from("probate_leads")
    .select(
      "id,case_number,filing_date,deceased_name,petitioner,attorney,address,city,state,zip,county,case_type,source_file,created_at",
      { count: "exact" }
    )
    .order("filing_date", { ascending: false, nullsFirst: false })
    .order("id", { ascending: false })
    .range(offset, offset + limit - 1);

  if (search) {
    q = q.or(
      `deceased_name.ilike.%${search}%,case_number.ilike.%${search}%,petitioner.ilike.%${search}%,attorney.ilike.%${search}%`
    );
  }
  if (dateFrom) q = q.gte("filing_date", dateFrom);
  if (dateTo) q = q.lte("filing_date", dateTo);

  const { data, count, error } = await q;

  if (error) {
    console.error("[LeadsAPI] Probate query error:", JSON.stringify(error));
    throw new Error(`Probate query failed: ${error.message}`);
  }

  console.log(
    `[LeadsAPI] Probate query OK: count=${count} rows=${data?.length ?? 0}`
  );

  return { data: data ?? [], count: count ?? 0 };
}

async function queryForeclosure(
  admin: AdminClient,
  search: string,
  dateFrom: string,
  dateTo: string,
  offset: number,
  limit: number
): Promise<{ data: unknown[]; count: number }> {
  let q = admin
    .from("foreclosure_leads")
    .select(
      "id,case_number,filing_date,plaintiff,defendant,attorney,address,city,state,zip,county,case_type,source_file,created_at",
      { count: "exact" }
    )
    .order("filing_date", { ascending: false, nullsFirst: false })
    .order("id", { ascending: false })
    .range(offset, offset + limit - 1);

  if (search) {
    q = q.or(
      `defendant.ilike.%${search}%,plaintiff.ilike.%${search}%,case_number.ilike.%${search}%,attorney.ilike.%${search}%,case_type.ilike.%${search}%`
    );
  }
  if (dateFrom) q = q.gte("filing_date", dateFrom);
  if (dateTo) q = q.lte("filing_date", dateTo);

  const { data, count, error } = await q;

  if (error) {
    console.error("[LeadsAPI] Foreclosure query error:", JSON.stringify(error));
    throw new Error(`Foreclosure query failed: ${error.message}`);
  }

  console.log(
    `[LeadsAPI] Foreclosure query OK: count=${count} rows=${data?.length ?? 0}`
  );

  return { data: data ?? [], count: count ?? 0 };
}
