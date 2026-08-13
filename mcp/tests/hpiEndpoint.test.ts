import assert from "node:assert/strict";
import { test } from "node:test";
import type { Basic, Bundle, Encounter, Observation, Provenance } from "@medplum/fhirtypes";
import type { PracticeRoleId } from "../src/authz/roles.js";
import { ODOS_OPHTHALMOLOGY_CODE_SYSTEM } from "../src/fhir/ophthalmology/codeBindings.js";
import { buildEncounterComplaintResource } from "../src/clinical-graph/encounter-complaint-store.js";
import { buildHpiFindingDefinition } from "../src/clinical-graph/hpi-definition.js";
import {
  handleHpiCaptureRequest,
  handleHpiDefinitionRequest,
  type HpiEndpointDeps,
} from "../src/clinical-graph/hpi-endpoint.js";

const AUTH = "Bearer good";
const ENCOUNTER: Encounter = {
  resourceType: "Encounter",
  id: "e1",
  status: "in-progress",
  class: { system: "http://terminology.hl7.org/CodeSystem/v3-ActCode", code: "AMB" },
  subject: { reference: "Patient/p1" },
};

const PROVENANCE = {
  source: "manual" as const,
  recordedAt: "2026-07-21T12:00:00.000Z",
  actorReference: "Practitioner/doc1",
};

const COMPLAINTS = [
  {
    id: "c1",
    encounterId: "e1",
    patientId: "p1",
    ordinal: 1,
    complaintKey: "dry-eye",
    conditions: ["dry-eyes"],
    eyeLocation: "OU" as const,
    eyeComparison: "right-worse" as const,
    qualities: ["constant", "environmentally-sensitive", "brought-on-by-drafts-or-fans"],
    duration: { value: 3, unit: "months" as const },
    treatmentsTried: ["artificial-tears", "warm-compresses"],
    additionalHistory: "worse at end of workday",
    narrative: { mode: "automated" as const },
    resolvedDx: [],
    status: "active" as const,
    provenance: PROVENANCE,
    provenanceHistory: [PROVENANCE],
  },
  {
    id: "c2",
    encounterId: "e1",
    patientId: "p1",
    ordinal: 2,
    freeTextLabel: "Headache",
    conditions: [],
    eyeLocation: "not-applicable" as const,
    qualities: [],
    treatmentsTried: ["no-treatment"],
    additionalHistory: "",
    narrative: { mode: "automated" as const },
    resolvedDx: [],
    status: "active" as const,
    provenance: PROVENANCE,
    provenanceHistory: [PROVENANCE],
  },
];

const BODY = {
  patientReference: "Patient/p1",
  encounterReference: "Encounter/e1",
  reviewOfSystems: [
    { code: "vision-changes", display: "Vision changes", category: "eye", status: "positive" },
    { code: "diabetes", display: "Diabetes", category: "general", status: "negative" },
  ],
  reviewAttestations: ["general"],
};

function fixture(role: PracticeRoleId = "provider", withComplaints = true) {
  const basics = withComplaints
    ? COMPLAINTS.map((complaint, index) => ({ ...buildEncounterComplaintResource(complaint), id: `basic-${index + 1}` }))
    : [];
  const created: Array<{ resource: Observation | Provenance; headers?: Record<string, string> }> = [];
  const definition = buildHpiFindingDefinition({
    source: "manual",
    recordedAt: "1970-01-01T00:00:00.000Z",
    actorReference: "Practitioner/odos-system",
  });
  const deps: HpiEndpointDeps = {
    authenticate: async (header) => header === AUTH ? {
      staffReference: "Practitioner/doc1",
      actorRole: role,
      fhir: {
        read: async <T extends Encounter>(): Promise<T> => structuredClone(ENCOUNTER) as T,
        search: async <T extends Basic>(_resourceType: T["resourceType"], params: Record<string, string> = {}): Promise<Bundle<T>> => {
          const filtered = basics.filter((resource) => {
            if (!params.code) return true;
            const [system, code] = params.code.split("|");
            return resource.code?.coding?.some((coding) => coding.system === system && coding.code === code);
          });
          return { resourceType: "Bundle", type: "searchset", entry: filtered.map((resource) => ({ resource: structuredClone(resource) as T })) };
        },
        create: async <T extends Basic | Observation | Provenance>(resource: T, headers?: Record<string, string>): Promise<T> => {
          if (resource.resourceType !== "Basic") created.push({ resource, headers });
          return { ...resource, id: `${resource.resourceType.toLowerCase()}-${created.length}` };
        },
        update: async <T extends Basic | Encounter>(_resourceType: T["resourceType"], _id: string, resource: T): Promise<T> => resource,
      },
    } : null,
    findingDefinitions: () => [definition],
    now: () => "2026-07-21T12:30:00.000Z",
  };
  return { created, deps };
}

