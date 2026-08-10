import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { test, type TestContext } from "node:test";
import type {
  Bundle,
  Condition,
  Encounter,
  Observation,
  Provenance,
  Resource,
} from "@medplum/fhirtypes";
import express from "express";
import type { PracticeRoleId } from "../src/authz/roles.js";
import {
  handlePreviousExamsReadRequest,
  registerDiagnosisCarryForwardRoutes,
  type PreviousExamsPage,
} from "../src/clinical-graph/diagnosis-carry-forward-endpoint.js";
import {
  buildEncounterDiagnosisComponent,
  buildEncounterDiagnosisCondition,
  type ConditionVerificationStatusCode,
} from "../src/fhir/condition.js";
import { lateralityConcept, ODOS_EXTENSION_URLS } from "../src/fhir/ophthalmology/extensions.js";
import { ODOS_OPHTHALMOLOGY_CODE_SYSTEM } from "../src/fhir/ophthalmology/codeBindings.js";
import { DIAGNOSIS_KEY_IDENTIFIER_SYSTEM } from "../src/clinical-graph/diagnosis-pick-endpoint.js";

const AUTH_CLINICIAN = "Bearer clinician";
const AUTH_FORBIDDEN = "Bearer forbidden";

test("GET previous exams returns 401 when unauthenticated", async (t) => {
  const base = await startPreviousExamRoutes(t, new MemoryFhir(), "auditor");

  const response = await fetch(`${base}/clinical-graph/encounters/current/previous-exams`);

  assert.equal(response.status, 401);
});

test("GET previous exams returns 403 without chart.read", async (t) => {
  const base = await startPreviousExamRoutes(t, new MemoryFhir(), "auditor");

  const response = await fetch(`${base}/clinical-graph/encounters/current/previous-exams`, {
    headers: { Authorization: AUTH_FORBIDDEN },
  });

  assert.equal(response.status, 403);
});

test("POST previous exams returns 401 when unauthenticated", async (t) => {
  const base = await startPreviousExamRoutes(t, new MemoryFhir(), "auditor");

  const response = await fetch(`${base}/clinical-graph/encounters/current/previous-exams`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      sourceEncounterReference: "Encounter/prior",
      sourceConditionReference: "Condition/prior-diagnosis",
    }),
  });

  assert.equal(response.status, 401);
});

test("POST previous exams returns 403 without chart.write", async (t) => {
  const base = await startPreviousExamRoutes(t, new MemoryFhir(), "auditor");

  const response = await fetch(`${base}/clinical-graph/encounters/current/previous-exams`, {
    method: "POST",
    headers: { Authorization: AUTH_FORBIDDEN, "Content-Type": "application/json" },
    body: JSON.stringify({
      sourceEncounterReference: "Encounter/prior",
      sourceConditionReference: "Condition/prior-diagnosis",
    }),
  });

  assert.equal(response.status, 403);
});

