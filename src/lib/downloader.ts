// ============================================================
// CSV File Downloader — in-memory only, no filesystem.
// Downloads CSV as binary (arraybuffer) then decodes as UTF-8
// so the raw string is passed intact to the parser, which
// strips the BOM itself. This avoids encoding corruption from
// axios responseType:"text" on some Node/Vercel environments.
// ============================================================

import axios from "axios";
import * as cheerio from "cheerio";
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

// ---- Helpers ---------------------------------------------------

function extractDateFromFilename(filename: string): string | null {
  const match = filename.match(/(\d{8})/);
  if (!match) return null;
  const raw = match[1];
  return `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}`;
}

async function discoverCsvFiles(
  baseUrl: string,
  sourceType: SourceType
): Promise<DiscoveredFile[]> {
  try {
    const response = await axios.get<string>(baseUrl, {
      responseType: "text",
      timeout: 20000,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        Accept: "text/html,application/xhtml+xml",
      },
    });

    const $ = cheerio.load(response.data);
    const files: DiscoveredFile[] = [];

    $("a").each((_, el) => {
      const href = $(el).attr("href");
      if (!href || !/\.csv$/i.test(href)) return;

      const filename = href.split("/").pop() ?? href;
      let url = href;
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

    files.sort((a, b) => b.filename.localeCompare(a.filename));
    console.log(
      `[Downloader] Discovered ${files.length} CSV file(s) at ${baseUrl}`
    );
    return files;
  } catch (err) {
    console.error(`[Downloader] Failed to scrape ${baseUrl}:`, err);
    return [];
  }
}

async function getProcessedFilenames(): Promise<Set<string>> {
  const admin = getSupabaseAdmin();
  const { data, error } = await admin
    .from("processed_files")
    .select("filename");

  if (error) {
    console.error("[Downloader] Could not fetch processed files:", error);
    return new Set();
  }

  return new Set(
    (data ?? []).map((row: { filename: string }) => row.filename)
  );
}

/**
 * Download a CSV as arraybuffer and decode explicitly as UTF-8.
 * This preserves the BOM character intact so the parser can detect
 * and strip it reliably, avoiding corruption from text-mode decoding.
 */
async function fetchCsvContent(url: string): Promise<string> {
  const response = await axios.get<ArrayBuffer>(url, {
    responseType: "arraybuffer",
    timeout: 30000,
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
    },
  });

  // Decode as UTF-8 — Buffer.from preserves every byte including BOM
  const buffer = Buffer.from(response.data);
  const text = buffer.toString("utf8");

  console.log(
    `[Downloader] Fetched ${buffer.length} bytes, decoded to ${text.length} chars`
  );
  console.log(
    `[Downloader] First byte hex: ${buffer.slice(0, 3).toString("hex")} (ef bb bf = UTF-8 BOM)`
  );

  return text;
}

// ---- Public API ------------------------------------------------

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
    `[Downloader] ${newFiles.length} new file(s) of ${allFiles.length} total discovered.`
  );

  const results: DownloadResult[] = [];

  for (const file of newFiles) {
    try {
      console.log(`[Downloader] Fetching: ${file.url}`);
      const csvContent = await fetchCsvContent(file.url);
      results.push({
        filename: file.filename,
        csvContent,
        sourceType: file.sourceType,
        fileDate: file.fileDate,
      });
    } catch (err) {
      console.error(`[Downloader] Failed to fetch ${file.filename}:`, err);
    }
  }

  return results;
}
