import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import type { Basic, Bundle, Condition, Encounter, Resource } from "@medplum/fhirtypes";
import type { PracticeRoleId } from "../src/authz/roles.js";
import { handleDiagnosisPickRequest } from "../src/clinical-graph/diagnosis-pick-endpoint.js";
import {
  handleDiagnosisVisitStatusListRequest,
  handleDiagnosisVisitStatusUpdateRequest,
} from "../src/clinical-graph/diagnosis-visit-status-endpoint.js";
import type {
  DiagnosisVisitStatus,
  DiagnosisVisitStatusRow,
  DiagnosisVisitStatusStore,
} from "../src/clinical-graph/diagnosis-visit-status-store.js";

class MemoryStatusStore implements DiagnosisVisitStatusStore {
  readonly rows = new Map<string, DiagnosisVisitStatusRow>();

  async listByEncounter(encounterId: string): Promise<DiagnosisVisitStatusRow[]> {
    return [...this.rows.values()].filter((row) => row.encounterId === encounterId);
  }

  async upsert(input: {
    conditionReference: string;
    encounterId: string;
    status: DiagnosisVisitStatus;
    setBy: string;
    at: string;
  }): Promise<DiagnosisVisitStatusRow> {
    const existing = this.rows.get(input.conditionReference);
    const row = {
      conditionReference: input.conditionReference,
      encounterId: input.encounterId,
      status: input.status,
      setBy: existing?.setBy ?? input.setBy,
      setAt: existing?.setAt ?? input.at,
      updatedAt: input.at,
    };
    this.rows.set(input.conditionReference, row);
    return row;
  }
}

class MemoryFhir {
  readonly resources: Resource[] = [];

  async read<T extends Resource>(resourceType: T["resourceType"], id: string): Promise<T> {
    const resource = this.resources.find((row) => row.resourceType === resourceType && row.id === id);
    if (!resource) throw new Error(`Missing ${resourceType}/${id}`);
    return structuredClone(resource as T);
  }

  async search<T extends Resource>(resourceType: T["resourceType"], params: Record<string, string> = {}): Promise<Bundle<T>> {
    const resources = this.resources.filter((resource) => resource.resourceType === resourceType).filter((resource) => {
      if (resourceType === "Basic" && params.code) {
        return (resource as Basic).code.coding?.some((coding) => `${coding.system}|${coding.code}` === params.code);
      }
      if (resourceType === "Condition" && params.encounter) {
        return (resource as Condition).encounter?.reference === params.encounter;
      }
      return true;
    });
    return {
      resourceType: "Bundle",
      type: "searchset",
      entry: resources.map((resource) => ({ resource: structuredClone(resource as T) })),
    };
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
    const persisted = {
      ...resource,
      id: resource.id ?? `${resource.resourceType.toLowerCase()}-${this.resources.length + 1}`,
      meta: { ...(resource.meta ?? {}), versionId: "1" },
    } as T;
    this.resources.push(persisted);
    return structuredClone(persisted);
  }

  async update<T extends Resource>(resourceType: T["resourceType"], id: string, resource: T): Promise<T> {
    const index = this.resources.findIndex((candidate) => candidate.resourceType === resourceType && candidate.id === id);
    if (index < 0) throw new Error(`Missing ${resourceType}/${id}`);
    const persisted = { ...resource, id, meta: { ...(resource.meta ?? {}), versionId: "2" } } as T;
    this.resources[index] = persisted;
    return structuredClone(persisted);
  }
}

