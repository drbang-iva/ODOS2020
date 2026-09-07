import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import type { AddressInfo } from "node:net";
import { resolve } from "node:path";
import type { Basic, Bundle, Encounter, Observation, Provenance, Resource } from "@medplum/fhirtypes";
import express from "express";
import type { PracticeRoleId } from "../src/authz/roles.js";
import {
  handleCustomSectionCaptureRequest,
} from "../src/clinical-graph/custom-section-endpoint.js";
import { handleCupDiscCaptureRequest } from "../src/clinical-graph/cup-disc-endpoint.js";
import {
  handleDiagnosisCandidatesRequest,
  orderDiagnosisCandidates,
} from "../src/clinical-graph/diagnosis-candidates-endpoint.js";
import {
  handleDiagnosisCatalogCreationRequest,
  handleDiagnosisCatalogListRequest,
  handleDiagnosisCatalogMutationRequest,
} from "../src/clinical-graph/diagnosis-catalog-endpoint.js";
import {
  DIAGNOSIS_CATALOG_WRITE_HEADERS,
  DIAGNOSIS_DEFINITION_CODE,
  DIAGNOSIS_DEFINITION_CODE_SYSTEM,
  FhirDiagnosisCatalogStore,
  buildDiagnosisCatalogSeeds,
} from "../src/clinical-graph/diagnosis-catalog-store.js";
import {
  FAMILY_RESOLUTION_MODES,
  validateFamilyResolutionModes,
  type FamilyResolutionModes,
} from "../src/clinical-graph/diagnosis-catalog-seeds.js";
import { evaluateMappingTrigger } from "../src/clinical-graph/diagnosis-mapping.js";
import {
  handleFindingDefinitionCreationRequest,
  handleFindingDefinitionMutationRequest,
} from "../src/clinical-graph/finding-definition-endpoint.js";
import {
  FINDING_DEFINITION_CODE,
  FINDING_DEFINITION_CODE_SYSTEM,
  FINDING_DEFINITION_WRITE_HEADERS,
  FhirFindingDefinitionStore,
} from "../src/clinical-graph/finding-definition-store.js";
import { handleRefractionCaptureRequest } from "../src/clinical-graph/refraction-endpoint.js";
import type { FindingInstance } from "../src/clinical-graph/glaucoma-suspect.js";

const AUTH = "Bearer test";

test("every active multi-row diagnosis family declares its clinical resolution mode", () => {
  validateFamilyResolutionModes(buildDiagnosisCatalogSeeds());
  assert.deepEqual(Object.keys(FAMILY_RESOLUTION_MODES).sort(), [
    "cataract",
    "diabetic-retinopathy",
    "exudative-amd",
    "glaucoma-suspect",
    "keratoconus",
    "lens",
    "low-tension-glaucoma",
    "nonexudative-amd",
    "primary-open-angle-glaucoma",
    "pterygium",
    "retinal-break",
    "type-1-diabetic-retinopathy",
    "visual-field-defect",
  ]);
});

test("family-resolution guard fails when an active multi-row family has no declaration", () => {
  const modes = structuredClone(FAMILY_RESOLUTION_MODES) as Record<string, unknown>;
  delete modes.lens;
  assert.throws(
    () => validateFamilyResolutionModes(buildDiagnosisCatalogSeeds(), modes as FamilyResolutionModes),
    /Family resolution mode missing for active multi-row family lens\./,
  );
});

test("family-resolution guard fails when a staged member is not an active catalog row", () => {
  const modes = structuredClone(FAMILY_RESOLUTION_MODES) as Record<string, any>;
  modes["primary-open-angle-glaucoma"].members[0].stableKey = "poag_missing";
  assert.throws(
    () => validateFamilyResolutionModes(buildDiagnosisCatalogSeeds(), modes as FamilyResolutionModes),
    /Staged member poag_missing does not exist as an active diagnosis catalog row\./,
  );
});

test("family-resolution guard fails when a staged member belongs to another clinical family", () => {
  const catalog = buildDiagnosisCatalogSeeds();
  const member = catalog.find((row) => row.stableKey === "poag_mild")!;
  member.clinicalFamily = "low-tension-glaucoma";
  assert.throws(
    () => validateFamilyResolutionModes(catalog),
    /Staged member poag_mild belongs to low-tension-glaucoma, not primary-open-angle-glaucoma\./,
  );
});

test("family-resolution guard rejects unspecified stage labels", () => {
  const modes = structuredClone(FAMILY_RESOLUTION_MODES) as Record<string, any>;
  modes["primary-open-angle-glaucoma"].members[0].stageLabel = "Unspecified";
  assert.throws(
    () => validateFamilyResolutionModes(buildDiagnosisCatalogSeeds(), modes as FamilyResolutionModes),
    /Stage label Unspecified for poag_mild must not contain unspecified\./,
  );
});

test("family-resolution guard rejects an undeclared active member inside a staged family", () => {
  const catalog = buildDiagnosisCatalogSeeds();
  const member = catalog.find((row) => row.stableKey === "poag_mild")!;
  catalog.push({
    ...member,
    stableKey: "poag_new_stage",
    display: "Primary open-angle glaucoma, new stage",
  });
  assert.throws(
    () => validateFamilyResolutionModes(catalog),
    /Staged family primary-open-angle-glaucoma has active catalog member poag_new_stage that is not declared\./,
  );
});

test("family-resolution guard rejects candidate family groups the specificity panel cannot stage", () => {
  assert.throws(
    () => validateFamilyResolutionModes(buildDiagnosisCatalogSeeds(), FAMILY_RESOLUTION_MODES, ["lens"]),
    /Diagnosis candidate familyGroup lens must reference a staged family resolution mode\./,
  );
});

class MemoryFhir {
  readonly resources: Resource[] = [];
  readonly writes: Array<{ operation: "create" | "update"; resourceType: string; id: string; headers?: Record<string, string> }> = [];
  readonly versions = new Map<string, Resource[]>();

  async search<T extends Resource>(resourceType: T["resourceType"], params: Record<string, string> = {}): Promise<Bundle<T>> {
    const resources = this.resources.filter((resource) => resource.resourceType === resourceType).filter((resource) => {
      if (resourceType === "Basic" && params.code) {
        const basic = resource as Basic;
        return basic.code?.coding?.some((coding) => `${coding.system}|${coding.code}` === params.code);
      }
      if (resourceType === "Observation" && params.encounter) {
        return (resource as Observation).encounter?.reference === params.encounter;
      }
      return true;
    });
    return { resourceType: "Bundle", type: "searchset", entry: resources.map((resource) => ({ resource: resource as T })) };
  }

  async create<T extends Resource>(resource: T, headers?: Record<string, string>): Promise<T> {
    const id = resource.id ?? `${resource.resourceType.toLowerCase()}-${this.resources.length + 1}`;
    const persisted = { ...resource, id, meta: { ...(resource.meta ?? {}), versionId: "1", lastUpdated: "2026-07-11T12:00:00.000Z" } } as T;
    this.resources.push(persisted);
    this.writes.push({ operation: "create", resourceType: resource.resourceType, id, headers });
    this.versions.set(`${resource.resourceType}/${id}`, [structuredClone(persisted)]);
    return structuredClone(persisted);
  }

  async read<T extends Resource>(resourceType: T["resourceType"], id: string): Promise<T> {
    if (resourceType === "Encounter" && id === "e1") {
      return {
        resourceType: "Encounter", id, status: "in-progress", class: { code: "AMB" },
        subject: { reference: "Patient/p1" },
      } as Encounter as T;
    }
    const resource = this.resources.find((candidate) => candidate.resourceType === resourceType && candidate.id === id);
    if (!resource) throw new Error(`Missing ${resourceType}/${id}`);
    return structuredClone(resource) as T;
  }

  async update<T extends Resource>(resourceType: T["resourceType"], id: string, resource: T, headers?: Record<string, string>): Promise<T> {
    const index = this.resources.findIndex((candidate) => candidate.resourceType === resourceType && candidate.id === id);
    if (index < 0) throw new Error(`Missing ${resourceType}/${id}`);
    const history = this.versions.get(`${resourceType}/${id}`) ?? [];
    const persisted = { ...resource, id, meta: { ...(resource.meta ?? {}), versionId: String(history.length + 1), lastUpdated: `2026-07-11T12:0${history.length}:00.000Z` } } as T;
    this.resources[index] = persisted;
    history.push(structuredClone(persisted));
    this.versions.set(`${resourceType}/${id}`, history);
    this.writes.push({ operation: "update", resourceType, id, headers });
    return structuredClone(persisted);
  }
}

