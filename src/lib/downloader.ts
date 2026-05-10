// ============================================================
// CSV File Downloader — in-memory only, no filesystem.
// Discovers CSV files from Hillsborough County directories.
//
// REAL URL PATTERNS:
//   Probate: https://publicrec.hillsclerk.com/Probate/dailyfilings/
//   Civil:   https://publicrec.hillsclerk.com/Civil/dailyfilings/
//
// REAL FILENAME PATTERNS:
//   ProbateFiling_20260508.csv
//   CivilFiling_20260507.csv
// ============================================================

import axios from "axios";
import { getSupabaseAdmin } from "./supabase";
import type { SourceType } from "@/types/leads";

const PROBATE_BASE_URL =
  process.env.PROBATE_BASE_URL ||
  "https://publicrec.hillsclerk.com/Probate/dailyfilings/";
const CIVIL_BASE_URL =
  process.env.CIVIL_BASE_URL ||
  "https://publicrec.hillsclerk.com/Civil/dailyfilings/";

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

// ---- Date extraction from filename ----------------------------
// Handles: ProbateFiling_20260508.csv, CivilFiling_20260507.csv
function extractDateFromFilename(filename: string): string | null {
  const match = filename.match(/(\d{8})/);
  if (!match) return null;
  const raw = match[1];
  const year = raw.slice(0, 4);
  const month = raw.slice(4, 6);
  const day = raw.slice(6, 8);
  // Validate it looks like a real date
  const y = parseInt(year, 10);
  const m = parseInt(month, 10);
  const d = parseInt(day, 10);
  if (y < 2000 || y > 2100 || m < 1 || m > 12 || d < 1 || d > 31) {
    return null;
  }
  return `${year}-${month}-${day}`;
}

// ---- HTML scraping with multiple fallback strategies ----------
function extractCsvLinksFromHtml(
  html: string,
  baseUrl: string,
  sourceType: SourceType
): DiscoveredFile[] {
  const files: DiscoveredFile[] = [];
  const seen = new Set<string>();

  const normalizedBase = baseUrl.endsWith("/")
    ? baseUrl.slice(0, -1)
    : baseUrl;

  console.log(`[Downloader] HTML length: ${html.length} chars`);
  console.log(
    `[Downloader] HTML snippet: ${JSON.stringify(html.slice(0, 500))}`
  );

  // Strategy 1: match href="...*.csv" attributes (quoted)
  const hrefRegex = /href=["']([^"']*\.csv)["']/gi;
  let match: RegExpExecArray | null;
  while ((match = hrefRegex.exec(html)) !== null) {
    const href = match[1];
    const filename = href.split("/").pop() ?? href;
    if (seen.has(filename)) continue;
    seen.add(filename);
    const url = href.startsWith("http")
      ? href
      : `${normalizedBase}/${filename}`;
    const fileDate = extractDateFromFilename(filename);
    console.log(
      `[Downloader] Strategy1 found: ${filename} → date: ${fileDate} → url: ${url}`
    );
    files.push({ filename, url, sourceType, fileDate });
  }

  // Strategy 2: match unquoted hrefs href=...csv
  if (files.length === 0) {
    const unquotedRegex = /href=([^\s>'"]+\.csv)/gi;
    while ((match = unquotedRegex.exec(html)) !== null) {
      const href = match[1];
      const filename = href.split("/").pop() ?? href;
      if (seen.has(filename)) continue;
      seen.add(filename);
      const url = href.startsWith("http")
        ? href
        : `${normalizedBase}/${filename}`;
      const fileDate = extractDateFromFilename(filename);
      console.log(
        `[Downloader] Strategy2 found: ${filename} → date: ${fileDate}`
      );
      files.push({ filename, url, sourceType, fileDate });
    }
  }

  // Strategy 3: find any token that looks like a CSV filename
  if (files.length === 0) {
    const filenameRegex =
      /(?:Probate|Civil)Filing_\d{8}\.csv/gi;
    while ((match = filenameRegex.exec(html)) !== null) {
      const filename = match[0];
      if (seen.has(filename)) continue;
      seen.add(filename);
      const url = `${normalizedBase}/${filename}`;
      const fileDate = extractDateFromFilename(filename);
      console.log(
        `[Downloader] Strategy3 found: ${filename} → date: ${fileDate}`
      );
      files.push({ filename, url, sourceType, fileDate });
    }
  }

  // Strategy 4: match any *.csv token anywhere in HTML
  if (files.length === 0) {
    const anyCsvRegex = /[\w\-]+\.csv/gi;
    while ((match = anyCsvRegex.exec(html)) !== null) {
      const filename = match[0];
      if (seen.has(filename)) continue;
      seen.add(filename);
      const url = `${normalizedBase}/${filename}`;
      const fileDate = extractDateFromFilename(filename);
      console.log(
        `[Downloader] Strategy4 found: ${filename} → date: ${fileDate}`
      );
      files.push({ filename, url, sourceType, fileDate });
    }
  }

  console.log(
    `[Downloader] Total CSV links found at ${baseUrl}: ${files.length}`
  );
  return files;
}

// ---- Discover CSV files from a directory page -----------------
async function discoverCsvFiles(
  baseUrl: string,
  sourceType: SourceType
): Promise<DiscoveredFile[]> {
  console.log(`[Downloader] Scraping directory: ${baseUrl}`);

  let html = "";

  // Try multiple request approaches
  const attempts = [
    {
      label: "arraybuffer+utf8",
      config: {
        responseType: "arraybuffer" as const,
        timeout: 25000,
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36",
          Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "Accept-Language": "en-US,en;q=0.9",
          Connection: "keep-alive",
        },
      },
    },
    {
      label: "text",
      config: {
        responseType: "text" as const,
        timeout: 25000,
        headers: {
          "User-Agent":
            "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
          Accept: "text/html",
        },
      },
    },
  ];

  for (const attempt of attempts) {
    try {
      console.log(`[Downloader] HTTP attempt: ${attempt.label} for ${baseUrl}`);
      const response = await axios.get(baseUrl, attempt.config as object);

      if (attempt.label === "arraybuffer+utf8") {
        const buf = Buffer.from(response.data as ArrayBuffer);
        html = buf.toString("utf8").replace(/^\uFEFF/, "");
      } else {
        html = String(response.data).replace(/^\uFEFF/, "");
      }

      console.log(
        `[Downloader] HTTP ${attempt.label} success: status=${response.status} content-length=${html.length}`
      );
      break;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(
        `[Downloader] HTTP ${attempt.label} failed for ${baseUrl}: ${msg}`
      );
    }
  }

  if (!html) {
    console.error(
      `[Downloader] All HTTP attempts failed for ${baseUrl}. Returning empty.`
    );
    return [];
  }

  const files = extractCsvLinksFromHtml(html, baseUrl, sourceType);

  // Sort descending by filename (newest first)
  files.sort((a, b) => b.filename.localeCompare(a.filename));

  if (files.length > 0) {
    console.log(
      `[Downloader] Most recent file: ${files[0].filename} (${files[0].fileDate})`
    );
  }

  return files;
}

// ---- Already-processed filenames from Supabase ----------------
async function getProcessedFilenames(): Promise<Set<string>> {
  const admin = getSupabaseAdmin();
  const { data, error } = await admin
    .from("processed_files")
    .select("filename");

  if (error) {
    console.error("[Downloader] Could not fetch processed files:", error);
    return new Set();
  }

  const names = new Set(
    (data ?? []).map((row: { filename: string }) => row.filename)
  );
  console.log(`[Downloader] Already processed: ${names.size} file(s)`);
  return names;
}

// ---- Download a single CSV file as UTF-8 string ---------------
async function fetchCsvContent(
  url: string,
  filename: string
): Promise<string> {
  console.log(`[Downloader] Downloading CSV: ${url}`);

  const response = await axios.get<ArrayBuffer>(url, {
    responseType: "arraybuffer",
    timeout: 30000,
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36",
      Accept: "text/csv,text/plain,*/*",
    },
  });

  const buffer = Buffer.from(response.data);
  const text = buffer.toString("utf8");

  console.log(
    `[Downloader] ${filename}: ${buffer.length} bytes → ${text.length} chars`
  );
  console.log(
    `[Downloader] ${filename}: BOM=${text.charCodeAt(0) === 0xfeff} first50=${JSON.stringify(text.slice(0, 50))}`
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
    console.error(
      `[Downloader] Failed to mark ${file.filename} as processed:`,
      error
    );
  } else {
    console.log(
      `[Downloader] Marked processed: ${file.filename} (${rowCount} rows)`
    );
  }
}