test("pull posts one present finding atomically while preserving absent source provenance and rank gaps", async (t) => {
  const fhir = pullFhir();
  const sourceCondition = await fhir.read<Condition>("Condition", "source-dry-eye-od");
  const sourcePresent = await fhir.read<Observation>("Observation", "source-staining-present");
  const base = await startPreviousExamRoutes(t, fhir, "auditor");

  const response = await fetch(`${base}/clinical-graph/encounters/current-pull/previous-exams`, {
    method: "POST",
    headers: { Authorization: AUTH_CLINICIAN, "Content-Type": "application/json" },
    body: JSON.stringify({
      sourceEncounterReference: "Encounter/source-pull",
      sourceConditionReference: "Condition/source-dry-eye-od",
    }),
  });

  assert.equal(response.status, 200, await response.clone().text());
  assert.equal(fhir.transactions.length, 1);
  const { bundle, headers } = fhir.transactions[0]!;
  assert.equal(bundle.type, "transaction");
  assert.equal(headers.Prefer, "return=representation");
  assert.deepEqual(bundle.entry?.map((entry) => [entry.resource?.resourceType, entry.request?.method, entry.request?.url]), [
    ["Condition", "POST", "Condition"],
    ["Encounter", "PUT", "Encounter/current-pull"],
    ["Observation", "POST", "Observation"],
    ["Provenance", "POST", "Provenance"],
  ]);
  assert.equal(bundle.entry?.every((entry) => entry.fullUrl?.startsWith("urn:uuid:")), true);

  const conditionEntry = bundle.entry![0]!;
  const encounterEntry = bundle.entry![1]!;
  const observationEntry = bundle.entry![2]!;
  const provenanceEntry = bundle.entry![3]!;
  const pulledCondition = conditionEntry.resource as Condition;
  const pulledEncounter = encounterEntry.resource as Encounter;
  const pulledObservation = observationEntry.resource as Observation;
  const provenance = provenanceEntry.resource as Provenance;

  assert.deepEqual(pulledCondition.code, sourceCondition.code);
  assert.deepEqual(pulledCondition.extension, sourceCondition.extension);
  assert.equal(pulledCondition.subject.reference, "Patient/patient-1");
  assert.equal(pulledCondition.encounter?.reference, "Encounter/current-pull");
  assert.equal(pulledCondition.verificationStatus?.coding?.[0]?.code, "confirmed");
  assert.deepEqual(pulledCondition.identifier, [{
    system: DIAGNOSIS_KEY_IDENTIFIER_SYSTEM,
    value: "current-pull::dry_eye::right",
  }]);
  assert.deepEqual(pulledCondition.evidence?.flatMap((evidence) => evidence.detail ?? []), [
    { reference: observationEntry.fullUrl },
  ]);

  assert.equal(encounterEntry.request?.ifMatch, 'W/"7"');
  assert.deepEqual(pulledEncounter.diagnosis?.map((diagnosisRow) => diagnosisRow.rank), [1, 4, 5]);
  assert.equal(pulledEncounter.diagnosis?.at(-1)?.condition.reference, conditionEntry.fullUrl);

  assert.deepEqual(pulledObservation.code, sourcePresent.code);
  assert.equal(pulledObservation.subject?.reference, "Patient/patient-1");
  assert.equal(pulledObservation.encounter?.reference, "Encounter/current-pull");
  assert.equal(pulledObservation.status, "preliminary");
  assert.equal(pulledObservation.valueBoolean, true);
  assert.deepEqual(pulledObservation.extension, sourcePresent.extension);
  assert.deepEqual(pulledObservation.component, sourcePresent.component);
  assert.equal(pulledObservation.focus, undefined);
  assert.equal(JSON.stringify(pulledObservation).includes("source-staining-present"), false);

  assert.equal(provenance.activity?.coding?.[0]?.code, "CREATE");
  assert.equal(provenance.activity?.text, "Diagnosis pull-forward");
  assert.deepEqual(provenance.target.map((target) => target.reference), [
    conditionEntry.fullUrl,
    encounterEntry.fullUrl,
    observationEntry.fullUrl,
  ]);
  assert.deepEqual(provenance.entity?.map((entity) => entity.what.reference), [
    "Condition/source-dry-eye-od",
    "Observation/source-staining-present",
    "Observation/source-filaments-absent",
    "Observation/source-legacy-no-boolean",
  ]);
  assert.deepEqual(provenance.agent.map((agent) => agent.who.reference), ["Practitioner/doc"]);

  const body = await response.json() as Record<string, unknown>;
  assert.equal(body.conditionReference, "Condition/pulled-condition");
  assert.equal(body.alreadyPresent, false);
  assert.equal((body.transaction as Bundle).type, "transaction-response");
});

test("pull re-read catches a raced exact OD diagnosis and returns its current reference without a transaction", async (t) => {
  const fhir = pullFhir();
  fhir.beforeCurrentEncounterRead = (readNumber) => {
    if (readNumber !== 2) return;
    const concurrent = diagnosis("concurrent-dry-eye-od", "current-pull", "dry_eye", "right", "confirmed", []);
    concurrent.code = { text: "Keratoconjunctivitis sicca, right eye" };
    concurrent.extension = [{
      url: ODOS_EXTENSION_URLS.eyeLaterality,
      valueCodeableConcept: lateralityConcept("OD"),
    }];
    fhir.resources.push(concurrent);
    const encounterResource = fhir.resource<Encounter>("Encounter", "current-pull");
    encounterResource.diagnosis = [
      ...(encounterResource.diagnosis ?? []),
      buildEncounterDiagnosisComponent("Condition/concurrent-dry-eye-od", 5),
    ];
    encounterResource.meta = { versionId: "8" };
  };
  const base = await startPreviousExamRoutes(t, fhir, "auditor");

  const response = await postPull(base, "source-dry-eye-od");

  assert.equal(response.status, 200, await response.clone().text());
  assert.deepEqual(await response.json(), {
    conditionReference: "Condition/concurrent-dry-eye-od",
    alreadyPresent: true,
  });
  assert.equal(fhir.transactions.length, 0);
});

test("pull does not treat an existing OD diagnosis as the requested OS identity", async (t) => {
  const fhir = pullFhir("source-dry-eye-os");
  const currentOd = diagnosis("current-dry-eye-od", "current-pull", "dry_eye", "right", "confirmed", []);
  currentOd.code = structuredClone(fhir.resource<Condition>("Condition", "source-dry-eye-os").code);
  fhir.resources.push(currentOd);
  fhir.resource<Encounter>("Encounter", "current-pull").diagnosis!.push(
    buildEncounterDiagnosisComponent("Condition/current-dry-eye-od", 5),
  );
  const base = await startPreviousExamRoutes(t, fhir, "auditor");

  const response = await postPull(base, "source-dry-eye-os");

  assert.equal(response.status, 200, await response.clone().text());
  assert.equal((await response.json() as { alreadyPresent: boolean }).alreadyPresent, false);
  assert.equal(fhir.transactions.length, 1);
});

