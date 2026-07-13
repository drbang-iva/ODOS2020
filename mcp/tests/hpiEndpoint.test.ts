import assert from "node:assert/strict";
import { test } from "node:test";
import type { Encounter, Observation, Provenance } from "@medplum/fhirtypes";
import type { PracticeRoleId } from "../src/authz/roles.js";
import { OSOD_OPHTHALMOLOGY_CODE_SYSTEM } from "../src/fhir/ophthalmology/codeBindings.js";
import { buildHpiFindingDefinition } from "../src/clinical-graph/hpi-definition.js";
import {
  handleHpiCaptureRequest,
  handleHpiDefinitionRequest,
  stampChiefComplaint,
  type HpiEndpointDeps,
} from "../src/clinical-graph/hpi-endpoint.js";

const AUTH = "Bearer good";
const ENCOUNTER: Encounter = {
  resourceType: "Encounter",
  id: "e1",
  status: "in-progress",
  class: { system: "http://terminology.hl7.org/CodeSystem/v3-ActCode", code: "AMB" },
  subject: { reference: "Patient/p1" },
  reasonCode: [
    { coding: [{ system: "https://example.test/local", code: "existing" }], text: "Existing coded reason" },
    { text: "Prior chief complaint" },
  ],
};
const BODY = {
  patientReference: "Patient/p1",
  encounterReference: "Encounter/e1",
  chiefComplaint: "Blurred vision at near",
  hpi: {
    location: "Both eyes",
    quality: "Intermittent blur",
    severity: "Moderate",
    duration: "Three months",
    timing: "Late afternoon",
    context: "Reading",
    modifyingFactors: "Improves with breaks",
    associatedSignsSymptoms: "Eyestrain",
  },
  reviewOfSystems: [
    { code: "vision-changes", display: "Vision changes", category: "eye", status: "positive" },
    { code: "diabetes", display: "Diabetes", category: "general", status: "positive" },
    { code: "migraine", display: "Migraine", category: "general", status: "negative" },
  ],
};

function fixture(role: PracticeRoleId = "clinician") {
  const created: Array<{ resource: Observation | Provenance; headers?: Record<string, string> }> = [];
  const updated: Encounter[] = [];
  const definition = buildHpiFindingDefinition({
    source: "manual",
    recordedAt: "1970-01-01T00:00:00.000Z",
    actorReference: "Practitioner/osod-system",
  });
  const deps: HpiEndpointDeps = {
    authenticate: async (header) => header === AUTH ? {
      staffReference: "Practitioner/doc1",
      actorRole: role,
      fhir: {
        read: async <T extends Encounter>(): Promise<T> => structuredClone(ENCOUNTER) as T,
        create: async <T extends Observation | Provenance>(
          resource: T,
          headers?: Record<string, string>,
        ): Promise<T> => {
          created.push({ resource, headers });
          return { ...resource, id: `${resource.resourceType.toLowerCase()}-${created.length}` };
        },
        update: async <T extends Encounter>(
          _resourceType: T["resourceType"],
          _id: string,
          resource: T,
          headers?: Record<string, string>,
        ): Promise<T> => {
          assert.equal(headers?.["X-OSOD-Source"], "mcp/save_hpi_ros");
          updated.push(resource);
          return resource;
        },
      },
    } : null,
    findingDefinitions: () => [definition],
    now: () => "2026-07-13T20:00:00.000Z",
  };
  return { created, updated, deps };
}