test("diagnosis catalog seeds are ledger-backed durable families and survive a store restart", async () => {
  const fhir = new MemoryFhir();
  const seeds = buildDiagnosisCatalogSeeds();
  assert.deepEqual(seeds.map((row) => row.stableKey), [
    "glaucoma_suspect_open_angle_low",
    "glaucoma_suspect_open_angle_high",
    "ocular_hypertension",
    "preglaucoma_unspecified",
    "anatomical_narrow_angle",
    "steroid_responder",
    "primary_angle_closure_without_damage",
    "vf_scotoma_central",
    "vf_scotoma_blind_spot",
    "vf_sector_or_arcuate",
    "vf_other_localized",
    "vf_homonymous_bilateral",
    "vf_heteronymous_bilateral",
    "vf_generalized_contraction",
    "cataract_nuclear_sclerosis",
    "cataract_cortical",
    "cataract_anterior_subcapsular",
    "cataract_posterior_subcapsular",
    "cataract_combined_forms",
    "cataract_posterior_capsular_opacification",
    "pseudoexfoliation_lens",
    "pseudophakia",
    "aphakia",
    "lens_subluxation",
    "lens_dislocation_anterior",
    "lens_dislocation_posterior",
    "hyperopia",
    "myopia",
    "astigmatism",
    "anisometropia",
    "presbyopia",
    "kcs_not_sjogren",
    "dry_eye_syndrome",
    "pinguecula",
    "hypertensive_retinopathy",
    "keratoconus_stable",
    "keratoconus_unstable",
    "keratoconus_unspecified_stability",
    "ulcerative_blepharitis",
    "squamous_blepharitis",
    "meibomian_gland_dysfunction",
    "pterygium_central",
    "pterygium_peripheral_stationary",
    "pterygium_peripheral_progressive",
    "pterygium_recurrent",
    "retinal_horseshoe_tear",
    "retinal_round_hole",
    "retinoschisis",
    "retinal_detachment_single_break",
    "t2_dr_unspecified_with_dme",
    "t2_dr_unspecified_without_dme",
    "t2_dr_mild_npdr_with_dme",
    "t2_dr_mild_npdr_without_dme",
    "t2_dr_moderate_npdr_with_dme",
    "t2_dr_moderate_npdr_without_dme",
    "t2_dr_severe_npdr_with_dme",
    "t2_dr_severe_npdr_without_dme",
    "t2_dr_pdr_with_dme",
    "t2_dr_pdr_trd_involving_macula",
    "t2_dr_pdr_trd_not_involving_macula",
    "t2_dr_pdr_combined_trd_rrd",
    "t2_dr_stable_pdr",
    "t2_dr_pdr_without_dme",
    "t2_diabetes_without_complications",
    "t2_diabetes_other_ophthalmic_complication",
    "t1_dr_unspecified_with_dme",
    "t1_dr_unspecified_without_dme",
    "t1_dr_mild_npdr_with_dme",
    "t1_dr_mild_npdr_without_dme",
    "t1_dr_moderate_npdr_with_dme",
    "t1_dr_moderate_npdr_without_dme",
    "t1_dr_severe_npdr_with_dme",
    "t1_dr_severe_npdr_without_dme",
    "t1_dr_pdr_with_dme",
    "t1_dr_pdr_trd_involving_macula",
    "t1_dr_pdr_trd_not_involving_macula",
    "t1_dr_pdr_combined_trd_rrd",
    "t1_dr_stable_pdr",
    "t1_dr_pdr_without_dme",
    "diplopia",
    "paralytic_strabismus",
    "macular_drusen",
    "epiretinal_membrane",
    "cystoid_macular_degeneration",
    "macular_hole",
    "cme_following_cataract_surgery",
    "retinal_edema",
    "subconjunctival_hemorrhage",
    "conjunctivochalasis",
    "vitreous_degeneration",
    "vitreous_hemorrhage",
    "vitreous_opacities",
    "optic_disc_drusen",
    "iris_neovascularization",
    "posterior_synechiae",
    "lattice_degeneration",
    "microcystoid_degeneration",
    "paving_stone_degeneration",
    "hyphema",
    "hypopyon",
    "acute_follicular_conjunctivitis",
    "giant_papillary_conjunctivitis",
    "anterior_scleritis",
    "posterior_scleritis",
    "nodular_episcleritis",
    "episcleritis_periodica_fugax",
    "third_nerve_palsy",
    "fourth_nerve_palsy",
    "sixth_nerve_palsy",
    "poag_mild",
    "poag_moderate",
    "poag_severe",
    "poag_indeterminate",
    "low_tension_glaucoma_mild",
    "low_tension_glaucoma_moderate",
    "low_tension_glaucoma_severe",
    "low_tension_glaucoma_indeterminate",
    "dry_amd_early",
    "dry_amd_intermediate",
    "dry_amd_advanced_atrophic_without_subfoveal",
    "dry_amd_advanced_atrophic_with_subfoveal",
    "wet_amd_active_cnv",
    "wet_amd_inactive_cnv",
    "wet_amd_inactive_scar",
    "pathological_myopia",
    "pathological_myopia_cnv",
    "pathological_myopia_macular_hole",
    "pathological_myopia_retinal_detachment",
    "pathological_myopia_foveoschisis",
    "pathological_myopia_other_maculopathy",
    "t2_dr_dme_resolved",
    "t1_dr_dme_resolved",
    "chronic_follicular_conjunctivitis",
    "demodex_infestation",
  ]);
  assert.deepEqual((seeds.find((row) => row.stableKey === "myopia")?.icd10 as { pattern: object }).pattern, {
    unspecifiedEye: "H52.10",
    right: "H52.11",
    left: "H52.12",
    bilateral: "H52.13",
  });
  const ulcerative = seeds.find((row) => row.stableKey === "ulcerative_blepharitis");
  assert.equal(ulcerative?.codingStatus, "verified");
  assert.deepEqual(ulcerative?.provenance.ledgerRefs, [
    "cdcIcd10Cm2026CodeDescriptions",
    "nlmClinicalTablesIcd10Cm",
  ]);
  const diabeticRetinopathySeeds = seeds.filter((row) => row.clinicalFamily === "diabetic-retinopathy");
  assert.equal(diabeticRetinopathySeeds.every((row) => row.id.length <= 64), true);
  assert.equal(diabeticRetinopathySeeds.every((row) => row.icd10Code?.startsWith("E11.3")), true);
  const mildWithEdema = seeds.find((row) => row.stableKey === "t2_dr_mild_npdr_with_dme");
  assert.deepEqual((mildWithEdema?.icd10 as { pattern: object }).pattern, {
    unspecifiedEye: "E11.3219",
    right: "E11.3211",
    left: "E11.3212",
    bilateral: "E11.3213",
  });
  assert.equal(mildWithEdema?.codingStatus, "verified");
  assert.equal(mildWithEdema?.lateralityRequired, true);
  const unspecifiedWithoutEdema = seeds.find((row) => row.stableKey === "t2_dr_unspecified_without_dme");
  assert.deepEqual(unspecifiedWithoutEdema?.icd10, {
    code: "E11.319",
    display: "Type 2 diabetes mellitus with unspecified diabetic retinopathy without macular edema",
  });
  assert.equal(unspecifiedWithoutEdema?.lateralityRequired, false);
  seeds[0]!.display = "Mutated caller copy";
  assert.equal(buildDiagnosisCatalogSeeds()[0]?.display, "Open angle with borderline findings, low risk");
  const practice = {
    ...seeds[0]!,
    id: "diagnosis-def-practice-kcs",
    stableKey: "custom:kcs",
    display: "Keratoconjunctivitis sicca",
    clinicalFamily: "ocular-surface",
    icd10: undefined,
    icd10Code: undefined,
    icd10Display: undefined,
    codingStatus: "provisional" as const,
    lateralityRequired: false,
    origin: "practice" as const,
  };
  await new FhirDiagnosisCatalogStore(fhir).save(practice);
  const restarted = new FhirDiagnosisCatalogStore(fhir);
  assert.equal((await restarted.list()).find((row) => row.stableKey === "custom:kcs")?.codingStatus, "provisional");
  assert.deepEqual(fhir.writes[0]?.headers, DIAGNOSIS_CATALOG_WRITE_HEADERS);
});

test("dry eye syndrome and Type 2 non-retinopathy concepts are distinct verified catalog rows", () => {
  const stableKeys = [
    "dry_eye_syndrome",
    "t2_diabetes_without_complications",
    "t2_diabetes_other_ophthalmic_complication",
  ];
  const rows = buildDiagnosisCatalogSeeds()
    .filter((row) => stableKeys.includes(row.stableKey))
    .map((row) => ({
      stableKey: row.stableKey,
      display: row.display,
      clinicalFamily: row.clinicalFamily,
      lateralityRequired: row.lateralityRequired,
      icd10: row.icd10,
      ledgerRefs: row.provenance.ledgerRefs,
    }));

  assert.deepEqual(rows, [
    {
      stableKey: "dry_eye_syndrome",
      display: "Dry eye syndrome",
      clinicalFamily: "dry-eye-syndrome",
      lateralityRequired: true,
      icd10: {
        pattern: {
          unspecifiedEye: "H04.129",
          right: "H04.121",
          left: "H04.122",
          bilateral: "H04.123",
        },
      },
      ledgerRefs: ["cdcIcd10Cm2026CodeDescriptions", "nlmClinicalTablesIcd10Cm"],
    },
    {
      stableKey: "t2_diabetes_without_complications",
      display: "Type 2 diabetes mellitus without complications",
      clinicalFamily: "type-2-diabetes-without-complications",
      lateralityRequired: false,
      icd10: {
        code: "E11.9",
        display: "Type 2 diabetes mellitus without complications",
      },
      ledgerRefs: ["cdcIcd10Cm2026CodeDescriptions", "nlmClinicalTablesIcd10Cm"],
    },
    {
      stableKey: "t2_diabetes_other_ophthalmic_complication",
      display: "Type 2 diabetes mellitus with other diabetic ophthalmic complication",
      clinicalFamily: "type-2-diabetes-other-ophthalmic-complication",
      lateralityRequired: false,
      icd10: {
        code: "E11.39",
        display: "Type 2 diabetes mellitus with other diabetic ophthalmic complication",
      },
      ledgerRefs: ["cdcIcd10Cm2026CodeDescriptions", "nlmClinicalTablesIcd10Cm"],
    },
  ]);

  const kcs = buildDiagnosisCatalogSeeds().find((row) => row.stableKey === "kcs_not_sjogren");
  assert.notEqual(rows[0]?.stableKey, kcs?.stableKey);
  assert.notEqual(rows[0]?.clinicalFamily, kcs?.clinicalFamily);
});

