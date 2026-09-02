import assert from "node:assert/strict";
import { test } from "node:test";
import type { Basic, Bundle, Encounter } from "@medplum/fhirtypes";
import type { PracticeRoleId } from "../src/authz/roles.js";
import {
  handleComplaintDefinitionCatalogRequest,
  handleEncounterComplaintListRequest,
  handleEncounterComplaintMutationRequest,
  type ComplaintEndpointDeps,
} from "../src/clinical-graph/complaint-endpoint.js";
import {
  COMPLAINT_DEFINITION_CODE,
  COMPLAINT_DEFINITION_CODE_SYSTEM,
} from "../src/clinical-graph/complaint-definition-store.js";
import {
  COMPLAINT_SEED_PROVENANCE_NOTE,
} from "../src/clinical-graph/complaint-model.js";
import {
  FhirEncounterComplaintStore,
  assertEncounterComplaint,
  buildEncounterComplaintResource,
  parseEncounterComplaintResource,
} from "../src/clinical-graph/encounter-complaint-store.js";

const AUTH = "Bearer good";
const CONCURRENT_EDIT_MESSAGE =
  "This record was changed by someone else since you opened it. Reload and reapply your change.";

class MemoryFhir {
  encounter: Encounter = {
    resourceType: "Encounter",
    id: "e1",
    status: "in-progress",
    class: { system: "http://terminology.hl7.org/CodeSystem/v3-ActCode", code: "AMB" },
    subject: { reference: "Patient/p1" },
    reasonCode: [{ coding: [{ system: "https://example.test", code: "coded" }] }, { text: "Legacy concern" }],
    meta: { versionId: "1" },
  };
  basics: Basic[] = [];
  writes: Array<{ method: "create" | "update"; resourceType: string; id?: string; headers?: Record<string, string> }> = [];
  beforeUpdate?: (resourceType: "Basic" | "Encounter", id: string) => void;

  async read<T extends Encounter>(): Promise<T> {
    return structuredClone(this.encounter) as T;
  }

  async search<T extends Basic>(_resourceType: T["resourceType"], params: Record<string, string> = {}): Promise<Bundle<T>> {
    const rows = this.basics.filter((resource) => {
      if (params.code) {
        const [system, code] = params.code.split("|");
        if (!resource.code?.coding?.some((coding) => coding.system === system && coding.code === code)) return false;
      }
      if (params.identifier) {
        const [system, value] = params.identifier.split("|");
        if (!resource.identifier?.some((identifier) => identifier.system === system && identifier.value === value)) return false;
      }
      return true;
    });
    return { resourceType: "Bundle", type: "searchset", entry: rows.map((resource) => ({ resource: structuredClone(resource) as T })) };
  }

  async create<T extends Basic>(resource: T, headers?: Record<string, string>): Promise<T> {
    const saved = {
      ...structuredClone(resource),
      id: resource.id ?? `basic-${this.basics.length + 1}`,
      meta: { lastUpdated: new Date().toISOString(), versionId: "1" },
    } as T;
    this.basics.push(saved);
    this.writes.push({ method: "create", resourceType: resource.resourceType, id: saved.id, headers });
    return structuredClone(saved);
  }

  async update<T extends Basic | Encounter>(resourceType: T["resourceType"], id: string, resource: T, headers?: Record<string, string>): Promise<T> {
    this.writes.push({ method: "update", resourceType, id, headers });
    const beforeUpdate = this.beforeUpdate;
    this.beforeUpdate = undefined;
    beforeUpdate?.(resourceType, id);
    if (resourceType === "Encounter") {
      assertIfMatch(headers, this.encounter.meta?.versionId);
      const versionId = String(Number(this.encounter.meta?.versionId ?? "0") + 1);
      this.encounter = {
        ...structuredClone(resource) as Encounter,
        meta: { ...resource.meta, versionId },
      };
      return structuredClone(this.encounter) as T;
    }
    const index = this.basics.findIndex((candidate) => candidate.id === id);
    assert.ok(index >= 0);
    assertIfMatch(headers, this.basics[index]?.meta?.versionId);
    const versionId = String(Number(this.basics[index]?.meta?.versionId ?? "0") + 1);
    const saved = {
      ...structuredClone(resource as Basic),
      id,
      meta: { lastUpdated: new Date().toISOString(), versionId },
    };
    this.basics[index] = saved;
    return structuredClone(saved) as T;
  }
}