test("HPI capture persists OSOD-local finding evidence and stamps a text-only encounter reason", async () => {
  const { created, updated, deps } = fixture();
  const result = await handleHpiCaptureRequest(deps, { authHeader: AUTH, body: BODY });

  assert.equal(result.status, 200);
  assert.deepEqual(created.map((entry) => entry.resource.resourceType), ["Observation", "Provenance"]);
  assert.equal(created.every((entry) => entry.headers?.["X-OSOD-Source"] === "mcp/save_hpi_ros"), true);
  const observation = created[0]!.resource as Observation;
  assert.equal(observation.code.coding?.[0]?.system, OSOD_OPHTHALMOLOGY_CODE_SYSTEM);
  assert.equal(observation.code.coding?.[0]?.code, "hpi_ros");
  assert.equal(observation.subject?.reference, BODY.patientReference);
  assert.equal(observation.encounter?.reference, BODY.encounterReference);
  assert.equal(componentValue(observation, "CHIEF_COMPLAINT"), BODY.chiefComplaint);
  assert.equal(componentValue(observation, "HPI_ASSOCIATED_SIGNS_SYMPTOMS"), "Eyestrain");
  assert.equal(componentValue(observation, "ROS_VISION_CHANGES"), "positive");
  assert.equal(componentValue(observation, "ROS_MIGRAINE"), "negative");

  assert.equal(updated.length, 1);
  assert.deepEqual(updated[0]!.reasonCode, [
    ENCOUNTER.reasonCode![0],
    { text: BODY.chiefComplaint },
  ]);
  const provenance = created[1]!.resource as Provenance;
  assert.deepEqual(provenance.target.map((target) => target.reference), [
    "Observation/observation-1",
    BODY.encounterReference,
    BODY.patientReference,
  ]);
  assert.match(provenance.activity?.text ?? "", /chief complaint, HPI, and review of systems/i);
});

test("HPI definition exposes eight elements, default ROS flags, extensibility, and the Mandate-14 boundary", async () => {
  const { deps } = fixture();
  const result = await handleHpiDefinitionRequest(deps, { authHeader: AUTH });
  assert.equal(result.status, 200);
  const definition = (result.body as {
    definition: {
      fields: Record<string, { allowCreate?: boolean; options?: Array<{ code: string }> }>;
      terminologyStatus: { status: string; note: string };
    };
  }).definition;
  assert.deepEqual(
    ["location", "quality", "severity", "duration", "timing", "context", "modifyingFactors", "associatedSignsSymptoms"]
      .filter((key) => key in definition.fields),
    ["location", "quality", "severity", "duration", "timing", "context", "modifyingFactors", "associatedSignsSymptoms"],
  );
  assert.equal(definition.fields.reviewOfSystems?.allowCreate, true);
  assert.deepEqual(definition.fields.reviewOfSystems?.options?.slice(-2).map((option) => option.code), ["diabetes", "hypertension"]);
  assert.equal(definition.terminologyStatus.status, "MANDATE-14-DEFERRED");
  assert.match(definition.terminologyStatus.note, /OSOD-local coding only/);
});

test("HPI capture enforces authority and permits only general-medical custom flags", async () => {
  assert.equal((await handleHpiCaptureRequest(fixture().deps, { authHeader: undefined, body: BODY })).status, 401);
  assert.equal((await handleHpiCaptureRequest(fixture("front-desk").deps, { authHeader: AUTH, body: BODY })).status, 403);
  const customEye = await handleHpiCaptureRequest(fixture().deps, {
    authHeader: AUTH,
    body: {
      ...BODY,
      reviewOfSystems: [{ code: "photophobia", display: "Photophobia", category: "eye", status: "positive" }],
    },
  });
  assert.equal(customEye.status, 400);
  assert.match((customEye.body as { error: string }).error, /general-medical/);
});

test("chief-complaint stamping appends a text-only reason when the encounter has only coded reasons", () => {
  const stamped = stampChiefComplaint({ ...ENCOUNTER, reasonCode: [ENCOUNTER.reasonCode![0]!] }, "Annual diabetic eye exam");
  assert.deepEqual(stamped.reasonCode, [ENCOUNTER.reasonCode![0], { text: "Annual diabetic eye exam" }]);
});

function componentValue(observation: Observation, code: string): string | undefined {
  return observation.component?.find((component) => component.code.coding?.[0]?.code === code)?.valueString;
}
