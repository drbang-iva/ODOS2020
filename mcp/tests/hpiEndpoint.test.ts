import assert from "node:assert/strict";
import { test } from "node:test";
import type { Basic, Bundle, Encounter, Observation, Provenance, Resource, ServiceRequest } from "@medplum/fhirtypes";
import type { PracticeRoleId } from "../src/authz/roles.js";
import { ODOS_OPHTHALMOLOGY_CODE_SYSTEM } from "../src/fhir/ophthalmology/codeBindings.js";
import { buildEncounterComplaintResource } from "../src/clinical-graph/encounter-complaint-store.js";
import { buildHpiFindingDefinition } from "../src/clinical-graph/hpi-definition.js";
import {
  HISTORY_REVIEW_ATTESTATION_CODE,
  buildHistoryAnswerObservation,
  buildHistoryReviewAttestation,
  parseHistoryAnswerObservation,
} from "../src/clinical-graph/history-answer-observation.js";
import {
  HPI_OBSERVATION_IDENTIFIER_SYSTEM,
  deriveFollowUpAnswerPrefills,
  deriveLastPlanPrefills,
  handleHpiCaptureRequest,
  handleHpiDefinitionRequest,
  handleHpiRecordRequest,
  handleHistoryReviewRequest,
  type HpiEndpointDeps,
} from "../src/clinical-graph/hpi-endpoint.js";
import { HISTORY_OPTION_CATALOGS } from "../src/clinical-graph/history-template-engine.js";
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
  assert.equal(componentBoolean(observation, "ROS_ATTESTED_GENERAL"), true);
  const provenance = setup.created[0]!.resource as Provenance;
  assert.match(provenance.activity?.text ?? "", /presenting complaints, history narrative/i);
  assert.match(provenance.activity?.text ?? "", /general remaining items reviewed negative/);
  assert.deepEqual((captured.body as { narratives: string[] }).narratives.length, 2);
});

test("saving two complaints refreshes exactly one live hpi_ros Observation for the encounter", async () => {
  const setup = fixture();
  setup.basics.splice(1);

  assert.equal((await handleHpiCaptureRequest(setup.deps, { authHeader: AUTH, body: BODY })).status, 200);
  const firstHistoryId = setup.observations.find((observation) =>
    observation.status !== "entered-in-error" && observation.code.coding?.some((coding) => coding.code === "hpi_ros")
  )?.id;
  assert.ok(firstHistoryId);
  setup.basics.push({ ...buildEncounterComplaintResource(COMPLAINTS[1]!), id: "basic-2" });
  assert.equal((await handleHpiCaptureRequest(setup.deps, { authHeader: AUTH, body: BODY })).status, 200);

  const liveHistory = setup.observations.filter((observation) =>
    observation.status !== "entered-in-error" &&
    observation.encounter?.reference === "Encounter/e1" &&
    observation.code.coding?.some((coding) => coding.code === "hpi_ros")
  );
  assert.equal(liveHistory.length, 1);
  assert.equal(liveHistory[0]?.id, firstHistoryId, "subsequent complaint saves update the same hpi_ros identity");
  assert.match(componentValue(liveHistory[0]!, "HISTORY_COMPLAINT_2") ?? "", /Headache/);
});

test("template autosave preserves review-of-systems components owned outside this slice", async () => {
  const setup = fixture();
  assert.equal((await handleHpiCaptureRequest(setup.deps, { authHeader: AUTH, body: BODY })).status, 200);
  assert.equal((await handleHpiCaptureRequest(setup.deps, {
    authHeader: AUTH,
    body: {
      patientReference: BODY.patientReference,
      encounterReference: BODY.encounterReference,
      templateAnswers: [],
    },
  })).status, 200);

  const liveHistory = setup.observations.find((observation) =>
    observation.status !== "entered-in-error" && observation.code.coding?.some((coding) => coding.code === "hpi_ros")
  );
  assert.equal(componentValue(liveHistory!, "ROS_VISION_CHANGES"), "positive");
  assert.equal(componentValue(liveHistory!, "ROS_DIABETES"), "negative");
  assert.equal(componentBoolean(liveHistory!, "ROS_ATTESTED_GENERAL"), true);
});

test("template answers update in place while hpi_ros stays one Observation per encounter", async () => {
  const setup = fixture();
  const glaucomaComplaint = {
    ...COMPLAINTS[0]!,
    complaintKey: "glaucoma",
    conditions: [],
    qualities: [],
    treatmentsTried: [],
    additionalHistory: "",
  };
  setup.basics.splice(0, setup.basics.length, { ...buildEncounterComplaintResource(glaucomaComplaint), id: "basic-1" });
  const templateAnswers = [
    { id: "answer-presentation", complaintId: "c1", templateKey: "glaucoma", sectionId: "presentation", value: { kind: "selection", code: "follow-up" } },
    { id: "answer-pain", complaintId: "c1", templateKey: "glaucoma", sectionId: "symptoms", optionCode: "ocular-pain", value: { kind: "tri-state", status: "negative" } },
  ];

  const first = await handleHpiCaptureRequest(setup.deps, {
    authHeader: AUTH,
    body: { ...BODY, templateAnswers },
  });
  assert.equal(first.status, 200);
  assert.match(componentValue(setup.observations.find((row) => row.code.coding?.some((coding) => coding.code === "hpi_ros"))!, "HISTORY_COMPLAINT_1") ?? "", /Denies ocular pain/);
  assert.equal((first.body as { answers: Array<{ observationReference: string }> }).answers[1]?.observationReference, "Observation/observation-3");

  const second = await handleHpiCaptureRequest(setup.deps, {
    authHeader: AUTH,
    body: {
      ...BODY,
      templateAnswers: templateAnswers.map((answer) => answer.id === "answer-pain"
        ? { ...answer, value: { kind: "tri-state", status: "positive" } }
        : answer),
    },
  });
  assert.equal(second.status, 200);
  assert.equal(setup.observations.filter((row) => row.status !== "entered-in-error" && row.code.coding?.some((coding) => coding.code === "hpi_ros")).length, 1);
  const painAnswers = setup.observations.filter((row) => row.code.coding?.some((coding) => coding.code === "history-template-answer"))
    .map(parseHistoryAnswerObservation)
    .filter((answer) => answer.id === "answer-pain");
  assert.equal(painAnswers.length, 1);
  assert.deepEqual(painAnswers[0]?.value, { kind: "tri-state", status: "positive" });
});

