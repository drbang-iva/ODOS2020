import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import type { AddressInfo } from "node:net";
import type { Basic, Bundle, Condition, Encounter, Observation, Provenance, Resource } from "@medplum/fhirtypes";
import express from "express";
import type { PracticeRoleId } from "../src/authz/roles.js";
import { handleCupDiscCaptureRequest } from "../src/clinical-graph/cup-disc-endpoint.js";
import {
  handleCustomSectionCaptureRequest,
  handleCustomSectionHistoryRequest,
} from "../src/clinical-graph/custom-section-endpoint.js";
import {
  deduplicateDiagnosisCandidates,
  handleDiagnosisCandidatesRequest,
} from "../src/clinical-graph/diagnosis-candidates-endpoint.js";
import { buildDiagnosisCatalogSeeds } from "../src/clinical-graph/diagnosis-catalog-store.js";
import { handleDiagnosisPickRequest } from "../src/clinical-graph/diagnosis-pick-endpoint.js";
import {
  DX_PICK_TALLY_CODE,
  DX_PICK_TALLY_CODE_SYSTEM,
  FhirDiagnosisPickTallyStore,
} from "../src/clinical-graph/diagnosis-pick-tally-store.js";
import { FhirFindingDefinitionStore } from "../src/clinical-graph/finding-definition-store.js";
import {
  createDiagnosisCandidateSchema,
  evaluateMappingTrigger,
  matchingQualifierGroups,
  updateDiagnosisCandidateSchema,
} from "../src/clinical-graph/diagnosis-mapping.js";
import type { FindingInstance } from "../src/clinical-graph/glaucoma-suspect.js";
import { handleEomCaptureRequest } from "../src/clinical-graph/eom-endpoint.js";

test("allOf mapping triggers require every nested option trigger", () => {
  const trigger = { kind: "allOf" as const, triggers: [
    { kind: "option" as const, field: "binocular", anyOf: ["yes"] },
    { kind: "option" as const, field: "incomitant", anyOf: ["yes"] },
  ] };
  const finding = (components: Array<{ code: string; display: string; value: number | string | boolean }>): FindingInstance => ({
    id: "eom-finding", state: "committed", findingDefinitionId: "finding-def-entrance-eom",
    patientReference: "Patient/p1", encounterReference: "Encounter/e1", laterality: "OU",
    value: { type: "components", components }, sourceType: "manual", recordedAt: "2026-07-22T12:00:00.000Z",
    provenance: { source: "manual", recordedAt: "2026-07-22T12:00:00.000Z" },
  });
  assert.equal(evaluateMappingTrigger(trigger, finding([
    { code: "binocular::yes", display: "binocular", value: true },
    { code: "incomitant::yes", display: "incomitant", value: true },
  ])), true);
  assert.equal(evaluateMappingTrigger(trigger, finding([{ code: "binocular::yes", display: "binocular", value: true }])), false);
  assert.equal(evaluateMappingTrigger(trigger, finding([{ code: "incomitant::yes", display: "incomitant", value: true }])), false);
});

test("EOM binocular plus incomitant proposes diplopia and paralytic strabismus without auto-confirming", async () => {
  const fhir = new MemoryFhir();
  const definitions = await new FhirFindingDefinitionStore(fhir).list();
  const authenticate = async () => ({ staffReference: "Practitioner/doc", actorRole: "clinician" as PracticeRoleId, fhir });
  const base = { patientReference: "Patient/p1", encounterReference: "Encounter/eom", state: "abnormal" as const, eyes: { OD: { primary: "-1" as const } }, nystagmus: { present: false } };
  const firing = await handleEomCaptureRequest({ authenticate, findingDefinitions: () => definitions, now: () => "2026-07-22T12:00:00.000Z" }, { authHeader: "Bearer eom", body: { ...base, diplopia: { present: true, type: "binocular", direction: "horizontal", comitancy: "incomitant", worstGaze: "right", frequency: "intermittent" } } });
  assert.equal(firing.status, 200, JSON.stringify(firing.body));
  const nonFiring = await handleEomCaptureRequest({ authenticate, findingDefinitions: () => definitions, now: () => "2026-07-22T12:01:00.000Z" }, { authHeader: "Bearer eom", body: { ...base, diplopia: { present: true, type: "binocular", direction: "horizontal", comitancy: "comitant", worstGaze: "right", frequency: "intermittent" } } });
  assert.equal(nonFiring.status, 200, JSON.stringify(nonFiring.body));
  const untouchedDiplopia = await handleEomCaptureRequest({ authenticate, findingDefinitions: () => definitions, now: () => "2026-07-22T12:01:30.000Z" }, { authHeader: "Bearer eom", body: { ...base, diplopia: { present: false } } });
  assert.equal(untouchedDiplopia.status, 200, JSON.stringify(untouchedDiplopia.body));
  const candidates = await handleDiagnosisCandidatesRequest({ authenticate, now: () => "2026-07-22T12:02:00.000Z" }, { authHeader: "Bearer eom", params: { encounterId: "eom" } });
  const findings = (candidates.body as { findings: Array<{ candidates: Array<{ diagnosisKey: string }> }> }).findings;
  assert.deepEqual(findings[0]?.candidates.map((row) => row.diagnosisKey), ["diplopia", "paralytic_strabismus"]);
  assert.deepEqual(findings[1]?.candidates, []);
  assert.deepEqual(findings[2]?.candidates, []);
  assert.equal(fhir.resources.some((row) => row.resourceType === "Condition"), false);
});

class MemoryFhir {
  readonly resources: Resource[] = [];
  readonly writes: Array<{ operation: "create" | "update"; resourceType: string; id: string; headers?: Record<string, string> }> = [];

  async read<T extends Resource>(resourceType: T["resourceType"], id: string): Promise<T> {
    const resource = this.resources.find((row) => row.resourceType === resourceType && row.id === id);
    if (!resource) throw new Error(`Missing ${resourceType}/${id}`);
    return structuredClone(resource as T);
  }

  async search<T extends Resource>(resourceType: T["resourceType"], params: Record<string, string> = {}): Promise<Bundle<T>> {
    const resources = this.resources.filter((resource) => resource.resourceType === resourceType).filter((resource) => {
      if (resourceType === "Basic") {
        const basic = resource as Basic;
        if (params.code && !basic.code?.coding?.some((coding) => `${coding.system}|${coding.code}` === params.code)) return false;
        if (params.identifier && !basic.identifier?.some((identifier) => `${identifier.system}|${identifier.value}` === params.identifier)) return false;
      }
      if (resourceType === "Observation" && params.encounter) return (resource as Observation).encounter?.reference === params.encounter;
      if (resourceType === "Condition" && params.encounter) return (resource as Condition).encounter?.reference === params.encounter;
      return true;
    });
    return { resourceType: "Bundle", type: "searchset", entry: resources.map((resource) => ({ resource: structuredClone(resource as T) })) };
  }

  async create<T extends Resource>(resource: T, headers?: Record<string, string>): Promise<T> {
    const conditionalIdentifier = headers?.["If-None-Exist"]?.match(/^identifier=([^|]+)\|(.+)$/);
    if (conditionalIdentifier) {
      const existing = this.resources.find((candidate) => candidate.resourceType === resource.resourceType &&
        "identifier" in candidate && candidate.identifier?.some((identifier) =>
          identifier.system === conditionalIdentifier[1] && identifier.value === conditionalIdentifier[2]
        ));
      if (existing) return structuredClone(existing as T);
    }
    const id = resource.id ?? `${resource.resourceType.toLowerCase()}-${this.resources.length + 1}`;
    const persisted = { ...resource, id, meta: { ...(resource.meta ?? {}), versionId: "1", lastUpdated: "2026-07-11T16:00:00.000Z" } } as T;
    this.resources.push(persisted);
    this.writes.push({ operation: "create", resourceType: resource.resourceType, id, headers });
    return structuredClone(persisted);
  }

