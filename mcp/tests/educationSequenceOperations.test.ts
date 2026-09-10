import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import express from "express";
import { registerCommsApiRoutes } from "../src/comms/comms-api.js";
import type { Basic, Bundle, Resource, Task } from "@medplum/fhirtypes";
import { createFhirEducationEnrollmentStore, type NewEducationEnrollment } from "../src/comms/education-enrollment.js";
import { educationSequenceRowId } from "../src/comms/education-sequence.js";
import { createEducationSequenceOperations } from "../src/comms/education-sequence-operations.js";
import { claimScheduledAttempt, admitScheduledAttempt, scheduledEnrollmentSnapshot } from "../src/comms/education-sequence-store.js";

const at = "2026-09-10T15:00:00.000Z";
async function fixture(channel: "sms" | "print" = "sms") {
  const resources = new Map<string, Resource>();
  let beforeUpdate: (() => Promise<void>) | undefined;
  const fhir = {
    baseUrl: "http://synthetic.invalid",
    async search<T extends Resource>(type: string, params: Record<string, string> = {}): Promise<Bundle<T>> {
      return { resourceType: "Bundle", type: "searchset", entry: [...resources.values()].filter(resource => resource.resourceType === type && (!params.identifier || (resource as Task).identifier?.some(value => `${value.system}|${value.value}` === params.identifier))).map(resource => ({ resource: structuredClone(resource) as T })) };
    },
    async searchProject<T extends Resource>(type: string, project: string, params: Record<string, string> = {}): Promise<Bundle<T>> {
      assert.equal(project, "practice");
      return { resourceType: "Bundle", type: "searchset", entry: [...resources.values()].filter(resource => resource.resourceType === type && (!params._id || resource.id === params._id)).map(resource => ({ resource: structuredClone(resource) as T })) };
    },
    async create<T extends Resource>(resource: T, headers?: Record<string, string>): Promise<T> {
      const identifier = headers?.["If-None-Exist"]?.replace(/^identifier=/, "");
      if (identifier) {
        const existing = [...resources.values()].find(candidate => candidate.resourceType === resource.resourceType && (candidate as Task).identifier?.some(value => value.value === identifier));
        if (existing) return structuredClone(existing) as T;
      }
      const saved = { ...structuredClone(resource), id: randomUUID(), meta: { ...resource.meta, project: "practice", versionId: randomUUID() } };
      resources.set(`${resource.resourceType}/${saved.id}`, saved);
      return structuredClone(saved);
    },
    async read<T extends Resource>(type: string, id: string): Promise<T> {
      const found = resources.get(`${type}/${id}`);
      if (!found) throw Object.assign(new Error("not found"), { status: 404 });
      return structuredClone(found) as T;
    },
    async update<T extends Resource>(type: string, id: string, resource: T, headers?: Record<string, string>): Promise<T> {
      if (beforeUpdate) { const callback = beforeUpdate; beforeUpdate = undefined; await callback(); }
      const old = resources.get(`${type}/${id}`)!;
      if (headers?.["If-Match"] !== `W/"${old.meta!.versionId}"`) throw Object.assign(new Error("stale"), { status: 412 });
      const saved = { ...structuredClone(resource), meta: { ...resource.meta, versionId: randomUUID() } };
      resources.set(`${type}/${id}`, saved);
      return structuredClone(saved);
    },
  };
  resources.set("Patient/synthetic", { resourceType: "Patient", id: "synthetic", meta: { project: "practice", versionId: randomUUID() } });
  const input: NewEducationEnrollment = {
    patientReference: "Patient/synthetic", journey: { id: "journey", version: 1 }, currentStageId: "start", stageEnteredAt: "2026-09-07T15:00:00.000Z", enteredFromEncounterReference: "Encounter/initial", enrolledBy: "Practitioner/synthetic", status: "active",
    stageHistory: [{ stageId: "start", enteredAt: "2026-09-07T15:00:00.000Z", enteredBy: "Practitioner/synthetic", reason: "enrollment" }], immediateSends: [], requestId: "synthetic-sequence",
    sequence: { id: "sequence", version: 1, steps: [{ stepIndex: 0, channel, lane: "clinical", content: { id: "education", version: 1 }, recipientReference: "Patient/synthetic", plannedAt: "2026-09-08T15:00:00.000Z", notBefore: "2026-09-08T15:00:00.000Z", latestUsefulTime: "2026-09-15T15:00:00.000Z", anchor: "stage-entry", offsetDays: 1, dayInterpretation: "calendar", timezone: "America/New_York" }] },
  };
  const store = createFhirEducationEnrollmentStore(fhir);
  const enrollment = await store.create(input);
  const snapshot = () => scheduledEnrollmentSnapshot(structuredClone(resources.get(`Basic/${enrollment.id}`) as Basic));
  const operations = createEducationSequenceOperations({ fhir, practiceProjectId: "practice", now: () => at });
  return { resources, fhir, store, enrollment, snapshot, operations, setBeforeUpdate(callback: () => Promise<void>) { beforeUpdate = callback; } };
}

