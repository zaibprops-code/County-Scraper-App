// ============================================================
// /api/leads — Paginated, filtered lead query
// GET /api/leads?type=all&search=&dateFrom=&dateTo=&page=1
// Uses service-role client to bypass Supabase RLS.
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

  console.log(`[LeadsAPI] type=${type} search="${search}" dateFrom="${dateFrom}" dateTo="${dateTo}" page=${page}`);

  const admin = getSupabaseAdmin();

  try {
    // Sanity: log unfiltered totals
    const [sanityP, sanityF] = await Promise.all([
      admin.from("probate_leads").select("id", { count: "exact", head: true }),
      admin.from("foreclosure_leads").select("id", { count: "exact", head: true }),
    ]);
    console.log(`[LeadsAPI] DB totals: probate=${sanityP.count ?? "err"} foreclosure=${sanityF.count ?? "err"}`);

    const [probateResult, foreclosureResult] = await Promise.all([
      type === "all" || type === "probate"
        ? queryProbate(admin, search, dateFrom, dateTo, offset, PAGE_SIZE)
        : { data: [], count: 0 },
      type === "all" || type === "foreclosure"
        ? queryForeclosure(admin, search, dateFrom, dateTo, offset, PAGE_SIZE)
        : { data: [], count: 0 },
    ]);

    console.log(`[LeadsAPI] Result: probateTotal=${probateResult.count} foreclosureTotal=${foreclosureResult.count}`);

    return NextResponse.json({
      probate: probateResult.data,
      foreclosure: foreclosureResult.data,
      probateTotal: probateResult.count,
      foreclosureTotal: foreclosureResult.count,
      page,
      pageSize: PAGE_SIZE,
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error("[LeadsAPI] Error:", msg);
    return NextResponse.json(
      { error: msg, probate: [], foreclosure: [], probateTotal: 0, foreclosureTotal: 0, page, pageSize: PAGE_SIZE },
      { status: 500 }
    );
  }
}

type AdminClient = ReturnType<typeof getSupabaseAdmin>;

async function queryProbate(
  admin: AdminClient,
  search: string,
  dateFrom: string,
  dateTo: string,
  offset: number,
  limit: number
) {
  let q = admin
    .from("probate_leads")
    .select(
      "id,case_number,filing_date,deceased_name,petitioner,attorney,address,city,state,zip,county,case_type,source_file,created_at",
      { count: "exact" }
    )
    .order("filing_date", { ascending: false, nullsFirst: false })
    .order("id", { ascending: false })
    .range(offset, offset + limit - 1);

  if (search) q = q.or(`deceased_name.ilike.%${search}%,case_number.ilike.%${search}%,petitioner.ilike.%${search}%,attorney.ilike.%${search}%`);
  if (dateFrom) q = q.gte("filing_date", dateFrom);
  if (dateTo) q = q.lte("filing_date", dateTo);

  const { data, count, error } = await q;
  if (error) { console.error("[LeadsAPI] Probate error:", error); throw new Error(error.message); }
  console.log(`[LeadsAPI] Probate: count=${count} rows=${data?.length ?? 0}`);
  return { data: data ?? [], count: count ?? 0 };
}

async function queryForeclosure(
  admin: AdminClient,
  search: string,
  dateFrom: string,
  dateTo: string,
  offset: number,
  limit: number
) {
  let q = admin
    .from("foreclosure_leads")
    .select(
      "id,case_number,filing_date,plaintiff,defendant,attorney,address,city,state,zip,county,case_type,source_file,created_at",
      { count: "exact" }
    )
    .order("filing_date", { ascending: false, nullsFirst: false })
    .order("id", { ascending: false })
    .range(offset, offset + limit - 1);

  if (search) q = q.or(`defendant.ilike.%${search}%,plaintiff.ilike.%${search}%,case_number.ilike.%${search}%,attorney.ilike.%${search}%,case_type.ilike.%${search}%`);
  if (dateFrom) q = q.gte("filing_date", dateFrom);
  if (dateTo) q = q.lte("filing_date", dateTo);

  const { data, count, error } = await q;
  if (error) { console.error("[LeadsAPI] Foreclosure error:", error); throw new Error(error.message); }
  console.log(`[LeadsAPI] Foreclosure: count=${count} rows=${data?.length ?? 0}`);
  return { data: data ?? [], count: count ?? 0 };
}
