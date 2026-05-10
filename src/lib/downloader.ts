// ============================================================
// CSV File Downloader — in-memory only, no filesystem.
//
// STRATEGY: Direct GET for last 14 days (no HEAD probing).
// HEAD probing 90 days = 180 requests = Vercel 60s timeout risk.
// Direct GET of only last 14 days = fast, safe, reliable.
// Files that don't exist return non-200 and are skipped cleanly.
//
// REAL URL PATTERNS:
//   Probate: .../Probate/dailyfilings/ProbateFiling_YYYYMMDD.csv
//   Civil:   .../Civil/dailyfilings/CivilFiling_YYYYMMDD.csv
// ============================================================

import axios from "axios";
import { getSupabaseAdmin } from "./supabase";
import type { SourceType } from "@/types/leads";

const PROBATE_BASE_URL = (
  process.env.PROBATE_BASE_URL ||
  "https://publicrec.hillsclerk.com/Probate/dailyfilings/"
).replace(/\/$/, "") + "/";

const CIVIL_BASE_URL = (
  process.env.CIVIL_BASE_URL ||
  "https://publicrec.hillsclerk.com/Civil/dailyfilings/"
).replace(/\/$/, "") + "/";

// Only check last N days — keeps the cron well within 60s limit
const DAYS_TO_CHECK = 14;

const REQUEST_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36",
  Accept: "text/csv,text/plain,*/*",
  "Accept-Language": "en-US,en;q=0.9",
};

// ---- Types -----------------------------------------------------

export interface DiscoveredFile {
  filename: string;
  url: string;
  sourceType: SourceType;
  fileDate: string | null;
}

export interface DownloadResult {
  filename: string;
  csvContent: string;
  sourceType: SourceType;
  fileDate: string | null;
}

// ---- Date helpers ----------------------------------------------

function toYYYYMMDD(date: Date): string {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  const d = String(date.getUTCDate()).padStart(2, "0");
  return `${y}${m}${d}`;
}

function toISODate(date: Date): string {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  const d = String(date.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/** Returns array of Date objects for last N days starting from today UTC */
function lastNDates(n: number): Date[] {
  const today = new Date();
  return Array.from({ length: n }, (_, i) =>
    new Date(
      Date.UTC(
        today.getUTCFullYear(),
        today.getUTCMonth(),
        today.getUTCDate() - i
      )
    )
  );
}

// ---- Supabase: already-processed filenames --------------------

async function getProcessedFilenames(): Promise<Set<string>> {
  const admin = getSupabaseAdmin();
  const { data, error } = await admin
    .from("processed_files")
    .select("filename");

  if (error) {
    console.error("[Downloader] Could not fetch processed_files:", error);
    return new Set();
  }

  const names = new Set(
    (data ?? []).map((row: { filename: string }) => row.filename)
  );
  console.log(
    `[Downloader] Already processed: ${names.size} file(s)${names.size > 0 ? " — " + [...names].slice(0, 5).join(", ") : ""}`
  );
  return names;
}

// ---- Discover: try direct GET for each date ------------------

async function discoverAndFetch(
  baseUrl: string,
  filePrefix: string,
  sourceType: SourceType,
  processedSet: Set<string>
): Promise<DownloadResult[]> {
  const dates = lastNDates(DAYS_TO_CHECK);
  const results: DownloadResult[] = [];

  console.log(
    `[Downloader] Checking ${DAYS_TO_CHECK} dates for ${filePrefix}*.csv at ${baseUrl}`
  );

  // Check all dates concurrently
  const checks = dates.map(async (date) => {
    const yyyymmdd = toYYYYMMDD(date);
    const filename = `${filePrefix}${yyyymmdd}.csv`;
    const url = `${baseUrl}${filename}`;
    const fileDate = toISODate(date);

    // Skip already-processed
    if (processedSet.has(filename)) {
      console.log(`[Downloader] SKIP (already processed): ${filename}`);
      return null;
    }

    try {
      console.log(`[Downloader] Trying: ${url}`);
      const resp = await axios.get<ArrayBuffer>(url, {
        responseType: "arraybuffer",
        timeout: 12000,
        headers: REQUEST_HEADERS,
        validateStatus: (s) => s < 500, // don't throw on 404
      });

      console.log(
        `[Downloader] HTTP ${resp.status} for ${filename} (${(resp.data as ArrayBuffer).byteLength} bytes)`
      );

      if (resp.status !== 200) {
        // Non-200 = file doesn't exist for this date (expected for weekends/holidays)
        return null;
      }

      // Decode as UTF-8 string — preserves BOM for parser to strip
      const buf = Buffer.from(resp.data as ArrayBuffer);
      const csvContent = buf.toString("utf8");

      console.log(
        `[Downloader] CSV discovered: ${filename} | date=${fileDate} | ${buf.length} bytes | BOM=${csvContent.charCodeAt(0) === 0xfeff}`
      );

      return {
        filename,
        csvContent,
        sourceType,
        fileDate,
      } as DownloadResult;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // Timeouts / connection errors are expected for non-existent dates
      if (!msg.toLowerCase().includes("timeout") && !msg.includes("ENOTFOUND")) {
        console.error(`[Downloader] Error fetching ${filename}: ${msg}`);
      } else {
        console.log(`[Downloader] No file for ${filename}: ${msg}`);
      }
      return null;
    }
  });

  const settled = await Promise.allSettled(checks);
  for (const r of settled) {
    if (r.status === "fulfilled" && r.value) {
      results.push(r.value);
    }
  }

  console.log(
    `[Downloader] Found ${results.length} new file(s) for prefix ${filePrefix}`
  );
  return results;
}

// ---- Public: mark file processed ------------------------------

export async function markFileProcessed(
  file: DiscoveredFile,
  rowCount: number
): Promise<void> {
  const admin = getSupabaseAdmin();
  const { error } = await admin.from("processed_files").upsert(
    {
      filename: file.filename,
      source_type: file.sourceType,
      file_date: file.fileDate,
      row_count: rowCount,
    },
    { onConflict: "filename" }
  );

  if (error) {
    console.error(
      `[Downloader] Failed to mark ${file.filename} as processed:`,
      error
    );
  } else {
    console.log(
      `[Downloader] Marked processed: ${file.filename} (${rowCount} leads)`
    );
  }
}

// ---- Public: main entry point ---------------------------------

export async function downloadNewFiles(): Promise<DownloadResult[]> {
  console.log("[Downloader] ▶ Starting discovery...");
  console.log(`[Downloader] Probate URL: ${PROBATE_BASE_URL}`);
  console.log(`[Downloader] Civil URL:   ${CIVIL_BASE_URL}`);
  console.log(`[Downloader] Checking last ${DAYS_TO_CHECK} days`);

  const processedSet = await getProcessedFilenames();

  // Run probate and civil discovery in parallel
  const [probateResults, civilResults] = await Promise.all([
    discoverAndFetch(PROBATE_BASE_URL, "ProbateFiling_", "probate", processedSet),
    discoverAndFetch(CIVIL_BASE_URL, "CivilFiling_", "civil", processedSet),
  ]);

  const allResults = [...probateResults, ...civilResults];

  console.log(
    `[Downloader] Total new files ready for parsing: ${allResults.length}`
  );
  allResults.forEach((f) =>
    console.log(
      `[Downloader]   ${f.sourceType} | ${f.filename} | date=${f.fileDate} | ${f.csvContent.length} chars`
    )
  );

  if (allResults.length === 0) {
    console.log(
      "[Downloader] No new files found. Either all recent dates are already processed, " +
        "no files were published yet today, or the county server is unreachable."
    );
  }

  return allResults;
}