test("operations queue conditionally deduplicates malformed records without a fabricated patient", async () => {
  const f = await fixture();
  const basic: Basic = { resourceType: "Basic", id: "broken", meta: { project: "practice", versionId: randomUUID() } };
  f.resources.set("Basic/broken", basic);
  const item = { enrollmentId: "broken", reason: "malformed-enrollment", at };
  await f.operations.staffItem(item);
  await f.operations.staffItem(item);
  const tasks = [...f.resources.values()].filter((resource): resource is Task => resource.resourceType === "Task");
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].for, undefined);
  assert.equal(tasks[0].focus?.reference, "Basic/broken");
  const items = await f.operations.list();
  assert.equal(items.length, 1);
  assert.equal(items[0].patientReference, undefined);
  assert.equal(items[0].reason, "malformed-enrollment");
});

test("clinician skip closes pending logical delivery atomically and records an explicit pacing anchor", async () => {
  const f = await fixture();
  const admitted = await admitScheduledAttempt(f.fhir, f.snapshot(), f.enrollment.scheduledSends![0].id, at);
  const row = admitted.enrollment.scheduledSends![0];
  const result = await f.operations.review(f.enrollment.id, row.id, { action: "skip", reason: "Clinician reviewed the next step", expectedVersion: admitted.resource.meta!.versionId!, actorReference: "Practitioner/synthetic" }, f.fhir);
  assert.equal(result.enrollment.currentStageId, f.enrollment.currentStageId);
  assert.equal(result.enrollment.status, "active");
  assert.equal(result.enrollment.scheduledSends![0].disposition, "closed");
  assert.deepEqual(result.enrollment.scheduledSends![0].runtime?.clinicianSkip, { at, by: "Practitioner/synthetic", reason: "Clinician reviewed the next step" });
  assert.equal(result.enrollment.immediateSends[0].state, "resolved");
  assert.equal(result.enrollment.immediateSends[0].outcome?.outcome, "not-sent");
});

test("worker claim winning the shared Basic race refuses clinician skip with typed stale version", async () => {
  const f = await fixture();
  const admitted = await admitScheduledAttempt(f.fhir, f.snapshot(), f.enrollment.scheduledSends![0].id, at);
  const rowId = admitted.enrollment.scheduledSends![0].id;
  f.setBeforeUpdate(async () => { await claimScheduledAttempt(f.fhir, admitted, rowId, at); });
  await assert.rejects(f.operations.review(f.enrollment.id, rowId, { action: "skip", reason: "Skip requested", expectedVersion: admitted.resource.meta!.versionId!, actorReference: "Practitioner/synthetic" }, f.fhir), /stale-enrollment-version/);
  assert.equal(f.snapshot().enrollment.immediateSends[0].state, "in-flight");
  assert.equal(f.snapshot().enrollment.scheduledSends![0].runtime?.clinicianSkip, undefined);
});

