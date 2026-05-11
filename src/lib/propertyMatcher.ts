// ============================================================
// Property Matcher — Hillsborough County Property Appraiser
//
// HCPA owner search uses "LASTNAME, FIRSTNAME" format.
// Example: "BREESE, EVA" matches "EVA R BREESE REVOCABLE TRUST"
//
// API endpoints tried in order:
//   1. HPAServices WCF REST (JSON)
//   2. ArcGIS FeatureServer query (JSON fallback)
//
// Called server-side from /api/match-properties — no CORS issue.
// ============================================================

import axios from "axios";
import type { HcpaProperty } from "@/types/leads";

const HCPA_OWNER_SEARCH =
  "https://gis.hcpafl.org/HPAServices/PropertySearch.svc/GetOwnerNameResults";

const ARCGIS_QUERY =
  "https://gis.hcpafl.org/arcgis/rest/services/Layers/MapServer/0/query";

const REQUEST_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36",
  Accept: "application/json, text/plain, */*",
  "Accept-Language": "en-US,en;q=0.9",
  Referer: "https://gis.hcpafl.org/propertysearch/",
};

const DELAY_MS = 350;
const TIMEOUT_MS = 10000;

export { DELAY_MS };

// ---- Delay ---------------------------------------------------

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---- Name parsing -------------------------------------------

export interface ParsedName {
  last: string;
  first: string;
  middle: string;
  raw: string;
}

/**
 * Parse a full name into components.
 * Handles:
 *   "Eva Rose Breese"        → last=BREESE  first=EVA   middle=ROSE
 *   "MOORE, MICHAEL JEROME"  → last=MOORE   first=MICHAEL middle=JEROME
 *   "sykes-Joseph, Patty"    → last=SYKES-JOSEPH first=PATTY
 *   "Robert E Smith"         → last=SMITH   first=ROBERT  middle=E
 */
export function parseName(fullName: string | null | undefined): ParsedName | null {
  if (!fullName || !fullName.trim()) return null;
  const s = fullName.trim();

  // Format: "LAST, FIRST MIDDLE"
  if (s.includes(",")) {
    const commaIdx = s.indexOf(",");
    const last = s.slice(0, commaIdx).trim().toUpperCase();
    const rest = s.slice(commaIdx + 1).trim().split(/\s+/).filter(Boolean);
    const first = (rest[0] ?? "").toUpperCase();
    const middle = rest.slice(1).join(" ").toUpperCase();
    return { last, first, middle, raw: s };
  }

  // Format: "First [Middle...] Last"
  const words = s.split(/\s+/).filter(Boolean).map((w) => w.toUpperCase());
  if (words.length === 0) return null;
  if (words.length === 1) return { last: words[0], first: "", middle: "", raw: s };
  if (words.length === 2) return { last: words[1], first: words[0], middle: "", raw: s };
  // 3+ words: first = words[0], middle = words[1..-2], last = words[-1]
  return {
    last: words[words.length - 1],
    first: words[0],
    middle: words.slice(1, -1).join(" "),
    raw: s,
  };
}

/**
 * Build HCPA owner search string in "LASTNAME, FIRSTNAME" format.
 * Falls back to "LASTNAME" only if no first name available.
 */
export function buildOwnerSearchString(parsed: ParsedName): string {
  if (parsed.first) {
    return `${parsed.last}, ${parsed.first}`;
  }
  return parsed.last;
}

// ---- Scoring ------------------------------------------------

interface ScoredProperty {
  prop: HcpaProperty;
  score: number;
  reasons: string[];
}

/**
 * Score a property result against parsed name.
 * Returns score=-999 if last name is completely absent (hard reject).
 */
