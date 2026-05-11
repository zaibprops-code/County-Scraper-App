// ============================================================
// Property Matcher — Hillsborough County Property Appraiser
//
// Searches https://gis.hcpafl.org for property ownership
// by deceased last name and stores the matched site address.
//
// API STRATEGY:
//   Primary:  HPAServices WCF REST endpoint (JSON)
//   Fallback: ArcGIS FeatureServer query (JSON)
//
// Called server-side from /api/match-properties (no CORS issue).
//
// RATE LIMITING: 300ms delay between requests to avoid hammering
// the county server. Processes leads sequentially, not in parallel.
// ============================================================

import axios from "axios";
import type { HcpaProperty } from "@/types/leads";

const HCPA_OWNER_SEARCH =
  "https://gis.hcpafl.org/HPAServices/PropertySearch.svc/GetOwnerNameResults";

// ArcGIS layer — fallback if WCF endpoint fails or returns bad data
const ARCGIS_QUERY =
  "https://gis.hcpafl.org/arcgis/rest/services/Layers/MapServer/0/query";

const REQUEST_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36",
  Accept: "application/json, text/plain, */*",
  "Accept-Language": "en-US,en;q=0.9",
  Referer: "https://gis.hcpafl.org/propertysearch/",
};

const DELAY_MS = 350; // ms between API calls
const TIMEOUT_MS = 10000;

// ---- Delay helper ---------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---- Last name extraction ------------------------------------

/**
 * Extract the last name from a full name string.
 * Handles formats:
 *   "LAST, FIRST MIDDLE"  → "LAST"
 *   "First Middle Last"   → "Last"
 *   "SMITH"               → "SMITH"
 */
export function extractLastName(fullName: string | null | undefined): string | null {
  if (!fullName || !fullName.trim()) return null;
  const s = fullName.trim();

  // Format: "LAST, FIRST" — comma-separated
  if (s.includes(",")) {
    const last = s.split(",")[0].trim();
    return last.length > 0 ? last.toUpperCase() : null;
  }

  // Format: "First Middle Last" — take the last word
  const words = s.split(/\s+/).filter(Boolean);
  const last = words[words.length - 1];
  return last && last.length > 1 ? last.toUpperCase() : null;
}

// ---- Property result scoring ---------------------------------

/**
 * Score a property result against the deceased's last name.
 * Higher score = better match.
 */
function scoreProperty(prop: HcpaProperty, lastName: string): number {
  const ownerUpper = prop.ownerName.toUpperCase();
  const lastUpper = lastName.toUpperCase();
  let score = 0;

  // Exact last name appears in owner name
  if (ownerUpper.includes(lastUpper)) score += 10;

  // Owner name starts with last name (LAST, FIRST format)
  if (ownerUpper.startsWith(lastUpper + ",") || ownerUpper.startsWith(lastUpper + " ")) {
    score += 5;
  }

  // Has a real site address (not a PO Box)
  if (
    prop.siteAddress &&
    !prop.siteAddress.toUpperCase().includes("PO BOX") &&
    !prop.siteAddress.toUpperCase().includes("P.O.")
  ) {
    score += 3;
  }

  // Florida property preferred
  if (prop.siteState === "FL" || prop.siteState === "Florida") score += 2;

  // Has zip code
  if (prop.siteZip && /^\d{5}/.test(prop.siteZip)) score += 1;

  return score;
}

// ---- HPAServices endpoint (primary) --------------------------

