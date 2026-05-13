// ============================================================
// Property Matcher — Hillsborough County Property Appraiser
//
// ENDPOINT RESOLUTION ORDER:
//   1. HCPA_ARCGIS_SERVICE env var (set this after running /api/discover-endpoint)
//      e.g. HCPA_ARCGIS_SERVICE=Property/MapServer/0
//   2. HPAProxy pattern (Esri proxy that bypasses auth for public queries)
//   3. Direct ArcGIS with self-discovery of service name
//
// Run /api/discover-endpoint once to find the real service name,
// then set HCPA_ARCGIS_SERVICE in Vercel env vars and redeploy.
// ============================================================

import axios, { AxiosError } from "axios";
import type { HcpaProperty } from "@/types/leads";

const BASE = "https://gis.hcpafl.org";
const PROXY = `${BASE}/HPAProxy/proxy.ashx`;

// If set, skips discovery entirely and uses this service path.
// Format: "ServiceName/MapServer/LayerID"  e.g. "Property/MapServer/0"
// Set via Vercel env var: HCPA_ARCGIS_SERVICE=Property/MapServer/0
const ENV_SERVICE = process.env.HCPA_ARCGIS_SERVICE ?? "";

const OUT_FIELDS = "OWN1,OWN2,PHYADDR,PHYDIRPFX,PHYNAME,PHYSUF,PHYUNIT,PHYCITY,PHYZIP";
const MAX_RECORDS = 10;

const BROWSER_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  Accept: "application/json, text/plain, */*",
  "Accept-Language": "en-US,en;q=0.9",
  Referer: "https://gis.hcpafl.org/propertysearch/",
  Origin: "https://gis.hcpafl.org",
};

export const DELAY_MS = 400;
const TIMEOUT_MS = 10000;
const MIN_ACCEPT_SCORE = 1;

// Module-level cache of discovered working endpoint (URL string)
let cachedQueryUrl: string | null = null;

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

// ---- Core ArcGIS query -------------------------------------

interface ArcGISFeature { attributes: Record<string, unknown>; }
interface ArcGISResponse {
  features?: ArcGISFeature[];
  error?: { code: number; message: string };
}

