import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import type { Basic, Bundle, Resource } from "@medplum/fhirtypes";
import { createFhirEducationEnrollmentStore, type NewEducationEnrollment } from "../src/comms/education-enrollment.js";
import { type EducationSequenceInput } from "../src/comms/education-sequence.js";
const actor = "Practitioner/synthetic";
const at = "2026-09-09T12:00:00.000Z";
function sequence(count = 1): EducationSequenceInput { return { id: "seq", version: 1, steps: Array.from({ length: count }, (_, stepIndex) => ({ stepIndex, channel: "sms", lane: "clinical", content: { id: "content", version: 1 }, recipientReference: "Patient/synthetic", plannedAt: "2026-09-10T12:00:00.000Z", notBefore: "2026-09-10T12:00:00.000Z", latestUsefulTime: "2026-09-15T12:00:00.000Z", anchor: "stage-entry", offsetDays: 1, dayInterpretation: "calendar", timezone: "America/New_York" })) }; }
function input(): NewEducationEnrollment { return { patientReference: "Patient/synthetic", journey: { id: "journey", version: 1 }, currentStageId: "start", stageEnteredAt: at, enteredFromEncounterReference: "Encounter/synthetic", enrolledBy: actor, status: "active", stageHistory: [{ stageId: "start", enteredAt: at, enteredBy: actor, reason: "enrollment-recorded" }], immediateSends: [], sequence: sequence(), requestId: "initial" }; }
function fake() {
  let persisted: Basic | undefined;
  let writes = 0;
  const fhir = { baseUrl: "http://synthetic.invalid/fhir/R4", async search<T extends Resource>(): Promise<Bundle<T>> { return { resourceType: "Bundle", type: "searchset", entry: persisted ? [{ resource: structuredClone(persisted) as T }] : [] }; }, async searchUrl<T extends Resource>(): Promise<Bundle<T>> { throw new Error("No pagination"); }, async create<T extends Resource>(resource: T, options?: Record<string, string>): Promise<T> {
      if (persisted && options?.["If-None-Exist"])
        return structuredClone(persisted) as T;
      persisted = { ...structuredClone(resource) as Basic, id: "synthetic-enrollment", meta: { versionId: randomUUID() } };
      writes++;
      return structuredClone(persisted) as T;
    }, async read<T extends Resource>(): Promise<T> { assert.ok(persisted); return structuredClone(persisted) as T; }, async update<T extends Resource>(_type: T["resourceType"], id: string, resource: T, options?: Record<string, string>): Promise<T> {
      assert.equal(_type, "Basic");
      assert.equal(id, persisted?.id);
      if (options?.["If-Match"] !== `W/"${persisted?.meta?.versionId}"`)
        throw Object.assign(new Error("Stale version"), { status: 412 });
      persisted = { ...structuredClone(resource) as Basic, meta: { versionId: randomUUID() } };
      writes++;
      return structuredClone(persisted) as T;
    } };
  return { fhir, get persisted() { return persisted!; }, get writes() { return writes; } };
}
test("FHIR activation round-trip and transition are one versioned Basic write; over-cap writes nothing", async () => { const db = fake(); const store = createFhirEducationEnrollmentStore(db.fhir); const initial = await store.create(input()); assert.equal(initial.scheduledSends?.length, 1); const before = db.writes; const transition = { fromStageId: "start", targetStageId: "next", enteredAt: at, enteredBy: actor, trigger: "clinician-action", status: "active" as const, immediateSends: [], sequence: sequence(), requestId: "next" }; const next = await store.transition(initial.id, transition); assert.equal(db.writes, before + 1); assert.deepEqual(next.scheduledSends!.map(row => row.disposition), ["cancelled", "scheduled"]); const unchanged = structuredClone(db.persisted); await assert.rejects(store.transition(next.id, { ...transition, fromStageId: "next", targetStageId: "later", requestId: "over", sequence: sequence(65) }), /activation-delivery-limit/); assert.deepEqual(db.persisted, unchanged); });
test("FHIR concurrent lifecycle writers refuse stale UUID If-Match, and missing version fails closed", async () => {
  const db = fake();
  const store = createFhirEducationEnrollmentStore(db.fhir);
  const row = await store.create(input());
  const results = await Promise.allSettled([store.stopSequence(row.id, { activationId: row.activations![0]!.id, actor, at, reason: "stop" }), store.admitSequence(row.id, { requestId: "second", sequence: sequence(), authorizedBy: actor, authorizedAt: at })]);
  assert.equal(results.filter(r => r.status === "fulfilled").length, 1);
  assert.equal(results.filter(r => r.status === "rejected" && (r.reason as {
    message?: string;
  }).message === "stale-enrollment-version").length, 1);
  assert.equal((await store.read(row.id))!.scheduledSends![0]!.disposition, "cancelled");
  delete db.persisted.meta;
  const writes = db.writes;
  await assert.rejects(store.admitSequence(row.id, { requestId: "missing-version", sequence: sequence(), authorizedBy: actor, authorizedAt: at }), /version is required/);
  assert.equal(db.writes, writes);
});
test("unresolved original attempt holds next stage until practitioner acknowledgement", async () => { const db = fake(); const store = createFhirEducationEnrollmentStore(db.fhir); const row = await store.create({ ...input(), immediateSends: [{ content: { id: "content", version: 1 }, channel: "sms", lane: "clinical" }] }); const send = db.persisted.extension!.find(e => e.url.endsWith("education-enrollment-immediate-send"))!; send.extension!.find(e => e.url === "state")!.valueCode = "in-flight"; const next = await store.transition(row.id, { fromStageId: "start", targetStageId: "next", enteredAt: at, enteredBy: actor, trigger: "clinician-action", status: "active", immediateSends: [{ content: { id: "content", version: 1 }, channel: "sms", lane: "clinical" }], sequence: sequence(), requestId: "next" }); assert.equal(next.scheduledSends!.at(-1)!.disposition, "held"); assert.equal((await store.claimImmediateSend(row.id, 1)).claimed, false); await store.markImmediateSendIndeterminate(row.id, 0, { acknowledgedAt: at, acknowledgedBy: actor, reason: "reviewed-indeterminate" }); const resumed = await store.applyLifecycle(row.id, { actor, at, reason: "reviewed-indeterminate" }); assert.equal(resumed.scheduledSends!.at(-1)!.disposition, "scheduled"); });
test("scheduling dispositions cannot inflate the persisted test-only sent-outcome query", async () => { const db = fake(); const store = createFhirEducationEnrollmentStore(db.fhir); const row = await store.create({ ...input(), sequence: sequence(5), immediateSends: [{ content: { id: "content", version: 1 }, channel: "sms", lane: "clinical" }] }); const send = db.persisted.extension!.find(e => e.url.endsWith("education-enrollment-immediate-send"))!; send.extension!.find(e => e.url === "state")!.valueCode = "resolved"; send.extension!.push({ url: "outcome", valueCode: "sent" }, { url: "provider-message-id", valueString: "historical-synthetic" }); const dispositions = ["waiting", "scheduled", "held", "cancelled", "closed"]; db.persisted.extension!.filter(e => e.url.endsWith("education-enrollment-scheduled-send")).forEach((extension, i) => { const scheduled = JSON.parse(extension.valueString!); scheduled.disposition = dispositions[i]; if (scheduled.disposition === "held")
  scheduled.holdReason = "patient-seen"; extension.valueString = JSON.stringify(scheduled); }); const persisted = (await store.read(row.id))!; const count = persisted.immediateSends.filter(send => send.outcome?.outcome === "sent").length; assert.equal(count, 1); assert.deepEqual(persisted.scheduledSends!.map(row => row.disposition), dispositions); });
