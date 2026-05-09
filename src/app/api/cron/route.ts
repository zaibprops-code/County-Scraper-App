// ============================================================
// /api/cron — Daily ingestion pipeline
// Triggered by Vercel Cron (vercel.json) every day at 08:00 UTC.
// Protected by Authorization: Bearer <CRON_SECRET> header.
// Can also be triggered manually:
//   curl -H "Authorization: Bearer $CRON_SECRET" https://your-app.vercel.app/api/cron
// ============================================================

import { NextRequest, NextResponse } from "next/server";
import { downloadNewFiles, markFileProcessed } from "@/lib/downloader";
import { parseCsvFile } from "@/lib/parser";
import { storeProbateLeads, storeForeclosureLeads } from "@/lib/storage";
import type { CronResult } from "@/types/leads";

export const dynamic = "force-dynamic";
// Allow up to 60 seconds (increase to 300 on Vercel Pro if needed)
export const maxDuration = 60;

export async function GET(request: NextRequest): Promise<NextResponse> {
  // ---- Auth check ----
  const authHeader = request.headers.get("authorization");
  const cronSecret = process.env.CRON_SECRET;

  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  console.log("[Cron] ▶ Starting daily lead ingestion pipeline...");
  const startTime = Date.now();

  try {
    // Step 1 — Discover and download new CSV files
    const newFiles = await downloadNewFiles();

    if (newFiles.length === 0) {
      const result: CronResult = {
        success: true,
        filesProcessed: 0,
        probateLeadsInserted: 0,
        foreclosureLeadsInserted: 0,
        message: "No new files found. Everything is up to date.",
      };
      console.log("[Cron] ✓ No new files.", result.message);
      return NextResponse.json(result);
    }

    let totalProbate = 0;
    let totalForeclosure = 0;

    // Step 2 — Parse and store each file
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

        // Step 3 — Mark file as processed in Supabase
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
        // Continue with remaining files even if one fails
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
