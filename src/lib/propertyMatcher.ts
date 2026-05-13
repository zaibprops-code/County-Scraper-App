// ============================================================
// Property Matcher — Hillsborough County Property Appraiser
//
// SELF-DISCOVERING: probes candidate ArcGIS service paths at
// runtime on Vercel and caches the first one that returns data.
//
// Why needed: gis.hcpafl.org/arcgis/rest/services/Layers/MapServer
// returns "Service not found" — the correct service name requires
// browser network inspection on Vercel's outbound IP.
// ============================================================

import axios, { AxiosError } from "axios";
import type { HcpaProperty } from "@/types/leads";

// Ranked candidate endpoints — tried in order until one works.
// Based on Florida PA GIS naming conventions and HCPA public docs.
const ARCGIS_CANDIDATES: string[] = [
  "https://gis.hcpafl.org/arcgis/rest/services/Property/MapServer/0/query",
  "https://gis.hcpafl.org/arcgis/rest/services/Parcels/MapServer/0/query",
  "https://gis.hcpafl.org/arcgis/rest/services/parcels/MapServer/0/query",
  "https://gis.hcpafl.org/arcgis/rest/services/PropertySearch/MapServer/0/query",
  "https://gis.hcpafl.org/arcgis/rest/services/Layers/MapServer/1/query",
  "https://gis.hcpafl.org/arcgis/rest/services/Layers/MapServer/2/query",
  "https://gis.hcpafl.org/arcgis/rest/services/Layers/MapServer/3/query",
  "https://gis.hcpafl.org/arcgis/rest/services/Layers/MapServer/4/query",
  "https://gis.hcpafl.org/arcgis/rest/services/Layers/MapServer/5/query",
  "https://gis.hcpafl.org/arcgis/rest/services/Layers/MapServer/6/query",
  "https://gis.hcpafl.org/arcgis/rest/services/Layers/FeatureServer/0/query",
  "https://gis.hcpafl.org/arcgis/rest/services/Property/FeatureServer/0/query",
  "https://gis.hcpafl.org/arcgis/rest/services/Parcels/FeatureServer/0/query",
  "https://gis.hcpafl.org/arcgis/rest/services/HCPA/MapServer/0/query",
  "https://gis.hcpafl.org/arcgis/rest/services/Public/MapServer/0/query",
];

const OUT_FIELDS = "OWN1,OWN2,PHYADDR,PHYDIRPFX,PHYNAME,PHYSUF,PHYUNIT,PHYCITY,PHYZIP";
const MAX_RECORDS = 10;

const BROWSER_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  Accept: "application/json, text/plain, */*",
  "Accept-Language": "en-US,en;q=0.9",
  Referer: "https://gis.hcpafl.org/propertysearch/",
};

export const DELAY_MS = 400;
const TIMEOUT_MS = 10000;
const MIN_ACCEPT_SCORE = 1;

// Module-level cache — persists for the lifetime of this serverless invocation
let cachedEndpoint: string | null = null;

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ---- Name parsing ------------------------------------------

export interface ParsedName {
  last: string;
  first: string;
  middle: string;
  raw: string;
}

export function parseName(fullName: string | null | undefined): ParsedName | null {
  if (!fullName || !fullName.trim()) return null;
  const s = fullName.trim();

  if (s.includes(",")) {
    const ci = s.indexOf(",");
    const last = s.slice(0, ci).trim().toUpperCase();
    const rest = s.slice(ci + 1).trim().split(/\s+/).filter(Boolean);
    return { last, first: (rest[0] ?? "").toUpperCase(), middle: rest.slice(1).join(" ").toUpperCase(), raw: s };
  }

  const words = s.split(/\s+/).filter(Boolean).map((w) => w.toUpperCase());
  if (words.length === 0) return null;
  if (words.length === 1) return { last: words[0], first: "", middle: "", raw: s };
  if (words.length === 2) return { last: words[1], first: words[0], middle: "", raw: s };
  return { last: words[words.length - 1], first: words[0], middle: words.slice(1, -1).join(" "), raw: s };
}

// ---- Raw ArcGIS query --------------------------------------

interface ArcGISFeature { attributes: Record<string, unknown>; }
interface ArcGISResponse {
  features?: ArcGISFeature[];
  error?: { code: number; message: string };
}