  async update<T extends Resource>(resourceType: T["resourceType"], id: string, resource: T, headers?: Record<string, string>): Promise<T> {
    const index = this.resources.findIndex((candidate) => candidate.resourceType === resourceType && candidate.id === id);
    if (index < 0) throw new Error(`Missing ${resourceType}/${id}`);
    const current = this.resources[index]!;
    const ifMatch = headers?.["If-Match"]?.match(/\"(.+)\"/)?.[1];
    if (ifMatch && ifMatch !== current.meta?.versionId) {
      const error = new Error("FHIR 412 Precondition Failed") as Error & { status?: number };
      error.status = 412;
      throw error;
    }
    const versionId = String(Number(current.meta?.versionId ?? "0") + 1);
    const lastUpdated = new Date(Date.parse("2026-07-11T16:00:00.000Z") + Number(versionId) * 60_000).toISOString();
    const persisted = { ...resource, id, meta: { ...(resource.meta ?? {}), versionId, lastUpdated } } as T;
    this.resources[index] = persisted;
    this.writes.push({ operation: "update", resourceType, id, headers });
    return structuredClone(persisted);
  }
}

test("real HTTP diagnosis picks persist right-eye evidence, Provenance, isolated tally ordering, and refuted audit state", async (t) => {
  const fhir = new MemoryFhir();
  fhir.resources.push({
    resourceType: "Encounter",
    id: "e1",
    status: "in-progress",
    class: { system: "http://terminology.hl7.org/CodeSystem/v3-ActCode", code: "AMB" },
    subject: { reference: "Patient/p1" },
    meta: { versionId: "1" },
  } as Encounter);
  const definitions = new FhirFindingDefinitionStore(fhir);
  const cupDiscDefinition = (await definitions.list()).find((row) => row.stableKey === "cup_disc_ratio")!;
  await definitions.save({
    ...cupDiscDefinition,
    diagnosisCandidates: [
      { id: "duplicate-rule", diagnosisKey: "glaucoma_suspect_open_angle_low", trigger: { kind: "always" }, priority: false, origin: "practice", active: true },
      { id: "ohtn-option", diagnosisKey: "ocular_hypertension", trigger: { kind: "always" }, priority: true, origin: "practice", active: true },
    ],
  });
  const routeDefinitions = await definitions.list();

  const authenticate = async (header: string | undefined) => {
    const practitioner = header === "Bearer doctor-1" ? "Practitioner/doctor-1" : header === "Bearer doctor-2" ? "Practitioner/doctor-2" : undefined;
    return practitioner ? { staffReference: practitioner, actorRole: "clinician" as PracticeRoleId, fhir } : null;
  };
  const app = express();
  app.use(express.json());
  app.post("/clinical-graph/glaucoma/cup-disc", async (req, res) => {
    const result = await handleCupDiscCaptureRequest({ authenticate, findingDefinitions: () => routeDefinitions }, { authHeader: req.header("authorization"), body: req.body });
    res.status(result.status).json(result.body);
  });
  app.get("/clinical-graph/encounters/:encounterId/diagnosis-candidates", async (req, res) => {
    const result = await handleDiagnosisCandidatesRequest({ authenticate, now: () => "2026-07-11T16:00:00.000Z" }, { authHeader: req.header("authorization"), params: req.params });
    res.status(result.status).json(result.body);
  });
  app.post("/clinical-graph/encounters/:encounterId/diagnosis-picks", async (req, res) => {
    const result = await handleDiagnosisPickRequest({ authenticate, now: () => "2026-07-11T16:00:00.000Z" }, { authHeader: req.header("authorization"), params: req.params, body: req.body });
    res.status(result.status).json(result.body);
  });
  const listener = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => listener.once("listening", resolve));
  t.after(() => listener.close());
  const base = `http://127.0.0.1:${(listener.address() as AddressInfo).port}`;

  const capture = await post(base, "/clinical-graph/glaucoma/cup-disc", {
    patientReference: "Patient/p1",
    encounterReference: "Encounter/e1",
    eyes: { OD: { verticalCupDiscRatio: 0.6 } },
  }, "Bearer doctor-1") as { eyes: { OD: { observationReference: string } } };
  const observationReference = capture.eyes.OD.observationReference;
  const initialDoctor1 = await candidates(base, "Bearer doctor-1");
  const cupDisc = initialDoctor1.findings.find((row) => row.observationReference === observationReference)!;
  assert.deepEqual(cupDisc.candidates.map((row) => row.diagnosisKey), ["glaucoma_suspect_open_angle_low", "ocular_hypertension"]);
  assert.equal(cupDisc.candidates.filter((row) => row.diagnosisKey === "glaucoma_suspect_open_angle_low").length, 1);
  assert.equal(cupDisc.candidates[0]?.source, "rule");

  await post(base, "/clinical-graph/encounters/e1/diagnosis-picks", {
    findingInstanceId: observationReference,
    diagnosisKey: "glaucoma_suspect_open_angle_low",
    action: "confirm",
    source: "rule",
  }, "Bearer doctor-1", 201);
  const condition = fhir.resources.find((row): row is Condition => row.resourceType === "Condition")!;
  assert.equal(condition.verificationStatus?.coding?.[0]?.code, "confirmed");
  assert.equal(condition.code?.coding?.[0]?.code, sourcedDiagnosisCode("glaucoma_suspect_open_angle_low", "right"));
  assert.equal(condition.evidence?.[0]?.detail?.[0]?.reference, observationReference);
  assert.equal(fhir.resources.some((row): row is Provenance => row.resourceType === "Provenance" &&
    row.target.some((target) => target.reference === `Condition/${condition.id}`) &&
    row.entity?.some((entity) => entity.what.reference === observationReference)), true);

  for (let index = 0; index < 2; index += 1) {
    await post(base, "/clinical-graph/encounters/e1/diagnosis-picks", {
      findingInstanceId: observationReference,
      diagnosisKey: "ocular_hypertension",
      action: index === 0 ? "possible" : "confirm",
      source: "mapping",
    }, "Bearer doctor-1", index === 0 ? 201 : 200);
  }
  const reorderedDoctor1 = await candidates(base, "Bearer doctor-1");
  assert.equal(reorderedDoctor1.findings.find((row) => row.observationReference === observationReference)?.candidates[0]?.diagnosisKey, "ocular_hypertension");
  const unchangedDoctor2 = await candidates(base, "Bearer doctor-2");
  assert.equal(unchangedDoctor2.findings.find((row) => row.observationReference === observationReference)?.candidates[0]?.diagnosisKey, "glaucoma_suspect_open_angle_low");
  assert.equal((await new FhirDiagnosisPickTallyStore(fhir).read("Practitioner/doctor-2")), undefined);

  await post(base, "/clinical-graph/encounters/e1/diagnosis-picks", {
    diagnosisKey: "ocular_hypertension",
    action: "discard",
    laterality: "OD",
  }, "Bearer doctor-1", 200);
  const discarded = fhir.resources.find((row): row is Condition => row.resourceType === "Condition" && row.code?.text === "Ocular hypertension")!;
  assert.equal(discarded.verificationStatus?.coding?.[0]?.code, "refuted");
  assert.equal(fhir.resources.filter((row) => row.resourceType === "Basic").some((row) => (row as Basic).code.coding?.some((coding) => coding.system === DX_PICK_TALLY_CODE_SYSTEM && coding.code === DX_PICK_TALLY_CODE)), true);
});

