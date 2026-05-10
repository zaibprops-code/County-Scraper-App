// ============================================================
// CSV File Downloader — in-memory only, no filesystem.
//
// FILE DISCOVERY STRATEGY:
//   PRIMARY:  Construct filenames from the last 90 days of dates,
//             verify each exists with a HEAD request.
//             This is more reliable than scraping HTML because the
//             county directory page may be JS-rendered or non-standard.
//   FALLBACK: Scrape HTML anchor tags from the directory page.
//
// REAL URL PATTERNS:
//   Probate: https://publicrec.hillsclerk.com/Probate/dailyfilings/ProbateFiling_YYYYMMDD.csv
//   Civil:   https://publicrec.hillsclerk.com/Civil/dailyfilings/CivilFiling_YYYYMMDD.csv
// ============================================================

import axios from "axios";
import { getSupabaseAdmin } from "./supabase";
import type { SourceType } from "@/types/leads";

const PROBATE_BASE_URL =
  (process.env.PROBATE_BASE_URL || "https://publicrec.hillsclerk.com/Probate/dailyfilings/").replace(/\/$/, "") + "/";
const CIVIL_BASE_URL =
  (process.env.CIVIL_BASE_URL || "https://publicrec.hillsclerk.com/Civil/dailyfilings/").replace(/\/$/, "") + "/";

// How many past days to probe when constructing filenames
const DAYS_TO_PROBE = 90;

const AXIOS_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36",
  Accept: "text/csv,text/plain,text/html,*/*",
  "Accept-Language": "en-US,en;q=0.9",
  Connection: "keep-alive",
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

function lastNDates(n: number): Date[] {
  const dates: Date[] = [];
  const now = new Date();
  for (let i = 0; i < n; i++) {
    dates.push(
      new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - i))
    );
  }
  return dates;
}

function extractDateFromFilename(filename: string): string | null {
  const match = filename.match(/(\d{8})/);
  if (!match) return null;
  const raw = match[1];
  const y = parseInt(raw.slice(0, 4), 10);
  const m = parseInt(raw.slice(4, 6), 10);
  const d = parseInt(raw.slice(6, 8), 10);
  if (y < 2000 || y > 2100 || m < 1 || m > 12 || d < 1 || d > 31) return null;
  return `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}`;
}

// ---- Already-processed filenames from Supabase ----------------

async function getProcessedFilenames(): Promise<Set<string>> {
  const admin = getSupabaseAdmin();
  const { data, error } = await admin.from("processed_files").select("filename");

  if (error) {
    console.error("[Downloader] Could not fetch processed files:", error);
    return new Set();
  }

  const names = new Set(
    (data ?? []).map((row: { filename: string }) => row.filename)
  );
  console.log(`[Downloader] Already processed: ${names.size} file(s)`);
  if (names.size > 0) {
    console.log(`[Downloader] Processed list: ${[...names].slice(0, 10).join(", ")}`);
  }
  return names;
}

// ---- Strategy 1: Probe dates directly -------------------------

async function discoverByDateProbing(
  baseUrl: string,
  filePrefix: string,
  sourceType: SourceType
): Promise<DiscoveredFile[]> {
  console.log(
    `[Downloader] Strategy1 (date probing): prefix=${filePrefix} base=${baseUrl}`
  );

  const dates = lastNDates(DAYS_TO_PROBE);
  const found: DiscoveredFile[] = [];
  const BATCH = 7;

  for (let i = 0; i < dates.length; i += BATCH) {
    const batch = dates.slice(i, i + BATCH);

    const results = await Promise.allSettled(
      batch.map(async (date) => {
        const yyyymmdd = toYYYYMMDD(date);
        const filename = `${filePrefix}${yyyymmdd}.csv`;
        const url = `${baseUrl}${filename}`;

        try {
          const resp = await axios.head(url, {
            timeout: 8000,
            headers: AXIOS_HEADERS,
            validateStatus: (s) => s < 500,
          });

          console.log(`[Downloader] HEAD ${filename}: HTTP ${resp.status}`);

          if (resp.status === 200) {
            const fileDate = toISODate(date);
            console.log(
              `[Downloader] CSV discovered: ${filename} → date=${fileDate} → url=${url}`
            );
            return { filename, url, sourceType, fileDate } as DiscoveredFile;
          }
          return null;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          if (!msg.includes("timeout") && !msg.includes("ECONNREFUSED") && !msg.includes("ENOTFOUND")) {
            console.log(`[Downloader] HEAD ${filename}: ${msg}`);
          }
          return null;
        }
      })
    );

    for (const r of results) {
      if (r.status === "fulfilled" && r.value) found.push(r.value);
    }
  }

  console.log(
    `[Downloader] Strategy1: found ${found.length} file(s) for prefix ${filePrefix}`
  );
  return found;
}

// ---- Strategy 2: Scrape HTML directory page -------------------

