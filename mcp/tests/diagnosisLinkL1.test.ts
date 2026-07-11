import assert from "node:assert/strict";
import { test } from "node:test";
import type { AddressInfo } from "node:net";
import type { Basic, Bundle, Observation, Provenance, Resource } from "@medplum/fhirtypes";
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
    "hyperopia",
    "myopia",
    "astigmatism",
    "anisometropia",
    "presbyopia",
  ]);
  assert.deepEqual((seeds.find((row) => row.stableKey === "myopia")?.icd10 as { pattern: object }).pattern, {
    unspecifiedEye: "H52.10",
    right: "H52.11",
    left: "H52.12",
    bilateral: "H52.13",
  });
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

test("mapping evaluator fails closed for malformed and unknown fields", () => {
  const finding: FindingInstance = {
    id: "finding-1",
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
  const authenticate = async (header: string | undefined) => header === AUTH || header === "Bearer chart" ? {
    staffReference: "Practitioner/admin-1",
    actorRole: (header === AUTH ? "practice-admin" : "clinician") as PracticeRoleId,
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
  const compiled = await get(base, "/clinical-graph/encounters/e1/diagnosis-candidates", "Bearer chart") as {
    findings: Array<{ findingDefinitionKey: string; candidates: Array<{ icd10?: { code?: string }; source: string }> }>;
  };
  assert.equal(
    compiled.findings.find((row) => row.findingDefinitionKey === "cup_disc_ratio")?.candidates[0]?.icd10?.code,
    cupDisc.eyes.OD.icd10Code,
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
  assert.equal(fhir.writes.some((write) => write.headers?.["X-OSOD-Source"] === FINDING_DEFINITION_WRITE_HEADERS["X-OSOD-Source"]), true);
  assert.equal(fhir.writes.some((write) => write.headers?.["X-OSOD-Source"] === DIAGNOSIS_CATALOG_WRITE_HEADERS["X-OSOD-Source"]), true);
  assert.equal(fhir.resources.some((resource) => resource.resourceType === "Condition"), false);
  assert.equal(fhir.resources.filter((resource) => resource.resourceType === "Basic").some((resource) => (resource as Basic).code?.coding?.some((coding) => coding.system === DIAGNOSIS_DEFINITION_CODE_SYSTEM && coding.code === DIAGNOSIS_DEFINITION_CODE)), true);
});

async function request(base: string, path: string, body: unknown, expected = 200, auth = AUTH): Promise<Record<string, unknown>> {
  const response = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { Authorization: auth, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const result = await response.json() as Record<string, unknown>;
  assert.equal(response.status, expected, JSON.stringify(result));
  return result;
}

async function get(base: string, path: string, auth = AUTH): Promise<unknown> {
  const response = await fetch(`${base}${path}`, { headers: { Authorization: auth } });
  const result = await response.json();
  assert.equal(response.status, 200, JSON.stringify(result));
  return result;
}
