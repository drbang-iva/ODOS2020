import assert from "node:assert/strict";
import { test } from "node:test";
import type { Basic, Bundle, Resource } from "@medplum/fhirtypes";
import {
  EducationEnrollmentDuplicateError,
  createFhirEducationEnrollmentStore,
  createInMemoryEducationEnrollmentStore,
  type NewEducationEnrollment,
} from "../src/comms/education-enrollment.js";

const PATIENT_REFERENCE = "Patient/synthetic-enrollment-1";
const ENCOUNTER_REFERENCE = "Encounter/synthetic-encounter-1";
const ENROLLED_BY = "Practitioner/synthetic-provider-1";

function enrollmentInput(version = 1): NewEducationEnrollment {
  return {
    patientReference: PATIENT_REFERENCE,
    journey: { id: "dry-eye-foundations", version },
    currentStageId: "welcome",
    stageEnteredAt: "2026-09-01T14:00:00.000Z",
    enteredFromEncounterReference: ENCOUNTER_REFERENCE,
    enrolledBy: ENROLLED_BY,
    status: "active",
    stageHistory: [{
      stageId: "welcome",
      enteredAt: "2026-09-01T14:00:00.000Z",
      enteredBy: ENROLLED_BY,
      reason: "enrollment-recorded",
    }],
    immediateSends: [{
      content: { id: "dry-eye-basics", version: 2 },
      channel: "sms",
      lane: "clinical",
    }],
  };
}

test("EducationEnrollment in-memory persistence records stage 1 truth and refuses the same active journey across versions", async () => {
  const store = createInMemoryEducationEnrollmentStore({
    generateId: () => "enrollment-synthetic-1",
  });
  const created = await store.create(enrollmentInput(1));

  assert.equal(created.id, "enrollment-synthetic-1");
  assert.equal(created.currentStageId, "welcome");
  assert.equal(created.stageHistory.length, 1);
  assert.deepEqual(created.immediateSends, [{
    content: { id: "dry-eye-basics", version: 2 },
    channel: "sms",
    lane: "clinical",
    idempotencyKey: "enrollment:enrollment-synthetic-1:stage1:1",
    state: "pending",
  }]);

  const claimed = await store.claimImmediateSend(created.id, 0);
  assert.equal(claimed.claimed, true);
  assert.equal(claimed.enrollment.immediateSends[0]?.state, "in-flight");
  const claimedAgain = await store.claimImmediateSend(created.id, 0);
  assert.equal(claimedAgain.claimed, false);
  assert.equal(claimedAgain.enrollment.immediateSends[0]?.state, "in-flight");

  const recorded = await store.recordImmediateSendOutcome(created.id, 0, {
    outcome: "suppressed",
    reason: "patient-opt-out",
  });
  assert.deepEqual(recorded.immediateSends[0], {
    content: { id: "dry-eye-basics", version: 2 },
    channel: "sms",
    lane: "clinical",
    idempotencyKey: "enrollment:enrollment-synthetic-1:stage1:1",
    state: "resolved",
    outcome: { outcome: "suppressed", reason: "patient-opt-out" },
  });
  assert.deepEqual(await store.listActiveForPatient(PATIENT_REFERENCE), [recorded]);
  assert.deepEqual(await store.read(created.id), recorded);

  await assert.rejects(
    () => store.create(enrollmentInput(2)),
    EducationEnrollmentDuplicateError,
  );
});

