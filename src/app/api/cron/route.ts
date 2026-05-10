// ============================================================
// /api/cron — Daily ingestion pipeline
// Auth disabled for MVP testing.
// ============================================================

import { NextResponse } from "next/server";
import { downloadNewFiles, markFileProcessed } from "@/lib/downloader";
import { parseCsvContent } from "@/lib/parser";
import { storeProbateLeads, storeForeclosureLeads } from "@/lib/storage";
import type { CronResult } from "@/types/leads";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(): Promise<NextResponse> {
  console.log("[Cron] ▶ Pipeline start");
  const t0 = Date.now();

  try {
    // Step 1: discover + download new CSV files
    const newFiles = await downloadNewFiles();

    console.log(`[Cron] Files returned by downloader: ${newFiles.length}`);

    if (newFiles.length === 0) {
      const result: CronResult = {
        success: true,
        filesProcessed: 0,
        probateLeadsInserted: 0,
        foreclosureLeadsInserted: 0,
        message: "No new files found.",
      };
      console.log("[Cron] ✓ Nothing to process.");
      return NextResponse.json(result);
    }

    let totalProbate = 0;
    let totalForeclosure = 0;

    for (const file of newFiles) {
      console.log(`[Cron] Processing file: ${file.filename} (${file.csvContent.length} chars)`);

      try {
        // Step 2: parse CSV content in memory
        const { probateLeads, foreclosureLeads } = parseCsvContent(
          file.csvContent,
          file.filename
        );

        console.log(
          `[Cron] ${file.filename}: parsed ${probateLeads.length} probate, ${foreclosureLeads.length} foreclosure`
        );

        // Step 3: store leads
        const [probateCount, foreclosureCount] = await Promise.all([
          storeProbateLeads(probateLeads),
          storeForeclosureLeads(foreclosureLeads),
        ]);

        console.log(
          `[Cron] ${file.filename}: stored ${probateCount} probate, ${foreclosureCount} foreclosure`
        );

        // Step 4: mark file processed
        await markFileProcessed(
          {
            filename: file.filename,
            url: "",
            sourceType: file.sourceType,
            fileDate: file.fileDate,
          },
          probateCount + foreclosureCount
        );

        totalProbate += probateCount;
        totalForeclosure += foreclosureCount;
      } catch (fileErr) {
        const msg = fileErr instanceof Error ? fileErr.message : String(fileErr);
        console.error(`[Cron] ✗ Error processing ${file.filename}: ${msg}`);
        // Continue with remaining files
      }
    }

    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    const result: CronResult = {
      success: true,
      filesProcessed: newFiles.length,
      probateLeadsInserted: totalProbate,
      foreclosureLeadsInserted: totalForeclosure,
      message: `Done in ${elapsed}s`,
    };

    console.log(`[Cron] ✓ Complete in ${elapsed}s:`, result);
    return NextResponse.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[Cron] ✗ Fatal pipeline error:", message);
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
