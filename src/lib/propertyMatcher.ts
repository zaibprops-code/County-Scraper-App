// ============================================================
// Property Matcher — Hillsborough County Property Appraiser
//
// Uses ArcGIS REST API only (HPAServices endpoint was 404).
//
// PRIMARY layer:
//   https://gis.hcpafl.org/arcgis/rest/services/Layers/MapServer/0/query
// FALLBACK layer (if primary returns no features):
//   https://gis.hcpafl.org/arcgis/rest/services/Layers/MapServer/1/query
//
// Owner name field:  OWN1 (primary), OWN2 (secondary owner)
// Physical address:  PHYADDR + PHYDIRPFX + PHYNAME + PHYSUF + PHYUNIT
// City/zip:          PHYCITY, PHYZIP
//
// Search strategy:
//   1. UPPER(OWN1) LIKE '%LASTNAME%'  — catches all name formats
//   2. If 0 results: UPPER(OWN2) LIKE '%LASTNAME%'
//   Score results and pick best match.
// ============================================================

import axios, { AxiosError } from "axios";
import type { HcpaProperty } from "@/types/leads";

// ArcGIS REST endpoints — both are public, no auth required
const ARCGIS_PRIMARY   = "https://gis.hcpafl.org/arcgis/rest/services/Layers/MapServer/0/query";
const ARCGIS_FALLBACK  = "https://gis.hcpafl.org/arcgis/rest/services/Layers/MapServer/1/query";

const ARCGIS_OUT_FIELDS = "OWN1,OWN2,PHYADDR,PHYDIRPFX,PHYNAME,PHYSUF,PHYUNIT,PHYCITY,PHYZIP";
const MAX_RECORDS = 10;  // enough to find the right owner, keeps response fast

const BROWSER_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  Accept: "application/json, text/plain, */*",
  "Accept-Language": "en-US,en;q=0.9",
  Referer: "https://gis.hcpafl.org/propertysearch/",
};

export const DELAY_MS = 400;   // ms between leads — avoids hammering GIS server
const TIMEOUT_MS     = 12000;
const RETRY_COUNT    = 2;
const RETRY_DELAY_MS = 1200;
const MIN_ACCEPT_SCORE = 1;    // low threshold — any last-name match with real address

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ---- Name parsing -------------------------------------------

export interface ParsedName {
  last: string;
  first: string;
  middle: string;
  raw: string;
}

/**
 * Parse full name into components.
 * "Eva Rose Breese"       → last=BREESE  first=EVA   middle=ROSE
 * "MOORE, MICHAEL JEROME" → last=MOORE   first=MICHAEL middle=JEROME
 * "Robert E Smith"        → last=SMITH   first=ROBERT  middle=E
 */
export function parseName(fullName: string | null | undefined): ParsedName | null {
  if (!fullName || !fullName.trim()) return null;
  const s = fullName.trim();

  if (s.includes(",")) {
    const ci = s.indexOf(",");
    const last = s.slice(0, ci).trim().toUpperCase();
    const rest = s.slice(ci + 1).trim().split(/\s+/).filter(Boolean);
    return {
      last,
      first: (rest[0] ?? "").toUpperCase(),
      middle: rest.slice(1).join(" ").toUpperCase(),
      raw: s,
    };
  }

  const words = s.split(/\s+/).filter(Boolean).map((w) => w.toUpperCase());
  if (words.length === 0) return null;
  if (words.length === 1) return { last: words[0], first: "", middle: "", raw: s };
  if (words.length === 2) return { last: words[1], first: words[0], middle: "", raw: s };
  return {
    last: words[words.length - 1],
    first: words[0],
    middle: words.slice(1, -1).join(" "),
    raw: s,
  };
}

// ---- ArcGIS query ------------------------------------------

interface ArcGISFeature {
  attributes: Record<string, unknown>;
}

interface ArcGISResponse {
  features?: ArcGISFeature[];
  error?: { code: number; message: string };
}

/**
 * Query one ArcGIS layer endpoint.
 * Returns raw feature array or null on network failure.
 */
