import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import type { Basic, Bundle, Condition, Encounter, Observation, Resource } from "@medplum/fhirtypes";
import express from "express";
import type { PracticeRoleId } from "../src/authz/roles.js";
import {
  handleDiagnosisCatalogListRequest,
  handleDiagnosisCatalogMutationRequest,
} from "../src/clinical-graph/diagnosis-catalog-endpoint.js";
import {
  buildDiagnosisCatalogResource,
  buildDiagnosisCatalogSeeds,
} from "../src/clinical-graph/diagnosis-catalog-store.js";
import { handleDiagnosisCompletenessRequest } from "../src/clinical-graph/diagnosis-completeness-endpoint.js";
import { DIAGNOSIS_KEY_IDENTIFIER_SYSTEM } from "../src/clinical-graph/diagnosis-pick-endpoint.js";

const AUTH_ADMIN = "Bearer admin";
const AUTH_CLINICIAN = "Bearer clinician";

test("L3 ships empty-tolerant with no seeded clinical key findings or windows", () => {
  assert.equal(buildDiagnosisCatalogSeeds().every((row) => row.keyFindings?.length === 0), true);
});

test("persisted diagnosis rows enforce the same key-finding bounds as mutations", () => {
  const seed = buildDiagnosisCatalogSeeds()[0]!;
  const entry = {
    findingKey: "finding",
    satisfiedBy: "any-on-file" as const,
    withinMonths: 12,
    origin: "practice" as const,
    active: true,
  };
  assert.throws(
    () => buildDiagnosisCatalogResource({
      ...seed,
      keyFindings: Array.from({ length: 65 }, (_, index) => ({ ...entry, findingKey: `finding_${index}` })),
    }),
    /more than 64/,
  );
  assert.throws(
    () => buildDiagnosisCatalogResource({ ...seed, keyFindings: [{ ...entry, label: "x".repeat(161) }] }),
    /label is invalid/,
  );
  assert.throws(
    () => buildDiagnosisCatalogResource({ ...seed, keyFindings: [{ ...entry, withinMonths: 1_201 }] }),
    /between 1 and 1,200/,
  );
});

class MemoryFhir {
  readonly resources: Resource[] = [];
  readonly followedUrls: string[] = [];

  async read<T extends Resource>(resourceType: T["resourceType"], id: string): Promise<T> {
    const resource = this.resources.find((row) => row.resourceType === resourceType && row.id === id);
    if (!resource) throw new Error(`Missing ${resourceType}/${id}`);
    return structuredClone(resource as T);
  }

  async search<T extends Resource>(resourceType: T["resourceType"], params: Record<string, string> = {}): Promise<Bundle<T>> {
    const resources = this.filtered(resourceType, params);
    if (resourceType === "Observation" && params.subject && resources.length > 1) {
      return bundle(resources.slice(0, 1) as T[], "memory://Observation/history-page-2");
    }
    return bundle(resources as T[]);
  }

  async searchUrl<T extends Resource>(url: string, resourceType: T["resourceType"]): Promise<Bundle<T>> {
    this.followedUrls.push(url);
    if (url !== "memory://Observation/history-page-2" || resourceType !== "Observation") {
      throw new Error(`Unexpected next URL ${url}`);
    }
    return bundle(this.filtered("Observation", { subject: "Patient/p1" }).slice(1) as T[]);
  }

  async create<T extends Resource>(resource: T): Promise<T> {
    const persisted = { ...resource, id: resource.id ?? `${resource.resourceType.toLowerCase()}-${this.resources.length + 1}` } as T;
    this.resources.push(persisted);
    return structuredClone(persisted);
  }

  async update<T extends Resource>(resourceType: T["resourceType"], id: string, resource: T): Promise<T> {
    const index = this.resources.findIndex((row) => row.resourceType === resourceType && row.id === id);
    if (index < 0) throw new Error(`Missing ${resourceType}/${id}`);
    const persisted = { ...resource, id } as T;
    this.resources[index] = persisted;
    return structuredClone(persisted);
  }

  private filtered(resourceType: Resource["resourceType"], params: Record<string, string>): Resource[] {
    return this.resources.filter((resource) => resource.resourceType === resourceType).filter((resource) => {
      if (resourceType === "Basic" && params.code) {
        return (resource as Basic).code?.coding?.some((coding) => `${coding.system}|${coding.code}` === params.code);
      }
      if (resourceType === "Condition" && params.encounter) {
        return (resource as Condition).encounter?.reference === params.encounter;
      }
      if (resourceType === "Observation" && params.encounter) {
        return (resource as Observation).encounter?.reference === params.encounter;
      }
      if (resourceType === "Observation" && params.subject) {
        return (resource as Observation).subject?.reference === params.subject;
      }
      return true;
    });
  }
}

