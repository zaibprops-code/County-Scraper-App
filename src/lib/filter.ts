// ============================================================
// Lead filtering — based on real Hillsborough County CSV values
// CaseTypeDescription column (exact values observed in production)
// ============================================================

// Probate: exact CaseTypeDescription values from ProbateFiling CSVs
const PROBATE_KEYWORDS = [
  "formal administration",
  "summary administration greater than",
  "summary administration less than",
  "summary administration",
  "guardian advocate",
  "pre - need guardianship",
  "minor settlement",
  "trust",
  "caveat",
  "probate",
];

// Foreclosure: exact CaseTypeDescription values from CivilFiling CSVs
const FORECLOSURE_KEYWORDS = [
  "mortgage foreclosure",
  "cc real property/mortgage foreclosure",
  "cc real property",
  "lis pendens",
  "foreclosure",
];

// Hard exclusions — never included even if above match
const IGNORE_KEYWORDS = [
  "traffic",
  "criminal",
  "misdemeanor",
  "felony",
  "domestic violence",
  "injunction for protection",
  "name change",
  "adoption",
  "dissolution of marriage",
  "dependency",
  "juvenile",
  "auto negligence",
  "personal injury",
  "workers compensation",
  "medical malpractice",
  "small claims",
  "landlord tenant",
  "lt residential",
  "eviction",
  "discrimination",
  "breach of contract",
  "contract & indebtedness",
  "contract and indebtedness",
  "debt owed",
  "paternity",
  "custody",
  "support enforcement",
  "replevin",
  "forfeiture",
  "insurance claims",
  "wills on deposit",
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
  if (lower.includes("guardian advocate")) return "Guardian Advocate";
  if (lower.includes("pre - need guardianship")) return "Pre-Need Guardianship";
  if (lower.includes("minor settlement")) return "Minor Settlement";
  if (lower.includes("caveat")) return "Caveat";
  if (lower.includes("trust")) return "Trust";
  if (lower.includes("probate")) return "Probate Administration";
  if (
    lower.includes("cc real property/mortgage foreclosure") ||
    lower.includes("cc real property")
  )
    return "Mortgage Foreclosure";
  if (lower.includes("mortgage foreclosure - homestead"))
    return "Mortgage Foreclosure (Homestead)";
  if (lower.includes("mortgage foreclosure - nonhomestead"))
    return "Mortgage Foreclosure (Non-Homestead)";
  if (lower.includes("mortgage foreclosure")) return "Mortgage Foreclosure";
  if (lower.includes("lis pendens")) return "Lis Pendens";
  if (lower.includes("foreclosure")) return "Foreclosure";

  return caseType
    .split(" ")
    .map((w) =>
      w.length > 0 ? w.charAt(0).toUpperCase() + w.slice(1).toLowerCase() : w
    )
    .join(" ");
}