function assertIfMatch(headers: Record<string, string> | undefined, versionId: string | undefined): void {
  if (headers?.["If-Match"] === `W/"${versionId}"`) return;
  throw Object.assign(new Error("FHIR 412 Precondition Failed"), { status: 412 });
}

function fixture(role: PracticeRoleId = "provider") {
  const fhir = new MemoryFhir();
  let timestamp = 0;
  const deps: ComplaintEndpointDeps = {
    authenticate: async (header) => header === AUTH ? {
      staffReference: "Practitioner/doc1",
      actorRole: role,
      fhir,
    } : null,
    now: () => `2026-07-21T12:00:0${timestamp++}.000Z`,
    id: () => `complaint-${timestamp}`,
  };
  return { deps, fhir };
}

const DRY_EYE = {
  complaintKey: "dry-eye",
  conditions: ["dry-eyes"],
  eyeLocation: "OU",
  eyeComparison: "right-worse",
  qualities: ["constant", "environmentally-sensitive", "brought-on-by-drafts-or-fans"],
  severity: undefined,
  duration: { value: 3, unit: "months" },
  treatmentsTried: ["artificial-tears", "warm-compresses"],
  additionalHistory: "worse at end of workday",
  narrative: { mode: "automated" },
};

test("complaint catalog uses a separate Basic type, preserves the 13 seed order, and branches only dry eye", async () => {
  const { deps, fhir } = fixture();
  const result = await handleComplaintDefinitionCatalogRequest(deps, { authHeader: AUTH });
  assert.equal(result.status, 200);
  const body = result.body as {
    definitions: Array<{ stableKey: string; display: string; seedRank: number; qualityOptions: unknown[]; treatmentOptions: unknown[]; provenance: { note?: string } }>;
    genericOptions: { qualities: Array<{ code: string }>; treatments: Array<{ code: string }> };
  };
  assert.equal(body.definitions.length, 13);
  assert.deepEqual(body.definitions.map((row) => row.display), [
    "Patient (Blurred Vision)",
    "Contact Lens Evaluation",
    "Routine Eye Exam",
    "Patient (Decreased Vision)",
    "Diabetic Ocular Evaluation",
    "Patient (Eye Irritation)",
    "Patient (Red Eye)",
    "Postop Cataract",
    "Patient (Eye Pain)",
    "Patient (Dry Eye)",
    "Patient (Floaters)",
    "Patient (Foreign Body Sensation)",
    "Glaucoma",
  ]);
  assert.deepEqual(body.definitions.map((row) => row.seedRank), Array.from({ length: 13 }, (_, index) => index + 1));
  assert.equal(body.definitions.filter((row) => row.qualityOptions.length || row.treatmentOptions.length).map((row) => row.stableKey).join(), "dry-eye");
  assert.equal(body.genericOptions.qualities.some((row) => row.code === "environmentally-sensitive"), false);
  assert.equal(body.genericOptions.treatments.some((row) => row.code === "artificial-tears"), false);
  assert.equal(body.definitions[0]?.provenance.note, COMPLAINT_SEED_PROVENANCE_NOTE);
  assert.equal(fhir.basics.some((resource) => resource.code?.coding?.some((coding) => coding.system === COMPLAINT_DEFINITION_CODE_SYSTEM && coding.code === COMPLAINT_DEFINITION_CODE)), false);
});