async function holdRow(f: Awaited<ReturnType<typeof fixture>>, reason: "patient-seen" | "needs-acknowledgement" | "content-unavailable", detail = reason as string) {
  const current = f.snapshot();
  const row = current.enrollment.scheduledSends![0];
  row.disposition = "held";
  row.holdReason = reason;
  row.events.push({ kind: "held", actor: "Practitioner/synthetic", at, reason: detail });
  const { writeScheduledEnrollment } = await import("../src/comms/education-sequence-store.js");
  const saved = await writeScheduledEnrollment(f.fhir, current);
  await f.operations.staffItem({ enrollmentId: f.enrollment.id, rowId: row.id, patientReference: "Patient/synthetic", reason: detail, at });
  return saved;
}

test("queue derives current action choices and settled state from enrollment instead of Task write success", async () => {
  const f = await fixture();
  const current = await holdRow(f, "content-unavailable");
  const items = await f.operations.list();
  assert.deepEqual(items[0].allowedActions, ["skip", "resume"]);
  assert.equal(items[0].patientReference, "Patient/synthetic");
  assert.equal(items[0].expectedVersion, current.resource.meta!.versionId);
  await f.operations.review(f.enrollment.id, current.enrollment.scheduledSends![0].id, { action: "skip", reason: "Clinician skipped", expectedVersion: items[0].expectedVersion!, actorReference: "Practitioner/synthetic" }, f.fhir);
  const settled = await f.operations.list();
  assert.equal(settled[0].state, "settled");
  assert.deepEqual(settled[0].allowedActions, []);
});

test("patient-seen resume requires exact held encounter and verifies its practice and patient", async () => {
  const f = await fixture();
  f.resources.set("Encounter/review", { resourceType: "Encounter", id: "review", status: "finished", class: {}, subject: { reference: "Patient/synthetic" }, meta: { project: "practice", versionId: randomUUID() } });
  const current = await holdRow(f, "patient-seen", "patient-seen:Encounter/review");
  const rowId = current.enrollment.scheduledSends![0].id;
  const input = { action: "resume" as const, reason: "Visit reviewed", expectedVersion: current.resource.meta!.versionId!, actorReference: "Practitioner/synthetic" };
  await assert.rejects(f.operations.review(f.enrollment.id, rowId, input, f.fhir), /reviewed-encounter-required/);
  assert.equal((await f.operations.list())[0].encounterReference, "Encounter/review");
  const foreign = f.resources.get("Encounter/review")!;
  foreign.meta!.project = "foreign";
  await assert.rejects(f.operations.review(f.enrollment.id, rowId, { ...input, reviewedEncounterReference: "Encounter/review" }, f.fhir), /patient-mismatch/);
  foreign.meta!.project = "practice";
  const resumed = await f.operations.review(f.enrollment.id, rowId, { ...input, reviewedEncounterReference: "Encounter/review" }, f.fhir);
  assert.equal(resumed.enrollment.scheduledSends![0].disposition, "scheduled");
  assert.deepEqual(resumed.enrollment.scheduledSends![0].runtime?.reviewedEncounterReferences, ["Encounter/review"]);
});

test("later Task pages are visited while returned foreign-practice items remain excluded", async () => {
  const f = await fixture();
  await holdRow(f, "content-unavailable");
  const tasks = [...f.resources.values()].filter((resource): resource is Task => resource.resourceType === "Task");
  const search = f.fhir.searchProject;
  f.fhir.searchProject = async (type, project, params) => type === "Task" ? { resourceType: "Bundle", type: "searchset", entry: [], link: [{ relation: "next", url: "http://synthetic.invalid/fhir/R4/Task?page=2" }] } : search(type, project, params);
  let pages = 0;
  (f.fhir as any).searchProjectUrl = async () => {
    pages++;
    const foreign = structuredClone(tasks[0]);
    foreign.id = "foreign";
    foreign.meta!.project = "foreign";
    return { resourceType: "Bundle", type: "searchset", entry: [{ resource: tasks[0] }, { resource: foreign }] };
  };
  const items = await f.operations.list();
  assert.equal(pages, 1);
  assert.equal(items.length, 1);
  assert.equal(items[0].id, tasks[0].id);
});


