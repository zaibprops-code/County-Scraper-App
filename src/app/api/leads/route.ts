// ============================================================
// /api/leads — Paginated, filtered lead query
// GET /api/leads?type=all&search=smith&dateFrom=2026-01-01&dateTo=2026-05-09&page=1
// ============================================================

import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";

export const dynamic = "force-dynamic";

const PAGE_SIZE = 50;

export async function GET(request: NextRequest): Promise<NextResponse> {
  const { searchParams } = new URL(request.url);

  const type = searchParams.get("type") ?? "all";
  const search = (searchParams.get("search") ?? "").trim();
  const dateFrom = searchParams.get("dateFrom") ?? "";
  const dateTo = searchParams.get("dateTo") ?? "";
  const page = Math.max(1, parseInt(searchParams.get("page") ?? "1", 10));
  const offset = (page - 1) * PAGE_SIZE;

  try {
    const [probateResult, foreclosureResult] = await Promise.all([
      type === "all" || type === "probate"
        ? queryProbate(search, dateFrom, dateTo, offset, PAGE_SIZE)
        : { data: [], count: 0 },

      type === "all" || type === "foreclosure"
        ? queryForeclosure(search, dateFrom, dateTo, offset, PAGE_SIZE)
        : { data: [], count: 0 },
    ]);

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
    console.error("[Leads API] Error:", msg);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

// ---- Query helpers ------------------------------------------------

async function queryProbate(
  search: string,
  dateFrom: string,
  dateTo: string,
  offset: number,
  limit: number
) {
  let q = supabase
    .from("probate_leads")
    .select(
      "id,case_number,filing_date,deceased_name,petitioner,attorney,address,city,state,zip,county,case_type,source_file,created_at",
      { count: "exact" }
    )
    .order("filing_date", { ascending: false })
    .order("created_at", { ascending: false })
    .range(offset, offset + limit - 1);

  if (search) {
    q = q.or(
      `deceased_name.ilike.%${search}%,case_number.ilike.%${search}%,petitioner.ilike.%${search}%,attorney.ilike.%${search}%`
    );
  }
  if (dateFrom) q = q.gte("filing_date", dateFrom);
  if (dateTo) q = q.lte("filing_date", dateTo);

  const { data, count, error } = await q;
  if (error) throw error;
  return { data: data ?? [], count: count ?? 0 };
}

async function queryForeclosure(
  search: string,
  dateFrom: string,
  dateTo: string,
  offset: number,
  limit: number
) {
  let q = supabase
    .from("foreclosure_leads")
    .select(
      "id,case_number,filing_date,plaintiff,defendant,attorney,address,city,state,zip,county,case_type,source_file,created_at",
      { count: "exact" }
    )
    .order("filing_date", { ascending: false })
    .order("created_at", { ascending: false })
    .range(offset, offset + limit - 1);

  if (search) {
    q = q.or(
      `defendant.ilike.%${search}%,plaintiff.ilike.%${search}%,case_number.ilike.%${search}%,attorney.ilike.%${search}%,case_type.ilike.%${search}%`
    );
  }
  if (dateFrom) q = q.gte("filing_date", dateFrom);
  if (dateTo) q = q.lte("filing_date", dateTo);

  const { data, count, error } = await q;
  if (error) throw error;
  return { data: data ?? [], count: count ?? 0 };
}