test("OH-3 multi-select findings propose verified per-eye diagnoses and explicit picks create the right Conditions", async () => {
  const fhir = new MemoryFhir();
  fhir.resources.push({
    resourceType: "Encounter", id: "e-oh3", status: "in-progress",
    class: { system: "http://terminology.hl7.org/CodeSystem/v3-ActCode", code: "AMB" },
    subject: { reference: "Patient/p-oh3" },
  } as Encounter);
  const definitions = await new FhirFindingDefinitionStore(fhir).list();
  const authenticate = async () => ({
    staffReference: "Practitioner/doctor-1",
    actorRole: "clinician" as PracticeRoleId,
    fhir,
  });
  const fieldFor = (stableKey: string) => {
    const definition = definitions.find((candidate) => candidate.stableKey === stableKey);
    assert.ok(definition);
    const field = Object.values(definition.valueSchema.fields as Record<string, { localCode?: string; valueType?: string }>)
      .find((candidate) => candidate.valueType === "multi-select");
    assert.ok(field?.localCode);
    return { definition, localCode: field.localCode };
  };

  const cornea = fieldFor("ocular-health:anterior:cornea");
  const corneaCapture = await handleCustomSectionCaptureRequest({
    authenticate,
    findingDefinitions: () => definitions,
    now: () => "2026-07-12T16:00:00.000Z",
  }, {
    authHeader: "Bearer doctor-1",
    params: { stableKey: cornea.definition.stableKey },
    body: {
      patientReference: "Patient/p-oh3",
      encounterReference: "Encounter/e-oh3",
      eyes: { OD: { state: "abnormal", customFields: [{ code: cornea.localCode, value: ["keratoconus"] }] } },
    },
  });
  assert.equal(corneaCapture.status, 200, JSON.stringify(corneaCapture.body));
  const corneaObservation = fhir.resources.find((resource): resource is Observation => resource.resourceType === "Observation" &&
    resource.code.coding?.some((coding) => coding.code === cornea.definition.stableKey))!;

  const corneaCandidates = await handleDiagnosisCandidatesRequest({ authenticate }, {
    authHeader: "Bearer doctor-1",
    params: { encounterId: "e-oh3" },
  });
  assert.equal(corneaCandidates.status, 200, JSON.stringify(corneaCandidates.body));
  const corneaRow = (corneaCandidates.body as {
    findings: Array<{ observationReference?: string; candidates: Array<{ diagnosisKey: string; icd10?: { code?: string } }> }>;
  }).findings.find((finding) => finding.observationReference === `Observation/${corneaObservation.id}`);
  assert.deepEqual(corneaRow?.candidates.map((candidate) => candidate.diagnosisKey), [
    "keratoconus_stable",
    "keratoconus_unstable",
  ]);
  assert.equal(corneaRow?.candidates[0]?.icd10?.code, "H18.611");

  const confirmedCornea = await handleDiagnosisPickRequest({
    authenticate,
    now: () => "2026-07-12T16:01:00.000Z",
  }, {
    authHeader: "Bearer doctor-1",
    params: { encounterId: "e-oh3" },
    body: {
      findingInstanceId: `Observation/${corneaObservation.id}`,
      diagnosisKey: "keratoconus_stable",
      action: "confirm",
      source: "mapping",
    },
  });
  assert.equal(confirmedCornea.status, 201, JSON.stringify(confirmedCornea.body));
  assert.equal((confirmedCornea.body as { condition: Condition }).condition.code?.coding?.[0]?.code, "H18.611");

  const lids = fieldFor("ocular-health:anterior:lids-lashes");
  const lidsCapture = await handleCustomSectionCaptureRequest({
    authenticate,
    findingDefinitions: () => definitions,
    now: () => "2026-07-12T16:02:00.000Z",
  }, {
    authHeader: "Bearer doctor-1",
    params: { stableKey: lids.definition.stableKey },
    body: {
      patientReference: "Patient/p-oh3",
      encounterReference: "Encounter/e-oh3",
      eyes: {
        OD: { state: "abnormal", customFields: [{ code: lids.localCode, value: ["anterior-blepharitis", "anterior-blepharitis::ulcerative"] }] },
        OS: { state: "abnormal", customFields: [{ code: lids.localCode, value: ["anterior-blepharitis", "anterior-blepharitis::ulcerative"] }] },
      },
    },
  });
  assert.equal(lidsCapture.status, 200, JSON.stringify(lidsCapture.body));
  const lidsObservations = fhir.resources.filter((resource): resource is Observation => resource.resourceType === "Observation" &&
    resource.code.coding?.some((coding) => coding.code === lids.definition.stableKey));
  assert.equal(lidsObservations.length, 2);
  const lidsCandidates = await handleDiagnosisCandidatesRequest({ authenticate }, {
    authHeader: "Bearer doctor-1",
    params: { encounterId: "e-oh3" },
  });
  const lidsRows = (lidsCandidates.body as {
    findings: Array<{ observationReference?: string; candidates: Array<{ diagnosisKey: string }> }>;
  }).findings.filter((finding) => lidsObservations.some((observation) => finding.observationReference === `Observation/${observation.id}`));
  assert.deepEqual(lidsRows.map((row) => row.candidates.map((candidate) => candidate.diagnosisKey)), [
    ["ulcerative_blepharitis"],
    ["ulcerative_blepharitis"],
  ]);

  for (const observation of lidsObservations) {
    const result = await handleDiagnosisPickRequest({
      authenticate,
      now: () => "2026-07-12T16:03:00.000Z",
    }, {
      authHeader: "Bearer doctor-1",
      params: { encounterId: "e-oh3" },
      body: {
        findingInstanceId: `Observation/${observation.id}`,
        diagnosisKey: "ulcerative_blepharitis",
        action: "confirm",
        source: "mapping",
      },
    });
    assert.equal(result.status, 201, JSON.stringify(result.body));
  }
  const blepharitisCodes = fhir.resources.filter((resource): resource is Condition => resource.resourceType === "Condition" &&
    resource.code?.text === "Ulcerative blepharitis")
    .map((condition) => condition.code?.coding?.[0]?.code)
    .sort();
  assert.deepEqual(blepharitisCodes, ["H01.013", "H01.016"]);
});

test("I1 complete ocular qualifiers resolve each selected finding to one diagnosis", async () => {
  const pterygiumCases = [
    [{ location: "central" }, "pterygium_central"],
    [{ location: "peripheral", progression: "stationary" }, "pterygium_peripheral_stationary"],
    [{ location: "peripheral", progression: "progressive" }, "pterygium_peripheral_progressive"],
    [{ location: "peripheral", progression: "recurrent" }, "pterygium_recurrent"],
  ] as const;
  for (const [stableKey, option] of [
    ["ocular-health:anterior:conjunctiva", "pterygium"],
    ["ocular-health:anterior:cornea", "pterygium-encroaching"],
  ] as const) {
    for (const [qualifiers, diagnosisKey] of pterygiumCases) {
      assert.deepEqual(await ocularCandidateKeys(stableKey, {
        OD: { selections: [option], findingDetails: { [option]: qualifiers } },
      }), [[diagnosisKey]]);
    }
  }

  for (const [stability, diagnosisKey] of [
    ["stable", "keratoconus_stable"],
    ["unstable", "keratoconus_unstable"],
  ] as const) {
    assert.deepEqual(await ocularCandidateKeys("ocular-health:anterior:cornea", {
      OD: { selections: ["keratoconus"], findingDetails: { keratoconus: { stability } } },
    }), [[diagnosisKey]]);
  }

  for (const [severity, macularEdema, diagnosisKey] of [
    ["mild", "present", "t2_dr_mild_npdr_with_dme"],
    ["mild", "absent", "t2_dr_mild_npdr_without_dme"],
    ["moderate", "present", "t2_dr_moderate_npdr_with_dme"],
    ["moderate", "absent", "t2_dr_moderate_npdr_without_dme"],
    ["severe", "present", "t2_dr_severe_npdr_with_dme"],
    ["severe", "absent", "t2_dr_severe_npdr_without_dme"],
  ] as const) {
    assert.deepEqual(await ocularCandidateKeys("ocular-health:posterior:fundus", {
      OD: {
        selections: ["diabetic-retinopathy-background-npdr"],
        findingDetails: { "diabetic-retinopathy-background-npdr": { severity, "macular-edema": macularEdema } },
      },
    }), [[diagnosisKey]]);
  }

  for (const [severity, diagnosisKey] of [
    ["with-macular-edema", "t2_dr_pdr_with_dme"],
    ["traction-rd-involving-macula", "t2_dr_pdr_trd_involving_macula"],
    ["traction-rd-not-involving-macula", "t2_dr_pdr_trd_not_involving_macula"],
    ["combined-traction-rhegmatogenous-rd", "t2_dr_pdr_combined_trd_rrd"],
    ["stable", "t2_dr_stable_pdr"],
    ["without-macular-edema", "t2_dr_pdr_without_dme"],
  ] as const) {
    assert.deepEqual(await ocularCandidateKeys("ocular-health:posterior:fundus", {
      OD: {
        selections: ["proliferative-diabetic-retinopathy-pdr"],
        findingDetails: { "proliferative-diabetic-retinopathy-pdr": { severity } },
      },
    }), [[diagnosisKey]]);
  }
});

