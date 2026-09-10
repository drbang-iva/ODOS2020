import assert from "node:assert/strict";
import { test } from "node:test";
import { createInMemoryEducationEnrollmentStore, type NewEducationEnrollment } from "../src/comms/education-enrollment.js";
import { educationSequenceRowId, enrollmentAdmissionBytes, type EducationSequenceInput } from "../src/comms/education-sequence.js";
const actor = "Practitioner/synthetic-provider";
const at = "2026-09-09T12:00:00.000Z";
const input = (): NewEducationEnrollment => ({ patientReference: "Patient/synthetic", journey: { id: "journey", version: 1 }, currentStageId: "start", stageEnteredAt: at, enteredFromEncounterReference: "Encounter/synthetic", enrolledBy: actor, status: "active", stageHistory: [{ stageId: "start", enteredAt: at, enteredBy: actor, reason: "enrollment-recorded" }], immediateSends: [] });
export function sequence(count = 1): EducationSequenceInput { return { id: "sequence", version: 1, steps: Array.from({ length: count }, (_, stepIndex) => ({ stepIndex, channel: "sms", lane: "clinical", content: { id: "content", version: 1 }, recipientReference: "Patient/synthetic", plannedAt: "2026-09-10T12:00:00.000Z", notBefore: "2026-09-10T12:00:00.000Z", latestUsefulTime: "2026-09-15T12:00:00.000Z", anchor: "stage-entry", offsetDays: 1, dayInterpretation: "calendar", timezone: "America/New_York" })) }; }
test("sequence admission retry binds identical rows and rejects changed intent", async () => { const store = createInMemoryEducationEnrollmentStore(); const row = await store.create(input()); const admission = { requestId: "retry", sequence: sequence(2), authorizedAt: at, authorizedBy: actor }; const first = await store.admitSequence(row.id, admission); const second = await store.admitSequence(row.id, admission); assert.equal(second.scheduledSends?.length, 2); assert.deepEqual(second, first); await assert.rejects(store.admitSequence(row.id, { ...admission, sequence: sequence(3) })); });
test("activation ceiling refuses whole 65-delivery activation before write", async () => { const store = createInMemoryEducationEnrollmentStore(); const row = await store.create(input()); await assert.rejects(store.admitSequence(row.id, { requestId: "over", sequence: sequence(65), authorizedAt: at, authorizedBy: actor }), /activation-delivery-limit/); assert.deepEqual(await store.read(row.id), row); });
test("lifetime ceiling across four activations preserves rows and permits stop", async () => {
  const store = createInMemoryEducationEnrollmentStore();
  let row = await store.create(input());
  for (let n = 0; n < 4; n++)
    row = await store.admitSequence(row.id, { requestId: `activation-${n}`, sequence: sequence(64), authorizedAt: at, authorizedBy: actor });
  assert.equal(row.scheduledSends?.length, 256);
  console.log('256-row admission budget bytes:', enrollmentAdmissionBytes(row));
  await assert.rejects(store.admitSequence(row.id, { requestId: "crossing", sequence: sequence(2), authorizedAt: at, authorizedBy: actor }), /enrollment-row-limit/);
  assert.deepEqual(await store.read(row.id), row);
  const stopped = await store.stopSequence(row.id, { activationId: row.activations![0]!.id, actor, at, reason: "operator-stop" });
  assert.equal(stopped.scheduledSends?.filter(s => s.disposition === "cancelled").length, 64);
  assert.equal(stopped.scheduledSends?.length, 256);
});
test("transition cancels old occurrence and restart never revives keys", async () => { const store = createInMemoryEducationEnrollmentStore(); let row = await store.create({ ...input(), sequence: sequence(2), requestId: "initial" }); const oldIds = row.scheduledSends!.map(s => s.id); row = await store.transition(row.id, { fromStageId: "start", targetStageId: "next", trigger: "clinician-action", enteredAt: at, enteredBy: actor, status: "active", immediateSends: [], sequence: sequence(), requestId: "next" }); assert.deepEqual(row.scheduledSends!.slice(0, 2).map(s => s.disposition), ["cancelled", "cancelled"]); row = await store.transition(row.id, { fromStageId: "next", targetStageId: "start", trigger: "clinician-action", enteredAt: at, enteredBy: actor, status: "active", immediateSends: [], sequence: sequence(), requestId: "return" }); assert.equal(row.scheduledSends!.at(-1)!.disposition, "scheduled"); assert.ok(!oldIds.includes(row.scheduledSends!.at(-1)!.id)); });
test("scheduled identities never share immediate-send namespace", () => {
  for (const activation of ["abc", "stage1", "enrollment:abc:stage1:1"])
    for (const channel of ["sms", "email", "print"] as const)
      for (let n = 0; n < 256; n++) {
        const key = educationSequenceRowId(activation, n, channel);
        assert.ok(!key.startsWith("enrollment:"));
        assert.equal(key, educationSequenceRowId(activation, n, channel));
      }
});
test("stopped activation remains cancelled while separately authorized activation survives", async () => { const store = createInMemoryEducationEnrollmentStore(); let row = await store.create({ ...input(), sequence: sequence(), requestId: "one" }); row = await store.admitSequence(row.id, { requestId: "two", sequence: sequence(), authorizedAt: at, authorizedBy: actor }); row = await store.stopSequence(row.id, { activationId: row.activations![0]!.id, actor, at, reason: "stop-one" }); assert.deepEqual(row.scheduledSends!.map(s => s.disposition), ["cancelled", "scheduled"]); const after = await store.admitSequence(row.id, { requestId: "one", sequence: sequence(), authorizedAt: at, authorizedBy: actor }); assert.equal(after.scheduledSends![0]!.disposition, "cancelled"); });
test("transition retry uses original binding before stale-from-stage check", async () => { const store = createInMemoryEducationEnrollmentStore(); const row = await store.create({ ...input(), sequence: sequence(), requestId: "one" }); const transition = { fromStageId: "start", targetStageId: "next", trigger: "clinician-action", enteredAt: at, enteredBy: actor, status: "active" as const, immediateSends: [], sequence: sequence(), requestId: "two" }; const first = await store.transition(row.id, transition); assert.deepEqual(await store.transition(row.id, transition), first); });
test("create retry refuses changed clinical context", async () => {
  const store = createInMemoryEducationEnrollmentStore();
  const body = { ...input(), sequence: sequence(), requestId: "one" };
  await store.create(body);
  for (const patch of [{ currentStageId: "changed" }, { journey: { id: "journey", version: 2 } }, { immediateSends: [{ content: { id: "content", version: 1 }, channel: "sms" as const, lane: "clinical" as const }] }])
    await assert.rejects(store.create({ ...body, ...patch }), /request-id-conflict/);
});
