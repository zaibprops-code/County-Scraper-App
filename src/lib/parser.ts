// ============================================================
// CSV Parser — Hillsborough County real CSV structure.
//
// CONFIRMED columns after transformHeader (snake_case):
//   casecategory, casetypedescription, casenumber, title,
//   filingdate, partytype, firstname, middlename,
//   lastname_companyname, dateofdeath (probate only),
//   partyaddress, attorney
//
// CONFIRMED facts from real production files:
//   - UTF-8 with BOM (\uFEFF byte 0)
//   - CRLF line endings
//   - Comma-delimited, double-quoted values
//   - Multiple rows per case (one row per party)
//   - PartyType (probate):    Petitioner, Decedent, Beneficiary,
//                             Trustee, Caveator, Ward, Subject
//   - PartyType (civil):      Plaintiff, Defendant, Petitioner,
//                             Respondent
//   - PartyAddress: "123 St, City, FL 33610"
//   - Attorney: "No Attorney" when unrepresented
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

// ---- Sanitize: force to string, strip BOM, normalize newlines -
function sanitize(input: unknown): string {
  let s: string;

  if (typeof input === "string") {
    s = input;
    console.log(`[Parser] Input: string, ${s.length} chars`);
  } else if (Buffer.isBuffer(input)) {
    s = (input as Buffer).toString("utf8");
    console.log(`[Parser] Input: Buffer → decoded utf8, ${s.length} chars`);
  } else if (input instanceof Uint8Array) {
    s = Buffer.from(input).toString("utf8");
    console.log(`[Parser] Input: Uint8Array → decoded utf8, ${s.length} chars`);
  } else if (input instanceof ArrayBuffer) {
    s = Buffer.from(input).toString("utf8");
    console.log(`[Parser] Input: ArrayBuffer → decoded utf8, ${s.length} chars`);
  } else {
    s = String(input ?? "");
    console.log(`[Parser] Input: ${typeof input} → String(), ${s.length} chars`);
  }

  // Strip UTF-8 BOM
  if (s.length > 0 && s.charCodeAt(0) === 0xfeff) {
    s = s.slice(1);
    console.log(`[Parser] Stripped BOM`);
  }

  // Normalise line endings → LF
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
// "123 Main St, Tampa, FL 33610"
// "801 N. Orange Ave, Suite 500, Orlando, FL 32801"
function parseAddress(raw: string | undefined): {
  address: string | null;
  city: string | null;
  state: string;
  zip: string | null;
} {
  const empty = { address: null, city: null, state: "FL", zip: null };
  if (!raw || !raw.trim()) return empty;

  const parts = raw
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);

  if (parts.length >= 3) {
    const address = cleanString(parts.slice(0, parts.length - 2).join(", "));
    const city = cleanString(parts[parts.length - 2]);
    const stateZip = parts[parts.length - 1].trim();
    const m = stateZip.match(/^([A-Z]{2})\s+(\d{5}(?:-\d{4})?)/);
    return {
      address,
      city,
      state: m ? m[1] : "FL",
      zip: m ? normalizeZip(m[2]) : null,
    };
  }
  if (parts.length === 2) {
    return { address: cleanString(parts[0]), city: cleanString(parts[1]), state: "FL", zip: null };
  }
  return { address: cleanString(raw), city: null, state: "FL", zip: null };
}

// ---- Group rows by normalised case number --------------------
function groupByCaseNumber(rows: RawRow[]): Map<string, RawRow[]> {
  const groups = new Map<string, RawRow[]>();
  let skippedNoCn = 0;
  for (const row of rows) {
    const cn = normalizeCaseNumber(row["casenumber"]);
    if (!cn) { skippedNoCn++; continue; }
    if (!groups.has(cn)) groups.set(cn, []);
    groups.get(cn)!.push(row);
  }
  if (skippedNoCn > 0) {
    console.log(`[Parser] Skipped ${skippedNoCn} rows with no casenumber`);
  }
  return groups;
}

// ---- Pick party row by PartyType priority --------------------
function pickParty(rows: RawRow[], ...types: string[]): RawRow | null {
  for (const type of types) {
    const found = rows.find(
      (r) => (r["partytype"] ?? "").toLowerCase().trim() === type.toLowerCase()
    );
    if (found) return found;
  }
  return null;
}

// ---- Main export ---------------------------------------------
export function parseCsvContent(
  csvContent: unknown,
  filename: string
): { probateLeads: ProbateLead[]; foreclosureLeads: ForeclosureLead[] } {
  console.log(`[Parser] ===== START ${filename} =====`);

  // Step 1: sanitize
  const sanitized = sanitize(csvContent);
  if (!sanitized.trim()) {
    console.error(`[Parser] ABORT ${filename}: empty content after sanitize`);
    return { probateLeads: [], foreclosureLeads: [] };
  }

  // Step 2: parse CSV
  const result = Papa.parse<RawRow>(sanitized, {
    header: true,
    skipEmptyLines: true,
    transformHeader,
    delimiter: ",",
  });

  console.log(`[Parser] Rows parsed: ${result.data.length}`);
  console.log(`[Parser] Parse errors: ${result.errors.length}`);
  if (result.errors.length > 0) {
    console.warn(`[Parser] Errors:`, JSON.stringify(result.errors.slice(0, 3)));
  }

  // Retry without skipEmptyLines if 0 rows
  if (result.data.length === 0) {
    console.warn(`[Parser] Retrying without skipEmptyLines...`);
    const r2 = Papa.parse<RawRow>(sanitized, {
      header: true,
      skipEmptyLines: false,
      transformHeader,
      delimiter: ",",
    });
    const filtered = r2.data.filter((row) =>
      Object.values(row).some((v) => v && String(v).trim() !== "")
    );
    console.log(`[Parser] Retry rows (after empty filter): ${filtered.length}`);
    result.data = filtered;
  }

  if (result.data.length === 0) {
    console.error(`[Parser] ABORT ${filename}: zero rows after all parse attempts`);
    return { probateLeads: [], foreclosureLeads: [] };
  }

  const headers = result.meta?.fields ?? Object.keys(result.data[0] ?? {});
  console.log(`[Parser] Headers: ${JSON.stringify(headers)}`);
  console.log(`[Parser] Sample row[0]: ${JSON.stringify(result.data[0]).slice(0, 300)}`);

  // Step 3: group by case number
  const groups = groupByCaseNumber(result.data);
  console.log(`[Parser] Unique cases: ${groups.size}`);

  // Step 4: build lead objects
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
    const partyTypes = caseRows.map((r) => r["partytype"]).join(",");

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
        "Subject",
        "Ward"
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
        `[Parser] Probate lead created: ${caseNumber} | "${lead.case_type}" | deceased="${lead.deceased_name}" | petitioner="${lead.petitioner}" | parties=[${partyTypes}]`
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
        `[Parser] Foreclosure lead created: ${caseNumber} | "${lead.case_type}" | plaintiff="${lead.plaintiff}" | defendant="${lead.defendant}" | parties=[${partyTypes}]`
      );
      foreclosureLeads.push(lead);
    } else {
      console.log(
        `[Parser] SKIP ${caseNumber}: "${caseType}" — not probate or foreclosure`
      );
    }
  }

  console.log(`[Parser] Final probate leads: ${probateLeads.length}`);
  console.log(`[Parser] Final foreclosure leads: ${foreclosureLeads.length}`);
  console.log(`[Parser] ===== END ${filename} =====`);

  return { probateLeads, foreclosureLeads };
}