test("history record read returns only live persisted template answers", async () => {
  const setup = fixture();
  setup.basics.splice(0, setup.basics.length, { ...buildEncounterComplaintResource({ ...COMPLAINTS[0]!, complaintKey: "glaucoma" }), id: "basic-1" });
  assert.equal((await handleHpiCaptureRequest(setup.deps, {
    authHeader: AUTH,
    body: {
      ...BODY,
      templateAnswers: [{
        id: "answer-presentation",
        complaintId: "c1",
        templateKey: "glaucoma",
        sectionId: "presentation",
        value: { kind: "selection", code: "follow-up" },
      }],
    },
  })).status, 200);

  const result = await handleHpiRecordRequest(setup.deps, { authHeader: AUTH, params: { encounterId: "e1" } });
  assert.equal(result.status, 200);
  assert.deepEqual((result.body as { answers: Array<{ id: string }> }).answers.map((answer) => answer.id), ["answer-presentation"]);
  assert.equal((result.body as { requiresAggregateRefresh: boolean }).requiresAggregateRefresh, false);

  const aggregate = setup.observations.find((observation) => observation.code.coding?.some((coding) => coding.code === "hpi_ros"));
  const complaintComponent = aggregate?.component?.find((component) => component.code.coding?.some((coding) => coding.code === "HISTORY_COMPLAINT_1"));
  assert.ok(complaintComponent);
  complaintComponent.valueString = "stale narrative";
  const stale = await handleHpiRecordRequest(setup.deps, { authHeader: AUTH, params: { encounterId: "e1" } });
  assert.equal((stale.body as { requiresAggregateRefresh: boolean }).requiresAggregateRefresh, true);
});

test("last-plan prefill derives presents-for selections from the latest prior plan without complaint-specific logic", () => {
  const complaints = [{ ...COMPLAINTS[0]!, complaintKey: "glaucoma", templateKey: "glaucoma" }];
  const plans: ServiceRequest[] = [
    {
      resourceType: "ServiceRequest",
      id: "older-plan",
      status: "active",
      intent: "plan",
      subject: { reference: "Patient/p1" },
      encounter: { reference: "Encounter/older" },
      authoredOn: "2026-01-01T12:00:00.000Z",
      reasonCode: [{ text: "Return for ocular exam" }],
    },
    {
      resourceType: "ServiceRequest",
      id: "latest-plan",
      status: "active",
      intent: "plan",
      subject: { reference: "Patient/p1" },
      encounter: { reference: "Encounter/prior" },
      authoredOn: "2026-08-01T12:00:00.000Z",
      reasonCode: [{ text: "Return for IOP check and visual field testing" }],
    },
  ];

  assert.deepEqual(deriveLastPlanPrefills(complaints, plans, "Encounter/e1", []), [
    {
      id: "history-c1-presents-for-iop-check",
      complaintId: "c1",
      templateKey: "glaucoma",
      sectionId: "presents-for",
      optionCode: "iop-check",
      value: { kind: "tri-state", status: "positive" },
    },
    {
      id: "history-c1-presents-for-visual-field-testing",
      complaintId: "c1",
      templateKey: "glaucoma",
      sectionId: "presents-for",
      optionCode: "visual-field-testing",
      value: { kind: "tri-state", status: "positive" },
    },
  ]);
});

test("follow-up prefill carries positive and denied list answers from only the latest prior encounter", () => {
  const complaints = [{ ...COMPLAINTS[0]!, complaintKey: "glaucoma", templateKey: "glaucoma" }];
  const metadata = (encounterReference: string, recordedAt: string) => ({
    patientReference: "Patient/p1",
    encounterReference,
    recordedAt,
  });
  const observations = [
    buildHistoryAnswerObservation({
      id: "prior-old",
      complaintId: "prior-c1",
      templateKey: "glaucoma",
      sectionId: "symptoms",
      optionCode: "blurred-vision",
      value: { kind: "tri-state", status: "positive" },
    }, metadata("Encounter/old", "2026-01-01T12:00:00.000Z")),
    buildHistoryAnswerObservation({
      id: "prior-latest-positive",
      complaintId: "prior-c2",
      templateKey: "glaucoma",
      sectionId: "current-treatment",
      optionCode: "latanoprost",
      eye: "OD",
      value: { kind: "tri-state", status: "positive" },
    }, metadata("Encounter/prior", "2026-08-01T12:00:00.000Z")),
    buildHistoryAnswerObservation({
      id: "prior-latest-positive-os",
      complaintId: "prior-c2",
      templateKey: "glaucoma",
      sectionId: "current-treatment",
      optionCode: "latanoprost",
      eye: "OS",
      value: { kind: "tri-state", status: "positive" },
    }, metadata("Encounter/prior", "2026-08-01T12:00:00.000Z")),
    buildHistoryAnswerObservation({
      id: "prior-latest-negative",
      complaintId: "prior-c2",
      templateKey: "glaucoma",
      sectionId: "symptoms",
      optionCode: "ocular-pain",
      value: { kind: "tri-state", status: "negative" },
    }, metadata("Encounter/prior", "2026-08-01T12:00:00.000Z")),
  ];

  assert.deepEqual(deriveFollowUpAnswerPrefills(complaints, observations, "Encounter/e1", []), [
    {
      id: "history-c1-current-treatment-latanoprost-OD",
      complaintId: "c1",
      templateKey: "glaucoma",
      sectionId: "current-treatment",
      optionCode: "latanoprost",
      eye: "OD",
      value: { kind: "tri-state", status: "positive" },
    },
    {
      id: "history-c1-current-treatment-latanoprost-OS",
      complaintId: "c1",
      templateKey: "glaucoma",
      sectionId: "current-treatment",
      optionCode: "latanoprost",
      eye: "OS",
      value: { kind: "tri-state", status: "positive" },
    },
    {
      id: "history-c1-symptoms-ocular-pain",
      complaintId: "c1",
      templateKey: "glaucoma",
      sectionId: "symptoms",
      optionCode: "ocular-pain",
      value: { kind: "tri-state", status: "negative" },
    },
  ]);
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
  const body = result.body as {
    definition: { fields: Record<string, unknown>; terminologyStatus: { status: string } };
  };
  const definition = body.definition;
  assert.deepEqual(Object.keys(definition.fields), ["reviewOfSystems"]);
  assert.equal((definition.fields.reviewOfSystems as { allowCreate?: boolean }).allowCreate, true);
  assert.equal(definition.terminologyStatus.status, "MANDATE-14-DEFERRED");
});

