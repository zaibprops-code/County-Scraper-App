// ============================================================
// /api/cron — Daily ingestion pipeline
// Auth check disabled for MVP/testing.
// ============================================================

import { NextResponse } from "next/server";
import { downloadNewFiles, markFileProcessed } from "@/lib/downloader";
import { parseCsvFile } from "@/lib/parser";
import { storeProbateLeads, storeForeclosureLeads } from "@/lib/storage";
import type { CronResult } from "@/types/leads";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(): Promise<NextResponse> {
  console.log("[Cron] ▶ Starting daily lead ingestion pipeline...");
  const startTime = Date.now();

  try {
    const newFiles = await downloadNewFiles();

    if (newFiles.length === 0) {
      const result: CronResult = {
        success: true,
        filesProcessed: 0,
        probateLeadsInserted: 0,
        foreclosureLeadsInserted: 0,
        message: "No new files found. Everything is up to date.",
      };
      console.log("[Cron] ✓ No new files.");
      return NextResponse.json(result);
    }

    let totalProbate = 0;
    let totalForeclosure = 0;

    for (const file of newFiles) {
      console.log(`[Cron] Processing: ${file.filename}`);

      try {
        const { probateLeads, foreclosureLeads } = parseCsvFile(
          file.localPath,
          file.filename
        );

        const [probateCount, foreclosureCount] = await Promise.all([
          storeProbateLeads(probateLeads),
          storeForeclosureLeads(foreclosureLeads),
        ]);

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
      } catch (fileError) {
        console.error(`[Cron] Error processing ${file.filename}:`, fileError);
      }
    }

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    const result: CronResult = {
      success: true,
      filesProcessed: newFiles.length,
      probateLeadsInserted: totalProbate,
      foreclosureLeadsInserted: totalForeclosure,
      message: `Pipeline completed in ${elapsed}s`,
    };

    console.log("[Cron] ✓ Done.", result);
    return NextResponse.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[Cron] ✗ Pipeline failed:", message);
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
