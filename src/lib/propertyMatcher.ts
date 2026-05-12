// ============================================================
// Property Matcher — Hillsborough County Property Appraiser
// DEBUG BUILD: Maximum verbosity on every step.
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
const TIMEOUT_MS = 12000;

// Minimum score to accept a match — set very low for debug visibility
const MIN_ACCEPT_SCORE = 1;

export { DELAY_MS };

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

// ---- Response parsing (handles axios auto-parsed JSON) ------

function extractItems(rawData: unknown, leadId: number): Record<string, unknown>[] {
  console.log(`[PM:L${leadId}] extractItems — typeof rawData: ${typeof rawData}`);
  console.log(`[PM:L${leadId}] extractItems — isArray: ${Array.isArray(rawData)}`);

  // axios auto-parses JSON — rawData is already an object/array (not a string)
  if (Array.isArray(rawData)) {
    console.log(`[PM:L${leadId}] extractItems — direct array, length=${rawData.length}`);
    return rawData as Record<string, unknown>[];
  }

  if (rawData !== null && typeof rawData === "object") {
    const obj = rawData as Record<string, unknown>;
    console.log(`[PM:L${leadId}] extractItems — object keys: ${Object.keys(obj).join(", ")}`);
    // WCF JSON: { d: [...] }
    const inner = obj["d"] ?? obj["results"] ?? obj["value"] ?? obj["data"];
    if (Array.isArray(inner)) {
      console.log(`[PM:L${leadId}] extractItems — found inner array via wrapper key, length=${(inner as unknown[]).length}`);
      return inner as Record<string, unknown>[];
    }
    console.log(`[PM:L${leadId}] extractItems — no array wrapper found, checking all values`);
    // Last resort: look for any array value in the object
    for (const [k, v] of Object.entries(obj)) {
      if (Array.isArray(v) && (v as unknown[]).length > 0) {
        console.log(`[PM:L${leadId}] extractItems — found array at key "${k}", length=${(v as unknown[]).length}`);
        return v as Record<string, unknown>[];
      }
    }
  }

  // String fallback (should not normally happen with axios JSON auto-parse)
  if (typeof rawData === "string") {
    const s = (rawData as string).trim();
    console.log(`[PM:L${leadId}] extractItems — string response, first 200 chars: ${s.slice(0, 200)}`);
    if (s.startsWith("[")) {
      try {
        const parsed = JSON.parse(s);
        console.log(`[PM:L${leadId}] extractItems — parsed string array, length=${parsed.length}`);
        return parsed;
      } catch (e) {
        console.log(`[PM:L${leadId}] extractItems — JSON.parse failed: ${e}`);
      }
    }
    if (s.startsWith("{")) {
      try {
        const obj = JSON.parse(s) as Record<string, unknown>;
        const inner = obj["d"] ?? obj["results"] ?? obj["value"];
        if (Array.isArray(inner)) return inner as Record<string, unknown>[];
      } catch (e) {
        console.log(`[PM:L${leadId}] extractItems — object parse failed: ${e}`);
      }
    }
    if (s.toLowerCase().startsWith("<html") || s.toLowerCase().startsWith("<!")) {
      console.log(`[PM:L${leadId}] extractItems — HTML response (auth wall / error page)`);
    }
  }

  console.log(`[PM:L${leadId}] extractItems — could not extract items, returning []`);
  return [];
}

