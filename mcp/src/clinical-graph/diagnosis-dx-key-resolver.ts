import {
  FAMILY_RESOLUTION_MODES,
  buildDiagnosisCatalogSeeds,
} from "./diagnosis-catalog-seeds.js";
import {
  loadDiagnosisCodeLedgerRows,
  type DiagnosisCodeLedgerRow,
} from "./diagnosis-code-ledgers.js";

export { loadDiagnosisCodeLedgerRows } from "./diagnosis-code-ledgers.js";

export type DiagnosisDxKeyResolution =
  | {
      status: "resolved";
      input: string;
      dxKeys: string[];
      ledgerFamilies: string[];
    }
  | {
      status: "unresolved";
      input: string;
      reason: "no-ledger-entry";
    };

interface ResolutionIndex {
  byFamily: Map<string, DiagnosisCodeLedgerRow[]>;
  byStableKey: Map<string, string[]>;
  stagedFamilies: Map<string, string[]>;
}

let cachedIndex: ResolutionIndex | undefined;

export function resolveDiagnosisDxKeys(input: string): DiagnosisDxKeyResolution {
  const normalizedInput = input.trim();
  const index = cachedIndex ??= buildResolutionIndex();
  const ledgerFamilies = index.byFamily.has(normalizedInput)
    ? [normalizedInput]
    : index.stagedFamilies.get(normalizedInput) ?? index.byStableKey.get(normalizedInput);
  if (!ledgerFamilies?.length) {
    return { status: "unresolved", input: normalizedInput, reason: "no-ledger-entry" };
  }
  return {
    status: "resolved",
    input: normalizedInput,
    dxKeys: uniqueSorted(ledgerFamilies.flatMap((family) => index.byFamily.get(family)?.map((row) => row.code) ?? [])),
    ledgerFamilies: uniqueSorted(ledgerFamilies),
  };
}

function buildResolutionIndex(): ResolutionIndex {
  const rows = loadDiagnosisCodeLedgerRows();
  const byFamily = new Map<string, DiagnosisCodeLedgerRow[]>();
  for (const row of rows) byFamily.set(row.family, [...(byFamily.get(row.family) ?? []), row]);

  const catalog = buildDiagnosisCatalogSeeds();
  const catalogByStableKey = new Map(catalog.map((row) => [row.stableKey, row]));
  const byStableKey = new Map<string, string[]>();
  for (const row of catalog) {
    const family = row.icd10Family;
    if (!family || !byFamily.has(family)) {
      throw new Error(`Diagnosis ${row.stableKey} has no verified ledger family.`);
    }
    byStableKey.set(row.stableKey, [family]);
  }
  const stagedFamilies = new Map<string, string[]>();
  for (const [clinicalFamily, mode] of Object.entries(FAMILY_RESOLUTION_MODES)) {
    if (mode.mode !== "staged") continue;
    const memberFamilies = mode.members.map((member) => {
      const family = catalogByStableKey.get(member.stableKey)?.icd10Family;
      if (!family || !byFamily.has(family)) {
        throw new Error(`Staged diagnosis ${member.stableKey} has no verified ledger family.`);
      }
      return family;
    });
    const bareFamily = longestCommonPrefix(memberFamilies);
    if (!bareFamily.endsWith("-")) {
      throw new Error(`Staged diagnosis family ${clinicalFamily} has no shared ledger family label.`);
    }
    stagedFamilies.set(clinicalFamily, memberFamilies);
    stagedFamilies.set(bareFamily, memberFamilies);
  }
  return { byFamily, byStableKey, stagedFamilies };
}

function longestCommonPrefix(values: readonly string[]): string {
  if (!values.length) return "";
  let prefix = values[0];
  for (const value of values.slice(1)) {
    while (!value.startsWith(prefix)) prefix = prefix.slice(0, -1);
  }
  return prefix;
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}
