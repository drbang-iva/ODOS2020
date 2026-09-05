import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { Encounter, Observation, Patient, Practitioner } from "@medplum/fhirtypes";
import { createAuthenticatedFhirClient } from "../tests/integration-helpers.js";
import { handleHpiRecordRequest, handleHistoryReviewRequest, handleHpiCaptureRequest, type HpiEndpointDeps } from "../src/clinical-graph/hpi-endpoint.js";
import { buildHistoryAnswerObservation, buildHistoryReviewAttestation, HISTORY_ITEM_REVIEW_CODE, HISTORY_REVIEW_ATTESTATION_CODE_SYSTEM } from "../src/clinical-graph/history-answer-observation.js";
import { searchAll } from "../src/fhir-search.js";

const baseUrl = process.env.MEDPLUM_BASE_URL!;
assert.ok(["localhost", "127.0.0.1"].includes(new URL(baseUrl).hostname));
const { fhir } = await createAuthenticatedFhirClient({ baseUrl, email: process.env.MEDPLUM_ADMIN_EMAIL!, password: process.env.MEDPLUM_ADMIN_PASSWORD! });
const patient = await fhir.create<Patient>({ resourceType: "Patient", active: true, name: [{ text: "Synthetic Item Review" }] });
const patientReference = `Patient/${patient.id}`;
const practitioner = await fhir.create<Practitioner>({ resourceType: "Practitioner", name: [{ text: "Synthetic Item Reviewer" }] });
const staffReference = `Practitioner/${practitioner.id}`;
const encounters = await Promise.all([0, 1].map(() => fhir.create<Encounter>({ resourceType: "Encounter", status: "in-progress", class: { display: "Synthetic test encounter" }, subject: { reference: patientReference } })));
const encounterReference = `Encounter/${encounters[1].id}`;
let now = "2026-09-01T12:00:00Z";
const deps: HpiEndpointDeps = { authenticate: async () => ({ staffReference, actorRole: "provider", fhir }), now: () => now };
const tobacco = { sectionKey: "social-history", sectionId: "tobacco" };
const occupation = { sectionKey: "social-history", sectionId: "occupation" };
const review = (targets: object[], gestureId = randomUUID(), encounter = encounterReference) => handleHistoryReviewRequest(deps, { authHeader: "synthetic", body: { patientReference, encounterReference: encounter, sectionKey: "social-history", action: "items-reviewed", method: "individual", targets, gestureId } });
const read = async () => { const result = await handleHpiRecordRequest(deps, { authHeader: "synthetic", params: { encounterId: encounters[1].id } }); assert.equal(result.status, 200); return result.body as any; };
const acts = () => searchAll<Observation>(fhir, "Observation", { subject: patientReference, code: `${HISTORY_REVIEW_ATTESTATION_CODE_SYSTEM}|${HISTORY_ITEM_REVIEW_CODE}`, _count: "20" }, { maxRows: 5000 });
const gesture = randomUUID();
const first = await review([tobacco], gesture); assert.equal(first.status, 200);
now = "2026-09-04T12:00:00Z";
assert.equal((await review([occupation])).status, 200);
assert.equal((await acts()).length, 2);
assert.deepEqual((await read()).lastReviewed, [{ target: tobacco, lastReviewed: "2026-09-01T12:00:00Z" }, { target: occupation, lastReviewed: now }]);
console.log("A then B: HTTP 200/200; 2 acts; both original dates intact");
const snapshot = await acts();
assert.deepEqual(await review([tobacco], gesture), first);
assert.deepEqual(await acts(), snapshot);
assert.equal((await review([occupation], gesture)).status, 409);
assert.deepEqual(await acts(), snapshot);
console.log("Retry: 2 acts unchanged including meta.versionId; changed targets HTTP 409");
const selected = { id: `${patient.id}-tobacco`, subjectScope: "patient" as const, templateKey: "social-history", sectionId: "tobacco", value: { kind: "selection" as const, code: "never" } };
for (const code of ["never", "former-smoker"]) {
  const result = await handleHpiCaptureRequest(deps, { authHeader: "synthetic", body: { patientReference, encounterReference, templateAnswers: [{ ...selected, value: { kind: "selection", code } }] } });
  assert.equal(result.status, 200); assert.deepEqual(await acts(), snapshot);
}
assert.equal((await read()).lastReviewed.find((r: any) => r.target.sectionId === "tobacco").lastReviewed, now);
console.log("Answer create/edit: 0 new acts; existing acts unchanged; later answer date wins");
for (let i = 0; i < 24; i++) assert.equal((await review([i % 2 ? tobacco : occupation], randomUUID(), `Encounter/${encounters[i % 2].id}`)).status, 200);
assert.equal((await acts()).length, 26); assert.equal((await read()).lastReviewed.length, 2);
console.log("Patient search: 26 acts across 2 encounters, paginated at 20; HTTP 200");
const priorAnswer = await fhir.create<Observation>(buildHistoryAnswerObservation({ id: `${patient.id}-legacy-x`, subjectScope: "patient", templateKey: "social-history", sectionId: "driving", optionCode: "drives-at-night", value: { kind: "tri-state", status: "negative" } }, { patientReference, encounterReference: `Encounter/${encounters[0].id}`, recordedAt: "2026-08-01T12:00:00Z" }));
const otherAnswer = await fhir.create<Observation>(buildHistoryAnswerObservation({ id: `${patient.id}-legacy-y`, subjectScope: "patient", templateKey: "social-history", sectionId: "home-safety", optionCode: "does-not-feel-safe-at-home", value: { kind: "tri-state", status: "negative" } }, { patientReference, encounterReference: `Encounter/${encounters[0].id}`, recordedAt: "2026-08-01T12:00:00Z" }));
await fhir.create<Observation>(buildHistoryReviewAttestation({ patientReference, encounterReference: `Encounter/${encounters[0].id}`, sectionKey: "social-history", actorReference: staffReference, recordedAt: now, priorAnswerReferences: [`Observation/${priorAnswer.id}`] }));
assert.ok(otherAnswer.id);
const legacyDates = (await read()).lastReviewed;
assert.equal(legacyDates.find((r: any) => r.target.sectionId === "driving").lastReviewed, now);
assert.equal(legacyDates.find((r: any) => r.target.sectionId === "home-safety").lastReviewed, "2026-08-01T12:00:00Z");
console.log("Legacy derivedFrom [x]: x gets act date; y retains its answer date");
// Both reads see no act before either transaction begins.
const raceGesture = randomUUID();
let arrived = 0;
let release!: () => void;
const barrier = new Promise<void>(resolve => { release = resolve; });
const concurrentDeps: HpiEndpointDeps = { ...deps, authenticate: async () => ({ staffReference, actorRole: "provider", fhir: {
  ...fhir,
  executeTransaction: async (...args: Parameters<typeof fhir.executeTransaction>) => { arrived++; if (arrived === 2) release(); await barrier; return fhir.executeTransaction(...args); },
} }) };
const attempts = await Promise.all([tobacco, occupation].map(target => handleHistoryReviewRequest(concurrentDeps, { authHeader: "synthetic", body: { patientReference, encounterReference, sectionKey: "social-history", action: "items-reviewed", method: "individual", targets: [target], gestureId: raceGesture } })));
assert.deepEqual(attempts.map(r => r.status).sort(), [200, 409]);
assert.equal((await acts()).length, 27);
console.log("Concurrent conflicting same-ID requests: HTTP 200/409; exactly 1 additional act");
console.log("PASS: 7 live persistence scenarios (synthetic local admin; not a constrained-role AccessPolicy verdict)");
