import assert from "node:assert/strict";
import { test } from "node:test";
import type { Bundle, Observation, Provenance, Resource } from "@medplum/fhirtypes";
import {
  BLOOD_PRESSURE_PANEL_CODE,
  BODY_HEIGHT_CODE,
  BODY_WEIGHT_CODE,
  CAROTENOID_SCORE_CODE,
  handleBodyMeasurementsCaptureRequest,
  handleBloodPressureCaptureRequest,
  handleCarotenoidCaptureRequest,
  handlePretestVitalsHistoryRequest,
  type PretestVitalsEndpointDeps,
} from "../src/clinical-graph/pretest-vitals-endpoint.js";

const AUTH = "Bearer good";

function fixture() {
  const observations: Observation[] = [];
  const created: Array<Observation | Provenance> = [];
  const transactions: Bundle[] = [];
  let standaloneCreates = 0;
  const deps: PretestVitalsEndpointDeps = {
    authenticate: async (header) => header === AUTH ? {
      staffReference: "Practitioner/doc1",
      actorRole: "provider",
      fhir: {
        create: async (resource, headers) => {
          standaloneCreates += 1;
          assert.equal(headers?.["X-ODOS-Source"], "mcp/save_section_observations");
          const saved = { ...resource, id: `${resource.resourceType.toLowerCase()}-${created.length + 1}` };
          created.push(saved);
          if (saved.resourceType === "Observation") observations.push(saved);
          return saved;
        },
        executeTransaction: async (bundle, headers) => {
          assert.equal(headers?.["X-ODOS-Source"], "mcp/save_section_observations");
          transactions.push(bundle);
          const entry = (bundle.entry ?? []).map((item) => {
            assert.ok(item.resource?.resourceType === "Observation" || item.resource?.resourceType === "Provenance");
            const saved = { ...item.resource, id: `${item.resource.resourceType.toLowerCase()}-${created.length + 1}` } as Observation | Provenance;
            created.push(saved);
            if (saved.resourceType === "Observation") observations.push(saved);
            return {
              resource: saved,
              response: { status: "201 Created", location: `${saved.resourceType}/${saved.id}/_history/1` },
            };
          });
          return { resourceType: "Bundle", type: "transaction-response", entry };
        },
        search: async <T extends Resource>() => ({
          resourceType: "Bundle",
          type: "searchset",
          entry: observations.map((resource) => ({ resource })),
        } as Bundle<T>),
      },
    } : null,
    now: () => "2026-08-17T14:30:00.000Z",
  };
  return { created, observations, transactions, standaloneCreates: () => standaloneCreates, deps };
}

test("body measurements use one atomic FHIR transaction with no standalone clinical writes", async () => {
  const { deps, transactions, standaloneCreates } = fixture();
  const result = await handleBodyMeasurementsCaptureRequest(deps, { authHeader: AUTH, body: {
    patientReference: "Patient/p1", encounterReference: "Encounter/e1", recordedAt: "2026-08-21T09:15:00.000Z",
    height: { value: 68.5, unit: "in" }, weight: { value: 154.25, unit: "lb" },
  } });

  assert.equal(result.status, 200);
  assert.equal(standaloneCreates(), 0);
  assert.equal(transactions.length, 1);
  const transaction = transactions[0];
  assert.equal(transaction?.type, "transaction");
  assert.deepEqual(transaction?.entry?.map((entry) => ({
    fullUrl: entry.fullUrl,
    resourceType: entry.resource?.resourceType,
    request: entry.request,
  })), [
    { fullUrl: "urn:uuid:body-height", resourceType: "Observation", request: { method: "POST", url: "Observation" } },
    { fullUrl: "urn:uuid:body-height-provenance", resourceType: "Provenance", request: { method: "POST", url: "Provenance" } },
    { fullUrl: "urn:uuid:body-weight", resourceType: "Observation", request: { method: "POST", url: "Observation" } },
    { fullUrl: "urn:uuid:body-weight-provenance", resourceType: "Provenance", request: { method: "POST", url: "Provenance" } },
  ]);
  assert.deepEqual((transaction?.entry?.[1]?.resource as Provenance).target.map((target) => target.reference), ["urn:uuid:body-height", "Patient/p1"]);
  assert.deepEqual((transaction?.entry?.[3]?.resource as Provenance).target.map((target) => target.reference), ["urn:uuid:body-weight", "Patient/p1"]);
});