test("two structured complaints round-trip, render deterministically, reorder, and keep primary reason separate from coding", async () => {
  const { deps, fhir } = fixture();
  const first = await handleEncounterComplaintMutationRequest(deps, {
    authHeader: AUTH,
    params: { encounterId: "e1" },
    body: { action: "create", patientReference: "Patient/p1", complaint: DRY_EYE },
  });
  assert.equal(first.status, 200);
  const firstRows = (first.body as { complaints: Array<{ id: string; renderedNarrative: string }> }).complaints;
  assert.equal(firstRows.length, 1);
  assert.equal(firstRows[0]?.renderedNarrative, "Patient reports dry eyes, both eyes, right worse than left, ongoing for 3 months. Described as constant, environmentally sensitive, brought on by drafts or fans. Current treatment: artificial tears, warm compresses. Additional history: worse at end of workday.");
  assert.deepEqual(fhir.encounter.reasonCode, [
    { coding: [{ system: "https://example.test", code: "coded" }] },
    { text: "dry eye, both eyes, 3 months" },
  ]);

  const second = await handleEncounterComplaintMutationRequest(deps, {
    authHeader: AUTH,
    params: { encounterId: "e1" },
    body: {
      action: "create",
      patientReference: "Patient/p1",
      complaint: {
        complaintKey: "routine-eye-exam",
        conditions: [],
        eyeLocation: "not-applicable",
        qualities: [],
        duration: { value: 1, unit: "years" },
        treatmentsTried: ["no-treatment"],
        additionalHistory: "",
        narrative: { mode: "automated" },
      },
    },
  });
  assert.equal(second.status, 200);
  const rows = (second.body as { complaints: Array<{ id: string; ordinal: number }> }).complaints;
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((row) => row.ordinal), [1, 2]);
  assert.match((second.body as { complaints: Array<{ renderedNarrative: string }> }).complaints[1]!.renderedNarrative, /ongoing for 1 year\./);

  const reordered = await handleEncounterComplaintMutationRequest(deps, {
    authHeader: AUTH,
    params: { encounterId: "e1" },
    body: { action: "reorder", complaintIds: [rows[1]!.id, rows[0]!.id] },
  });
  assert.equal(reordered.status, 200);
  assert.match(fhir.encounter.reasonCode?.[1]?.text ?? "", /^routine eye exam/);
  assert.equal(fhir.encounter.reasonCode?.[0]?.coding?.[0]?.code, "coded");
  assert.equal(fhir.writes.every((write) => write.headers?.["X-ODOS-Source"] === "encounter-complaints"), true);
  const encounterUpdates = fhir.writes.filter((write) =>
    write.method === "update" && write.resourceType === "Encounter" && write.id === "e1"
  );
  assert.deepEqual(encounterUpdates.map((write) => write.headers?.["If-Match"]), ['W/"1"', 'W/"2"', 'W/"3"']);

  const listed = await handleEncounterComplaintListRequest(deps, { authHeader: AUTH, params: { encounterId: "e1" } });
  assert.equal(listed.status, 200);
  assert.equal((listed.body as { complaints: unknown[]; legacyFallback: boolean }).complaints.length, 2);
  assert.equal((listed.body as { legacyFallback: boolean }).legacyFallback, false);
});

test("stale Encounter complaint stamp returns a concurrent-edit response without overwriting the concurrent Encounter", async () => {
  const { deps, fhir } = fixture();
  let concurrentEncounter: Encounter | undefined;
  fhir.beforeUpdate = (resourceType) => {
    if (resourceType !== "Encounter") return;
    fhir.encounter = {
      ...fhir.encounter,
      reasonCode: [{ text: "Concurrent clinician concern" }],
      meta: { ...fhir.encounter.meta, versionId: "2" },
    };
    concurrentEncounter = structuredClone(fhir.encounter);
  };

  const result = await handleEncounterComplaintMutationRequest(deps, {
    authHeader: AUTH,
    params: { encounterId: "e1" },
    body: { action: "create", patientReference: "Patient/p1", complaint: DRY_EYE },
  });

  assert.equal(result.status, 409);
  assert.deepEqual(result.body, { error: CONCURRENT_EDIT_MESSAGE, code: "concurrent-edit" });
  assert.deepEqual(fhir.encounter, concurrentEncounter);
});