test("EducationEnrollment FHIR Basic round-trip preserves exact sends, outcomes, and repeated stage history", async () => {
  let persisted: Basic | undefined;
  const searches: Array<Record<string, string>> = [];
  const fhir = {
    baseUrl: "https://synthetic.example/fhir/R4",
    async search<T extends Resource>(resourceType: T["resourceType"], params: Record<string, string> = {}): Promise<Bundle<T>> {
      assert.equal(resourceType, "Basic");
      searches.push(structuredClone(params));
      const matches = persisted && (
        params.identifier
          ? persisted.identifier?.some((identifier) =>
            `${identifier.system}|${identifier.value}` === params.identifier)
          : true
      ) ? [persisted] : [];
      return {
        resourceType: "Bundle",
        type: "searchset",
        entry: matches.map((resource) => ({ resource: structuredClone(resource) as T })),
      };
    },
    async searchUrl<T extends Resource>(): Promise<Bundle<T>> {
      throw new Error("Unexpected EducationEnrollment pagination.");
    },
    async create<T extends Resource>(resource: T): Promise<T> {
      persisted = {
        ...(structuredClone(resource) as Basic),
        id: "fhir-enrollment-1",
        meta: { versionId: "1", lastUpdated: "2026-09-01T14:00:00.000Z" },
      };
      return structuredClone(persisted) as T;
    },
    async read<T extends Resource>(resourceType: T["resourceType"], id: string): Promise<T> {
      assert.equal(resourceType, "Basic");
      assert.equal(id, "fhir-enrollment-1");
      assert.ok(persisted);
      return structuredClone(persisted) as T;
    },
    async update<T extends Resource>(resourceType: T["resourceType"], id: string, resource: T): Promise<T> {
      assert.equal(resourceType, "Basic");
      assert.equal(id, "fhir-enrollment-1");
      persisted = {
        ...(structuredClone(resource) as Basic),
        id,
        meta: { versionId: "2", lastUpdated: "2026-09-01T14:01:00.000Z" },
      };
      return structuredClone(persisted) as T;
    },
  };
  const store = createFhirEducationEnrollmentStore(fhir);

  const created = await store.create(enrollmentInput());
  assert.equal(created.id, "fhir-enrollment-1");
  assert.equal(created.immediateSends[0]?.idempotencyKey, "enrollment:fhir-enrollment-1:stage1:1");
  assert.equal(created.immediateSends[0]?.state, "pending");
  const claimed = await store.claimImmediateSend(created.id, 0);
  assert.equal(claimed.claimed, true);
  assert.equal(claimed.enrollment.immediateSends[0]?.state, "in-flight");
  await store.recordImmediateSendOutcome(created.id, 0, {
    outcome: "sent",
    providerMessageId: "SM-synthetic-enrollment",
  });
  assert.ok(persisted);
  persisted.extension?.push({
    url: "https://odos2020.com/fhir/StructureDefinition/education-enrollment-stage-history",
    extension: [
      { url: "stage-id", valueString: "consult" },
      { url: "entered-at", valueInstant: "2026-09-02T14:00:00.000Z" },
      { url: "entered-by", valueReference: { reference: ENROLLED_BY } },
      { url: "reason", valueCode: "clinician-action" },
    ],
  });

  const roundTrip = await store.read(created.id);
  assert.equal(roundTrip?.stageHistory.length, 2);
  assert.deepEqual(roundTrip?.immediateSends[0]?.outcome, {
    outcome: "sent",
    providerMessageId: "SM-synthetic-enrollment",
  });
  assert.equal(roundTrip?.immediateSends[0]?.state, "resolved");
  assert.deepEqual(await store.listActiveForPatient(PATIENT_REFERENCE), [roundTrip]);
  assert.equal(searches.some((params) => params.identifier?.includes("education-enrollment-active")), true);
  assert.equal(searches.some((params) =>
    params.code?.includes("education-enrollment")
    && params.subject === PATIENT_REFERENCE), true);
});