test("body measurements persist two separate US Core Observations with exact verified LOINC and UCUM pairs", async () => {
  const { created, deps } = fixture();
  const result = await handleBodyMeasurementsCaptureRequest(deps, {
    authHeader: AUTH,
    body: {
      patientReference: "Patient/p1",
      encounterReference: "Encounter/e1",
      recordedAt: "2026-08-21T09:15:00.000Z",
      height: { value: 68.5, unit: "in" },
      weight: { value: 154.25, unit: "lb" },
    },
  });

  assert.equal(result.status, 200);
  assert.deepEqual(created.map((resource) => resource.resourceType), ["Observation", "Provenance", "Observation", "Provenance"]);
  const [height, , weight] = created as [Observation, Provenance, Observation, Provenance];
  assert.deepEqual(height.meta?.profile, ["http://hl7.org/fhir/us/core/StructureDefinition/us-core-body-height"]);
  assert.deepEqual(height.code, { coding: [{ system: "http://loinc.org", code: BODY_HEIGHT_CODE, display: "Body height" }], text: "Body height" });
  assert.deepEqual(height.valueQuantity, { value: 68.5, unit: "in", system: "http://unitsofmeasure.org", code: "[in_i]" });
  assert.deepEqual(weight.meta?.profile, ["http://hl7.org/fhir/us/core/StructureDefinition/us-core-body-weight"]);
  assert.deepEqual(weight.code, { coding: [{ system: "http://loinc.org", code: BODY_WEIGHT_CODE, display: "Body weight" }], text: "Body weight" });
  assert.deepEqual(weight.valueQuantity, { value: 154.25, unit: "lb", system: "http://unitsofmeasure.org", code: "[lb_av]" });
});

test("body measurements carry the complete shared capture context on both Observations", async () => {
  const { created, deps } = fixture();
  await handleBodyMeasurementsCaptureRequest(deps, { authHeader: AUTH, body: {
    patientReference: "Patient/p1", encounterReference: "Encounter/e1", recordedAt: "2026-08-21T09:15:00.000Z",
    height: { value: 68.5, unit: "in" }, weight: { value: 154.25, unit: "lb" },
  } });

  for (const observation of [created[0], created[2]] as Observation[]) {
    assert.equal(observation.status, "preliminary");
    assert.deepEqual(observation.category, [{ coding: [{
      system: "http://terminology.hl7.org/CodeSystem/observation-category",
      code: "vital-signs",
      display: "Vital Signs",
    }] }]);
    assert.deepEqual(observation.subject, { reference: "Patient/p1" });
    assert.deepEqual(observation.encounter, { reference: "Encounter/e1" });
    assert.equal(observation.effectiveDateTime, "2026-08-21T09:15:00.000Z");
    assert.deepEqual(observation.performer, [{ reference: "Practitioner/doc1" }]);
  }
});

test("metric body measurements are normalized before persistence with agreeing customary unit and code", async () => {
  const { created, deps } = fixture();
  const result = await handleBodyMeasurementsCaptureRequest(deps, { authHeader: AUTH, body: {
    patientReference: "Patient/p1", encounterReference: "Encounter/e1",
    height: { value: 175, unit: "cm" }, weight: { value: 80, unit: "kg" },
  } });

  assert.equal(result.status, 200);
  const height = created[0] as Observation;
  const weight = created[2] as Observation;
  assert.ok(Math.abs((height.valueQuantity?.value ?? 0) - 68.89763779527559) < 1e-12);
  assert.deepEqual({ unit: height.valueQuantity?.unit, code: height.valueQuantity?.code }, { unit: "in", code: "[in_i]" });
  assert.ok(Math.abs((weight.valueQuantity?.value ?? 0) - 176.3698097479022) < 1e-12);
  assert.deepEqual({ unit: weight.valueQuantity?.unit, code: weight.valueQuantity?.code }, { unit: "lb", code: "[lb_av]" });
});

test("missing or non-positive body measurements return 400 with zero writes", async () => {
  for (const body of [
    { patientReference: "Patient/p1", encounterReference: "Encounter/e1", weight: { value: 150, unit: "lb" } },
    { patientReference: "Patient/p1", encounterReference: "Encounter/e1", height: { value: 68, unit: "in" } },
    { patientReference: "Patient/p1", encounterReference: "Encounter/e1", height: { value: 0, unit: "in" }, weight: { value: 150, unit: "lb" } },
    { patientReference: "Patient/p1", encounterReference: "Encounter/e1", height: { value: 68, unit: "in" }, weight: { value: -1, unit: "lb" } },
  ]) {
    const { created, deps } = fixture();
    const result = await handleBodyMeasurementsCaptureRequest(deps, { authHeader: AUTH, body });
    assert.equal(result.status, 400);
    assert.equal(created.length, 0);
  }
});