async function queryArcGISLayer(
  endpoint: string,
  whereClause: string,
  leadId: number,
  attemptLabel: string
): Promise<ArcGISFeature[] | null> {
  const params = {
    where: whereClause,
    outFields: ARCGIS_OUT_FIELDS,
    returnGeometry: "false",
    resultRecordCount: String(MAX_RECORDS),
    f: "json",
  };

  // Build full URL for logging
  const qs = Object.entries(params)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join("&");
  const fullUrl = `${endpoint}?${qs}`;

  console.log(`[PM:L${leadId}] ${attemptLabel} URL: ${fullUrl}`);

  for (let attempt = 1; attempt <= RETRY_COUNT; attempt++) {
    try {
      const resp = await axios.get<ArcGISResponse>(endpoint, {
        params,
        timeout: TIMEOUT_MS,
        headers: BROWSER_HEADERS,
        validateStatus: () => true,
      });

      console.log(`[PM:L${leadId}] ${attemptLabel} attempt=${attempt} HTTP=${resp.status} Content-Type=${resp.headers?.["content-type"] ?? "unknown"}`);

      // Log raw response prefix for debugging
      const rawStr = typeof resp.data === "string"
        ? (resp.data as string).slice(0, 400)
        : JSON.stringify(resp.data).slice(0, 400);
      console.log(`[PM:L${leadId}] ${attemptLabel} raw (first 400): ${rawStr}`);

      if (resp.status !== 200) {
        console.warn(`[PM:L${leadId}] ${attemptLabel} non-200: ${resp.status}`);
        if (attempt < RETRY_COUNT) { await sleep(RETRY_DELAY_MS); continue; }
        return null;
      }

      // ArcGIS sometimes returns a JSON error body with HTTP 200
      const data = resp.data as ArcGISResponse;
      if (data?.error) {
        console.error(`[PM:L${leadId}] ${attemptLabel} ArcGIS error body: code=${data.error.code} msg="${data.error.message}"`);
        return null;
      }

      const features = data?.features ?? [];
      console.log(`[PM:L${leadId}] ${attemptLabel} features returned: ${features.length}`);
      return features;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const code = (err as AxiosError).code ?? "unknown";
      console.error(`[PM:L${leadId}] ${attemptLabel} attempt=${attempt} EXCEPTION code=${code}: ${msg}`);
      if (attempt < RETRY_COUNT) { await sleep(RETRY_DELAY_MS); }
    }
  }

  console.error(`[PM:L${leadId}] ${attemptLabel} all ${RETRY_COUNT} attempts failed`);
  return null;
}

/**
 * Convert a raw ArcGIS feature into a HcpaProperty.
 * Assembles physical address from component fields.
 */
function featureToProperty(f: ArcGISFeature): HcpaProperty {
  const a = f.attributes ?? {};

  // Build street address from HCPA components
  const addrParts = [
    String(a["PHYADDR"]    ?? ""),
    String(a["PHYDIRPFX"]  ?? ""),
    String(a["PHYNAME"]    ?? ""),
    String(a["PHYSUF"]     ?? ""),
    String(a["PHYUNIT"]    ?? ""),
  ].map((s) => s.trim()).filter(Boolean);

  // Prefer OWN1; fall back to OWN2 if OWN1 is empty
  const ownerName =
    String(a["OWN1"] ?? "").trim() ||
    String(a["OWN2"] ?? "").trim();

  return {
    ownerName,
    siteAddress: addrParts.join(" ").trim(),
    siteCity:    String(a["PHYCITY"] ?? "").trim(),
    siteState:   "FL",
    siteZip:     String(a["PHYZIP"]  ?? "").trim(),
  };
}

/**
 * Search ArcGIS for properties owned by someone with the given last name.
 * Tries OWN1 first, then OWN2, then the fallback layer.
 */
