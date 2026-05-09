// ============================================================
// /api/export — CSV and Excel export of all matching leads
// GET /api/export?format=csv&type=all&search=&dateFrom=&dateTo=
// GET /api/export?format=xlsx&type=foreclosure
// ============================================================

import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";
import * as XLSX from "xlsx";
import Papa from "papaparse";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(request: NextRequest): Promise<NextResponse> {
  const { searchParams } = new URL(request.url);
  const format = searchParams.get("format") ?? "csv";
  const type = searchParams.get("type") ?? "all";
  const search = (searchParams.get("search") ?? "").trim();
  const dateFrom = searchParams.get("dateFrom") ?? "";
  const dateTo = searchParams.get("dateTo") ?? "";

  try {
    const [probateRows, foreclosureRows] = await Promise.all([
      type === "all" || type === "probate"
        ? fetchAllProbate(search, dateFrom, dateTo)
        : [],
      type === "all" || type === "foreclosure"
        ? fetchAllForeclosure(search, dateFrom, dateTo)
        : [],
    ]);

    const timestamp = new Date().toISOString().slice(0, 10);

    if (format === "xlsx") {
      return buildXlsxResponse(probateRows, foreclosureRows, timestamp);
    }
    return buildCsvResponse(probateRows, foreclosureRows, type, timestamp);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error("[Export API] Error:", msg);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

// ---- Data fetchers -----------------------------------------------

type ProbateExportRow = {
  case_number: string;
  filing_date: string | null;
  case_type: string | null;
  deceased_name: string | null;
  petitioner: string | null;
  attorney: string | null;
  address: string | null;
  city: string | null;
  state: string;
  zip: string | null;
  county: string;
  source_file: string;
};

type ForeclosureExportRow = {
  case_number: string;
  filing_date: string | null;
  case_type: string | null;
  plaintiff: string | null;
  defendant: string | null;
  attorney: string | null;
  address: string | null;
  city: string | null;
  state: string;
  zip: string | null;
  county: string;
  source_file: string;
};

async function fetchAllProbate(
  search: string,
  dateFrom: string,
  dateTo: string
): Promise<ProbateExportRow[]> {
  let q = supabase
    .from("probate_leads")
    .select(
      "case_number,filing_date,case_type,deceased_name,petitioner,attorney,address,city,state,zip,county,source_file"
    )
    .order("filing_date", { ascending: false })
    .limit(10000);

  if (search) {
    q = q.or(
      `deceased_name.ilike.%${search}%,case_number.ilike.%${search}%,petitioner.ilike.%${search}%`
    );
  }
  if (dateFrom) q = q.gte("filing_date", dateFrom);
  if (dateTo) q = q.lte("filing_date", dateTo);

  const { data, error } = await q;
  if (error) throw error;
  return (data ?? []) as ProbateExportRow[];
}

async function fetchAllForeclosure(
  search: string,
  dateFrom: string,
  dateTo: string
): Promise<ForeclosureExportRow[]> {
  let q = supabase
    .from("foreclosure_leads")
    .select(
      "case_number,filing_date,case_type,plaintiff,defendant,attorney,address,city,state,zip,county,source_file"
    )
    .order("filing_date", { ascending: false })
    .limit(10000);

  if (search) {
    q = q.or(
      `defendant.ilike.%${search}%,case_number.ilike.%${search}%,plaintiff.ilike.%${search}%`
    );
  }
  if (dateFrom) q = q.gte("filing_date", dateFrom);
  if (dateTo) q = q.lte("filing_date", dateTo);

  const { data, error } = await q;
  if (error) throw error;
  return (data ?? []) as ForeclosureExportRow[];
}

// ---- Response builders -------------------------------------------

function buildCsvResponse(
  probate: ProbateExportRow[],
  foreclosure: ForeclosureExportRow[],
  type: string,
  timestamp: string
): NextResponse {
  let csv = "";

  if (type !== "foreclosure" && probate.length > 0) {
    csv += "# PROBATE LEADS\r\n";
    csv += Papa.unparse(probate, { header: true, newline: "\r\n" });
    csv += "\r\n";
  }

  if (type !== "probate" && foreclosure.length > 0) {
    if (csv) csv += "\r\n# FORECLOSURE LEADS\r\n";
    csv += Papa.unparse(foreclosure, { header: true, newline: "\r\n" });
  }

  return new NextResponse(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="hillsborough-leads-${timestamp}.csv"`,
    },
  });
}

function buildXlsxResponse(
  probate: ProbateExportRow[],
  foreclosure: ForeclosureExportRow[],
  timestamp: string
): NextResponse {
  const wb = XLSX.utils.book_new();

  const addSheet = (data: object[], sheetName: string) => {
    if (data.length === 0) return;
    const ws = XLSX.utils.json_to_sheet(data);
    // Set column widths
    const colCount = Object.keys(data[0]).length;
    ws["!cols"] = Array(colCount).fill({ wch: 22 });
    XLSX.utils.book_append_sheet(wb, ws, sheetName);
  };

  addSheet(probate, "Probate Leads");
  addSheet(foreclosure, "Foreclosure Leads");

  // If both sheets are empty, add a placeholder
  if (wb.SheetNames.length === 0) {
    const ws = XLSX.utils.aoa_to_sheet([["No leads found for the selected filters."]]);
    XLSX.utils.book_append_sheet(wb, ws, "No Data");
  }

  const buffer = XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;

  return new NextResponse(buffer, {
    headers: {
      "Content-Type":
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="hillsborough-leads-${timestamp}.xlsx"`,
    },
  });
}