test("ocular-health dry eye amendment dates only the four newly verified rows", () => {
  const ledger = JSON.parse(readFileSync(
    resolve(process.cwd(), "../data/code-bindings/ocular-health-phase0-ledger.json"),
    "utf8",
  )) as {
    accessDate: string;
    scope: string;
    amendments?: Array<{
      accessDate: string;
      scopeDelta: string;
      codesAdded: string[];
      sourceRefs: string[];
    }>;
    diagnosisCodes: Array<{
      code: string;
      display: string;
      family: string;
      laterality: string;
      sourceRefs: string[];
    }>;
  };

  assert.equal(ledger.accessDate, "2026-08-10");
  assert.match(ledger.scope, /dry eye syndrome \(H04\.12-\)/);
  assert.deepEqual(ledger.amendments?.filter((row) => row.scopeDelta.includes("dry eye syndrome")), [{
    accessDate: "2026-08-17",
    scopeDelta: "Added dry eye syndrome (H04.12-) diagnosis catalog family.",
    codesAdded: ["H04.121", "H04.122", "H04.123", "H04.129"],
    sourceRefs: ["cdcIcd10Cm2026CodeDescriptions", "nlmClinicalTablesIcd10Cm"],
  }]);
  assert.deepEqual(
    ledger.diagnosisCodes.filter((row) => row.family === "H04.12-"),
    [
      { code: "H04.121", display: "Dry eye syndrome of right lacrimal gland", family: "H04.12-", laterality: "OD", sourceRefs: ["cdcIcd10Cm2026CodeDescriptions", "nlmClinicalTablesIcd10Cm"] },
      { code: "H04.122", display: "Dry eye syndrome of left lacrimal gland", family: "H04.12-", laterality: "OS", sourceRefs: ["cdcIcd10Cm2026CodeDescriptions", "nlmClinicalTablesIcd10Cm"] },
      { code: "H04.123", display: "Dry eye syndrome of bilateral lacrimal glands", family: "H04.12-", laterality: "OU", sourceRefs: ["cdcIcd10Cm2026CodeDescriptions", "nlmClinicalTablesIcd10Cm"] },
      { code: "H04.129", display: "Dry eye syndrome of unspecified lacrimal gland", family: "H04.12-", laterality: "UNKNOWN", sourceRefs: ["cdcIcd10Cm2026CodeDescriptions", "nlmClinicalTablesIcd10Cm"] },
    ],
  );
});

test("Type 2 diabetes ledger is dual-source and carries no payer coverage claims", () => {
  const ledger = JSON.parse(readFileSync(
    resolve(process.cwd(), "../data/code-bindings/type-2-diabetes-phase0-ledger.json"),
    "utf8",
  )) as {
    ledger: string;
    status: string;
    mandate: string;
    accessDate: string;
    scope: string;
    sources: Record<string, { url: string; accessDate: string }>;
    diagnosisFamilies: Array<{ family: string; description: string; sourceRefs: string[] }>;
    diagnosisCodes: Array<{ code: string; display: string; family: string; laterality: string; sourceRefs: string[] }>;
    provisionalCoverageRules?: unknown;
  };

  const sourceRefs = ["cdcIcd10Cm2026CodeDescriptions", "nlmClinicalTablesIcd10Cm"];
  assert.equal(ledger.ledger, "type-2-diabetes-phase0");
  assert.equal(ledger.status, "phase0-seeded");
  assert.equal(ledger.mandate, "Mandate 14");
  assert.equal(ledger.accessDate, "2026-08-17");
  assert.match(ledger.scope, /No payer coverage rules are declared\.$/);
  assert.deepEqual(Object.keys(ledger.sources), sourceRefs);
  assert.equal(Object.values(ledger.sources).every((source) => source.url.startsWith("https://") && source.accessDate.length === 10), true);
  assert.deepEqual(ledger.diagnosisFamilies, [
    { family: "E11.9", description: "Type 2 diabetes mellitus without complications", sourceRefs },
    { family: "E11.39", description: "Type 2 diabetes mellitus with other diabetic ophthalmic complication", sourceRefs },
  ]);
  assert.deepEqual(ledger.diagnosisCodes, [
    { code: "E11.9", display: "Type 2 diabetes mellitus without complications", family: "E11.9", laterality: "UNKNOWN", sourceRefs },
    { code: "E11.39", display: "Type 2 diabetes mellitus with other diabetic ophthalmic complication", family: "E11.39", laterality: "UNKNOWN", sourceRefs },
  ]);
  assert.equal(ledger.diagnosisCodes.every((row) => row.sourceRefs.length === 2), true);
  assert.equal(ledger.provisionalCoverageRules, undefined);
});

test("Wave A diagnosis families resolve every verified laterality code", () => {
  const seeds = buildDiagnosisCatalogSeeds();
  const expected = {
    macular_drusen: ["H35.361", "H35.362", "H35.363", "H35.369"],
    epiretinal_membrane: ["H35.371", "H35.372", "H35.373", "H35.379"],
    cystoid_macular_degeneration: ["H35.351", "H35.352", "H35.353", "H35.359"],
    macular_hole: ["H35.341", "H35.342", "H35.343", "H35.349"],
    subconjunctival_hemorrhage: ["H11.31", "H11.32", "H11.33", "H11.30"],
    conjunctivochalasis: ["H11.821", "H11.822", "H11.823", "H11.829"],
    vitreous_degeneration: ["H43.811", "H43.812", "H43.813", "H43.819"],
    vitreous_hemorrhage: ["H43.11", "H43.12", "H43.13", "H43.10"],
    vitreous_opacities: ["H43.391", "H43.392", "H43.393", "H43.399"],
    optic_disc_drusen: ["H47.321", "H47.322", "H47.323", "H47.329"],
    iris_neovascularization: ["H21.1X1", "H21.1X2", "H21.1X3", "H21.1X9"],
    posterior_synechiae: ["H21.541", "H21.542", "H21.543", "H21.549"],
    lattice_degeneration: ["H35.411", "H35.412", "H35.413", "H35.419"],
    microcystoid_degeneration: ["H35.421", "H35.422", "H35.423", "H35.429"],
    paving_stone_degeneration: ["H35.431", "H35.432", "H35.433", "H35.439"],
    hyphema: ["H21.01", "H21.02", "H21.03", "H21.00"],
    hypopyon: ["H20.051", "H20.052", "H20.053", "H20.059"],
    acute_follicular_conjunctivitis: ["H10.011", "H10.012", "H10.013", "H10.019"],
    giant_papillary_conjunctivitis: ["H10.411", "H10.412", "H10.413", "H10.419"],
    anterior_scleritis: ["H15.011", "H15.012", "H15.013", "H15.019"],
    posterior_scleritis: ["H15.031", "H15.032", "H15.033", "H15.039"],
    nodular_episcleritis: ["H15.121", "H15.122", "H15.123", "H15.129"],
    episcleritis_periodica_fugax: ["H15.111", "H15.112", "H15.113", "H15.119"],
    third_nerve_palsy: ["H49.01", "H49.02", "H49.03", "H49.00"],
    fourth_nerve_palsy: ["H49.11", "H49.12", "H49.13", "H49.10"],
    sixth_nerve_palsy: ["H49.21", "H49.22", "H49.23", "H49.20"],
  } as const;

  for (const [stableKey, [right, left, bilateral, unspecifiedEye]] of Object.entries(expected)) {
    const seed = seeds.find((row) => row.stableKey === stableKey);
    assert.ok(seed, `Missing Wave A diagnosis catalog seed ${stableKey}`);
    assert.deepEqual(seed.icd10, { pattern: { unspecifiedEye, right, left, bilateral } });
    assert.equal(seed.lateralityRequired, true);
    assert.deepEqual(seed.provenance.ledgerRefs, [
      "cdcIcd10Cm2026CodeDescriptions",
      "nlmClinicalTablesIcd10Cm",
    ]);
  }

  const demodex = seeds.find((row) => row.stableKey === "demodex_infestation");
  assert.ok(demodex, "Missing Wave A diagnosis catalog seed demodex_infestation");
  assert.deepEqual(demodex.icd10, { code: "B88.01", display: "Infestation by Demodex mites" });
  assert.equal(demodex.lateralityRequired, false);
  assert.deepEqual(demodex.provenance.ledgerRefs, [
    "cdcIcd10Cm2026CodeDescriptions",
    "nlmClinicalTablesIcd10Cm",
  ]);
});

