import assert from "node:assert/strict";
import { test } from "node:test";
import type { Bundle, Observation, Provenance } from "@medplum/fhirtypes";
import type { PracticeRoleId } from "../src/authz/roles.js";
import {
  handleSoftContactLensCaptureRequest,
  handleSpecialtyContactLensCaptureRequest,
} from "../src/clinical-graph/contact-lens-endpoint.js";
import {
  handleRefractionHistoryRequest,
  type RefractionHistoryResponse,
} from "../src/clinical-graph/refraction-history-endpoint.js";
import { handleRefractionCaptureRequest } from "../src/clinical-graph/refraction-endpoint.js";
import { handleWearingCaptureRequest } from "../src/clinical-graph/pretest-endpoint.js";
import { CONTACT_LENS_PARAMETER_CODE_SYSTEM } from "../src/fhir/contactLens.js";

const AUTH = "Bearer good";
const PATIENT = "Patient/p1";
const ENCOUNTER = "Encounter/e1";

test("refraction history enforces chart.read and returns empty tab groups", async () => {
  const fixture = historyFixture();
  const unauthorized = await handleRefractionHistoryRequest(fixture.historyDeps(), {
    authHeader: undefined,
    query: { patient: PATIENT },
  });
  const forbidden = await handleRefractionHistoryRequest(fixture.historyDeps("auditor"), {
    authHeader: AUTH,
    query: { patient: PATIENT },
  });
  const empty = await fixture.read();

  assert.equal(unauthorized.status, 401);
  assert.equal(forbidden.status, 403);
  assert.equal(empty.status, 200);
  assert.deepEqual(empty.body, { glasses: [], softCl: [], specialtyCl: [] });
  assert.equal(fixture.searches.length, 4);
  for (const search of fixture.searches) {
    assert.equal(search.params.subject, PATIENT);
    assert.equal(search.params._sort, "-date");
    assert.equal(search.params._count, "200");
  }
});

test("refraction capture round-trips structured powers, VA, type, eye, and purpose", async () => {
  const fixture = historyFixture();
  fixture.recordedAt = "2026-07-10T13:00:00.000Z";
  const captured = await handleRefractionCaptureRequest(fixture.captureDeps(), {
    authHeader: AUTH,
    body: {
      patientReference: PATIENT,
      encounterReference: ENCOUNTER,
      blocks: [{
        type: "FINAL_RX",
        purpose: "General wear",
        OD: {
          sphere: -1.25,
          cylinder: -0.5,
          axis: 90,
          add: 2,
          distanceVisualAcuity: "20/20 +1",
          nearVisualAcuity: "J1",
        },
      }],
    },
  });
  const history = await fixture.readBody();

  assert.equal(captured.status, 200);
  assert.deepEqual(history.glasses, [{
    type: "Final/Rx",
    date: "2026-07-10T13:00:00.000Z",
    eye: "OD",
    sphere: -1.25,
    cylinder: -0.5,
    axis: 90,
    add: 2,
    distVA: "20/20 +1",
    nearVA: "J1",
    purpose: "General wear",
  }]);
  assert.deepEqual(history.softCl, []);
  assert.deepEqual(history.specialtyCl, []);
});

test("wearing capture round-trips its paired component encoding and sorts ahead of older refraction", async () => {
  const fixture = historyFixture();
  fixture.recordedAt = "2026-07-10T12:00:00.000Z";
  await handleRefractionCaptureRequest(fixture.captureDeps(), {
    authHeader: AUTH,
    body: {
      patientReference: PATIENT,
      encounterReference: ENCOUNTER,
      blocks: [{ type: "MANIFEST", OS: { sphere: -0.25 } }],
    },
  });
  fixture.recordedAt = "2026-07-10T14:00:00.000Z";
  const captured = await handleWearingCaptureRequest(fixture.captureDeps(), {
    authHeader: AUTH,
    body: {
      patientReference: PATIENT,
      encounterReference: ENCOUNTER,
      leftGlassesAtHome: false,
      pairs: [{
        eyeglassType: "progressives",
        OD: {
          sphere: 1.25,
          cylinder: -0.75,
          axis: 80,
          add: 2.25,
          distanceVisualAcuity: "20/25",
          nearVisualAcuity: "J2",
        },
      }],
    },
  });
  const history = await fixture.readBody();

  assert.equal(captured.status, 200);
  assert.deepEqual(history.glasses[0], {
    type: "Wearing",
    date: "2026-07-10T14:00:00.000Z",
    eye: "OD",
    sphere: 1.25,
    cylinder: -0.75,
    axis: 80,
    add: 2.25,
    distVA: "20/25",
    nearVA: "J2",
  });
  assert.equal(history.glasses[1]?.type, "Manifest");
  assert.equal("nearVA" in (history.glasses[1] ?? {}), false);
});