test("pull ignores a matching Condition that does not belong to the current Encounter", async (t) => {
  const fhir = pullFhir();
  const foreign = diagnosis("foreign-dry-eye-od", "current-pull", "dry_eye", "right", "confirmed", []);
  foreign.encounter = { reference: "Encounter/other" };
  foreign.extension = [{
    url: ODOS_EXTENSION_URLS.eyeLaterality,
    valueCodeableConcept: lateralityConcept("OD"),
  }];
  fhir.resources.push(foreign);
  fhir.resource<Encounter>("Encounter", "current-pull").diagnosis!.push(
    buildEncounterDiagnosisComponent("Condition/foreign-dry-eye-od", 5),
  );
  const base = await startPreviousExamRoutes(t, fhir, "auditor");

  const response = await postPull(base, "source-dry-eye-od");

  assert.equal(response.status, 200, await response.clone().text());
  assert.equal((await response.json() as { alreadyPresent: boolean }).alreadyPresent, false);
  assert.equal(fhir.transactions.length, 1);
});

test("pull requires literal coding and text to match even when catalog key and laterality match", async (t) => {
  const fhir = pullFhir();
  const differentLiteral = diagnosis(
    "current-dry-eye-different-literal",
    "current-pull",
    "dry_eye",
    "right",
    "confirmed",
    [],
  );
  differentLiteral.code = { text: "Different literal recorded diagnosis" };
  differentLiteral.extension = [{
    url: ODOS_EXTENSION_URLS.eyeLaterality,
    valueCodeableConcept: lateralityConcept("OD"),
  }];
  fhir.resources.push(differentLiteral);
  fhir.resource<Encounter>("Encounter", "current-pull").diagnosis!.push(
    buildEncounterDiagnosisComponent("Condition/current-dry-eye-different-literal", 5),
  );
  const base = await startPreviousExamRoutes(t, fhir, "auditor");

  const response = await postPull(base, "source-dry-eye-od");

  assert.equal(response.status, 200, await response.clone().text());
  assert.equal((await response.json() as { alreadyPresent: boolean }).alreadyPresent, false);
  assert.equal(fhir.transactions.length, 1);
});

test("pull matches uncataloged literal coding text and laterality without a terminology mapping", async (t) => {
  const fhir = pullFhir("source-uncataloged");
  const source = fhir.resource<Condition>("Condition", "source-uncataloged");
  const current: Condition = {
    ...structuredClone(source),
    id: "current-uncataloged",
    encounter: { reference: "Encounter/current-pull" },
    code: {
      coding: [...(source.code?.coding ?? [])].reverse(),
      text: source.code?.text,
    },
  };
  fhir.resources.push(current);
  fhir.resource<Encounter>("Encounter", "current-pull").diagnosis!.push(
    buildEncounterDiagnosisComponent("Condition/current-uncataloged", 5),
  );
  const base = await startPreviousExamRoutes(t, fhir, "auditor");

  const response = await postPull(base, "source-uncataloged");

  assert.equal(response.status, 200, await response.clone().text());
  assert.deepEqual(await response.json(), {
    conditionReference: "Condition/current-uncataloged",
    alreadyPresent: true,
  });
  assert.equal(fhir.transactions.length, 0);
});

test("pull rejects source patient, diagnosis membership, and retracted-condition boundary failures", async (t) => {
  for (const boundary of ["patient", "membership", "retracted"] as const) {
    const fhir = pullFhir();
    if (boundary === "patient") {
      fhir.resource<Condition>("Condition", "source-dry-eye-od").subject.reference = "Patient/other";
    } else if (boundary === "membership") {
      fhir.resource<Encounter>("Encounter", "source-pull").diagnosis = [];
    } else {
      fhir.resource<Condition>("Condition", "source-dry-eye-od").verificationStatus = {
        coding: [{ system: "http://terminology.hl7.org/CodeSystem/condition-ver-status", code: "refuted" }],
      };
    }
    const base = await startPreviousExamRoutes(t, fhir, "auditor");

    const response = await postPull(base, "source-dry-eye-od");

    assert.equal(response.status, 409, `${boundary}: ${await response.text()}`);
    assert.equal(fhir.transactions.length, 0);
  }
});

test("pull rejects failed transaction entries and maps precondition failures to 409", async (t) => {
  for (const failureStatus of ["412 Precondition Failed", "500 Internal Server Error"] as const) {
    const fhir = pullFhir();
    fhir.transactionFailureStatus = failureStatus;
    const base = await startPreviousExamRoutes(t, fhir, "auditor");

    const response = await postPull(base, "source-dry-eye-od");

    assert.equal(response.status, failureStatus.startsWith("412") ? 409 : 502, await response.text());
    assert.equal(fhir.transactions.length, 1);
  }
});