test("I2 absent or partial ocular qualifiers retain the specified safe fallbacks", async () => {
  assert.deepEqual(await ocularCandidateKeys("ocular-health:anterior:conjunctiva", {
    OD: { selections: ["pterygium"], findingDetails: { pterygium: { location: "peripheral" } } },
  }), [[
    "pterygium_central",
    "pterygium_peripheral_stationary",
    "pterygium_peripheral_progressive",
    "pterygium_recurrent",
  ]]);

  assert.deepEqual(await ocularCandidateKeys("ocular-health:posterior:fundus", {
    OD: {
      selections: ["diabetic-retinopathy-background-npdr"],
      findingDetails: { "diabetic-retinopathy-background-npdr": { severity: "mild" } },
    },
    OS: { selections: ["proliferative-diabetic-retinopathy-pdr"] },
  }), [
    [
      "t2_dr_mild_npdr_with_dme",
      "t2_dr_mild_npdr_without_dme",
      "t2_dr_moderate_npdr_with_dme",
      "t2_dr_moderate_npdr_without_dme",
      "t2_dr_severe_npdr_with_dme",
      "t2_dr_severe_npdr_without_dme",
    ],
    [
      "t2_dr_pdr_with_dme",
      "t2_dr_pdr_trd_involving_macula",
      "t2_dr_pdr_trd_not_involving_macula",
      "t2_dr_pdr_combined_trd_rrd",
      "t2_dr_stable_pdr",
      "t2_dr_pdr_without_dme",
    ],
  ]);
});

test("I3 qualifier triggers are scoped to the option that recorded the shared key", () => {
  const optionATrigger = {
    kind: "qualifier" as const,
    field: "CUSTOM_FINDINGS",
    option: "option-a",
    qualifiers: { location: "peripheral" },
  };
  const finding: FindingInstance = {
    id: "qualified-finding",
    state: "committed",
    findingDefinitionId: "qualified-definition",
    patientReference: "Patient/p1",
    encounterReference: "Encounter/e1",
    laterality: "OD",
    value: { type: "components", components: [
      { code: "OD_CUSTOM_FINDINGS::option-a", display: "Option A", value: true },
      { code: "OD_CUSTOM_FINDINGS::option-b", display: "Option B", value: true },
      { code: "OD_CUSTOM_FINDINGS::option-a::location", display: "Option A location", value: "central" },
      { code: "OD_CUSTOM_FINDINGS::option-b::location", display: "Option B location", value: "peripheral" },
    ] },
    sourceType: "manual",
    recordedAt: "2026-08-04T12:00:00.000Z",
    provenance: { source: "manual", recordedAt: "2026-08-04T12:00:00.000Z" },
  };
  assert.equal(createDiagnosisCandidateSchema.safeParse({ diagnosisKey: "candidate-a", trigger: optionATrigger }).success, true);
  assert.equal(updateDiagnosisCandidateSchema.safeParse({ trigger: optionATrigger }).success, true);
  assert.equal(evaluateMappingTrigger(optionATrigger, finding), false);
  assert.equal(evaluateMappingTrigger({ ...optionATrigger, option: "option-b" }, finding), true);
});

test("I4 ocular records without findingDetails retain specific candidate lists", async () => {
  assert.deepEqual(await ocularCandidateKeys("ocular-health:anterior:conjunctiva", {
    OD: { selections: ["pterygium"] },
  }), [[
    "pterygium_central",
    "pterygium_peripheral_stationary",
    "pterygium_peripheral_progressive",
    "pterygium_recurrent",
  ]]);
  assert.deepEqual(await ocularCandidateKeys("ocular-health:anterior:cornea", {
    OD: { selections: ["keratoconus"] },
  }), [["keratoconus_stable", "keratoconus_unstable"]]);
  assert.deepEqual(await ocularCandidateKeys("ocular-health:posterior:fundus", {
    OD: { selections: ["diabetic-retinopathy-background-npdr"] },
  }), [[
    "t2_dr_mild_npdr_with_dme",
    "t2_dr_mild_npdr_without_dme",
    "t2_dr_moderate_npdr_with_dme",
    "t2_dr_moderate_npdr_without_dme",
    "t2_dr_severe_npdr_with_dme",
    "t2_dr_severe_npdr_without_dme",
  ]]);
});

test("unspecified ocular diagnosis keys never surface with qualifiers unset or set", async () => {
  const forbidden = new Set([
    "keratoconus_unspecified_stability",
    "t2_dr_unspecified_with_dme",
    "t2_dr_unspecified_without_dme",
  ]);
  const cases = [
    ["ocular-health:anterior:cornea", {
      OD: { selections: ["keratoconus"] },
    }],
    ...(["stable", "unstable"] as const).map((stability) => [
      "ocular-health:anterior:cornea",
      { OD: { selections: ["keratoconus"], findingDetails: { keratoconus: { stability } } } },
    ]),
    ["ocular-health:posterior:fundus", {
      OD: { selections: ["diabetic-retinopathy-background-npdr"] },
    }],
    ...(["mild", "moderate", "severe"] as const).flatMap((severity) =>
      (["present", "absent"] as const).map((macularEdema) => [
        "ocular-health:posterior:fundus",
        { OD: {
          selections: ["diabetic-retinopathy-background-npdr"],
          findingDetails: { "diabetic-retinopathy-background-npdr": { severity, "macular-edema": macularEdema } },
        } },
      ])
    ),
  ] as const;

  for (const [stableKey, eyes] of cases) {
    const proposed = (await ocularCandidateKeys(stableKey, eyes)).flat();
    assert.equal(
      proposed.some((diagnosisKey) => forbidden.has(diagnosisKey)),
      false,
      `${stableKey} proposed an unspecified diagnosis: ${proposed.join(", ")}`,
    );
  }
});

