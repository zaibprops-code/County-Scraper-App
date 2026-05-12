// ============================================================
// Property Matcher — Hillsborough County Property Appraiser
// DEBUG BUILD: Full request/response logging + retry logic.
// ============================================================

import axios, { AxiosError } from "axios";
import type { HcpaProperty } from "@/types/leads";

const HCPA_OWNER_SEARCH =
  "https://gis.hcpafl.org/HPAServices/PropertySearch.svc/GetOwnerNameResults";

const ARCGIS_QUERY =
  "https://gis.hcpafl.org/arcgis/rest/services/Layers/MapServer/0/query";

// Browser-like headers to avoid bot detection
const BROWSER_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  Accept:
    "application/json, text/javascript, */*; q=0.01",
  "Accept-Language": "en-US,en;q=0.9",
  "Accept-Encoding": "gzip, deflate, br",
  Referer: "https://gis.hcpafl.org/propertysearch/",
  Origin: "https://gis.hcpafl.org",
  "X-Requested-With": "XMLHttpRequest",
  Connection: "keep-alive",
};

export const DELAY_MS = 400;
const TIMEOUT_MS = 12000;
const RETRY_COUNT = 3;
const RETRY_DELAY_MS = 1000;
const MIN_ACCEPT_SCORE = 1;

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

