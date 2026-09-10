import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import express from "express";
import type { Basic, Encounter, Patient, Practitioner } from "@medplum/fhirtypes";
import { createMedplumClient } from "../src/fhir-client.js";
import { createFhirEducationEnrollmentStore, type NewEducationEnrollment } from "../src/comms/education-enrollment.js";
import { admitScheduledAttempt, claimScheduledAttempt, readScheduledEnrollment, writeScheduledEnrollment } from "../src/comms/education-sequence-store.js";
import { EducationSequenceAdmissionError } from "../src/comms/education-sequence.js";
import { runOnce, type EducationSequenceWorkerDeps } from "../src/comms/education-sequence-worker.js";
import { registerCommsApiRoutes, type CommsApiRouteDeps } from "../src/comms/comms-api.js";
import { createEducationSequenceOperations } from "../src/comms/education-sequence-operations.js";
import { TEST_FHIR_AUDIT_CONTEXT, TEST_FHIR_AUDIT_RECORDER } from "./fhirAuditTestStub.js";

test("isolated synthetic Medplum enforces scheduled enrollment conditional writes", { skip: process.env.ODOS_SEQUENCE_LIVE_WRITE !== "1", timeout: 90_000 }, async (t) => {
  const base = process.env.ODOS_SEQUENCE_LIVE_BASE_URL!;
  const url = new URL(base);
  assert.ok(["127.0.0.1", "localhost"].includes(url.hostname), "Only an explicitly supplied loopback disposable server is allowed");
  assert.equal(process.env.ODOS_SEQUENCE_LIVE_DISPOSABLE, "1");
  const verifier = randomBytes(32).toString("base64url");
  const post = async (path: string, body: unknown) => {
    const response = await fetch(new URL(path, base), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    assert.ok(response.ok, `${path}: HTTP ${response.status}`);
    return response.json();
  };
  let registration = await post("auth/newuser", { projectId: "new", firstName: "Synthetic", lastName: "Sequence Proof", email: `${randomUUID()}@example.invalid`, password: `Seq2-${randomBytes(32).toString("base64url")}!`, remember: false, codeChallengeMethod: "S256", codeChallenge: createHash("sha256").update(verifier).digest("base64url"), recaptchaToken: "" });
  if (!registration.code) registration = await post("auth/newproject", { login: registration.login, projectName: `Synthetic sequence proof ${randomUUID()}` });
  assert.ok(registration.code);
  const tokenResponse = await fetch(new URL("oauth2/token", base), { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "authorization_code", code: registration.code, code_verifier: verifier }) });
  assert.equal(tokenResponse.status, 200);
  const { access_token: accessToken } = await tokenResponse.json();
  assert.ok(accessToken);
  const fhir = createMedplumClient({ baseUrl: base, accessToken, audit: TEST_FHIR_AUDIT_RECORDER, auditContext: TEST_FHIR_AUDIT_CONTEXT });
  const store = createFhirEducationEnrollmentStore(fhir);
  const projectId = await fhir.getActiveProjectId();
  t.diagnostic(`Disposable synthetic project: ${projectId}`);
  const patient = await fhir.create<Patient>({ resourceType: "Patient", name: [{ text: "Synthetic Sequence Proof" }] });
  const practitioner = await fhir.create<Practitioner>({ resourceType: "Practitioner", name: [{ text: "Synthetic Sequence Author" }] });
  const actor = `Practitioner/${practitioner.id}`;
  const patientReference = `Patient/${patient.id}`;
  const encounter = await fhir.create<Encounter>({ resourceType: "Encounter", status: "finished", class: { display: "Synthetic test encounter" }, subject: { reference: patientReference } });
  const at = "2026-09-10T14:00:00.000Z";
  const make = (): NewEducationEnrollment => ({ patientReference, journey: { id: `journey-${randomUUID()}`, version: 1 }, currentStageId: "start", stageEnteredAt: "2026-09-07T14:00:00.000Z", enteredFromEncounterReference: `Encounter/${encounter.id}`, enrolledBy: actor, status: "active", stageHistory: [{ stageId: "start", enteredAt: "2026-09-07T14:00:00.000Z", enteredBy: actor, reason: "enrollment-recorded" }], immediateSends: [], requestId: randomUUID(), sequence: { id: "synthetic-sequence", version: 1, steps: [{ stepIndex: 0, channel: "sms", lane: "clinical", content: { id: "synthetic-content", version: 1 }, recipientReference: patientReference, plannedAt: "2026-09-08T14:00:00.000Z", notBefore: "2026-09-08T14:00:00.000Z", latestUsefulTime: "2026-09-15T14:00:00.000Z", anchor: "stage-entry", offsetDays: 1, dayInterpretation: "calendar", timezone: "America/New_York" }] } });
  const stop = async (id: string) => { const e = (await store.read(id))!; return store.stopSequence(id, { activationId: e.activations![0].id, actor, at, reason: "synthetic-clinician-stop" }); };
  const typedConflict = (error: unknown) => error instanceof EducationSequenceAdmissionError && error.reason === "stale-enrollment-version";
  const underlyingUpdate = fhir.update.bind(fhir);
  const transportStatuses: number[] = [];
  fhir.update = async (...args: Parameters<typeof fhir.update>) => {
    try { return await underlyingUpdate(...args); } catch (error) { transportStatuses.push((error as { status: number }).status); throw error; }
  };
  await t.test("raw stale If-Match returns 412 and fresh version succeeds", async () => {
    const e = await store.create(make());
    const stale = await fhir.read<Basic>("Basic", e.id);
    await stop(e.id);
    const response = await fetch(new URL(`fhir/R4/Basic/${e.id}`, base), { method: "PUT", headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/fhir+json", "If-Match": `W/"${stale.meta!.versionId}"` }, body: JSON.stringify(stale) });
    assert.equal(response.status, 412);
    const fresh = await fhir.read<Basic>("Basic", e.id);
    const saved = await underlyingUpdate("Basic", e.id, fresh, { "If-Match": `W/"${fresh.meta!.versionId}"` });
    assert.notEqual(saved.meta!.versionId, stale.meta!.versionId);
    assert.equal((await store.read(e.id))!.scheduledSends![0].disposition, "cancelled");
    t.diagnostic("Raw HTTP 412; fresh If-Match update succeeded; cancellation retained");
  });
  await t.test("stale admission and stale claim fail with typed conflict after stop", async () => {
    for (const stage of ["admission", "claim"] as const) {
      const e = await store.create(make());
      let snapshot = await readScheduledEnrollment(fhir, e.id);
      const rowId = e.scheduledSends![0].id;
      if (stage === "claim") snapshot = await admitScheduledAttempt(fhir, snapshot, rowId, at);
      await stop(e.id);
      const operation = stage === "claim" ? claimScheduledAttempt : admitScheduledAttempt;
      await assert.rejects(operation(fhir, snapshot, rowId, at), typedConflict);
      assert.equal(transportStatuses.at(-1), 412);
      const retained = (await store.read(e.id))!;
      assert.equal(retained.scheduledSends![0].disposition, "cancelled");
      assert.ok(retained.scheduledSends![0].events.some(event => event.kind === "cancelled" && event.reason === "synthetic-clinician-stop"));
      assert.equal(retained.currentStageId, "start");
      assert.equal(retained.status, "active");
    }
    t.diagnostic("Admission + claim: real transport 412 -> stale-enrollment-version; cancellation histories retained");
  });
  await t.test("worker stop during preflight makes zero adapter calls", async () => {
    const e = await store.create(make());
    let stopped = false;
    let adapterCalls = 0;
    const workerFhir = { ...fhir, searchProject: (type: string, project: string, params: Record<string, string>) => fhir.searchProject(type as never, project, { ...params, ...(type === "Basic" ? { _id: e.id } : {}) }) } as typeof fhir;
    const deps: EducationSequenceWorkerDeps = { fhir: workerFhir, projectId, authenticate: async () => {}, store, now: () => at, spacingEnabled: false, prepare: async enrollment => { if (enrollment.id === e.id) { stopped = true; await stop(e.id); } return { kind: "ready", prepared: {} }; }, execute: async () => { adapterCalls++; throw new Error("Adapter must not run"); }, reconcile: async () => undefined, evidence: async () => undefined, staffItem: async () => {}, log: () => {} };
    await runOnce(deps);
    assert.equal(stopped, true, "Worker must actually reach the due row");
    assert.equal(adapterCalls, 0);
    assert.equal(transportStatuses.at(-1), 412);
    assert.equal((await store.read(e.id))!.scheduledSends![0].disposition, "cancelled");
    t.diagnostic("Actual worker enumerated real FHIR; stop after read; transport 412; adapter calls=0");
  });
  await t.test("staff queue persists, deduplicates and lists valid and malformed enrollment items", async () => {
    const enrollment = await store.create(make());
    const snapshot = await readScheduledEnrollment(fhir, enrollment.id);
    const row = snapshot.enrollment.scheduledSends![0];
    row.disposition = "held";
    row.holdReason = "content-unavailable";
    row.events.push({ kind: "held", actor, at, reason: "content-unavailable" });
    await writeScheduledEnrollment(fhir, snapshot);
    const malformed = await fhir.create<Basic>({ resourceType: "Basic", code: { text: "Synthetic deliberately malformed enrollment" } });
    const createObservations: { resourceType: string; projectPresent: boolean; id: string | undefined }[] = [];
    const opsFhir = { ...fhir, create: async (...args: Parameters<typeof fhir.create>) => {
      const created = await fhir.create(...args);
      createObservations.push({ resourceType: created.resourceType, projectPresent: !!created.meta?.project, id: created.id });
      return created;
    } } as typeof fhir;
    const operations = createEducationSequenceOperations({ fhir: opsFhir, practiceProjectId: projectId, now: () => at });
    const errors: string[] = [];
    for (const item of [
      { enrollmentId: enrollment.id, rowId: row.id, patientReference, reason: "content-unavailable", at },
      { enrollmentId: enrollment.id, rowId: row.id, patientReference, reason: "content-unavailable", at },
      { enrollmentId: malformed.id!, reason: "malformed-enrollment", at },
    ]) {
      try { await operations.staffItem(item); } catch (error) { errors.push((error as Error).message); }
    }
    const queue = await operations.list();
    const validItems = queue.filter(item => item.enrollmentId === enrollment.id);
    const malformedItems = queue.filter(item => item.enrollmentId === malformed.id);
    t.diagnostic(`Task create responses: ${JSON.stringify(createObservations)}`);
    t.diagnostic(`staffItem errors: ${JSON.stringify(errors)}; valid queue items=${validItems.length}; malformed queue items=${malformedItems.length}`);
    assert.equal(validItems.length, 1, "Two identical staffItem calls must create one queryable Task");
    assert.equal(malformedItems.length, 1, "Malformed enrollment must stay visible in Task code query");
    assert.equal(validItems[0].state, "open");
    assert.equal(validItems[0].patientReference, patientReference);
    assert.deepEqual(validItems[0].allowedActions, ["skip", "resume"]);
    assert.equal(malformedItems[0].patientReference, undefined);
    assert.deepEqual(malformedItems[0].allowedActions, []);
    assert.deepEqual(errors, [], "Successful durable Task writes must not be reported as failures");
  });
  await t.test("actual HTTP stop route maps real 412 to typed 409", async () => {
    const e = await store.create(make());
    const conflictingFhir = { ...fhir, update: async (...args: Parameters<typeof fhir.update>) => { const current = await fhir.read<Basic>("Basic", e.id); current.meta = { ...current.meta, tag: [{ display: "Synthetic competing writer" }] }; await underlyingUpdate("Basic", e.id, current, { "If-Match": `W/"${current.meta.versionId}"` }); return fhir.update(...args); } };
    const deps = { authenticateService: async () => {}, authenticate: async () => ({ staffReference: actor, actorRole: "provider", roles: ["provider"], fhir }), fhir, enrollmentStore: createFhirEducationEnrollmentStore(conflictingFhir), educationCatalog: { list: () => [], get: () => undefined }, dispatch: {}, trackedLinkStore: {}, publicBaseUrl: "https://example.invalid", practiceName: "Synthetic", audit: TEST_FHIR_AUDIT_RECORDER, now: () => at } as unknown as CommsApiRouteDeps;
    const app = express(); app.use(express.json()); registerCommsApiRoutes(app, deps);
    const server = app.listen(0, "127.0.0.1"); await once(server, "listening");
    try {
      const response = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/communications/education/enrollments/${e.id}/sequences/${encodeURIComponent(e.activations![0].id)}/stop`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer synthetic-route-fixture" }, body: JSON.stringify({ reason: "synthetic-conflict" }) });
      assert.equal(response.status, 409);
      assert.deepEqual(await response.json(), { outcome: "refused", reason: "stale-enrollment-version" });
      assert.equal(transportStatuses.at(-1), 412);
      assert.equal((await store.read(e.id))!.activations![0].status, "active");
      t.diagnostic("Actual route HTTP 409 stale-enrollment-version from real Medplum HTTP 412");
    } finally { server.close(); await once(server, "close"); }
  });
});