test("Macula edema catalog additions are backed by the two ruled FY2026 primary sources", () => {
  const ledger = JSON.parse(readFileSync(
    resolve(process.cwd(), "../data/code-bindings/ocular-health-phase0-ledger.json"),
    "utf8",
  )) as {
    accessDate: string;
    sources: Record<string, { url: string; accessDate: string }>;
    amendments?: Array<{ accessDate: string; codesAdded: string[]; sourceRefs: string[] }>;
    diagnosisCodes: Array<{ code: string; display: string; family: string; laterality: string; sourceRefs: string[] }>;
  };
  const sourceRefs = ["cmsIcd10CmFy2026MsDrgV43", "cdcIcd10Cm2026CodeDescriptions"];
  assert.equal(ledger.sources.cmsIcd10CmFy2026MsDrgV43?.url, "https://www.cms.gov/icd10m/FY2026-fr-v43-fullcode-cms/fullcode_cms/P0460.html");
  assert.equal(ledger.sources.cmsIcd10CmFy2026MsDrgV43?.accessDate, "2026-09-07");
  assert.deepEqual(ledger.amendments?.at(-1), {
    accessDate: "2026-09-07",
    scopeDelta: "Added post-cataract cystoid macular edema (H59.03-) and retinal edema (H35.81).",
    codesAdded: ["H59.031", "H59.032", "H59.033", "H59.039", "H35.81"],
    sourceRefs,
  });
  assert.deepEqual(ledger.diagnosisCodes.filter((row) =>
    row.family === "H59.03-" || row.family === "H35.81"
  ), [
    { code: "H59.031", display: "Cystoid macular edema following cataract surgery, right eye", family: "H59.03-", laterality: "OD", sourceRefs },
    { code: "H59.032", display: "Cystoid macular edema following cataract surgery, left eye", family: "H59.03-", laterality: "OS", sourceRefs },
    { code: "H59.033", display: "Cystoid macular edema following cataract surgery, bilateral", family: "H59.03-", laterality: "OU", sourceRefs },
    { code: "H59.039", display: "Cystoid macular edema following cataract surgery, unspecified eye", family: "H59.03-", laterality: "UNKNOWN", sourceRefs },
    { code: "H35.81", display: "Retinal edema", family: "H35.81", laterality: "NONE", sourceRefs },
  ]);

  const seeds = buildDiagnosisCatalogSeeds();
  const cme = seeds.find((row) => row.stableKey === "cme_following_cataract_surgery");
  const edema = seeds.find((row) => row.stableKey === "retinal_edema");
  assert.deepEqual(cme?.icd10, {
    pattern: { unspecifiedEye: "H59.039", right: "H59.031", left: "H59.032", bilateral: "H59.033" },
  });
  assert.equal(cme?.lateralityRequired, true);
  assert.deepEqual(edema?.icd10, { code: "H35.81", display: "Retinal edema" });
  assert.equal(edema?.lateralityRequired, false);
  for (const seed of [cme, edema]) {
    assert.equal(seed?.codingStatus, "verified");
    assert.deepEqual(seed?.provenance.ledgerRefs, sourceRefs);
  }
});

test("Wave B diagnosis families resolve every verified laterality code", () => {
  const seeds = buildDiagnosisCatalogSeeds();
  const expected = {
    poag_mild: ["H40.1111", "H40.1121", "H40.1131", "H40.1191"],
    poag_moderate: ["H40.1112", "H40.1122", "H40.1132", "H40.1192"],
    poag_severe: ["H40.1113", "H40.1123", "H40.1133", "H40.1193"],
    poag_indeterminate: ["H40.1114", "H40.1124", "H40.1134", "H40.1194"],
    low_tension_glaucoma_mild: ["H40.1211", "H40.1221", "H40.1231", "H40.1291"],
    low_tension_glaucoma_moderate: ["H40.1212", "H40.1222", "H40.1232", "H40.1292"],
    low_tension_glaucoma_severe: ["H40.1213", "H40.1223", "H40.1233", "H40.1293"],
    low_tension_glaucoma_indeterminate: ["H40.1214", "H40.1224", "H40.1234", "H40.1294"],
    dry_amd_early: ["H35.3111", "H35.3121", "H35.3131", "H35.3191"],
    dry_amd_intermediate: ["H35.3112", "H35.3122", "H35.3132", "H35.3192"],
    dry_amd_advanced_atrophic_without_subfoveal: ["H35.3113", "H35.3123", "H35.3133", "H35.3193"],
    dry_amd_advanced_atrophic_with_subfoveal: ["H35.3114", "H35.3124", "H35.3134", "H35.3194"],
    wet_amd_active_cnv: ["H35.3211", "H35.3221", "H35.3231", "H35.3291"],
    wet_amd_inactive_cnv: ["H35.3212", "H35.3222", "H35.3232", "H35.3292"],
    wet_amd_inactive_scar: ["H35.3213", "H35.3223", "H35.3233", "H35.3293"],
    pathological_myopia: ["H44.21", "H44.22", "H44.23", "H44.20"],
    pathological_myopia_cnv: ["H44.2A1", "H44.2A2", "H44.2A3", "H44.2A9"],
    pathological_myopia_macular_hole: ["H44.2B1", "H44.2B2", "H44.2B3", "H44.2B9"],
    pathological_myopia_retinal_detachment: ["H44.2C1", "H44.2C2", "H44.2C3", "H44.2C9"],
    pathological_myopia_foveoschisis: ["H44.2D1", "H44.2D2", "H44.2D3", "H44.2D9"],
    pathological_myopia_other_maculopathy: ["H44.2E1", "H44.2E2", "H44.2E3", "H44.2E9"],
    t2_dr_dme_resolved: ["E11.37X1", "E11.37X2", "E11.37X3", "E11.37X9"],
    chronic_follicular_conjunctivitis: ["H10.431", "H10.432", "H10.433", "H10.439"],
  } as const;

  for (const [stableKey, [right, left, bilateral, unspecifiedEye]] of Object.entries(expected)) {
    const seed = seeds.find((row) => row.stableKey === stableKey);
    assert.ok(seed, `Missing Wave B diagnosis catalog seed ${stableKey}`);
    assert.deepEqual(
      seed.icd10,
      { pattern: { unspecifiedEye, right, left, bilateral } },
      `Wave B code pattern mismatch for ${stableKey}`,
    );
    assert.equal(seed.lateralityRequired, true);
    assert.deepEqual(seed.provenance.ledgerRefs, [
      "cdcIcd10Cm2026CodeDescriptions",
      "nlmClinicalTablesIcd10Cm",
    ]);
  }
});

test("every declared Type 1 retinopathy family resolves only to codes in its ledger", () => {
  const ledger = JSON.parse(readFileSync(
    resolve(process.cwd(), "../data/code-bindings/type-1-diabetic-retinopathy-phase0-ledger.json"),
    "utf8",
  )) as {
    diagnosisFamilies: Array<{ family: string }>;
    diagnosisCodes: Array<{ code: string; family: string }>;
  };
  const expectedFamilies = {
    t1_dr_unspecified_with_dme: "E10.311",
    t1_dr_unspecified_without_dme: "E10.319",
    t1_dr_mild_npdr_with_dme: "E10.321-",
    t1_dr_mild_npdr_without_dme: "E10.329-",
    t1_dr_moderate_npdr_with_dme: "E10.331-",
    t1_dr_moderate_npdr_without_dme: "E10.339-",
    t1_dr_severe_npdr_with_dme: "E10.341-",
    t1_dr_severe_npdr_without_dme: "E10.349-",
    t1_dr_pdr_with_dme: "E10.351-",
    t1_dr_pdr_trd_involving_macula: "E10.352-",
    t1_dr_pdr_trd_not_involving_macula: "E10.353-",
    t1_dr_pdr_combined_trd_rrd: "E10.354-",
    t1_dr_stable_pdr: "E10.355-",
    t1_dr_pdr_without_dme: "E10.359-",
  } as const;

  assert.deepEqual(ledger.diagnosisFamilies.map((row) => row.family), Object.values(expectedFamilies));
  assert.equal(ledger.diagnosisCodes.length, 50);
  const seeds = buildDiagnosisCatalogSeeds();
  for (const [stableKey, family] of Object.entries(expectedFamilies)) {
    const seed = seeds.find((row) => row.stableKey === stableKey);
    assert.ok(seed?.icd10, `Missing Type 1 diagnosis catalog seed ${stableKey}`);
    const resolvedCodes = "code" in seed.icd10
      ? [seed.icd10.code]
      : Object.values(seed.icd10.pattern).filter((code): code is string => code !== undefined).sort();
    const ledgerCodes = ledger.diagnosisCodes
      .filter((row) => row.family === family)
      .map((row) => row.code)
      .sort();
    assert.deepEqual(resolvedCodes, ledgerCodes, `Type 1 seed ${stableKey} must resolve only to ${family} ledger codes`);
  }
});

test("Type 1 resolved DME preserves the literal X family from the ocular ledger", () => {
  const ledger = JSON.parse(readFileSync(
    resolve(process.cwd(), "../data/code-bindings/ocular-health-phase0-ledger.json"),
    "utf8",
  )) as { diagnosisCodes: Array<{ code: string; family: string }> };
  const expectedCodes = ["E10.37X1", "E10.37X2", "E10.37X3", "E10.37X9"];
  const ledgerCodes = ledger.diagnosisCodes
    .filter((row) => row.family === "E10.37X-")
    .map((row) => row.code);
  assert.deepEqual(ledgerCodes, expectedCodes);

  const seed = buildDiagnosisCatalogSeeds().find((row) => row.stableKey === "t1_dr_dme_resolved");
  assert.ok(seed?.icd10 && "pattern" in seed.icd10, "Missing Type 1 resolved DME catalog seed");
  assert.deepEqual(seed.icd10.pattern, {
    unspecifiedEye: "E10.37X9",
    right: "E10.37X1",
    left: "E10.37X2",
    bilateral: "E10.37X3",
  });
});

