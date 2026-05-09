// ============================================================
// Lead filtering rules
// Keyword lists derived from real Hillsborough County CSV values.
// Civil column: CaseTypeDescription
// Probate column: CaseTypeDescription (or similar)
// ============================================================

const PROBATE_KEYWORDS = [
  "formal administration",
  "summary administration",
  "probate administration",
  "ancillary administration",
  "determination of homestead",
  "estate of",
  "probate",
  "guardianship",
  "trust",
];

const FORECLOSURE_KEYWORDS = [
  "mortgage foreclosure",
  "cc real property/mortgage foreclosure",
  "cc real property",
  "lis pendens",
  "foreclosure complaint",
  "foreclosure",
  "notice of lis pendens",
];

// Terms that should always be excluded regardless of above matches
const IGNORE_KEYWORDS = [
  "traffic infraction",
  "misdemeanor",
  "felony",
  "criminal",
  "domestic violence",
  "injunction for protection",
  "name change",
  "adoption",
  "dissolution of marriage",
  "dependency",
  "juvenile",
  "civil infraction",
  "auto negligence",
  "personal injury",
  "workers compensation",
  "medical malpractice",
  "small claims",
  "landlord tenant",
];

function matchesAny(text: string, keywords: string[]): boolean {
  const lower = text.toLowerCase().trim();
  return keywords.some((kw) => lower.includes(kw.toLowerCase()));
}

export function isProbateLead(caseType: string | null | undefined): boolean {
  if (!caseType) return false;
  if (matchesAny(caseType, IGNORE_KEYWORDS)) return false;
  return matchesAny(caseType, PROBATE_KEYWORDS);
}

export function isForeclosureLead(
  caseType: string | null | undefined
): boolean {
  if (!caseType) return false;
  if (matchesAny(caseType, IGNORE_KEYWORDS)) return false;
  return matchesAny(caseType, FORECLOSURE_KEYWORDS);
}

export function normalizeCaseType(caseType: string): string {
  const lower = caseType.toLowerCase().trim();

  if (lower.includes("formal administration")) return "Formal Administration";
  if (lower.includes("summary administration")) return "Summary Administration";
  if (lower.includes("ancillary administration"))
    return "Ancillary Administration";
  if (lower.includes("determination of homestead"))
    return "Determination of Homestead";
  if (lower.includes("guardianship")) return "Guardianship";
  if (lower.includes("trust")) return "Trust";
  if (lower.includes("probate")) return "Probate Administration";
  if (
    lower.includes("cc real property/mortgage foreclosure") ||
    lower.includes("cc real property")
  )
    return "Mortgage Foreclosure";
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
