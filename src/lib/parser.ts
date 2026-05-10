// ============================================================
// CSV Parser — Hillsborough County real CSV structure.
//
// CONFIRMED COLUMN LAYOUT (both Civil and Probate after transformHeader):
//   casecategory, casetypedescription, casenumber, title,
//   filingdate, partytype, firstname, middlename,
//   lastname_companyname, [dateofdeath - probate only],
//   partyaddress, attorney
//
// KEY FACTS (confirmed from real production files):
//   - UTF-8-SIG encoding (BOM \uFEFF at byte 0)
//   - CRLF line endings
//   - Comma delimited, values quoted with "
//   - Multiple rows per case (one per party)
//   - PartyType values (probate):  Petitioner, Decedent, Beneficiary,
//                                  Trustee, Caveator, Ward, Next of Kin,
//                                  Subject, Minor
//   - PartyType values (civil):    Plaintiff, Defendant,
//                                  Petitioner, Respondent
//   - PartyAddress: single string "123 St, City, FL 33601"
//   - Attorney: may be "No Attorney"
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
function transformHeader(h: string): string {
  return h.trim().toLowerCase().replace(/[\s\-\/]+/g, "_");
}

// ---- Sanitize input -------------------------------------------
// Forces to string (guards against Buffer arriving from axios),
// strips UTF-8 BOM, normalises line endings.
function sanitize(input: unknown): string {
  let s: string;

  if (typeof input === "string") {
    s = input;
  } else if (Buffer.isBuffer(input)) {
    // axios responseType:"arraybuffer" decoded by downloader as Buffer
    s = (input as Buffer).toString("utf8");
    console.log("[Parser] Input was Buffer — converted to utf8 string");
  } else if (input instanceof ArrayBuffer) {
    s = Buffer.from(input).toString("utf8");
    console.log("[Parser] Input was ArrayBuffer — converted to utf8 string");
  } else if (input instanceof Uint8Array) {
    s = Buffer.from(input).toString("utf8");
    console.log("[Parser] Input was Uint8Array — converted to utf8 string");
  } else {
    // Last resort
    s = String(input);
    console.log(`[Parser] Input was ${typeof input} — coerced with String()`);
  }

  // Strip UTF-8 BOM (\uFEFF = 0xEF 0xBB 0xBF)
  if (s.charCodeAt(0) === 0xfeff) {
    s = s.slice(1);
    console.log("[Parser] Stripped BOM");
  }

  // Normalise CRLF → LF, bare CR → LF
  s = s.replace(/\r\n/g, "\n").replace(/\r/g, "\n");

  return s;
}

// ---- Name assembly --------------------------------------------
function assembleName(row: RawRow | null): string | null {
  if (!row) return null;
  const first = cleanString(row["firstname"]) ?? "";
  const middle = cleanString(row["middlename"]) ?? "";
  const last = cleanString(row["lastname_companyname"]) ?? "";
  const full = [first, middle, last].filter(Boolean).join(" ").trim();
  return normalizeName(full) ?? null;
}

// ---- Address parsing ------------------------------------------
// Format: "123 Main St, Tampa, FL 33610"
//         "801 N. Orange Ave, Suite 500, Orlando, FL 32801"
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
    // Everything except last two parts = street address
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

