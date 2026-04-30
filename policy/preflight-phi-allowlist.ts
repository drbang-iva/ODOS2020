export interface PreflightPhiAllowlistEntry {
  readonly pattern: RegExp;
  readonly reason: string;
}

export const DEFAULT_PREFLIGHT_PHI_ALLOWLIST: readonly PreflightPhiAllowlistEntry[] = [
  {
    pattern: /\bosod\.local\b/i,
    reason: "Synthetic local-domain install examples are not patient identifiers.",
  },
  {
    pattern: /\bdrill-admin@osod\.local\b/i,
    reason: "Synthetic DR drill account is an operator fixture.",
  },
];

export function isPreflightPhiAllowed(value: string): boolean {
  return DEFAULT_PREFLIGHT_PHI_ALLOWLIST.some((entry) => entry.pattern.test(value));
}