test("I5 qualifier components cannot diagnose or suppress without an active parent option", async () => {
  const trigger = {
    kind: "qualifier" as const,
    field: "CUSTOM_FINDINGS",
    option: "pterygium",
    qualifiers: { location: "central" },
  };
  const finding = (parent: "absent" | "false"): FindingInstance => ({
    id: `qualified-${parent}`,
    state: "committed",
    findingDefinitionId: "qualified-definition",
    patientReference: "Patient/p1",
    encounterReference: "Encounter/e1",
    laterality: "OD",
    value: { type: "components", components: [
      ...(parent === "false"
        ? [{ code: "OD_CUSTOM_FINDINGS::pterygium", display: "Pterygium", value: false }]
        : []),
      { code: "OD_CUSTOM_FINDINGS::pterygium::location", display: "Pterygium location", value: "central" },
    ] },
    sourceType: "manual",
    recordedAt: "2026-08-04T12:00:00.000Z",
    provenance: { source: "manual", recordedAt: "2026-08-04T12:00:00.000Z" },
  });
  for (const parent of ["absent", "false"] as const) {
    assert.equal(evaluateMappingTrigger(trigger, finding(parent)), false, `${parent} parent must block qualifier matching`);
    assert.deepEqual(matchingQualifierGroups(trigger, finding(parent)), [], `${parent} parent must not register a suppression group`);
  }

  for (const parent of ["absent", "false"] as const) {
    const fhir = new MemoryFhir();
    const definitions = await new FhirFindingDefinitionStore(fhir).list();
    const definition = definitions.find((candidate) => candidate.stableKey === "ocular-health:anterior:conjunctiva");
    assert.ok(definition);
    const field = Object.values(definition.valueSchema.fields as Record<string, { localCode?: string; valueType?: string }>)
      .find((candidate) => candidate.valueType === "multi-select");
    assert.ok(field?.localCode);
    const optionCode = `OD_${field.localCode}::pterygium`;
    fhir.resources.push({
      resourceType: "Observation",
      id: `qualifier-with-${parent}-parent`,
      status: "preliminary",
      code: {
        coding: [{ system: "https://odos2020.com/fhir/CodeSystem/odos", code: definition.stableKey }],
        text: definition.display,
      },
      subject: { reference: "Patient/p-qualified" },
      encounter: { reference: "Encounter/e-qualified" },
      effectiveDateTime: "2026-08-04T12:00:00.000Z",
      interpretation: [{ coding: [{ code: "A" }] }],
      extension: [{
        url: "https://odos2020.com/fhir/StructureDefinition/eye-laterality",
        valueCodeableConcept: { coding: [{ code: "OD" }] },
      }],
      component: [
        ...(parent === "false"
          ? [{ code: { coding: [{ code: optionCode }], text: "Pterygium" }, valueBoolean: false }]
          : []),
        {
          code: { coding: [{ code: `${optionCode}::location` }], text: "Pterygium — Location" },
          valueCodeableConcept: { coding: [{ code: "central" }] },
        },
      ],
    } as Observation);
    const authenticate = async () => ({
      staffReference: "Practitioner/doctor-1",
      actorRole: "clinician" as PracticeRoleId,
      fhir,
    });
    const result = await handleDiagnosisCandidatesRequest({ authenticate }, {
      authHeader: "Bearer doctor-1",
      params: { encounterId: "e-qualified" },
    });
    assert.equal(result.status, 200, JSON.stringify(result.body));
    const rows = (result.body as CandidateResponse).findings;
    assert.equal(rows.length, 1);
    assert.deepEqual(rows[0]?.candidates, [], `${parent} parent must produce no diagnosis candidate`);
  }
});

test("I6 allOf-wrapped option fallbacks are suppressed like bare option fallbacks", async () => {
  const fhir = new MemoryFhir();
  const store = new FhirFindingDefinitionStore(fhir);
  const definition = (await store.list()).find((candidate) => candidate.stableKey === "ocular-health:anterior:conjunctiva");
  assert.ok(definition);
  await store.save({
    ...definition,
    diagnosisCandidates: definition.diagnosisCandidates?.map((candidate) =>
      candidate.trigger.kind === "option" && candidate.trigger.anyOf.includes("pterygium")
        ? { ...candidate, trigger: { kind: "allOf" as const, triggers: [candidate.trigger] } }
        : candidate
    ),
  });
  const definitions = await store.list();
  const field = Object.values(definition.valueSchema.fields as Record<string, { localCode?: string; valueType?: string }>)
    .find((candidate) => candidate.valueType === "multi-select");
  assert.ok(field?.localCode);
  const authenticate = async () => ({
    staffReference: "Practitioner/doctor-1",
    actorRole: "clinician" as PracticeRoleId,
    fhir,
  });
  const capture = await handleCustomSectionCaptureRequest({
    authenticate,
    findingDefinitions: () => definitions,
    now: () => "2026-08-04T12:00:00.000Z",
  }, {
    authHeader: "Bearer doctor-1",
    params: { stableKey: definition.stableKey },
    body: {
      patientReference: "Patient/p-qualified",
      encounterReference: "Encounter/e-qualified",
      eyes: { OD: {
        state: "abnormal",
        customFields: [{ code: field.localCode, value: ["pterygium"] }],
        findingDetails: { pterygium: { location: "central" } },
      } },
    },
  });
  assert.equal(capture.status, 200, JSON.stringify(capture.body));
  const result = await handleDiagnosisCandidatesRequest({ authenticate }, {
    authHeader: "Bearer doctor-1",
    params: { encounterId: "e-qualified" },
  });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.deepEqual(
    (result.body as CandidateResponse).findings.map((finding) =>
      finding.candidates.map((candidate) => candidate.diagnosisKey)
    ),
    [["pterygium_central"]],
  );
});

test("direct laterality-required picks ask once, then write no fabricated evidence, and evaluators contain no pick call site", async () => {
  const fhir = new MemoryFhir();
  fhir.resources.push({
    resourceType: "Encounter", id: "e1", status: "in-progress",
    class: { system: "http://terminology.hl7.org/CodeSystem/v3-ActCode", code: "AMB" },
    subject: { reference: "Patient/p1" },
  } as Encounter);
  const result = await handleDiagnosisPickRequest({
    authenticate: async () => ({ staffReference: "Practitioner/doctor-1", actorRole: "clinician", fhir }),
  }, {
    authHeader: "Bearer doctor-1",
    params: { encounterId: "e1" },
    body: { diagnosisKey: "myopia", action: "confirm" },
  });
  assert.equal(result.status, 422);
  assert.match(String((result.body as { error: string }).error), /requires laterality/);
  const discard = await handleDiagnosisPickRequest({
    authenticate: async () => ({ staffReference: "Practitioner/doctor-1", actorRole: "clinician", fhir }),
  }, {
    authHeader: "Bearer doctor-1",
    params: { encounterId: "e1" },
    body: { diagnosisKey: "myopia", action: "discard" },
  });
  assert.equal(discard.status, 422);
  assert.match(String((discard.body as { error: string }).error), /requires laterality/);
  const explicit = await handleDiagnosisPickRequest({
    authenticate: async () => ({ staffReference: "Practitioner/doctor-1", actorRole: "clinician", fhir }),
    now: () => "2026-07-11T16:00:00.000Z",
  }, {
    authHeader: "Bearer doctor-1",
    params: { encounterId: "e1" },
    body: { diagnosisKey: "myopia", action: "confirm", laterality: "OD" },
  });
  assert.equal(explicit.status, 201);
  const directCondition = (explicit.body as { condition: Condition }).condition;
  assert.equal(directCondition.code?.coding?.[0]?.code, sourcedDiagnosisCode("myopia", "right"));
  assert.equal(directCondition.evidence, undefined);
  for (const file of ["glaucoma-suspect.ts", "refraction-suspect.ts", "diagnosis-mapping.ts"]) {
    const source = readFileSync(new URL(`../src/clinical-graph/${file}`, import.meta.url), "utf8");
    assert.doesNotMatch(source, /handleDiagnosisPickRequest|diagnosis-picks/);
  }
});

