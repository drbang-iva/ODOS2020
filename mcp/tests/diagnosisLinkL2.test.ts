import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import type { AddressInfo } from "node:net";
import type { Basic, Bundle, Condition, Encounter, Observation, Provenance, Resource } from "@medplum/fhirtypes";
import express from "express";
import type { PracticeRoleId } from "../src/authz/roles.js";
import { handleCupDiscCaptureRequest } from "../src/clinical-graph/cup-disc-endpoint.js";
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
    "identifier=https://osod.dev/fhir/NamingSystem/diagnosis-catalog-stable-key|glaucoma_suspect_open_angle_low::right");
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
    code: { coding: [{ system: "https://osod.dev/fhir/CodeSystem/osod", code: "cup_disc_ratio" }], text: "Cup/Disc" },
    subject: { reference: "Patient/p1" }, encounter: { reference: "Encounter/e1" },
    effectiveDateTime: "2026-07-11T16:00:00.000Z", valueQuantity: { value: 0.6, unit: "ratio" },
    extension: [{ url: "https://osod.dev/fhir/StructureDefinition/eye-laterality", valueCodeableConcept: { coding: [{ code: "OD" }] } }],
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
  findings: Array<{ observationReference?: string; candidates: Array<{ diagnosisKey: string; source: string }> }>;
};

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
    code: { coding: [{ system: "https://osod.dev/fhir/CodeSystem/osod", code: "cup_disc_ratio" }], text: "Cup/Disc" },
    subject: { reference: "Patient/p1" },
    encounter: { reference: "Encounter/e1" },
    effectiveDateTime: "2026-07-11T16:00:00.000Z",
    valueQuantity: { value: 0.6, unit: "ratio" },
    extension: [{ url: "https://osod.dev/fhir/StructureDefinition/eye-laterality", valueCodeableConcept: { coding: [{ code: eye }] } }],
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