test("HPI definition publishes the patient-scoped Ocular, Medical, Family, and Social History declarations", async () => {
  const result = await handleHpiDefinitionRequest(fixture().deps, { authHeader: AUTH });
  const body = result.body as { subjectSections: Array<{ key: string; subjectScope: string }> };
  assert.deepEqual(body.subjectSections.map((section) => [section.key, section.subjectScope]), [
    ["ocular-history", "patient"],
    ["medical-history", "patient"],
    ["family-history", "patient"],
    ["social-history", "patient"],
  ]);
});

test("record read keeps prior patient-scoped Ocular History separate from answers entered today", async () => {
  const setup = fixture();
  const patientAnswer = (id: string, encounterReference: string, recordedAt: string, status: "positive" | "negative", patientReference = "Patient/p1") => ({
    ...buildHistoryAnswerObservation({
      id,
      subjectScope: "patient" as const,
      templateKey: "ocular-history",
      sectionId: "conditions",
      optionCode: "glaucoma",
      eye: "OD" as const,
      value: { kind: "tri-state" as const, status },
    }, { patientReference, encounterReference, recordedAt }),
    id: `observation-${id}`,
  });
  setup.observations.push(
    patientAnswer("prior-older", "Encounter/e0", "2026-06-01T12:00:00.000Z", "negative"),
    patientAnswer("prior-latest", "Encounter/prior", "2026-08-01T12:00:00.000Z", "positive"),
    patientAnswer("foreign-newer", "Encounter/foreign", "2026-09-01T12:00:00.000Z", "negative", "Patient/p2"),
    patientAnswer("foreign-today", "Encounter/e1", "2026-09-02T12:00:00.000Z", "positive", "Patient/p2"),
    patientAnswer("today", "Encounter/e1", "2026-09-03T12:00:00.000Z", "negative"),
    buildHistoryAnswerObservation({
      id: "prior-complaint",
      complaintId: "old-complaint",
      templateKey: "glaucoma",
      sectionId: "symptoms",
      optionCode: "ocular-pain",
      value: { kind: "tri-state", status: "positive" },
    }, { patientReference: "Patient/p1", encounterReference: "Encounter/prior", recordedAt: "2026-08-02T12:00:00.000Z" }),
  );

  const result = await handleHpiRecordRequest(setup.deps, { authHeader: AUTH, params: { encounterId: "e1" } });
  assert.equal(result.status, 200);
  const body = result.body as {
    answers: Array<{ id: string }>;
    carriedForwardAnswers: Array<{ answer: { id: string }; encounterReference: string; recordedAt: string }>;
  };
  assert.deepEqual(body.answers.map((answer) => answer.id), ["today"]);
  assert.deepEqual(body.carriedForwardAnswers, [{
    answer: {
      id: "prior-latest",
      subjectScope: "patient",
      templateKey: "ocular-history",
      sectionId: "conditions",
      optionCode: "glaucoma",
      eye: "OD",
      value: { kind: "tri-state", status: "positive" },
      observationReference: "Observation/observation-prior-latest",
    },
    encounterReference: "Encounter/prior",
    recordedAt: "2026-08-01T12:00:00.000Z",
  }]);
});

test("patient-scoped Ocular History saves without a synthetic complaint id", async () => {
  const setup = fixture();
  const result = await handleHpiCaptureRequest(setup.deps, {
    authHeader: AUTH,
    body: {
      ...BODY,
      templateAnswers: [{
        id: "ocular-e1-conditions-glaucoma-OD",
        subjectScope: "patient",
        templateKey: "ocular-history",
        sectionId: "conditions",
        optionCode: "glaucoma",
        eye: "OD",
        value: { kind: "tri-state", status: "positive", note: "Diagnosed in 2024" },
      }],
    },
  });

  assert.equal(result.status, 200);
  const persisted = setup.observations.find((observation) => observation.code.coding?.some((coding) => coding.code === "history-template-answer"));
  assert.ok(persisted);
  const answer = parseHistoryAnswerObservation(persisted);
  assert.equal(answer.subjectScope, "patient");
  assert.equal("complaintId" in answer, false);
});

test("Family History saves one condition with positive and denied relatives through the section-aware gate", async () => {
  const answer = {
    id: "family-e1-conditions-glaucoma",
    subjectScope: "patient" as const,
    templateKey: "family-history",
    sectionId: "conditions",
    optionCode: "glaucoma",
    value: { kind: "relations" as const, positive: ["father", "brother"], negative: ["mother"] },
  };
  const setup = fixture("provider", false);
  const result = await handleHpiCaptureRequest(setup.deps, {
    authHeader: AUTH,
    body: { patientReference: "Patient/p1", encounterReference: "Encounter/e1", templateAnswers: [answer] },
  });

  assert.equal(result.status, 200, JSON.stringify(result.body));
  const persisted = setup.observations.find((observation) => observation.code.coding?.some((coding) => coding.code === "history-template-answer"));
  assert.ok(persisted);
  assert.deepEqual(parseHistoryAnswerObservation(persisted), {
    ...answer,
    observationReference: `Observation/${persisted.id}`,
  });
});

test("Family History rejects wrong section kinds, unknown or repeated relations, and conditions with no marked relatives", async () => {
  const base = {
    id: "family-e1-conditions-glaucoma",
    subjectScope: "patient" as const,
    templateKey: "family-history",
    sectionId: "conditions",
    optionCode: "glaucoma",
  };
  const cases = [
    { answer: { ...base, value: { kind: "tri-state", status: "positive" } }, error: /wrong value type for family_conditions/ },
    { answer: { ...base, sectionId: "notes", optionCode: undefined, value: { kind: "relations", positive: ["father"], negative: [] } }, error: /wrong value type for text/ },
    { answer: { ...base, value: { kind: "relations", positive: ["guardian"], negative: [] } }, error: /unknown family relation/ },
    { answer: { ...base, value: { kind: "relations", positive: ["father", "father"], negative: [] } }, error: /value is invalid/ },
    { answer: { ...base, value: { kind: "relations", positive: [], negative: ["mother", "mother"] } }, error: /value is invalid/ },
    { answer: { ...base, value: { kind: "relations", positive: [], negative: [] } }, error: /at least one family relation/ },
  ];
  for (const row of cases) {
    const result = await handleHpiCaptureRequest(fixture("provider", false).deps, {
      authHeader: AUTH,
      body: { patientReference: "Patient/p1", encounterReference: "Encounter/e1", templateAnswers: [row.answer] },
    });
    assert.equal(result.status, 400);
    assert.match((result.body as { error: string }).error, row.error);
  }
});