async function routeServer(f: Awaited<ReturnType<typeof fixture>>, withOperations = true) {
  const app = express();
  app.use(express.json());
  registerCommsApiRoutes(app, {
    authenticateService: async () => undefined,
    authenticate: async (header: string | undefined) => header === "Bearer provider" || header === "Bearer staff" ? {
      staffReference: "Practitioner/synthetic", actorRole: header === "Bearer provider" ? "provider" : "staff", roles: [header === "Bearer provider" ? "provider" : "staff"], fhir: f.fhir,
    } : null,
    sequenceOperations: withOperations ? f.operations : undefined,
    audit: { record: async (_row: unknown, operation: () => Promise<unknown>) => operation(), recordDenied: async () => undefined },
  } as any);
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, close: async () => { server.close(); await once(server, "close"); } };
}

test("operations routes expose provider actions, deny staff review, and preserve typed stale 409", async () => {
  const f = await fixture();
  const current = await holdRow(f, "content-unavailable");
  const server = await routeServer(f);
  const path = `/communications/education/enrollments/${f.enrollment.id}/scheduled-sends/${encodeURIComponent(f.enrollment.scheduledSends![0].id)}/review`;
  try {
    const denied = await fetch(`${server.base}/communications/education/sequence-work`);
    assert.equal(denied.status, 401);
    const listed = await fetch(`${server.base}/communications/education/sequence-work`, { headers: { authorization: "Bearer provider" } });
    assert.equal(listed.status, 200);
    assert.deepEqual((await listed.json()).items[0].allowedActions, ["skip", "resume"]);
    const staffList = await fetch(`${server.base}/communications/education/sequence-work`, { headers: { authorization: "Bearer staff" } });
    assert.deepEqual((await staffList.json()).items[0].allowedActions, []);
    const send = (actor: string, expectedVersion: string) => fetch(`${server.base}${path}`, { method: "POST", headers: { authorization: `Bearer ${actor}`, "content-type": "application/json" }, body: JSON.stringify({ action: "skip", reason: "Clinician reviewed", expectedVersion }) });
    assert.equal((await send("staff", current.resource.meta!.versionId!)).status, 409);
    const stale = await send("provider", randomUUID());
    assert.equal(stale.status, 409);
    assert.deepEqual(await stale.json(), { outcome: "refused", reason: "stale-enrollment-version" });
    const saved = await send("provider", current.resource.meta!.versionId!);
    assert.equal(saved.status, 200);
    assert.equal((await saved.json()).enrollment.scheduledSends[0].disposition, "closed");
  } finally { await server.close(); }
});

test("operations route refuses missing dependency without querying the education catalog", async () => {
  const f = await fixture();
  const server = await routeServer(f, false);
  try {
    const response = await fetch(`${server.base}/communications/education/sequence-work`, { headers: { authorization: "Bearer provider" } });
    assert.equal(response.status, 409);
  } finally { await server.close(); }
});


test("clinician stop winning the review race retains cancellation history", async () => {
  const f = await fixture();
  const current = f.snapshot();
  f.setBeforeUpdate(async () => {
    await f.store.stopSequence(f.enrollment.id, { activationId: f.enrollment.activations![0].id, actor: "Practitioner/synthetic", at, reason: "Clinician stopped sequence" });
  });
  await assert.rejects(f.operations.review(f.enrollment.id, f.enrollment.scheduledSends![0].id, { action: "skip", reason: "Skip requested", expectedVersion: current.resource.meta!.versionId!, actorReference: "Practitioner/synthetic" }, f.fhir), /stale-enrollment-version/);
  const row = f.snapshot().enrollment.scheduledSends![0];
  assert.equal(row.disposition, "cancelled");
  assert.equal(row.events.at(-1)?.reason, "Clinician stopped sequence");
  assert.equal(row.runtime?.clinicianSkip, undefined);
});

test("clinician skip winning the claim race resolves pending without authorizing provider dispatch", async () => {
  const f = await fixture();
  const admitted = await admitScheduledAttempt(f.fhir, f.snapshot(), f.enrollment.scheduledSends![0].id, at);
  const rowId = admitted.enrollment.scheduledSends![0].id;
  await f.operations.review(f.enrollment.id, rowId, { action: "skip", reason: "Skip requested", expectedVersion: admitted.resource.meta!.versionId!, actorReference: "Practitioner/synthetic" }, f.fhir);
  await assert.rejects(claimScheduledAttempt(f.fhir, admitted, rowId, at), /stale-enrollment-version/);
  assert.equal(f.snapshot().enrollment.immediateSends[0].state, "resolved");
  assert.equal(f.snapshot().enrollment.immediateSends[0].outcome?.outcome, "not-sent");
});