test("EducationEnrollment FHIR terminal transition preserves prior truth and removes only the active identifier with If-Match", async () => {
  let persisted: Basic | undefined;
  const ifMatches: string[] = [];
  const fhir = {
    baseUrl: "https://synthetic.example/fhir/R4",
    async search<T extends Resource>(): Promise<Bundle<T>> {
      return { resourceType: "Bundle", type: "searchset" };
    },
    async searchUrl<T extends Resource>(): Promise<Bundle<T>> {
      throw new Error("Unexpected EducationEnrollment pagination.");
    },
    async create<T extends Resource>(resource: T): Promise<T> {
      persisted = {
        ...(structuredClone(resource) as Basic),
        id: "fhir-terminal-enrollment",
        meta: { versionId: "1", lastUpdated: "2026-09-01T14:00:00.000Z" },
      };
      return structuredClone(persisted) as T;
    },
    async read<T extends Resource>(resourceType: T["resourceType"], id: string): Promise<T> {
      assert.equal(resourceType, "Basic");
      assert.equal(id, "fhir-terminal-enrollment");
      assert.ok(persisted);
      return structuredClone(persisted) as T;
    },
    async update<T extends Resource>(
      resourceType: T["resourceType"],
      id: string,
      resource: T,
      options?: Record<string, string>,
    ): Promise<T> {
      assert.equal(resourceType, "Basic");
      assert.equal(id, "fhir-terminal-enrollment");
      assert.ok(persisted);
      ifMatches.push(options?.["If-Match"] ?? "");
      persisted = {
        ...(structuredClone(resource) as Basic),
        id,
        meta: {
          versionId: String(Number(persisted.meta?.versionId ?? "0") + 1),
          lastUpdated: "2026-09-01T14:01:00.000Z",
        },
      };
      return structuredClone(persisted) as T;
    },
  };
  const store = createFhirEducationEnrollmentStore(fhir);
  const created = await store.create(enrollmentInput());
  await store.claimImmediateSend(created.id, 0);
  await store.recordImmediateSendOutcome(created.id, 0, {
    outcome: "sent",
    providerMessageId: "SM-stage-1",
  });

  const transitioned = await store.transition(created.id, {
    fromStageId: "welcome",
    targetStageId: "complete",
    trigger: "clinician-action",
    enteredAt: "2026-09-02T14:00:00.000Z",
    enteredBy: ENROLLED_BY,
    status: "completed",
    immediateSends: [{
      content: { id: "dry-eye-basics", version: 2 },
      channel: "sms",
      lane: "clinical",
    }],
  });
  assert.equal(transitioned.status, "completed");
  assert.equal(transitioned.stageHistory.length, 2);
  assert.deepEqual(transitioned.immediateSends[0]?.outcome, {
    outcome: "sent",
    providerMessageId: "SM-stage-1",
  });
  assert.equal(persisted?.identifier?.some((identifier) =>
    identifier.system === "https://odos2020.com/fhir/NamingSystem/education-enrollment-active"), true);

  assert.equal(transitioned.immediateSends[1]?.idempotencyKey,
    "enrollment:fhir-terminal-enrollment:stage:complete:2");
  assert.equal(transitioned.immediateSends[1]?.state, "pending");
  const terminalClaim = await store.claimImmediateSend(created.id, 1);
  assert.equal(terminalClaim.claimed, true);
  await store.recordImmediateSendOutcome(created.id, 1, {
    outcome: "sent",
    providerMessageId: "SM-terminal-stage",
  });
  const cleared = await store.clearTerminalActiveIdentifier(created.id);
  assert.equal(persisted?.identifier?.some((identifier) =>
    identifier.system === "https://odos2020.com/fhir/NamingSystem/education-enrollment-active"), false);
  assert.equal(persisted?.identifier?.some((identifier) =>
    identifier.system === "https://odos2020.com/fhir/NamingSystem/education-enrollment-id"), true);
  assert.equal(cleared.status, "completed");
  assert.equal(cleared.stageHistory.length, 2);
  assert.deepEqual(cleared.immediateSends.map((send) => send.outcome), [{
    outcome: "sent",
    providerMessageId: "SM-stage-1",
  }, {
    outcome: "sent",
    providerMessageId: "SM-terminal-stage",
  }]);
  assert.deepEqual(ifMatches, [
    'W/"1"',
    'W/"2"',
    'W/"3"',
    'W/"4"',
    'W/"5"',
    'W/"6"',
    'W/"7"',
  ]);
});
