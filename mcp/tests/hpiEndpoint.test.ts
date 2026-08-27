import assert from "node:assert/strict";
import { test } from "node:test";
import type { Basic, Bundle, Encounter, Observation, Provenance, Resource } from "@medplum/fhirtypes";
import type { PracticeRoleId } from "../src/authz/roles.js";
import { ODOS_OPHTHALMOLOGY_CODE_SYSTEM } from "../src/fhir/ophthalmology/codeBindings.js";
import { buildEncounterComplaintResource } from "../src/clinical-graph/encounter-complaint-store.js";
import { buildHpiFindingDefinition } from "../src/clinical-graph/hpi-definition.js";
import {
  HPI_OBSERVATION_IDENTIFIER_SYSTEM,
  handleHpiCaptureRequest,
  handleHpiDefinitionRequest,
  type HpiEndpointDeps,
} from "../src/clinical-graph/hpi-endpoint.js";
import { buildExamOverviewProjection } from "../src/clinical-graph/exam-overview-projection.js";

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
  const observations: Observation[] = [];
  const transactions: Array<{ bundle: Bundle; headers?: Record<string, string> }> = [];
  let beforeTransaction: (() => void) | undefined;
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
        search: async <T extends Resource>(resourceType: T["resourceType"], params: Record<string, string> = {}): Promise<Bundle<T>> => {
          if (resourceType === "Observation") {
            return {
              resourceType: "Bundle",
              type: "searchset",
              entry: observations.filter((observation) =>
                (!params.encounter || observation.encounter?.reference === params.encounter) &&
                (!params.code || observation.code.coding?.some((coding) => `${coding.system}|${coding.code}` === params.code))
              ).map((resource) => ({ resource: structuredClone(resource) as T })),
            };
          }
          const filtered = basics.filter((resource) => {
            if (!params.code) return true;
            const [system, code] = params.code.split("|");
            return resource.code?.coding?.some((coding) => coding.system === system && coding.code === code);
          });
          return { resourceType: "Bundle", type: "searchset", entry: filtered.map((resource) => ({ resource: structuredClone(resource) as T })) };
        },
        create: async <T extends Basic | Observation | Provenance>(resource: T, headers?: Record<string, string>): Promise<T> => {
          if (resource.resourceType !== "Basic") created.push({ resource, headers });
          const persisted = { ...resource, id: `${resource.resourceType.toLowerCase()}-${created.length}` } as T;
          if (persisted.resourceType === "Observation") observations.push(structuredClone(persisted));
          return persisted;
        },
        update: async <T extends Basic | Encounter>(_resourceType: T["resourceType"], _id: string, resource: T): Promise<T> => resource,
        executeTransaction: async (bundle: Bundle, headers?: Record<string, string>): Promise<Bundle> => {
          beforeTransaction?.();
          beforeTransaction = undefined;
          transactions.push({ bundle: structuredClone(bundle), headers });
          const responseEntries: NonNullable<Bundle["entry"]> = [];
          for (const entry of bundle.entry ?? []) {
            const resource = structuredClone(entry.resource);
            if (resource?.resourceType === "Observation") {
              const identifier = resource.identifier?.[0];
              const conditionalRequest = entry.request?.method === "POST" && entry.request.ifNoneExist ||
                entry.request?.method === "PUT" && entry.request.url?.startsWith("Observation?identifier=");
              const conditionalMatch = conditionalRequest
                ? observations.find((candidate) => candidate.identifier?.some((row) =>
                    row.system === identifier?.system && row.value === identifier?.value
                  ))
                : undefined;
              const id = conditionalMatch?.id ?? resource.id ?? `observation-${observations.length + 1}`;
              const persisted = conditionalMatch && entry.request?.method === "POST"
                ? conditionalMatch
                : { ...resource, id };
              const index = observations.findIndex((candidate) => candidate.id === id);
              if (index >= 0) observations[index] = persisted;
              else observations.push(persisted);
              responseEntries.push({ response: {
                status: conditionalMatch ? "200 OK" : index >= 0 ? "200 OK" : "201 Created",
                location: `Observation/${id}/_history/1`,
              } });
              continue;
            }
            if (resource?.resourceType === "Provenance") {
              const id = `provenance-${created.length + responseEntries.length + 1}`;
              created.push({ resource });
              responseEntries.push({ response: { status: "201 Created", location: `Provenance/${id}/_history/1` } });
            }
          }
          return { resourceType: "Bundle", type: "transaction-response", entry: responseEntries };
        },
      },
    } : null,
    findingDefinitions: () => [definition],
    now: () => "2026-07-21T12:30:00.000Z",
  };
  return {
    basics,
    created,
    deps,
    observations,
    transactions,
    beforeNextTransaction(callback: () => void) { beforeTransaction = callback; },
  };
}