test("patient-scoped tobacco persists as one catalog-validated selection rather than a tri-state", async () => {
  const selected = {
    id: "social-e1-tobacco",
    subjectScope: "patient" as const,
    templateKey: "social-history",
    sectionId: "tobacco",
    value: { kind: "selection" as const, code: "current" },
  };
  const setup = fixture("provider", false);
  const result = await handleHpiCaptureRequest(setup.deps, {
    authHeader: AUTH,
    body: { patientReference: "Patient/p1", encounterReference: "Encounter/e1", templateAnswers: [selected] },
  });

  assert.equal(result.status, 200);
  const persisted = setup.observations.find((observation) => observation.code.coding?.some((coding) => coding.code === "history-template-answer"));
  assert.ok(persisted);
  assert.deepEqual(parseHistoryAnswerObservation(persisted), {
    ...selected,
    observationReference: `Observation/${persisted.id}`,
  });

  const rejected = await handleHpiCaptureRequest(fixture("provider", false).deps, {
    authHeader: AUTH,
    body: {
      patientReference: "Patient/p1",
      encounterReference: "Encounter/e1",
      templateAnswers: [{ ...selected, value: { kind: "tri-state", status: "positive" } }],
    },
  });
  assert.equal(rejected.status, 400);
  assert.match((rejected.body as { error: string }).error, /wrong value type for single_select/);
});

test("changing a single-select updates one answer with If-Match instead of voiding and recreating it", async () => {
  const setup = fixture("provider", false);
  const answer = {
    id: "history-e1-social-history-tobacco-value",
    subjectScope: "patient" as const,
    templateKey: "social-history",
    sectionId: "tobacco",
    value: { kind: "selection" as const, code: "current" },
  };
  assert.equal((await handleHpiCaptureRequest(setup.deps, {
    authHeader: AUTH,
    body: { patientReference: "Patient/p1", encounterReference: "Encounter/e1", templateAnswers: [answer] },
  })).status, 200);
  const persisted = setup.observations.find((observation) =>
    observation.code.coding?.some((coding) => coding.code === "history-template-answer")
  );
  assert.ok(persisted);
  persisted.meta = { versionId: "7" };

  assert.equal((await handleHpiCaptureRequest(setup.deps, {
    authHeader: AUTH,
    body: {
      patientReference: "Patient/p1",
      encounterReference: "Encounter/e1",
      templateAnswers: [{ ...answer, value: { kind: "selection", code: "former-smoker" } }],
    },
  })).status, 200);

  const replacement = setup.transactions.at(-1)?.bundle.entry?.find((entry) =>
    entry.resource?.resourceType === "Observation" && entry.resource.id === persisted.id
  );
  assert.deepEqual(replacement?.request, {
    method: "PUT",
    url: `Observation/${persisted.id}`,
    ifMatch: 'W/"7"',
  });
  const liveAnswers = setup.observations.filter((observation) =>
    observation.status !== "entered-in-error" &&
    observation.code.coding?.some((coding) => coding.code === "history-template-answer")
  );
  assert.equal(liveAnswers.length, 1);
  assert.deepEqual(parseHistoryAnswerObservation(liveAnswers[0]!).value, {
    kind: "selection",
    code: "former-smoker",
  });
});

test("Medical History keeps prior answers separate from answers entered today", async () => {
  const setup = fixture("provider", false);
  const medicalAnswer = (
    id: string,
    encounterReference: string,
    sectionId: "conditions" | "systemic-medications",
    optionCode: "diabetes-mellitus" | "ibuprofen-800-mg",
  ) => ({
    ...buildHistoryAnswerObservation({
      id,
      subjectScope: "patient" as const,
      templateKey: "medical-history",
      sectionId,
      optionCode,
      value: { kind: "tri-state" as const, status: "positive" as const },
    }, {
      patientReference: "Patient/p1",
      encounterReference,
      recordedAt: encounterReference === "Encounter/e1" ? "2026-09-03T12:00:00.000Z" : "2026-08-01T12:00:00.000Z",
    }),
    id: `observation-${id}`,
  });
  setup.observations.push(
    medicalAnswer("prior-diabetes", "Encounter/prior", "conditions", "diabetes-mellitus"),
    medicalAnswer("today-ibuprofen", "Encounter/e1", "systemic-medications", "ibuprofen-800-mg"),
  );

  const result = await handleHpiRecordRequest(setup.deps, { authHeader: AUTH, params: { encounterId: "e1" } });
  assert.equal(result.status, 200);
  const body = result.body as {
    answers: Array<{ id: string }>;
    carriedForwardAnswers: Array<{ answer: { id: string } }>;
  };
  assert.deepEqual(body.answers.map((answer) => answer.id), ["today-ibuprofen"]);
  assert.deepEqual(body.carriedForwardAnswers.map((row) => row.answer.id), ["prior-diabetes"]);
});

test("Medical History keeps ophthalmic and systemic medication laterality in separate declared sections", async () => {
  const ophthalmic = {
    id: "medical-e1-ophthalmic-medications-miebo-pf-OD",
    subjectScope: "patient" as const,
    templateKey: "medical-history",
    sectionId: "ophthalmic-medications",
    optionCode: "miebo-pf",
    eye: "OD" as const,
    value: { kind: "tri-state" as const, status: "positive" as const },
  };
  const systemic = {
    id: "medical-e1-systemic-medications-ibuprofen-800-mg",
    subjectScope: "patient" as const,
    templateKey: "medical-history",
    sectionId: "systemic-medications",
    optionCode: "ibuprofen-800-mg",
    value: { kind: "tri-state" as const, status: "positive" as const },
  };
  const setup = fixture("provider", false);
  const result = await handleHpiCaptureRequest(setup.deps, {
    authHeader: AUTH,
    body: { patientReference: "Patient/p1", encounterReference: "Encounter/e1", templateAnswers: [ophthalmic, systemic] },
  });
  assert.equal(result.status, 200);
  assert.deepEqual(setup.observations.filter((observation) =>
    observation.code.coding?.some((coding) => coding.code === "history-template-answer")
  ).map(parseHistoryAnswerObservation).map((answer) => [answer.sectionId, answer.eye]), [
    ["ophthalmic-medications", "OD"],
    ["systemic-medications", undefined],
  ]);

  const missingEye = await handleHpiCaptureRequest(fixture("provider", false).deps, {
    authHeader: AUTH,
    body: { patientReference: "Patient/p1", encounterReference: "Encounter/e1", templateAnswers: [{ ...ophthalmic, eye: undefined }] },
  });
  assert.equal(missingEye.status, 400);
  assert.match((missingEye.body as { error: string }).error, /requires an eye/);

  const systemicEye = await handleHpiCaptureRequest(fixture("provider", false).deps, {
    authHeader: AUTH,
    body: { patientReference: "Patient/p1", encounterReference: "Encounter/e1", templateAnswers: [{ ...systemic, eye: "OS" }] },
  });
  assert.equal(systemicEye.status, 400);
  assert.match((systemicEye.body as { error: string }).error, /cannot name an eye/);
});

