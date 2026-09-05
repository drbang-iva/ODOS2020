import assert from "node:assert/strict";
import { test } from "node:test";
import type { Bundle, Encounter, Observation, Patient, Practitioner, Resource } from "@medplum/fhirtypes";
import { createAuthenticatedFhirClient, requireMedplumAdmin } from "./integration-helpers.js";
import { buildHistoryAnswerObservation, buildHistoryReviewAttestation, HISTORY_ANSWER_CODE_SYSTEM, HISTORY_ANSWER_CODE, HISTORY_ANSWER_SCOPE_SYSTEM } from "../src/clinical-graph/history-answer-observation.js";
import { handleHpiRecordRequest, type HpiEndpointDeps } from "../src/clinical-graph/hpi-endpoint.js";
import { searchAll } from "../src/fhir-search.js";

test("local Medplum seeds 5001 patient answers, paginates reviews, and excludes ROS in the index", { timeout: 600_000 }, async (t) => {
  if (!requireMedplumAdmin(t, "historyPaginationMedplum", "Local synthetic Medplum credentials are required.")) return;
  const baseUrl = process.env.MEDPLUM_BASE_URL!;
  assert.ok(["localhost", "127.0.0.1"].includes(new URL(baseUrl).hostname));
  const { fhir } = await createAuthenticatedFhirClient({ baseUrl, email: process.env.MEDPLUM_ADMIN_EMAIL!, password: process.env.MEDPLUM_ADMIN_PASSWORD! });
  const patient = await fhir.create<Patient>({ resourceType: "Patient", active: true, name: [{ text: "Synthetic History Pagination" }] });
  const patientReference = `Patient/${patient.id}`;
  const practitioner = await fhir.create<Practitioner>({ resourceType: "Practitioner", name: [{ text: "Synthetic Pagination Tester" }] });
  const staffReference = `Practitioner/${practitioner.id}`;
  const encounter = () => fhir.create<Encounter>({ resourceType: "Encounter", status: "in-progress", class: { display: "Synthetic test encounter" }, subject: { reference: patientReference } });
  const prior = await encounter();
  const current = await encounter();
  const recordedAt = "2026-09-04T12:00:00Z";
  const deps: HpiEndpointDeps = { authenticate: async () => ({ staffReference, actorRole: "provider", fhir }) };
  const read = () => handleHpiRecordRequest(deps, { authHeader: "synthetic", params: { encounterId: current.id } });
  const makeAnswer = (index: number, scope: "patient" | "encounter"): Observation => buildHistoryAnswerObservation({
    id: `${patient.id}-${scope}-${index}`, subjectScope: scope, templateKey: scope === "patient" ? "ocular-history" : "review-of-systems",
    sectionId: "conditions", optionCode: `option-${index}`, value: { kind: "tri-state", status: "negative" },
  }, { patientReference, encounterReference: `Encounter/${prior.id}`, recordedAt });
  async function seed(rows: Resource[]) {
    for (let offset = 0; offset < rows.length; offset += 100) {
      const chunk = rows.slice(offset, offset + 100);
      const result: Bundle = await fhir.executeTransaction({ resourceType: "Bundle", type: "transaction", entry: chunk.map(resource => ({ resource, request: { method: "POST", url: resource.resourceType } })) });
      assert.equal(result.entry?.length, chunk.length);
      const failed = result.entry?.find(entry => !/^2\d\d/.test(entry.response?.status ?? ""));
      assert.equal(failed, undefined, JSON.stringify({ status: failed?.response?.status, outcome: failed?.response?.outcome }));
    }
  }
  await seed(Array.from({ length: 600 }, (_, index) => makeAnswer(index, "patient")));
  let response = await read();
  assert.equal(response.status, 200);
  assert.equal((response.body as any).carriedForwardAnswers.length, 600);
  t.diagnostic("600 patient answers: HTTP 200; carriedForwardAnswers=600");
  await seed(Array.from({ length: 25 }, (_, index) => buildHistoryReviewAttestation({ patientReference,
    encounterReference: `Encounter/${current.id}`, sectionKey: `section-${index}`, actorReference: staffReference, recordedAt, priorAnswerReferences: [],
  })));
  response = await read();
  assert.equal(response.status, 200);
  assert.equal((response.body as any).reviewAttestations.length, 25);
  t.diagnostic("25 encounter review acts: HTTP 200; reviewAttestations=25");
  await seed(Array.from({ length: 600 }, (_, index) => makeAnswer(index, "encounter")));
  const indexed = await searchAll<Observation>(fhir, "Observation", { subject: patientReference,
    code: `${HISTORY_ANSWER_CODE_SYSTEM}|${HISTORY_ANSWER_CODE}`, "category:not": `${HISTORY_ANSWER_SCOPE_SYSTEM}|encounter`,
  }, { maxRows: 5000 });
  assert.equal(indexed.length, 600);
  assert.ok(indexed.every(row => !row.identifier?.[0]?.value?.includes("-encounter-")));
  t.diagnostic("600 ROS answers: category:not excludes all 600 before collection; patient rows=600");
  await seed(Array.from({ length: 401 }, (_, index) => makeAnswer(index + 600, "patient")));
  response = await read();
  assert.equal(response.status, 200);
  assert.equal((response.body as any).carriedForwardAnswers.length, 1001);
  t.diagnostic("1001 patient answers: HTTP 200; carriedForwardAnswers=1001");
  await seed(Array.from({ length: 3999 }, (_, index) => makeAnswer(index + 1001, "patient")));
  response = await read();
  assert.equal(response.status, 200);
  assert.equal((response.body as any).carriedForwardAnswers.length, 5000);
  t.diagnostic("5000 patient answers: HTTP 200; carriedForwardAnswers=5000");
  await seed([makeAnswer(5000, "patient")]);
  response = await read();
  assert.equal(response.status, 409);
  assert.match((response.body as any).error, /5001 rows.*11 pages/);
  t.diagnostic(`5001 patient answers: HTTP ${response.status}; ${(response.body as any).error}`);
});