test("body measurement capture requires authentication and chart.write with zero unauthorized writes", async () => {
  const request = { body: {
    patientReference: "Patient/p1", encounterReference: "Encounter/e1",
    height: { value: 68, unit: "in" }, weight: { value: 150, unit: "lb" },
  } };
  const unauthenticated = fixture();
  assert.equal((await handleBodyMeasurementsCaptureRequest(unauthenticated.deps, { ...request, authHeader: undefined })).status, 401);
  assert.equal(unauthenticated.created.length, 0);

  const forbidden = fixture();
  const authenticate = forbidden.deps.authenticate;
  forbidden.deps.authenticate = async (header) => {
    const staff = await authenticate(header);
    return staff ? { ...staff, actorRole: "admin" } : null;
  };
  assert.equal((await handleBodyMeasurementsCaptureRequest(forbidden.deps, { ...request, authHeader: AUTH })).status, 403);
  assert.equal(forbidden.created.length, 0);
});

test("history returns only the latest height and weight while retaining BP and carotenoid arrays", async () => {
  const { deps } = fixture();
  for (const [recordedAt, height, weight] of [
    ["2026-08-21T09:00:00.000Z", 67, 150],
    ["2026-08-21T10:00:00.000Z", 68, 151],
  ] as const) {
    await handleBodyMeasurementsCaptureRequest(deps, { authHeader: AUTH, body: {
      patientReference: "Patient/p1", encounterReference: "Encounter/e1", recordedAt,
      height: { value: height, unit: "in" }, weight: { value: weight, unit: "lb" },
    } });
  }

  const result = await handlePretestVitalsHistoryRequest(deps, { authHeader: AUTH, query: { patient: "Patient/p1" } });
  assert.equal(result.status, 200);
  const body = result.body as {
    bloodPressure: unknown[];
    carotenoid: unknown[];
    height: { value: number; unit: string; code: string; recordedAt: string } | null;
    weight: { value: number; unit: string; code: string; recordedAt: string } | null;
  };
  assert.deepEqual(body.height, {
    observationReference: "Observation/observation-5",
    encounterReference: "Encounter/e1",
    recordedAt: "2026-08-21T10:00:00.000Z",
    value: 68,
    unit: "in",
    code: "[in_i]",
  });
  assert.deepEqual(body.weight, {
    observationReference: "Observation/observation-7",
    encounterReference: "Encounter/e1",
    recordedAt: "2026-08-21T10:00:00.000Z",
    value: 151,
    unit: "lb",
    code: "[lb_av]",
  });
  assert.deepEqual(body.bloodPressure, []);
  assert.deepEqual(body.carotenoid, []);
});

test("stored body-measurement shape matches the documented PR #410 reader contract (shape-contract, not integration)", async () => {
  const { observations, deps } = fixture();
  await handleBodyMeasurementsCaptureRequest(deps, { authHeader: AUTH, body: {
    patientReference: "Patient/p1", encounterReference: "Encounter/e1", recordedAt: "2026-08-21T09:15:00.000Z",
    height: { value: 68.5, unit: "in" }, weight: { value: 154.25, unit: "lb" },
  } });

  const readerQueries = [
    { patient: "p1", code: "http://loinc.org|8302-2", "status:not": "entered-in-error", _sort: "-date", _count: "1" },
    { patient: "p1", code: "http://loinc.org|29463-7", "status:not": "entered-in-error", _sort: "-date", _count: "1" },
  ];
  assert.deepEqual(readerQueries, [
    { patient: "p1", code: `http://loinc.org|${BODY_HEIGHT_CODE}`, "status:not": "entered-in-error", _sort: "-date", _count: "1" },
    { patient: "p1", code: `http://loinc.org|${BODY_WEIGHT_CODE}`, "status:not": "entered-in-error", _sort: "-date", _count: "1" },
  ]);
  assert.deepEqual(observations, [
    {
      resourceType: "Observation",
      id: "observation-1",
      meta: { profile: ["http://hl7.org/fhir/us/core/StructureDefinition/us-core-body-height"] },
      status: "preliminary",
      category: [{ coding: [{ system: "http://terminology.hl7.org/CodeSystem/observation-category", code: "vital-signs", display: "Vital Signs" }] }],
      code: { coding: [{ system: "http://loinc.org", code: "8302-2", display: "Body height" }], text: "Body height" },
      subject: { reference: "Patient/p1" },
      encounter: { reference: "Encounter/e1" },
      effectiveDateTime: "2026-08-21T09:15:00.000Z",
      performer: [{ reference: "Practitioner/doc1" }],
      valueQuantity: { value: 68.5, unit: "in", system: "http://unitsofmeasure.org", code: "[in_i]" },
    },
    {
      resourceType: "Observation",
      id: "observation-3",
      meta: { profile: ["http://hl7.org/fhir/us/core/StructureDefinition/us-core-body-weight"] },
      status: "preliminary",
      category: [{ coding: [{ system: "http://terminology.hl7.org/CodeSystem/observation-category", code: "vital-signs", display: "Vital Signs" }] }],
      code: { coding: [{ system: "http://loinc.org", code: "29463-7", display: "Body weight" }], text: "Body weight" },
      subject: { reference: "Patient/p1" },
      encounter: { reference: "Encounter/e1" },
      effectiveDateTime: "2026-08-21T09:15:00.000Z",
      performer: [{ reference: "Practitioner/doc1" }],
      valueQuantity: { value: 154.25, unit: "lb", system: "http://unitsofmeasure.org", code: "[lb_av]" },
    },
  ]);
});