test("visual-field descriptors derive every approved code while preserving the descriptor through reload", async () => {
  const cases = [
    ["no-defect", "No defect", undefined, undefined],
    ["field-loss-od", "Field loss OD", "vf_other_localized", "H53.451"],
    ["field-loss-os", "Field loss OS", "vf_other_localized", "H53.452"],
    ["bitemporal-hemianopsia", "Bitemporal hemianopsia", "vf_heteronymous_bilateral", "H53.47"],
    ["right-homonymous-hemianopsia", "Right homonymous hemianopsia", "vf_homonymous_bilateral", "H53.461"],
    ["left-homonymous-hemianopsia", "Left homonymous hemianopsia", "vf_homonymous_bilateral", "H53.462"],
    ["superior-right-homonymous-quadrantanopia", "Superior right homonymous quadrantanopia", "vf_homonymous_bilateral", "H53.461"],
    ["inferior-right-homonymous-quadrantanopia", "Inferior right homonymous quadrantanopia", "vf_homonymous_bilateral", "H53.461"],
    ["superior-left-homonymous-quadrantanopia", "Superior left homonymous quadrantanopia", "vf_homonymous_bilateral", "H53.462"],
    ["inferior-left-homonymous-quadrantanopia", "Inferior left homonymous quadrantanopia", "vf_homonymous_bilateral", "H53.462"],
  ] as const;

  for (const [descriptor, display, diagnosisKey, code] of cases) {
    const fhir = new MemoryFhir();
    const definitions = await new FhirFindingDefinitionStore(fhir).list();
    const definition = definitions.find((candidate) => candidate.stableKey === "entrance:visual-field-defect");
    assert.ok(definition, `Missing visual-field definition for ${descriptor}`);
    const authenticate = async () => ({
      staffReference: "Practitioner/doctor-1",
      actorRole: "clinician" as PracticeRoleId,
      fhir,
    });
    const capture = await handleCustomSectionCaptureRequest({
      authenticate,
      findingDefinitions: () => definitions,
      now: () => "2026-08-05T14:00:00.000Z",
    }, {
      authHeader: "Bearer doctor-1",
      params: { stableKey: definition.stableKey },
      body: {
        patientReference: "Patient/vf",
        encounterReference: "Encounter/vf",
        customFields: [{ code: "CUSTOM_FIELD_DEFECT", value: descriptor }],
      },
    });
    assert.equal(capture.status, 200, JSON.stringify(capture.body));
    const observationReference = (capture.body as { observationReference: string }).observationReference;
    const observation = fhir.resources.find((resource): resource is Observation =>
      resource.resourceType === "Observation" && `Observation/${resource.id}` === observationReference
    );
    assert.ok(observation);
    const storedDescriptor = observation.component?.find((component) =>
      component.code.coding?.some((coding) => coding.code === "CUSTOM_FIELD_DEFECT")
    )?.valueCodeableConcept?.coding?.[0];
    assert.deepEqual([storedDescriptor?.code, storedDescriptor?.display], [descriptor, display]);

    const history = await handleCustomSectionHistoryRequest({
      authenticate,
      findingDefinitions: () => definitions,
    }, {
      authHeader: "Bearer doctor-1",
      params: { stableKey: definition.stableKey },
      query: { patient: "Patient/vf", encounter: "Encounter/vf" },
    });
    assert.equal(history.status, 200, JSON.stringify(history.body));
    assert.deepEqual(
      (history.body as { rows: Array<{ observationReference?: string; values: Array<{ value: unknown }> }> }).rows
        .map((row) => [row.observationReference, row.values[0]?.value]),
      [[observationReference, display]],
    );

    const candidates = await handleDiagnosisCandidatesRequest({ authenticate }, {
      authHeader: "Bearer doctor-1",
      params: { encounterId: "vf" },
    });
    assert.equal(candidates.status, 200, JSON.stringify(candidates.body));
    const finding = (candidates.body as CandidateResponse).findings.find((row) =>
      row.observationReference === observationReference
    );
    assert.ok(finding);
    if (!diagnosisKey || !code) {
      assert.deepEqual(finding.candidates, []);
      continue;
    }
    assert.deepEqual(
      finding.candidates.map((candidate) => [candidate.diagnosisKey, candidate.icd10?.code]),
      [[diagnosisKey, code]],
    );
    const pick = await handleDiagnosisPickRequest({ authenticate }, {
      authHeader: "Bearer doctor-1",
      params: { encounterId: "vf" },
      body: { findingInstanceId: observationReference, diagnosisKey, action: "confirm", source: "mapping" },
    });
    assert.equal(pick.status, 201, JSON.stringify(pick.body));
    assert.equal((pick.body as { condition: Condition }).condition.code?.coding?.[0]?.code, code);
    assert.equal(storedDescriptor?.display, display);
  }
});

test("staged glaucoma visibly suppresses only the visual-field proposal and override never changes glaucoma stage", async () => {
  const fhir = new MemoryFhir();
  const definitions = await new FhirFindingDefinitionStore(fhir).list();
  const definition = definitions.find((candidate) => candidate.stableKey === "entrance:visual-field-defect");
  assert.ok(definition);
  const authenticate = async () => ({
    staffReference: "Practitioner/doctor-1",
    actorRole: "clinician" as PracticeRoleId,
    fhir,
  });
  const capture = await handleCustomSectionCaptureRequest({
    authenticate,
    findingDefinitions: () => definitions,
    now: () => "2026-08-05T14:00:00.000Z",
  }, {
    authHeader: "Bearer doctor-1",
    params: { stableKey: definition.stableKey },
    body: {
      patientReference: "Patient/vf",
      encounterReference: "Encounter/vf",
      customFields: [{ code: "CUSTOM_FIELD_DEFECT", value: "field-loss-od" }],
    },
  });
  assert.equal(capture.status, 200, JSON.stringify(capture.body));
  const observationReference = (capture.body as { observationReference: string }).observationReference;

  const stagedGlaucoma = {
    resourceType: "Condition",
    id: "staged-glaucoma",
    subject: { reference: "Patient/vf" },
    encounter: { reference: "Encounter/vf" },
    code: { coding: [{ system: "http://hl7.org/fhir/sid/icd-10-cm", code: "H40.ZZZ2" }] },
    verificationStatus: { coding: [{ code: "confirmed" }] },
    stage: [{ summary: { text: "Operator-entered stage" } }],
  } as Condition;
  fhir.resources.push({
    resourceType: "Condition",
    id: "unstaged-glaucoma",
    subject: { reference: "Patient/vf" },
    encounter: { reference: "Encounter/vf" },
    code: { coding: [{ system: "http://hl7.org/fhir/sid/icd-10-cm", code: "H40.021" }] },
    verificationStatus: { coding: [{ code: "confirmed" }] },
  } as Condition, {
    resourceType: "Condition",
    id: "unconfirmed-staged-glaucoma",
    subject: { reference: "Patient/vf" },
    encounter: { reference: "Encounter/vf" },
    code: { coding: [{ system: "http://hl7.org/fhir/sid/icd-10-cm", code: "H40.ZZZ1" }] },
    verificationStatus: { coding: [{ code: "provisional" }] },
  } as Condition, {
    resourceType: "Condition",
    id: "other-encounter-stage",
    subject: { reference: "Patient/vf" },
    encounter: { reference: "Encounter/other" },
    code: { coding: [{ system: "http://hl7.org/fhir/sid/icd-10-cm", code: "H40.ZZZ3" }] },
    verificationStatus: { coding: [{ code: "confirmed" }] },
  } as Condition);
  const unsuppressed = await handleDiagnosisCandidatesRequest({ authenticate }, {
    authHeader: "Bearer doctor-1",
    params: { encounterId: "vf" },
  });
  const unsuppressedFinding = (unsuppressed.body as CandidateResponse).findings.find((row) =>
    row.observationReference === observationReference
  );
  assert.deepEqual(unsuppressedFinding?.candidates.map((candidate) => candidate.icd10?.code), ["H53.451"]);
  assert.equal(unsuppressedFinding?.suppression, undefined);

  fhir.resources.push(stagedGlaucoma);
  const stagedBefore = structuredClone(fhir.resources.find((resource) => resource.id === "staged-glaucoma"));
  const writesBefore = fhir.writes.length;

  const candidates = await handleDiagnosisCandidatesRequest({ authenticate }, {
    authHeader: "Bearer doctor-1",
    params: { encounterId: "vf" },
  });
  assert.equal(candidates.status, 200, JSON.stringify(candidates.body));
  const finding = (candidates.body as CandidateResponse).findings.find((row) =>
    row.observationReference === observationReference
  );
  assert.ok(finding);
  assert.deepEqual(finding.candidates, []);
  assert.deepEqual(finding.suppressedCandidates?.map((candidate) => candidate.icd10?.code), ["H53.451"]);
  assert.deepEqual(finding.suppression, {
    message: "H53.4x not proposed — the glaucoma stage already carries the field defect.",
    overridable: true,
  });
  assert.deepEqual(fhir.resources.find((resource) => resource.id === "staged-glaucoma"), stagedBefore);
  assert.equal(fhir.writes.length, writesBefore);

  const override = await handleDiagnosisPickRequest({ authenticate }, {
    authHeader: "Bearer doctor-1",
    params: { encounterId: "vf" },
    body: {
      findingInstanceId: observationReference,
      diagnosisKey: "vf_other_localized",
      action: "confirm",
      source: "mapping",
    },
  });
  assert.equal(override.status, 201, JSON.stringify(override.body));
  assert.equal((override.body as { condition: Condition }).condition.code?.coding?.[0]?.code, "H53.451");
  assert.deepEqual(fhir.resources.find((resource) => resource.id === "staged-glaucoma"), stagedBefore);
});