test("previous exams preserves FHIR newest-first order across offsets and returns unbounded exact records", async () => {
  const fhir = previousExamFhir();

  const response = await handlePreviousExamsReadRequest(deps(fhir), {
    authHeader: AUTH_CLINICIAN,
    params: { encounterId: "current" },
    query: {},
  });

  assert.equal(response.status, 200, JSON.stringify(response.body));
  const page = response.body as PreviousExamsPage;
  assert.equal(page.pageSize, 4);
  assert.equal(page.encounters.length, 4);
  assert.deepEqual(page.encounters.map((group) => ({
    encounterReference: group.encounterReference,
    date: group.date,
    visitType: group.visitType,
  })), [
    { encounterReference: "Encounter/prior-1", date: "2026-07-10T08:30:00-04:00", visitType: "Routine eye exam" },
    { encounterReference: "Encounter/prior-2", date: "2026-07-10T12:00:00+00:00", visitType: "Comprehensive eye exam" },
    { encounterReference: "Encounter/prior-3", date: "2026-05-10T09:00:00.000Z", visitType: "Problem visit" },
    { encounterReference: "Encounter/prior-4", date: "2026-04-10T09:00:00.000Z", visitType: "Visit type not recorded" },
  ]);
  assert.ok(page.nextCursor);
  assert.equal(page.nextCursor.includes("http"), false);
  assert.equal(page.nextCursor.includes("Encounter"), false);
  assert.equal(page.nextCursor.includes("_page"), false);

  const first = page.encounters[0]!;
  assert.deepEqual(first.diagnoses.slice(0, 3).map((diagnosis) => diagnosis.conditionReference), [
    "Condition/prior-1-dry-eye-od",
    "Condition/prior-1-dry-eye-os",
    "Condition/prior-1-uncataloged",
  ]);
  assert.equal(first.diagnoses.length, 15);
  assert.equal(first.diagnoses.at(-1)?.conditionReference, "Condition/prior-1-extra-12");
  const { findings, ...firstDiagnosis } = first.diagnoses[0]!;
  assert.deepEqual(firstDiagnosis, {
    conditionReference: "Condition/prior-1-dry-eye-od",
    display: "Keratoconjunctivitis sicca, right eye",
    identity: {
      diagnosisKey: "dry_eye",
      coding: [],
      text: "Keratoconjunctivitis sicca, right eye",
      laterality: "OD",
    },
    checked: true,
    currentConditionReference: "Condition/current-dry-eye-od",
  });
  assert.equal(findings.length, 14);
  assert.equal(findings.at(-1)?.observationReference, "Observation/prior-1-bulk-finding-12");
  assert.deepEqual(findings.slice(0, 2), [
      {
        observationReference: "Observation/prior-1-staining-present",
        code: "ocular-surface::STAINING::punctate",
        display: "Punctate staining",
        presence: "present",
        grade: "2+",
        laterality: "OD",
      },
      {
        observationReference: "Observation/prior-1-filaments-absent",
        code: "ocular-surface::FILAMENTS::present",
        display: "Corneal filaments",
        presence: "absent",
        laterality: "OD",
      },
    ]);
  assert.equal(first.diagnoses[1]!.identity.laterality, "OS");
  assert.equal(first.diagnoses[1]!.checked, false);
  assert.deepEqual(first.diagnoses[2]!.identity, {
    coding: [
      { system: "urn:system:a", code: "alpha", display: "Alpha coding" },
      { system: "urn:system:z", code: "zeta", display: "Zeta coding" },
    ],
    text: "Literal uncataloged diagnosis",
    laterality: "UNKNOWN",
  });

  const secondDryEye = page.encounters[1]!.diagnoses.find((diagnosis) =>
    diagnosis.conditionReference === "Condition/prior-2-dry-eye-od"
  );
  assert.deepEqual(secondDryEye?.identity, first.diagnoses[0]!.identity);
  assert.equal(secondDryEye?.currentConditionReference, "Condition/current-dry-eye-od");
  assert.deepEqual(fhir.initialEncounterSearch, {
    subject: "Patient/patient-1",
    date: "lt2026-08-10T09:00:00.000Z",
    _sort: "-date",
    _count: "4",
  });
});