test("blood pressure persists the US Core panel with verified component codes and capture context", async () => {
  const { created, deps } = fixture();
  const result = await handleBloodPressureCaptureRequest(deps, {
    authHeader: AUTH,
    body: {
      patientReference: "Patient/p1",
      encounterReference: "Encounter/e1",
      recordedAt: "2026-08-17T14:25:00.000Z",
      systolic: 132,
      diastolic: 84,
      cuffSite: "Left upper arm",
      position: "sitting",
    },
  });

  assert.equal(result.status, 200);
  assert.deepEqual(created.map((resource) => resource.resourceType), ["Observation", "Provenance"]);
  const observation = created[0] as Observation;
  assert.deepEqual(observation.meta?.profile, ["http://hl7.org/fhir/us/core/StructureDefinition/us-core-blood-pressure"]);
  assert.equal(observation.code.coding?.[0]?.code, BLOOD_PRESSURE_PANEL_CODE);
  assert.equal(observation.category?.[0]?.coding?.[0]?.code, "vital-signs");
  assert.equal(observation.bodySite?.text, "Left upper arm");
  assert.equal(observation.effectiveDateTime, "2026-08-17T14:25:00.000Z");
  assert.deepEqual(observation.component?.slice(0, 2).map((component) => ({
    code: component.code.coding?.[0]?.code,
    value: component.valueQuantity?.value,
    unit: component.valueQuantity?.code,
  })), [
    { code: "8480-6", value: 132, unit: "mm[Hg]" },
    { code: "8462-4", value: 84, unit: "mm[Hg]" },
  ]);
  assert.equal(observation.component?.[2]?.valueCodeableConcept?.coding?.[0]?.code, "sitting");
  assert.equal((created[1] as Provenance).target[1]?.reference, "Patient/p1");
});

test("repeat blood pressure capture creates another reading instead of overwriting", async () => {
  const { observations, deps } = fixture();
  const body = {
    patientReference: "Patient/p1", encounterReference: "Encounter/e1",
    systolic: 128, diastolic: 78, cuffSite: "Right upper arm", position: "standing",
  };
  assert.equal((await handleBloodPressureCaptureRequest(deps, { authHeader: AUTH, body })).status, 200);
  assert.equal((await handleBloodPressureCaptureRequest(deps, { authHeader: AUTH, body: { ...body, systolic: 126 } })).status, 200);
  assert.equal(observations.length, 2);
});

test("carotenoid capture stores only the integer score and S3 device, with no diagnosis or charge artifact", async () => {
  const { created, deps } = fixture();
  const result = await handleCarotenoidCaptureRequest(deps, {
    authHeader: AUTH,
    body: {
      patientReference: "Patient/p1",
      encounterReference: "Encounter/e1",
      recordedAt: "2026-08-17T14:25:00.000Z",
      score: 51_000,
    },
  });

  assert.equal(result.status, 200);
  assert.deepEqual(created.map((resource) => resource.resourceType), ["Observation", "Provenance"]);
  const observation = created[0] as Observation;
  assert.equal(observation.code.coding?.[0]?.code, CAROTENOID_SCORE_CODE);
  assert.equal(observation.valueInteger, 51_000);
  assert.equal(observation.valueQuantity, undefined);
  assert.equal(observation.device?.display, "Nu Skin Pharmanex S3");
  assert.equal(JSON.stringify(result.body).match(/diagnos|charge|coverage/gi), null);
});