test("real HTTP L3 routes persist ordered key findings and report only unsatisfied findings for active confirmed diagnoses", async (t) => {
  const fhir = new MemoryFhir();
  fhir.resources.push(encounter(), diagnosisCondition("confirmed", "glaucoma_suspect_open_angle_low", "right", "confirmed-1"));
  fhir.resources.push(diagnosisCondition("provisional", "glaucoma_suspect_open_angle_low", "left", "possible-1"));
  fhir.resources.push(diagnosisCondition("refuted", "glaucoma_suspect_open_angle_low", "bilateral", "refuted-1"));
  fhir.resources.push(diagnosisCondition("confirmed", "myopia", "right", "empty-key-findings"));
  fhir.resources.push(observation("dummy_history", "Historical placeholder", "Encounter/old", "2026-06-01T12:00:00.000Z", "history-dummy"));
  fhir.resources.push(observation("pachymetry_um", "Pachymetry", "Encounter/old", "2024-01-01T12:00:00.000Z", "history-pachymetry"));

  const authenticate = async (header: string | undefined) => {
    const actorRole = header === AUTH_ADMIN ? "practice-admin" : header === AUTH_CLINICIAN ? "clinician" : "auditor";
    return header ? { staffReference: "Practitioner/test", actorRole: actorRole as PracticeRoleId, fhir } : null;
  };
  const app = express();
  app.use(express.json());
  app.get("/clinical-graph/diagnosis-catalog", async (req, res) => {
    const result = await handleDiagnosisCatalogListRequest({ authenticate }, { authHeader: req.header("authorization") });
    res.status(result.status).json(result.body);
  });
  app.post("/clinical-graph/diagnosis-catalog/:stableKey", async (req, res) => {
    const result = await handleDiagnosisCatalogMutationRequest(
      { authenticate, now: () => "2026-07-11T12:00:00.000Z" },
      { authHeader: req.header("authorization"), params: req.params, body: req.body },
    );
    res.status(result.status).json(result.body);
  });
  app.get("/clinical-graph/encounters/:encounterId/diagnosis-completeness", async (req, res) => {
    const result = await handleDiagnosisCompletenessRequest(
      { authenticate, now: () => "2026-07-11T12:00:00.000Z" },
      { authHeader: req.header("authorization"), params: req.params },
    );
    res.status(result.status).json(result.body);
  });
  const listener = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => listener.once("listening", resolve));
  t.after(() => listener.close());
  const base = `http://127.0.0.1:${(listener.address() as AddressInfo).port}`;

  await post(base, "/clinical-graph/diagnosis-catalog/glaucoma_suspect_open_angle_low", {
    keyFindings: [
      { findingKey: "cup_disc_ratio", satisfiedBy: "this-encounter", active: true },
      { findingKey: "pachymetry_um", label: "Corneal thickness", satisfiedBy: "any-on-file", withinMonths: 12, active: true },
    ],
  }, AUTH_CLINICIAN, 403);
  await post(base, "/clinical-graph/diagnosis-catalog/glaucoma_suspect_open_angle_low", {
    keyFindings: [
      { findingKey: "cup_disc_ratio", satisfiedBy: "this-encounter", active: true },
      { findingKey: "pachymetry_um", label: "Corneal thickness", satisfiedBy: "any-on-file", withinMonths: 12, active: true },
    ],
  }, AUTH_ADMIN, 200);

  const catalog = await get(base, "/clinical-graph/diagnosis-catalog", AUTH_ADMIN) as { diagnoses: Array<{ stableKey: string; keyFindings: unknown[] }> };
  assert.equal(catalog.diagnoses.find((row) => row.stableKey === "glaucoma_suspect_open_angle_low")?.keyFindings.length, 2);
  const deleteAttempt = await post(base, "/clinical-graph/diagnosis-catalog/glaucoma_suspect_open_angle_low", {
    keyFindings: [{ findingKey: "cup_disc_ratio", satisfiedBy: "this-encounter", active: true }],
  }, AUTH_ADMIN, 400) as { error: string };
  assert.match(deleteAttempt.error, /deactivated instead of deleted/);

  const missingBoth = await completeness(base) as CompletenessResponse;
  assert.deepEqual(missingBoth.diagnoses.map((row) => row.conditionReference), ["Condition/confirmed-1"]);
  assert.deepEqual(missingBoth.diagnoses[0]?.missing, [
    { findingKey: "cup_disc_ratio", display: "Cup/disc ratio" },
    { findingKey: "pachymetry_um", display: "Corneal thickness" },
  ]);
  assert.deepEqual(fhir.followedUrls, ["memory://Observation/history-page-2"]);

  fhir.resources.push(observation("cup_disc_ratio", "Cup-to-disc ratio", "Encounter/e1", "2026-07-11T11:00:00.000Z", "encounter-cup-disc"));
  const missingHistorical = await completeness(base) as CompletenessResponse;
  assert.deepEqual(missingHistorical.diagnoses[0]?.missing, [
    { findingKey: "pachymetry_um", display: "Corneal thickness" },
  ]);

  const historical = fhir.resources.find((row) => row.id === "history-pachymetry") as Observation;
  historical.effectiveDateTime = "2026-02-01T12:00:00.000Z";
  assert.deepEqual((await completeness(base) as CompletenessResponse).diagnoses, []);

  delete historical.effectiveDateTime;
  historical.effectiveInstant = "2026-02-02T12:00:00.000Z";
  assert.deepEqual((await completeness(base) as CompletenessResponse).diagnoses, []);

  delete historical.effectiveInstant;
  historical.effectiveTiming = { event: ["2026-02-03T12:00:00.000Z"] };
  assert.deepEqual((await completeness(base) as CompletenessResponse).diagnoses, []);

  await post(base, "/clinical-graph/diagnosis-catalog/glaucoma_suspect_open_angle_low", {
    keyFindings: [
      { findingKey: "pachymetry_um", label: "Corneal thickness", satisfiedBy: "any-on-file", withinMonths: 12, active: true },
      { findingKey: "cup_disc_ratio", satisfiedBy: "this-encounter", active: false },
    ],
  }, AUTH_ADMIN, 200);
  const reloaded = await get(base, "/clinical-graph/diagnosis-catalog", AUTH_ADMIN) as { diagnoses: Array<{ stableKey: string; keyFindings: Array<{ findingKey: string; active: boolean; origin: string }> }> };
  assert.deepEqual(reloaded.diagnoses.find((row) => row.stableKey === "glaucoma_suspect_open_angle_low")?.keyFindings, [
    { findingKey: "pachymetry_um", label: "Corneal thickness", satisfiedBy: "any-on-file", withinMonths: 12, origin: "practice", active: true },
    { findingKey: "cup_disc_ratio", satisfiedBy: "this-encounter", origin: "practice", active: false },
  ]);
});