// ---- Pick party row by PartyType priority --------------------
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
  csvContent: unknown,
  filename: string
): { probateLeads: ProbateLead[]; foreclosureLeads: ForeclosureLead[] } {

  // ---- Step 1: Sanitize ----
  console.log(`[Parser] === START ${filename} ===`);
  console.log(`[Parser] Input type: ${typeof csvContent}, isBuffer: ${Buffer.isBuffer(csvContent)}`);
  console.log(`[Parser] Input length: ${typeof csvContent === "string" ? (csvContent as string).length : "n/a"}`);

  const sanitized = sanitize(csvContent);

  console.log(`[Parser] Sanitized length: ${sanitized.length} chars`);
  console.log(`[Parser] First 120 chars: ${JSON.stringify(sanitized.slice(0, 120))}`);

  if (!sanitized || sanitized.trim().length === 0) {
    console.error(`[Parser] ABORT ${filename}: sanitized content is empty`);
    return { probateLeads: [], foreclosureLeads: [] };
  }

  // ---- Step 2: Parse CSV ----
  const result = Papa.parse<RawRow>(sanitized, {
    header: true,
    skipEmptyLines: true,
    transformHeader,
    delimiter: ",",
  });

  console.log(`[Parser] Rows parsed: ${result.data.length}`);
  console.log(`[Parser] Parse errors: ${result.errors.length}`);
  if (result.errors.length > 0) {
    console.warn(`[Parser] First 3 errors:`, JSON.stringify(result.errors.slice(0, 3)));
  }

  if (result.data.length === 0) {
    // Attempt 2: no skipEmptyLines
    console.warn(`[Parser] Retrying without skipEmptyLines...`);
    const r2 = Papa.parse<RawRow>(sanitized, {
      header: true,
      skipEmptyLines: false,
      transformHeader,
      delimiter: ",",
    });
    result.data = r2.data.filter((row) =>
      Object.values(row).some((v) => v && v.trim() !== "")
    );
    console.log(`[Parser] Retry rows: ${result.data.length}`);
  }

  if (result.data.length === 0) {
    console.error(`[Parser] ABORT ${filename}: zero rows after all parse attempts`);
    return { probateLeads: [], foreclosureLeads: [] };
  }

  // Log detected headers
  const headers = result.meta.fields ?? Object.keys(result.data[0] ?? {});
  console.log(`[Parser] Headers: ${JSON.stringify(headers)}`);

  // ---- Step 3: Group by case number ----
  const groups = groupByCaseNumber(result.data);
  console.log(`[Parser] Unique cases: ${groups.size}`);

  // ---- Step 4: Build lead objects ----
  const probateLeads: ProbateLead[] = [];
  const foreclosureLeads: ForeclosureLead[] = [];

  for (const [caseNumber, caseRows] of groups) {
    const anchor = caseRows[0];
    const caseType = cleanString(anchor["casetypedescription"]);

    if (!caseType) {
      console.log(`[Parser] SKIP ${caseNumber}: empty casetypedescription`);
      continue;
    }

    const filingDate = parseDate(anchor["filingdate"]);

    const attorneyRaw =
      caseRows
        .map((r) => cleanString(r["attorney"]))
        .find((a) => a && a.toLowerCase() !== "no attorney") ?? null;
    const attorney = normalizeName(attorneyRaw);

    if (isProbateLead(caseType)) {
      const decedentRow = pickParty(caseRows, "Decedent");
      const petitionerRow = pickParty(
        caseRows, "Petitioner", "Trustee", "Subject", "Ward"
      );
      const addressRow = petitionerRow ?? decedentRow ?? anchor;
      const { address, city, state, zip } = parseAddress(
        addressRow["partyaddress"]
      );

      const lead: ProbateLead = {
        case_number: caseNumber,
        filing_date: filingDate,
        deceased_name: assembleName(decedentRow),
        petitioner: assembleName(petitionerRow),
        attorney,
        address,
        city,
        state,
        zip,
        county: "Hillsborough",
        case_type: normalizeCaseType(caseType),
        source_file: filename,
        raw_data: anchor as Record<string, unknown>,
      };

      console.log(
        `[Parser] Probate lead created: ${caseNumber} | type="${lead.case_type}" | deceased="${lead.deceased_name}" | petitioner="${lead.petitioner}"`
      );
      probateLeads.push(lead);
    } else if (isForeclosureLead(caseType)) {
      const plaintiffRow = pickParty(caseRows, "Plaintiff", "Petitioner");
      const defendantRow = pickParty(caseRows, "Defendant", "Respondent");
      const addressRow = defendantRow ?? plaintiffRow ?? anchor;
      const { address, city, state, zip } = parseAddress(
        addressRow["partyaddress"]
      );

      const lead: ForeclosureLead = {
        case_number: caseNumber,
        filing_date: filingDate,
        plaintiff: assembleName(plaintiffRow),
        defendant: assembleName(defendantRow),
        attorney,
        address,
        city,
        state,
        zip,
        county: "Hillsborough",
        case_type: normalizeCaseType(caseType),
        source_file: filename,
        raw_data: anchor as Record<string, unknown>,
      };

      console.log(
        `[Parser] Foreclosure lead created: ${caseNumber} | type="${lead.case_type}" | plaintiff="${lead.plaintiff}" | defendant="${lead.defendant}"`
      );
      foreclosureLeads.push(lead);
    } else {
      console.log(
        `[Parser] SKIP ${caseNumber}: "${caseType}" — not a probate or foreclosure lead`
      );
    }
  }

  console.log(`[Parser] Final probate leads: ${probateLeads.length}`);
  console.log(`[Parser] Final foreclosure leads: ${foreclosureLeads.length}`);
  console.log(`[Parser] === END ${filename} ===`);

  return { probateLeads, foreclosureLeads };
}