test("Type 1 retinopathy ledger carries diagnosis provenance without coverage claims", () => {
  const ledger = JSON.parse(readFileSync(
    resolve(process.cwd(), "../data/code-bindings/type-1-diabetic-retinopathy-phase0-ledger.json"),
    "utf8",
  )) as {
    mandate: string;
    sources: Record<string, { type: string; url: string; accessDate: string }>;
    diagnosisCodes: Array<{ code: string; laterality: string; sourceRefs: string[] }>;
    provisionalCoverageRules?: unknown;
  };

  assert.equal(ledger.mandate, "Mandate 14");
  assert.equal(Object.keys(ledger.sources).length, 2);
  assert.equal(Object.values(ledger.sources).every((source) => source.url.startsWith("https://") && source.accessDate.length === 10), true);
  assert.equal(ledger.diagnosisCodes.every((row) => row.sourceRefs.length === 2), true);
  assert.equal(ledger.diagnosisCodes.filter((row) => row.code === "E10.311" || row.code === "E10.319").every((row) => row.laterality === "UNKNOWN"), true);
  assert.equal(ledger.provisionalCoverageRules, undefined);
});

test("Type 1 retinopathy catalog excludes deferred and stage-unspecified diagnoses", () => {
  const catalogCodes = new Set(buildDiagnosisCatalogSeeds().flatMap((row) =>
    row.icd10 && "code" in row.icd10
      ? [row.icd10.code]
      : Object.values(row.icd10?.pattern ?? {}).filter((code): code is string => code !== undefined)
  ));

  assert.equal(catalogCodes.has("E10.36"), false);
  assert.equal(catalogCodes.has("E10.39"), false);
  assert.equal([...catalogCodes].filter((code) => code.startsWith("E10.3")).length, 54);
});

test("Wave B catalog excludes stage-unspecified glaucoma and AMD codes", () => {
  const catalogCodes = new Set(buildDiagnosisCatalogSeeds().flatMap((row) =>
    "code" in row.icd10
      ? [row.icd10.code]
      : Object.values(row.icd10.pattern).filter((code): code is string => code !== undefined)
  ));

  for (const code of [
    "H40.1110", "H40.1120", "H40.1130", "H40.1190",
    "H40.1210", "H40.1220", "H40.1230", "H40.1290",
    "H35.3110", "H35.3120", "H35.3130", "H35.3190",
    "H35.3210", "H35.3220", "H35.3230", "H35.3290",
  ]) {
    assert.equal(catalogCodes.has(code), false, `Stage-unspecified ICD-10 code ${code} must not be seeded`);
  }
});

test("eyelid families expose only verified both-lids per-eye slots and declare bilateral expansion", () => {
  const seeds = buildDiagnosisCatalogSeeds();
  const expected = {
    ulcerative_blepharitis: ["H01.01A", "H01.01B"],
    squamous_blepharitis: ["H01.02A", "H01.02B"],
    meibomian_gland_dysfunction: ["H02.88A", "H02.88B"],
  } as const;

  for (const [stableKey, [right, left]] of Object.entries(expected)) {
    const row = seeds.find((candidate) => candidate.stableKey === stableKey);
    assert.ok(row?.icd10 && "pattern" in row.icd10, `Missing ICD-10 pattern for ${stableKey}`);
    assert.deepEqual(row.icd10.pattern, { right, left });
    assert.equal(row.bilateralResolution, "emit-both-eyes");
    assert.notEqual(row.icd10Code, "H01.019");
    assert.notEqual(row.icd10Code, "H01.029");
    assert.notEqual(row.icd10Code, "H02.889");
  }

  const ledger = JSON.parse(readFileSync(
    new URL("../../data/code-bindings/ocular-health-phase0-ledger.json", import.meta.url),
    "utf8",
  )) as { diagnosisCodes: Array<{ code: string; sourceRefs: string[] }> };
  for (const code of Object.values(expected).flat()) {
    const entry = ledger.diagnosisCodes.find((candidate) => candidate.code === code);
    assert.deepEqual(entry?.sourceRefs, [
      "cdcIcd10Cm2026CodeDescriptions",
      "nlmClinicalTablesIcd10Cm",
    ]);
  }
  for (const legacyCode of ["H01.013", "H01.016", "H01.019", "H01.023", "H01.026", "H01.029", "H02.883", "H02.886", "H02.889"]) {
    assert.ok(ledger.diagnosisCodes.some((candidate) => candidate.code === legacyCode), `${legacyCode} must remain ledger-readable`);
  }
});

test("persisted eyelid definitions cannot override the verified seed code projection", async () => {
  const fhir = new MemoryFhir();
  const current = buildDiagnosisCatalogSeeds().find((row) => row.stableKey === "meibomian_gland_dysfunction")!;
  await new FhirDiagnosisCatalogStore(fhir).save({
    ...current,
    display: "Practice MGD label",
    icd10: {
      pattern: {
        unspecifiedEye: "H02.889",
        right: "H02.883",
        left: "H02.886",
      },
    },
    icd10Code: "H02.889",
    icd10Display: "Meibomian gland dysfunction of unspecified eye, unspecified eyelid",
    bilateralResolution: undefined,
    provenance: { ...current.provenance, note: "Practice-authored note remains intact." },
  });

  const resolved = (await new FhirDiagnosisCatalogStore(fhir).list()).find((row) =>
    row.stableKey === "meibomian_gland_dysfunction"
  );

  assert.equal(resolved?.display, "Practice MGD label");
  assert.deepEqual(resolved?.icd10, { pattern: { right: "H02.88A", left: "H02.88B" } });
  assert.equal(resolved?.icd10Code, "H02.88A");
  assert.equal(resolved?.bilateralResolution, "emit-both-eyes");
  assert.equal(resolved?.provenance.note, "Practice-authored note remains intact.");
  assert.deepEqual(resolved?.provenance.ledgerRefs, current.provenance.ledgerRefs);
});

test("glaucoma laterality-only families seed all verified ledger codes", () => {
  const seeds = buildDiagnosisCatalogSeeds();
  const expected = {
    preglaucoma_unspecified: {
      unspecifiedEye: "H40.009",
      right: "H40.001",
      left: "H40.002",
      bilateral: "H40.003",
    },
    anatomical_narrow_angle: {
      unspecifiedEye: "H40.039",
      right: "H40.031",
      left: "H40.032",
      bilateral: "H40.033",
    },
    steroid_responder: {
      unspecifiedEye: "H40.049",
      right: "H40.041",
      left: "H40.042",
      bilateral: "H40.043",
    },
    primary_angle_closure_without_damage: {
      unspecifiedEye: "H40.069",
      right: "H40.061",
      left: "H40.062",
      bilateral: "H40.063",
    },
  };

  for (const [stableKey, pattern] of Object.entries(expected)) {
    const seed = seeds.find((row) => row.stableKey === stableKey);
    assert.ok(seed, `Missing diagnosis catalog seed ${stableKey}`);
    assert.deepEqual(seed.icd10, { pattern });
    assert.equal(seed.codingStatus, "verified");
    assert.equal(seed.lateralityRequired, true);
    assert.deepEqual(seed.provenance.ledgerRefs, [
      "cdcIcd10Cm2026CodeDescriptions",
      "nlmClinicalTablesIcd10Cm",
    ]);
    assert.deepEqual(seed.applicableFindingDefinitionIds, []);
  }
});

