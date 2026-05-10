// ============================================================
// Lead filtering — exact values confirmed from real
// Hillsborough County production CSV files.
//
// Probate types (from ProbateFiling CSVs):
//   Formal Administration, Summary Administration Greater Than $1000,
//   Summary Administration Less Than $1000, Guardian Advocate Pers/Prop,
//   Pre - Need Guardianship, Minor Settlement, Trust, Caveat
//
// Foreclosure types (from CivilFiling CSVs):
//   Mortgage Foreclosure - Homestead -1/2/3-
//   Mortgage Foreclosure - NonHomestead -1/2/3-
//   CC Real Property/Mortgage Foreclosure $x to $y
//   CC Enforce Lien $x to $y
//
// EXCLUDED (intentionally ignored):
//   Wills on Deposit — not investor-relevant
//   All other civil case types
// ============================================================

// ---- Probate: substring match against casetypedescription ----
const PROBATE_SUBSTRINGS = [
  "formal administration",
  "summary administration",
  "guardian advocate",
  "pre - need guardianship",
  "minor settlement",
  "trust litigation",
  "caveat",
  // bare "trust" intentionally omitted — too broad, catches Trust Litigation via above
];

// "Trust" alone IS a valid probate case type from real files
const PROBATE_EXACT = [
  "trust",
];

// ---- Foreclosure: substring match against casetypedescription ----
const FORECLOSURE_SUBSTRINGS = [
  "mortgage foreclosure",
  "cc real property/mortgage foreclosure",
  "cc real property",
  "cc enforce lien",
  "lis pendens",
];

// ---- Hard exclusions — never match even if above would ----
const EXCLUDE_SUBSTRINGS = [
  "wills on deposit",
  "trust litigation",  // handled as probate above
];

function matchSubstring(text: string, list: string[]): boolean {
  const lower = text.toLowerCase().trim();
  return list.some((kw) => lower.includes(kw));
}

function matchExact(text: string, list: string[]): boolean {
  const lower = text.toLowerCase().trim();
  return list.some((kw) => lower === kw);
}

export function isProbateLead(caseType: string | null | undefined): boolean {
  if (!caseType || !caseType.trim()) return false;
  if (matchSubstring(caseType, EXCLUDE_SUBSTRINGS)) return false;
  return (
    matchSubstring(caseType, PROBATE_SUBSTRINGS) ||
    matchExact(caseType, PROBATE_EXACT)
  );
}

export function isForeclosureLead(
  caseType: string | null | undefined
): boolean {
  if (!caseType || !caseType.trim()) return false;
  if (matchSubstring(caseType, EXCLUDE_SUBSTRINGS)) return false;
  return matchSubstring(caseType, FORECLOSURE_SUBSTRINGS);
}

export function normalizeCaseType(raw: string): string {
  const l = raw.toLowerCase().trim();

  if (l === "formal administration") return "Formal Administration";
  if (l.includes("summary administration greater")) return "Summary Administration (>$1000)";
  if (l.includes("summary administration less")) return "Summary Administration (<$1000)";
  if (l.includes("summary administration")) return "Summary Administration";
  if (l.includes("guardian advocate")) return "Guardian Advocate";
  if (l.includes("pre - need guardianship")) return "Pre-Need Guardianship";
  if (l.includes("minor settlement")) return "Minor Settlement";
  if (l === "trust") return "Trust";
  if (l.includes("trust litigation")) return "Trust Litigation";
  if (l.includes("caveat")) return "Caveat";
  if (l.includes("cc real property/mortgage foreclosure")) return "Mortgage Foreclosure";
  if (l.includes("mortgage foreclosure - homestead")) return "Mortgage Foreclosure (Homestead)";
  if (l.includes("mortgage foreclosure - nonhomestead")) return "Mortgage Foreclosure (Non-Homestead)";
  if (l.includes("mortgage foreclosure")) return "Mortgage Foreclosure";
  if (l.includes("cc enforce lien")) return "Enforce Lien";
  if (l.includes("lis pendens")) return "Lis Pendens";

  // Title-case fallback
  return raw
    .split(" ")
    .map((w) =>
      w.length > 0 ? w.charAt(0).toUpperCase() + w.slice(1).toLowerCase() : w
    )
    .join(" ");
}
