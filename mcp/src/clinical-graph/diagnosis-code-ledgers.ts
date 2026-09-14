import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

export interface DiagnosisCodeLedgerRow {
  code: string;
  display: string;
  family: string;
  laterality: string;
  sourceRefs: string[];
}

export const DIAGNOSIS_CODE_LEDGER_PATHS = {
  glaucomaSuspect: resolve(REPO_ROOT, "data/code-bindings/glaucoma-suspect-phase0-ledger.json"),
  refractiveError: resolve(REPO_ROOT, "data/code-bindings/refractive-error-phase0-ledger.json"),
  ocularHealth: resolve(REPO_ROOT, "data/code-bindings/ocular-health-phase0-ledger.json"),
  diabeticRetinopathy: resolve(REPO_ROOT, "data/code-bindings/diabetic-retinopathy-phase0-ledger.json"),
  type2Diabetes: resolve(REPO_ROOT, "data/code-bindings/type-2-diabetes-phase0-ledger.json"),
  type1DiabeticRetinopathy: resolve(REPO_ROOT, "data/code-bindings/type-1-diabetic-retinopathy-phase0-ledger.json"),
  diplopia: resolve(REPO_ROOT, "data/code-bindings/diplopia-phase0-ledger.json"),
  visualField: resolve(REPO_ROOT, "data/code-bindings/visual-field-phase0-ledger.json"),
  lens: resolve(REPO_ROOT, "data/code-bindings/lens-phase0-ledger.json"),
} as const;

export function loadDiagnosisCodeLedger(path: string): DiagnosisCodeLedgerRow[] {
  const parsed = JSON.parse(readFileSync(path, "utf8")) as { diagnosisCodes?: DiagnosisCodeLedgerRow[] };
  if (!Array.isArray(parsed.diagnosisCodes)) throw new Error(`Diagnosis ledger ${path} has no diagnosisCodes array.`);
  return parsed.diagnosisCodes;
}

export function loadDiagnosisCodeLedgerRows(): DiagnosisCodeLedgerRow[] {
  return Object.values(DIAGNOSIS_CODE_LEDGER_PATHS).flatMap(loadDiagnosisCodeLedger);
}
