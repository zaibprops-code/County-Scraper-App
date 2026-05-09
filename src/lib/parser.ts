// ============================================================
// CSV Parser — in-memory only, no filesystem reads.
// Column mapping based on real Hillsborough County CSV exports:
//
// Civil CSV headers (after transformHeader → snake_case):
//   casetypedescription, casenumber, filingdate, partyname,
//   plaintiffname, defendantname, attorneyname, address, city,
//   state, zipcode
//
// Probate CSV headers (after transformHeader → snake_case):
//   casetypedescription, casenumber, filingdate, deceasedname,
//   petitionername, attorneyname, address, city, state, zipcode
// ============================================================

import Papa from "papaparse";
import { isProbateLead, isForeclosureLead, normalizeCaseType } from "./filter";
import {
  cleanString,
  normalizeName,
  parseDate,
  normalizeZip,
  normalizeCaseNumber,
  firstOf,
} from "@/utils/clean";
import type { ProbateLead, ForeclosureLead } from "@/types/leads";

type RawRow = Record<string, string>;

/**
 * transformHeader converts raw CSV headers to lowercase+underscores.
 * "CaseTypeDescription" → "casetypedescription"
 * "Filing Date"         → "filing_date"
 * We try both variants in firstOf() calls below.
 */
function transformHeader(header: string): string {
  return header.trim().toLowerCase().replace(/[\s\-\/]+/g, "_");
}

/**
 * Parse raw CSV text and return categorised investor-relevant leads.
 */
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
      `[Parser] ${result.errors.length} parse warning(s) in ${filename}:`,
      result.errors.slice(0, 3)
    );
  }

  const rows: RawRow[] = result.data;
  const probateLeads: ProbateLead[] = [];
  const foreclosureLeads: ForeclosureLead[] = [];

  if (rows.length > 0) {
    console.log(
      `[Parser] Headers detected in ${filename}:`,
      Object.keys(rows[0])
    );
  } else {
    console.warn(`[Parser] No rows found in ${filename}`);
  }

  for (const row of rows) {
    // ---- Case type ----
    // Real Hillsborough Civil:  "CaseTypeDescription" → "casetypedescription"
    // Real Hillsborough Probate: same column name pattern
    const caseType = firstOf(
      row.casetypedescription,   // CaseTypeDescription (real column)
      row.case_type_description, // Case_Type_Description variant
      row.case_type,             // case_type
      row.casetype,              // casetype
      row.type,
      row.description,
      row.case_description,
      row.filing_type,
      row.event_type,
      row.category
    );

    if (!caseType) continue;

    // ---- Case number ----
    const caseNumber = normalizeCaseNumber(
      firstOf(
        row.casenumber,          // CaseNumber (real column)
        row.case_number,
        row.case_no,
        row.case_num,
        row.casenmbr,
        row.number
      )
    );
    if (!caseNumber) continue;

    // ---- Filing date ----
    const filingDate = parseDate(
      firstOf(
        row.filingdate,          // FilingDate (real column)
        row.filing_date,
        row.filed_date,
        row.date_filed,
        row.file_date,
        row.date,
        row.event_date
      )
    );

    // ---- Attorney ----
    const attorney = normalizeName(
      firstOf(
        row.attorneyname,        // AttorneyName (real column)
        row.attorney_name,
        row.attorney,
        row.atty,
        row.counsel
      )
    );

    // ---- Address fields ----
    const address = cleanString(
      firstOf(
        row.address,
        row.streetaddress,
        row.street_address,
        row.property_address,
        row.addr,
        row.street
      )
    );

    const city = cleanString(
      firstOf(row.city, row.municipality, row.muni)
    );

    const state = cleanString(firstOf(row.state, row.st)) ?? "FL";

    const zip = normalizeZip(
      firstOf(
        row.zipcode,             // ZipCode (real column)
        row.zip_code,
        row.zip,
        row.postal_code,
        row.postal
      )
    );

    // ---- Route to correct table ----
    if (isProbateLead(caseType)) {
      const lead: ProbateLead = {
        case_number: caseNumber,
        filing_date: filingDate,
        deceased_name: normalizeName(
          firstOf(
            row.deceasedname,        // DeceasedName (real probate column)
            row.deceased_name,
            row.deceased,
            row.decedent,
            row.decedents_name,
            row.name,
            row.partyname,           // PartyName fallback
            row.party_name,
            row.party1_name
          )
        ),
        petitioner: normalizeName(
          firstOf(
            row.petitionername,      // PetitionerName (real probate column)
            row.petitioner_name,
            row.petitioner,
            row.plaintiffname,       // PlaintiffName fallback
            row.plaintiff_name,
            row.plaintiff,
            row.filer,
            row.party1,
            row.party_1
          )
        ),
        attorney,
        address,
        city,
        state,
        zip,
        county: "Hillsborough",
        case_type: normalizeCaseType(caseType),
        source_file: filename,
        raw_data: row as Record<string, unknown>,
      };
      probateLeads.push(lead);
    } else if (isForeclosureLead(caseType)) {
      const lead: ForeclosureLead = {
        case_number: caseNumber,
        filing_date: filingDate,
        plaintiff: normalizeName(
          firstOf(
            row.plaintiffname,       // PlaintiffName (real civil column)
            row.plaintiff_name,
            row.plaintiff,
            row.petitionername,
            row.petitioner_name,
            row.petitioner,
            row.filer,
            row.party1,
            row.party_1
          )
        ),
        defendant: normalizeName(
          firstOf(
            row.defendantname,       // DefendantName (real civil column)
            row.defendant_name,
            row.defendant,
            row.respondent,
            row.party2,
            row.party_2,
            row.partyname,
            row.party_name
          )
        ),
        attorney,
        address,
        city,
        state,
        zip,
        county: "Hillsborough",
        case_type: normalizeCaseType(caseType),
        source_file: filename,
        raw_data: row as Record<string, unknown>,
      };
      foreclosureLeads.push(lead);
    }
  }

  console.log(
    `[Parser] ${filename} → ${probateLeads.length} probate, ${foreclosureLeads.length} foreclosure leads`
  );

  return { probateLeads, foreclosureLeads };
}
