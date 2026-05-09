// ============================================================
// CSV Parser
// Reads a local CSV, maps columns to schema fields,
// and returns arrays of typed lead records.
// ============================================================

import * as fs from "fs";
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
 * Parse a downloaded CSV file and return categorised leads.
 * Column names are tried in order of most-to-least likely to handle
 * variations in Hillsborough County CSV exports over time.
 */
export function parseCsvFile(
  localPath: string,
  filename: string
): { probateLeads: ProbateLead[]; foreclosureLeads: ForeclosureLead[] } {
  const content = fs.readFileSync(localPath, "utf-8");

  const result = Papa.parse<RawRow>(content, {
    header: true,
    skipEmptyLines: true,
    // Normalise header names: lowercase + underscores
    transformHeader: (header: string) =>
      header.trim().toLowerCase().replace(/[\s\-\/]+/g, "_"),
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

  // Log raw headers from first file to help debug column mapping
  if (rows.length > 0) {
    console.log(`[Parser] Headers in ${filename}:`, Object.keys(rows[0]));
  }

  for (const row of rows) {
    // ---- Case type — the primary dispatch field ----
    const caseType = firstOf(
      row.case_type,
      row.casetype,
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
        row.case_number,
        row.casenumber,
        row.case_no,
        row.case_num,
        row.casenmbr,
        row.number
      )
    );
    if (!caseNumber) continue;

    // ---- Shared fields ----
    const filingDate = parseDate(
      firstOf(
        row.filing_date,
        row.filingdate,
        row.filed_date,
        row.date_filed,
        row.file_date,
        row.date,
        row.event_date
      )
    );

    const attorney = normalizeName(
      firstOf(
        row.attorney,
        row.attorney_name,
        row.atty,
        row.counsel,
        row.atty_name
      )
    );

    const address = cleanString(
      firstOf(
        row.address,
        row.street_address,
        row.property_address,
        row.addr,
        row.street
      )
    );

    const city = cleanString(firstOf(row.city, row.municipality, row.muni));

    const state = cleanString(firstOf(row.state, row.st)) ?? "FL";

    const zip = normalizeZip(
      firstOf(row.zip, row.zipcode, row.zip_code, row.postal_code, row.postal)
    );

    // ---- Route to correct table ----
    if (isProbateLead(caseType)) {
      const lead: ProbateLead = {
        case_number: caseNumber,
        filing_date: filingDate,
        deceased_name: normalizeName(
          firstOf(
            row.deceased_name,
            row.deceased,
            row.decedent,
            row.decedents_name,
            row.name,
            row.party_name,
            row.party1_name
          )
        ),
        petitioner: normalizeName(
          firstOf(
            row.petitioner,
            row.plaintiff,
            row.filer,
            row.party1,
            row.party_1,
            row.petitioner_name
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
            row.plaintiff,
            row.petitioner,
            row.filer,
            row.party1,
            row.party_1,
            row.plaintiff_name
          )
        ),
        defendant: normalizeName(
          firstOf(
            row.defendant,
            row.respondent,
            row.party2,
            row.party_2,
            row.defendant_name,
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