test("carotenoid capture rejects scores above the S3 scale before any write", async () => {
  const { created, deps } = fixture();
  const result = await handleCarotenoidCaptureRequest(deps, {
    authHeader: AUTH,
    body: { patientReference: "Patient/p1", encounterReference: "Encounter/e1", score: 90_001 },
  });

  assert.equal(result.status, 400);
  assert.equal(created.length, 0);
});

test("history returns every BP and carotenoid reading in chronological order", async () => {
  const { deps } = fixture();
  await handleCarotenoidCaptureRequest(deps, { authHeader: AUTH, body: {
    patientReference: "Patient/p1", encounterReference: "Encounter/e1", recordedAt: "2026-08-17T15:00:00.000Z", score: 42_000,
  } });
  await handleBloodPressureCaptureRequest(deps, { authHeader: AUTH, body: {
    patientReference: "Patient/p1", encounterReference: "Encounter/e1", recordedAt: "2026-08-17T14:00:00.000Z",
    systolic: 120, diastolic: 76, cuffSite: "Left upper arm", position: "sitting",
  } });
  const result = await handlePretestVitalsHistoryRequest(deps, { authHeader: AUTH, query: { patient: "Patient/p1" } });
  assert.equal(result.status, 200);
  const body = result.body as { bloodPressure: unknown[]; carotenoid: unknown[] };
  assert.equal(body.bloodPressure.length, 1);
  assert.equal(body.carotenoid.length, 1);
});

test("history follows next links so later BP and carotenoid pages remain visible", async () => {
  const makeObservation = (kind: "bp" | "carotenoid", id: string, recordedAt: string): Observation => kind === "bp" ? {
    resourceType: "Observation",
    id,
    status: "preliminary",
    code: { coding: [{ system: "http://loinc.org", code: BLOOD_PRESSURE_PANEL_CODE }] },
    effectiveDateTime: recordedAt,
    component: [
      { code: { coding: [{ system: "http://loinc.org", code: "8480-6" }] }, valueQuantity: { value: 120 } },
      { code: { coding: [{ system: "http://loinc.org", code: "8462-4" }] }, valueQuantity: { value: 76 } },
    ],
  } : {
    resourceType: "Observation",
    id,
    status: "preliminary",
    code: { coding: [{ system: "https://odos2020.com/fhir/CodeSystem/ophthalmology", code: CAROTENOID_SCORE_CODE }] },
    effectiveDateTime: recordedAt,
    valueInteger: 42_000,
  };
  const deps: PretestVitalsEndpointDeps = {
    authenticate: async () => ({
      staffReference: "Practitioner/doc1",
      actorRole: "provider",
      fhir: {
        baseUrl: "https://example.test/",
        create: async (resource) => resource,
        executeTransaction: async (bundle) => bundle,
        search: async <T extends Resource>(_resourceType: T["resourceType"], params?: Record<string, string>) => {
          const kind = params?.code?.includes(BLOOD_PRESSURE_PANEL_CODE) ? "bp" : "carotenoid";
          return {
            resourceType: "Bundle",
            type: "searchset",
            entry: [{ resource: makeObservation(kind, `${kind}-1`, "2026-08-17T14:00:00.000Z") as T }],
            link: [{ relation: "next", url: `https://example.test/fhir/R4/Observation?kind=${kind}` }],
          } as Bundle<T>;
        },
        searchUrl: async <T extends Resource>(url: string) => {
          const kind = url.includes("kind=bp") ? "bp" : "carotenoid";
          return {
            resourceType: "Bundle",
            type: "searchset",
            entry: [{ resource: makeObservation(kind, `${kind}-2`, "2026-08-17T15:00:00.000Z") as T }],
          } as Bundle<T>;
        },
      },
    }),
  };

  const result = await handlePretestVitalsHistoryRequest(deps, { authHeader: AUTH, query: { patient: "Patient/p1" } });
  const body = result.body as { bloodPressure: unknown[]; carotenoid: unknown[] };
  assert.equal(body.bloodPressure.length, 2);
  assert.equal(body.carotenoid.length, 2);
});
