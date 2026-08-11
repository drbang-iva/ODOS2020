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
const TYPE_1_DIABETIC_RETINOPATHY_LEDGER_PATH = resolve(REPO_ROOT, "data/code-bindings/type-1-diabetic-retinopathy-phase0-ledger.json");
const DIPLOPIA_LEDGER_PATH = resolve(REPO_ROOT, "data/code-bindings/diplopia-phase0-ledger.json");
const VISUAL_FIELD_LEDGER_PATH = resolve(REPO_ROOT, "data/code-bindings/visual-field-phase0-ledger.json");
const LENS_LEDGER_PATH = resolve(REPO_ROOT, "data/code-bindings/lens-phase0-ledger.json");

interface LedgerRow {
  code: string;
  display: string;
  family: string;
  laterality: string;
  sourceRefs: string[];
}

export type FamilyResolutionMode =
  | {
      mode: "staged";
      axisLabel: string;
      members: Array<{ stableKey: string; stageLabel: string }>;
    }
  | { mode: "qualifier-resolved" }
  | { mode: "distinct" };

export type FamilyResolutionModes = Record<string, FamilyResolutionMode>;

export const FAMILY_RESOLUTION_MODES: FamilyResolutionModes = {
  "primary-open-angle-glaucoma": {
    mode: "staged",
    axisLabel: "Stage",
    members: [
      { stableKey: "poag_mild", stageLabel: "Mild" },
      { stableKey: "poag_moderate", stageLabel: "Moderate" },
      { stableKey: "poag_severe", stageLabel: "Severe" },
      { stableKey: "poag_indeterminate", stageLabel: "Indeterminate" },
    ],
  },
  "low-tension-glaucoma": {
    mode: "staged",
    axisLabel: "Stage",
    members: [
      { stableKey: "low_tension_glaucoma_mild", stageLabel: "Mild" },
      { stableKey: "low_tension_glaucoma_moderate", stageLabel: "Moderate" },
      { stableKey: "low_tension_glaucoma_severe", stageLabel: "Severe" },
      { stableKey: "low_tension_glaucoma_indeterminate", stageLabel: "Indeterminate" },
    ],
  },
  "nonexudative-amd": {
    mode: "staged",
    axisLabel: "Stage",
    members: [
      { stableKey: "dry_amd_early", stageLabel: "Early" },
      { stableKey: "dry_amd_intermediate", stageLabel: "Intermediate" },
      {
        stableKey: "dry_amd_advanced_atrophic_without_subfoveal",
        stageLabel: "Advanced atrophic without subfoveal involvement (geographic atrophy)",
      },
      {
        stableKey: "dry_amd_advanced_atrophic_with_subfoveal",
        stageLabel: "Advanced atrophic with subfoveal involvement (geographic atrophy)",
      },
    ],
  },
  "exudative-amd": {
    mode: "staged",
    axisLabel: "Activity",
    members: [
      { stableKey: "wet_amd_active_cnv", stageLabel: "With active CNV" },
      { stableKey: "wet_amd_inactive_cnv", stageLabel: "With inactive CNV" },
      { stableKey: "wet_amd_inactive_scar", stageLabel: "With inactive scar" },
    ],
  },
  "diabetic-retinopathy": { mode: "qualifier-resolved" },
  "type-1-diabetic-retinopathy": { mode: "qualifier-resolved" },
  keratoconus: { mode: "qualifier-resolved" },
  pterygium: { mode: "qualifier-resolved" },
  "glaucoma-suspect": { mode: "distinct" },
  "visual-field-defect": { mode: "distinct" },
  cataract: { mode: "distinct" },
  lens: { mode: "distinct" },
  "retinal-break": { mode: "distinct" },
};

