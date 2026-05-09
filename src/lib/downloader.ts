// ============================================================
// CSV File Downloader
// Discovers and downloads new CSV files from county directories.
// Tracks already-processed files in Supabase to avoid repeats.
// ============================================================

import axios from "axios";
import * as cheerio from "cheerio";
import * as fs from "fs";
import * as path from "path";
import { getSupabaseAdmin } from "./supabase";
import type { DiscoveredFile, DownloadResult, SourceType } from "@/types/leads";

const PROBATE_BASE_URL =
  process.env.PROBATE_BASE_URL ||
  "https://publicrec.hillsclerk.com/Probate/dailyfilings/";
const CIVIL_BASE_URL =
  process.env.CIVIL_BASE_URL ||
  "https://publicrec.hillsclerk.com/Civil/dailyfilings/";
const RAW_DATA_DIR = path.join(process.cwd(), "raw-data");

// Ensure raw-data dir exists
if (!fs.existsSync(RAW_DATA_DIR)) {
  fs.mkdirSync(RAW_DATA_DIR, { recursive: true });
}

/**
 * Extract ISO date from a filename like CivilFiling_20260507.csv
 */
function extractDateFromFilename(filename: string): string | null {
  const match = filename.match(/(\d{8})/);
  if (!match) return null;
  const raw = match[1];
  return `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}`;
}

/**
 * Scrape the county directory page and return all CSV links found.
 */
async function discoverCsvFiles(
  baseUrl: string,
  sourceType: SourceType
): Promise<DiscoveredFile[]> {
  try {
    const response = await axios.get(baseUrl, {
      timeout: 20000,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        Accept: "text/html,application/xhtml+xml",
      },
    });

    const $ = cheerio.load(response.data as string);
    const files: DiscoveredFile[] = [];

    // Match all anchor tags pointing to CSV files
    $("a").each((_, el) => {
      const href = $(el).attr("href");
      if (!href) return;
      if (!/\.csv$/i.test(href)) return;

      const filename = path.basename(href);
      let url = href;

      // Resolve relative URLs
      if (!href.startsWith("http")) {
        const base = baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;
        url = `${base}/${filename}`;
      }

      files.push({
        filename,
        url,
        sourceType,
        fileDate: extractDateFromFilename(filename),
      });
    });

    // Sort newest first
    files.sort((a, b) => b.filename.localeCompare(a.filename));
    console.log(
      `[Downloader] Discovered ${files.length} CSV files at ${baseUrl}`
    );
    return files;
  } catch (error) {
    console.error(
      `[Downloader] Failed to scrape directory ${baseUrl}:`,
      error
    );
    return [];
  }
}

/**
 * Fetch the set of already-processed filenames from Supabase.
 */
async function getProcessedFilenames(): Promise<Set<string>> {
  const admin = getSupabaseAdmin();
  const { data, error } = await admin
    .from("processed_files")
    .select("filename");

  if (error) {
    console.error("[Downloader] Could not fetch processed files:", error);
    return new Set();
  }

  return new Set((data ?? []).map((row: { filename: string }) => row.filename));
}

/**
 * Download a CSV file to raw-data/ on disk.
 */
async function downloadFile(file: DiscoveredFile): Promise<string> {
  const localPath = path.join(RAW_DATA_DIR, file.filename);

  if (fs.existsSync(localPath)) {
    console.log(`[Downloader] Already on disk: ${file.filename}`);
    return localPath;
  }

  console.log(`[Downloader] Downloading: ${file.url}`);
  const response = await axios.get(file.url, {
    responseType: "arraybuffer",
    timeout: 30000,
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
    },
  });

  fs.writeFileSync(localPath, Buffer.from(response.data as ArrayBuffer));
  console.log(`[Downloader] Saved to ${localPath}`);
  return localPath;
}

/**
 * Mark a file as processed in Supabase, storing row count.
 */
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
    console.log(`[Downloader] Marked as processed: ${file.filename}`);
  }
}

/**
 * Main entry: discover and download all new CSV files from both directories.
 * Returns an array of DownloadResult for each new file fetched.
 */
export async function downloadNewFiles(): Promise<DownloadResult[]> {
  const [probateFiles, civilFiles] = await Promise.all([
    discoverCsvFiles(PROBATE_BASE_URL, "probate"),
    discoverCsvFiles(CIVIL_BASE_URL, "civil"),
  ]);

  const allFiles: DiscoveredFile[] = [...probateFiles, ...civilFiles];

  if (allFiles.length === 0) {
    console.log("[Downloader] No CSV files found in directories.");
    return [];
  }

  const processedSet = await getProcessedFilenames();
  const newFiles = allFiles.filter((f) => !processedSet.has(f.filename));

  console.log(
    `[Downloader] ${newFiles.length} new file(s) out of ${allFiles.length} discovered.`
  );

  const results: DownloadResult[] = [];

  for (const file of newFiles) {
    try {
      const localPath = await downloadFile(file);
      results.push({
        filename: file.filename,
        localPath,
        sourceType: file.sourceType,
        fileDate: file.fileDate,
      });
    } catch (err) {
      console.error(`[Downloader] Failed to download ${file.filename}:`, err);
    }
  }

  return results;
}

export type { DiscoveredFile, DownloadResult };