test("visual-field Phase 0 ledger and catalog seeds preserve verified code shapes", () => {
  const raw = readFileSync(
    resolve(process.cwd(), "../data/code-bindings/visual-field-phase0-ledger.json"),
    "utf8",
  );
  const ledger = JSON.parse(raw) as {
    ledger: string;
    status: string;
    mandate: string;
    accessDate: string;
    sources: Record<string, { accessDate: string }>;
    diagnosisFamilies: Array<{ family: string; fieldSideDigits?: Record<string, string>; sourceRefs: string[] }>;
    diagnosisCodes: Array<{ code: string; display: string; family: string; laterality: string; sourceRefs: string[] }>;
  };

  assert.equal(ledger.ledger, "visual-field-phase0");
  assert.equal(ledger.status, "phase0-seeded");
  assert.equal(ledger.mandate, "Mandate 14");
  assert.equal(ledger.accessDate, "2026-08-04");
  assert.deepEqual(Object.keys(ledger.sources), [
    "cdcIcd10Cm2026CodeDescriptions",
    "nlmClinicalTablesIcd10Cm",
  ]);
  assert.equal(Object.values(ledger.sources).every((source) => source.accessDate === "2026-08-04"), true);
  assert.deepEqual(ledger.diagnosisFamilies.map((row) => row.family), [
    "H53.41-",
    "H53.42-",
    "H53.43-",
    "H53.45-",
    "H53.46-",
    "H53.47",
    "H53.48-",
  ]);
  assert.deepEqual(
    ledger.diagnosisFamilies.find((row) => row.family === "H53.46-")?.fieldSideDigits,
    { "1": "right", "2": "left", "9": "unspecified" },
  );
  assert.equal(ledger.diagnosisFamilies.every((row) => row.sourceRefs.length === 2), true);
  assert.equal(ledger.diagnosisCodes.length, 24);
  assert.equal(ledger.diagnosisCodes.every((row) => row.sourceRefs.length === 2), true);
  assert.equal(ledger.diagnosisCodes.some((row) => row.code === "H53.40"), false);
  assert.deepEqual(
    ledger.diagnosisCodes.map(({ code, display }) => [code, display]),
    [
      ["H53.411", "Scotoma involving central area, right eye"],
      ["H53.412", "Scotoma involving central area, left eye"],
      ["H53.413", "Scotoma involving central area, bilateral"],
      ["H53.419", "Scotoma involving central area, unspecified eye"],
      ["H53.421", "Scotoma of blind spot area, right eye"],
      ["H53.422", "Scotoma of blind spot area, left eye"],
      ["H53.423", "Scotoma of blind spot area, bilateral"],
      ["H53.429", "Scotoma of blind spot area, unspecified eye"],
      ["H53.431", "Sector or arcuate defects, right eye"],
      ["H53.432", "Sector or arcuate defects, left eye"],
      ["H53.433", "Sector or arcuate defects, bilateral"],
      ["H53.439", "Sector or arcuate defects, unspecified eye"],
      ["H53.451", "Other localized visual field defect, right eye"],
      ["H53.452", "Other localized visual field defect, left eye"],
      ["H53.453", "Other localized visual field defect, bilateral"],
      ["H53.459", "Other localized visual field defect, unspecified eye"],
      ["H53.461", "Homonymous bilateral field defects, right side"],
      ["H53.462", "Homonymous bilateral field defects, left side"],
      ["H53.469", "Homonymous bilateral field defects, unspecified side"],
      ["H53.47", "Heteronymous bilateral field defects"],
      ["H53.481", "Generalized contraction of visual field, right eye"],
      ["H53.482", "Generalized contraction of visual field, left eye"],
      ["H53.483", "Generalized contraction of visual field, bilateral"],
      ["H53.489", "Generalized contraction of visual field, unspecified eye"],
    ],
  );

  const seeds = buildDiagnosisCatalogSeeds().filter((row) => row.clinicalFamily === "visual-field-defect");
  const expected = {
    vf_scotoma_central: { pattern: { unspecifiedEye: "H53.419", right: "H53.411", left: "H53.412", bilateral: "H53.413" } },
    vf_scotoma_blind_spot: { pattern: { unspecifiedEye: "H53.429", right: "H53.421", left: "H53.422", bilateral: "H53.423" } },
    vf_sector_or_arcuate: { pattern: { unspecifiedEye: "H53.439", right: "H53.431", left: "H53.432", bilateral: "H53.433" } },
    vf_other_localized: { pattern: { unspecifiedEye: "H53.459", right: "H53.451", left: "H53.452", bilateral: "H53.453" } },
    vf_homonymous_bilateral: { pattern: { unspecifiedEye: "H53.469", right: "H53.461", left: "H53.462" } },
    vf_heteronymous_bilateral: { code: "H53.47", display: "Heteronymous bilateral field defects" },
    vf_generalized_contraction: { pattern: { unspecifiedEye: "H53.489", right: "H53.481", left: "H53.482", bilateral: "H53.483" } },
  };

  assert.equal(seeds.length, 7);
  for (const [stableKey, icd10] of Object.entries(expected)) {
    const seed = seeds.find((row) => row.stableKey === stableKey);
    assert.ok(seed, `Missing visual-field diagnosis catalog seed ${stableKey}`);
    assert.deepEqual(seed.icd10, icd10);
    assert.equal(seed.codingStatus, "verified");
    assert.deepEqual(seed.applicableFindingDefinitionIds, []);
  }
  assert.equal(seeds.find((row) => row.stableKey === "vf_homonymous_bilateral")?.provenance.note,
    "For this family, right, left, and unspecified pattern slots encode visual-field side, not eye laterality; generic eye-laterality resolution uses the unspecified-side code until field-side capture exists.");
  assert.equal(seeds.find((row) => row.stableKey === "vf_homonymous_bilateral")?.lateralityRequired, false);
  assert.doesNotMatch(JSON.stringify(seeds), /H53\.40/);
});

test("lens Phase 0 ledger and catalog seeds preserve verified codes and laterality asymmetry", () => {
  const raw = readFileSync(
    resolve(process.cwd(), "../data/code-bindings/lens-phase0-ledger.json"),
    "utf8",
  );
  const ledger = JSON.parse(raw) as {
    ledger: string;
    status: string;
    mandate: string;
    accessDate: string;
    sources: Record<string, { accessDate: string }>;
    diagnosisFamilies: Array<{ family: string; lateralityDigits?: Record<string, string>; sourceRefs: string[] }>;
    diagnosisCodes: Array<{ code: string; display: string; family: string; laterality: string; sourceRefs: string[] }>;
  };

  assert.equal(ledger.ledger, "lens-phase0");
  assert.equal(ledger.status, "phase0-seeded");
  assert.equal(ledger.mandate, "Mandate 14");
  assert.equal(ledger.accessDate, "2026-08-06");
  assert.deepEqual(Object.keys(ledger.sources), [
    "cdcIcd10Cm2026CodeDescriptions",
    "nlmClinicalTablesIcd10Cm",
    "cdcIcd10Cm2026AlphabeticIndex",
  ]);
  assert.deepEqual(ledger.diagnosisFamilies.map((row) => row.family), [
    "H25.1-",
    "H25.01-",
    "H25.03-",
    "H25.04-",
    "H25.81-",
    "H26.49-",
    "H27.0-",
    "H27.11-",
    "H27.12-",
    "H27.13-",
    "H26.8",
    "Z96.1",
  ]);
  assert.deepEqual(
    ledger.diagnosisFamilies.find((row) => row.family === "H25.1-")?.lateralityDigits,
    { "0": "unspecified", "1": "OD", "2": "OS", "3": "bilateral" },
  );
  assert.deepEqual(
    ledger.diagnosisFamilies.find((row) => row.family === "H27.0-")?.lateralityDigits,
    { "0": "unspecified", "1": "OD", "2": "OS", "3": "bilateral" },
  );
  assert.equal(ledger.diagnosisCodes.length, 42);
  assert.deepEqual(
    ledger.diagnosisCodes.map(({ code, display, family, laterality }) => [code, display, family, laterality]),
    [
      ["H25.11", "Age-related nuclear cataract, right eye", "H25.1-", "OD"],
      ["H25.12", "Age-related nuclear cataract, left eye", "H25.1-", "OS"],
      ["H25.13", "Age-related nuclear cataract, bilateral", "H25.1-", "OU"],
      ["H25.10", "Age-related nuclear cataract, unspecified eye", "H25.1-", "UNKNOWN"],
      ["H25.011", "Cortical age-related cataract, right eye", "H25.01-", "OD"],
      ["H25.012", "Cortical age-related cataract, left eye", "H25.01-", "OS"],
      ["H25.013", "Cortical age-related cataract, bilateral", "H25.01-", "OU"],
      ["H25.019", "Cortical age-related cataract, unspecified eye", "H25.01-", "UNKNOWN"],
      ["H25.031", "Anterior subcapsular polar age-related cataract, right eye", "H25.03-", "OD"],
      ["H25.032", "Anterior subcapsular polar age-related cataract, left eye", "H25.03-", "OS"],
      ["H25.033", "Anterior subcapsular polar age-related cataract, bilateral", "H25.03-", "OU"],
      ["H25.039", "Anterior subcapsular polar age-related cataract, unspecified eye", "H25.03-", "UNKNOWN"],
      ["H25.041", "Posterior subcapsular polar age-related cataract, right eye", "H25.04-", "OD"],
      ["H25.042", "Posterior subcapsular polar age-related cataract, left eye", "H25.04-", "OS"],
      ["H25.043", "Posterior subcapsular polar age-related cataract, bilateral", "H25.04-", "OU"],
      ["H25.049", "Posterior subcapsular polar age-related cataract, unspecified eye", "H25.04-", "UNKNOWN"],
      ["H25.811", "Combined forms of age-related cataract, right eye", "H25.81-", "OD"],
      ["H25.812", "Combined forms of age-related cataract, left eye", "H25.81-", "OS"],
      ["H25.813", "Combined forms of age-related cataract, bilateral", "H25.81-", "OU"],
      ["H25.819", "Combined forms of age-related cataract, unspecified eye", "H25.81-", "UNKNOWN"],
      ["H26.491", "Other secondary cataract, right eye", "H26.49-", "OD"],
      ["H26.492", "Other secondary cataract, left eye", "H26.49-", "OS"],
      ["H26.493", "Other secondary cataract, bilateral", "H26.49-", "OU"],
      ["H26.499", "Other secondary cataract, unspecified eye", "H26.49-", "UNKNOWN"],
      ["H27.01", "Aphakia, right eye", "H27.0-", "OD"],
      ["H27.02", "Aphakia, left eye", "H27.0-", "OS"],
      ["H27.03", "Aphakia, bilateral", "H27.0-", "OU"],
      ["H27.00", "Aphakia, unspecified eye", "H27.0-", "UNKNOWN"],
      ["H27.111", "Subluxation of lens, right eye", "H27.11-", "OD"],
      ["H27.112", "Subluxation of lens, left eye", "H27.11-", "OS"],
      ["H27.113", "Subluxation of lens, bilateral", "H27.11-", "OU"],
      ["H27.119", "Subluxation of lens, unspecified eye", "H27.11-", "UNKNOWN"],
      ["H27.121", "Anterior dislocation of lens, right eye", "H27.12-", "OD"],
      ["H27.122", "Anterior dislocation of lens, left eye", "H27.12-", "OS"],
      ["H27.123", "Anterior dislocation of lens, bilateral", "H27.12-", "OU"],
      ["H27.129", "Anterior dislocation of lens, unspecified eye", "H27.12-", "UNKNOWN"],
      ["H27.131", "Posterior dislocation of lens, right eye", "H27.13-", "OD"],
      ["H27.132", "Posterior dislocation of lens, left eye", "H27.13-", "OS"],
      ["H27.133", "Posterior dislocation of lens, bilateral", "H27.13-", "OU"],
      ["H27.139", "Posterior dislocation of lens, unspecified eye", "H27.13-", "UNKNOWN"],
      ["H26.8", "Other specified cataract", "H26.8", "NONE"],
      ["Z96.1", "Presence of intraocular lens", "Z96.1", "NONE"],
    ],
  );

  const allSeeds = buildDiagnosisCatalogSeeds();
  const seeds = allSeeds.filter((row) => row.clinicalFamily === "cataract" || row.clinicalFamily === "lens");
  const expected = {
    cataract_nuclear_sclerosis: { pattern: { unspecifiedEye: "H25.10", right: "H25.11", left: "H25.12", bilateral: "H25.13" } },
    cataract_cortical: { pattern: { unspecifiedEye: "H25.019", right: "H25.011", left: "H25.012", bilateral: "H25.013" } },
    cataract_anterior_subcapsular: { pattern: { unspecifiedEye: "H25.039", right: "H25.031", left: "H25.032", bilateral: "H25.033" } },
    cataract_posterior_subcapsular: { pattern: { unspecifiedEye: "H25.049", right: "H25.041", left: "H25.042", bilateral: "H25.043" } },
    cataract_combined_forms: { pattern: { unspecifiedEye: "H25.819", right: "H25.811", left: "H25.812", bilateral: "H25.813" } },
    cataract_posterior_capsular_opacification: { pattern: { unspecifiedEye: "H26.499", right: "H26.491", left: "H26.492", bilateral: "H26.493" } },
    pseudoexfoliation_lens: { code: "H26.8", display: "Other specified cataract" },
    pseudophakia: { code: "Z96.1", display: "Presence of intraocular lens" },
    aphakia: { pattern: { unspecifiedEye: "H27.00", right: "H27.01", left: "H27.02", bilateral: "H27.03" } },
    lens_subluxation: { pattern: { unspecifiedEye: "H27.119", right: "H27.111", left: "H27.112", bilateral: "H27.113" } },
    lens_dislocation_anterior: { pattern: { unspecifiedEye: "H27.129", right: "H27.121", left: "H27.122", bilateral: "H27.123" } },
    lens_dislocation_posterior: { pattern: { unspecifiedEye: "H27.139", right: "H27.131", left: "H27.132", bilateral: "H27.133" } },
  };

  assert.equal(allSeeds.length, 134);
  assert.equal(seeds.length, 12);
  for (const [stableKey, icd10] of Object.entries(expected)) {
    const seed = seeds.find((row) => row.stableKey === stableKey);
    assert.ok(seed, `Missing lens diagnosis catalog seed ${stableKey}`);
    assert.deepEqual(seed.icd10, icd10);
    assert.equal(seed.codingStatus, "verified");
    assert.deepEqual(seed.applicableFindingDefinitionIds, []);
    assert.equal(seed.provenance.ledgerRefs.length >= 2, true);
  }
  const pseudoexfoliation = seeds.find((row) => row.stableKey === "pseudoexfoliation_lens");
  assert.equal(pseudoexfoliation?.display, "Pseudoexfoliation of lens capsule");
  assert.deepEqual(pseudoexfoliation?.provenance.ledgerRefs, [
    "cdcIcd10Cm2026CodeDescriptions",
    "nlmClinicalTablesIcd10Cm",
    "cdcIcd10Cm2026AlphabeticIndex",
  ]);
  const pseudophakia = seeds.find((row) => row.stableKey === "pseudophakia");
  assert.equal(pseudophakia?.lateralityRequired, false);
  assert.equal("pattern" in (pseudophakia?.icd10 ?? {}), false);
  assert.equal(pseudoexfoliation?.lateralityRequired, false);
  assert.equal("pattern" in (pseudoexfoliation?.icd10 ?? {}), false);
  const aphakia = seeds.find((row) => row.stableKey === "aphakia");
  assert.equal(aphakia?.lateralityRequired, true);
  assert.deepEqual(aphakia?.icd10, expected.aphakia);
  assert.doesNotMatch(JSON.stringify({ ledger, seeds }), /H25\.2|H26\.0|H26\.22|H26\.23|H26\.41/);
});