test("confirm freezes the original setter and timestamp when a different clinician changes status", async () => {
  const fhir = encounterFhir();
  const store = new MemoryStatusStore();
  const authenticate = async (authHeader: string | undefined) => {
    const staffReference = authHeader === "Bearer clinician-a"
      ? "Practitioner/clinician-a"
      : authHeader === "Bearer clinician-b"
        ? "Practitioner/clinician-b"
        : undefined;
    return staffReference ? {
      staffReference,
      actorRole: "clinician" as PracticeRoleId,
      fhir,
    } : null;
  };

  const confirmed = await handleDiagnosisPickRequest({
    authenticate,
    diagnosisVisitStatusStore: store,
    now: () => "2026-07-21T14:00:00.000Z",
  }, {
    authHeader: "Bearer clinician-a",
    params: { encounterId: "encounter-1" },
    body: { diagnosisKey: "myopia", laterality: "OD", action: "confirm", status: "worsening" },
  });
  assert.equal(confirmed.status, 201, JSON.stringify(confirmed.body));
  const condition = (confirmed.body as { condition: Condition }).condition;
  const conditionReference = `Condition/${condition.id}`;
  assert.equal(store.rows.get(conditionReference)?.status, "worsening");

  const updated = await handleDiagnosisVisitStatusUpdateRequest({
    authenticate,
    store,
    now: () => "2026-07-21T14:05:00.000Z",
  }, {
    authHeader: "Bearer clinician-b",
    params: { encounterId: "encounter-1", conditionId: condition.id },
    body: { status: "improved" },
  });
  assert.equal(updated.status, 200, JSON.stringify(updated.body));
  assert.equal(store.rows.size, 1);
  assert.deepEqual(store.rows.get(conditionReference), {
    conditionReference,
    encounterId: "encounter-1",
    status: "improved",
    setBy: "Practitioner/clinician-a",
    setAt: "2026-07-21T14:00:00.000Z",
    updatedAt: "2026-07-21T14:05:00.000Z",
  });
});

test("missing rows read as unset, signed encounters reject updates, and a later encounter gets a new Condition without copied status", async () => {
  const fhir = encounterFhir();
  const store = new MemoryStatusStore();
  const authenticate = async () => ({
    staffReference: "Practitioner/doctor-1",
    actorRole: "clinician" as PracticeRoleId,
    fhir,
  });
  const pick = (encounterId: string, body: Record<string, unknown>, at: string) => handleDiagnosisPickRequest({
    authenticate,
    diagnosisVisitStatusStore: store,
    now: () => at,
  }, { authHeader: "Bearer doctor-1", params: { encounterId }, body });

  const empty = await handleDiagnosisVisitStatusListRequest(
    { authenticate, store },
    { authHeader: "Bearer doctor-1", params: { encounterId: "encounter-1" } },
  );
  assert.deepEqual(empty, { status: 200, body: { statuses: [] } });

  const first = await pick("encounter-1", {
    diagnosisKey: "myopia",
    laterality: "OD",
    action: "confirm",
    status: "stable",
  }, "2026-07-21T15:00:00.000Z");
  const firstCondition = (first.body as { condition: Condition }).condition;
  const firstEncounter = fhir.resources.find((resource): resource is Encounter =>
    resource.resourceType === "Encounter" && resource.id === "encounter-1"
  )!;
  firstEncounter.status = "finished";
  const afterSign = await handleDiagnosisVisitStatusUpdateRequest(
    { authenticate, store },
    {
      authHeader: "Bearer doctor-1",
      params: { encounterId: "encounter-1", conditionId: firstCondition.id },
      body: { status: "resolved-this-visit" },
    },
  );
  assert.equal(afterSign.status, 409);
  assert.match(String((afterSign.body as { error: string }).error), /after the encounter is signed/);
  firstEncounter.status = "in-progress";

  assert.equal((await pick("encounter-1", {
    diagnosisKey: "myopia", laterality: "OD", action: "discard",
  }, "2026-07-21T15:05:00.000Z")).status, 200);
  const later = await pick("encounter-2", {
    diagnosisKey: "myopia", laterality: "OD", action: "confirm",
  }, "2026-07-21T15:10:00.000Z");
  assert.equal(later.status, 201, JSON.stringify(later.body));
  const laterCondition = (later.body as { condition: Condition }).condition;
  assert.notEqual(laterCondition.id, firstCondition.id);
  assert.equal(store.rows.has(`Condition/${laterCondition.id}`), false);
});

test("status vocabulary is application-validated and the SQL column remains extensible", () => {
  const migration = readFileSync(
    new URL("../../data/migrations/2026-07-21-encounter-diagnosis-statuses.sql", import.meta.url),
    "utf8",
  );
  assert.match(migration, /status TEXT NOT NULL/);
  assert.doesNotMatch(migration, /CHECK\s*\(\s*status/i);
});

function encounterFhir(): MemoryFhir {
  const fhir = new MemoryFhir();
  for (const id of ["encounter-1", "encounter-2"]) {
    fhir.resources.push({
      resourceType: "Encounter",
      id,
      status: "in-progress",
      class: { system: "http://terminology.hl7.org/CodeSystem/v3-ActCode", code: "AMB" },
      subject: { reference: "Patient/patient-1" },
    } as Encounter);
  }
  return fhir;
}