test("patient-scoped text sections use the same history answer persistence path", async () => {
  const occupation = {
    id: "social-e1-occupation",
    subjectScope: "patient" as const,
    templateKey: "social-history",
    sectionId: "occupation",
    value: { kind: "text" as const, text: "Accountant" },
  };
  const setup = fixture("provider", false);
  const result = await handleHpiCaptureRequest(setup.deps, {
    authHeader: AUTH,
    body: { patientReference: "Patient/p1", encounterReference: "Encounter/e1", templateAnswers: [occupation] },
  });
  assert.equal(result.status, 200);
  const persisted = setup.observations.find((observation) => observation.code.coding?.some((coding) => coding.code === "history-template-answer"));
  assert.ok(persisted);
  assert.deepEqual(parseHistoryAnswerObservation(persisted), {
    ...occupation,
    observationReference: `Observation/${persisted.id}`,
  });
});

test("Ocular History can be recorded before a chief complaint without creating an empty HPI", async () => {
  const setup = fixture("provider", false);
  const result = await handleHpiCaptureRequest(setup.deps, {
    authHeader: AUTH,
    body: {
      patientReference: "Patient/p1",
      encounterReference: "Encounter/e1",
      templateAnswers: [{
        id: "ocular-e1-conditions-strabismus",
        subjectScope: "patient",
        templateKey: "ocular-history",
        sectionId: "conditions",
        optionCode: "strabismus",
        value: { kind: "tri-state", status: "negative" },
      }],
    },
  });

  assert.equal(result.status, 200);
  assert.equal(setup.observations.filter((observation) => observation.code.coding?.some((coding) => coding.code === "history-template-answer")).length, 1);
  assert.equal(setup.observations.some((observation) => observation.code.coding?.some((coding) => coding.code === "hpi_ros")), false);
});

test("reviewed today records a separate attestation that references prior answers without editing them", async () => {
  const setup = fixture();
  setup.observations.push({
    ...buildHistoryAnswerObservation({
      id: "prior-glaucoma",
      subjectScope: "patient",
      templateKey: "ocular-history",
      sectionId: "conditions",
      optionCode: "glaucoma",
      eye: "OD",
      value: { kind: "tri-state", status: "positive" },
    }, {
      patientReference: "Patient/p1",
      encounterReference: "Encounter/prior",
      recordedAt: "2026-08-01T12:00:00.000Z",
    }),
    id: "prior-glaucoma-observation",
  });
  const before = structuredClone(setup.observations);

  const result = await handleHistoryReviewRequest(setup.deps, {
    authHeader: AUTH,
    body: {
      patientReference: "Patient/p1",
      encounterReference: "Encounter/e1",
      sectionKey: "ocular-history",
    },
  });

  assert.equal(result.status, 200);
  assert.deepEqual(setup.observations.slice(0, before.length), before, "reviewing does not rewrite prior answers");
  const transactionResources = setup.transactions.at(-1)?.bundle.entry?.map((entry) => entry.resource).filter(Boolean) ?? [];
  assert.deepEqual(transactionResources.map((resource) => resource.resourceType), ["Observation", "Provenance"]);
  const attestation = transactionResources[0] as Observation;
  assert.equal(attestation.code.coding?.[0]?.code, HISTORY_REVIEW_ATTESTATION_CODE);
  assert.equal(attestation.effectiveDateTime, "2026-07-21T12:30:00.000Z");
  assert.deepEqual(attestation.performer, [{ reference: "Practitioner/doc1" }]);
  assert.deepEqual(attestation.derivedFrom, [{ reference: "Observation/prior-glaucoma-observation" }]);

  const record = await handleHpiRecordRequest(setup.deps, { authHeader: AUTH, params: { encounterId: "e1" } });
  assert.deepEqual((record.body as { reviewAttestations: unknown[] }).reviewAttestations, [{
    sectionKey: "ocular-history",
    actorReference: "Practitioner/doc1",
    recordedAt: "2026-07-21T12:30:00.000Z",
    attestationReference: "Observation/observation-2",
    priorAnswerReferences: ["Observation/prior-glaucoma-observation"],
  }]);
});

test("Social History uses the shared no-change attestation path and names itself in refusals", async () => {
  const socialAnswer = (id: string, encounterReference: string) => ({
    ...buildHistoryAnswerObservation({
      id,
      subjectScope: "patient" as const,
      templateKey: "social-history",
      sectionId: "tobacco",
      value: { kind: "selection" as const, code: "former-smoker" },
    }, {
      patientReference: "Patient/p1",
      encounterReference,
      recordedAt: encounterReference === "Encounter/e1" ? "2026-09-03T12:00:00.000Z" : "2026-08-01T12:00:00.000Z",
    }),
    id: `${id}-observation`,
  });
  const reviewSetup = fixture();
  reviewSetup.observations.push(socialAnswer("prior-tobacco", "Encounter/prior"));
  const reviewed = await handleHistoryReviewRequest(reviewSetup.deps, {
    authHeader: AUTH,
    body: {
      patientReference: "Patient/p1",
      encounterReference: "Encounter/e1",
      sectionKey: "social-history",
    },
  });
  assert.equal(reviewed.status, 200);
  assert.equal((reviewSetup.transactions.at(-1)?.bundle.entry?.[0]?.resource as Observation).derivedFrom?.[0]?.reference,
    "Observation/prior-tobacco-observation");

  const editedSetup = fixture();
  editedSetup.observations.push(
    socialAnswer("prior-tobacco", "Encounter/prior"),
    socialAnswer("today-tobacco", "Encounter/e1"),
  );
  const refused = await handleHistoryReviewRequest(editedSetup.deps, {
    authHeader: AUTH,
    body: {
      patientReference: "Patient/p1",
      encounterReference: "Encounter/e1",
      sectionKey: "social-history",
    },
  });
  assert.equal(refused.status, 409);
  assert.equal((refused.body as { error: string }).error,
    "Social History was edited on this encounter; a no-change review cannot also be recorded.");
});

