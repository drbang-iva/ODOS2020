import assert from "node:assert/strict";
import { test } from "node:test";
import type { Bundle, Observation, Provenance } from "@medplum/fhirtypes";
import type { PracticeRoleId } from "../src/authz/roles.js";
import { handleEomCaptureRequest, handleEomHistoryRequest, type EomEndpointDeps } from "../src/clinical-graph/eom-endpoint.js";
import { buildFindingDefinitionSeeds } from "../src/clinical-graph/finding-definition-store.js";

const AUTH = "Bearer good";
class MemoryFhir {
  resources: Array<Observation | Provenance> = [];
  async create<T extends Observation | Provenance>(resource: T): Promise<T> { const saved = { ...resource, id: resource.id ?? `${resource.resourceType.toLowerCase()}-${this.resources.length + 1}` } as T; this.resources.push(saved); return saved; }
  async search<T extends Observation>(resourceType: T["resourceType"]): Promise<Bundle<T>> { return { resourceType: "Bundle", type: "searchset", entry: this.resources.filter((row) => row.resourceType === resourceType).map((resource) => ({ resource: resource as T })) }; }
}
function setup(role: PracticeRoleId = "clinician") { const fhir = new MemoryFhir(); const deps: EomEndpointDeps = { authenticate: async (header) => header === AUTH ? { staffReference: "Practitioner/doc", actorRole: role, fhir } : null, findingDefinitions: () => buildFindingDefinitionSeeds(), now: () => "2026-07-22T12:00:00.000Z" }; return { fhir, deps }; }
test("EOM normal and abnormal captures persist shared state, documentation, trigger components, and history", async () => {
  const { fhir, deps } = setup();
  const normal = await handleEomCaptureRequest(deps, { authHeader: AUTH, body: { patientReference: "Patient/p1", encounterReference: "Encounter/e1", state: "normal" } });
  assert.equal(normal.status, 200, JSON.stringify(normal.body));
  const normalObservation = fhir.resources.find((row): row is Observation => row.resourceType === "Observation")!;
  assert.equal(value(normalObservation, "NORMAL_TEMPLATE"), "Full OU — SAFE");
  assert.equal(code(normalObservation, "entrance.eom"), "normal");
  const abnormal = await handleEomCaptureRequest(deps, { authHeader: AUTH, body: { patientReference: "Patient/p1", encounterReference: "Encounter/e1", state: "abnormal", eyes: { OD: { primary: "-2" } }, nystagmus: { present: true, note: "gaze evoked" }, diplopia: { present: true, type: "binocular", direction: "horizontal", comitancy: "incomitant", worstGaze: "right", frequency: "intermittent", onset: "2026-07-20" } } });
  assert.equal(abnormal.status, 200, JSON.stringify(abnormal.body));
  const observation = fhir.resources.filter((row): row is Observation => row.resourceType === "Observation").at(-1)!;
  assert.equal(value(observation, "OD_CUSTOM_EOM_POS_PRIMARY"), "-2");
  assert.equal(boolean(observation, "binocular::yes"), true);
  assert.equal(boolean(observation, "incomitant::yes"), true);
  assert.equal(code(observation, "entrance.eom"), "abnormal");
  assert.equal(fhir.resources.filter((row) => row.resourceType === "Provenance").length, 2);
  const history = await handleEomHistoryRequest(deps, { authHeader: AUTH, query: { patient: "Patient/p1", encounter: "Encounter/e1" } });
  assert.equal(history.status, 200);
  assert.equal((history.body as { rows: unknown[] }).rows.length, 2);
});
test("EOM enforces auth, chart.write, and abnormal-detail boundaries", async () => {
  assert.equal((await handleEomCaptureRequest(setup().deps, { authHeader: undefined, body: {} })).status, 401);
  assert.equal((await handleEomCaptureRequest(setup("front-desk").deps, { authHeader: AUTH, body: {} })).status, 403);
  assert.equal((await handleEomCaptureRequest(setup().deps, { authHeader: AUTH, body: { patientReference: "Patient/p1", encounterReference: "Encounter/e1", state: "normal", diplopia: { present: false } } })).status, 400);
  assert.equal((await handleEomCaptureRequest(setup().deps, { authHeader: AUTH, body: { patientReference: "Patient/p1", encounterReference: "Encounter/e1", state: "abnormal", eyes: {}, nystagmus: { present: false }, diplopia: { present: false } } })).status, 400);
});
function component(observation: Observation, name: string) { return observation.component?.find((row) => row.code.coding?.some((coding) => coding.code === name)); }
function value(observation: Observation, name: string) { return component(observation, name)?.valueString; }
function boolean(observation: Observation, name: string) { return component(observation, name)?.valueBoolean; }
function code(observation: Observation, name: string) { return component(observation, name)?.valueCodeableConcept?.coding?.[0]?.code; }