function scoreProperty(prop: HcpaProperty, parsed: ParsedName, leadId: number): ScoredProperty {
  const owner = prop.ownerName.toUpperCase().trim();
  const { last, first, middle } = parsed;
  let score = 0;
  const reasons: string[] = [];

  // ---- Hard requirement: last name must appear ----
  if (!owner.includes(last)) {
    const reason = `REJECT — last name "${last}" not in "${owner}"`;
    console.log(`[PropertyMatcher] Lead ${leadId} score: ${reason}`);
    return { prop, score: -999, reasons: [reason] };
  }
  score += 20;
  reasons.push(`+20 last "${last}" found`);

  // Last name at very start (LAST, FIRST format)
  if (owner.startsWith(last + ",") || owner.startsWith(last + " ")) {
    score += 5;
    reasons.push("+5 last at start");
  }

  // ---- First name matching (flexible) ----
  if (first) {
    const firstInitial = first.charAt(0);

    if (owner.includes(first)) {
      // Exact first name present
      score += 10;
      reasons.push(`+10 exact first "${first}"`);
    } else if (
      // Initial matches: look for " E " or " E\b" anywhere in owner string
      new RegExp(`(?:^|[\\s,])${firstInitial}(?:\\s|$|\\.|,)`).test(owner)
    ) {
      score += 5;
      reasons.push(`+5 first initial "${firstInitial}"`);
    } else if (owner.includes(` ${firstInitial}`) || owner.startsWith(firstInitial)) {
      score += 3;
      reasons.push(`+3 first initial weak "${firstInitial}"`);
    } else {
      reasons.push(`+0 no first name match (first="${first}", owner="${owner}")`);
    }
  }

  // ---- Middle name/initial matching ----
  if (middle) {
    const midInitial = middle.charAt(0);
    if (owner.includes(middle)) {
      score += 3;
      reasons.push(`+3 middle "${middle}"`);
    } else if (new RegExp(`(?:^|\\s)${midInitial}(?:\\s|$|\\.)`).test(owner)) {
      score += 1;
      reasons.push(`+1 middle initial "${midInitial}"`);
    }
  }

  // ---- Trust / estate modifiers (common in probate) ----
  if (owner.includes("REVOCABLE TRUST") || owner.includes("REV TRUST")) {
    score += 3;
    reasons.push("+3 revocable trust");
  } else if (owner.includes("TRUST")) {
    score += 2;
    reasons.push("+2 trust");
  }
  if (owner.includes("ESTATE")) {
    score += 2;
    reasons.push("+2 estate");
  }
  if (owner.includes("LIVING TRUST")) {
    score += 1;
    reasons.push("+1 living trust");
  }

  // ---- Address quality ----
  const addr = prop.siteAddress.toUpperCase();
  if (addr && !addr.includes("PO BOX") && !addr.includes("P.O.")) {
    score += 3;
    reasons.push("+3 non-PO-box address");
  } else if (!addr) {
    score -= 5;
    reasons.push("-5 no site address");
  }

  // Florida preferred
  if (prop.siteState === "FL" || prop.siteState === "Florida") {
    score += 2;
    reasons.push("+2 Florida");
  }

  // Valid ZIP
  if (prop.siteZip && /^\d{5}/.test(prop.siteZip)) {
    score += 1;
    reasons.push("+1 valid ZIP");
  }

  return { prop, score, reasons };
}

// ---- HPAServices (primary) ----------------------------------

async function searchHpaServices(
  searchStr: string,
  leadId: number
): Promise<HcpaProperty[]> {
  const url = `${HCPA_OWNER_SEARCH}?ownerName=${encodeURIComponent(searchStr)}`;
  console.log(`[PropertyMatcher] Lead ${leadId} HPAServices URL: ${url}`);

  try {
    const resp = await axios.get(HCPA_OWNER_SEARCH, {
      params: { ownerName: searchStr },
      timeout: TIMEOUT_MS,
      headers: REQUEST_HEADERS,
      validateStatus: (s) => s < 500,
    });

    console.log(`[PropertyMatcher] Lead ${leadId} HPAServices HTTP ${resp.status}`);
    console.log(`[PropertyMatcher] Lead ${leadId} HPAServices response type: ${typeof resp.data}`);

    if (resp.status !== 200) return [];

    const raw = resp.data;
    let items: Record<string, unknown>[] = [];

    if (Array.isArray(raw)) {
      items = raw as Record<string, unknown>[];
    } else if (typeof raw === "string" && raw.trim().startsWith("[")) {
      try { items = JSON.parse(raw); } catch { items = []; }
    } else if (typeof raw === "string" && raw.trim().startsWith("{")) {
      try {
        const obj = JSON.parse(raw) as Record<string, unknown>;
        const inner = obj["d"] ?? obj["results"] ?? obj["value"];
        items = Array.isArray(inner) ? (inner as Record<string, unknown>[]) : [];
      } catch { items = []; }
    } else if (raw && typeof raw === "object") {
      const obj = raw as Record<string, unknown>;
      const inner = obj["d"] ?? obj["results"] ?? obj["value"];
      items = Array.isArray(inner) ? (inner as Record<string, unknown>[]) : [];
    }

    console.log(`[PropertyMatcher] Lead ${leadId} HPAServices: ${items.length} item(s) returned`);

    const props = items.map((item) => ({
      ownerName: String(item["Name"] ?? item["OwnerName"] ?? item["OWN1"] ?? item["name"] ?? "").trim(),
      siteAddress: String(item["Address"] ?? item["SiteAddress"] ?? item["SITE_ADDR"] ?? item["address"] ?? "").trim(),
      siteCity: String(item["City"] ?? item["SiteCity"] ?? item["CITY"] ?? item["city"] ?? "").trim(),
      siteState: String(item["State"] ?? item["SiteState"] ?? item["STATE"] ?? "FL").trim(),
      siteZip: String(item["ZipCode"] ?? item["SiteZip"] ?? item["ZIP"] ?? item["zip"] ?? "").trim(),
    })).filter((p) => p.ownerName.length > 0);

    if (props.length > 0) {
      console.log(`[PropertyMatcher] Lead ${leadId} HPAServices owner names returned:`);
      props.forEach((p, i) =>
        console.log(`  [${i}] "${p.ownerName}" | addr="${p.siteAddress}" | city="${p.siteCity}" | zip="${p.siteZip}"`)
      );
    }

    return props;
  } catch (err) {
    console.error(`[PropertyMatcher] Lead ${leadId} HPAServices error: ${err instanceof Error ? err.message : err}`);
    return [];
  }
}