test("previous exams cursor loads the next four-encounter page without accepting a URL", async () => {
  const fhir = previousExamFhir();
  const first = await handlePreviousExamsReadRequest(deps(fhir), {
    authHeader: AUTH_CLINICIAN,
    params: { encounterId: "current" },
    query: {},
  });
  const firstPage = first.body as PreviousExamsPage;

  const second = await handlePreviousExamsReadRequest(deps(fhir), {
    authHeader: AUTH_CLINICIAN,
    params: { encounterId: "current" },
    query: { cursor: firstPage.nextCursor },
  });

  assert.equal(second.status, 200, JSON.stringify(second.body));
  assert.deepEqual(second.body, {
    pageSize: 4,
    encounters: [{
      encounterReference: "Encounter/prior-5",
      date: "2026-03-10T09:00:00.000Z",
      visitType: "Annual eye exam",
      diagnoses: [],
    }],
  });
  assert.equal(fhir.followedUrls.length, 1);
  assert.equal(fhir.followedUrls[0], "/fhir/R4/Encounter?_page=2&_count=4");

  const rejected = await handlePreviousExamsReadRequest(deps(fhir), {
    authHeader: AUTH_CLINICIAN,
    params: { encounterId: "current" },
    query: { cursor: "https://attacker.example/fhir/R4/Encounter?_page=2" },
  });
  assert.equal(rejected.status, 400);
  assert.equal(fhir.followedUrls.length, 1);
});

test("previous exams rejects a cross-origin Bundle next link", async () => {
  const fhir = previousExamFhir();
  fhir.nextUrl = "https://evil.example/fhir/R4/Encounter?_page=2&_count=4";

  const response = await handlePreviousExamsReadRequest(deps(fhir), {
    authHeader: AUTH_CLINICIAN,
    params: { encounterId: "current" },
    query: {},
  });

  assert.equal(response.status, 502);
  assert.deepEqual(response.body, { error: "FHIR previous-exams next link is invalid." });
});

test("previous exams rejects a scheme-relative cross-origin Bundle next link", async () => {
  const fhir = previousExamFhir();
  fhir.nextUrl = "//evil.example/fhir/R4/Encounter?_page=2&_count=4";

  const response = await handlePreviousExamsReadRequest(deps(fhir), {
    authHeader: AUTH_CLINICIAN,
    params: { encounterId: "current" },
    query: {},
  });

  assert.equal(response.status, 502);
  assert.deepEqual(response.body, { error: "FHIR previous-exams next link is invalid." });
});

test("previous exams accepts a same-origin absolute Bundle next link", async () => {
  const fhir = previousExamFhir();
  fhir.nextUrl = "https://fhir.local/fhir/R4/Encounter?_page=2&_count=4";

  const first = await handlePreviousExamsReadRequest(deps(fhir), {
    authHeader: AUTH_CLINICIAN,
    params: { encounterId: "current" },
    query: {},
  });
  const firstPage = first.body as PreviousExamsPage;
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.ok(firstPage.nextCursor);

  const second = await handlePreviousExamsReadRequest(deps(fhir), {
    authHeader: AUTH_CLINICIAN,
    params: { encounterId: "current" },
    query: { cursor: firstPage.nextCursor },
  });
  assert.equal(second.status, 200, JSON.stringify(second.body));
  assert.deepEqual(fhir.followedUrls, ["/fhir/R4/Encounter?_page=2&_count=4"]);
});

async function startPreviousExamRoutes(
  t: TestContext,
  fhir: MemoryFhir,
  forbiddenRole: PracticeRoleId,
): Promise<string> {
  const app = express();
  app.use(express.json());
  registerDiagnosisCarryForwardRoutes(app, {
    authenticateService: async () => undefined,
    fhirBaseUrl: "https://fhir.local",
    authenticate: async (header: string | undefined) => header === AUTH_FORBIDDEN
      ? { staffReference: "Practitioner/forbidden", actorRole: forbiddenRole, fhir: unreachableFhir }
      : header === AUTH_CLINICIAN
        ? { staffReference: "Practitioner/doc", actorRole: "clinician", fhir }
        : null,
    authenticateWrite: async (header: string | undefined) => header === AUTH_FORBIDDEN
      ? { staffReference: "Practitioner/forbidden", actorRole: forbiddenRole, fhir: unreachableFhir }
      : header === AUTH_CLINICIAN
        ? { staffReference: "Practitioner/doc", actorRole: "clinician", fhir }
        : null,
  });
  const listener = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => listener.once("listening", resolve));
  t.after(() => listener.close());
  return `http://127.0.0.1:${(listener.address() as AddressInfo).port}`;
}

async function postPull(base: string, sourceConditionId: string): Promise<Response> {
  return fetch(`${base}/clinical-graph/encounters/current-pull/previous-exams`, {
    method: "POST",
    headers: { Authorization: AUTH_CLINICIAN, "Content-Type": "application/json" },
    body: JSON.stringify({
      sourceEncounterReference: "Encounter/source-pull",
      sourceConditionReference: `Condition/${sourceConditionId}`,
    }),
  });
}