async function searchHpaServices(lastName: string): Promise<HcpaProperty[]> {
  console.log(`[PropertyMatcher] HPAServices search: "${lastName}"`);

  try {
    const resp = await axios.get(HCPA_OWNER_SEARCH, {
      params: { ownerName: lastName },
      timeout: TIMEOUT_MS,
      headers: REQUEST_HEADERS,
      validateStatus: (s) => s < 500,
    });

    console.log(`[PropertyMatcher] HPAServices HTTP ${resp.status} for "${lastName}"`);

    if (resp.status !== 200) return [];

    const raw = resp.data;
    console.log(`[PropertyMatcher] HPAServices raw type: ${typeof raw}`);

    // Parse response — may be JSON array or JSON string
    let items: Record<string, unknown>[] = [];

    if (Array.isArray(raw)) {
      items = raw as Record<string, unknown>[];
    } else if (typeof raw === "string") {
      try {
        const parsed = JSON.parse(raw);
        items = Array.isArray(parsed) ? parsed : [];
      } catch {
        console.log(`[PropertyMatcher] HPAServices: could not parse response as JSON`);
        return [];
      }
    } else if (raw && typeof raw === "object") {
      // Might be { d: [...] } pattern (WCF JSON)
      const obj = raw as Record<string, unknown>;
      const inner = obj["d"] ?? obj["results"] ?? obj["value"];
      items = Array.isArray(inner) ? (inner as Record<string, unknown>[]) : [];
    }

    console.log(`[PropertyMatcher] HPAServices: ${items.length} result(s) for "${lastName}"`);

    return items.map((item) => ({
      ownerName: String(
        item["Name"] ?? item["OwnerName"] ?? item["OWN1"] ?? item["name"] ?? ""
      ).trim(),
      siteAddress: String(
        item["Address"] ?? item["SiteAddress"] ?? item["SITE_ADDR"] ?? item["address"] ?? ""
      ).trim(),
      siteCity: String(
        item["City"] ?? item["SiteCity"] ?? item["CITY"] ?? item["city"] ?? ""
      ).trim(),
      siteState: String(
        item["State"] ?? item["SiteState"] ?? item["STATE"] ?? "FL"
      ).trim(),
      siteZip: String(
        item["ZipCode"] ?? item["SiteZip"] ?? item["ZIP"] ?? item["zip"] ?? ""
      ).trim(),
    })).filter((p) => p.ownerName.length > 0 || p.siteAddress.length > 0);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[PropertyMatcher] HPAServices error for "${lastName}": ${msg}`);
    return [];
  }
}

// ---- ArcGIS REST fallback ------------------------------------

async function searchArcGIS(lastName: string): Promise<HcpaProperty[]> {
  console.log(`[PropertyMatcher] ArcGIS fallback search: "${lastName}"`);

  try {
    const where = `UPPER(OWN1) LIKE '%${lastName.toUpperCase().replace(/'/g, "''")}%'`;

    const resp = await axios.get(ARCGIS_QUERY, {
      params: {
        where,
        outFields: "OWN1,PHYADDR,PHYDIRPFX,PHYNAME,PHYSUF,PHYUNIT,PHYCITY,PHYZIP",
        returnGeometry: false,
        resultRecordCount: 20,
        f: "json",
      },
      timeout: TIMEOUT_MS,
      headers: REQUEST_HEADERS,
      validateStatus: (s) => s < 500,
    });

    console.log(`[PropertyMatcher] ArcGIS HTTP ${resp.status} for "${lastName}"`);

    if (resp.status !== 200) return [];

    const data = resp.data as {
      features?: Array<{ attributes: Record<string, unknown> }>;
    };

    const features = data?.features ?? [];
    console.log(`[PropertyMatcher] ArcGIS: ${features.length} feature(s) for "${lastName}"`);

    return features.map((f) => {
      const a = f.attributes ?? {};
      // Build street address from components
      const parts = [
        String(a["PHYADDR"] ?? ""),
        String(a["PHYDIRPFX"] ?? ""),
        String(a["PHYNAME"] ?? ""),
        String(a["PHYSUF"] ?? ""),
        String(a["PHYUNIT"] ?? ""),
      ].map((s) => s.trim()).filter(Boolean);

      return {
        ownerName: String(a["OWN1"] ?? "").trim(),
        siteAddress: parts.join(" ").trim(),
        siteCity: String(a["PHYCITY"] ?? "").trim(),
        siteState: "FL",
        siteZip: String(a["PHYZIP"] ?? "").trim(),
      };
    }).filter((p) => p.ownerName.length > 0);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[PropertyMatcher] ArcGIS error for "${lastName}": ${msg}`);
    return [];
  }
}

// ---- Main: find best matching property -----------------------

export interface MatchedProperty {
  address: string;
  city: string;
  state: string;
  zip: string;
}

/**
 * Search HCPA for a property owned by the given deceased name.
 * Returns the best matching property address, or null if not found.
 */
export async function findPropertyForDecedent(
  deceasedName: string | null | undefined,
  leadId: number
): Promise<MatchedProperty | null> {
  const lastName = extractLastName(deceasedName);

  if (!lastName || lastName.length < 2) {
    console.log(`[PropertyMatcher] Lead ${leadId}: no usable last name from "${deceasedName}"`);
    return null;
  }

  console.log(`[PropertyMatcher] Lead ${leadId}: searching for "${lastName}" (from "${deceasedName}")`);

  // Try primary endpoint first
  let results = await searchHpaServices(lastName);

  // Fallback to ArcGIS if primary returns nothing
  if (results.length === 0) {
    console.log(`[PropertyMatcher] Lead ${leadId}: HPAServices empty → trying ArcGIS`);
    results = await searchArcGIS(lastName);
  }

  if (results.length === 0) {
    console.log(`[PropertyMatcher] Lead ${leadId}: no results for "${lastName}"`);
    return null;
  }

  // Score all results and pick the best
  const scored = results
    .map((prop) => ({ prop, score: scoreProperty(prop, lastName) }))
    .filter(({ prop }) => prop.siteAddress.length > 0)
    .sort((a, b) => b.score - a.score);

  if (scored.length === 0) {
    console.log(`[PropertyMatcher] Lead ${leadId}: results found but none had a site address`);
    return null;
  }

  const best = scored[0].prop;
  console.log(
    `[PropertyMatcher] Lead ${leadId}: matched "${best.ownerName}" → "${best.siteAddress}, ${best.siteCity}, ${best.siteState} ${best.siteZip}" (score=${scored[0].score})`
  );

  return {
    address: best.siteAddress,
    city: best.siteCity,
    state: best.siteState || "FL",
    zip: best.siteZip,
  };
}

export { sleep, DELAY_MS };