// ---- ArcGIS fallback ----------------------------------------

async function searchArcGIS(
  searchStr: string,
  lastName: string,
  leadId: number
): Promise<HcpaProperty[]> {
  console.log(`[PropertyMatcher] Lead ${leadId} ArcGIS fallback: searchStr="${searchStr}" lastName="${lastName}"`);

  try {
    // Search by last name only in ArcGIS (it doesn't support LAST, FIRST format)
    const safeLast = lastName.replace(/'/g, "''");
    const where = `UPPER(OWN1) LIKE '%${safeLast}%'`;

    console.log(`[PropertyMatcher] Lead ${leadId} ArcGIS where: ${where}`);

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

    console.log(`[PropertyMatcher] Lead ${leadId} ArcGIS HTTP ${resp.status}`);

    if (resp.status !== 200) return [];

    const data = resp.data as { features?: Array<{ attributes: Record<string, unknown> }> };
    const features = data?.features ?? [];
    console.log(`[PropertyMatcher] Lead ${leadId} ArcGIS: ${features.length} feature(s)`);

    const props = features.map((f) => {
      const a = f.attributes ?? {};
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

    if (props.length > 0) {
      console.log(`[PropertyMatcher] Lead ${leadId} ArcGIS owner names:`);
      props.forEach((p, i) =>
        console.log(`  [${i}] "${p.ownerName}" | addr="${p.siteAddress}"`)
      );
    }

    return props;
  } catch (err) {
    console.error(`[PropertyMatcher] Lead ${leadId} ArcGIS error: ${err instanceof Error ? err.message : err}`);
    return [];
  }
}

// ---- Main export --------------------------------------------

export interface MatchedProperty {
  address: string;
  city: string;
  state: string;
  zip: string;
}

/**
 * Find the best HCPA property match for a deceased person.
 * Returns matched address or null.
 */
export async function findPropertyForDecedent(
  deceasedName: string | null | undefined,
  leadId: number
): Promise<MatchedProperty | null> {
  console.log(`[PropertyMatcher] ===== Lead ${leadId} START =====`);
  console.log(`[PropertyMatcher] Lead ${leadId} raw deceased_name: "${deceasedName}"`);

  const parsed = parseName(deceasedName);

  if (!parsed || !parsed.last || parsed.last.length < 2) {
    console.log(`[PropertyMatcher] Lead ${leadId} SKIP: could not extract usable last name`);
    return null;
  }

  const searchStr = buildOwnerSearchString(parsed);

  console.log(`[PropertyMatcher] Lead ${leadId} parsed: last="${parsed.last}" first="${parsed.first}" middle="${parsed.middle}"`);
  console.log(`[PropertyMatcher] Lead ${leadId} HCPA search string: "${searchStr}"`);

  // Try primary (HPAServices) with "LAST, FIRST" format
  let results = await searchHpaServices(searchStr, leadId);

  // If no results with full "LAST, FIRST", try last name only
  if (results.length === 0 && parsed.first) {
    console.log(`[PropertyMatcher] Lead ${leadId} retrying with last name only: "${parsed.last}"`);
    results = await searchHpaServices(parsed.last, leadId);
  }

  // Fallback to ArcGIS
  if (results.length === 0) {
    console.log(`[PropertyMatcher] Lead ${leadId} HPAServices empty → ArcGIS fallback`);
    results = await searchArcGIS(searchStr, parsed.last, leadId);
  }

  if (results.length === 0) {
    console.log(`[PropertyMatcher] Lead ${leadId} NO RESULTS from any source for "${searchStr}"`);
    return null;
  }

  console.log(`[PropertyMatcher] Lead ${leadId} scoring ${results.length} candidate(s):`);

  // Score all candidates
  const scored: ScoredProperty[] = results.map((prop) => {
    const s = scoreProperty(prop, parsed, leadId);
    console.log(
      `[PropertyMatcher] Lead ${leadId}   "${prop.ownerName}" → score=${s.score} | ${s.reasons.join(" | ")}`
    );
    return s;
  });

  // Filter out hard rejects and sort
  const valid = scored
    .filter((s) => s.score > 0 && s.prop.siteAddress.length > 0)
    .sort((a, b) => b.score - a.score);

  if (valid.length === 0) {
    console.log(`[PropertyMatcher] Lead ${leadId} ALL CANDIDATES REJECTED (score ≤ 0 or no address)`);
    return null;
  }

  const best = valid[0];
  console.log(
    `[PropertyMatcher] Lead ${leadId} TOP MATCH: "${best.prop.ownerName}" score=${best.score} → "${best.prop.siteAddress}, ${best.prop.siteCity} ${best.prop.siteZip}"`
  );
  console.log(`[PropertyMatcher] ===== Lead ${leadId} END =====`);

  return {
    address: best.prop.siteAddress,
    city: best.prop.siteCity,
    state: best.prop.siteState || "FL",
    zip: best.prop.siteZip,
  };
}