test("reviewed today refuses to attest no change after this encounter has an Ocular History edit", async () => {
  const setup = fixture();
  for (const [id, encounterReference] of [["prior-glaucoma", "Encounter/prior"], ["today-glaucoma", "Encounter/e1"]] as const) {
    setup.observations.push({
      ...buildHistoryAnswerObservation({
        id,
        subjectScope: "patient",
        templateKey: "ocular-history",
        sectionId: "conditions",
        optionCode: "glaucoma",
        eye: "OD",
        value: { kind: "tri-state", status: "positive" },
      }, {
        patientReference: "Patient/p1",
        encounterReference,
        recordedAt: encounterReference === "Encounter/e1" ? "2026-09-03T12:00:00.000Z" : "2026-08-01T12:00:00.000Z",
      }),
      id: `${id}-observation`,
    });
  }

  const result = await handleHistoryReviewRequest(setup.deps, {
    authHeader: AUTH,
    body: {
      patientReference: "Patient/p1",
      encounterReference: "Encounter/e1",
      sectionKey: "ocular-history",
    },
  });

  assert.equal(result.status, 409);
  assert.match((result.body as { error: string }).error, /edited on this encounter/);
  assert.equal(setup.transactions.length, 0);
});

test("a later Ocular History edit retires the earlier no-change attestation in the same transaction", async () => {
  const setup = fixture("provider", false);
  setup.observations.push({
    ...buildHistoryReviewAttestation({
      patientReference: "Patient/p1",
      encounterReference: "Encounter/e1",
      sectionKey: "ocular-history",
      actorReference: "Practitioner/doc1",
      recordedAt: "2026-09-03T11:00:00.000Z",
      priorAnswerReferences: ["Observation/prior-glaucoma"],
    }),
    id: "review-before-edit",
    meta: { versionId: "3" },
  });

  const result = await handleHpiCaptureRequest(setup.deps, {
    authHeader: AUTH,
    body: {
      patientReference: "Patient/p1",
      encounterReference: "Encounter/e1",
      templateAnswers: [{
        id: "ocular-e1-conditions-glaucoma-OD",
        subjectScope: "patient",
        templateKey: "ocular-history",
        sectionId: "conditions",
        optionCode: "glaucoma",
        eye: "OD",
        value: { kind: "tri-state", status: "positive" },
      }],
    },
  });

  assert.equal(result.status, 200);
  assert.deepEqual((result.body as { retiredReviewSections: string[] }).retiredReviewSections, ["ocular-history"]);
  assert.equal(setup.observations.find((observation) => observation.id === "review-before-edit")?.status, "entered-in-error");
  const retirement = setup.transactions[0]?.bundle.entry?.find((entry) => entry.resource?.resourceType === "Observation" && entry.resource.id === "review-before-edit");
  assert.equal(retirement?.request?.method, "PUT");
  assert.equal(retirement?.request?.ifMatch, 'W/"3"');
  const retirementProvenance = setup.transactions[0]?.bundle.entry?.find((entry) =>
    entry.resource?.resourceType === "Provenance" && entry.resource.activity?.coding?.some((coding) => coding.code === "VOID")
  )?.resource as Provenance | undefined;
  assert.equal(retirementProvenance?.agent[0]?.who.reference, "Practitioner/doc1");
});

test("patient-scoped notes require a positive answer and catalog permission", async () => {
  const answer = {
    id: "ocular-e1-conditions-glaucoma-OD",
    subjectScope: "patient" as const,
    templateKey: "ocular-history",
    sectionId: "conditions",
    optionCode: "glaucoma",
    eye: "OD" as const,
    value: { kind: "tri-state" as const, status: "negative" as const, note: "Not allowed" },
  };
  const negativeSetup = fixture("provider", false);
  const negativeResult = await handleHpiCaptureRequest(negativeSetup.deps, {
    authHeader: AUTH,
    body: { patientReference: "Patient/p1", encounterReference: "Encounter/e1", templateAnswers: [answer] },
  });
  assert.equal(negativeResult.status, 400);
  assert.match((negativeResult.body as { error: string }).error, /value is invalid/);
  assert.equal(negativeSetup.transactions.length, 0);

  const glaucoma = HISTORY_OPTION_CATALOGS.ocular_history_conditions?.find((option) => option.code === "glaucoma");
  assert.ok(glaucoma);
  const originalPermission = glaucoma.note_on_positive;
  glaucoma.note_on_positive = false;
  try {
    const permissionSetup = fixture("provider", false);
    const permissionResult = await handleHpiCaptureRequest(permissionSetup.deps, {
      authHeader: AUTH,
      body: {
        patientReference: "Patient/p1",
        encounterReference: "Encounter/e1",
        templateAnswers: [{ ...answer, value: { ...answer.value, status: "positive" as const } }],
      },
    });
    assert.equal(permissionResult.status, 400);
    assert.match((permissionResult.body as { error: string }).error, /does not allow notes/);
    assert.equal(permissionSetup.transactions.length, 0);
  } finally {
    glaucoma.note_on_positive = originalPermission;
  }
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
  const wrongTemplateValue = await handleHpiCaptureRequest(fixture().deps, {
    authHeader: AUTH,
    body: {
      ...BODY,
      templateAnswers: [
        { id: "answer-presentation", complaintId: "c1", templateKey: "glaucoma", sectionId: "presentation", value: { kind: "selection", code: "follow-up" } },
        { id: "answer-duration", complaintId: "c1", templateKey: "glaucoma", sectionId: "glaucoma-duration", value: { kind: "tri-state", status: "positive" } },
      ],
    },
  });
  assert.equal(wrongTemplateValue.status, 400);
  assert.match((wrongTemplateValue.body as { error: string }).error, /wrong value type/);
  const missingTreatmentEye = await handleHpiCaptureRequest(fixture().deps, {
    authHeader: AUTH,
    body: {
      ...BODY,
      templateAnswers: [
        { id: "answer-presentation", complaintId: "c1", templateKey: "glaucoma", sectionId: "presentation", value: { kind: "selection", code: "follow-up" } },
        { id: "answer-treatment", complaintId: "c1", templateKey: "glaucoma", sectionId: "current-treatment", optionCode: "latanoprost", value: { kind: "tri-state", status: "positive" } },
      ],
    },
  });
  assert.equal(missingTreatmentEye.status, 400);
  assert.match((missingTreatmentEye.body as { error: string }).error, /requires an eye/);
  const inactiveConditionalAnswer = await handleHpiCaptureRequest(fixture().deps, {
    authHeader: AUTH,
    body: {
      ...BODY,
      templateAnswers: [
        { id: "answer-presentation", complaintId: "c1", templateKey: "glaucoma", sectionId: "presentation", value: { kind: "selection", code: "pressure-check" } },
        { id: "answer-interval", complaintId: "c1", templateKey: "glaucoma", sectionId: "interval", value: { kind: "interval", code: "same" } },
      ],
    },
  });
  assert.equal(inactiveConditionalAnswer.status, 400);
  assert.match((inactiveConditionalAnswer.body as { error: string }).error, /inactive for pressure-check/);
});