export function validateFamilyResolutionModes(
  catalog: readonly DiagnosisCatalogRow[],
  modes: FamilyResolutionModes = FAMILY_RESOLUTION_MODES,
  candidateFamilyGroups: readonly string[] = [],
): void {
  const activeRows = catalog.filter((row) => row.active);
  const byFamily = new Map<string, DiagnosisCatalogRow[]>();
  const byStableKey = new Map(activeRows.map((row) => [row.stableKey, row]));
  for (const row of activeRows) {
    byFamily.set(row.clinicalFamily, [...(byFamily.get(row.clinicalFamily) ?? []), row]);
  }
  for (const [clinicalFamily, rows] of byFamily) {
    if (rows.length > 1 && !modes[clinicalFamily]) {
      throw new Error(`Family resolution mode missing for active multi-row family ${clinicalFamily}.`);
    }
  }
  for (const [clinicalFamily, mode] of Object.entries(modes)) {
    if (mode.mode !== "staged") continue;
    const declaredMemberKeys = new Set(mode.members.map((member) => member.stableKey));
    for (const member of mode.members) {
      const row = byStableKey.get(member.stableKey);
      if (!row) {
        throw new Error(`Staged member ${member.stableKey} does not exist as an active diagnosis catalog row.`);
      }
      if (row.clinicalFamily !== clinicalFamily) {
        throw new Error(`Staged member ${member.stableKey} belongs to ${row.clinicalFamily}, not ${clinicalFamily}.`);
      }
      if (member.stageLabel.toLocaleLowerCase().includes("unspecified")) {
        throw new Error(`Stage label ${member.stageLabel} for ${member.stableKey} must not contain unspecified.`);
      }
    }
    const undeclaredMember = byFamily.get(clinicalFamily)?.find((row) => !declaredMemberKeys.has(row.stableKey));
    if (undeclaredMember) {
      throw new Error(`Staged family ${clinicalFamily} has active catalog member ${undeclaredMember.stableKey} that is not declared.`);
    }
  }
  for (const familyGroup of new Set(candidateFamilyGroups)) {
    if (modes[familyGroup]?.mode !== "staged") {
      throw new Error(`Diagnosis candidate familyGroup ${familyGroup} must reference a staged family resolution mode.`);
    }
  }
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
  const type1DiabeticRetinopathy = loadLedger(TYPE_1_DIABETIC_RETINOPATHY_LEDGER_PATH);
  const diplopia = loadLedger(DIPLOPIA_LEDGER_PATH);
  const visualField = loadLedger(VISUAL_FIELD_LEDGER_PATH);
  const lens = loadLedger(LENS_LEDGER_PATH);
  const seeds = [
    familySeed("glaucoma_suspect_open_angle_low", "Open angle with borderline findings, low risk", "glaucoma-suspect", "H40.01-", glaucoma, provenance),
    familySeed("glaucoma_suspect_open_angle_high", "Open angle with borderline findings, high risk", "glaucoma-suspect", "H40.02-", glaucoma, provenance),
    familySeed("ocular_hypertension", "Ocular hypertension", "ocular-hypertension", "H40.05-", glaucoma, provenance),
    familySeed("preglaucoma_unspecified", "Preglaucoma, unspecified", "glaucoma-suspect", "H40.00-", glaucoma, provenance),
    familySeed("anatomical_narrow_angle", "Anatomical narrow angle", "anatomical-narrow-angle", "H40.03-", glaucoma, provenance),
    familySeed("steroid_responder", "Steroid responder", "steroid-responder", "H40.04-", glaucoma, provenance),
    familySeed("primary_angle_closure_without_damage", "Primary angle closure without glaucoma damage", "primary-angle-closure", "H40.06-", glaucoma, provenance),
    familySeed("vf_scotoma_central", "Scotoma involving central area", "visual-field-defect", "H53.41-", visualField, provenance),
    familySeed("vf_scotoma_blind_spot", "Scotoma of blind spot area", "visual-field-defect", "H53.42-", visualField, provenance),
    familySeed("vf_sector_or_arcuate", "Sector or arcuate defects", "visual-field-defect", "H53.43-", visualField, provenance),
    familySeed("vf_other_localized", "Other localized visual field defect", "visual-field-defect", "H53.45-", visualField, provenance),
    fieldSideFamilySeed("vf_homonymous_bilateral", "Homonymous bilateral field defects", "visual-field-defect", "H53.46-", visualField, provenance),
    fixedSeed("vf_heteronymous_bilateral", "Heteronymous bilateral field defects", "visual-field-defect", "H53.47", visualField, provenance),
    familySeed("vf_generalized_contraction", "Generalized contraction of visual field", "visual-field-defect", "H53.48-", visualField, provenance),
    familySeed("cataract_nuclear_sclerosis", "Age-related nuclear cataract", "cataract", "H25.1-", lens, provenance),
    familySeed("cataract_cortical", "Cortical age-related cataract", "cataract", "H25.01-", lens, provenance),
    familySeed("cataract_anterior_subcapsular", "Anterior subcapsular polar age-related cataract", "cataract", "H25.03-", lens, provenance),
    familySeed("cataract_posterior_subcapsular", "Posterior subcapsular polar age-related cataract", "cataract", "H25.04-", lens, provenance),
    familySeed("cataract_combined_forms", "Combined forms of age-related cataract", "cataract", "H25.81-", lens, provenance),
    familySeed("cataract_posterior_capsular_opacification", "Other secondary cataract", "cataract", "H26.49-", lens, provenance),
    fixedSeed("pseudoexfoliation_lens", "Pseudoexfoliation of lens capsule", "lens", "H26.8", lens, provenance),
    fixedSeed("pseudophakia", "Presence of intraocular lens", "lens", "Z96.1", lens, provenance),
    familySeed("aphakia", "Aphakia", "lens", "H27.0-", lens, provenance),
    familySeed("lens_subluxation", "Subluxation of lens", "lens", "H27.11-", lens, provenance),
    familySeed("lens_dislocation_anterior", "Anterior dislocation of lens", "lens", "H27.12-", lens, provenance),
    familySeed("lens_dislocation_posterior", "Posterior dislocation of lens", "lens", "H27.13-", lens, provenance),
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
    fixedSeed("t1_dr_unspecified_with_dme", "Type 1 diabetes with unspecified diabetic retinopathy with macular edema", "type-1-diabetic-retinopathy", "E10.311", type1DiabeticRetinopathy, provenance),
    fixedSeed("t1_dr_unspecified_without_dme", "Type 1 diabetes with unspecified diabetic retinopathy without macular edema", "type-1-diabetic-retinopathy", "E10.319", type1DiabeticRetinopathy, provenance),
    familySeed("t1_dr_mild_npdr_with_dme", "Type 1 diabetes with mild nonproliferative diabetic retinopathy with macular edema", "type-1-diabetic-retinopathy", "E10.321-", type1DiabeticRetinopathy, provenance),
    familySeed("t1_dr_mild_npdr_without_dme", "Type 1 diabetes with mild nonproliferative diabetic retinopathy without macular edema", "type-1-diabetic-retinopathy", "E10.329-", type1DiabeticRetinopathy, provenance),
    familySeed("t1_dr_moderate_npdr_with_dme", "Type 1 diabetes with moderate nonproliferative diabetic retinopathy with macular edema", "type-1-diabetic-retinopathy", "E10.331-", type1DiabeticRetinopathy, provenance),
    familySeed("t1_dr_moderate_npdr_without_dme", "Type 1 diabetes with moderate nonproliferative diabetic retinopathy without macular edema", "type-1-diabetic-retinopathy", "E10.339-", type1DiabeticRetinopathy, provenance),
    familySeed("t1_dr_severe_npdr_with_dme", "Type 1 diabetes with severe nonproliferative diabetic retinopathy with macular edema", "type-1-diabetic-retinopathy", "E10.341-", type1DiabeticRetinopathy, provenance),
    familySeed("t1_dr_severe_npdr_without_dme", "Type 1 diabetes with severe nonproliferative diabetic retinopathy without macular edema", "type-1-diabetic-retinopathy", "E10.349-", type1DiabeticRetinopathy, provenance),
    familySeed("t1_dr_pdr_with_dme", "Type 1 diabetes with proliferative diabetic retinopathy with macular edema", "type-1-diabetic-retinopathy", "E10.351-", type1DiabeticRetinopathy, provenance),
    familySeed("t1_dr_pdr_trd_involving_macula", "Type 1 diabetes with proliferative diabetic retinopathy with traction retinal detachment involving the macula", "type-1-diabetic-retinopathy", "E10.352-", type1DiabeticRetinopathy, provenance),
    familySeed("t1_dr_pdr_trd_not_involving_macula", "Type 1 diabetes with proliferative diabetic retinopathy with traction retinal detachment not involving the macula", "type-1-diabetic-retinopathy", "E10.353-", type1DiabeticRetinopathy, provenance),
    familySeed("t1_dr_pdr_combined_trd_rrd", "Type 1 diabetes with proliferative diabetic retinopathy with combined traction and rhegmatogenous retinal detachment", "type-1-diabetic-retinopathy", "E10.354-", type1DiabeticRetinopathy, provenance),
    familySeed("t1_dr_stable_pdr", "Type 1 diabetes with stable proliferative diabetic retinopathy", "type-1-diabetic-retinopathy", "E10.355-", type1DiabeticRetinopathy, provenance),
    familySeed("t1_dr_pdr_without_dme", "Type 1 diabetes with proliferative diabetic retinopathy without macular edema", "type-1-diabetic-retinopathy", "E10.359-", type1DiabeticRetinopathy, provenance),
    fixedSeed("diplopia", "Diplopia", "diplopia", "H53.2", diplopia, provenance),
    fixedSeed("paralytic_strabismus", "Unspecified paralytic strabismus", "paralytic-strabismus", "H49.9", diplopia, provenance),
    familySeed("macular_drusen", "Drusen (degenerative) of macula", "macular-drusen", "H35.36-", ocularHealth, provenance),
    familySeed("epiretinal_membrane", "Puckering of macula (epiretinal membrane)", "epiretinal-membrane", "H35.37-", ocularHealth, provenance),
    familySeed("cystoid_macular_degeneration", "Cystoid macular degeneration", "cystoid-macular-degeneration", "H35.35-", ocularHealth, provenance),
    familySeed("macular_hole", "Macular cyst, hole, or pseudohole", "macular-hole", "H35.34-", ocularHealth, provenance),
    familySeed("subconjunctival_hemorrhage", "Conjunctival hemorrhage", "subconjunctival-hemorrhage", "H11.3-", ocularHealth, provenance),
    familySeed("conjunctivochalasis", "Conjunctivochalasis", "conjunctivochalasis", "H11.82-", ocularHealth, provenance),
    familySeed("vitreous_degeneration", "Vitreous degeneration", "vitreous-degeneration", "H43.81-", ocularHealth, provenance),
    familySeed("vitreous_hemorrhage", "Vitreous hemorrhage", "vitreous-hemorrhage", "H43.1-", ocularHealth, provenance),
    familySeed("vitreous_opacities", "Other vitreous opacities", "vitreous-opacities", "H43.39-", ocularHealth, provenance),
    familySeed("optic_disc_drusen", "Drusen of optic disc", "optic-disc-drusen", "H47.32-", ocularHealth, provenance),
    familySeed("iris_neovascularization", "Other vascular disorders of iris and ciliary body", "iris-neovascularization", "H21.1X-", ocularHealth, provenance),
    familySeed("posterior_synechiae", "Posterior synechiae (iris)", "posterior-synechiae", "H21.54-", ocularHealth, provenance),
    familySeed("lattice_degeneration", "Lattice degeneration of retina", "lattice-degeneration", "H35.41-", ocularHealth, provenance),
    familySeed("microcystoid_degeneration", "Microcystoid degeneration of retina", "microcystoid-degeneration", "H35.42-", ocularHealth, provenance),
    familySeed("paving_stone_degeneration", "Paving stone degeneration of retina", "paving-stone-degeneration", "H35.43-", ocularHealth, provenance),
    familySeed("hyphema", "Hyphema", "hyphema", "H21.0-", ocularHealth, provenance),
    familySeed("hypopyon", "Hypopyon", "hypopyon", "H20.05-", ocularHealth, provenance),
    familySeed("acute_follicular_conjunctivitis", "Acute follicular conjunctivitis", "acute-follicular-conjunctivitis", "H10.01-", ocularHealth, provenance),
    familySeed("giant_papillary_conjunctivitis", "Chronic giant papillary conjunctivitis", "giant-papillary-conjunctivitis", "H10.41-", ocularHealth, provenance),
    familySeed("anterior_scleritis", "Anterior scleritis", "anterior-scleritis", "H15.01-", ocularHealth, provenance),
    familySeed("posterior_scleritis", "Posterior scleritis", "posterior-scleritis", "H15.03-", ocularHealth, provenance),
    familySeed("nodular_episcleritis", "Nodular episcleritis", "nodular-episcleritis", "H15.12-", ocularHealth, provenance),
    familySeed("episcleritis_periodica_fugax", "Episcleritis periodica fugax", "episcleritis-periodica-fugax", "H15.11-", ocularHealth, provenance),
    familySeed("third_nerve_palsy", "Third [oculomotor] nerve palsy", "third-nerve-palsy", "H49.0-", ocularHealth, provenance),
    familySeed("fourth_nerve_palsy", "Fourth [trochlear] nerve palsy", "fourth-nerve-palsy", "H49.1-", ocularHealth, provenance),
    familySeed("sixth_nerve_palsy", "Sixth [abducent] nerve palsy", "sixth-nerve-palsy", "H49.2-", ocularHealth, provenance),
    familySeed("poag_mild", "Primary open-angle glaucoma, mild stage", "primary-open-angle-glaucoma", "H40.11-mild", ocularHealth, provenance),
    familySeed("poag_moderate", "Primary open-angle glaucoma, moderate stage", "primary-open-angle-glaucoma", "H40.11-moderate", ocularHealth, provenance),
    familySeed("poag_severe", "Primary open-angle glaucoma, severe stage", "primary-open-angle-glaucoma", "H40.11-severe", ocularHealth, provenance),
    familySeed("poag_indeterminate", "Primary open-angle glaucoma, indeterminate stage", "primary-open-angle-glaucoma", "H40.11-indeterminate", ocularHealth, provenance),
    familySeed("low_tension_glaucoma_mild", "Low-tension glaucoma, mild stage", "low-tension-glaucoma", "H40.12-mild", ocularHealth, provenance),
    familySeed("low_tension_glaucoma_moderate", "Low-tension glaucoma, moderate stage", "low-tension-glaucoma", "H40.12-moderate", ocularHealth, provenance),
    familySeed("low_tension_glaucoma_severe", "Low-tension glaucoma, severe stage", "low-tension-glaucoma", "H40.12-severe", ocularHealth, provenance),
    familySeed("low_tension_glaucoma_indeterminate", "Low-tension glaucoma, indeterminate stage", "low-tension-glaucoma", "H40.12-indeterminate", ocularHealth, provenance),
    familySeed("dry_amd_early", "Nonexudative AMD, early dry stage", "nonexudative-amd", "H35.31-early", ocularHealth, provenance),
    familySeed("dry_amd_intermediate", "Nonexudative AMD, intermediate dry stage", "nonexudative-amd", "H35.31-intermediate", ocularHealth, provenance),
    familySeed("dry_amd_advanced_atrophic_without_subfoveal", "Nonexudative AMD, advanced atrophic without subfoveal involvement", "nonexudative-amd", "H35.31-advanced_atrophic_without_subfoveal", ocularHealth, provenance),
    familySeed("dry_amd_advanced_atrophic_with_subfoveal", "Nonexudative AMD, advanced atrophic with subfoveal involvement", "nonexudative-amd", "H35.31-advanced_atrophic_with_subfoveal", ocularHealth, provenance),
    familySeed("wet_amd_active_cnv", "Exudative AMD, with active choroidal neovascularization", "exudative-amd", "H35.32-active_cnv", ocularHealth, provenance),
    familySeed("wet_amd_inactive_cnv", "Exudative AMD, with inactive choroidal neovascularization", "exudative-amd", "H35.32-inactive_cnv", ocularHealth, provenance),
    familySeed("wet_amd_inactive_scar", "Exudative AMD, with inactive scar", "exudative-amd", "H35.32-inactive_scar", ocularHealth, provenance),
    familySeed("pathological_myopia", "Pathological myopia (degenerative)", "pathological-myopia", "H44.2-", ocularHealth, provenance),
    familySeed("pathological_myopia_cnv", "Pathological myopia with choroidal neovascularization", "pathological-myopia-cnv", "H44.2A-", ocularHealth, provenance),
    familySeed("pathological_myopia_macular_hole", "Pathological myopia with macular hole", "pathological-myopia-macular-hole", "H44.2B-", ocularHealth, provenance),
    familySeed("pathological_myopia_retinal_detachment", "Pathological myopia with retinal detachment", "pathological-myopia-retinal-detachment", "H44.2C-", ocularHealth, provenance),
    familySeed("pathological_myopia_foveoschisis", "Pathological myopia with foveoschisis", "pathological-myopia-foveoschisis", "H44.2D-", ocularHealth, provenance),
    familySeed("pathological_myopia_other_maculopathy", "Pathological myopia with other maculopathy (myopic macular degeneration)", "pathological-myopia-other-maculopathy", "H44.2E-", ocularHealth, provenance),
    familySeed("t2_dr_dme_resolved", "Type 2 diabetes with diabetic macular edema, resolved following treatment", "diabetic-retinopathy", "E11.37X-", ocularHealth, provenance),
    familySeed("t1_dr_dme_resolved", "Type 1 diabetes with diabetic macular edema, resolved following treatment", "type-1-diabetic-retinopathy", "E10.37X-", ocularHealth, provenance),
    familySeed("chronic_follicular_conjunctivitis", "Chronic follicular conjunctivitis", "chronic-follicular-conjunctivitis", "H10.43-", ocularHealth, provenance),
    fixedSeed("demodex_infestation", "Infestation by Demodex mites", "demodex-infestation", "B88.01", ocularHealth, provenance),
  ];
  validateFamilyResolutionModes(seeds);
  return seeds;
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
      right: matches.find((row) => row.laterality === "OD_BOTH_LIDS")?.code,
      left: matches.find((row) => row.laterality === "OS_BOTH_LIDS")?.code,
    },
  };
  const right = matches.find((row) => row.laterality === "OD_BOTH_LIDS");
  if (!right || !icd10.pattern.right || !icd10.pattern.left) {
    throw new Error(`Verified diagnosis family ${family} is incomplete in its Phase 0 ledger.`);
  }
  return baseSeed({
    stableKey,
    display,
    clinicalFamily,
    icd10Family: family,
    icd10Code: right.code,
    icd10Display: right.display,
    lateralityRequired: true,
    icd10,
    bilateralResolution: "emit-both-eyes",
    provenance: { ...provenance, ledgerRefs: [...new Set(matches.flatMap((row) => row.sourceRefs))] },
  });
}