function deps(fhir: MemoryFhir) {
  return {
    fhirBaseUrl: "https://fhir.local",
    authenticate: async (header: string | undefined) => header === AUTH_CLINICIAN
      ? { staffReference: "Practitioner/doc", actorRole: "clinician" as const, fhir }
      : null,
  };
}

function previousExamFhir(): MemoryFhir {
  const fhir = new MemoryFhir();
  fhir.resources.push({ resourceType: "Patient", id: "patient-1", active: true });
  fhir.resources.push(encounter("current", "2026-08-10T09:00:00.000Z", "Current exam", ["current-dry-eye-od"]));
  fhir.resources.push(encounter("prior-1", "2026-07-10T08:30:00-04:00", "Routine eye exam", [
    "prior-1-dry-eye-od",
    "prior-1-dry-eye-os",
    "prior-1-uncataloged",
    "prior-1-refuted",
    "prior-1-entered-error",
    ...Array.from({ length: 12 }, (_, index) => `prior-1-extra-${String(index + 1).padStart(2, "0")}`),
  ]));
  fhir.resources.push(encounter("prior-2", "2026-07-10T12:00:00+00:00", "Comprehensive eye exam", ["prior-2-dry-eye-od"]));
  fhir.resources.push(encounter("prior-3", "2026-05-10T09:00:00.000Z", "Problem visit", ["prior-3-other"]));
  fhir.resources.push(encounter("prior-4", "2026-04-10T09:00:00.000Z", undefined, ["prior-4-other"]));
  fhir.resources.push(encounter("prior-5", "2026-03-10T09:00:00.000Z", "Annual eye exam", []));

  fhir.resources.push(diagnosis("current-dry-eye-od", "current", "dry_eye", "right", "confirmed", []));
  fhir.resources.push(diagnosis("prior-1-dry-eye-od", "prior-1", "dry_eye", "right", "confirmed", [
    "prior-1-staining-present",
    "prior-1-filaments-absent",
    "prior-1-no-boolean",
    "prior-1-entered-error-observation",
    ...Array.from({ length: 12 }, (_, index) => `prior-1-bulk-finding-${String(index + 1).padStart(2, "0")}`),
  ]));
  fhir.resources.push(diagnosis("prior-1-dry-eye-os", "prior-1", "dry_eye", "left", "confirmed", []));
  fhir.resources.push({
    ...diagnosis("prior-1-uncataloged", "prior-1", undefined, "unspecified", "provisional", []),
    code: {
      coding: [
        { system: "urn:system:z", code: "zeta", display: "Zeta coding" },
        { system: "urn:system:a", code: "alpha", display: "Alpha coding" },
      ],
      text: "Literal uncataloged diagnosis",
    },
  });
  fhir.resources.push(diagnosis("prior-1-refuted", "prior-1", "refuted", "right", "refuted", []));
  fhir.resources.push(diagnosis("prior-1-entered-error", "prior-1", "entered_error", "right", "entered-in-error", []));
  fhir.resources.push(diagnosis("prior-2-dry-eye-od", "prior-2", "dry_eye", "right", "confirmed", []));
  fhir.resources.push(diagnosis("prior-3-other", "prior-3", "other", "bilateral", "differential", []));
  fhir.resources.push(diagnosis("prior-4-other", "prior-4", "other", "unspecified", "unconfirmed", []));
  for (let index = 1; index <= 12; index += 1) {
    const suffix = String(index).padStart(2, "0");
    fhir.resources.push(diagnosis(`prior-1-extra-${suffix}`, "prior-1", `extra_${suffix}`, "unspecified", "confirmed", []));
  }

  fhir.resources.push(finding(
    "prior-1-staining-present",
    "prior-1",
    "ocular-surface::STAINING::punctate",
    "Punctate staining",
    true,
    "OD",
    "2+",
  ));
  fhir.resources.push(finding(
    "prior-1-filaments-absent",
    "prior-1",
    "ocular-surface::FILAMENTS::present",
    "Corneal filaments",
    false,
    "OD",
  ));
  const noBoolean = finding(
    "prior-1-no-boolean",
    "prior-1",
    "ocular-surface::TEAR::debris",
    "Tear debris",
    true,
    "OD",
  );
  delete noBoolean.valueBoolean;
  noBoolean.valueString = "present";
  fhir.resources.push(noBoolean);
  fhir.resources.push({
    ...finding(
      "prior-1-entered-error-observation",
      "prior-1",
      "ocular-surface::SCAR::present",
      "Corneal scar",
      true,
      "OD",
    ),
    status: "entered-in-error",
  });
  for (let index = 1; index <= 12; index += 1) {
    const suffix = String(index).padStart(2, "0");
    fhir.resources.push(finding(
      `prior-1-bulk-finding-${suffix}`,
      "prior-1",
      `synthetic-finding-${suffix}`,
      `Synthetic finding ${suffix}`,
      index % 2 === 0,
      "OD",
    ));
  }
  return fhir;
}

