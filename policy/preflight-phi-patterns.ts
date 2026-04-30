import { isPreflightPhiAllowed } from "./preflight-phi-allowlist.js";

export interface PreflightPhiPattern {
  readonly id: string;
  readonly description: string;
  readonly severity: "warning" | "hard-block";
  readonly regex: RegExp;
}

export interface PreflightPhiMatch {
  readonly patternId: string;
  readonly description: string;
  readonly matchedText: string;
  readonly line?: number;
  readonly column?: number;
}

export const PREFLIGHT_PHI_PATTERNS: readonly PreflightPhiPattern[] = [
  {
    id: "ssn-shaped",
    description: "SSN-shaped digit sequence",
    severity: "warning",
    regex: /\b\d{3}-\d{2}-\d{4}\b/g,
  },
  {
    id: "dob-shaped",
    description: "DOB-shaped value",
    severity: "warning",
    regex: /\bDOB\s*[:=#-]?\s*(?:\d{4}-\d{2}-\d{2}|\d{1,2}\/\d{1,2}\/\d{4})\b/gi,
  },
  {
    id: "mrn-shaped",
    description: "MRN-shaped identifier",
    severity: "warning",
    regex: /\bMRN\s*[:=#-]?\s*[A-Z0-9-]{4,}\b/gi,
  },
  {
    id: "patient-identifier-raw",
    description: "Raw Patient.identifier-shaped value",
    severity: "warning",
    regex: /\bPatient\.identifier\s*[:=]\s*[A-Za-z0-9._:-]{4,}\b/g,
  },
  {
    id: "fixture-patient-name",
    description: "Known PHI-shaped patient-name fixture",
    severity: "warning",
    regex: /\b(?:John Smith|Jane Doe|Mary Johnson|Robert Jones)\b/g,
  },
  {
    id: "patient-name-label",
    description: "Patient-name label followed by a two-token name",
    severity: "warning",
    regex: /\b(?:patient|pt|patient_name|patient-name)\s*[:=#-]\s*[A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,2}\b/g,
  },
];

export function findPhiPatternMatches(value: string): PreflightPhiMatch[] {
  if (!value || isPreflightPhiAllowed(value)) {
    return [];
  }

  const matches: PreflightPhiMatch[] = [];
  for (const pattern of PREFLIGHT_PHI_PATTERNS) {
    pattern.regex.lastIndex = 0;
    for (const match of value.matchAll(pattern.regex)) {
      if (isPreflightPhiAllowed(match[0])) {
        continue;
      }
      const position = lineAndColumn(value, match.index ?? 0);
      matches.push({
        patternId: pattern.id,
        description: pattern.description,
        matchedText: redactMatch(match[0]),
        line: position.line,
        column: position.column,
      });
    }
  }
  return matches;
}

function lineAndColumn(value: string, index: number): { line: number; column: number } {
  const prefix = value.slice(0, index);
  const lines = prefix.split(/\r?\n/);
  return { line: lines.length, column: (lines.at(-1)?.length ?? 0) + 1 };
}

function redactMatch(value: string): string {
  if (value.length <= 4) {
    return "[redacted]";
  }
  return `${value.slice(0, 2)}...[redacted]`;
}