test("history capture persists ordinal complaint narratives and explicitly reviewed ROS in one Observation", async () => {
  const { created, deps } = fixture();
  const result = await handleHpiCaptureRequest(deps, { authHeader: AUTH, body: BODY });
  assert.equal(result.status, 200);
  assert.deepEqual(created.map((entry) => entry.resource.resourceType), ["Observation", "Provenance"]);
  assert.equal(created.every((entry) => entry.headers?.["X-ODOS-Source"] === "mcp/save_hpi_ros"), true);
  const observation = created[0]!.resource as Observation;
  assert.equal(observation.code.coding?.[0]?.system, ODOS_OPHTHALMOLOGY_CODE_SYSTEM);
  assert.equal(observation.code.coding?.[0]?.code, "hpi_ros");
  assert.match(componentValue(observation, "HISTORY_COMPLAINT_1") ?? "", /Patient reports dry eyes/);
  assert.match(componentValue(observation, "HISTORY_COMPLAINT_2") ?? "", /Patient reports Headache/);
  assert.equal(componentValue(observation, "ROS_VISION_CHANGES"), "positive");
  const provenance = created[1]!.resource as Provenance;
  assert.match(provenance.activity?.text ?? "", /presenting complaints, history narrative/i);
  assert.match(provenance.activity?.text ?? "", /general remaining items reviewed negative/);
  assert.deepEqual((result.body as { narratives: string[] }).narratives.length, 2);
});

test("HPI definition retires the eight-textarea fields and retains extensible Review of Systems", async () => {
  const { deps } = fixture();
  const result = await handleHpiDefinitionRequest(deps, { authHeader: AUTH });
  assert.equal(result.status, 200);
  const definition = (result.body as { definition: { fields: Record<string, unknown>; terminologyStatus: { status: string } } }).definition;
  assert.deepEqual(Object.keys(definition.fields), ["reviewOfSystems"]);
  assert.equal((definition.fields.reviewOfSystems as { allowCreate?: boolean }).allowCreate, true);
  assert.equal(definition.terminologyStatus.status, "MANDATE-14-DEFERRED");
});

test("history capture enforces authority, option validation, encounter scope, and an active complaint", async () => {
  assert.equal((await handleHpiCaptureRequest(fixture().deps, { authHeader: undefined, body: BODY })).status, 401);
  assert.equal((await handleHpiCaptureRequest(fixture("admin").deps, { authHeader: AUTH, body: BODY })).status, 403);
  const unknown = await handleHpiCaptureRequest(fixture().deps, {
    authHeader: AUTH,
    body: { ...BODY, reviewOfSystems: [{ code: "invented", display: "Invented", category: "general", status: "positive" }] },
  });
  assert.equal(unknown.status, 400);
  assert.match((unknown.body as { error: string }).error, /unknown or inactive/);
  const encounterOnlyCustom = await handleHpiCaptureRequest(fixture().deps, {
    authHeader: AUTH,
    body: { ...BODY, reviewOfSystems: [{ code: "custom-migraine", display: "Migraine", category: "general", status: "positive" }] },
  });
  assert.equal(encounterOnlyCustom.status, 200);
  const noComplaint = await handleHpiCaptureRequest(fixture("provider", false).deps, { authHeader: AUTH, body: BODY });
  assert.equal(noComplaint.status, 400);
  assert.match((noComplaint.body as { error: string }).error, /presenting complaint/);
});

function componentValue(observation: Observation, code: string): string | undefined {
  return observation.component?.find((component) => component.code.coding?.[0]?.code === code)?.valueString;
}