function mapItemToProperty(item: Record<string, unknown>): HcpaProperty {
  return {
    ownerName: String(
      item["Name"] ?? item["OwnerName"] ?? item["OWN1"] ?? item["name"] ?? item["OWNER"] ?? ""
    ).trim(),
    siteAddress: String(
      item["Address"] ?? item["SiteAddress"] ?? item["SITE_ADDR"] ??
      item["address"] ?? item["PHYADDR"] ?? item["SiteAddr"] ?? ""
    ).trim(),
    siteCity: String(
      item["City"] ?? item["SiteCity"] ?? item["CITY"] ?? item["city"] ?? item["PHYCITY"] ?? ""
    ).trim(),
    siteState: String(
      item["State"] ?? item["SiteState"] ?? item["STATE"] ?? item["state"] ?? "FL"
    ).trim(),
    siteZip: String(
      item["ZipCode"] ?? item["SiteZip"] ?? item["ZIP"] ?? item["zip"] ??
      item["PHYZIP"] ?? item["Zip"] ?? ""
    ).trim(),
  };
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
  const addr = prop.siteAddress.toUpperCase().trim();
  const { last, first, middle } = parsed;
  let score = 0;
  const reasons: string[] = [];

  console.log(`[PM:L${leadId}]   Candidate[${idx}]: ownerName="${owner}" addr="${addr}" city="${prop.siteCity}" zip="${prop.siteZip}"`);

  // ---- Last name (hard check) ----
  const lastInOwner = owner.includes(last);
  if (!lastInOwner) {
    const reason = `HARD REJECT — "${last}" not found in "${owner}"`;
    console.log(`[PM:L${leadId}]   [${idx}] ${reason}`);
    return { prop, score: -999, reasons: [reason] };
  }
  score += 20;
  reasons.push(`+20 last "${last}" in owner`);
  console.log(`[PM:L${leadId}]   [${idx}] +20 last name "${last}" found in "${owner}"`);

  // Last name at start
  if (owner.startsWith(last + ",") || owner.startsWith(last + " ") || owner === last) {
    score += 5;
    reasons.push("+5 last at start");
    console.log(`[PM:L${leadId}]   [${idx}] +5 last name at start`);
  }

  // ---- First name ----
  if (first) {
    const firstInitial = first.charAt(0);
    const exactFirst = owner.includes(first);
    // Initial pattern: space+initial+space/end/comma/dot
    const initialPattern = new RegExp(`(?:^|[\\s,])${firstInitial}(?:[\\s,.$]|$)`);
    const initialMatch = initialPattern.test(owner);
    const weakInitial = owner.includes(` ${firstInitial}`) || owner.includes(`,${firstInitial}`) || owner.includes(` ${firstInitial} `);

    if (exactFirst) {
      score += 10;
      reasons.push(`+10 exact first "${first}"`);
      console.log(`[PM:L${leadId}]   [${idx}] +10 exact first "${first}"`);
    } else if (initialMatch) {
      score += 6;
      reasons.push(`+6 first initial "${firstInitial}" (word boundary)`);
      console.log(`[PM:L${leadId}]   [${idx}] +6 first initial "${firstInitial}" (word boundary match)`);
    } else if (weakInitial) {
      score += 3;
      reasons.push(`+3 first initial "${firstInitial}" (weak)`);
      console.log(`[PM:L${leadId}]   [${idx}] +3 first initial "${firstInitial}" (weak match in "${owner}")`);
    } else {
      reasons.push(`+0 first name no match (first="${first}", initial="${firstInitial}", owner="${owner}")`);
      console.log(`[PM:L${leadId}]   [${idx}] +0 first name "${first}" / initial "${firstInitial}" NOT found in "${owner}"`);
    }
  } else {
    console.log(`[PM:L${leadId}]   [${idx}] no first name to match`);
  }

  // ---- Middle ----
  if (middle) {
    const midInitial = middle.charAt(0);
    const exactMid = owner.includes(middle);
    const midInit = new RegExp(`(?:^|[\\s,])${midInitial}(?:[\\s,.$]|$)`).test(owner);
    if (exactMid) {
      score += 3;
      reasons.push(`+3 middle "${middle}"`);
      console.log(`[PM:L${leadId}]   [${idx}] +3 middle "${middle}" found`);
    } else if (midInit) {
      score += 1;
      reasons.push(`+1 middle initial "${midInitial}"`);
      console.log(`[PM:L${leadId}]   [${idx}] +1 middle initial "${midInitial}" found`);
    } else {
      console.log(`[PM:L${leadId}]   [${idx}] +0 middle "${middle}" NOT found in "${owner}"`);
    }
  }

  // ---- Trust / estate detection ----
  if (owner.includes("REVOCABLE TRUST") || owner.includes("REV TRUST")) {
    score += 3;
    reasons.push("+3 revocable trust");
    console.log(`[PM:L${leadId}]   [${idx}] +3 REVOCABLE TRUST detected — valid for probate`);
  } else if (owner.includes("TRUST")) {
    score += 2;
    reasons.push("+2 trust");
    console.log(`[PM:L${leadId}]   [${idx}] +2 TRUST detected`);
  }
  if (owner.includes("ESTATE OF") || owner.includes("ESTATE")) {
    score += 2;
    reasons.push("+2 estate");
    console.log(`[PM:L${leadId}]   [${idx}] +2 ESTATE detected`);
  }
  if (owner.includes("LIVING TRUST")) {
    score += 1;
    reasons.push("+1 living trust");
    console.log(`[PM:L${leadId}]   [${idx}] +1 LIVING TRUST detected`);
  }

  // ---- Address quality ----
  if (!addr) {
    score -= 10;
    reasons.push("-10 no address");
    console.log(`[PM:L${leadId}]   [${idx}] -10 no site address`);
  } else if (addr.includes("PO BOX") || addr.includes("P.O. BOX") || addr.includes("P O BOX")) {
    score -= 3;
    reasons.push("-3 PO box");
    console.log(`[PM:L${leadId}]   [${idx}] -3 PO box address`);
  } else {
    score += 3;
    reasons.push("+3 real address");
    console.log(`[PM:L${leadId}]   [${idx}] +3 non-PO-box address "${addr}"`);
  }

  if (prop.siteState === "FL" || prop.siteState === "Florida") {
    score += 2;
    reasons.push("+2 FL");
    console.log(`[PM:L${leadId}]   [${idx}] +2 Florida state`);
  }

  if (prop.siteZip && /^\d{5}/.test(prop.siteZip)) {
    score += 1;
    reasons.push("+1 valid ZIP");
    console.log(`[PM:L${leadId}]   [${idx}] +1 valid ZIP "${prop.siteZip}"`);
  }

  console.log(`[PM:L${leadId}]   [${idx}] TOTAL SCORE: ${score} — ${reasons.join(" | ")}`);
  return { prop, score, reasons };
}