async function discoverByHtmlScraping(
  baseUrl: string,
  sourceType: SourceType
): Promise<DiscoveredFile[]> {
  console.log(`[Downloader] Strategy2 (HTML scraping): ${baseUrl}`);

  let html = "";

  try {
    const resp = await axios.get<ArrayBuffer>(baseUrl, {
      responseType: "arraybuffer",
      timeout: 20000,
      headers: AXIOS_HEADERS,
      validateStatus: (s) => s < 500,
    });

    console.log(
      `[Downloader] Fetching directory: ${baseUrl} → HTTP ${resp.status} ${(resp.data as ArrayBuffer).byteLength} bytes`
    );

    if (resp.status !== 200) {
      console.warn(`[Downloader] Strategy2: HTTP ${resp.status} for ${baseUrl}`);
      return [];
    }

    const buf = Buffer.from(resp.data as ArrayBuffer);
    html = buf.toString("utf8").replace(/^\uFEFF/, "");

    console.log(`[Downloader] Directory fetched: ${html.length} chars`);
    console.log(`[Downloader] HTML snippet: ${JSON.stringify(html.slice(0, 500))}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[Downloader] Strategy2 failed for ${baseUrl}: ${msg}`);
    return [];
  }

  const found: DiscoveredFile[] = [];
  const seen = new Set<string>();
  const base = baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;

  const patterns: RegExp[] = [
    /href=["']([^"']*\.csv)["']/gi,
    /href=([^\s>'"]+\.csv)/gi,
    /(?:Probate|Civil)Filing_\d{8}\.csv/gi,
    /[\w]+_\d{8}\.csv/gi,
  ];

  for (const regex of patterns) {
    let match: RegExpExecArray | null;
    regex.lastIndex = 0;
    while ((match = regex.exec(html)) !== null) {
      const raw = match[1] ?? match[0];
      const filename = raw.split("/").pop() ?? raw;
      if (!filename.toLowerCase().endsWith(".csv")) continue;
      if (seen.has(filename)) continue;
      seen.add(filename);
      const url = raw.startsWith("http") ? raw : `${base}/${filename}`;
      const fileDate = extractDateFromFilename(filename);
      console.log(
        `[Downloader] CSV discovered: ${filename} → date=${fileDate} → url=${url}`
      );
      found.push({ filename, url, sourceType, fileDate });
    }
    if (found.length > 0) break;
  }

  console.log(
    `[Downloader] Strategy2: found ${found.length} file(s) at ${baseUrl}`
  );
  return found;
}

// ---- Download a single CSV ------------------------------------ 

async function fetchCsvContent(url: string, filename: string): Promise<string> {
  console.log(`[Downloader] Downloading: ${url}`);

  const resp = await axios.get<ArrayBuffer>(url, {
    responseType: "arraybuffer",
    timeout: 30000,
    headers: AXIOS_HEADERS,
  });

  const buf = Buffer.from(resp.data as ArrayBuffer);
  const text = buf.toString("utf8");

  console.log(
    `[Downloader] Download success: ${filename} — ${buf.length} bytes, ${text.length} chars, BOM=${text.charCodeAt(0) === 0xfeff}`
  );

  return text;
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
    console.error(`[Downloader] Failed to mark ${file.filename} as processed:`, error);
  } else {
    console.log(`[Downloader] Marked processed: ${file.filename} (${rowCount} rows)`);
  }
}

// ---- Public: main entry point ---------------------------------

export async function downloadNewFiles(): Promise<DownloadResult[]> {
  console.log("[Downloader] ▶ Starting file discovery...");
  console.log(`[Downloader] Probate base URL: ${PROBATE_BASE_URL}`);
  console.log(`[Downloader] Civil base URL:   ${CIVIL_BASE_URL}`);
  console.log(`[Downloader] Probing last ${DAYS_TO_PROBE} days`);

  const [probateFiles, civilFiles] = await Promise.all([
    discoverByDateProbing(PROBATE_BASE_URL, "ProbateFiling_", "probate").then(
      async (files) => {
        if (files.length > 0) return files;
        console.log("[Downloader] Probate Strategy1 found 0 → trying Strategy2");
        return discoverByHtmlScraping(PROBATE_BASE_URL, "probate");
      }
    ),
    discoverByDateProbing(CIVIL_BASE_URL, "CivilFiling_", "civil").then(
      async (files) => {
        if (files.length > 0) return files;
        console.log("[Downloader] Civil Strategy1 found 0 → trying Strategy2");
        return discoverByHtmlScraping(CIVIL_BASE_URL, "civil");
      }
    ),
  ]);

  const allFiles: DiscoveredFile[] = [...probateFiles, ...civilFiles].sort(
    (a, b) => b.filename.localeCompare(a.filename)
  );

  console.log(`[Downloader] Total files discovered: ${allFiles.length}`);
  allFiles.forEach((f) =>
    console.log(`[Downloader]   ${f.sourceType} | ${f.filename} | date=${f.fileDate}`)
  );

  if (allFiles.length === 0) {
    console.warn(
      "[Downloader] ✗ No CSV files discovered. " +
        "The county server may be unreachable from Vercel, or the URL/filename pattern has changed."
    );
    return [];
  }

  const processedSet = await getProcessedFilenames();

  const newFiles = allFiles.filter((f) => {
    const isNew = !processedSet.has(f.filename);
    console.log(
      `[Downloader] ${f.filename}: ${isNew ? "NEW → queued" : "already processed → skipping"}`
    );
    return isNew;
  });

  console.log(
    `[Downloader] New files to download: ${newFiles.length} of ${allFiles.length}`
  );

  if (newFiles.length === 0) {
    console.log("[Downloader] All discovered files already processed.");
    return [];
  }

  const results: DownloadResult[] = [];

  for (const file of newFiles) {
    try {
      const csvContent = await fetchCsvContent(file.url, file.filename);
      results.push({
        filename: file.filename,
        csvContent,
        sourceType: file.sourceType,
        fileDate: file.fileDate,
      });
      console.log(`[Downloader] ✓ Ready: ${file.filename}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[Downloader] ✗ Failed: ${file.filename}: ${msg}`);
    }
  }

  console.log(`[Downloader] ✓ Done. ${results.length} file(s) ready for parsing.`);
  return results;
}