test("diabetic retinopathy Phase 0 ledger is dual-source and keeps coverage descriptor-only", () => {
  const raw = readFileSync(
    resolve(process.cwd(), "../data/code-bindings/diabetic-retinopathy-phase0-ledger.json"),
    "utf8",
  );
  const ledger = JSON.parse(raw) as {
    mandate: string;
    accessDate: string;
    diagnosisFamilies: Array<{ family: string }>;
    diagnosisCodes: Array<{ code: string; laterality: string; sourceRefs: string[] }>;
    procedures: Array<{ conceptKey: string; coverageReady: boolean; code?: string; cptBinding: { status: string } }>;
    provisionalCoverageRules: Array<{ procedureCode: string; diagnosisFamilies: string[]; jurisdiction: string; supportStatus: string; notBillReady: boolean }>;
  };

  assert.equal(ledger.mandate, "Mandate 14");
  assert.equal(ledger.accessDate, "2026-07-13");
  assert.equal(ledger.diagnosisFamilies.length, 14);
  assert.equal(ledger.diagnosisCodes.length, 50);
  assert.equal(ledger.diagnosisCodes.every((row) => row.sourceRefs.length >= 2), true);
  assert.equal(ledger.diagnosisCodes.filter((row) => row.code === "E11.311" || row.code === "E11.319").every((row) => row.laterality === "UNKNOWN"), true);
  assert.deepEqual(
    new Set(ledger.diagnosisCodes.filter((row) => row.code !== "E11.311" && row.code !== "E11.319").map((row) => row.laterality)),
    new Set(["OD", "OS", "OU", "UNKNOWN"]),
  );
  assert.deepEqual(ledger.procedures.map((row) => row.conceptKey), ["fundus-photography", "scodi-retina"]);
  assert.equal(ledger.procedures.every((row) => row.cptBinding.status === "deferred-to-licensed-adapter" && row.coverageReady === false && row.code === undefined), true);
  assert.equal(ledger.provisionalCoverageRules.every((row) => row.supportStatus === "provisional" && row.notBillReady), true);
  assert.equal(ledger.provisionalCoverageRules.every((row) => row.jurisdiction === "Palmetto GBA J-M South Carolina"), true);
  assert.equal(ledger.provisionalCoverageRules.every((row) => !/^\d+$/.test(row.procedureCode)), true);
  assert.equal(ledger.provisionalCoverageRules.every((row) => row.diagnosisFamilies.length === ledger.diagnosisFamilies.length), true);
  assert.doesNotMatch(raw, /(?<!\d)\d{5}(?!\d)/);
});

test("mapping evaluator fails closed for malformed and unknown fields", () => {
  const finding: FindingInstance = {
    id: "finding-1",
    state: "committed",
    presence: "present",
    findingDefinitionId: "finding-def-1",
    patientReference: "Patient/p1",
    encounterReference: "Encounter/e1",
    laterality: "OD",
    value: { type: "components", components: [{ code: "CUSTOM_TEAR_1", display: "Tear", value: 2 }] },
    sourceType: "manual",
    recordedAt: "2026-07-11T12:00:00.000Z",
    provenance: { source: "manual", recordedAt: "2026-07-11T12:00:00.000Z" },
  };
  assert.equal(evaluateMappingTrigger({ kind: "numeric", field: "CUSTOM_TEAR_1", op: "<=", value: 3 }, finding), true);
  assert.equal(evaluateMappingTrigger({ kind: "numeric", field: "UNKNOWN", op: "<=", value: 3 }, finding), false);
  assert.equal(evaluateMappingTrigger({ kind: "javascript", expression: "true" }, finding), false);
});

test("candidate ordering accepts an empty L1 tally and optional L2 counts", () => {
  const rows = [
    { diagnosisKey: "alpha", display: "Alpha", codingStatus: "provisional" as const, priority: false, source: "mapping" as const, order: 0 },
    { diagnosisKey: "beta", display: "Beta", codingStatus: "verified" as const, priority: true, source: "rule" as const, order: 1 },
  ];
  assert.deepEqual(orderDiagnosisCandidates(rows).map((row) => row.diagnosisKey), ["beta", "alpha"]);
  assert.deepEqual(orderDiagnosisCandidates(rows, { alpha: 3 }).map((row) => row.diagnosisKey), ["alpha", "beta"]);
});

