import assert from "node:assert/strict";
import { test } from "node:test";
import type { Bundle, Encounter, Observation, Resource } from "@medplum/fhirtypes";
import { buildHistoryAnswerObservation, buildHistoryReviewAttestation, parseHistoryAnswerObservation } from "../src/clinical-graph/history-answer-observation.js";
import { handleHpiRecordRequest, handleHistoryReviewRequest, handleHpiCaptureRequest, type HpiEndpointDeps } from "../src/clinical-graph/hpi-endpoint.js";
import { ODOS_OPHTHALMOLOGY_CODE_SYSTEM } from "../src/fhir/ophthalmology/codeBindings.js";
import { buildEncounterComplaintResource } from "../src/clinical-graph/encounter-complaint-store.js";
import { FhirSearchPageLimitError } from "../src/fhir-search.js";

const patientReference = "Patient/pagination-patient";
const encounterReference = "Encounter/pagination-current";
const recordedAt = "2026-09-04T12:00:00Z";
const scopeSystem = "https://odos2020.com/fhir/CodeSystem/history-answer-scope";

function answer(index: number, scope: "patient" | "encounter" = "patient", encounter = "Encounter/prior"): Observation {
  return { ...buildHistoryAnswerObservation({
    id: `answer-${index}`, subjectScope: scope, templateKey: scope === "patient" ? "ocular-history" : "review-of-systems",
    sectionId: "conditions", optionCode: `option-${index}`, value: { kind: "tri-state", status: "negative" },
  }, { patientReference, encounterReference: encounter, recordedAt }), id: `answer-${index}` };
}
function review(index: number): Observation {
  return { ...buildHistoryReviewAttestation({ patientReference, encounterReference, recordedAt,
    sectionKey: `section-${index}`, actorReference: "Practitioner/test", priorAnswerReferences: ["Observation/answer-0"],
  }), id: `review-${index}` };
}
function fixture(rows: Observation[], pageSize?: number) {
  const returned: Observation[] = [];
  const basics: Resource[] = [];
  const plans: Resource[] = [];
  const transactions: Bundle[] = [];
  const baseUrl = "http://localhost:18103/";
  function page<T extends Resource>(type: T["resourceType"], params: Record<string, string>): Bundle<T> {
    const matches = type === "Observation" ? rows.filter(row =>
      (!params.subject || row.subject?.reference === params.subject) &&
      (!params.encounter || row.encounter?.reference === params.encounter) &&
      (!params.code || row.code.coding?.some(c => `${c.system}|${c.code}` === params.code)) &&
      (!params["category:not"] || !row.category?.some(c => c.coding?.some(coding => `${coding.system}|${coding.code}` === params["category:not"])))
    ) : type === "Basic" ? basics : plans;
    const count = pageSize ?? Number(params._count ?? 100);
    const start = Number(params._offset ?? 0);
    const chunk = matches.slice(start, start + count);
    if (params.subject) returned.push(...chunk as Observation[]);
    const next = new URLSearchParams({ ...params, _offset: String(start + count) });
    return { resourceType: "Bundle", type: "searchset", entry: chunk.map(resource => ({ resource: structuredClone(resource) as unknown as T })),
      ...(start + count < matches.length ? { link: [{ relation: "next", url: `${baseUrl}fhir/R4/${type}?${next}` }] } : {}) };
  }
  const fhir = {
    baseUrl,
    read: async <T extends Encounter>() => ({ resourceType: "Encounter", id: "pagination-current", status: "in-progress", subject: { reference: patientReference } }) as T,
    search: async <T extends Resource>(type: T["resourceType"], params: Record<string, string> = {}) => page<T>(type, params),
    searchUrl: async <T extends Resource>(url: string, type: T["resourceType"]) => page<T>(type, Object.fromEntries(new URL(url, baseUrl).searchParams)),
    create: async (row: any) => row,
    update: async (_type: any, _id: string, row: any) => row,
    executeTransaction: async (bundle: Bundle): Promise<Bundle> => {
      transactions.push(bundle);
      return { resourceType: "Bundle", type: "transaction-response", entry: bundle.entry?.map((entry, index) => ({ resource: entry.resource,
        response: { status: "200 OK", location: `${entry.resource?.resourceType}/${entry.resource?.id ?? `created-${index}`}/_history/1` } })) };
    },
  };
  const deps: HpiEndpointDeps = { authenticate: async () => ({ staffReference: "Practitioner/test", actorRole: "provider", fhir }), now: () => recordedAt };
  return { deps, fhir, returned, transactions, basics, plans };
}
async function read(setup: ReturnType<typeof fixture>) {
  return handleHpiRecordRequest(setup.deps, { authHeader: "synthetic", params: { encounterId: "pagination-current" } });
}
for (const count of [600, 1001, 5000]) {
  test(`patient carry-forward reads all ${count} seeded answers`, async () => {
    const response = await read(fixture(Array.from({ length: count }, (_, index) => answer(index))));
    assert.equal(response.status, 200);
    assert.equal((response.body as any).carriedForwardAnswers.length, count);
  });
}
test("patient ceiling refuses 5001 rows with observed row and page counts", async () => {
  const response = await read(fixture(Array.from({ length: 5001 }, (_, index) => answer(index))));
  assert.equal(response.status, 409);
  assert.match((response.body as any).error, /5001 rows.*11 pages/);
  assert.match((response.body as any).error, /5000/);
});
test("25 seeded review acts survive pagination and derivation", async () => {
  const response = await read(fixture(Array.from({ length: 25 }, (_, index) => review(index))));
  assert.equal(response.status, 200);
  assert.equal((response.body as any).reviewAttestations.length, 25);
});
test("ROS cannot enter another encounter carry-forward search or consume its ceiling", async () => {
  const setup = fixture([answer(0), ...Array.from({ length: 5001 }, (_, index) => answer(index + 1, "encounter"))]);
  const response = await read(setup);
  assert.equal(response.status, 200);
  assert.equal((response.body as any).carriedForwardAnswers.length, 1);
  assert.ok(setup.returned.every(row => parseHistoryAnswerObservation(row).subjectScope !== "encounter"));
});
test("scope token persists on encounter answers while old patient answers remain readable", async () => {
  assert.ok(answer(1, "encounter").category?.some(c => c.coding?.some(coding => coding.system === scopeSystem && coding.code === "encounter")));
  const legacy = answer(0); delete legacy.category;
  const response = await read(fixture([legacy]));
  assert.equal((response.body as any).carriedForwardAnswers.length, 1);
});
test("current-encounter answer read follows multiple pages", async () => {
  const response = await read(fixture(Array.from({ length: 600 }, (_, index) => answer(index, "encounter", encounterReference))));
  assert.equal(response.status, 200);
  assert.equal((response.body as any).answers.length, 600);
});
test("review endpoint reads all patient answers and finds an existing act beyond page one", async () => {
  const prior = Array.from({ length: 1001 }, (_, index) => answer(index));
  const acts = Array.from({ length: 25 }, (_, index) => review(index));
  acts.push({ ...buildHistoryReviewAttestation({ patientReference, encounterReference, recordedAt, sectionKey: "ocular-history",
    actorReference: "Practitioner/test", priorAnswerReferences: [] }), id: "existing-review" });
  const setup = fixture([...prior, ...acts]);
  const response = await handleHistoryReviewRequest(setup.deps, { authHeader: "synthetic", body: { patientReference, encounterReference, sectionKey: "ocular-history" } });
  assert.equal(response.status, 200);
  assert.equal(setup.transactions[0]?.entry?.[0]?.request?.url, "Observation/existing-review");
  assert.equal((setup.transactions[0]?.entry?.[0]?.resource as Observation).derivedFrom?.length, 1001);
});
for (const handler of [handleHpiRecordRequest, handleHistoryReviewRequest, handleHpiCaptureRequest]) {
  test(`${handler.name} catches page limits with the page count`, async () => {
    const setup = fixture([]);
    setup.fhir.search = async () => { throw new FhirSearchPageLimitError("Observation", 17); };
    const response = await handler(setup.deps, { authHeader: "synthetic", params: { encounterId: "pagination-current" },
      body: { patientReference, encounterReference, ...(handler === handleHistoryReviewRequest ? { sectionKey: "ocular-history" } : {}) } });
    assert.equal(response.status, 409);
    assert.match((response.body as any).error, /17 pages/);
  });
}

