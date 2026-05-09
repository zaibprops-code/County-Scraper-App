// ============================================================
// CSV Parser — built for real Hillsborough County CSV structure.
//
// REAL COLUMN LAYOUT (both Civil and Probate):
//   CaseCategory, CaseTypeDescription, CaseNumber, Title,
//   FilingDate, PartyType, FirstName, MiddleName,
//   LastName/CompanyName, [DateofDeath - probate only],
//   PartyAddress, Attorney
//
// KEY FACTS:
//   - Each case has MULTIPLE rows (one per party)
//   - PartyType values: Plaintiff, Defendant, Petitioner,
//     Decedent, Beneficiary, Trustee, Caveator, Subject
//   - No separate address columns — PartyAddress is full string
//   - Attorney is on every row (same value per case)
//   - Names are split across FirstName, MiddleName, LastName/CompanyName
//
// STRATEGY:
//   - Group all rows by CaseNumber
//   - Pick one representative row per case
//   - Extract plaintiff/defendant or decedent/petitioner by PartyType
//   - Parse address from the primary party's PartyAddress field
// ============================================================

import Papa from "papaparse";
import { isProbateLead, isForeclosureLead, normalizeCaseType } from "./filter";
import { cleanString, normalizeName, parseDate, normalizeZip, normalizeCaseNumber } from "@/utils/clean";
import type { ProbateLead, ForeclosureLead } from "@/types/leads";

// Raw row exactly as it comes out of PapaParse after header transform
type RawRow = Record<string, string>;

// ---- Header transform -----------------------------------------
// "LastName/CompanyName" → "lastname_companyname"
// "CaseTypeDescription"  → "casetypedescription"
function transformHeader(h: string): string {
  return h
    .trim()
    .toLowerCase()
    .replace(/[\s\-\/]+/g, "_");
}

// ---- Name assembly --------------------------------------------
function assembleName(row: RawRow): string | null {
  // After transform: firstname, middlename, lastname_companyname
  const first = cleanString(row["firstname"]) ?? "";
  const middle = cleanString(row["middlename"]) ?? "";
  const last = cleanString(row["lastname_companyname"]) ?? "";

  const full = [first, middle, last].filter(Boolean).join(" ").trim();
  return normalizeName(full) ?? null;
}

// ---- Address parsing ------------------------------------------
// PartyAddress format: "123 Main St, Tampa, FL 33601"
function parseAddress(raw: string | undefined): {
  address: string | null;
  city: string | null;
  state: string;
  zip: string | null;
} {
  if (!raw || !raw.trim()) {
    return { address: null, city: null, state: "FL", zip: null };
  }

  const parts = raw.split(",").map((p) => p.trim());

  if (parts.length >= 3) {
    const address = cleanString(parts[0]);
    const city = cleanString(parts[1]);
    // Last part is like "FL 33601" or "FL 33601-1234"
    const stateZipPart = parts[parts.length - 1].trim();
    const stateZipMatch = stateZipPart.match(/^([A-Z]{2})\s+(\d{5}(?:-\d{4})?)/);
    const state = stateZipMatch ? stateZipMatch[1] : "FL";
    const zip = stateZipMatch ? normalizeZip(stateZipMatch[2]) : null;
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

// ---- Pick a party row by type priority -----------------------
function pickParty(rows: RawRow[], ...types: string[]): RawRow | null {
  for (const type of types) {
    const found = rows.find(
      (r) => (r["partytype"] ?? "").toLowerCase() === type.toLowerCase()
    );
    if (found) return found;
  }
  return rows[0] ?? null;
}

// ---- Main export ----------------------------------------------
export function parseCsvContent(
  csvContent: string,
  filename: string
): { probateLeads: ProbateLead[]; foreclosureLeads: ForeclosureLead[] } {
  const result = Papa.parse<RawRow>(csvContent, {
    header: true,
    skipEmptyLines: true,
    transformHeader,
  });

  if (result.errors.length > 0) {
    console.warn(
      `[Parser] ${result.errors.length} warning(s) in ${filename}:`,
      result.errors.slice(0, 3)
    );
  }

  const rows: RawRow[] = result.data;

  if (rows.length === 0) {
    console.warn(`[Parser] No rows in ${filename}`);
    return { probateLeads: [], foreclosureLeads: [] };
  }

  console.log(`[Parser] ${filename}: ${rows.length} raw rows, headers:`, Object.keys(rows[0]));

  const groups = groupByCaseNumber(rows);
  console.log(`[Parser] ${filename}: ${groups.size} unique case numbers`);

  const probateLeads: ProbateLead[] = [];
  const foreclosureLeads: ForeclosureLead[] = [];

  for (const [caseNumber, caseRows] of groups) {
    // All rows for a case share the same CaseTypeDescription and FilingDate
    const anchor = caseRows[0];
    const caseType = cleanString(anchor["casetypedescription"]);
    if (!caseType) continue;

    const filingDate = parseDate(anchor["filingdate"]);

    // Attorney: use first non-"No Attorney" value found
    const attorneyRaw = caseRows
      .map((r) => cleanString(r["attorney"]))
      .find((a) => a && a.toLowerCase() !== "no attorney") ?? null;
    const attorney = normalizeName(attorneyRaw);

    if (isProbateLead(caseType)) {
      // Pick decedent for deceased_name
      const decedentRow = pickParty(caseRows, "Decedent");
      const petitionerRow = pickParty(caseRows, "Petitioner", "Trustee", "Subject");
      const addressRow = petitionerRow ?? decedentRow ?? anchor;

      const { address, city, state, zip } = parseAddress(
        addressRow["partyaddress"]
      );

      const lead: ProbateLead = {
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
      };
      probateLeads.push(lead);
    } else if (isForeclosureLead(caseType)) {
      const plaintiffRow = pickParty(caseRows, "Plaintiff", "Petitioner");
      const defendantRow = pickParty(caseRows, "Defendant", "Respondent");
      // Use defendant's address as the property address (they own the property)
      const addressRow = defendantRow ?? plaintiffRow ?? anchor;

      const { address, city, state, zip } = parseAddress(
        addressRow["partyaddress"]
      );

      const lead: ForeclosureLead = {
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
      };
      foreclosureLeads.push(lead);
    }
  }

  console.log(
    `[Parser] ${filename} → ${probateLeads.length} probate leads, ${foreclosureLeads.length} foreclosure leads`
  );

  return { probateLeads, foreclosureLeads };
}
