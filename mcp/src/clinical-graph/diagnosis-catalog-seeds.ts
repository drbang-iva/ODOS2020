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
const OCULAR_HEALTH_LEDGER_PATH = resolve(REPO_ROOT, "data/code-bindings/ocular-health-phase0-ledger.json");
const DIABETIC_RETINOPATHY_LEDGER_PATH = resolve(REPO_ROOT, "data/code-bindings/diabetic-retinopathy-phase0-ledger.json");
const DIPLOPIA_LEDGER_PATH = resolve(REPO_ROOT, "data/code-bindings/diplopia-phase0-ledger.json");

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
    actorReference: "Practitioner/odos-system",
  };
  const glaucoma = loadLedger(GLAUCOMA_LEDGER_PATH);
  const refractive = loadLedger(REFRACTIVE_LEDGER_PATH);
  const ocularHealth = loadLedger(OCULAR_HEALTH_LEDGER_PATH);
  const diabeticRetinopathy = loadLedger(DIABETIC_RETINOPATHY_LEDGER_PATH);
  const diplopia = loadLedger(DIPLOPIA_LEDGER_PATH);
  return [
    familySeed("glaucoma_suspect_open_angle_low", "Open angle with borderline findings, low risk", "glaucoma-suspect", "H40.01-", glaucoma, provenance),
    familySeed("glaucoma_suspect_open_angle_high", "Open angle with borderline findings, high risk", "glaucoma-suspect", "H40.02-", glaucoma, provenance),
    familySeed("ocular_hypertension", "Ocular hypertension", "ocular-hypertension", "H40.05-", glaucoma, provenance),
    familySeed("hyperopia", "Hypermetropia", "hyperopia", "H52.0-", refractive, provenance),
    familySeed("myopia", "Myopia", "myopia", "H52.1-", refractive, provenance),
    familySeed("astigmatism", "Unspecified astigmatism", "astigmatism", "H52.20-", refractive, provenance),
    fixedSeed("anisometropia", "Anisometropia", "anisometropia", "H52.31", refractive, provenance),
    fixedSeed("presbyopia", "Presbyopia", "presbyopia", "H52.4", refractive, provenance),
    familySeed("kcs_not_sjogren", "Keratoconjunctivitis sicca (dry eye)", "keratoconjunctivitis-sicca", "H16.22-", ocularHealth, provenance),
    familySeed("pinguecula", "Pinguecula", "pinguecula", "H11.15-", ocularHealth, provenance),
    familySeed("hypertensive_retinopathy", "Hypertensive retinopathy", "hypertensive-retinopathy", "H35.03-", ocularHealth, provenance),
    familySeed("keratoconus_stable", "Keratoconus, stable", "keratoconus", "H18.61-", ocularHealth, provenance),
    familySeed("keratoconus_unstable", "Keratoconus, unstable", "keratoconus", "H18.62-", ocularHealth, provenance),
    familySeed("keratoconus_unspecified_stability", "Keratoconus (stability unspecified)", "keratoconus", "H18.60-", ocularHealth, provenance),
    perEyeFamilySeed("ulcerative_blepharitis", "Ulcerative blepharitis", "blepharitis-ulcerative", "H01.01-", ocularHealth, provenance),
    perEyeFamilySeed("squamous_blepharitis", "Squamous blepharitis", "blepharitis-squamous", "H01.02-", ocularHealth, provenance),
    perEyeFamilySeed("meibomian_gland_dysfunction", "Meibomian gland dysfunction", "meibomian-gland-dysfunction", "H02.88-", ocularHealth, provenance),
    familySeed("pterygium_central", "Central pterygium", "pterygium", "H11.02-", ocularHealth, provenance),
    familySeed("pterygium_peripheral_stationary", "Peripheral pterygium, stationary", "pterygium", "H11.04-", ocularHealth, provenance),
    familySeed("pterygium_peripheral_progressive", "Peripheral pterygium, progressive", "pterygium", "H11.05-", ocularHealth, provenance),
    familySeed("pterygium_recurrent", "Recurrent pterygium", "pterygium", "H11.06-", ocularHealth, provenance),
    familySeed("retinal_horseshoe_tear", "Horseshoe tear of retina", "retinal-break", "H33.31-", ocularHealth, provenance),
    familySeed("retinal_round_hole", "Round hole of retina", "retinal-break", "H33.32-", ocularHealth, provenance),
    familySeed("retinoschisis", "Retinoschisis", "retinoschisis", "H33.10-", ocularHealth, provenance),
    familySeed("retinal_detachment_single_break", "Retinal detachment with single break", "retinal-detachment", "H33.01-", ocularHealth, provenance),
    fixedSeed("t2_dr_unspecified_with_dme", "Type 2 diabetes with unspecified diabetic retinopathy with macular edema", "diabetic-retinopathy", "E11.311", diabeticRetinopathy, provenance),
    fixedSeed("t2_dr_unspecified_without_dme", "Type 2 diabetes with unspecified diabetic retinopathy without macular edema", "diabetic-retinopathy", "E11.319", diabeticRetinopathy, provenance),
    familySeed("t2_dr_mild_npdr_with_dme", "Type 2 diabetes with mild nonproliferative diabetic retinopathy with macular edema", "diabetic-retinopathy", "E11.321-", diabeticRetinopathy, provenance),
    familySeed("t2_dr_mild_npdr_without_dme", "Type 2 diabetes with mild nonproliferative diabetic retinopathy without macular edema", "diabetic-retinopathy", "E11.329-", diabeticRetinopathy, provenance),
    familySeed("t2_dr_moderate_npdr_with_dme", "Type 2 diabetes with moderate nonproliferative diabetic retinopathy with macular edema", "diabetic-retinopathy", "E11.331-", diabeticRetinopathy, provenance),
    familySeed("t2_dr_moderate_npdr_without_dme", "Type 2 diabetes with moderate nonproliferative diabetic retinopathy without macular edema", "diabetic-retinopathy", "E11.339-", diabeticRetinopathy, provenance),
    familySeed("t2_dr_severe_npdr_with_dme", "Type 2 diabetes with severe nonproliferative diabetic retinopathy with macular edema", "diabetic-retinopathy", "E11.341-", diabeticRetinopathy, provenance),
    familySeed("t2_dr_severe_npdr_without_dme", "Type 2 diabetes with severe nonproliferative diabetic retinopathy without macular edema", "diabetic-retinopathy", "E11.349-", diabeticRetinopathy, provenance),
    familySeed("t2_dr_pdr_with_dme", "Type 2 diabetes with proliferative diabetic retinopathy with macular edema", "diabetic-retinopathy", "E11.351-", diabeticRetinopathy, provenance),
    familySeed("t2_dr_pdr_trd_involving_macula", "Type 2 diabetes with proliferative diabetic retinopathy with traction retinal detachment involving the macula", "diabetic-retinopathy", "E11.352-", diabeticRetinopathy, provenance),
    familySeed("t2_dr_pdr_trd_not_involving_macula", "Type 2 diabetes with proliferative diabetic retinopathy with traction retinal detachment not involving the macula", "diabetic-retinopathy", "E11.353-", diabeticRetinopathy, provenance),
    familySeed("t2_dr_pdr_combined_trd_rrd", "Type 2 diabetes with proliferative diabetic retinopathy with combined traction and rhegmatogenous retinal detachment", "diabetic-retinopathy", "E11.354-", diabeticRetinopathy, provenance),
    familySeed("t2_dr_stable_pdr", "Type 2 diabetes with stable proliferative diabetic retinopathy", "diabetic-retinopathy", "E11.355-", diabeticRetinopathy, provenance),
    familySeed("t2_dr_pdr_without_dme", "Type 2 diabetes with proliferative diabetic retinopathy without macular edema", "diabetic-retinopathy", "E11.359-", diabeticRetinopathy, provenance),
    fixedSeed("diplopia", "Diplopia", "diplopia", "H53.2", diplopia, provenance),
    fixedSeed("paralytic_strabismus", "Unspecified paralytic strabismus", "paralytic-strabismus", "H49.9", diplopia, provenance),
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

function perEyeFamilySeed(
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