function componentValue(observation: Observation, code: string): string | undefined {
  return observation.component?.find((component) => component.code.coding?.[0]?.code === code)?.valueString;
}

function componentBoolean(observation: Observation, code: string): boolean | undefined {
  return observation.component?.find((component) => component.code.coding?.[0]?.code === code)?.valueBoolean;
}

const DELTA_CONTEXT = {
  patientReference: "Patient/p1", encounterReference: "Encounter/e1",
  recordedAt: "2026-09-04T10:00:00.000Z", actorReference: "Practitioner/doc1",
};

function deltaAnswer(index: number) {
  return {
    id: `delta-${index}`, subjectScope: "patient" as const, templateKey: "social-history",
    sectionId: "occupation", value: { kind: "text" as const, text: `History ${index}` },
  };
}

for (const [answerCount, existing, expectedStatus, expectedEntries] of [
  [7, false, 200, 8], [8, false, 413, 9],
  [50, true, 200, 51], [51, true, 413, 52],
] as const) {
  test(`delta bundle boundary: ${expectedEntries} entries, ${existing ? answerCount + " ordinary PUTs" : "conditional PUTs"}, status ${expectedStatus}`, async () => {
    const setup = fixture("provider", false);
    const answers = Array.from({ length: answerCount }, (_, index) => deltaAnswer(index));
    if (existing) setup.observations.push(...answers.map((answer, index) => ({
      ...buildHistoryAnswerObservation({ ...answer, value: { kind: "text", text: "Before" } }, DELTA_CONTEXT),
      id: `stored-${index}`, meta: { versionId: "1" },
    })));
    const before = structuredClone(setup.observations);
    const result = await handleHpiCaptureRequest(setup.deps, { authHeader: AUTH, body: { ...BODY, reviewOfSystems: undefined, reviewAttestations: undefined, templateAnswers: answers } });
    if (expectedStatus === 413) {
      assert.deepEqual(setup.observations, before, "refusal must leave every resource unchanged");
      assert.equal(setup.created.length, 0, "refusal creates no provenance");
      assert.equal(setup.transactions.length, 0, "guard runs before any write attempt");
    } else {
      assert.equal(setup.observations.length, answerCount);
      assert.equal(setup.transactions[0]?.bundle.entry?.length, expectedEntries);
      assert.deepEqual(setup.observations.map(parseHistoryAnswerObservation).map((answer) => answer.value), answers.map((answer) => answer.value));
    }
    assert.equal(result.status, expectedStatus);
  });
}

test("byte-identical delta resubmission writes nothing and retains all review acts and answer dates", async () => {
  const setup = fixture("provider", false);
  const answer = deltaAnswer(0);
  setup.observations.push({ ...buildHistoryAnswerObservation(answer, DELTA_CONTEXT), id: "stored-0" });
  for (const sectionKey of ["social-history", "ocular-history"]) setup.observations.push({
    ...buildHistoryReviewAttestation({ ...DELTA_CONTEXT, sectionKey, priorAnswerReferences: ["Observation/prior"] }), id: `review-${sectionKey}`,
  });
  const before = structuredClone(setup.observations);
  for (const templateAnswers of [[answer], []]) {
    const result = await handleHpiCaptureRequest(setup.deps, { authHeader: AUTH, body: { patientReference: BODY.patientReference, encounterReference: BODY.encounterReference, templateAnswers } });
    assert.equal(result.status, 200);
    assert.deepEqual(setup.observations, before);
    assert.equal(setup.transactions.length, 0);
    assert.deepEqual((result.body as { retiredReviewSections: string[] }).retiredReviewSections, []);
  }
});

test("changed delta retires only its section and maps references past skipped unchanged answers", async () => {
  const setup = fixture("provider", false);
  const unchanged = deltaAnswer(0);
  setup.observations.push({ ...buildHistoryAnswerObservation(unchanged, DELTA_CONTEXT), id: "stored-0" });
  for (const sectionKey of ["social-history", "ocular-history"]) setup.observations.push({
    ...buildHistoryReviewAttestation({ ...DELTA_CONTEXT, sectionKey, priorAnswerReferences: ["Observation/prior"] }), id: `review-${sectionKey}`,
  });
  const original = structuredClone(setup.observations[0]);
  const result = await handleHpiCaptureRequest(setup.deps, { authHeader: AUTH, body: { patientReference: BODY.patientReference, encounterReference: BODY.encounterReference, templateAnswers: [unchanged, deltaAnswer(1)] } });
  assert.equal(result.status, 200);
  assert.deepEqual(setup.observations[0], original);
  assert.deepEqual((result.body as { retiredReviewSections: string[] }).retiredReviewSections, ["social-history"]);
  assert.equal(setup.observations.find((row) => row.id === "review-ocular-history")?.status, "preliminary");
  const returned = (result.body as { answers: Array<{ id: string; observationReference: string }> }).answers;
  assert.equal(returned.find((row) => row.id === "delta-1")?.observationReference, "Observation/observation-4");
});