test("real HTTP routes complete Tear Film mapping, candidates read, deactivation, RBAC fence, versioning, and audit headers", async (t) => {
  const fhir = new MemoryFhir();
  const app = express();
  app.use(express.json());
  const authenticate = async (header: string | undefined) => header === AUTH || header === "Bearer chart" || header === "Bearer no-grant" ? {
    staffReference: "Practitioner/admin-1",
    actorRole: (header === AUTH ? "admin" : header === "Bearer chart" ? "provider" : "admin") as PracticeRoleId,
    fhir,
  } : null;
  const findingDeps = () => ({ authenticate, now: () => "2026-07-11T12:00:00.000Z", shortId: () => "stable01" });
  app.post("/clinical-graph/finding-definitions", async (req, res) => {
    const result = await handleFindingDefinitionCreationRequest(findingDeps(), { authHeader: req.header("authorization"), body: req.body });
    res.status(result.status).json(result.body);
  });
  app.post("/clinical-graph/finding-definitions/:stableKey", async (req, res) => {
    const result = await handleFindingDefinitionMutationRequest(findingDeps(), { authHeader: req.header("authorization"), params: req.params, body: req.body });
    res.status(result.status).json(result.body);
  });
  app.post("/clinical-graph/diagnosis-catalog", async (req, res) => {
    const result = await handleDiagnosisCatalogCreationRequest({ ...findingDeps(), shortId: () => "diagn01" }, { authHeader: req.header("authorization"), body: req.body });
    res.status(result.status).json(result.body);
  });
  app.post("/clinical-graph/diagnosis-catalog/:stableKey", async (req, res) => {
    const result = await handleDiagnosisCatalogMutationRequest(findingDeps(), { authHeader: req.header("authorization"), params: req.params, body: req.body });
    res.status(result.status).json(result.body);
  });
  app.get("/clinical-graph/diagnosis-catalog", async (req, res) => {
    const result = await handleDiagnosisCatalogListRequest(findingDeps(), { authHeader: req.header("authorization") });
    res.status(result.status).json(result.body);
  });
  app.post("/clinical-graph/custom/:stableKey", async (req, res) => {
    const definitions = await new FhirFindingDefinitionStore(fhir).list();
    const result = await handleCustomSectionCaptureRequest({ authenticate, findingDefinitions: () => definitions }, { authHeader: req.header("authorization"), params: req.params, body: req.body });
    res.status(result.status).json(result.body);
  });
  app.post("/clinical-graph/glaucoma/cup-disc", async (req, res) => {
    const definitions = await new FhirFindingDefinitionStore(fhir).list();
    const result = await handleCupDiscCaptureRequest({ authenticate, findingDefinitions: () => definitions }, { authHeader: req.header("authorization"), body: req.body });
    res.status(result.status).json(result.body);
  });
  app.post("/clinical-graph/refraction", async (req, res) => {
    const definitions = await new FhirFindingDefinitionStore(fhir).list();
    const result = await handleRefractionCaptureRequest({ authenticate, findingDefinitions: () => definitions }, { authHeader: req.header("authorization"), body: req.body });
    res.status(result.status).json(result.body);
  });
  app.get("/clinical-graph/encounters/:encounterId/diagnosis-candidates", async (req, res) => {
    const result = await handleDiagnosisCandidatesRequest({ authenticate, now: () => "2026-07-11T12:00:00.000Z" }, { authHeader: req.header("authorization"), params: req.params });
    res.status(result.status).json(result.body);
  });
  const listener = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => listener.once("listening", resolve));
  t.after(() => listener.close());
  const base = `http://127.0.0.1:${(listener.address() as AddressInfo).port}`;

  await get(base, "/clinical-graph/encounters/e1/diagnosis-candidates", null, 401);
  await request(base, "/clinical-graph/diagnosis-catalog", {}, 401, null);
  await get(base, "/clinical-graph/encounters/e1/diagnosis-candidates", "Bearer no-grant", 200);
  await request(base, "/clinical-graph/diagnosis-catalog", {}, 400, "Bearer no-grant");

  const section = await request(base, "/clinical-graph/finding-definitions", {
    action: "create-definition",
    display: "Tear Film",
    fields: [{ display: "Tear quality", valueType: "number" }],
    perEye: false,
  }, 201);
  const definition = section.definition as { stableKey: string };
  const field = (section.fields as Array<{ localCode: string }>)[0]!;
  const diagnosis = await request(base, "/clinical-graph/diagnosis-catalog", {
    display: "Keratoconjunctivitis sicca",
    clinicalFamily: "ocular-surface",
    lateralityRequired: false,
  }, 201);
  const diagnosisRow = diagnosis.diagnosis as { stableKey: string; codingStatus: string };
  assert.equal(diagnosisRow.codingStatus, "provisional");

  const mapping = await request(base, `/clinical-graph/finding-definitions/${encodeURIComponent(definition.stableKey)}`, {
    action: "create-diagnosis-candidate",
    diagnosisKey: diagnosisRow.stableKey,
    trigger: { kind: "always" },
    priority: true,
  });
  const candidate = mapping.candidate as { id: string };
  await request(base, `/clinical-graph/custom/${encodeURIComponent(definition.stableKey)}`, {
    patientReference: "Patient/p1",
    encounterReference: "Encounter/e1",
    customFields: [{ code: field.localCode, value: 1 }],
  }, 200, "Bearer chart");

  const candidates = await get(base, "/clinical-graph/encounters/e1/diagnosis-candidates", "Bearer chart") as {
    findings: Array<{ candidates: Array<{ diagnosisKey: string; codingStatus: string; source: string }> }>;
  };
  assert.deepEqual(candidates.findings[0]?.candidates, [{
    diagnosisKey: diagnosisRow.stableKey,
    display: "Keratoconjunctivitis sicca",
    codingStatus: "provisional",
    priority: true,
    source: "mapping",
  }]);

  const cupDisc = await request(base, "/clinical-graph/glaucoma/cup-disc", {
    patientReference: "Patient/p1",
    encounterReference: "Encounter/e1",
    eyes: { OD: { verticalCupDiscRatio: 0.8 } },
  }, 200, "Bearer chart") as { eyes: { OD: { icd10Code: string } } };
  const refraction = await request(base, "/clinical-graph/refraction", {
    patientReference: "Patient/p1",
    encounterReference: "Encounter/e1",
    blocks: [{ type: "MANIFEST", OD: { sphere: -1 } }],
  }, 200, "Bearer chart") as { suggestions: Array<{ code: string }> };
  await request(base, "/clinical-graph/diagnosis-catalog/glaucoma_suspect_open_angle_high", {
    display: "Practice-edited high-risk glaucoma suspect",
  });
  const compiled = await get(base, "/clinical-graph/encounters/e1/diagnosis-candidates", "Bearer chart") as {
    findings: Array<{ findingDefinitionKey: string; candidates: Array<{ display: string; icd10?: { code?: string }; source: string }> }>;
  };
  assert.equal(
    compiled.findings.find((row) => row.findingDefinitionKey === "cup_disc_ratio")?.candidates[0]?.icd10?.code,
    cupDisc.eyes.OD.icd10Code,
  );
  assert.equal(
    compiled.findings.find((row) => row.findingDefinitionKey === "cup_disc_ratio")?.candidates[0]?.display,
    "Practice-edited high-risk glaucoma suspect",
  );
  assert.deepEqual(
    compiled.findings.find((row) => row.findingDefinitionKey === "refraction")?.candidates.map((row) => row.icd10?.code),
    refraction.suggestions.map((row) => row.code),
  );
  assert.equal(compiled.findings.flatMap((row) => row.candidates).every((row) => row.source === "rule" || row.source === "mapping"), true);

  const wearingRejected = await request(base, "/clinical-graph/finding-definitions/wearing_rx", {
    action: "create-diagnosis-candidate",
    diagnosisKey: diagnosisRow.stableKey,
    trigger: { kind: "always" },
  }, 400);
  assert.match(String(wearingRejected.error), /does not allow diagnosis mapping/);

  await request(base, `/clinical-graph/finding-definitions/${encodeURIComponent(definition.stableKey)}`, {
    action: "update-diagnosis-candidate",
    id: candidate.id,
    active: false,
  });
  const after = await get(base, "/clinical-graph/encounters/e1/diagnosis-candidates", "Bearer chart") as {
    findings: Array<{ candidates: unknown[] }>;
  };
  assert.deepEqual(after.findings[0]?.candidates, []);

  const findingRow = fhir.resources.find((resource) => resource.resourceType === "Basic" && (resource as Basic).code?.coding?.some((coding) => coding.system === FINDING_DEFINITION_CODE_SYSTEM && coding.code === FINDING_DEFINITION_CODE));
  assert.ok(findingRow?.id);
  assert.ok((fhir.versions.get(`Basic/${findingRow.id}`)?.length ?? 0) >= 2);
  assert.equal(fhir.writes.some((write) => write.headers?.["X-ODOS-Source"] === FINDING_DEFINITION_WRITE_HEADERS["X-ODOS-Source"]), true);
  assert.equal(fhir.writes.some((write) => write.headers?.["X-ODOS-Source"] === DIAGNOSIS_CATALOG_WRITE_HEADERS["X-ODOS-Source"]), true);
  assert.equal(fhir.resources.some((resource) => resource.resourceType === "Condition"), false);
  assert.equal(fhir.resources.filter((resource) => resource.resourceType === "Basic").some((resource) => (resource as Basic).code?.coding?.some((coding) => coding.system === DIAGNOSIS_DEFINITION_CODE_SYSTEM && coding.code === DIAGNOSIS_DEFINITION_CODE)), true);
});

async function request(base: string, path: string, body: unknown, expected = 200, auth: string | null = AUTH): Promise<Record<string, unknown>> {
  const response = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { ...(auth ? { Authorization: auth } : {}), "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const result = await response.json() as Record<string, unknown>;
  assert.equal(response.status, expected, JSON.stringify(result));
  return result;
}

async function get(base: string, path: string, auth: string | null = AUTH, expected = 200): Promise<unknown> {
  const response = await fetch(`${base}${path}`, { headers: auth ? { Authorization: auth } : {} });
  const result = await response.json();
  assert.equal(response.status, expected, JSON.stringify(result));
  return result;
}
