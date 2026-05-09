// ============================================================
// Lead filtering rules
// Only investor-relevant case types pass through.
// ============================================================

const PROBATE_KEYWORDS = [
  "formal administration",
  "summary administration",
  "probate administration",
  "ancillary administration",
  "determination of homestead",
  "estate of",
  "probate",
];

const FORECLOSURE_KEYWORDS = [
  "mortgage foreclosure",
  "lis pendens",
  "foreclosure complaint",
  "foreclosure",
  "notice of lis pendens",
];

const IGNORE_KEYWORDS = [
  "traffic infraction",
  "criminal",
  "misdemeanor",
  "felony",
  "small claims",
  "landlord tenant",
  "domestic violence",
  "injunction",
  "name change",
  "adoption",
  "dissolution of marriage",
  "divorce",
  "dependency",
  "juvenile",
  "civil infraction",
  "contract and indebtedness",
  "auto negligence",
  "personal injury",
  "workers compensation",
  "medical malpractice",
];

function matchesAny(text: string, keywords: string[]): boolean {
  const lower = text.toLowerCase();
  return keywords.some((kw) => lower.includes(kw));
}

/**
 * Returns true if this case type is a relevant probate lead.
 */
export function isProbateLead(caseType: string | null | undefined): boolean {
  if (!caseType) return false;
  if (matchesAny(caseType, IGNORE_KEYWORDS)) return false;
  return matchesAny(caseType, PROBATE_KEYWORDS);
}

/**
 * Returns true if this case type is a relevant foreclosure/civil lead.
 */
export function isForeclosureLead(
  caseType: string | null | undefined
): boolean {
  if (!caseType) return false;
  if (matchesAny(caseType, IGNORE_KEYWORDS)) return false;
  return matchesAny(caseType, FORECLOSURE_KEYWORDS);
}

/**
 * Map a raw case type string to a clean, normalized label.
 */
export function normalizeCaseType(caseType: string): string {
  const lower = caseType.toLowerCase().trim();

  if (lower.includes("formal administration")) return "Formal Administration";
  if (lower.includes("summary administration")) return "Summary Administration";
  if (lower.includes("ancillary administration"))
    return "Ancillary Administration";
  if (lower.includes("determination of homestead"))
    return "Determination of Homestead";
  if (lower.includes("probate")) return "Probate Administration";
  if (lower.includes("mortgage foreclosure")) return "Mortgage Foreclosure";
  if (lower.includes("lis pendens")) return "Lis Pendens";
  if (lower.includes("foreclosure")) return "Foreclosure";

  // Title-case fallback
  return caseType
    .split(" ")
    .map((w) =>
      w.length > 0 ? w.charAt(0).toUpperCase() + w.slice(1).toLowerCase() : w
    )
    .join(" ");
}