test("soft contact lens capture round-trips canonical CL parameters and tab-specific fields", async () => {
  const fixture = historyFixture();
  fixture.recordedAt = "2026-07-10T15:00:00.000Z";
  const captured = await handleSoftContactLensCaptureRequest(fixture.captureDeps(), {
    authHeader: AUTH,
    body: {
      patientReference: PATIENT,
      encounterReference: ENCOUNTER,
      status: "dispensed_successful",
      eyes: {
        OS: {
          manufacturer: "alcon",
          product: "air_optix_aqua_multifocal",
          baseCurve: 8.6,
          diameter: 14.2,
          sphere: -6,
          cylinder: -1.25,
          axis: 100,
          add: 2.25,
          colorMfPower: "high",
          distanceVisualAcuity: "20/20",
          nearVisualAcuity: "J1",
        },
      },
    },
  });
  const observation = fixture.observations[0];
  const history = await fixture.readBody();

  assert.equal(captured.status, 200);
  assert.equal(canonicalParameterCodes(observation).has("sphere-power"), true);
  assert.equal(canonicalParameterCodes(observation).has("base-curve-mm"), true);
  assert.deepEqual(history.softCl, [{
    date: "2026-07-10T15:00:00.000Z",
    eye: "OS",
    manufacturer: "alcon",
    product: "air_optix_aqua_multifocal",
    baseCurve: 8.6,
    diameter: 14.2,
    sphere: -6,
    cylinder: -1.25,
    axis: 100,
    add: 2.25,
    colorMfPower: "high",
    distVA: "20/20",
    nearVA: "J1",
    status: "dispensed_successful",
  }]);
  assert.deepEqual(history.glasses, []);
  assert.deepEqual(history.specialtyCl, []);
});

test("specialty contact lens capture round-trips canonical CL parameters, type, and material", async () => {
  const fixture = historyFixture();
  fixture.recordedAt = "2026-07-10T16:00:00.000Z";
  const captured = await handleSpecialtyContactLensCaptureRequest(fixture.captureDeps(), {
    authHeader: AUTH,
    body: {
      patientReference: PATIENT,
      encounterReference: ENCOUNTER,
      eyes: {
        OD: {
          manufacturer: "blanchard",
          product: "onefit_med",
          lensType: "scleral-prolate",
          material: "Boston-XO2",
          baseCurve: 7.8,
          diameter: 16.5,
          sphere: -8,
          cylinder: -1.25,
          axis: 90,
          add: 2,
          distanceVisualAcuity: "20/25",
          nearVisualAcuity: "J1",
          additionalFields: [],
        },
      },
    },
  });
  const observation = fixture.observations[0];
  const history = await fixture.readBody();

  assert.equal(captured.status, 200);
  assert.equal(canonicalParameterCodes(observation).has("sphere-power"), true);
  assert.equal(canonicalParameterCodes(observation).has("add-power"), true);
  assert.deepEqual(history.specialtyCl, [{
    date: "2026-07-10T16:00:00.000Z",
    eye: "OD",
    product: "onefit_med",
    lensType: "scleral-prolate",
    material: "Boston-XO2",
    baseCurve: 7.8,
    diameter: 16.5,
    sphere: -8,
    cylinder: -1.25,
    axis: 90,
    add: 2,
    distVA: "20/25",
    nearVA: "J1",
  }]);
  assert.deepEqual(history.glasses, []);
  assert.deepEqual(history.softCl, []);
});

function historyFixture() {
  const observations: Observation[] = [];
  const searches: Array<{ params: Record<string, string> }> = [];
  const fixture = {
    recordedAt: "2026-07-10T12:00:00.000Z",
    observations,
    searches,
    fhir: {
      create: async <T extends Observation | Provenance>(resource: T): Promise<T> => {
        const created = { ...resource, id: resource.id ?? `${resource.resourceType.toLowerCase()}-${observations.length + 1}` };
        if (created.resourceType === "Observation") observations.push(created);
        return created as T;
      },
      search: async <T extends Observation>(
        _resourceType: T["resourceType"],
        params: Record<string, string> = {},
      ): Promise<Bundle<T>> => {
        searches.push({ params });
        const [system, code] = params.code?.split("|") ?? [];
        const matches = observations
          .filter((observation) => observation.subject?.reference === params.subject)
          .filter((observation) => observation.code.coding?.some((coding) => coding.system === system && coding.code === code))
          .sort((left, right) => String(right.effectiveDateTime).localeCompare(String(left.effectiveDateTime)));
        return {
          resourceType: "Bundle",
          type: "searchset",
          entry: matches.map((resource) => ({ resource: resource as T })),
        };
      },
    },
    authenticate(role: PracticeRoleId = "clinician") {
      return async (authHeader: string | undefined) => authHeader === AUTH
        ? { staffReference: "Practitioner/doc1", actorRole: role, fhir: fixture.fhir }
        : null;
    },
    captureDeps(role: PracticeRoleId = "clinician") {
      return { authenticate: fixture.authenticate(role), now: () => fixture.recordedAt };
    },
    historyDeps(role: PracticeRoleId = "clinician") {
      return { authenticate: fixture.authenticate(role) };
    },
    read() {
      return handleRefractionHistoryRequest(fixture.historyDeps(), {
        authHeader: AUTH,
        query: { patient: PATIENT },
      });
    },
    async readBody(): Promise<RefractionHistoryResponse> {
      const response = await fixture.read();
      assert.equal(response.status, 200);
      return response.body as RefractionHistoryResponse;
    },
  };
  return fixture;
}

function canonicalParameterCodes(observation: Observation | undefined): Set<string | undefined> {
  return new Set(observation?.component?.flatMap((component) => component.code.coding ?? [])
    .filter((coding) => coding.system === CONTACT_LENS_PARAMETER_CODE_SYSTEM)
    .map((coding) => coding.code));
}