function pullFhir(sourceConditionId = "source-dry-eye-od"): MemoryFhir {
  const fhir = new MemoryFhir();
  fhir.resources.push({ resourceType: "Patient", id: "patient-1", active: true });
  const current = encounter("current-pull", "2026-08-10T09:00:00.000Z", "Current exam", [
    "current-other-1",
    "current-other-2",
  ]);
  current.meta = { versionId: "7" };
  current.diagnosis![0]!.rank = 1;
  current.diagnosis![1]!.rank = 4;
  fhir.resources.push(current);
  fhir.resources.push(encounter("source-pull", "2026-07-10T09:00:00.000Z", "Prior exam", [sourceConditionId]));
  fhir.resources.push(diagnosis("current-other-1", "current-pull", "other_1", "unspecified", "confirmed", []));
  fhir.resources.push(diagnosis("current-other-2", "current-pull", "other_2", "bilateral", "confirmed", []));

  const sourceOd = diagnosis("source-dry-eye-od", "source-pull", "dry_eye", "right", "confirmed", [
    "source-staining-present",
    "source-filaments-absent",
    "source-legacy-no-boolean",
  ]);
  sourceOd.extension = [{
    url: ODOS_EXTENSION_URLS.eyeLaterality,
    valueCodeableConcept: lateralityConcept("OD"),
  }];
  fhir.resources.push(sourceOd);
  const sourceOs = diagnosis("source-dry-eye-os", "source-pull", "dry_eye", "left", "confirmed", []);
  sourceOs.extension = [{
    url: ODOS_EXTENSION_URLS.eyeLaterality,
    valueCodeableConcept: lateralityConcept("OS"),
  }];
  fhir.resources.push(sourceOs);
  fhir.resources.push({
    ...diagnosis("source-uncataloged", "source-pull", undefined, "unspecified", "confirmed", []),
    code: {
      coding: [
        { system: "urn:literal:z", code: "z", display: "Literal Z" },
        { system: "urn:literal:a", code: "a", display: "Literal A" },
      ],
      text: "Literal uncataloged diagnosis",
    },
  });
  fhir.resources.push(finding(
    "source-staining-present",
    "source-pull",
    "ocular-surface::STAINING::punctate",
    "Punctate staining",
    true,
    "OD",
    "2+",
  ));
  fhir.resources.push(finding(
    "source-filaments-absent",
    "source-pull",
    "ocular-surface::FILAMENTS::present",
    "Corneal filaments",
    false,
    "OD",
  ));
  const sourceLegacy = finding(
    "source-legacy-no-boolean",
    "source-pull",
    "ocular-surface::LEGACY::finding",
    "Legacy source finding",
    true,
    "OD",
  );
  delete sourceLegacy.valueBoolean;
  sourceLegacy.valueString = "Legacy recorded value";
  fhir.resources.push(sourceLegacy);
  return fhir;
}

function encounter(
  id: string,
  date: string,
  visitType: string | undefined,
  conditionIds: string[],
): Encounter {
  return {
    resourceType: "Encounter",
    id,
    status: id === "current" ? "in-progress" : "finished",
    class: { system: "http://terminology.hl7.org/CodeSystem/v3-ActCode", code: "AMB", display: "ambulatory" },
    subject: { reference: "Patient/patient-1" },
    period: { start: date, end: date },
    ...(visitType ? { type: [{ text: visitType }] } : {}),
    diagnosis: conditionIds.map((conditionId, index) =>
      buildEncounterDiagnosisComponent(`Condition/${conditionId}`, index + 1)
    ),
  };
}

function diagnosis(
  id: string,
  encounterId: string,
  diagnosisKey: string | undefined,
  laterality: "right" | "left" | "bilateral" | "unspecified",
  verificationStatus: ConditionVerificationStatusCode,
  evidenceIds: string[],
): Condition {
  const code = diagnosisKey === "dry_eye"
    ? { text: `Keratoconjunctivitis sicca, ${laterality === "left" ? "left" : "right"} eye` }
    : { text: diagnosisKey ?? "Literal uncataloged diagnosis" };
  return {
    ...buildEncounterDiagnosisCondition({
      patientReference: "Patient/patient-1",
      encounterReference: `Encounter/${encounterId}`,
      code,
      verificationStatus,
      ...(diagnosisKey ? {
        identifiers: [{
          system: DIAGNOSIS_KEY_IDENTIFIER_SYSTEM,
          value: `${encounterId}::${diagnosisKey}::${laterality}`,
        }],
      } : {}),
      evidenceObservationReferences: evidenceIds.map((evidenceId) => `Observation/${evidenceId}`),
    }),
    id,
  };
}

