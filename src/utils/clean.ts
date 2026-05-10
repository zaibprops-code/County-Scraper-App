// ============================================================
// Data cleaning and normalization utilities
// ============================================================

/**
 * Trim whitespace and normalize internal spaces.
 * Returns null for empty / missing values.
 */
export function cleanString(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const str = String(value).trim().replace(/\s+/g, " ");
  return str.length > 0 ? str : null;
}

/**
 * Convert a string to Title Case.
 */
export function normalizeName(value: unknown): string | null {
  const str = cleanString(value);
  if (!str) return null;
  return str
    .toLowerCase()
    .split(" ")
    .map((word) =>
      word.length > 0 ? word.charAt(0).toUpperCase() + word.slice(1) : word
    )
    .join(" ");
}

/**
 * Parse a date string into ISO format YYYY-MM-DD.
 * Handles: MM/DD/YYYY, M/D/YYYY, YYYY-MM-DD
 */
export function parseDate(value: unknown): string | null {
  if (!value) return null;
  const str = String(value).trim();
  if (!str) return null;

  // MM/DD/YYYY or M/D/YYYY
  const mdyMatch = str.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (mdyMatch) {
    const [, m, d, y] = mdyMatch;
    return `${y}-${m.padStart(2, "0")}-${d.padStart(2, "0")}`;
  }

  // Already ISO: YYYY-MM-DD
  if (/^\d{4}-\d{2}-\d{2}$/.test(str)) return str;

  // Fallback: try native Date parse
  const date = new Date(str);
  if (!isNaN(date.getTime())) {
    return date.toISOString().split("T")[0];
  }

  return null;
}

/**
 * Normalize a ZIP code to 5 digits.
 */
export function normalizeZip(value: unknown): string | null {
  const str = cleanString(value);
  if (!str) return null;
  const digits = str.replace(/\D/g, "");
  return digits.length >= 5 ? digits.substring(0, 5) : null;
}

/**
 * Normalize a case number: uppercase, remove all whitespace.
 */
export function normalizeCaseNumber(value: unknown): string | null {
  const str = cleanString(value);
  if (!str) return null;
  return str.toUpperCase().replace(/\s+/g, "");
}

/**
 * Return the first non-empty string from a list of fallback values.
 */
export function firstOf(...values: unknown[]): string | null {
  for (const v of values) {
    const cleaned = cleanString(v);
    if (cleaned) return cleaned;
  }
  return null;
}