test("delta comparison persists changed answer coordinates when the value is unchanged", async () => {
  const setup = fixture();
  setup.basics.splice(0, setup.basics.length, { ...buildEncounterComplaintResource({ ...COMPLAINTS[0]!, complaintKey: "glaucoma" }), id: "basic-1" });
  const presentation = { id: "presentation", complaintId: "c1", templateKey: "glaucoma", sectionId: "presentation", value: { kind: "selection" as const, code: "follow-up" } };
  const symptom = { id: "symptom", complaintId: "c1", templateKey: "glaucoma", sectionId: "symptoms", optionCode: "ocular-pain", value: { kind: "tri-state" as const, status: "negative" as const } };
  setup.observations.push(
    { ...buildHistoryAnswerObservation(presentation, DELTA_CONTEXT), id: "stored-presentation" },
    { ...buildHistoryAnswerObservation(symptom, DELTA_CONTEXT), id: "stored-symptom" },
  );

  const movedSymptom = { ...symptom, optionCode: "headache" };
  const result = await handleHpiCaptureRequest(setup.deps, {
    authHeader: AUTH,
    body: { patientReference: BODY.patientReference, encounterReference: BODY.encounterReference, templateAnswers: [movedSymptom] },
  });

  assert.equal(result.status, 200);
  assert.equal(parseHistoryAnswerObservation(setup.observations.find((row) => row.id === "stored-symptom")!).optionCode, "headache");
  const aggregate = setup.observations.find((row) => row.code.coding?.some((coding) => coding.code === "hpi_ros"))!;
  assert.match(componentValue(aggregate, "HISTORY_COMPLAINT_1") ?? "", /Denies headache/);
  assert.doesNotMatch(componentValue(aggregate, "HISTORY_COMPLAINT_1") ?? "", /ocular pain/);
});

test("moving an answer out of a reviewed patient section retires that section's attestation", async () => {
  const setup = fixture();
  setup.basics.splice(0, setup.basics.length, { ...buildEncounterComplaintResource({ ...COMPLAINTS[0]!, complaintKey: "glaucoma" }), id: "basic-1" });
  const prior = deltaAnswer(0);
  setup.observations.push(
    { ...buildHistoryAnswerObservation(prior, DELTA_CONTEXT), id: "stored-answer" },
    { ...buildHistoryReviewAttestation({ ...DELTA_CONTEXT, sectionKey: "social-history", priorAnswerReferences: ["Observation/stored-answer"] }), id: "review-social" },
  );
  const moved = {
    id: prior.id,
    complaintId: "c1",
    templateKey: "glaucoma",
    sectionId: "additional-history",
    value: prior.value,
  };

  const result = await handleHpiCaptureRequest(setup.deps, {
    authHeader: AUTH,
    body: { patientReference: BODY.patientReference, encounterReference: BODY.encounterReference, templateAnswers: [moved] },
  });

  assert.equal(result.status, 200);
  assert.equal(setup.observations.find((row) => row.id === "review-social")?.status, "entered-in-error");
  assert.deepEqual((result.body as { retiredReviewSections: string[] }).retiredReviewSections, ["social-history"]);
  assert.equal(parseHistoryAnswerObservation(setup.observations.find((row) => row.id === "stored-answer")!).complaintId, "c1");
});

test("complaint delta uses persisted presentation and preserves omitted narrative answers without rewriting them", async () => {
  const setup = fixture();
  setup.basics.splice(0, setup.basics.length, { ...buildEncounterComplaintResource({ ...COMPLAINTS[0]!, complaintKey: "glaucoma" }), id: "basic-1" });
  const presentation = { id: "presentation", complaintId: "c1", templateKey: "glaucoma", sectionId: "presentation", value: { kind: "selection" as const, code: "follow-up" } };
  const pain = { id: "pain", complaintId: "c1", templateKey: "glaucoma", sectionId: "symptoms", optionCode: "ocular-pain", value: { kind: "tri-state" as const, status: "negative" as const } };
  const body = { patientReference: BODY.patientReference, encounterReference: BODY.encounterReference, templateAnswers: [presentation, pain] };
  assert.equal((await handleHpiCaptureRequest(setup.deps, { authHeader: AUTH, body })).status, 200);
  const beforeAnswers = structuredClone(setup.observations.filter((row) => row.code.coding?.some((coding) => coding.code === "history-template-answer")));
  const interval = { id: "interval", complaintId: "c1", templateKey: "glaucoma", sectionId: "interval", value: { kind: "interval", code: "better" } };
  const result = await handleHpiCaptureRequest(setup.deps, { authHeader: AUTH, body: { ...body, templateAnswers: [interval] } });
  assert.equal(result.status, 200);
  for (const before of beforeAnswers) assert.deepEqual(setup.observations.find((row) => row.id === before.id), before);
  const aggregate = setup.observations.find((row) => row.code.coding?.some((coding) => coding.code === "hpi_ros"))!;
  assert.match(componentValue(aggregate, "HISTORY_COMPLAINT_1") ?? "", /Denies ocular pain/);
  const writes = setup.transactions.length;
  assert.equal((await handleHpiCaptureRequest(setup.deps, { authHeader: AUTH, body: { ...body, templateAnswers: [] } })).status, 200);
  assert.equal(setup.transactions.length, writes, "unchanged aggregate refresh must not manufacture a PUT");
});

test("conditional bundle guard includes aggregate and review retirement provenance before any write", async () => {
  const setup = fixture();
  setup.observations.push({ ...buildHistoryReviewAttestation({ ...DELTA_CONTEXT, sectionKey: "social-history", priorAnswerReferences: ["Observation/prior"] }), id: "review-social" });
  const before = structuredClone(setup.observations);
  const result = await handleHpiCaptureRequest(setup.deps, { authHeader: AUTH, body: { patientReference: BODY.patientReference, encounterReference: BODY.encounterReference, templateAnswers: Array.from({ length: 5 }, (_, index) => deltaAnswer(index)) } });
  assert.equal(result.status, 413, "5 answers + aggregate + 2 provenance + review retirement = 9 entries");
  assert.deepEqual(setup.observations, before);
  assert.equal(setup.created.length, 0);
  assert.equal(setup.transactions.length, 0);
});

test("delta validation does not revalidate an omitted legacy section", async () => {
  const setup = fixture("provider", false);
  const omitted = { ...buildHistoryAnswerObservation({ ...deltaAnswer(0), templateKey: "legacy-section" }, DELTA_CONTEXT), id: "legacy" };
  setup.observations.push(omitted);
  const result = await handleHpiCaptureRequest(setup.deps, { authHeader: AUTH, body: { patientReference: BODY.patientReference, encounterReference: BODY.encounterReference, templateAnswers: [deltaAnswer(1)] } });
  assert.equal(result.status, 200);
  assert.deepEqual(setup.observations[0], omitted);
});