test("history capture persists ordinal complaint narratives and explicitly reviewed ROS in one Observation", async () => {
  const setup = fixture();
  const captured = await handleHpiCaptureRequest(setup.deps, { authHeader: AUTH, body: BODY });
  assert.equal(captured.status, 200);
  assert.equal(setup.transactions.length, 1);
  assert.equal(setup.transactions[0]?.headers?.["X-ODOS-Source"], "mcp/save_hpi_ros");
  assert.equal(setup.transactions[0]?.headers?.Prefer, "return=representation");
  assert.deepEqual(setup.transactions[0]?.bundle.entry?.map((entry) => entry.resource?.resourceType), ["Observation", "Provenance"]);
  const observation = setup.observations[0]!;
  assert.equal(observation.code.coding?.[0]?.system, ODOS_OPHTHALMOLOGY_CODE_SYSTEM);
  assert.equal(observation.code.coding?.[0]?.code, "hpi_ros");
  assert.match(componentValue(observation, "HISTORY_COMPLAINT_1") ?? "", /Patient reports dry eyes/);
  assert.match(componentValue(observation, "HISTORY_COMPLAINT_2") ?? "", /Patient reports Headache/);
  assert.equal(componentValue(observation, "ROS_VISION_CHANGES"), "positive");
  const provenance = setup.created[0]!.resource as Provenance;
  assert.match(provenance.activity?.text ?? "", /presenting complaints, history narrative/i);
  assert.match(provenance.activity?.text ?? "", /general remaining items reviewed negative/);
  assert.deepEqual((captured.body as { narratives: string[] }).narratives.length, 2);
});

test("saving two complaints refreshes exactly one live hpi_ros Observation for the encounter", async () => {
  const setup = fixture();
  setup.basics.splice(1);

  assert.equal((await handleHpiCaptureRequest(setup.deps, { authHeader: AUTH, body: BODY })).status, 200);
  setup.basics.push({ ...buildEncounterComplaintResource(COMPLAINTS[1]!), id: "basic-2" });
  assert.equal((await handleHpiCaptureRequest(setup.deps, { authHeader: AUTH, body: BODY })).status, 200);

  const liveHistory = setup.observations.filter((observation) =>
    observation.status !== "entered-in-error" &&
    observation.encounter?.reference === "Encounter/e1" &&
    observation.code.coding?.some((coding) => coding.code === "hpi_ros")
  );
  assert.equal(liveHistory.length, 1);
  assert.match(componentValue(liveHistory[0]!, "HISTORY_COMPLAINT_2") ?? "", /Headache/);
});

test("a capture retires pre-existing extra live History findings in the same transaction", async () => {
  const setup = fixture();
  assert.equal((await handleHpiCaptureRequest(setup.deps, { authHeader: AUTH, body: BODY })).status, 200);
  setup.observations.push({
    ...structuredClone(setup.observations[0]!),
    id: "legacy-history-duplicate",
    identifier: undefined,
    effectiveDateTime: "2026-07-21T11:00:00.000Z",
  });

  assert.equal((await handleHpiCaptureRequest(setup.deps, { authHeader: AUTH, body: BODY })).status, 200);
  assert.equal(setup.observations.filter((observation) => observation.status !== "entered-in-error").length, 1);
  assert.equal(setup.observations.find((observation) => observation.id === "legacy-history-duplicate")?.status, "entered-in-error");
  assert.deepEqual(setup.transactions.at(-1)?.bundle.entry?.map((entry) => ({
    type: entry.resource?.resourceType,
    method: entry.request?.method,
  })), [
    { type: "Observation", method: "PUT" },
    { type: "Provenance", method: "POST" },
    { type: "Observation", method: "PUT" },
  ]);
});

test("a concurrent first capture cannot make a successful request lose its History content", async () => {
  const setup = fixture();
  setup.beforeNextTransaction(() => setup.observations.push({
    resourceType: "Observation",
    id: "concurrent-history",
    status: "final",
    code: { coding: [{ system: ODOS_OPHTHALMOLOGY_CODE_SYSTEM, code: "hpi_ros", display: "History" }] },
    subject: { reference: "Patient/p1" },
    encounter: { reference: "Encounter/e1" },
    effectiveDateTime: "2026-07-21T12:29:00.000Z",
    identifier: [{ system: HPI_OBSERVATION_IDENTIFIER_SYSTEM, value: "e1" }],
    component: [{ code: { coding: [{ code: "HISTORY_COMPLAINT_1" }] }, valueString: "Concurrent stale content" }],
  }));

  assert.equal((await handleHpiCaptureRequest(setup.deps, { authHeader: AUTH, body: BODY })).status, 200);
  assert.equal(setup.observations.length, 1);
  assert.equal(setup.observations[0]?.id, "concurrent-history");
  assert.match(componentValue(setup.observations[0]!, "HISTORY_COMPLAINT_1") ?? "", /Patient reports dry eyes/);
  assert.deepEqual(setup.transactions[0]?.bundle.entry?.[0]?.request, {
    method: "PUT",
    url: `Observation?identifier=${HPI_OBSERVATION_IDENTIFIER_SYSTEM}|e1`,
  });
});

test("a complaint-backed hpi_ros capture makes the exam overview report History as charted", async () => {
  const setup = fixture();
  const result = await handleHpiCaptureRequest(setup.deps, { authHeader: AUTH, body: {
    ...BODY,
    reviewOfSystems: [],
    reviewAttestations: [],
  } });
  assert.equal(result.status, 200);

  const projection = buildExamOverviewProjection({
    encounterReference: "Encounter/e1",
    patientReference: "Patient/p1",
    visitTypeCategoryId: "comprehensive",
    definitions: [buildHpiFindingDefinition({
      source: "manual",
      recordedAt: "1970-01-01T00:00:00.000Z",
      actorReference: "Practitioner/odos-system",
    })],
    currentObservations: setup.observations,
    priorObservationCandidates: [],
    assessmentRows: [],
  });
  assert.equal(projection.sections.find((section) => section.sectionKey === "history")?.state, "examined");
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