type CompletenessResponse = {
  diagnoses: Array<{ conditionReference?: string; missing: Array<{ findingKey: string; display: string }> }>;
};

function encounter(): Encounter {
  return {
    resourceType: "Encounter",
    id: "e1",
    status: "in-progress",
    class: { system: "http://terminology.hl7.org/CodeSystem/v3-ActCode", code: "AMB" },
    subject: { reference: "Patient/p1" },
  };
}

function diagnosisCondition(
  verificationStatus: "confirmed" | "provisional" | "refuted",
  diagnosisKey: string,
  laterality: string,
  id: string,
): Condition {
  return {
    resourceType: "Condition",
    id,
    subject: { reference: "Patient/p1" },
    encounter: { reference: "Encounter/e1" },
    clinicalStatus: { coding: [{ code: "active" }] },
    verificationStatus: { coding: [{ code: verificationStatus }] },
    identifier: [{ system: DIAGNOSIS_KEY_IDENTIFIER_SYSTEM, value: `${diagnosisKey}::${laterality}` }],
    code: { text: diagnosisKey },
  };
}

function observation(code: string, display: string, encounterReference: string, recordedAt: string, id: string): Observation {
  return {
    resourceType: "Observation",
    id,
    status: "final",
    code: { coding: [{ system: "https://osod.dev/fhir/CodeSystem/clinical-finding", code, display }] },
    subject: { reference: "Patient/p1" },
    encounter: { reference: encounterReference },
    effectiveDateTime: recordedAt,
    valueString: "charted",
  };
}

function bundle<T extends Resource>(resources: T[], nextUrl?: string): Bundle<T> {
  return {
    resourceType: "Bundle",
    type: "searchset",
    entry: resources.map((resource) => ({ resource: structuredClone(resource) })),
    ...(nextUrl ? { link: [{ relation: "next", url: nextUrl }] } : {}),
  };
}

async function completeness(base: string): Promise<unknown> {
  return get(base, "/clinical-graph/encounters/e1/diagnosis-completeness", AUTH_CLINICIAN);
}

async function get(base: string, path: string, authorization: string): Promise<unknown> {
  const response = await fetch(`${base}${path}`, { headers: { Authorization: authorization } });
  assert.equal(response.status, 200);
  return response.json();
}

async function post(
  base: string,
  path: string,
  body: unknown,
  authorization: string,
  expectedStatus: number,
): Promise<unknown> {
  const response = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { Authorization: authorization, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  assert.equal(response.status, expectedStatus);
  return response.json();
}