test("stale encounter-complaint Basic update returns a concurrent-edit response without overwriting the concurrent row", async () => {
  const { deps, fhir } = fixture();
  const created = await handleEncounterComplaintMutationRequest(deps, {
    authHeader: AUTH,
    params: { encounterId: "e1" },
    body: { action: "create", patientReference: "Patient/p1", complaint: DRY_EYE },
  });
  const complaintId = (created.body as { complaints: Array<{ id: string }> }).complaints[0]!.id;
  const encounterBefore = structuredClone(fhir.encounter);
  let concurrentBasic: Basic | undefined;
  fhir.beforeUpdate = (resourceType, id) => {
    if (resourceType !== "Basic") return;
    const index = fhir.basics.findIndex((candidate) => candidate.id === id);
    assert.ok(index >= 0);
    const stored = fhir.basics[index]!;
    const concurrentComplaint = {
      ...parseEncounterComplaintResource(stored),
      additionalHistory: "saved by another clinician",
    };
    fhir.basics[index] = {
      ...buildEncounterComplaintResource(concurrentComplaint, stored),
      meta: { ...stored.meta, versionId: "2" },
    };
    concurrentBasic = structuredClone(fhir.basics[index]);
  };

  const result = await handleEncounterComplaintMutationRequest(deps, {
    authHeader: AUTH,
    params: { encounterId: "e1" },
    body: { action: "update", complaintId, complaint: { ...DRY_EYE, severity: "moderate" } },
  });

  assert.equal(result.status, 409);
  assert.deepEqual(result.body, { error: CONCURRENT_EDIT_MESSAGE, code: "concurrent-edit" });
  assert.deepEqual(fhir.basics.find((candidate) => candidate.id === concurrentBasic?.id), concurrentBasic);
  assert.deepEqual(fhir.encounter, encounterBefore);
});

test("an active complaint can be edited and removal keeps its persisted audit row", async () => {
  const { deps, fhir } = fixture();
  const created = await handleEncounterComplaintMutationRequest(deps, {
    authHeader: AUTH,
    params: { encounterId: "e1" },
    body: { action: "create", patientReference: "Patient/p1", complaint: DRY_EYE },
  });
  const id = (created.body as { complaints: Array<{ id: string }> }).complaints[0]!.id;
  const updated = await handleEncounterComplaintMutationRequest(deps, {
    authHeader: AUTH,
    params: { encounterId: "e1" },
    body: { action: "update", complaintId: id, complaint: { ...DRY_EYE, severity: "moderate" } },
  });
  assert.equal(updated.status, 200);
  assert.equal((updated.body as { complaints: Array<{ severity?: string }> }).complaints[0]?.severity, "moderate");
  const removed = await handleEncounterComplaintMutationRequest(deps, {
    authHeader: AUTH,
    params: { encounterId: "e1" },
    body: { action: "remove", complaintId: id },
  });
  assert.equal(removed.status, 200);
  assert.deepEqual((removed.body as { complaints: unknown[] }).complaints, []);
  const persisted = fhir.basics.find((row) => row.identifier?.some((identifier) => identifier.value === id));
  assert.ok(persisted);
  assert.match(persisted.extension?.[0]?.valueString ?? "", /\"status\":\"removed\"/);

  const reopened = await handleEncounterComplaintListRequest(deps, {
    authHeader: AUTH,
    params: { encounterId: "e1" },
  });
  assert.equal(reopened.status, 200);
  assert.deepEqual(
    (reopened.body as { complaints: unknown[] }).complaints,
    [],
    "a removed complaint stays out when History is reopened",
  );
});

test("encounter complaint reads collapse duplicate Basics by complaint id and keep the newest row", async () => {
  const { deps, fhir } = fixture();
  const created = await handleEncounterComplaintMutationRequest(deps, {
    authHeader: AUTH,
    params: { encounterId: "e1" },
    body: { action: "create", patientReference: "Patient/p1", complaint: DRY_EYE },
  });
  assert.equal(created.status, 200);
  const original = fhir.basics.find((row) => row.code?.coding?.some((coding) => coding.code === "odos-encounter-complaint"));
  assert.ok(original);
  original.meta = { lastUpdated: "2026-07-21T12:00:00.000Z" };
  const complaint = parseEncounterComplaintResource(original);
  const duplicate = buildEncounterComplaintResource({ ...complaint, additionalHistory: "newest duplicate row" });
  duplicate.id = "duplicate-basic";
  duplicate.meta = { lastUpdated: "2026-07-21T12:01:00.000Z" };
  fhir.basics.push(duplicate);

  const rows = await new FhirEncounterComplaintStore(fhir).listByEncounter("e1");
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.id, complaint.id);
  assert.equal(rows[0]?.additionalHistory, "newest duplicate row");
});