function finding(
  id: string,
  encounterId: string,
  code: string,
  display: string,
  valueBoolean: boolean,
  laterality: "OD" | "OS" | "OU",
  grade?: string,
): Observation {
  return {
    resourceType: "Observation",
    id,
    status: "preliminary",
    code: { coding: [{ system: ODOS_OPHTHALMOLOGY_CODE_SYSTEM, code, display }], text: display },
    subject: { reference: "Patient/patient-1" },
    encounter: { reference: `Encounter/${encounterId}` },
    effectiveDateTime: "2026-07-10T09:05:00.000Z",
    valueBoolean,
    extension: [{
      url: ODOS_EXTENSION_URLS.eyeLaterality,
      valueCodeableConcept: lateralityConcept(laterality),
    }],
    ...(grade ? {
      component: [{
        code: { coding: [{ system: ODOS_OPHTHALMOLOGY_CODE_SYSTEM, code: "GRADE", display: "Grade" }] },
        valueString: grade,
      }],
    } : {}),
  };
}

const unreachableFhir = new Proxy({}, {
  get() {
    throw new Error("FHIR must not be reached before route authorization succeeds.");
  },
});

class MemoryFhir {
  readonly resources: Resource[] = [];
  readonly followedUrls: string[] = [];
  readonly transactions: Array<{ bundle: Bundle; headers: Record<string, string> }> = [];
  initialEncounterSearch: Record<string, string> | undefined;
  nextUrl = "/fhir/R4/Encounter?_page=2&_count=4";
  transactionFailureStatus: string | undefined;
  beforeCurrentEncounterRead: ((readNumber: number) => void) | undefined;
  private currentEncounterReads = 0;

  async read<T extends Resource>(resourceType: T["resourceType"], id: string): Promise<T> {
    if (resourceType === "Encounter" && id === "current-pull") {
      this.currentEncounterReads += 1;
      this.beforeCurrentEncounterRead?.(this.currentEncounterReads);
    }
    const resource = this.resources.find((candidate) =>
      candidate.resourceType === resourceType && candidate.id === id
    );
    if (!resource) throw new Error(`Missing ${resourceType}/${id}`);
    return structuredClone(resource as T);
  }

  resource<T extends Resource>(resourceType: T["resourceType"], id: string): T {
    const resource = this.resources.find((candidate) =>
      candidate.resourceType === resourceType && candidate.id === id
    );
    if (!resource) throw new Error(`Missing ${resourceType}/${id}`);
    return resource as T;
  }

  async executeTransaction(bundle: Bundle, headers: Record<string, string> = {}): Promise<Bundle> {
    this.transactions.push({ bundle: structuredClone(bundle), headers: structuredClone(headers) });
    if (this.transactionFailureStatus) {
      return {
        resourceType: "Bundle",
        type: "transaction-response",
        entry: bundle.entry?.map((entry, index) => ({
          resource: entry.resource,
          response: { status: index === 1 ? this.transactionFailureStatus! : "201 Created" },
        })),
      };
    }
    return {
      resourceType: "Bundle",
      type: "transaction-response",
      entry: bundle.entry?.map((entry) => {
        const resource = structuredClone(entry.resource!);
        if (resource.resourceType === "Condition") resource.id = "pulled-condition";
        if (resource.resourceType === "Observation") resource.id = "pulled-observation";
        if (resource.resourceType === "Provenance") resource.id = "pulled-provenance";
        return {
          resource,
          response: { status: entry.request?.method === "PUT" ? "200 OK" : "201 Created" },
        };
      }),
    };
  }

  async search<T extends Resource>(
    resourceType: T["resourceType"],
    params: Record<string, string> = {},
  ): Promise<Bundle<T>> {
    if (resourceType !== "Encounter") throw new Error(`Unexpected search for ${resourceType}`);
    this.initialEncounterSearch = structuredClone(params);
    return this.encounterPage(["prior-1", "prior-2", "prior-3", "prior-4"], this.nextUrl);
  }

  async searchUrl<T extends Resource>(url: string, resourceType: T["resourceType"]): Promise<Bundle<T>> {
    if (resourceType !== "Encounter") throw new Error(`Unexpected paged search for ${resourceType}`);
    this.followedUrls.push(url);
    if (url !== "/fhir/R4/Encounter?_page=2&_count=4") throw new Error(`Unexpected next URL ${url}`);
    return this.encounterPage(["prior-5"]);
  }

  private encounterPage<T extends Resource>(ids: string[], next?: string): Bundle<T> {
    const rows = ids.map((id) => this.resources.find((resource) =>
      resource.resourceType === "Encounter" && resource.id === id
    ) as T);
    return {
      resourceType: "Bundle",
      type: "searchset",
      entry: rows.map((resource) => ({ resource: structuredClone(resource) })),
      ...(next ? { link: [{ relation: "next", url: next }] } : {}),
    };
  }
}
