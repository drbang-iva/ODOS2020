import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  ClinicalGraphProvenance,
  DiagnosisCatalogRow,
  DiagnosisIcd10,
} from "./glaucoma-suspect.js";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const GLAUCOMA_LEDGER_PATH = resolve(REPO_ROOT, "data/code-bindings/glaucoma-suspect-phase0-ledger.json");
const REFRACTIVE_LEDGER_PATH = resolve(REPO_ROOT, "data/code-bindings/refractive-error-phase0-ledger.json");

interface LedgerRow {
  code: string;
  display: string;
  family: string;
  laterality: string;
  sourceRefs: string[];
}

let cachedDiagnosisCatalogSeeds: DiagnosisCatalogRow[] | undefined;

export function buildDiagnosisCatalogSeeds(): DiagnosisCatalogRow[] {
  cachedDiagnosisCatalogSeeds ??= buildSeeds();
  return structuredClone(cachedDiagnosisCatalogSeeds);
}

function buildSeeds(): DiagnosisCatalogRow[] {
  const provenance: ClinicalGraphProvenance = {
    source: "manual",
    recordedAt: new Date(0).toISOString(),
    actorReference: "Practitioner/osod-system",
  };
  const glaucoma = loadLedger(GLAUCOMA_LEDGER_PATH);
  const refractive = loadLedger(REFRACTIVE_LEDGER_PATH);
  return [
    familySeed("glaucoma_suspect_open_angle_low", "Open angle with borderline findings, low risk", "glaucoma-suspect", "H40.01-", glaucoma, provenance),
    familySeed("glaucoma_suspect_open_angle_high", "Open angle with borderline findings, high risk", "glaucoma-suspect", "H40.02-", glaucoma, provenance),
    familySeed("ocular_hypertension", "Ocular hypertension", "ocular-hypertension", "H40.05-", glaucoma, provenance),
    familySeed("hyperopia", "Hypermetropia", "hyperopia", "H52.0-", refractive, provenance),
    familySeed("myopia", "Myopia", "myopia", "H52.1-", refractive, provenance),
    familySeed("astigmatism", "Unspecified astigmatism", "astigmatism", "H52.20-", refractive, provenance),
    fixedSeed("anisometropia", "Anisometropia", "anisometropia", "H52.31", refractive, provenance),
    fixedSeed("presbyopia", "Presbyopia", "presbyopia", "H52.4", refractive, provenance),
  ];
}

function loadLedger(path: string): LedgerRow[] {
  const parsed = JSON.parse(readFileSync(path, "utf8")) as { diagnosisCodes?: LedgerRow[] };
  if (!Array.isArray(parsed.diagnosisCodes)) throw new Error(`Diagnosis ledger ${path} has no diagnosisCodes array.`);
  return parsed.diagnosisCodes;
}

function familySeed(
  stableKey: string,
  display: string,
  clinicalFamily: string,
  family: string,
  rows: readonly LedgerRow[],
  provenance: ClinicalGraphProvenance,
): DiagnosisCatalogRow {
  const matches = rows.filter((row) => row.family === family);
  const icd10: DiagnosisIcd10 = {
    pattern: {
      unspecifiedEye: matches.find((row) => row.laterality === "UNKNOWN")?.code,
      right: matches.find((row) => row.laterality === "OD")?.code,
      left: matches.find((row) => row.laterality === "OS")?.code,
      bilateral: matches.find((row) => row.laterality === "OU")?.code,
    },
  };
  const unspecified = matches.find((row) => row.laterality === "UNKNOWN") ?? matches[0];
  if (!unspecified || Object.values(icd10.pattern).some((code) => !code)) {
    throw new Error(`Verified diagnosis family ${family} is incomplete in its Phase 0 ledger.`);
  }
  return baseSeed({
    stableKey,
    display,
    clinicalFamily,
    icd10Family: family,
    icd10Code: unspecified.code,
    icd10Display: unspecified.display,
    lateralityRequired: true,
    icd10,
    provenance: { ...provenance, ledgerRefs: [...new Set(matches.flatMap((row) => row.sourceRefs))] },
  });
}

function fixedSeed(
  stableKey: string,
  display: string,
  clinicalFamily: string,
  code: string,
  rows: readonly LedgerRow[],
  provenance: ClinicalGraphProvenance,
): DiagnosisCatalogRow {
  const row = rows.find((candidate) => candidate.code === code);
  if (!row) throw new Error(`Verified diagnosis code ${code} is missing from its Phase 0 ledger.`);
  return baseSeed({
    stableKey,
    display,
    clinicalFamily,
    icd10Family: row.family,
    icd10Code: row.code,
    icd10Display: row.display,
    lateralityRequired: false,
    icd10: { code: row.code, display: row.display },
    provenance: { ...provenance, ledgerRefs: row.sourceRefs },
  });
}

function baseSeed(input: {
  stableKey: string;
  display: string;
  clinicalFamily: string;
  icd10Family: string;
  icd10Code: string;
  icd10Display: string;
  lateralityRequired: boolean;
  icd10: DiagnosisIcd10;
  provenance: ClinicalGraphProvenance;
}): DiagnosisCatalogRow {
  return {
    id: `diagnosis-def-${input.stableKey.replaceAll("_", "-")}`,
    stableKey: input.stableKey,
    display: input.display,
    clinicalFamily: input.clinicalFamily,
    icd10Family: input.icd10Family,
    icd10Code: input.icd10Code,
    icd10Display: input.icd10Display,
    icd10: input.icd10,
    codingStatus: "verified",
    lateralityRequired: input.lateralityRequired,
    applicableFindingDefinitionIds: [],
    separatesSeverityStagePayerRisk: true,
    keyFindings: [],
    origin: "seed",
    active: true,
    provenance: input.provenance,
  };
}