test("encounter complaint validation requires additionalHistory to be present", () => {
  const complaint = {
    id: "complaint-1",
    encounterId: "e1",
    patientId: "p1",
    ordinal: 1,
    complaintKey: "dry-eye",
    conditions: [],
    eyeLocation: "OU",
    qualities: [],
    treatmentsTried: [],
    narrative: { mode: "automated" },
    resolvedDx: [],
    status: "active",
    provenance: { source: "manual", recordedAt: "2026-07-21T12:00:00.000Z", actorReference: "Practitioner/doc1" },
    provenanceHistory: [],
  };
  assert.throws(() => assertEncounterComplaint(complaint), /additionalHistory/);
});

test("complaint mutations fail closed on unsourced options, duplicate reorder input, and signed encounters", async () => {
  const { deps, fhir } = fixture();
  const invalid = await handleEncounterComplaintMutationRequest(deps, {
    authHeader: AUTH,
    params: { encounterId: "e1" },
    body: { action: "create", patientReference: "Patient/p1", complaint: { ...DRY_EYE, qualities: ["invented-quality"] } },
  });
  assert.equal(invalid.status, 400);
  assert.match((invalid.body as { error: string }).error, /unknown or inactive/);
  assert.equal(fhir.basics.length, 0);

  const created = await handleEncounterComplaintMutationRequest(deps, {
    authHeader: AUTH,
    params: { encounterId: "e1" },
    body: { action: "create", patientReference: "Patient/p1", complaint: DRY_EYE },
  });
  const id = (created.body as { complaints: Array<{ id: string }> }).complaints[0]!.id;
  const duplicate = await handleEncounterComplaintMutationRequest(deps, {
    authHeader: AUTH,
    params: { encounterId: "e1" },
    body: { action: "reorder", complaintIds: [id, id] },
  });
  assert.equal(duplicate.status, 400);
  fhir.encounter.status = "finished";
  const closed = await handleEncounterComplaintMutationRequest(deps, {
    authHeader: AUTH,
    params: { encounterId: "e1" },
    body: { action: "remove", complaintId: id },
  });
  assert.equal(closed.status, 409);
});

test("legacy text-only encounter reason renders as one Other complaint without rewriting history", async () => {
  const { deps, fhir } = fixture();
  const before = structuredClone(fhir.encounter);
  const result = await handleEncounterComplaintListRequest(deps, { authHeader: AUTH, params: { encounterId: "e1" } });
  assert.equal(result.status, 200);
  const body = result.body as { complaints: Array<{ freeTextLabel?: string; ordinal: number; renderedNarrative: string }>; legacyFallback: boolean };
  assert.equal(body.legacyFallback, true);
  assert.equal(body.complaints.length, 1);
  assert.equal(body.complaints[0]?.freeTextLabel, "Legacy concern");
  assert.equal(body.complaints[0]?.ordinal, 1);
  assert.match(body.complaints[0]?.renderedNarrative ?? "", /Patient reports Legacy concern/);
  assert.deepEqual(fhir.encounter, before);
  assert.equal(fhir.basics.length, 0);
});

test("override freezes narrative text and records clinician-edited provenance", async () => {
  const { deps } = fixture();
  const result = await handleEncounterComplaintMutationRequest(deps, {
    authHeader: AUTH,
    params: { encounterId: "e1" },
    body: {
      action: "create",
      patientReference: "Patient/p1",
      complaint: { ...DRY_EYE, narrative: { mode: "override", overrideText: "Patient reports clinician-edited history." } },
    },
  });
  assert.equal(result.status, 200);
  const complaint = (result.body as { complaints: Array<{ renderedNarrative: string; narrative: { overrideProvenance?: { note?: string } } }> }).complaints[0]!;
  assert.equal(complaint.renderedNarrative, "Patient reports clinician-edited history.");
  assert.equal(complaint.narrative.overrideProvenance?.note, "clinician-edited");
});