test("homonymous field-side picks never derive field side from eye laterality", async () => {
  const fhir = diagnosisPickFhir();
  const pick = (laterality: "OD" | "OS" | "OU") => handleDiagnosisPickRequest({
    authenticate: async () => ({ staffReference: "Practitioner/doctor-1", actorRole: "clinician", fhir }),
    now: () => "2026-08-05T12:00:00.000Z",
  }, {
    authHeader: "Bearer doctor-1",
    params: { encounterId: "e1" },
    body: { diagnosisKey: "vf_homonymous_bilateral", action: "confirm", laterality },
  });

  const od = await pick("OD");
  const os = await pick("OS");
  const ou = await pick("OU");
  assert.equal(od.status, 201);
  assert.equal(os.status, 200);
  assert.equal(ou.status, 200);
  assert.equal((od.body as { condition: Condition }).condition.code?.coding?.[0]?.code, "H53.469");
  assert.equal((os.body as { condition: Condition }).condition.code?.coding?.[0]?.code, "H53.469");
  assert.equal((ou.body as { condition: Condition }).condition.code?.coding?.[0]?.code, "H53.469");
  assert.equal(fhir.resources.filter((resource) => resource.resourceType === "Condition").length, 1);
});

test("a concurrent Condition update returns 409 without silently retrying the clinician decision", async () => {
  class ConcurrentUpdateFhir extends MemoryFhir {
    conflictOnConditionUpdate = false;

    override async update<T extends Resource>(resourceType: T["resourceType"], id: string, resource: T, headers?: Record<string, string>): Promise<T> {
      if (resourceType === "Condition" && this.conflictOnConditionUpdate) {
        this.conflictOnConditionUpdate = false;
        const current = this.resources.find((candidate) => candidate.resourceType === resourceType && candidate.id === id)!;
        current.meta = { ...(current.meta ?? {}), versionId: String(Number(current.meta?.versionId ?? "0") + 1) };
      }
      return super.update(resourceType, id, resource, headers);
    }
  }

  const fhir = new ConcurrentUpdateFhir();
  const seeded = diagnosisPickFhir();
  fhir.resources.push(...seeded.resources);
  const pick = (action: "possible" | "confirm") => handleDiagnosisPickRequest({
    authenticate: async () => ({ staffReference: "Practitioner/doctor-1", actorRole: "clinician", fhir }),
    now: () => "2026-07-11T16:00:00.000Z",
  }, {
    authHeader: "Bearer doctor-1",
    params: { encounterId: "e1" },
    body: {
      findingInstanceId: "Observation/finding-od",
      diagnosisKey: "glaucoma_suspect_open_angle_low",
      action,
    },
  });

  assert.equal((await pick("possible")).status, 201);
  fhir.conflictOnConditionUpdate = true;
  const result = await pick("confirm");
  assert.equal(result.status, 409);
  assert.match(String((result.body as { error: string }).error), /reload and retry/);
  const condition = fhir.resources.find((resource): resource is Condition => resource.resourceType === "Condition")!;
  assert.equal(condition.verificationStatus?.coding?.[0]?.code, "provisional");
  assert.equal(fhir.writes.filter((write) => write.resourceType === "Condition" && write.operation === "update").length, 0);
});

test("laterality-keyed picks keep both eyes distinct, escalate one eye, and discard only its Condition", async () => {
  const fhir = diagnosisPickFhir();
  const pick = (body: Record<string, unknown>) => handleDiagnosisPickRequest({
    authenticate: async () => ({ staffReference: "Practitioner/doctor-1", actorRole: "clinician", fhir }),
    now: () => "2026-07-11T16:00:00.000Z",
  }, { authHeader: "Bearer doctor-1", params: { encounterId: "e1" }, body });

  const possibleOd = await pick({
    findingInstanceId: "Observation/finding-od",
    diagnosisKey: "glaucoma_suspect_open_angle_low",
    action: "possible",
  });
  assert.equal(possibleOd.status, 201);
  assert.equal((possibleOd.body as { condition: Condition }).condition.verificationStatus?.coding?.[0]?.code, "provisional");

  const confirmOd = await pick({
    findingInstanceId: "Observation/finding-od",
    diagnosisKey: "glaucoma_suspect_open_angle_low",
    action: "confirm",
  });
  assert.equal(confirmOd.status, 200);
  assert.equal(fhir.resources.filter((resource) => resource.resourceType === "Condition").length, 1);

  const confirmOs = await pick({
    findingInstanceId: "Observation/finding-os",
    diagnosisKey: "glaucoma_suspect_open_angle_low",
    action: "confirm",
  });
  assert.equal(confirmOs.status, 201);
  const conditions = fhir.resources.filter((resource): resource is Condition => resource.resourceType === "Condition");
  assert.equal(conditions.length, 2);
  assert.deepEqual(new Set(conditions.map((condition) => condition.code?.coding?.[0]?.code)), new Set([
    sourcedDiagnosisCode("glaucoma_suspect_open_angle_low", "right"),
    sourcedDiagnosisCode("glaucoma_suspect_open_angle_low", "left"),
  ]));
  assert.equal(conditions.find((condition) => condition.code?.coding?.[0]?.code === sourcedDiagnosisCode("glaucoma_suspect_open_angle_low", "right"))
    ?.evidence?.some((evidence) => evidence.detail?.some((detail) => detail.reference === "Observation/finding-od")), true);
  assert.equal(conditions.find((condition) => condition.code?.coding?.[0]?.code === sourcedDiagnosisCode("glaucoma_suspect_open_angle_low", "left"))
    ?.evidence?.some((evidence) => evidence.detail?.some((detail) => detail.reference === "Observation/finding-os")), true);

  const discardOd = await pick({
    findingInstanceId: "Observation/finding-od",
    diagnosisKey: "glaucoma_suspect_open_angle_low",
    action: "discard",
  });
  assert.equal(discardOd.status, 200);
  const discardedConditions = fhir.resources.filter((resource): resource is Condition => resource.resourceType === "Condition");
  assert.equal(discardedConditions.find((condition) => condition.code?.coding?.[0]?.code === sourcedDiagnosisCode("glaucoma_suspect_open_angle_low", "right"))
    ?.verificationStatus?.coding?.[0]?.code, "refuted");
  assert.equal(discardedConditions.find((condition) => condition.code?.coding?.[0]?.code === sourcedDiagnosisCode("glaucoma_suspect_open_angle_low", "left"))
    ?.verificationStatus?.coding?.[0]?.code, "confirmed");
});

test("conditional create makes identical same-eye Possible double-submit idempotent", async () => {
  const fhir = diagnosisPickFhir();
  const request = () => handleDiagnosisPickRequest({
    authenticate: async () => ({ staffReference: "Practitioner/doctor-1", actorRole: "clinician", fhir }),
    now: () => "2026-07-11T16:00:00.000Z",
  }, {
    authHeader: "Bearer doctor-1",
    params: { encounterId: "e1" },
    body: {
      findingInstanceId: "Observation/finding-od",
      diagnosisKey: "glaucoma_suspect_open_angle_low",
      action: "possible",
    },
  });

  await Promise.all([request(), request()]);
  const conditions = fhir.resources.filter((resource): resource is Condition => resource.resourceType === "Condition");
  assert.equal(conditions.length, 1);
  assert.equal(conditions[0]?.verificationStatus?.coding?.[0]?.code, "provisional");
  assert.equal(fhir.writes.filter((write) => write.resourceType === "Condition" && write.operation === "create").length, 1);
  assert.equal(fhir.writes.find((write) => write.resourceType === "Condition")?.headers?.["If-None-Exist"],
    "identifier=https://odos2020.com/fhir/NamingSystem/diagnosis-catalog-stable-key|e1::glaucoma_suspect_open_angle_low::right");
});