for (const outcome of [{ outcome: "suppressed", reason: "patient-opt-out" }, { outcome: "not-sent", reason: "not-delivered" }] as const) {
  test(`terminal ${outcome.outcome} only offers skip, never a resume that replays its terminal key`, async () => {
    const f = await fixture();
    const admitted = await admitScheduledAttempt(f.fhir, f.snapshot(), f.enrollment.scheduledSends![0].id, at);
    await claimScheduledAttempt(f.fhir, admitted, f.enrollment.scheduledSends![0].id, at);
    await f.store.recordImmediateSendOutcome(f.enrollment.id, 0, outcome);
    const current = await holdRow(f, "needs-acknowledgement");
    assert.deepEqual((await f.operations.list())[0].allowedActions, ["skip"]);
    await assert.rejects(f.operations.review(f.enrollment.id, f.enrollment.scheduledSends![0].id, { action: "resume", reason: "Resume requested", expectedVersion: current.resource.meta!.versionId!, actorReference: "Practitioner/synthetic" }, f.fhir), /requires-skip/);
  });
}

test("in-flight and accepted rows cannot be skipped, including acceptance recorded only on Communication", async () => {
  const f = await fixture();
  const admitted = await admitScheduledAttempt(f.fhir, f.snapshot(), f.enrollment.scheduledSends![0].id, at);
  const claimed = await claimScheduledAttempt(f.fhir, admitted, f.enrollment.scheduledSends![0].id, at);
  const review = () => f.operations.review(f.enrollment.id, f.enrollment.scheduledSends![0].id, { action: "skip", reason: "Skip requested", expectedVersion: f.snapshot().resource.meta!.versionId!, actorReference: "Practitioner/synthetic" }, f.fhir);
  await assert.rejects(review(), /needs-acknowledgement/);
  await f.store.markImmediateSendIndeterminate(f.enrollment.id, 0, { reason: "Operator reviewed unknown outcome", acknowledgedAt: at, acknowledgedBy: "Practitioner/synthetic" });
  const { ODOS_COMMS_STAFF_SEND_IDENTIFIER_SYSTEM } = await import("../src/comms/comms-persistence.js");
  f.resources.set("Communication/accepted", { resourceType: "Communication", id: "accepted", status: "completed", sent: at, subject: { reference: "Patient/synthetic" }, sender: { reference: "Practitioner/synthetic" }, identifier: [{ system: ODOS_COMMS_STAFF_SEND_IDENTIFIER_SYSTEM, value: claimed.enrollment.immediateSends[0].idempotencyKey }], meta: { project: "practice", versionId: randomUUID() } });
  await assert.rejects(review(), /accepted-sequence-step/);
  assert.equal(f.snapshot().enrollment.scheduledSends![0].runtime?.clinicianSkip, undefined);
});

test("print tasks only offer skip and invalid clinician skip metadata cannot become a timing anchor", async () => {
  const f = await fixture("print");
  const current = await holdRow(f, "needs-acknowledgement", "print-handout-due");
  assert.deepEqual((await f.operations.list())[0].allowedActions, ["skip"]);
  const row = current.enrollment.scheduledSends![0];
  row.disposition = "closed";
  row.runtime = { clinicianSkip: { at: 1 as any, by: "Practitioner/synthetic", reason: "Reviewed" } };
  const { validateStoredEducationSequences } = await import("../src/comms/education-sequence.js");
  assert.throws(() => validateStoredEducationSequences(current.enrollment), /skip/);
});


