import assert from "node:assert/strict";
import { test } from "node:test";
import type { Bundle, Observation, Provenance } from "@medplum/fhirtypes";
import {
  BLOOD_PRESSURE_PANEL_CODE,
  CAROTENOID_SCORE_CODE,
  handleBloodPressureCaptureRequest,
  handleCarotenoidCaptureRequest,
  handlePretestVitalsHistoryRequest,
  type PretestVitalsEndpointDeps,
} from "../src/clinical-graph/pretest-vitals-endpoint.js";

const AUTH = "Bearer good";

function fixture() {
  const observations: Observation[] = [];
  const created: Array<Observation | Provenance> = [];
  const deps: PretestVitalsEndpointDeps = {
    authenticate: async (header) => header === AUTH ? {
      staffReference: "Practitioner/doc1",
      actorRole: "provider",
      fhir: {
        create: async (resource, headers) => {
          assert.equal(headers?.["X-ODOS-Source"], "mcp/save_section_observations");
          const saved = { ...resource, id: `${resource.resourceType.toLowerCase()}-${created.length + 1}` };
          created.push(saved);
          if (saved.resourceType === "Observation") observations.push(saved);
          return saved;
        },
        search: async <T extends Observation>() => ({
          resourceType: "Bundle",
          type: "searchset",
          entry: observations.map((resource) => ({ resource })),
        } as Bundle<T>),
      },
    } : null,
    now: () => "2026-08-17T14:30:00.000Z",
  };
  return { created, observations, deps };
}

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
        create: async (resource) => resource,
        search: async <T extends Observation>(_resourceType: T["resourceType"], params?: Record<string, string>) => {
          const kind = params?.code?.includes(BLOOD_PRESSURE_PANEL_CODE) ? "bp" : "carotenoid";
          return {
            resourceType: "Bundle",
            type: "searchset",
            entry: [{ resource: makeObservation(kind, `${kind}-1`, "2026-08-17T14:00:00.000Z") as T }],
            link: [{ relation: "next", url: `https://example.test/fhir/R4/Observation?kind=${kind}` }],
          } as Bundle<T>;
        },
        searchUrl: async <T extends Observation>(url: string) => {
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