// ---- Public: discover and download all new CSV files ----------
export async function downloadNewFiles(): Promise<DownloadResult[]> {
  console.log("[Downloader] ▶ Starting file discovery...");
  console.log(`[Downloader] Probate URL: ${PROBATE_BASE_URL}`);
  console.log(`[Downloader] Civil URL:   ${CIVIL_BASE_URL}`);

  const [probateFiles, civilFiles] = await Promise.all([
    discoverCsvFiles(PROBATE_BASE_URL, "probate"),
    discoverCsvFiles(CIVIL_BASE_URL, "civil"),
  ]);

  const allFiles: DiscoveredFile[] = [...probateFiles, ...civilFiles];

  console.log(`[Downloader] Total discovered: ${allFiles.length} file(s)`);
  allFiles.forEach((f) =>
    console.log(
      `[Downloader]   ${f.sourceType} | ${f.filename} | date=${f.fileDate} | url=${f.url}`
    )
  );

  if (allFiles.length === 0) {
    console.warn(
      "[Downloader] No CSV files discovered. Check that the county directory pages are accessible from Vercel."
    );
    return [];
  }

  const processedSet = await getProcessedFilenames();
  const newFiles = allFiles.filter((f) => {
    const isNew = !processedSet.has(f.filename);
    console.log(
      `[Downloader] ${f.filename}: ${isNew ? "NEW → will download" : "already processed → skipping"}`
    );
    return isNew;
  });

  console.log(
    `[Downloader] New files to download: ${newFiles.length} of ${allFiles.length}`
  );

  if (newFiles.length === 0) {
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
      console.log(`[Downloader] ✓ Downloaded: ${file.filename}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[Downloader] ✗ Failed to download ${file.filename}: ${msg}`);
    }
  }

  console.log(
    `[Downloader] ✓ Done. ${results.length} file(s) ready for parsing.`
  );
  return results;
}