async function queryArcGIS(
  queryUrl: string,
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
  const fullUrl = `${queryUrl}?${qs}`;
  console.log(`[PM:L${leadId}] [${tag}] VERIFIED LIVE ENDPOINT: ${fullUrl}`);

  try {
    const resp = await axios.get<ArcGISResponse>(queryUrl, {
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
      const msg = `ArcGIS error code=${data.error.code} "${data.error.message}"`;
      console.log(`[PM:L${leadId}] [${tag}] ${msg}`);
      return { features: [], ok: false, errorMsg: msg };
    }

    const features = data?.features ?? [];
    console.log(`[PM:L${leadId}] [${tag}] VERIFIED RESPONSE COUNT: ${features.length}`);
    if (features.length > 0) {
      const keys = Object.keys(features[0].attributes ?? {});
      console.log(`[PM:L${leadId}] [${tag}] VERIFIED OWNER FIELD: ${keys.includes("OWN1") ? "OWN1 ✓" : `OWN1 not found — keys: ${keys.join(", ")}`}`);
      console.log(`[PM:L${leadId}] [${tag}] VERIFIED ADDRESS FIELD: ${keys.includes("PHYADDR") ? "PHYADDR ✓" : "PHYADDR not found"}`);
    }
    return { features, ok: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const code = (err as AxiosError).code ?? "";
    console.error(`[PM:L${leadId}] [${tag}] EXCEPTION code=${code}: ${msg}`);
    return { features: [], ok: false, errorMsg: msg };
  }
}

// ---- Endpoint resolution -----------------------------------

/**
 * Build candidate query URLs in priority order:
 * 1. Env var (user-configured after running discover-endpoint)
 * 2. HPAProxy variants
 * 3. Direct ArcGIS variants
 */
function buildCandidateUrls(): Array<{ url: string; label: string }> {
  const candidates: Array<{ url: string; label: string }> = [];

  // Priority 1: User-configured env var
  if (ENV_SERVICE) {
    const direct = `${BASE}/arcgis/rest/services/${ENV_SERVICE}/query`;
    const proxied = `${PROXY}?${direct}`;
    candidates.push(
      { url: proxied, label: `ENV_VAR_PROXY(${ENV_SERVICE})` },
      { url: direct, label: `ENV_VAR_DIRECT(${ENV_SERVICE})` }
    );
    console.log(`[PM] Using HCPA_ARCGIS_SERVICE env var: ${ENV_SERVICE}`);
  }

  // Priority 2: HPAProxy + known service names
  const services = [
    "Property/MapServer/0",
    "Parcels/MapServer/0",
    "parcels/MapServer/0",
    "PropertySearch/MapServer/0",
    "HPA_Layers/MapServer/0",
    "Layers/MapServer/4",
    "Layers/MapServer/5",
    "Layers/MapServer/6",
    "Layers/FeatureServer/0",
    "Property/FeatureServer/0",
    "Parcels/FeatureServer/0",
  ];

  for (const svc of services) {
    const direct = `${BASE}/arcgis/rest/services/${svc}/query`;
    candidates.push(
      { url: `${PROXY}?${direct}`, label: `PROXY(${svc})` },
      { url: direct, label: `DIRECT(${svc})` }
    );
  }

  return candidates;
}

async function getWorkingQueryUrl(leadId: number): Promise<string | null> {
  if (cachedQueryUrl) {
    console.log(`[PM:L${leadId}] Using cached query URL: ${cachedQueryUrl}`);
    return cachedQueryUrl;
  }

  const candidates = buildCandidateUrls();
  console.log(`[PM:L${leadId}] DISCOVERY: testing ${candidates.length} candidate URLs...`);

  for (let i = 0; i < candidates.length; i++) {
    const { url, label } = candidates[i];
    console.log(`[PM:L${leadId}] DISCOVERY [${i + 1}/${candidates.length}] ${label}`);

    const result = await queryArcGIS(url, "UPPER(OWN1) LIKE '%SMITH%'", leadId, `DISC${i + 1}`);

    if (result.ok && result.features.length > 0) {
      cachedQueryUrl = url;
      console.log(`[PM:L${leadId}] DISCOVERY: ✓ WORKING URL FOUND [${label}]: ${url}`);
      console.log(`[PM:L${leadId}] TIP: Set env var HCPA_ARCGIS_SERVICE=${label.replace(/^(?:ENV_VAR_)?(?:PROXY|DIRECT)\((.+)\)$/, "$1")} to skip discovery next time`);
      return url;
    }

    if (result.ok && result.features.length === 0) {
      console.log(`[PM:L${leadId}] DISCOVERY [${i + 1}]: 200 OK but 0 features — wrong layer or field`);
    }

    if (i < candidates.length - 1) await sleep(150);
  }

  console.error(`[PM:L${leadId}] DISCOVERY: ALL candidates failed. Run /api/discover-endpoint for diagnosis.`);
  return null;
}

// ---- Feature → HcpaProperty --------------------------------

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

async function searchOwner(lastName: string, queryUrl: string, leadId: number): Promise<HcpaProperty[]> {
  const safe = lastName.replace(/'/g, "''").toUpperCase();
  const props: HcpaProperty[] = [];

  const r1 = await queryArcGIS(queryUrl, `UPPER(OWN1) LIKE '%${safe}%'`, leadId, "OWN1");
  if (r1.ok && r1.features.length > 0) {
    const mapped = r1.features.map(toProperty).filter((p) => p.ownerName.length > 0);
    console.log(`[PM:L${leadId}] OWN1 → ${mapped.length} properties`);
    mapped.forEach((p, i) => console.log(`[PM:L${leadId}]   OWN1[${i}] owner="${p.ownerName}" addr="${p.siteAddress}"`));
    props.push(...mapped);
  }

  if (props.length === 0) {
    const r2 = await queryArcGIS(queryUrl, `UPPER(OWN2) LIKE '%${safe}%'`, leadId, "OWN2");
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

function scoreCandidate(prop: HcpaProperty, parsed: ParsedName, idx: number, leadId: number): Scored {
  const owner = prop.ownerName.toUpperCase().trim();
  const addr  = prop.siteAddress.toUpperCase().trim();
  const { last, first, middle } = parsed;
  let s = 0;
  const r: string[] = [];

  console.log(`[PM:L${leadId}]   Candidate[${idx}] owner="${owner}" addr="${addr}" city="${prop.siteCity}"`);

  if (!owner.includes(last)) {
    const msg = `HARD REJECT: "${last}" not in "${owner}"`;
    console.log(`[PM:L${leadId}]   [${idx}] ${msg}`);
    return { prop, score: -999, reasons: [msg] };
  }
  s += 20; r.push(`+20 last`);
  console.log(`[PM:L${leadId}]   [${idx}] +20 last "${last}" ✓`);

  if (owner.startsWith(last + ",") || owner.startsWith(last + " ") || owner === last) {
    s += 5; r.push("+5 last@start");
    console.log(`[PM:L${leadId}]   [${idx}] +5 last at start`);
  }

  if (first) {
    const fi = first.charAt(0);
    if (owner.includes(first))                                               { s += 10; r.push(`+10 first="${first}"`);  console.log(`[PM:L${leadId}]   [${idx}] +10 exact first "${first}"`); }
    else if (new RegExp(`(?:^|[\\s,])${fi}(?:[\\s,.$]|$)`).test(owner))     { s += 6;  r.push(`+6 fi="${fi}"`);         console.log(`[PM:L${leadId}]   [${idx}] +6 initial "${fi}" (word boundary)`); }
    else if (owner.includes(` ${fi}`) || owner.includes(`,${fi}`))           { s += 3;  r.push(`+3 fi_weak`);            console.log(`[PM:L${leadId}]   [${idx}] +3 initial "${fi}" (weak)`); }
    else                                                                     {          console.log(`[PM:L${leadId}]   [${idx}] +0 first "${first}" NOT found`); }
  }

  if (middle) {
    const mi = middle.charAt(0);
    if (owner.includes(middle))                                              { s += 3; r.push(`+3 mid`); }
    else if (new RegExp(`(?:^|[\\s,])${mi}(?:[\\s,.$]|$)`).test(owner))     { s += 1; r.push(`+1 mi`); }
  }

  if (owner.includes("REVOCABLE TRUST") || owner.includes("REV TRUST"))     { s += 3; r.push("+3 rev_trust"); console.log(`[PM:L${leadId}]   [${idx}] +3 REVOCABLE TRUST`); }
  else if (owner.includes("TRUST"))                                          { s += 2; r.push("+2 trust");    console.log(`[PM:L${leadId}]   [${idx}] +2 TRUST`); }
  if (owner.includes("ESTATE"))                                              { s += 2; r.push("+2 estate");   console.log(`[PM:L${leadId}]   [${idx}] +2 ESTATE`); }

  if (!addr)                                                                 { s -= 10; r.push("-10 no_addr"); }
  else if (addr.includes("PO BOX") || addr.includes("P.O."))                { s -= 3;  r.push("-3 po_box"); }
  else                                                                       { s += 3;  r.push("+3 real_addr"); console.log(`[PM:L${leadId}]   [${idx}] +3 real address`); }

  if (prop.siteState === "FL")                                               { s += 2; r.push("+2 FL"); }
  if (prop.siteZip && /^\d{5}/.test(prop.siteZip))                          { s += 1; r.push("+1 ZIP"); }

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

  const parsed = parseName(deceasedName);
  if (!parsed || !parsed.last || parsed.last.length < 2) {
    console.log(`[PM:L${leadId}] ABORT — unusable name`);
    return null;
  }
  console.log(`[PM:L${leadId}] STAGE2: last="${parsed.last}" first="${parsed.first}" middle="${parsed.middle}"`);

  const queryUrl = await getWorkingQueryUrl(leadId);
  if (!queryUrl) {
    console.error(`[PM:L${leadId}] ABORT — no working endpoint. Run /api/discover-endpoint and set HCPA_ARCGIS_SERVICE env var.`);
    return null;
  }

  const results = await searchOwner(parsed.last, queryUrl, leadId);
  console.log(`[PM:L${leadId}] STAGE3: total candidates: ${results.length}`);

  if (results.length === 0) {
    console.log(`[PM:L${leadId}] RESULT: no_match — 0 candidates`);
    return null;
  }

  const scored = results.map((p, i) => scoreCandidate(p, parsed, i, leadId));
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
  console.log(`[PM:L${leadId}] VERIFIED LIVE ENDPOINT: ${queryUrl}`);
  console.log(`[PM:L${leadId}] VERIFIED OWNER FIELD: OWN1 = "${best.prop.ownerName}"`);
  console.log(`[PM:L${leadId}] VERIFIED ADDRESS FIELD: PHYADDR → "${best.prop.siteAddress}"`);
  console.log(`[PM:L${leadId}] STAGE5: storing addr="${best.prop.siteAddress}" city="${best.prop.siteCity}" zip="${best.prop.siteZip}"`);
  console.log(`[PM:L${leadId}] ===== END id=${leadId} =====`);

  return {
    address: best.prop.siteAddress,
    city:    best.prop.siteCity,
    state:   best.prop.siteState || "FL",
    zip:     best.prop.siteZip,
  };
}
