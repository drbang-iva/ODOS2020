import assert from "node:assert/strict";
import { test } from "node:test";
import type { Bundle, MedicationAdministration, Observation, Provenance } from "@medplum/fhirtypes";
import type { PracticeRoleId } from "../src/authz/roles.js";
import {
  handleDilationCaptureRequest,
  handleDilationHistoryRequest,
  type DilationEndpointDeps,
} from "../src/clinical-graph/dilation-endpoint.js";
import { buildFindingDefinitionSeeds } from "../src/clinical-graph/finding-definition-store.js";

const AUTH = "Bearer good";

class MemoryFhir {
  resources: Array<MedicationAdministration | Observation | Provenance> = [];
  writes: Array<{ type: string; source?: string }> = [];

  async create<T extends MedicationAdministration | Observation | Provenance>(resource: T, headers?: Record<string, string>): Promise<T> {
    const saved = { ...resource, id: resource.id ?? `${resource.resourceType.toLowerCase()}-${this.resources.length + 1}` } as T;
    this.resources.push(saved);
    this.writes.push({ type: saved.resourceType, source: headers?.["X-ODOS-Source"] });
    return saved;
  }

  async search<T extends MedicationAdministration | Observation>(resourceType: T["resourceType"]): Promise<Bundle<T>> {
    return {
      resourceType: "Bundle",
      type: "searchset",
      entry: this.resources.filter((resource) => resource.resourceType === resourceType).map((resource) => ({ resource: resource as T })),
    };
  }

  async read<T extends MedicationAdministration>(resourceType: T["resourceType"], id: string): Promise<T> {
    const resource = this.resources.find((candidate) => candidate.resourceType === resourceType && candidate.id === id);
    if (!resource) throw new Error(`${resourceType}/${id} not found`);
    return resource as T;
  }
}

function deps(role: PracticeRoleId = "clinician") {
  const fhir = new MemoryFhir();
  const value: DilationEndpointDeps = {
    authenticate: async (authHeader) => authHeader === AUTH
      ? { staffReference: "Practitioner/doc-1", actorRole: role, fhir }
      : null,
    findingDefinitions: () => buildFindingDefinitionSeeds(),
    now: () => "2026-07-22T14:00:00.000Z",
  };
  return { fhir, deps: value };
}

test("Dilation persists one MedicationAdministration per agent plus DFE Observation and Provenance", async () => {
  const { fhir, deps: d } = deps();
  const result = await handleDilationCaptureRequest(d, {
    authHeader: AUTH,
    body: {
      patientReference: "Patient/p1",
      encounterReference: "Encounter/e1",
      agents: [
        { agent: "tropicamide-1", drops: 1, eyes: "OU", time: "2026-07-22T13:55:00.000Z" },
        { agent: "phenylephrine-2-5", drops: 1, eyes: "OU", time: "2026-07-22T13:56:00.000Z" },
      ],
      dfePerformed: true,
    },
  });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.deepEqual(fhir.resources.map((resource) => resource.resourceType), [
    "MedicationAdministration", "Provenance",
    "MedicationAdministration", "Provenance",
    "Observation", "Provenance",
  ]);
  assert.equal(fhir.writes.every((write) => write.source === "mcp/save_section_observations"), true);
  const administrations = fhir.resources.filter((resource): resource is MedicationAdministration => resource.resourceType === "MedicationAdministration");
  assert.equal(administrations[0]?.medicationCodeableConcept?.coding?.[0]?.code, "tropicamide-1");
  assert.equal(administrations[0]?.dosage?.dose?.value, 1);
  assert.equal(administrations[0]?.dosage?.site?.coding?.[0]?.code, "OU");
  assert.equal(administrations[0]?.performer?.[0]?.actor.reference, "Practitioner/doc-1");
  const observation = fhir.resources.find((resource): resource is Observation => resource.resourceType === "Observation");
  assert.equal(componentValue(observation, "DFE_PERFORMED"), true);
  assert.equal(componentCode(observation, "entrance.dilation.dfe"), "normal");
  assert.deepEqual(observation?.partOf?.map((source) => source.reference), [
    "MedicationAdministration/medicationadministration-1",
    "MedicationAdministration/medicationadministration-3",
  ]);
  assert.equal(observation?.note?.[0]?.text, "Dilated fundus examination performed.");
});

test("declined dilation creates no administration and returns its medicolegal note through history", async () => {
  const { fhir, deps: d } = deps();
  const result = await handleDilationCaptureRequest(d, {
    authHeader: AUTH,
    body: {
      patientReference: "Patient/p2",
      encounterReference: "Encounter/e2",
      agents: [],
      dfePerformed: false,
      declined: { reason: "Driving after visit.", counseledRisksNote: "Reviewed risk of missed retinal disease." },
    },
  });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(fhir.resources.some((resource) => resource.resourceType === "MedicationAdministration"), false);
  const observation = fhir.resources.find((resource): resource is Observation => resource.resourceType === "Observation");
  assert.equal(componentCode(observation, "entrance.dilation.dfe"), "deferred");
  assert.match(observation?.note?.[0]?.text ?? "", /Dilation declined: Driving after visit\./);
  assert.match(observation?.note?.[0]?.text ?? "", /Counseled risks: Reviewed risk/);

  const history = await handleDilationHistoryRequest(d, {
    authHeader: AUTH,
    query: { patient: "Patient/p2", encounter: "Encounter/e2" },
  });
  assert.equal(history.status, 200);
  assert.match((history.body as { notes: Array<{ text: string }> }).notes[0]?.text ?? "", /Driving after visit/);
});

test("Dilation enforces authentication, chart permissions, catalog agents, and declined exclusivity", async () => {
  assert.equal((await handleDilationCaptureRequest(deps().deps, { authHeader: undefined, body: {} })).status, 401);
  assert.equal((await handleDilationCaptureRequest(deps("front-desk").deps, { authHeader: AUTH, body: {} })).status, 403);
  const invalid = await handleDilationCaptureRequest(deps().deps, {
    authHeader: AUTH,
    body: {
      patientReference: "Patient/p3",
      encounterReference: "Encounter/e3",
      agents: [{ agent: "unknown", drops: 1, eyes: "OU", time: "2026-07-22T13:55:00.000Z" }],
      dfePerformed: true,
    },
  });
  assert.equal(invalid.status, 400);
  assert.match(String((invalid.body as { error: string }).error), /Unknown dilation agent/);
  const mixed = await handleDilationCaptureRequest(deps().deps, {
    authHeader: AUTH,
    body: {
      patientReference: "Patient/p3",
      encounterReference: "Encounter/e3",
      agents: [],
      dfePerformed: true,
      declined: { reason: "No", counseledRisksNote: "Counseled" },
    },
  });
  assert.equal(mixed.status, 400);
});

function componentValue(observation: Observation | undefined, code: string) {
  return observation?.component?.find((component) => component.code.coding?.some((coding) => coding.code === code))?.valueBoolean;
}

function componentCode(observation: Observation | undefined, code: string) {
  return observation?.component?.find((component) => component.code.coding?.some((coding) => coding.code === code))?.valueCodeableConcept?.coding?.[0]?.code;
}
