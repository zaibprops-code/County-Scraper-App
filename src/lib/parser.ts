// ============================================================
// CSV Parser — Hillsborough County real CSV structure.
//
// CONFIRMED REAL COLUMN LAYOUT (both Civil and Probate):
//   CaseCategory, CaseTypeDescription, CaseNumber, Title,
//   FilingDate, PartyType, FirstName, MiddleName,
//   LastName/CompanyName, [DateofDeath - probate only],
//   PartyAddress, Attorney
//
// After transformHeader:
//   casecategory, casetypedescription, casenumber, title,
//   filingdate, partytype, firstname, middlename,
//   lastname_companyname, [dateofdeath], partyaddress, attorney
//
// KEY FACTS (confirmed from real files):
//   - UTF-8-SIG encoding (BOM: \uFEFF at start)
//   - CRLF line endings
//   - Comma delimited, values quoted with "
//   - Multiple rows per case (one per party)
//   - PartyType: Petitioner, Decedent, Plaintiff, Defendant,
//     Beneficiary, Trustee, Caveator, Subject
//   - PartyAddress is a single string: "123 St, City, FL 33601"
//   - Attorney field may contain "No Attorney"
// ============================================================

import Papa from "papaparse";
import { isProbateLead, isForeclosureLead, normalizeCaseType } from "./filter";
import {
  cleanString,
  normalizeName,
  parseDate,
  normalizeZip,
  normalizeCaseNumber,
} from "@/utils/clean";
import type { ProbateLead, ForeclosureLead } from "@/types/leads";

type RawRow = Record<string, string>;

// ---- Header transform -----------------------------------------
// "LastName/CompanyName" → "lastname_companyname"
// "CaseTypeDescription"  → "casetypedescription"
// "DateofDeath"          → "dateofdeath"
function transformHeader(h: string): string {
  return h
    .trim()
    .toLowerCase()
    .replace(/[\s\-\/]+/g, "_");
}

// ---- Strip BOM and normalize line endings ---------------------
function sanitizeCsvString(raw: string): string {
  // Strip UTF-8 BOM (\uFEFF) if present — Hillsborough CSVs are UTF-8-SIG
  let s = raw.replace(/^\uFEFF/, "");
  // Normalize CRLF → LF so PapaParse handles consistently
  s = s.replace(/\r\n/g, "\n");
  // Normalize bare CR → LF
  s = s.replace(/\r/g, "\n");
  return s;
}

// ---- Name assembly --------------------------------------------
function assembleName(row: RawRow): string | null {
  const first = cleanString(row["firstname"]) ?? "";
  const middle = cleanString(row["middlename"]) ?? "";
  const last = cleanString(row["lastname_companyname"]) ?? "";
  const full = [first, middle, last].filter(Boolean).join(" ").trim();
  return normalizeName(full) ?? null;
}

// ---- Address parsing ------------------------------------------
// Format observed: "6618 Travis blvd., Tampa, FL 33610"
// Or multi-part:   "801 N. Orange Avenue, Suite 500, Orlando, FL 32801"
function parseAddress(raw: string | undefined): {
  address: string | null;
  city: string | null;
  state: string;
  zip: string | null;
} {
  if (!raw || !raw.trim()) {
    return { address: null, city: null, state: "FL", zip: null };
  }

  const parts = raw.split(",").map((p) => p.trim()).filter(Boolean);

  if (parts.length >= 3) {
    const streetParts = parts.slice(0, parts.length - 2);
    const address = cleanString(streetParts.join(", "));
    const city = cleanString(parts[parts.length - 2]);
    const stateZip = parts[parts.length - 1].trim();
    const match = stateZip.match(/^([A-Z]{2})\s+(\d{5}(?:-\d{4})?)/);
    const state = match ? match[1] : "FL";
    const zip = match ? normalizeZip(match[2]) : null;
    return { address, city, state: state || "FL", zip };
  }

  if (parts.length === 2) {
    return {
      address: cleanString(parts[0]),
      city: cleanString(parts[1]),
      state: "FL",
      zip: null,
    };
  }

  return { address: cleanString(raw), city: null, state: "FL", zip: null };
}

