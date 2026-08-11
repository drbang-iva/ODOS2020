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
    "diplopia",
    "paralytic_strabismus",
    "macular_drusen",
    "epiretinal_membrane",
    "cystoid_macular_degeneration",
    "macular_hole",
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

test("diagnosis catalog contains no non-billable strict-prefix header codes", () => {
  const codesByFamily = new Map<string, Set<string>>();
  for (const seed of buildDiagnosisCatalogSeeds()) {
    const codes = seed.icd10 && "code" in seed.icd10
      ? [seed.icd10.code]
      : Object.values(seed.icd10?.pattern ?? {}).filter((code): code is string => Boolean(code));
    const familyCodes = codesByFamily.get(seed.icd10Family) ?? new Set<string>();
    for (const code of codes) familyCodes.add(code);
    codesByFamily.set(seed.icd10Family, familyCodes);
  }

  for (const [family, codes] of codesByFamily) {
    for (const code of codes) {
      const descendant = [...codes].find((candidate) => candidate.length > code.length && candidate.startsWith(code));
      assert.equal(descendant, undefined, `${code} is a non-billable header for ${descendant} in ${family}`);
    }
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

  assert.equal(allSeeds.length, 91);
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
    actorRole: (header === AUTH ? "practice-admin" : header === "Bearer chart" ? "clinician" : "auditor") as PracticeRoleId,
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
  await get(base, "/clinical-graph/encounters/e1/diagnosis-candidates", "Bearer no-grant", 403);
  await request(base, "/clinical-graph/diagnosis-catalog", {}, 403, "Bearer no-grant");

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