async function queryArcGIS(
  endpoint: string,
  whereClause: string,
  leadId: number,
  tag: string
): Promise<{ features: ArcGISFeature[]; ok: boolean; errorMsg?: string }> {
  const params = {
    where: whereClause,
    outFields: OUT_FIELDS,
    returnGeometry: "false",
    resultRecordCount: String(MAX_RECORDS),
    f: "json",
  };

  const qs = new URLSearchParams(params as Record<string, string>).toString();
  console.log(`[PM:L${leadId}] [${tag}] ${endpoint}?${qs}`);

  try {
    const resp = await axios.get<ArcGISResponse>(endpoint, {
      params,
      timeout: TIMEOUT_MS,
      headers: BROWSER_HEADERS,
      validateStatus: () => true,
    });

    const bodySnippet = JSON.stringify(resp.data).slice(0, 350);
    console.log(`[PM:L${leadId}] [${tag}] HTTP=${resp.status} body: ${bodySnippet}`);

    if (resp.status !== 200) {
      return { features: [], ok: false, errorMsg: `HTTP ${resp.status}` };
    }

    const data = resp.data as ArcGISResponse;
    if (data?.error) {
      const msg = `code=${data.error.code} "${data.error.message}"`;
      console.log(`[PM:L${leadId}] [${tag}] ArcGIS error: ${msg}`);
      return { features: [], ok: false, errorMsg: msg };
    }

    const features = data?.features ?? [];
    console.log(`[PM:L${leadId}] [${tag}] features returned: ${features.length}`);
    if (features.length > 0) {
      console.log(`[PM:L${leadId}] [${tag}] attribute keys: ${Object.keys(features[0].attributes ?? {}).join(", ")}`);
    }
    return { features, ok: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const code = (err as AxiosError).code ?? "";
    console.error(`[PM:L${leadId}] [${tag}] EXCEPTION code=${code}: ${msg}`);
    return { features: [], ok: false, errorMsg: msg };
  }
}

// ---- Service discovery -------------------------------------

async function getWorkingEndpoint(leadId: number): Promise<string | null> {
  if (cachedEndpoint) {
    console.log(`[PM:L${leadId}] DISCOVERY: using cached endpoint: ${cachedEndpoint}`);
    return cachedEndpoint;
  }

  console.log(`[PM:L${leadId}] DISCOVERY: probing ${ARCGIS_CANDIDATES.length} endpoints...`);

  for (let i = 0; i < ARCGIS_CANDIDATES.length; i++) {
    const ep = ARCGIS_CANDIDATES[i];
    console.log(`[PM:L${leadId}] DISCOVERY [${i + 1}/${ARCGIS_CANDIDATES.length}]: ${ep}`);

    const result = await queryArcGIS(ep, "UPPER(OWN1) LIKE '%SMITH%'", leadId, `DISC${i + 1}`);

    if (result.ok && result.features.length > 0) {
      cachedEndpoint = ep;
      console.log(`[PM:L${leadId}] DISCOVERY: ✓ WORKING ENDPOINT: ${ep} (${result.features.length} test features)`);
      return ep;
    }

    if (!result.ok) {
      console.log(`[PM:L${leadId}] DISCOVERY [${i + 1}]: failed — ${result.errorMsg}`);
    } else {
      // Responded 200 but no features — could be valid endpoint with different field names
      // Mark as "maybe" candidate and keep looking for better
      console.log(`[PM:L${leadId}] DISCOVERY [${i + 1}]: 200 OK but 0 SMITH results — field names may differ`);
      if (!cachedEndpoint) cachedEndpoint = ep; // tentative
    }

    if (i < ARCGIS_CANDIDATES.length - 1) await sleep(150);
  }

  if (cachedEndpoint) {
    console.log(`[PM:L${leadId}] DISCOVERY: no endpoint had SMITH data, using tentative: ${cachedEndpoint}`);
    return cachedEndpoint;
  }

  console.error(`[PM:L${leadId}] DISCOVERY: ALL ${ARCGIS_CANDIDATES.length} candidates failed`);
  return null;
}

// ---- Feature mapping ---------------------------------------

function toProperty(f: ArcGISFeature): HcpaProperty {
  const a = f.attributes ?? {};
  const addrParts = [
    String(a["PHYADDR"] ?? ""), String(a["PHYDIRPFX"] ?? ""),
    String(a["PHYNAME"] ?? ""), String(a["PHYSUF"] ?? ""),
    String(a["PHYUNIT"] ?? ""),
  ].map((s) => s.trim()).filter(Boolean);

  return {
    ownerName: String(a["OWN1"] ?? "").trim() || String(a["OWN2"] ?? "").trim(),
    siteAddress: addrParts.join(" ").trim(),
    siteCity:    String(a["PHYCITY"] ?? "").trim(),
    siteState:   "FL",
    siteZip:     String(a["PHYZIP"]  ?? "").trim(),
  };
}

// ---- Owner search ------------------------------------------

async function searchOwner(
  lastName: string,
  endpoint: string,
  leadId: number
): Promise<HcpaProperty[]> {
  const safe = lastName.replace(/'/g, "''").toUpperCase();
  const props: HcpaProperty[] = [];

  // Search OWN1
  const r1 = await queryArcGIS(endpoint, `UPPER(OWN1) LIKE '%${safe}%'`, leadId, "OWN1");
  if (r1.ok && r1.features.length > 0) {
    const mapped = r1.features.map(toProperty).filter((p) => p.ownerName.length > 0);
    console.log(`[PM:L${leadId}] OWN1 → ${mapped.length} properties`);
    mapped.forEach((p, i) => console.log(`[PM:L${leadId}]   OWN1[${i}] owner="${p.ownerName}" addr="${p.siteAddress}" city="${p.siteCity}"`));
    props.push(...mapped);
  }

  // Search OWN2 if nothing in OWN1
  if (props.length === 0) {
    console.log(`[PM:L${leadId}] OWN1 empty → trying OWN2`);
    const r2 = await queryArcGIS(endpoint, `UPPER(OWN2) LIKE '%${safe}%'`, leadId, "OWN2");
    if (r2.ok && r2.features.length > 0) {
      const mapped = r2.features.map(toProperty).filter((p) => p.ownerName.length > 0);
      console.log(`[PM:L${leadId}] OWN2 → ${mapped.length} properties`);
      mapped.forEach((p, i) => console.log(`[PM:L${leadId}]   OWN2[${i}] owner="${p.ownerName}" addr="${p.siteAddress}"`));
      props.push(...mapped);
    }
  }

  return props;
}

// ---- Scoring -----------------------------------------------

interface Scored { prop: HcpaProperty; score: number; reasons: string[]; }

function score(prop: HcpaProperty, parsed: ParsedName, idx: number, leadId: number): Scored {
  const owner = prop.ownerName.toUpperCase().trim();
  const addr  = prop.siteAddress.toUpperCase().trim();
  const { last, first, middle } = parsed;
  let s = 0;
  const r: string[] = [];

  console.log(`[PM:L${leadId}]   Candidate[${idx}] owner="${owner}" addr="${addr}"`);

  if (!owner.includes(last)) {
    const msg = `HARD REJECT: "${last}" not in "${owner}"`;
    console.log(`[PM:L${leadId}]   [${idx}] ${msg}`);
    return { prop, score: -999, reasons: [msg] };
  }
  s += 20; r.push(`+20 last`);
  console.log(`[PM:L${leadId}]   [${idx}] +20 last "${last}" ✓`);

  if (owner.startsWith(last + ",") || owner.startsWith(last + " ") || owner === last) {
    s += 5; r.push("+5 last@start");
  }

  if (first) {
    const fi = first.charAt(0);
    if (owner.includes(first)) { s += 10; r.push(`+10 first="${first}"`); console.log(`[PM:L${leadId}]   [${idx}] +10 exact first "${first}"`); }
    else if (new RegExp(`(?:^|[\\s,])${fi}(?:[\\s,.$]|$)`).test(owner)) { s += 6; r.push(`+6 fi="${fi}"`); console.log(`[PM:L${leadId}]   [${idx}] +6 first initial "${fi}"`); }
    else if (owner.includes(` ${fi}`) || owner.includes(`,${fi}`)) { s += 3; r.push(`+3 fi_weak`); console.log(`[PM:L${leadId}]   [${idx}] +3 first initial "${fi}" weak`); }
    else { console.log(`[PM:L${leadId}]   [${idx}] +0 first "${first}" NOT found`); }
  }

  if (middle) {
    const mi = middle.charAt(0);
    if (owner.includes(middle)) { s += 3; r.push(`+3 mid`); }
    else if (new RegExp(`(?:^|[\\s,])${mi}(?:[\\s,.$]|$)`).test(owner)) { s += 1; r.push(`+1 mi`); }
  }

  if (owner.includes("REVOCABLE TRUST") || owner.includes("REV TRUST")) { s += 3; r.push("+3 rev_trust"); console.log(`[PM:L${leadId}]   [${idx}] +3 REVOCABLE TRUST`); }
  else if (owner.includes("TRUST")) { s += 2; r.push("+2 trust"); console.log(`[PM:L${leadId}]   [${idx}] +2 TRUST`); }
  if (owner.includes("ESTATE")) { s += 2; r.push("+2 estate"); }

  if (!addr) { s -= 10; r.push("-10 no_addr"); console.log(`[PM:L${leadId}]   [${idx}] -10 no address`); }
  else if (addr.includes("PO BOX") || addr.includes("P.O.")) { s -= 3; r.push("-3 po_box"); }
  else { s += 3; r.push("+3 real_addr"); console.log(`[PM:L${leadId}]   [${idx}] +3 real address ✓`); }

  if (prop.siteState === "FL") { s += 2; r.push("+2 FL"); }
  if (prop.siteZip && /^\d{5}/.test(prop.siteZip)) { s += 1; r.push("+1 ZIP"); }

  console.log(`[PM:L${leadId}]   [${idx}] SCORE=${s} — ${r.join(" ")}`);
  return { prop, score: s, reasons: r };
}

// ---- Main export -------------------------------------------

export interface MatchedProperty { address: string; city: string; state: string; zip: string; }

export async function findPropertyForDecedent(
  deceasedName: string | null | undefined,
  leadId: number
): Promise<MatchedProperty | null> {
  console.log(`[PM:L${leadId}] ===== START id=${leadId} name="${deceasedName}" =====`);

  // STAGE 2: Name extraction
  const parsed = parseName(deceasedName);
  if (!parsed || !parsed.last || parsed.last.length < 2) {
    console.log(`[PM:L${leadId}] ABORT — unusable name`);
    return null;
  }
  console.log(`[PM:L${leadId}] STAGE2: last="${parsed.last}" first="${parsed.first}" middle="${parsed.middle}"`);

  // STAGE 3: Service discovery
  const endpoint = await getWorkingEndpoint(leadId);
  if (!endpoint) {
    console.error(`[PM:L${leadId}] ABORT — no working endpoint`);
    return null;
  }
  console.log(`[PM:L${leadId}] STAGE3: using endpoint: ${endpoint}`);

  const results = await searchOwner(parsed.last, endpoint, leadId);
  console.log(`[PM:L${leadId}] STAGE3: total candidates: ${results.length}`);

  if (results.length === 0) {
    console.log(`[PM:L${leadId}] RESULT: no_match — 0 candidates`);
    return null;
  }

  // STAGE 4: Scoring
  console.log(`[PM:L${leadId}] STAGE4: scoring ${results.length} candidates`);
  const scored = results.map((p, i) => score(p, parsed, i, leadId));
  const sorted = [...scored].sort((a, b) => b.score - a.score);

  console.log(`[PM:L${leadId}] TOP 5:`);
  sorted.slice(0, 5).forEach((s, i) =>
    console.log(`[PM:L${leadId}]   #${i + 1} score=${s.score} owner="${s.prop.ownerName}" addr="${s.prop.siteAddress}"`)
  );

  const valid = sorted.filter((s) => s.score >= MIN_ACCEPT_SCORE && s.prop.siteAddress.trim().length > 0);

  if (valid.length === 0) {
    sorted.forEach((s, i) =>
      console.log(`[PM:L${leadId}]   REJECT[${i}] score=${s.score} addr="${s.prop.siteAddress}" | ${s.reasons.join(" ")}`)
    );
    console.log(`[PM:L${leadId}] RESULT: no_match — all rejected`);
    return null;
  }

  const best = valid[0];
  console.log(`[PM:L${leadId}] STAGE4: BEST owner="${best.prop.ownerName}" score=${best.score}`);
  console.log(`[PM:L${leadId}] STAGE5: storing addr="${best.prop.siteAddress}" city="${best.prop.siteCity}" zip="${best.prop.siteZip}"`);
  console.log(`[PM:L${leadId}] ===== END id=${leadId} =====`);

  return {
    address: best.prop.siteAddress,
    city:    best.prop.siteCity,
    state:   best.prop.siteState || "FL",
    zip:     best.prop.siteZip,
  };
}