// ---- Group rows by case number --------------------------------
function groupByCaseNumber(rows: RawRow[]): Map<string, RawRow[]> {
  const groups = new Map<string, RawRow[]>();
  for (const row of rows) {
    const cn = normalizeCaseNumber(row["casenumber"]);
    if (!cn) continue;
    if (!groups.has(cn)) groups.set(cn, []);
    groups.get(cn)!.push(row);
  }
  return groups;
}

// ---- Pick a party row by PartyType priority ------------------
function pickParty(rows: RawRow[], ...types: string[]): RawRow | null {
  for (const type of types) {
    const found = rows.find(
      (r) =>
        (r["partytype"] ?? "").toLowerCase().trim() === type.toLowerCase()
    );
    if (found) return found;
  }
  return null;
}

// ---- Main export ----------------------------------------------
export function parseCsvContent(
  csvContent: string,
  filename: string
): { probateLeads: ProbateLead[]; foreclosureLeads: ForeclosureLead[] } {

  // ---- DEBUG: log raw content info BEFORE sanitize ----
  console.log(`[Parser] RAW INPUT ${filename}:`);
  console.log(`  length: ${csvContent.length} chars`);
  console.log(`  first char codes: ${[...csvContent.slice(0, 6)].map(c => c.charCodeAt(0)).join(", ")}`);
  console.log(`  starts with BOM: ${csvContent.charCodeAt(0) === 0xFEFF}`);
  console.log(`  CRLF count: ${(csvContent.match(/\r\n/g) ?? []).length}`);
  console.log(`  LF count: ${(csvContent.match(/(?<!\r)\n/g) ?? []).length}`);
  console.log(`  CR count: ${(csvContent.match(/\r(?!\n)/g) ?? []).length}`);
  console.log(`  first 150 chars: ${JSON.stringify(csvContent.slice(0, 150))}`);

  // ---- Sanitize: strip BOM, normalize line endings ----
  const sanitized = sanitizeCsvString(csvContent);

  console.log(`[Parser] SANITIZED ${filename}:`);
  console.log(`  length: ${sanitized.length} chars`);
  console.log(`  first char codes: ${[...sanitized.slice(0, 6)].map(c => c.charCodeAt(0)).join(", ")}`);
  console.log(`  first 150 chars: ${JSON.stringify(sanitized.slice(0, 150))}`);

  // ---- Parse attempt 1: standard config ----
  let result = Papa.parse<RawRow>(sanitized, {
    header: true,
    skipEmptyLines: true,
    transformHeader,
    delimiter: ",",
  });

  console.log(`[Parser] ATTEMPT-1 ${filename}: rows=${result.data.length} errors=${result.errors.length}`);
  if (result.errors.length > 0) {
    console.log(`[Parser] ATTEMPT-1 errors:`, JSON.stringify(result.errors.slice(0, 3)));
  }
  if (result.meta?.fields) {
    console.log(`[Parser] ATTEMPT-1 headers: ${JSON.stringify(result.meta.fields)}`);
  }

  // ---- Parse attempt 2: if 0 rows, try without skipEmptyLines ----
  if (result.data.length === 0) {
    console.log(`[Parser] ATTEMPT-2 trying skipEmptyLines:false`);
    result = Papa.parse<RawRow>(sanitized, {
      header: true,
      skipEmptyLines: false,
      transformHeader,
      delimiter: ",",
    });
    console.log(`[Parser] ATTEMPT-2 rows=${result.data.length}`);
    if (result.meta?.fields) {
      console.log(`[Parser] ATTEMPT-2 headers: ${JSON.stringify(result.meta.fields)}`);
    }
    // Re-filter empty rows manually
    result.data = result.data.filter((r) =>
      Object.values(r).some((v) => v && v.trim() !== "")
    );
    console.log(`[Parser] ATTEMPT-2 after empty filter: rows=${result.data.length}`);
  }

  // ---- Parse attempt 3: no transformHeader, raw keys ----
  if (result.data.length === 0) {
    console.log(`[Parser] ATTEMPT-3 trying no transformHeader`);
    const raw3 = Papa.parse<RawRow>(sanitized, {
      header: true,
      skipEmptyLines: true,
      delimiter: ",",
    });
    console.log(`[Parser] ATTEMPT-3 rows=${raw3.data.length}`);
    if (raw3.meta?.fields) {
      console.log(`[Parser] ATTEMPT-3 raw headers: ${JSON.stringify(raw3.meta.fields)}`);
    }
    if (raw3.data.length > 0) {
      // Map raw headers to transformed manually
      const fieldMap: Record<string, string> = {};
      (raw3.meta.fields ?? []).forEach((f) => {
        fieldMap[f] = transformHeader(f);
      });
      result.data = raw3.data.map((row) => {
        const mapped: RawRow = {};
        for (const [origKey, val] of Object.entries(row)) {
          mapped[fieldMap[origKey] ?? transformHeader(origKey)] = val;
        }
        return mapped;
      });
      result.meta.fields = Object.values(fieldMap);
      console.log(`[Parser] ATTEMPT-3 after manual transform: rows=${result.data.length}`);
    }
  }

  const rows: RawRow[] = result.data;

  if (rows.length === 0) {
    console.error(`[Parser] ALL ATTEMPTS FAILED for ${filename}. No rows parsed.`);
    return { probateLeads: [], foreclosureLeads: [] };
  }

  if (rows.length > 0) {
    console.log(`[Parser] SUCCESS ${filename}: ${rows.length} raw rows`);
    console.log(`[Parser] Sample row keys: ${JSON.stringify(Object.keys(rows[0]))}`);
    console.log(`[Parser] Sample row: ${JSON.stringify(rows[0]).slice(0, 300)}`);
  }

  // ---- Group rows by case number ----
  const groups = groupByCaseNumber(rows);
  console.log(`[Parser] ${filename}: ${groups.size} unique case numbers`);

  const probateLeads: ProbateLead[] = [];
  const foreclosureLeads: ForeclosureLead[] = [];

  for (const [caseNumber, caseRows] of groups) {
    const anchor = caseRows[0];
    const caseType = cleanString(anchor["casetypedescription"]);
    if (!caseType) continue;

    const filingDate = parseDate(anchor["filingdate"]);

    // Attorney: first non-empty, non-"No Attorney" value across all party rows
    const attorneyRaw =
      caseRows
        .map((r) => cleanString(r["attorney"]))
        .find((a) => a && a.toLowerCase() !== "no attorney") ?? null;
    const attorney = normalizeName(attorneyRaw);

    if (isProbateLead(caseType)) {
      const decedentRow = pickParty(caseRows, "Decedent");
      const petitionerRow = pickParty(
        caseRows,
        "Petitioner",
        "Trustee",
        "Subject"
      );
      const addressRow = petitionerRow ?? decedentRow ?? anchor;
      const { address, city, state, zip } = parseAddress(
        addressRow["partyaddress"]
      );

      probateLeads.push({
        case_number: caseNumber,
        filing_date: filingDate,
        deceased_name: decedentRow ? assembleName(decedentRow) : null,
        petitioner: petitionerRow ? assembleName(petitionerRow) : null,
        attorney,
        address,
        city,
        state,
        zip,
        county: "Hillsborough",
        case_type: normalizeCaseType(caseType),
        source_file: filename,
        raw_data: anchor as Record<string, unknown>,
      });
    } else if (isForeclosureLead(caseType)) {
      const plaintiffRow = pickParty(caseRows, "Plaintiff", "Petitioner");
      const defendantRow = pickParty(caseRows, "Defendant", "Respondent");
      const addressRow = defendantRow ?? plaintiffRow ?? anchor;
      const { address, city, state, zip } = parseAddress(
        addressRow["partyaddress"]
      );

      foreclosureLeads.push({
        case_number: caseNumber,
        filing_date: filingDate,
        plaintiff: plaintiffRow ? assembleName(plaintiffRow) : null,
        defendant: defendantRow ? assembleName(defendantRow) : null,
        attorney,
        address,
        city,
        state,
        zip,
        county: "Hillsborough",
        case_type: normalizeCaseType(caseType),
        source_file: filename,
        raw_data: anchor as Record<string, unknown>,
      });
    }
  }

  console.log(
    `[Parser] FINAL ${filename} → ${probateLeads.length} probate, ${foreclosureLeads.length} foreclosure leads`
  );

  return { probateLeads, foreclosureLeads };
}