function aggregate(index: number): Observation {
  return { resourceType: "Observation", id: `aggregate-${index}`, status: "preliminary", subject: { reference: patientReference },
    encounter: { reference: encounterReference }, code: { coding: [{ system: ODOS_OPHTHALMOLOGY_CODE_SYSTEM, code: "hpi_ros" }] } };
}
test("aggregate and last-plan reads follow their second pages", async () => {
  const setup = fixture(Array.from({ length: 201 }, (_, index) => aggregate(index)));
  setup.plans.push(...Array.from({ length: 1001 }, (_, index) => ({ resourceType: "ServiceRequest" as const, id: `plan-${index}`, status: "active", intent: "plan", subject: { reference: patientReference } })));
  const response = await read(setup);
  assert.equal(response.status, 200);
  assert.equal(setup.returned.filter(row => row.resourceType === "ServiceRequest").length, 1001);
});
test("capture reconciles aggregate duplicates across pages", async () => {
  const setup = fixture([aggregate(0), aggregate(1), aggregate(2)], 2);
  const provenance = { source: "manual" as const, recordedAt, actorReference: "Practitioner/test" };
  setup.basics.push(buildEncounterComplaintResource({ id: "complaint", encounterId: "pagination-current", patientId: "pagination-patient", ordinal: 1,
    freeTextLabel: "Synthetic complaint", conditions: [], eyeLocation: "not-applicable", qualities: [], treatmentsTried: [], additionalHistory: "",
    narrative: { mode: "automated" }, resolvedDx: [], status: "active", provenance, provenanceHistory: [provenance] }));
  const response = await handleHpiCaptureRequest(setup.deps, { authHeader: "synthetic", body: { patientReference, encounterReference } });
  assert.equal(response.status, 200);
  const observations = setup.transactions[0]?.entry?.flatMap(entry => entry.resource?.resourceType === "Observation" ? [entry.resource] : []) ?? [];
  assert.equal(observations.filter(row => row.status === "entered-in-error").length, 2);
  assert.ok(observations.some(row => row.id === "aggregate-2"));
});
test("answer upsert finds the existing answer and retires reviews beyond page one", async () => {
  const selected = { id: "tobacco", subjectScope: "patient" as const, templateKey: "social-history", sectionId: "tobacco", value: { kind: "selection" as const, code: "current" } };
  const existing = { ...buildHistoryAnswerObservation(selected, { patientReference, encounterReference, recordedAt }), id: "existing-tobacco", meta: { versionId: "7" } };
  const acts = Array.from({ length: 3 }, (_, index) => ({ ...buildHistoryReviewAttestation({ patientReference, encounterReference, sectionKey: "social-history", actorReference: "Practitioner/test", recordedAt, priorAnswerReferences: [] }), id: `social-review-${index}` }));
  const setup = fixture([answer(0, "patient", encounterReference), answer(1, "patient", encounterReference), existing, ...acts], 2);
  const response = await handleHpiCaptureRequest(setup.deps, { authHeader: "synthetic", body: { patientReference, encounterReference, templateAnswers: [{ ...selected, value: { kind: "selection", code: "former-smoker" } }] } });
  assert.equal(response.status, 200);
  const entries = setup.transactions[0]?.entry ?? [];
  assert.ok(entries.some(entry => entry.request?.url === "Observation/existing-tobacco" && entry.request.ifMatch === 'W/"7"'));
  assert.equal(entries.filter(entry => entry.resource?.resourceType === "Observation" && entry.resource.status === "entered-in-error").length, 3);
});