test("a failed tally side effect never fails a successful explicit diagnosis pick", async () => {
  class TallyFailFhir extends MemoryFhir {
    override async create<T extends Resource>(resource: T, headers?: Record<string, string>): Promise<T> {
      if (resource.resourceType === "Basic" && (resource as Basic).code.coding?.some((coding) => coding.code === DX_PICK_TALLY_CODE)) {
        throw new Error("simulated tally outage");
      }
      return super.create(resource, headers);
    }
  }
  const fhir = new TallyFailFhir();
  fhir.resources.push({
    resourceType: "Encounter", id: "e1", status: "in-progress",
    class: { system: "http://terminology.hl7.org/CodeSystem/v3-ActCode", code: "AMB" },
    subject: { reference: "Patient/p1" },
  } as Encounter, {
    resourceType: "Observation", id: "finding-1", status: "preliminary",
    code: { coding: [{ system: "https://odos2020.com/fhir/CodeSystem/odos", code: "cup_disc_ratio" }], text: "Cup/Disc" },
    subject: { reference: "Patient/p1" }, encounter: { reference: "Encounter/e1" },
    effectiveDateTime: "2026-07-11T16:00:00.000Z", valueQuantity: { value: 0.6, unit: "ratio" },
    extension: [{ url: "https://odos2020.com/fhir/StructureDefinition/eye-laterality", valueCodeableConcept: { coding: [{ code: "OD" }] } }],
  } as Observation);
  const originalError = console.error;
  const errors: string[] = [];
  console.error = (...values) => errors.push(values.map(String).join(" "));
  try {
    const result = await handleDiagnosisPickRequest({
      authenticate: async () => ({ staffReference: "Practitioner/doctor-1", actorRole: "clinician", fhir }),
      now: () => "2026-07-11T16:00:00.000Z",
    }, {
      authHeader: "Bearer doctor-1",
      params: { encounterId: "e1" },
      body: { findingInstanceId: "finding-1", diagnosisKey: "glaucoma_suspect_open_angle_low", action: "confirm" },
    });
    assert.equal(result.status, 201);
    assert.equal(fhir.resources.some((resource) => resource.resourceType === "Condition"), true);
    assert.equal(errors.some((message) => message.includes("simulated tally outage")), true);
  } finally {
    console.error = originalError;
  }
});

test("dedup keeps rule evidence and the higher-priority mapping when no rule exists", () => {
  const rows = deduplicateDiagnosisCandidates([
    { diagnosisKey: "alpha", display: "Alpha", codingStatus: "verified", priority: true, source: "mapping", order: 0 },
    { diagnosisKey: "alpha", display: "Alpha", codingStatus: "verified", priority: false, source: "rule", order: 9 },
    { diagnosisKey: "beta", display: "Beta", codingStatus: "verified", priority: false, source: "mapping", order: 0 },
    { diagnosisKey: "beta", display: "Beta", codingStatus: "verified", priority: true, source: "mapping", order: 3 },
  ]);
  assert.equal(rows.find((row) => row.diagnosisKey === "alpha")?.source, "rule");
  assert.equal(rows.find((row) => row.diagnosisKey === "beta")?.priority, true);
});

type CandidateResponse = {
  findings: Array<{
    observationReference?: string;
    candidates: Array<{ diagnosisKey: string; source: string; icd10?: { code?: string } }>;
    suppressedCandidates?: Array<{ diagnosisKey: string; source: string; icd10?: { code?: string } }>;
    suppression?: { message: string; overridable: boolean };
  }>;
};

async function ocularCandidateKeys(
  stableKey: string,
  eyes: Partial<Record<"OD" | "OS", {
    selections: string[];
    findingDetails?: Record<string, Record<string, string>>;
  }>>,
): Promise<string[][]> {
  const fhir = new MemoryFhir();
  const definitions = await new FhirFindingDefinitionStore(fhir).list();
  const definition = definitions.find((candidate) => candidate.stableKey === stableKey);
  assert.ok(definition);
  const field = Object.values(definition.valueSchema.fields as Record<string, { localCode?: string; valueType?: string }>)
    .find((candidate) => candidate.valueType === "multi-select");
  assert.ok(field?.localCode);
  const authenticate = async () => ({
    staffReference: "Practitioner/doctor-1",
    actorRole: "clinician" as PracticeRoleId,
    fhir,
  });
  const capture = await handleCustomSectionCaptureRequest({
    authenticate,
    findingDefinitions: () => definitions,
    now: () => "2026-08-04T12:00:00.000Z",
  }, {
    authHeader: "Bearer doctor-1",
    params: { stableKey },
    body: {
      patientReference: "Patient/p-qualified",
      encounterReference: "Encounter/e-qualified",
      eyes: Object.fromEntries(Object.entries(eyes).map(([eye, row]) => [eye, {
        state: "abnormal",
        customFields: [{ code: field.localCode, value: row.selections }],
        ...(row.findingDetails ? { findingDetails: row.findingDetails } : {}),
      }])),
    },
  });
  assert.equal(capture.status, 200, JSON.stringify(capture.body));
  const result = await handleDiagnosisCandidatesRequest({ authenticate }, {
    authHeader: "Bearer doctor-1",
    params: { encounterId: "e-qualified" },
  });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  return (result.body as CandidateResponse).findings.map((finding) =>
    finding.candidates.map((candidate) => candidate.diagnosisKey)
  );
}

function diagnosisPickFhir(): MemoryFhir {
  const fhir = new MemoryFhir();
  fhir.resources.push({
    resourceType: "Encounter", id: "e1", status: "in-progress",
    class: { system: "http://terminology.hl7.org/CodeSystem/v3-ActCode", code: "AMB" },
    subject: { reference: "Patient/p1" },
  } as Encounter, ...(["OD", "OS"] as const).map((eye) => ({
    resourceType: "Observation",
    id: `finding-${eye.toLowerCase()}`,
    status: "preliminary",
    code: { coding: [{ system: "https://odos2020.com/fhir/CodeSystem/odos", code: "cup_disc_ratio" }], text: "Cup/Disc" },
    subject: { reference: "Patient/p1" },
    encounter: { reference: "Encounter/e1" },
    effectiveDateTime: "2026-07-11T16:00:00.000Z",
    valueQuantity: { value: 0.6, unit: "ratio" },
    extension: [{ url: "https://odos2020.com/fhir/StructureDefinition/eye-laterality", valueCodeableConcept: { coding: [{ code: eye }] } }],
  } as Observation)));
  return fhir;
}

function sourcedDiagnosisCode(
  stableKey: string,
  laterality: "right" | "left" | "bilateral" | "unspecifiedEye",
): string {
  const row = buildDiagnosisCatalogSeeds().find((candidate) => candidate.stableKey === stableKey);
  if (!row?.icd10 || "code" in row.icd10) throw new Error(`Diagnosis ${stableKey} has no sourced laterality pattern.`);
  const code = row.icd10.pattern[laterality];
  if (!code || (row.provenance.ledgerRefs?.length ?? 0) < 2) throw new Error(`Diagnosis ${stableKey} is not backed by two ledger sources.`);
  return code;
}

async function candidates(base: string, authorization: string): Promise<CandidateResponse> {
  const response = await fetch(`${base}/clinical-graph/encounters/e1/diagnosis-candidates`, { headers: { Authorization: authorization } });
  const body = await response.json() as CandidateResponse;
  assert.equal(response.status, 200, JSON.stringify(body));
  return body;
}

async function post(base: string, path: string, body: unknown, authorization: string, expected = 200): Promise<unknown> {
  const response = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { Authorization: authorization, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const result = await response.json();
  assert.equal(response.status, expected, JSON.stringify(result));
  return result;
}
