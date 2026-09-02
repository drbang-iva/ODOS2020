import assert from "node:assert/strict";
import { test } from "node:test";
import type { Bundle, Observation, Provenance } from "@medplum/fhirtypes";
import type { PracticeRoleId } from "../src/authz/roles.js";
import { handleCoverTestCaptureRequest, handleCoverTestHistoryRequest, type CoverTestEndpointDeps } from "../src/clinical-graph/cover-test-endpoint.js";
import { buildFindingDefinitionSeeds } from "../src/clinical-graph/finding-definition-store.js";

const AUTH = "Bearer good";

class MemoryFhir {
  resources: Array<Observation | Provenance> = [];
  async create<T extends Observation | Provenance>(resource: T): Promise<T> {
    const saved = { ...resource, id: resource.id ?? `${resource.resourceType.toLowerCase()}-${this.resources.length + 1}` } as T;
    this.resources.push(saved);
    return saved;
  }
  async search<T extends Observation>(resourceType: T["resourceType"]): Promise<Bundle<T>> {
    return { resourceType: "Bundle", type: "searchset", entry: this.resources.filter((row) => row.resourceType === resourceType).map((resource) => ({ resource: resource as T })) };
  }
}

function setup(role: PracticeRoleId = "provider") {
  const fhir = new MemoryFhir();
  const deps: CoverTestEndpointDeps = {
    authenticate: async (header) => header === AUTH ? { staffReference: "Practitioner/doc", actorRole: role, fhir } : null,
    findingDefinitions: () => buildFindingDefinitionSeeds(),
    now: () => "2026-07-22T12:00:00.000Z",
  };
  return { fhir, deps };
}

test("cover test persists independent ortho and bounded deviation rows with documentation and history", async () => {
  const { fhir, deps } = setup();
  const result = await handleCoverTestCaptureRequest(deps, {
    authHeader: AUTH,
    body: {
      patientReference: "Patient/p1",
      encounterReference: "Encounter/e1",
      rows: [
        { slot: "distance-cc", state: "ortho", note: "steady fixation" },
        { slot: "near-sc", state: "deviation", deviationType: "phoria", direction: "exo", magnitude: 60, laterality: "alternating", comitancy: "comitant", note: "breaks at near" },
      ],
    },
  });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  const observation = fhir.resources.find((row): row is Observation => row.resourceType === "Observation")!;
  assert.equal(code(observation, "entrance.cover"), "abnormal");
  assert.equal(value(observation, "DISTANCE_CC_STATE"), "ortho");
  assert.equal(quantity(observation, "NEAR_SC_MAGNITUDE"), 60);
  assert.match(observation.note?.[0]?.text ?? "", /distance-cc: ortho — steady fixation/);
  assert.match(observation.note?.[0]?.text ?? "", /near-sc: phoria exo 60Δ/);
  assert.equal(fhir.resources.some((row) => row.resourceType === "Provenance"), true);
  const history = await handleCoverTestHistoryRequest(deps, { authHeader: AUTH, query: { patient: "Patient/p1", encounter: "Encounter/e1" } });
  assert.equal((history.body as { rows: Array<{ summary: string }> }).rows[0]?.summary, observation.note?.[0]?.text);
});

test("cover test accepts zero, rejects values above 60, duplicate slots, and unauthorized writes", async () => {
  assert.equal((await handleCoverTestCaptureRequest(setup().deps, { authHeader: undefined, body: {} })).status, 401);
  assert.equal((await handleCoverTestCaptureRequest(setup("admin").deps, { authHeader: AUTH, body: {} })).status, 403);
  const duplicate = await handleCoverTestCaptureRequest(setup().deps, { authHeader: AUTH, body: { patientReference: "Patient/p1", encounterReference: "Encounter/e1", rows: [{ slot: "distance-cc", state: "ortho" }, { slot: "distance-cc", state: "ortho" }] } });
  assert.equal(duplicate.status, 400);
  const zero = await deviation(setup().deps, 0);
  assert.equal(zero.status, 200, JSON.stringify(zero.body));
  const aboveBound = await deviation(setup().deps, 61);
  assert.equal(aboveBound.status, 400);
});

function deviation(deps: CoverTestEndpointDeps, magnitude: number) {
  return handleCoverTestCaptureRequest(deps, {
    authHeader: AUTH,
    body: {
      patientReference: "Patient/p1",
      encounterReference: "Encounter/e1",
      rows: [{ slot: "near-sc", state: "deviation", deviationType: "phoria", direction: "exo", magnitude, laterality: "alternating", comitancy: "comitant" }],
    },
  });
}

function component(observation: Observation, name: string) {
  return observation.component?.find((row) => row.code.coding?.some((coding) => coding.code === name));
}
function value(observation: Observation, name: string) {
  return component(observation, name)?.valueString;
}
function quantity(observation: Observation, name: string) {
  return component(observation, name)?.valueQuantity?.value;
}
function code(observation: Observation, name: string) {
  return component(observation, name)?.valueCodeableConcept?.coding?.[0]?.code;
}

test("cover-test history hides voided rows and exposes each live row's Observation reference", async () => {
  const { fhir, deps } = setup();
  await handleCoverTestCaptureRequest(deps, { authHeader: AUTH, body: { patientReference: "Patient/p1", encounterReference: "Encounter/e1", rows: [{ slot: "distance-cc", state: "ortho" }] } });
  await handleCoverTestCaptureRequest(deps, { authHeader: AUTH, body: { patientReference: "Patient/p1", encounterReference: "Encounter/e1", rows: [{ slot: "near-cc", state: "ortho" }] } });
  const observations = fhir.resources.filter((row): row is Observation => row.resourceType === "Observation");
  assert.equal(observations.length, 2);
  observations[0]!.status = "entered-in-error";
  const history = await handleCoverTestHistoryRequest(deps, { authHeader: AUTH, query: { patient: "Patient/p1", encounter: "Encounter/e1" } });
  const rows = (history.body as { rows: Array<{ summary: string; observationReference?: string }> }).rows;
  assert.equal(rows.length, 1, "the voided row must not be listed");
  assert.equal(rows[0]?.observationReference, `Observation/${observations[1]!.id}`);
});
