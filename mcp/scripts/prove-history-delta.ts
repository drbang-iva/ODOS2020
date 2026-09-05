import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { Encounter, Observation, Patient, Practitioner } from "@medplum/fhirtypes";
import { createAuthenticatedFhirClient } from "../tests/integration-helpers.js";
import { handleHpiCaptureRequest, type HpiEndpointDeps } from "../src/clinical-graph/hpi-endpoint.js";
import { buildHistoryAnswerObservation, buildHistoryReviewAttestation, parseHistoryAnswerObservation } from "../src/clinical-graph/history-answer-observation.js";

const baseUrl = process.env.MEDPLUM_BASE_URL;
assert.ok(baseUrl && ["localhost", "127.0.0.1"].includes(new URL(baseUrl).hostname), "Proof requires the local synthetic Medplum stack");
const email = process.env.MEDPLUM_ADMIN_EMAIL;
const password = process.env.MEDPLUM_ADMIN_PASSWORD;
assert.ok(email && password, "Provide the synthetic stack credentials in the environment");
const { fhir } = await createAuthenticatedFhirClient({ baseUrl, email, password });
const practitioner = await fhir.create<Practitioner>({ resourceType: "Practitioner", name: [{ family: "HistoryDeltaProof" }] });
const patient = await fhir.create<Patient>({ resourceType: "Patient", name: [{ family: "SyntheticHistoryDeltaProof" }] });
const patientReference = `Patient/${patient.id}`;
let submitted = 0;
const deps: HpiEndpointDeps = {
  authenticate: async () => ({
    staffReference: `Practitioner/${practitioner.id}`, actorRole: "provider",
    fhir: {
      read: fhir.read.bind(fhir), search: fhir.search.bind(fhir), create: fhir.create.bind(fhir), update: fhir.update.bind(fhir),
      executeTransaction: async (bundle, headers) => { submitted++; return fhir.executeTransaction(bundle, headers); },
    },
  }),
};
let passed = 0;
for (const [count, existing, status] of [[8, false, 413], [7, false, 200], [51, true, 413], [50, true, 200]] as const) {
  const encounter = await fhir.create<Encounter>({ resourceType: "Encounter", status: "in-progress", class: { code: "synthetic-proof" }, subject: { reference: patientReference } });
  const encounterReference = `Encounter/${encounter.id}`;
  const context = { patientReference, encounterReference, actorReference: `Practitioner/${practitioner.id}`, recordedAt: "2026-09-04T10:00:00.000Z" };
  const answers = Array.from({ length: count }, (_, index) => ({ id: `proof-${randomUUID()}`, subjectScope: "patient" as const, templateKey: "social-history", sectionId: "occupation", value: { kind: "text" as const, text: `Synthetic ${index}` } }));
  if (existing) for (const answer of answers) await fhir.create(buildHistoryAnswerObservation({ ...answer, value: { kind: "text", text: "Before" } }, context));
  const rows = async () => ((await fhir.search<Observation>("Observation", { encounter: encounterReference, _count: "100" })).entry ?? []).map((row) => row.resource!).sort((a, b) => a.id!.localeCompare(b.id!));
  const before = await rows();
  const writesBefore = submitted;
  const result = await handleHpiCaptureRequest(deps, { authHeader: "synthetic-local-proof", body: { patientReference, encounterReference, templateAnswers: answers } });
  const after = await rows();
  assert.equal(result.status, status);
  if (status === 413) {
    assert.deepEqual(after, before, "Refusal preserves resources and versions");
    assert.equal(submitted, writesBefore, "No transaction submitted");
  } else {
    assert.equal(after.length, count);
    for (const answer of answers) assert.deepEqual(after.map(parseHistoryAnswerObservation).find((row) => row.id === answer.id)?.value, answer.value);
    assert.equal(submitted, writesBefore + 1);
  }
  console.log(`PASS ${existing ? count + " ordinary PUTs" : count + 1 + " conditional-inclusive entries"}: HTTP ${status}; ${after.length} answers; ${submitted - writesBefore} transaction submissions; ${status === 413 ? "all resources and versions unchanged" : "all values persisted"}`);
  passed++;
  if (count === 7) {
    for (const sectionKey of ["social-history", "ocular-history"]) await fhir.create(buildHistoryReviewAttestation({ ...context, sectionKey, priorAnswerReferences: [`Observation/${after[0]!.id}`] }));
    const reviewed = await rows();
    const priorSubmissions = submitted;
    for (const templateAnswers of [answers, []]) {
      const unchanged = await handleHpiCaptureRequest(deps, { authHeader: "synthetic-local-proof", body: { patientReference, encounterReference, templateAnswers } });
      assert.equal(unchanged.status, 200);
      assert.deepEqual(await rows(), reviewed);
    }
    assert.equal(submitted, priorSubmissions);
    console.log("PASS identical and empty deltas: zero submissions; answer dates, versions, and both reviews unchanged");
    passed++;
    const changed = await handleHpiCaptureRequest(deps, { authHeader: "synthetic-local-proof", body: { patientReference, encounterReference, templateAnswers: [{ ...answers[0], value: { kind: "text", text: "Changed synthetic occupation" } }] } });
    assert.equal(changed.status, 200);
    assert.deepEqual((changed.body as { retiredReviewSections: string[] }).retiredReviewSections, ["social-history"]);
    const changedRows = await rows();
    const untouched = reviewed.filter((row) => row.identifier?.[0]?.value !== answers[0]!.id && !row.identifier?.[0]?.value?.endsWith(":social-history"));
    for (const row of untouched) assert.deepEqual(changedRows.find((candidate) => candidate.id === row.id), row);
    console.log("PASS one changed answer: only Social review retired; unrelated answers and Ocular review unchanged");
    passed++;
  }
}
console.log(`Live History delta proof: ${passed} passed, 0 failed`);
