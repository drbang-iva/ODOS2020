import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadDiagnosisCodeLedger } from "./diagnosis-code-ledgers.js";

const refractiveCodes = new Set(loadDiagnosisCodeLedger(resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../data/code-bindings/refractive-billing-class-ledger.json",
)).map((row) => row.code));

export function diagnosisBillingClass(icd10Code: string): "refractive" | "medical" {
  return refractiveCodes.has(icd10Code) ? "refractive" : "medical";
}
