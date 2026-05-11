// ============================================================
// CSV File Downloader — in-memory only, no filesystem.
// Fetches only the explicit date range supplied by the caller.
// ============================================================

import axios from "axios";
import { getSupabaseAdmin } from "./supabase";
import type { SourceType, DownloadResult, DiscoveredFile } from "@/types/leads";

const PROBATE_BASE_URL = (
  process.env.PROBATE_BASE_URL ||
  "https://publicrec.hillsclerk.com/Probate/dailyfilings/"
).replace(/\/$/, "") + "/";

const CIVIL_BASE_URL = (
  process.env.CIVIL_BASE_URL ||
  "https://publicrec.hillsclerk.com/Civil/dailyfilings/"
).replace(/\/$/, "") + "/";

const REQUEST_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36",
  Accept: "text/csv,text/plain,*/*",
  "Accept-Language": "en-US,en;q=0.9",
};

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

/** All calendar dates from isoFrom to isoTo inclusive (YYYY-MM-DD) */
function datesBetween(isoFrom: string, isoTo: string): Date[] {
  const [fy, fm, fd] = isoFrom.split("-").map(Number);
  const [ty, tm, td] = isoTo.split("-").map(Number);
  const start = new Date(Date.UTC(fy, fm - 1, fd));
  const end = new Date(Date.UTC(ty, tm - 1, td));
  const dates: Date[] = [];
  const cur = new Date(start);
  while (cur <= end) {
    dates.push(new Date(cur));
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return dates;
}

// ---- Download one CSV file ------------------------------------

async function fetchCsvContent(
  url: string,
  filename: string
): Promise<string | null> {
  console.log(`[Downloader] Trying: ${url}`);
  try {
    const resp = await axios.get<ArrayBuffer>(url, {
      responseType: "arraybuffer",
      timeout: 12000,
      headers: REQUEST_HEADERS,
      validateStatus: (s) => s < 500,
    });

    console.log(`[Downloader] HTTP ${resp.status} — ${filename} (${(resp.data as ArrayBuffer).byteLength} bytes)`);

    if (resp.status !== 200) return null;

    const buf = Buffer.from(resp.data as ArrayBuffer);
    const text = buf.toString("utf8");
    console.log(`[Downloader] Download success: ${filename} BOM=${text.charCodeAt(0) === 0xfeff}`);
    return text;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log(`[Downloader] No file for ${filename}: ${msg}`);
    return null;
  }
}

// ---- Fetch all files for one source across date range --------

async function fetchDatesForSource(
  baseUrl: string,
  filePrefix: string,
  sourceType: SourceType,
  dates: Date[]
): Promise<DownloadResult[]> {
  const fetches = dates.map(async (date) => {
    const yyyymmdd = toYYYYMMDD(date);
    const filename = `${filePrefix}${yyyymmdd}.csv`;
    const url = `${baseUrl}${filename}`;
    const fileDate = toISODate(date);

    const csvContent = await fetchCsvContent(url, filename);
    if (!csvContent) return null;

    return { filename, csvContent, sourceType, fileDate } as DownloadResult;
  });

  const settled = await Promise.allSettled(fetches);
  const results: DownloadResult[] = [];
  for (const r of settled) {
    if (r.status === "fulfilled" && r.value) results.push(r.value);
  }

  console.log(`[Downloader] ${filePrefix}: ${results.length} file(s) found in range`);
  return results;
}

// ---- Public: mark file processed in Supabase -----------------

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
    console.error(`[Downloader] Failed to mark ${file.filename}:`, error);
  } else {
    console.log(`[Downloader] Marked processed: ${file.filename} (${rowCount} leads)`);
  }
}

// ---- Public: download files for explicit date range ----------

export async function downloadFilesForRange(
  isoFrom: string,
  isoTo: string
): Promise<DownloadResult[]> {
  console.log(`[Downloader] ▶ Range: ${isoFrom} → ${isoTo}`);
  console.log(`[Downloader] Probate URL: ${PROBATE_BASE_URL}`);
  console.log(`[Downloader] Civil URL:   ${CIVIL_BASE_URL}`);

  const dates = datesBetween(isoFrom, isoTo);
  console.log(`[Downloader] Dates: ${dates.length} — ${dates.map(toYYYYMMDD).join(", ")}`);

  const [probate, civil] = await Promise.all([
    fetchDatesForSource(PROBATE_BASE_URL, "ProbateFiling_", "probate", dates),
    fetchDatesForSource(CIVIL_BASE_URL, "CivilFiling_", "civil", dates),
  ]);

  const all = [...probate, ...civil];
  console.log(`[Downloader] Total files ready: ${all.length}`);
  all.forEach((f) =>
    console.log(`[Downloader]   ${f.sourceType} | ${f.filename} | ${f.csvContent.length} chars`)
  );
  return all;
}

// ---- Legacy: Vercel daily cron falls back to today -----------

export async function downloadNewFiles(): Promise<DownloadResult[]> {
  const today = toISODate(new Date());
  console.log(`[Downloader] downloadNewFiles() → today: ${today}`);
  return downloadFilesForRange(today, today);
}
