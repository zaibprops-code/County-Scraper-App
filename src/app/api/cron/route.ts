// ============================================================
// /api/cron — Date-scoped ingestion pipeline
//
// GET /api/cron?dateFrom=YYYY-MM-DD&dateTo=YYYY-MM-DD
//
// Behavior:
//   1. Clear ALL existing leads (session reset)
//   2. Download CSVs only for the requested date range
//   3. Parse, filter, store
//   4. Return result
// ============================================================

import { NextRequest, NextResponse } from "next/server";
import { downloadFilesForRange, markFileProcessed } from "@/lib/downloader";
import { parseCsvContent } from "@/lib/parser";
import { storeProbateLeads, storeForeclosureLeads, clearAllLeads } from "@/lib/storage";
import type { CronResult } from "@/types/leads";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

function todayISO(): string {
  const d = new Date();
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const { searchParams } = new URL(request.url);

  const rawFrom = searchParams.get("dateFrom")?.trim() ?? "";
  const rawTo = searchParams.get("dateTo")?.trim() ?? "";

  // Resolve dates: if only one provided use it for both ends
  const today = todayISO();
  const resolvedFrom = rawFrom || today;
  const resolvedTo = rawTo || rawFrom || today;

  console.log(`[Cron] ▶ Start — range: ${resolvedFrom} → ${resolvedTo}`);
  const t0 = Date.now();

  try {
    // Step 1: Clear existing data
    console.log("[Cron] Step 1: Clearing DB...");
    await clearAllLeads();
    console.log("[Cron] Step 1: DB cleared");

    // Step 2: Download files for range
    console.log(`[Cron] Step 2: Downloading ${resolvedFrom} → ${resolvedTo}`);
    const files = await downloadFilesForRange(resolvedFrom, resolvedTo);
    console.log(`[Cron] Step 2: ${files.length} file(s) downloaded`);

    if (files.length === 0) {
      const result: CronResult = {
        success: true,
        filesProcessed: 0,
        probateLeadsInserted: 0,
        foreclosureLeadsInserted: 0,
        message: `No files found for ${resolvedFrom} → ${resolvedTo}. County may not publish on weekends or holidays.`,
      };
      console.log("[Cron] No files found:", result.message);
      return NextResponse.json(result);
    }

    let totalProbate = 0;
    let totalForeclosure = 0;

    // Step 3: Parse + store each file
    for (const file of files) {
      console.log(`[Cron] Step 3: Parsing ${file.filename}`);
      try {
        const { probateLeads, foreclosureLeads } = parseCsvContent(
          file.csvContent,
          file.filename
        );

        console.log(`[Cron] ${file.filename}: ${probateLeads.length} probate, ${foreclosureLeads.length} foreclosure`);

        const [probateCount, foreclosureCount] = await Promise.all([
          storeProbateLeads(probateLeads),
          storeForeclosureLeads(foreclosureLeads),
        ]);

        await markFileProcessed(
          { filename: file.filename, url: "", sourceType: file.sourceType, fileDate: file.fileDate },
          probateCount + foreclosureCount
        );

        totalProbate += probateCount;
        totalForeclosure += foreclosureCount;
        console.log(`[Cron] ${file.filename}: stored ${probateCount} probate, ${foreclosureCount} foreclosure`);
      } catch (e) {
        console.error(`[Cron] Error on ${file.filename}:`, e instanceof Error ? e.message : e);
      }
    }

    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    const result: CronResult = {
      success: true,
      filesProcessed: files.length,
      probateLeadsInserted: totalProbate,
      foreclosureLeadsInserted: totalForeclosure,
      message: `Done in ${elapsed}s`,
    };

    console.log("[Cron] ✓", result);
    return NextResponse.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[Cron] ✗ Fatal:", message);
    return NextResponse.json(
      {
        success: false,
        filesProcessed: 0,
        probateLeadsInserted: 0,
        foreclosureLeadsInserted: 0,
        error: message,
      } satisfies CronResult,
      { status: 500 }
    );
  }
}