export function parseName(fullName: string | null | undefined): ParsedName | null {
  if (!fullName || !fullName.trim()) return null;
  const s = fullName.trim();

  if (s.includes(",")) {
    const commaIdx = s.indexOf(",");
    const last = s.slice(0, commaIdx).trim().toUpperCase();
    const rest = s.slice(commaIdx + 1).trim().split(/\s+/).filter(Boolean);
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

export function buildOwnerSearchString(parsed: ParsedName): string {
  return parsed.first ? `${parsed.last}, ${parsed.first}` : parsed.last;
}

// ---- HTTP request with retry --------------------------------

interface FetchResult {
  status: number;
  data: unknown;
  headers: Record<string, string>;
  ok: boolean;
}

async function fetchWithRetry(
  url: string,
  params: Record<string, string | number | boolean>,
  leadId: number,
  label: string
): Promise<FetchResult | null> {
  for (let attempt = 1; attempt <= RETRY_COUNT; attempt++) {
    const fullUrl =
      url + "?" + Object.entries(params).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`).join("&");

    console.log(`[PM:L${leadId}] ${label} attempt ${attempt}/${RETRY_COUNT}`);
    console.log(`[PM:L${leadId}] ${label} full URL: ${fullUrl}`);

    try {
      const resp = await axios.get(url, {
        params,
        timeout: TIMEOUT_MS,
        headers: BROWSER_HEADERS,
        validateStatus: () => true, // never throw on any status
        maxRedirects: 5,
      });

      // Log response metadata
      const respHeaders: Record<string, string> = {};
      for (const [k, v] of Object.entries(resp.headers ?? {})) {
        respHeaders[k] = String(v);
      }

      console.log(`[PM:L${leadId}] ${label} HTTP status: ${resp.status}`);
      console.log(`[PM:L${leadId}] ${label} Content-Type: ${respHeaders["content-type"] ?? "unknown"}`);
      console.log(`[PM:L${leadId}] ${label} Content-Length: ${respHeaders["content-length"] ?? "unknown"}`);

      const rawBody =
        typeof resp.data === "string"
          ? (resp.data as string)
          : JSON.stringify(resp.data ?? "");
      console.log(`[PM:L${leadId}] ${label} body (first 600): ${rawBody.slice(0, 600)}`);

      if (resp.status >= 200 && resp.status < 300) {
        console.log(`[PM:L${leadId}] ${label} attempt ${attempt} SUCCESS`);
        return { status: resp.status, data: resp.data, headers: respHeaders, ok: true };
      }

      console.warn(`[PM:L${leadId}] ${label} non-2xx: ${resp.status} — ${rawBody.slice(0, 200)}`);

      if (resp.status === 400 || resp.status === 404) {
        console.log(`[PM:L${leadId}] ${label} permanent failure (${resp.status}) — not retrying`);
        return { status: resp.status, data: resp.data, headers: respHeaders, ok: false };
      }

      if (attempt < RETRY_COUNT) {
        console.log(`[PM:L${leadId}] ${label} waiting ${RETRY_DELAY_MS}ms before retry...`);
        await sleep(RETRY_DELAY_MS);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const axErr = err as AxiosError;
      console.error(`[PM:L${leadId}] ${label} attempt ${attempt} EXCEPTION: ${msg}`);
      if (axErr.code) console.error(`[PM:L${leadId}] ${label} axios error code: ${axErr.code}`);
      if (axErr.response) {
        console.error(`[PM:L${leadId}] ${label} error response status: ${axErr.response.status}`);
        console.error(`[PM:L${leadId}] ${label} error response data: ${JSON.stringify(axErr.response.data).slice(0, 300)}`);
      }

      if (attempt < RETRY_COUNT) {
        console.log(`[PM:L${leadId}] ${label} waiting ${RETRY_DELAY_MS}ms before retry...`);
        await sleep(RETRY_DELAY_MS);
      }
    }
  }

  console.error(`[PM:L${leadId}] ${label} ALL ${RETRY_COUNT} attempts failed`);
  return null;
}

// ---- Response item extraction --------------------------------

function extractItems(rawData: unknown, leadId: number, label: string): Record<string, unknown>[] {
  // axios auto-parses JSON — check array/object first
  if (Array.isArray(rawData)) {
    console.log(`[PM:L${leadId}] ${label} extractItems: direct array, length=${rawData.length}`);
    return rawData as Record<string, unknown>[];
  }

  if (rawData !== null && typeof rawData === "object") {
    const obj = rawData as Record<string, unknown>;
    console.log(`[PM:L${leadId}] ${label} extractItems: object keys=${Object.keys(obj).join(", ")}`);
    // WCF JSON wrapper: { d: [...] }
    const inner = obj["d"] ?? obj["results"] ?? obj["value"] ?? obj["data"] ?? obj["items"];
    if (Array.isArray(inner)) {
      console.log(`[PM:L${leadId}] ${label} extractItems: found inner array, length=${(inner as unknown[]).length}`);
      return inner as Record<string, unknown>[];
    }
    // Last resort: find any array value
    for (const [k, v] of Object.entries(obj)) {
      if (Array.isArray(v) && (v as unknown[]).length > 0) {
        console.log(`[PM:L${leadId}] ${label} extractItems: found array at key "${k}", length=${(v as unknown[]).length}`);
        return v as Record<string, unknown>[];
      }
    }
    console.log(`[PM:L${leadId}] ${label} extractItems: no array found in object`);
    return [];
  }

  // String fallback
  if (typeof rawData === "string") {
    const s = (rawData as string).trim();
    if (s.startsWith("[")) {
      try { const p = JSON.parse(s); console.log(`[PM:L${leadId}] ${label} extractItems: parsed string array, length=${p.length}`); return p; }
      catch (e) { console.log(`[PM:L${leadId}] ${label} extractItems: JSON.parse array failed: ${e}`); }
    }
    if (s.startsWith("{")) {
      try {
        const obj = JSON.parse(s) as Record<string, unknown>;
        const inner = obj["d"] ?? obj["results"] ?? obj["value"];
        if (Array.isArray(inner)) return inner as Record<string, unknown>[];
      } catch (e) { console.log(`[PM:L${leadId}] ${label} extractItems: JSON.parse object failed: ${e}`); }
    }
    if (s.toLowerCase().startsWith("<html") || s.startsWith("<!")) {
      console.log(`[PM:L${leadId}] ${label} extractItems: HTML response — likely auth wall / server error`);
    }
  }

  console.log(`[PM:L${leadId}] ${label} extractItems: returning []`);
  return [];
}

function mapItem(item: Record<string, unknown>): HcpaProperty {
  return {
    ownerName: String(item["Name"] ?? item["OwnerName"] ?? item["OWN1"] ?? item["name"] ?? item["OWNER"] ?? "").trim(),
    siteAddress: String(item["Address"] ?? item["SiteAddress"] ?? item["SITE_ADDR"] ?? item["address"] ?? item["SiteAddr"] ?? "").trim(),
    siteCity: String(item["City"] ?? item["SiteCity"] ?? item["CITY"] ?? item["city"] ?? item["PHYCITY"] ?? "").trim(),
    siteState: String(item["State"] ?? item["SiteState"] ?? item["STATE"] ?? item["state"] ?? "FL").trim(),
    siteZip: String(item["ZipCode"] ?? item["SiteZip"] ?? item["ZIP"] ?? item["zip"] ?? item["PHYZIP"] ?? item["Zip"] ?? "").trim(),
  };
}

// ---- HPAServices (primary) ----------------------------------

async function searchHpaServices(searchStr: string, leadId: number): Promise<HcpaProperty[]> {
  console.log(`[PM:L${leadId}] HPAServices search: "${searchStr}"`);

  const result = await fetchWithRetry(
    HCPA_OWNER_SEARCH,
    { ownerName: searchStr },
    leadId,
    "HPAServices"
  );

  if (!result || !result.ok) {
    console.log(`[PM:L${leadId}] HPAServices: no successful response`);
    return [];
  }

  const items = extractItems(result.data, leadId, "HPAServices");
  if (items.length > 0) {
    console.log(`[PM:L${leadId}] HPAServices: item[0] keys: ${Object.keys(items[0]).join(", ")}`);
  }

  const props = items.map(mapItem).filter((p) => p.ownerName.length > 0);
  console.log(`[PM:L${leadId}] HPAServices: ${props.length} usable properties`);
  props.forEach((p, i) =>
    console.log(`[PM:L${leadId}]   HPAServices[${i}] owner="${p.ownerName}" addr="${p.siteAddress}" city="${p.siteCity}"`)
  );
  return props;
}

// ---- ArcGIS fallback ----------------------------------------

async function searchArcGIS(lastName: string, leadId: number): Promise<HcpaProperty[]> {
  const safeLast = lastName.replace(/'/g, "''");
  const where = `UPPER(OWN1) LIKE '%${safeLast}%'`;
  console.log(`[PM:L${leadId}] ArcGIS search: where="${where}"`);

  const result = await fetchWithRetry(
    ARCGIS_QUERY,
    {
      where,
      outFields: "OWN1,PHYADDR,PHYDIRPFX,PHYNAME,PHYSUF,PHYUNIT,PHYCITY,PHYZIP",
      returnGeometry: "false",
      resultRecordCount: 20,
      f: "json",
    },
    leadId,
    "ArcGIS"
  );

  if (!result || !result.ok) {
    console.log(`[PM:L${leadId}] ArcGIS: no successful response`);
    return [];
  }

  const data = result.data as { features?: Array<{ attributes: Record<string, unknown> }> };
  const features = data?.features ?? [];
  console.log(`[PM:L${leadId}] ArcGIS: ${features.length} feature(s)`);

  const props = features.map((f) => {
    const a = f.attributes ?? {};
    const parts = [
      String(a["PHYADDR"] ?? ""), String(a["PHYDIRPFX"] ?? ""),
      String(a["PHYNAME"] ?? ""), String(a["PHYSUF"] ?? ""),
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

  props.forEach((p, i) =>
    console.log(`[PM:L${leadId}]   ArcGIS[${i}] owner="${p.ownerName}" addr="${p.siteAddress}"`)
  );
  return props;
}

// ---- Scoring ------------------------------------------------

interface ScoredProperty { prop: HcpaProperty; score: number; reasons: string[]; }

function scoreProperty(prop: HcpaProperty, parsed: ParsedName, idx: number, leadId: number): ScoredProperty {
  const owner = prop.ownerName.toUpperCase().trim();
  const addr = prop.siteAddress.toUpperCase().trim();
  const { last, first, middle } = parsed;
  let score = 0;
  const reasons: string[] = [];

  console.log(`[PM:L${leadId}]   Candidate[${idx}]: owner="${owner}" addr="${addr}" city="${prop.siteCity}" zip="${prop.siteZip}"`);

  if (!owner.includes(last)) {
    const r = `HARD REJECT — "${last}" not in "${owner}"`;
    console.log(`[PM:L${leadId}]   [${idx}] ${r}`);
    return { prop, score: -999, reasons: [r] };
  }
  score += 20; reasons.push(`+20 last "${last}"`);
  console.log(`[PM:L${leadId}]   [${idx}] +20 last "${last}" found`);

  if (owner.startsWith(last + ",") || owner.startsWith(last + " ") || owner === last) {
    score += 5; reasons.push("+5 last at start");
    console.log(`[PM:L${leadId}]   [${idx}] +5 last at start`);
  }

  if (first) {
    const fi = first.charAt(0);
    if (owner.includes(first)) {
      score += 10; reasons.push(`+10 exact first "${first}"`);
      console.log(`[PM:L${leadId}]   [${idx}] +10 exact first "${first}"`);
    } else if (new RegExp(`(?:^|[\\s,])${fi}(?:[\\s,.$]|$)`).test(owner)) {
      score += 6; reasons.push(`+6 initial "${fi}" (word boundary)`);
      console.log(`[PM:L${leadId}]   [${idx}] +6 first initial "${fi}" word boundary`);
    } else if (owner.includes(` ${fi}`) || owner.includes(`,${fi}`)) {
      score += 3; reasons.push(`+3 initial "${fi}" (weak)`);
      console.log(`[PM:L${leadId}]   [${idx}] +3 first initial "${fi}" weak`);
    } else {
      console.log(`[PM:L${leadId}]   [${idx}] +0 first "${first}" / initial "${fi}" NOT in "${owner}"`);
    }
  }

  if (middle) {
    const mi = middle.charAt(0);
    if (owner.includes(middle)) { score += 3; reasons.push(`+3 middle "${middle}"`); console.log(`[PM:L${leadId}]   [${idx}] +3 middle "${middle}"`); }
    else if (new RegExp(`(?:^|[\\s,])${mi}(?:[\\s,.$]|$)`).test(owner)) { score += 1; reasons.push(`+1 mid-init "${mi}"`); console.log(`[PM:L${leadId}]   [${idx}] +1 middle initial "${mi}"`); }
    else { console.log(`[PM:L${leadId}]   [${idx}] +0 middle "${middle}" NOT in "${owner}"`); }
  }

  if (owner.includes("REVOCABLE TRUST") || owner.includes("REV TRUST")) { score += 3; reasons.push("+3 rev trust"); console.log(`[PM:L${leadId}]   [${idx}] +3 REVOCABLE TRUST`); }
  else if (owner.includes("TRUST")) { score += 2; reasons.push("+2 trust"); console.log(`[PM:L${leadId}]   [${idx}] +2 TRUST`); }
  if (owner.includes("ESTATE")) { score += 2; reasons.push("+2 estate"); console.log(`[PM:L${leadId}]   [${idx}] +2 ESTATE`); }

  if (!addr) { score -= 10; reasons.push("-10 no addr"); console.log(`[PM:L${leadId}]   [${idx}] -10 no address`); }
  else if (addr.includes("PO BOX") || addr.includes("P.O.")) { score -= 3; reasons.push("-3 PO box"); console.log(`[PM:L${leadId}]   [${idx}] -3 PO box`); }
  else { score += 3; reasons.push("+3 addr"); console.log(`[PM:L${leadId}]   [${idx}] +3 real address`); }

  if (prop.siteState === "FL") { score += 2; reasons.push("+2 FL"); }
  if (prop.siteZip && /^\d{5}/.test(prop.siteZip)) { score += 1; reasons.push("+1 ZIP"); }

  console.log(`[PM:L${leadId}]   [${idx}] TOTAL=${score} — ${reasons.join(" | ")}`);
  return { prop, score, reasons };
}

// ---- Main export --------------------------------------------

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

  console.log(`[PM:L${leadId}] parsed: last="${parsed.last}" first="${parsed.first}" middle="${parsed.middle}"`);

  const searchStr = buildOwnerSearchString(parsed);
  console.log(`[PM:L${leadId}] HCPA search string: "${searchStr}"`);

  // Attempt 1: HPAServices "LAST, FIRST"
  let results = await searchHpaServices(searchStr, leadId);
  if (results.length > 0) console.log(`[PM:L${leadId}] HPAServices "LAST, FIRST" → ${results.length} result(s) ✓`);

  // Attempt 2: HPAServices last name only
  if (results.length === 0 && parsed.first) {
    console.log(`[PM:L${leadId}] Attempt 2: HPAServices last-only "${parsed.last}"`);
    results = await searchHpaServices(parsed.last, leadId);
    if (results.length > 0) console.log(`[PM:L${leadId}] HPAServices last-only → ${results.length} result(s) ✓`);
  }

  // Attempt 3: ArcGIS
  if (results.length === 0) {
    console.log(`[PM:L${leadId}] Attempt 3: ArcGIS fallback last="${parsed.last}"`);
    results = await searchArcGIS(parsed.last, leadId);
    if (results.length > 0) console.log(`[PM:L${leadId}] ArcGIS → ${results.length} result(s) ✓`);
  }

  console.log(`[PM:L${leadId}] Total candidates: ${results.length}`);

  if (results.length === 0) {
    console.log(`[PM:L${leadId}] RESULT: no_match — zero candidates`);
    return null;
  }

  // Score
  console.log(`[PM:L${leadId}] === Scoring ${results.length} candidate(s) ===`);
  const scored = results.map((p, i) => scoreProperty(p, parsed, i, leadId));
  const sorted = [...scored].sort((a, b) => b.score - a.score);

  console.log(`[PM:L${leadId}] === Top 5 ===`);
  sorted.slice(0, 5).forEach((s, i) =>
    console.log(`[PM:L${leadId}]   #${i + 1} score=${s.score} owner="${s.prop.ownerName}" addr="${s.prop.siteAddress}"`)
  );

  const valid = sorted.filter((s) => s.score >= MIN_ACCEPT_SCORE && s.prop.siteAddress.trim().length > 0);
  console.log(`[PM:L${leadId}] Valid (score>=${MIN_ACCEPT_SCORE} + addr): ${valid.length}`);

  if (valid.length === 0) {
    console.log(`[PM:L${leadId}] ALL REJECTED — full rejection list:`);
    sorted.forEach((s, i) =>
      console.log(`[PM:L${leadId}]   [${i}] score=${s.score} addrOk=${s.prop.siteAddress.trim().length > 0} owner="${s.prop.ownerName}" | ${s.reasons.join(" | ")}`)
    );
    console.log(`[PM:L${leadId}] RESULT: no_match`);
    return null;
  }

  const best = valid[0];
  console.log(`[PM:L${leadId}] RESULT: MATCHED owner="${best.prop.ownerName}" addr="${best.prop.siteAddress}" city="${best.prop.siteCity}" score=${best.score}`);
  console.log(`[PM:L${leadId}] ===== END id=${leadId} =====`);

  return {
    address: best.prop.siteAddress,
    city: best.prop.siteCity,
    state: best.prop.siteState || "FL",
    zip: best.prop.siteZip,
  };
}