for (const defect of ["key", "content", "channel", "lane", "acceptedAt", "providerNeverInvoked", "predecessor", "duplicate-binding"] as const) {
  test(`stored attempt ${defect} corruption is rejected before worker or review can trust it`, async () => {
    const f = await fixture();
    const admitted = await admitScheduledAttempt(f.fhir, f.snapshot(), f.enrollment.scheduledSends![0].id, at);
    const row = admitted.enrollment.scheduledSends![0];
    const attempt = row.attempts[0];
    const send = admitted.enrollment.immediateSends[0];
    if (defect === "key") attempt.attemptKey = "education-sequence-mismatched";
    if (defect === "content") send.content.id = "other-content";
    if (defect === "channel") send.channel = "email";
    if (defect === "lane") send.lane = "frontdesk";
    if (defect === "acceptedAt") attempt.acceptedAt = "not-an-instant";
    if (defect === "providerNeverInvoked") attempt.providerNeverInvoked = false as any;
    if (defect === "predecessor") attempt.predecessorAttemptKey = attempt.attemptKey;
    if (defect === "duplicate-binding") {
      const duplicate = structuredClone(row);
      duplicate.stepIndex += 1;
      duplicate.id = educationSequenceRowId(duplicate.activationId, duplicate.stepIndex, duplicate.channel);
      admitted.enrollment.scheduledSends!.push(duplicate);
    }
    const { validateStoredEducationSequences } = await import("../src/comms/education-sequence.js");
    assert.throws(() => validateStoredEducationSequences(admitted.enrollment), /attempt/);
  });
}

test("staff item verifies a scoped reload when create responses omit extended metadata", async () => {
  const f = await fixture();
  const create = f.fhir.create.bind(f.fhir);
  f.fhir.create = async (...args: Parameters<typeof f.fhir.create>) => {
    const result = await create(...args);
    if (result.resourceType === "Task") delete result.meta?.project;
    return result;
  };
  const item = { enrollmentId: f.enrollment.id, rowId: f.enrollment.scheduledSends![0].id, patientReference: "Patient/synthetic", reason: "content-unavailable", at };
  await f.operations.staffItem(item);
  await f.operations.staffItem(item);
  assert.equal([...f.resources.values()].filter(resource => resource.resourceType === "Task").length, 1);
  assert.equal((await f.operations.list()).length, 1);
});

test("staff item refuses a foreign or mismatched Task returned by the scoped reload", async () => {
  for (const change of ["foreign", "identity"] as const) {
    const f = await fixture();
    const create = f.fhir.create.bind(f.fhir);
    f.fhir.create = async (...args: Parameters<typeof f.fhir.create>) => {
      const result = await create(...args);
      if (result.resourceType === "Task") {
        const saved = f.resources.get(`Task/${result.id}`) as Task;
        if (change === "foreign") saved.meta!.project = "foreign";
        else saved.focus = { reference: "Basic/different" };
        delete result.meta?.project;
      }
      return result;
    };
    await assert.rejects(f.operations.staffItem({ enrollmentId: f.enrollment.id, reason: "content-unavailable", at }), /foreign practice|identity conflict/);
  }
});

test("exhausted attempts offer skip and refuse a resume that would immediately hold again", async () => {
  const f = await fixture();
  const current = f.snapshot();
  const row = current.enrollment.scheduledSends![0];
  for (let index = 0; index < 3; index++) {
    const attemptKey = `education-sequence-${randomUUID()}`;
    row.attempts.push({ sendIndex: index, attemptKey, ...(index ? { predecessorAttemptKey: row.attempts[index - 1].attemptKey } : {}), ...(index < 2 ? { providerNeverInvoked: true as const } : {}) });
    current.enrollment.immediateSends.push({ content: row.content, channel: row.channel, lane: row.lane, idempotencyKey: attemptKey, state: "resolved", outcome: { outcome: "rescheduled", reason: "quiet-hours", rescheduledAt: at } });
  }
  const { writeScheduledEnrollment } = await import("../src/comms/education-sequence-store.js");
  await writeScheduledEnrollment(f.fhir, current);
  const held = await holdRow(f, "needs-acknowledgement", "attempt-limit");
  assert.deepEqual((await f.operations.list())[0].allowedActions, ["skip"]);
  await assert.rejects(f.operations.review(f.enrollment.id, row.id, { action: "resume", reason: "Retry requested", expectedVersion: held.resource.meta!.versionId!, actorReference: "Practitioner/synthetic" }, f.fhir), /scheduled-row-requires-skip/);
});