async function searchArcGIS(
  lastName: string,
  leadId: number
): Promise<HcpaProperty[]> {
  const safe = lastName.replace(/'/g, "''").toUpperCase();

  // Attempt A: primary layer, OWN1
  const whereA = `UPPER(OWN1) LIKE '%${safe}%'`;
  let features = await queryArcGISLayer(ARCGIS_PRIMARY, whereA, leadId, "ArcGIS-primary-OWN1");

  // Attempt B: primary layer, OWN2 (second owner — catches trust ownership)
  if (!features || features.length === 0) {
    const whereB = `UPPER(OWN2) LIKE '%${safe}%'`;
    console.log(`[PM:L${leadId}] ArcGIS-primary-OWN1 empty → trying OWN2`);
    features = await queryArcGISLayer(ARCGIS_PRIMARY, whereB, leadId, "ArcGIS-primary-OWN2");
  }

  // Attempt C: fallback layer, OWN1
  if (!features || features.length === 0) {
    const whereC = `UPPER(OWN1) LIKE '%${safe}%'`;
    console.log(`[PM:L${leadId}] primary layer empty → trying fallback layer`);
    features = await queryArcGISLayer(ARCGIS_FALLBACK, whereC, leadId, "ArcGIS-fallback-OWN1");
  }

  if (!features || features.length === 0) {
    console.log(`[PM:L${leadId}] ArcGIS: zero results across all attempts for lastName="${lastName}"`);
    return [];
  }

  const props = features
    .map(featureToProperty)
    .filter((p) => p.ownerName.length > 0);

  console.log(`[PM:L${leadId}] ArcGIS: ${props.length} usable properties after map/filter`);
  props.forEach((p, i) =>
    console.log(`[PM:L${leadId}]   [${i}] owner="${p.ownerName}" addr="${p.siteAddress}" city="${p.siteCity}" zip="${p.siteZip}"`)
  );

  return props;
}

// ---- Scoring ------------------------------------------------

interface ScoredProperty {
  prop: HcpaProperty;
  score: number;
  reasons: string[];
}

function scoreProperty(
  prop: HcpaProperty,
  parsed: ParsedName,
  idx: number,
  leadId: number
): ScoredProperty {
  const owner = prop.ownerName.toUpperCase().trim();
  const addr  = prop.siteAddress.toUpperCase().trim();
  const { last, first, middle } = parsed;
  let score = 0;
  const reasons: string[] = [];

  console.log(`[PM:L${leadId}]   Candidate[${idx}]: owner="${owner}" addr="${addr}" city="${prop.siteCity}" zip="${prop.siteZip}"`);

  // Hard check: last name must appear somewhere in owner string
  if (!owner.includes(last)) {
    const r = `HARD REJECT — "${last}" not in "${owner}"`;
    console.log(`[PM:L${leadId}]   [${idx}] ${r}`);
    return { prop, score: -999, reasons: [r] };
  }
  score += 20; reasons.push(`+20 last "${last}"`);
  console.log(`[PM:L${leadId}]   [${idx}] +20 last "${last}" found`);

  if (owner.startsWith(last + ",") || owner.startsWith(last + " ") || owner === last) {
    score += 5; reasons.push("+5 last at start");
    console.log(`[PM:L${leadId}]   [${idx}] +5 last name at start of owner string`);
  }

  // First name / initial
  if (first) {
    const fi = first.charAt(0);
    if (owner.includes(first)) {
      score += 10; reasons.push(`+10 exact first "${first}"`);
      console.log(`[PM:L${leadId}]   [${idx}] +10 exact first "${first}"`);
    } else if (new RegExp(`(?:^|[\\s,])${fi}(?:[\\s,.$]|$)`).test(owner)) {
      score += 6;  reasons.push(`+6 initial "${fi}" (word boundary)`);
      console.log(`[PM:L${leadId}]   [${idx}] +6 first initial "${fi}" (word boundary)`);
    } else if (owner.includes(` ${fi}`) || owner.includes(`,${fi}`)) {
      score += 3;  reasons.push(`+3 initial "${fi}" (weak)`);
      console.log(`[PM:L${leadId}]   [${idx}] +3 first initial "${fi}" (weak)`);
    } else {
      console.log(`[PM:L${leadId}]   [${idx}] +0 first "${first}"/initial "${fi}" NOT found in "${owner}"`);
    }
  }

  // Middle name / initial
  if (middle) {
    const mi = middle.charAt(0);
    if (owner.includes(middle)) {
      score += 3; reasons.push(`+3 middle "${middle}"`);
      console.log(`[PM:L${leadId}]   [${idx}] +3 middle "${middle}"`);
    } else if (new RegExp(`(?:^|[\\s,])${mi}(?:[\\s,.$]|$)`).test(owner)) {
      score += 1; reasons.push(`+1 mid-init "${mi}"`);
      console.log(`[PM:L${leadId}]   [${idx}] +1 middle initial "${mi}"`);
    } else {
      console.log(`[PM:L${leadId}]   [${idx}] +0 middle "${middle}" NOT in "${owner}"`);
    }
  }

  // Trust / estate — very common in probate
  if (owner.includes("REVOCABLE TRUST") || owner.includes("REV TRUST")) {
    score += 3; reasons.push("+3 revocable trust");
    console.log(`[PM:L${leadId}]   [${idx}] +3 REVOCABLE TRUST`);
  } else if (owner.includes("TRUST")) {
    score += 2; reasons.push("+2 trust");
    console.log(`[PM:L${leadId}]   [${idx}] +2 TRUST`);
  }
  if (owner.includes("ESTATE")) {
    score += 2; reasons.push("+2 estate");
    console.log(`[PM:L${leadId}]   [${idx}] +2 ESTATE`);
  }
  if (owner.includes("LIVING TRUST")) {
    score += 1; reasons.push("+1 living trust");
    console.log(`[PM:L${leadId}]   [${idx}] +1 LIVING TRUST`);
  }

  // Address quality
  if (!addr) {
    score -= 10; reasons.push("-10 no addr");
    console.log(`[PM:L${leadId}]   [${idx}] -10 no site address`);
  } else if (addr.includes("PO BOX") || addr.includes("P.O.")) {
    score -= 3; reasons.push("-3 PO box");
    console.log(`[PM:L${leadId}]   [${idx}] -3 PO box`);
  } else {
    score += 3; reasons.push("+3 real addr");
    console.log(`[PM:L${leadId}]   [${idx}] +3 real physical address`);
  }

  if (prop.siteState === "FL") { score += 2; reasons.push("+2 FL"); }
  if (prop.siteZip && /^\d{5}/.test(prop.siteZip)) { score += 1; reasons.push("+1 ZIP"); }

  console.log(`[PM:L${leadId}]   [${idx}] TOTAL SCORE: ${score} — ${reasons.join(" | ")}`);
  return { prop, score, reasons };
}

// ---- Main export --------------------------------------------

export interface MatchedProperty {
  address: string;
  city: string;
  state: string;
  zip: string;
}

export async function findPropertyForDecedent(
  deceasedName: string | null | undefined,
  leadId: number
): Promise<MatchedProperty | null> {
  console.log(`[PM:L${leadId}] ===== START id=${leadId} name="${deceasedName}" =====`);

  const parsed = parseName(deceasedName);
  if (!parsed || !parsed.last || parsed.last.length < 2) {
    console.log(`[PM:L${leadId}] ABORT — unusable name`);
    return null;
  }

  console.log(`[PM:L${leadId}] parsed: last="${parsed.last}" first="${parsed.first}" middle="${parsed.middle}"`);

  // Search ArcGIS by last name
  const results = await searchArcGIS(parsed.last, leadId);

  console.log(`[PM:L${leadId}] Total candidates: ${results.length}`);

  if (results.length === 0) {
    console.log(`[PM:L${leadId}] RESULT: no_match — zero candidates`);
    return null;
  }

  // Score and rank
  console.log(`[PM:L${leadId}] === Scoring ${results.length} candidate(s) ===`);
  const scored: ScoredProperty[] = results.map((p, i) =>
    scoreProperty(p, parsed, i, leadId)
  );
  const sorted = [...scored].sort((a, b) => b.score - a.score);

  console.log(`[PM:L${leadId}] === Top 5 by score ===`);
  sorted.slice(0, 5).forEach((s, i) =>
    console.log(`[PM:L${leadId}]   #${i + 1} score=${s.score} owner="${s.prop.ownerName}" addr="${s.prop.siteAddress}"`)
  );

  const valid = sorted.filter(
    (s) => s.score >= MIN_ACCEPT_SCORE && s.prop.siteAddress.trim().length > 0
  );

  if (valid.length === 0) {
    console.log(`[PM:L${leadId}] ALL REJECTED (score<${MIN_ACCEPT_SCORE} or no address):`);
    sorted.forEach((s, i) =>
      console.log(`[PM:L${leadId}]   [${i}] score=${s.score} addr="${s.prop.siteAddress}" | ${s.reasons.join(" | ")}`)
    );
    console.log(`[PM:L${leadId}] RESULT: no_match`);
    return null;
  }

  const best = valid[0];
  console.log(`[PM:L${leadId}] TOP MATCH SELECTED: owner="${best.prop.ownerName}" score=${best.score}`);
  console.log(`[PM:L${leadId}] Storing → addr="${best.prop.siteAddress}" city="${best.prop.siteCity}" state="${best.prop.siteState}" zip="${best.prop.siteZip}"`);
  console.log(`[PM:L${leadId}] ===== END id=${leadId} =====`);

  return {
    address: best.prop.siteAddress,
    city:    best.prop.siteCity,
    state:   best.prop.siteState || "FL",
    zip:     best.prop.siteZip,
  };
}