function fieldSideFamilySeed(
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
      unspecifiedEye: matches.find((row) => row.laterality === "FIELD_UNKNOWN")?.code,
      right: matches.find((row) => row.laterality === "FIELD_RIGHT")?.code,
      left: matches.find((row) => row.laterality === "FIELD_LEFT")?.code,
    },
  };
  const unspecified = matches.find((row) => row.laterality === "FIELD_UNKNOWN") ?? matches[0];
  if (!unspecified || Object.values(icd10.pattern).some((code) => !code)) {
    throw new Error(`Verified diagnosis field-side family ${family} is incomplete in its Phase 0 ledger.`);
  }
  return baseSeed({
    stableKey,
    display,
    clinicalFamily,
    icd10Family: family,
    icd10Code: unspecified.code,
    icd10Display: unspecified.display,
    lateralityRequired: false,
    icd10,
    provenance: {
      ...provenance,
      ledgerRefs: [...new Set(matches.flatMap((row) => row.sourceRefs))],
      note: "For this family, right, left, and unspecified pattern slots encode visual-field side, not eye laterality; generic eye-laterality resolution uses the unspecified-side code until field-side capture exists.",
    },
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
  bilateralResolution?: DiagnosisCatalogRow["bilateralResolution"];
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
    ...(input.bilateralResolution ? { bilateralResolution: input.bilateralResolution } : {}),
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
