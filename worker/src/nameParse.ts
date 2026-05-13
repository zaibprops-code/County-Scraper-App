// ============================================================
// Name parsing utilities for HCPA owner search formatting.
// Converts probate deceased_name into HCPA search format.
// ============================================================

export interface ParsedName {
  last: string;
  first: string;
  middle: string;
  raw: string;
}

/**
 * Parse a full name into components.
 * Handles:
 *   "Eva Rose Breese"       → last=BREESE  first=EVA   middle=ROSE
 *   "MOORE, MICHAEL JEROME" → last=MOORE   first=MICHAEL middle=JEROME
 *   "Robert E Smith"        → last=SMITH   first=ROBERT  middle=E
 */
export function parseName(fullName: string | null | undefined): ParsedName | null {
  if (!fullName || !fullName.trim()) return null;
  const s = fullName.trim();

  // Already "LAST, FIRST [MIDDLE]" format
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

  // "First [Middle...] Last" format
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

/**
 * Build HCPA owner search string in "LASTNAME, FIRSTNAME" format.
 * Example: "Eva Rose Breese" → "BREESE, EVA"
 */
export function buildSearchString(parsed: ParsedName): string {
  if (parsed.first) {
    return `${parsed.last}, ${parsed.first}`;
  }
  return parsed.last;
}

/**
 * Parse a raw address string into components.
 * Handles: "1234 MAIN ST, TAMPA, FL 33601"
 */
export function parseAddressString(raw: string): {
  address: string | null;
  city: string | null;
  state: string;
  zip: string | null;
} {
  if (!raw || !raw.trim()) {
    return { address: null, city: null, state: "FL", zip: null };
  }

  const parts = raw.split(",").map((p) => p.trim()).filter(Boolean);

  if (parts.length >= 3) {
    const address = parts.slice(0, parts.length - 2).join(", ").trim() || null;
    const city = parts[parts.length - 2].trim() || null;
    const stateZip = parts[parts.length - 1].trim();
    const match = stateZip.match(/^([A-Z]{2})\s+(\d{5}(?:-\d{4})?)/);
    return {
      address,
      city,
      state: match ? match[1] : "FL",
      zip: match ? match[2].slice(0, 5) : null,
    };
  }

  if (parts.length === 2) {
    return { address: parts[0], city: parts[1], state: "FL", zip: null };
  }

  return { address: raw.trim(), city: null, state: "FL", zip: null };
}