// ---- HPAServices --------------------------------------------

async function searchHpaServices(
  searchStr: string,
  leadId: number
): Promise<HcpaProperty[]> {
  const fullUrl = `${HCPA_OWNER_SEARCH}?ownerName=${encodeURIComponent(searchStr)}`;
  console.log(`[PM:L${leadId}] HPAServices request URL: ${fullUrl}`);

  try {
    const resp = await axios.get(HCPA_OWNER_SEARCH, {
      params: { ownerName: searchStr },
      timeout: TIMEOUT_MS,
      headers: REQUEST_HEADERS,
      validateStatus: (s) => s < 500,
    });

    console.log(`[PM:L${leadId}] HPAServices HTTP status: ${resp.status}`);
    console.log(`[PM:L${leadId}] HPAServices Content-Type: ${resp.headers?.["content-type"] ?? "unknown"}`);
    console.log(`[PM:L${leadId}] HPAServices resp.data type: ${typeof resp.data}, isArray: ${Array.isArray(resp.data)}`);

    // Log raw response (truncated)
    const rawStr = typeof resp.data === "string"
      ? resp.data
      : JSON.stringify(resp.data);
    console.log(`[PM:L${leadId}] HPAServices raw response (first 500): ${rawStr.slice(0, 500)}`);

    if (resp.status !== 200) {
      console.log(`[PM:L${leadId}] HPAServices non-200 status — skipping`);
      return [];
    }

    const items = extractItems(resp.data, leadId);
    console.log(`[PM:L${leadId}] HPAServices extracted ${items.length} item(s)`);

    if (items.length > 0) {
      // Log raw item keys so we know the exact field names
      console.log(`[PM:L${leadId}] HPAServices item[0] keys: ${Object.keys(items[0]).join(", ")}`);
      console.log(`[PM:L${leadId}] HPAServices item[0] raw: ${JSON.stringify(items[0])}`);
    }

    const props = items
      .map(mapItemToProperty)
      .filter((p) => p.ownerName.length > 0 || p.siteAddress.length > 0);

    console.log(`[PM:L${leadId}] HPAServices mapped ${props.length} properties:`);
    props.forEach((p, i) =>
      console.log(`[PM:L${leadId}]   [${i}] owner="${p.ownerName}" addr="${p.siteAddress}" city="${p.siteCity}" zip="${p.siteZip}"`)
    );

    return props;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[PM:L${leadId}] HPAServices EXCEPTION: ${msg}`);
    if (err instanceof Error && "response" in err) {
      const axErr = err as { response?: { status: number; data: unknown } };
      console.error(`[PM:L${leadId}] HPAServices error response status: ${axErr.response?.status}`);
      console.error(`[PM:L${leadId}] HPAServices error response data: ${JSON.stringify(axErr.response?.data).slice(0, 300)}`);
    }
    return [];
  }
}

// ---- ArcGIS fallback ----------------------------------------

async function searchArcGIS(
  lastName: string,
  leadId: number
): Promise<HcpaProperty[]> {
  const safeLast = lastName.replace(/'/g, "''");
  const where = `UPPER(OWN1) LIKE '%${safeLast}%'`;
  const fullUrl = `${ARCGIS_QUERY}?where=${encodeURIComponent(where)}&outFields=OWN1,PHYADDR,PHYDIRPFX,PHYNAME,PHYSUF,PHYUNIT,PHYCITY,PHYZIP&returnGeometry=false&resultRecordCount=20&f=json`;

  console.log(`[PM:L${leadId}] ArcGIS request URL: ${fullUrl}`);

  try {
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

    console.log(`[PM:L${leadId}] ArcGIS HTTP status: ${resp.status}`);
    console.log(`[PM:L${leadId}] ArcGIS raw (first 400): ${JSON.stringify(resp.data).slice(0, 400)}`);

    if (resp.status !== 200) return [];

    const data = resp.data as { features?: Array<{ attributes: Record<string, unknown> }> };
    const features = data?.features ?? [];
    console.log(`[PM:L${leadId}] ArcGIS features count: ${features.length}`);

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

    console.log(`[PM:L${leadId}] ArcGIS mapped ${props.length} properties:`);
    props.forEach((p, i) =>
      console.log(`[PM:L${leadId}]   [${i}] owner="${p.ownerName}" addr="${p.siteAddress}"`)
    );

    return props;
  } catch (err) {
    console.error(`[PM:L${leadId}] ArcGIS EXCEPTION: ${err instanceof Error ? err.message : err}`);
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

export async function findPropertyForDecedent(
  deceasedName: string | null | undefined,
  leadId: number
): Promise<MatchedProperty | null> {
  console.log(`[PM:L${leadId}] ========== START leadId=${leadId} ==========`);
  console.log(`[PM:L${leadId}] deceased_name raw: "${deceasedName}"`);

  const parsed = parseName(deceasedName);

  if (!parsed) {
    console.log(`[PM:L${leadId}] ABORT — parseName returned null`);
    return null;
  }

  console.log(`[PM:L${leadId}] parsed: last="${parsed.last}" first="${parsed.first}" middle="${parsed.middle}"`);

  if (!parsed.last || parsed.last.length < 2) {
    console.log(`[PM:L${leadId}] ABORT — last name too short or empty`);
    return null;
  }

  const searchStr = buildOwnerSearchString(parsed);
  console.log(`[PM:L${leadId}] HCPA search string: "${searchStr}"`);

  // --- Attempt 1: HPAServices with "LAST, FIRST" ---
  let results = await searchHpaServices(searchStr, leadId);

  // --- Attempt 2: HPAServices with last name only ---
  if (results.length === 0 && parsed.first) {
    console.log(`[PM:L${leadId}] Attempt 2: HPAServices last-only "${parsed.last}"`);
    results = await searchHpaServices(parsed.last, leadId);
  }

  // --- Attempt 3: ArcGIS fallback ---
  if (results.length === 0) {
    console.log(`[PM:L${leadId}] Attempt 3: ArcGIS fallback last="${parsed.last}"`);
    results = await searchArcGIS(parsed.last, leadId);
  }

  console.log(`[PM:L${leadId}] Total candidates after all attempts: ${results.length}`);

  if (results.length === 0) {
    console.log(`[PM:L${leadId}] RESULT: no_match — zero candidates from all sources`);
    return null;
  }

  // Score all candidates
  console.log(`[PM:L${leadId}] === Scoring ${results.length} candidate(s) ===`);
  const scored: ScoredProperty[] = results.map((prop, idx) =>
    scoreProperty(prop, parsed, idx, leadId)
  );

  // Sort by score descending
  const sorted = [...scored].sort((a, b) => b.score - a.score);

  // Log top 5
  console.log(`[PM:L${leadId}] === Top 5 candidates by score ===`);
  sorted.slice(0, 5).forEach((s, i) => {
    console.log(`[PM:L${leadId}]   #${i + 1} score=${s.score} owner="${s.prop.ownerName}" addr="${s.prop.siteAddress}"`);
  });

  // Accept candidates with score >= MIN_ACCEPT_SCORE AND a real address
  const valid = sorted.filter(
    (s) => s.score >= MIN_ACCEPT_SCORE && s.prop.siteAddress.trim().length > 0
  );

  console.log(`[PM:L${leadId}] Candidates with score>=${MIN_ACCEPT_SCORE} and address: ${valid.length}`);

  if (valid.length === 0) {
    // Log ALL rejection reasons for debugging
    console.log(`[PM:L${leadId}] ALL REJECTED — reasons per candidate:`);
    sorted.forEach((s, i) => {
      const addrOk = s.prop.siteAddress.trim().length > 0;
      console.log(
        `[PM:L${leadId}]   [${i}] score=${s.score} addrOk=${addrOk} owner="${s.prop.ownerName}" | ${s.reasons.join(" | ")}`
      );
    });
    console.log(`[PM:L${leadId}] RESULT: no_match`);
    return null;
  }

  const best = valid[0];
  console.log(
    `[PM:L${leadId}] RESULT: MATCHED → owner="${best.prop.ownerName}" addr="${best.prop.siteAddress}" city="${best.prop.siteCity}" zip="${best.prop.siteZip}" score=${best.score}`
  );
  console.log(`[PM:L${leadId}] ========== END leadId=${leadId} ==========`);

  return {
    address: best.prop.siteAddress,
    city: best.prop.siteCity,
    state: best.prop.siteState || "FL",
    zip: best.prop.siteZip,
  };
}
