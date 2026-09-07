import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import type { Basic, Bundle, Observation, Provenance } from "@medplum/fhirtypes";
import express from "express";
import type { PracticeRoleId } from "../src/authz/roles.js";
import {
  handleCustomSectionCaptureRequest,
  handleCustomSectionHistoryRequest,
} from "../src/clinical-graph/custom-section-endpoint.js";
import { handleDiagnosisCandidatesRequest } from "../src/clinical-graph/diagnosis-candidates-endpoint.js";
import {
  handleFindingDefinitionCreationRequest,
  handleFindingDefinitionMutationRequest,
} from "../src/clinical-graph/finding-definition-endpoint.js";
import {
  FhirFindingDefinitionStore,
  buildFindingDefinitionSeeds,
} from "../src/clinical-graph/finding-definition-store.js";
import {
  customFieldOptionInputSchema,
  observationCustomValue,
} from "../src/clinical-graph/custom-fields.js";
import { buildExamOverviewProjection } from "../src/clinical-graph/exam-overview-projection.js";
import type { ClinicalFindingDefinition } from "../src/clinical-graph/glaucoma-suspect.js";
import {
  buildOcularHealthDefinitions,
  type StructureSeed,
} from "../src/clinical-graph/ocular-health-definition.js";

const AUTH = "Bearer good";
const NOW = "2026-07-10T18:00:00.000Z";
const SYNTHETIC_PROVENANCE = {
  source: "manual" as const,
  recordedAt: NOW,
  actorReference: "Practitioner/synthetic",
};

test("Skin Carotenoid Score creates, captures, reads, renames, and deactivates without changing its stable key", async () => {
  const fhir = new MemoryFhir();
  const denied = await handleFindingDefinitionCreationRequest(definitionDeps("provider", fhir, "scs00000"), {
    authHeader: AUTH,
    body: scsDefinitionBody(),
  });
  assert.equal(denied.status, 403);

  const created = await handleFindingDefinitionCreationRequest(definitionDeps("admin", fhir, "scs00000"), {
    authHeader: AUTH,
    body: scsDefinitionBody(),
  });
  assert.equal(created.status, 201);
  const createdBody = created.body as {
    definition: { stableKey: string; display: string; perEye: boolean };
    fields: Array<{ localCode: string }>;
  };
  const stableKey = createdBody.definition.stableKey;
  const localCode = createdBody.fields[0]!.localCode;
  assert.equal(stableKey, "custom:skin-carotenoid-score-scs00000");
  assert.equal(createdBody.definition.perEye, false);
  const definitions = await catalog(fhir);
  const definition = definitions.find((row) => row.stableKey === stableKey);
  assert.equal(definition?.notBillReady, true);

  const backdated = await handleCustomSectionCaptureRequest(clinicalDeps("provider", fhir, definitions), {
    authHeader: AUTH,
    params: { stableKey },
    body: {
      patientReference: "Patient/p1",
      encounterReference: "Encounter/e1",
      recordedAt: "2020-01-01T00:00:00.000Z",
      customFields: [{ code: localCode, value: 72 }],
    },
  });
  assert.equal(backdated.status, 400);
  assert.equal(fhir.observations.length, 0);

  const capture = await handleCustomSectionCaptureRequest(clinicalDeps("provider", fhir, definitions), {
    authHeader: AUTH,
    params: { stableKey },
    body: {
      patientReference: "Patient/p1",
      encounterReference: "Encounter/e1",
      customFields: [{ code: localCode, value: 72 }],
      remarks: "Discussed nutrition.",
    },
  });
  assert.equal(capture.status, 200, JSON.stringify(capture.body));
  const captureReference = (capture.body as { observationReference: string }).observationReference;
  assert.equal(captureReference, `Observation/${fhir.observations[0]?.id}`);
  assert.equal(fhir.observations.length, 1);
  assert.equal(fhir.observations[0]?.status, "preliminary");
  assert.equal(component(fhir.observations[0], localCode)?.valueQuantity?.value, 72);
  assert.equal(component(fhir.observations[0], "REMARKS")?.valueString, "Discussed nutrition.");
  assert.deepEqual(fhir.captureWrites.map((write) => write.resourceType), ["Observation", "Provenance"]);
  assert.equal(fhir.captureWrites.every((write) => write.header === "mcp/save_section_observations"), true);
  const provenance = fhir.captureWrites.find((write) => write.resourceType === "Provenance")?.resource as Provenance;
  assert.equal(provenance.target?.[0]?.reference?.startsWith("Observation/"), true);
  assert.equal(provenance.target?.[1]?.reference, "Patient/p1");

  const history = await handleCustomSectionHistoryRequest(clinicalDeps("provider", fhir, definitions), {
    authHeader: AUTH,
    params: { stableKey },
    query: { patient: "Patient/p1" },
  });
  assert.equal(history.status, 200);
  assert.deepEqual((history.body as { rows: unknown[] }).rows, [{
    observationReference: captureReference,
    recordedAt: NOW,
    values: [{ code: localCode, label: "Score", value: 72 }],
    remarks: "Discussed nutrition.",
  }]);

  const renamed = await handleFindingDefinitionMutationRequest(definitionDeps("admin", fhir, "unused000"), {
    authHeader: AUTH,
    params: { stableKey },
    body: { action: "update-definition", display: "Carotenoid Score" },
  });
  assert.equal(renamed.status, 200);
  assert.equal((renamed.body as { definition: { stableKey: string; display: string } }).definition.stableKey, stableKey);
  assert.equal((renamed.body as { definition: { display: string } }).definition.display, "Carotenoid Score");

  const fieldRenamed = await handleFindingDefinitionMutationRequest(definitionDeps("admin", fhir, "unused000"), {
    authHeader: AUTH,
    params: { stableKey },
    body: { action: "update-custom-field", localCode, display: "SCS" },
  });
  assert.equal(fieldRenamed.status, 200);
  assert.equal((fieldRenamed.body as { field: { localCode: string } }).field.localCode, localCode);

  const deactivated = await handleFindingDefinitionMutationRequest(definitionDeps("admin", fhir, "unused000"), {
    authHeader: AUTH,
    params: { stableKey },
    body: { action: "update-definition", active: false },
  });
  assert.equal(deactivated.status, 200);
  const inactiveDefinitions = await catalog(fhir);
  const blocked = await handleCustomSectionCaptureRequest(clinicalDeps("provider", fhir, inactiveDefinitions), {
    authHeader: AUTH,
    params: { stableKey },
    body: {
      patientReference: "Patient/p1",
      encounterReference: "Encounter/e1",
      customFields: [{ code: localCode, value: 70 }],
    },
  });
  assert.equal(blocked.status, 404);
  assert.equal(fhir.observations.length, 1);

  await handleFindingDefinitionMutationRequest(definitionDeps("admin", fhir, "unused000"), {
    authHeader: AUTH,
    params: { stableKey },
    body: { action: "update-definition", active: true },
  });
  const reactivated = await catalog(fhir);
  const restoredHistory = await handleCustomSectionHistoryRequest(clinicalDeps("provider", fhir, reactivated), {
    authHeader: AUTH,
    params: { stableKey },
    query: { patient: "Patient/p1" },
  });
  assert.equal(restoredHistory.status, 200);
  assert.equal((restoredHistory.body as { rows: unknown[] }).rows.length, 1);
});

test("per-eye custom sections prefix field components and read OD and OS independently", async () => {
  const fhir = new MemoryFhir();
  const created = await handleFindingDefinitionCreationRequest(definitionDeps("admin", fhir, "eye00000"), {
    authHeader: AUTH,
    body: {
      action: "create-definition",
      display: "Tear Pattern",
      perEye: true,
      fields: [{
        display: "Pattern",
        valueType: "select",
        options: [
          { code: "stable", display: "Stable", active: true },
          { code: "unstable", display: "Unstable", active: true },
        ],
      }],
    },
  });
  const body = created.body as { definition: { stableKey: string }; fields: Array<{ localCode: string }> };
  const definitions = await catalog(fhir);
  const capture = await handleCustomSectionCaptureRequest(clinicalDeps("provider", fhir, definitions), {
    authHeader: AUTH,
    params: { stableKey: body.definition.stableKey },
    body: {
      patientReference: "Patient/p2",
      encounterReference: "Encounter/e2",
      eyes: {
        OD: { customFields: [{ code: body.fields[0]!.localCode, value: "stable" }] },
        OS: { customFields: [{ code: body.fields[0]!.localCode, value: "unstable" }] },
      },
    },
  });
  assert.equal(capture.status, 200, JSON.stringify(capture.body));
  assert.equal(component(fhir.observations[0], `OD_${body.fields[0]!.localCode}`)?.valueCodeableConcept?.coding?.[0]?.code, "stable");
  assert.equal(component(fhir.observations[1], `OS_${body.fields[0]!.localCode}`)?.valueCodeableConcept?.coding?.[0]?.code, "unstable");

  const history = await handleCustomSectionHistoryRequest(clinicalDeps("provider", fhir, definitions), {
    authHeader: AUTH,
    params: { stableKey: body.definition.stableKey },
    query: { patient: "Patient/p2" },
  });
  const rows = (history.body as { rows: Array<{ eye: string; values: Array<{ value: string }> }> }).rows;
  assert.deepEqual(rows.map((row) => [row.eye, row.values[0]?.value]), [["OD", "Stable"], ["OS", "Unstable"]]);

  const adminRead = await handleCustomSectionHistoryRequest(clinicalDeps("admin", fhir, definitions), {
    authHeader: AUTH,
    params: { stableKey: body.definition.stableKey },
    query: { patient: "Patient/p2" },
  });
  const deniedWrite = await handleCustomSectionCaptureRequest(clinicalDeps("admin", fhir, definitions), {
    authHeader: AUTH,
    params: { stableKey: body.definition.stableKey },
    body: {
      patientReference: "Patient/p2",
      encounterReference: "Encounter/e2",
      eyes: { OD: { customFields: [] } },
    },
  });
  assert.equal(adminRead.status, 200);
  assert.equal(deniedWrite.status, 403);
});

test("per-eye multi-select fields namespace shared option codes, preserve legacy rows, and omit empty selections", async () => {
  const fhir = new MemoryFhir();
  const created = await handleFindingDefinitionCreationRequest(definitionDeps("admin", fhir, "multi000"), {
    authHeader: AUTH,
    body: {
      action: "create-definition",
      display: "Shared option panel",
      perEye: true,
      fields: [
        { display: "First findings", valueType: "multi-select", options: [{ code: "shared", display: "Shared first", active: true }] },
        { display: "Second findings", valueType: "multi-select", options: [{ code: "shared", display: "Shared second", active: true }] },
      ],
    },
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const body = created.body as { definition: { stableKey: string }; fields: Array<{ localCode: string }> };
  const [first, second] = body.fields;
  assert.ok(first && second);
  const definitions = await catalog(fhir);
  const captured = await handleCustomSectionCaptureRequest(clinicalDeps("provider", fhir, definitions), {
    authHeader: AUTH,
    params: { stableKey: body.definition.stableKey },
    body: {
      patientReference: "Patient/p-multi",
      encounterReference: "Encounter/e-multi",
      eyes: {
        OD: { customFields: [{ code: first.localCode, value: ["shared"] }, { code: second.localCode, value: [] }] },
        OS: { customFields: [{ code: first.localCode, value: [] }, { code: second.localCode, value: ["shared"] }] },
      },
    },
  });
  assert.equal(captured.status, 200, JSON.stringify(captured.body));
  assert.equal(component(fhir.observations[0], `OD_${first.localCode}::shared`)?.valueBoolean, true);
  assert.equal(component(fhir.observations[0], `OD_${second.localCode}::shared`), undefined);
  assert.equal(component(fhir.observations[1], `OS_${first.localCode}::shared`), undefined);
  assert.equal(component(fhir.observations[1], `OS_${second.localCode}::shared`)?.valueBoolean, true);

  const history = await handleCustomSectionHistoryRequest(clinicalDeps("provider", fhir, definitions), {
    authHeader: AUTH,
    params: { stableKey: body.definition.stableKey },
    query: { patient: "Patient/p-multi", encounter: "Encounter/e-multi" },
  });
  const rows = (history.body as { rows: Array<{ eye: string; values: Array<{ code: string; value: string[] }> }> }).rows;
  assert.deepEqual(rows.map((row) => [row.eye, row.values]), [
    ["OD", [{ code: first.localCode, label: "First findings", value: ["shared"] }]],
    ["OS", [{ code: second.localCode, label: "Second findings", value: ["shared"] }]],
  ]);
  const sharedOption = [{ code: "shared", display: "Shared", active: true }];
  assert.deepEqual(observationCustomValue(fhir.observations[0]!, {
    localCode: first.localCode,
    valueType: "multi-select",
    options: sharedOption,
  }, "OD_"), ["shared"]);
  assert.equal(observationCustomValue(fhir.observations[0]!, {
    localCode: second.localCode,
    valueType: "multi-select",
    options: sharedOption,
  }, "OD_"), undefined);
  const legacy = {
    ...fhir.observations[0]!,
    component: [{
      code: { coding: [{ code: "OD_shared" }] },
      valueBoolean: true,
    }],
  };
  assert.deepEqual(observationCustomValue(legacy, {
    localCode: first.localCode,
    valueType: "multi-select",
    options: sharedOption,
  }, "OD_"), ["shared"]);

  const rejectedState = await handleCustomSectionCaptureRequest(clinicalDeps("provider", fhir, definitions), {
    authHeader: AUTH,
    params: { stableKey: body.definition.stableKey },
    body: {
      patientReference: "Patient/p-multi",
      encounterReference: "Encounter/e-multi",
      eyes: { OD: { state: "normal", customFields: [] } },
    },
  });
  assert.equal(rejectedState.status, 400);
  assert.deepEqual(rejectedState.body, { error: "Exam state and other text are only supported for ocular-health structures." });
  const rejectedOther = await handleCustomSectionCaptureRequest(clinicalDeps("provider", fhir, definitions), {
    authHeader: AUTH,
    params: { stableKey: body.definition.stableKey },
    body: {
      patientReference: "Patient/p-multi",
      encounterReference: "Encounter/e-multi",
      eyes: { OD: { customFields: [], other: "Clear." } },
    },
  });
  assert.equal(rejectedOther.status, 400);
  assert.equal(fhir.observations.length, 2);
});

test("bare-string ocular-health seeds keep the current definition and presence-only history shape", async () => {
  const [definition] = buildOcularHealthDefinitions([{
    key: "synthetic-bare",
    display: "Synthetic Bare",
    normalTemplate: "Synthetic normal.",
    priority: ["bare finding"],
    additional: ["other finding"],
  }], "ocular-health:synthetic:", SYNTHETIC_PROVENANCE);
  assert.ok(definition);
  assert.deepEqual(definition.valueSchema, {
    type: "ocular-health-structure",
    perEye: true,
    fields: {
      CUSTOM_ABNORMAL_FINDINGS_01: {
        localCode: "CUSTOM_ABNORMAL_FINDINGS_01",
        display: "Abnormal findings",
        origin: "practice",
        valueType: "multi-select",
        options: [
          { code: "bare-finding", display: "bare finding", active: true, priority: true },
          { code: "other-finding", display: "other finding", active: true, priority: false },
        ],
        order: 0,
        active: true,
      },
    },
  });

  const fhir = new MemoryFhir();
  const capture = await handleCustomSectionCaptureRequest(
    clinicalDeps("provider", fhir, [definition]),
    {
      authHeader: AUTH,
      params: { stableKey: definition.stableKey },
      body: {
        patientReference: "Patient/p-bare",
        encounterReference: "Encounter/e-bare",
        eyes: {
          OD: {
            state: "abnormal",
            customFields: [{ code: "CUSTOM_ABNORMAL_FINDINGS_01", value: ["bare-finding"] }],
          },
        },
      },
    },
  );
  assert.equal(capture.status, 200, JSON.stringify(capture.body));
  const captureReference = (capture.body as {
    eyes: { OD: { observationReference: string } };
  }).eyes.OD.observationReference;
  assert.equal(captureReference, `Observation/${fhir.observations[0]?.id}`);
  const history = await handleCustomSectionHistoryRequest(
    clinicalDeps("provider", fhir, [definition]),
    {
      authHeader: AUTH,
      params: { stableKey: definition.stableKey },
      query: { patient: "Patient/p-bare", encounter: "Encounter/e-bare" },
    },
  );
  assert.deepEqual((history.body as { rows: unknown[] }).rows, [{
    observationReference: captureReference,
    recordedAt: NOW,
    eye: "OD",
    values: [{
      code: "CUSTOM_ABNORMAL_FINDINGS_01",
      label: "Abnormal findings",
      value: ["bare-finding"],
    }],
    state: "abnormal",
  }]);
});

test("finding qualifiers round-trip all four kinds independently by finding and eye", async () => {
  const structures: StructureSeed[] = [{
    key: "synthetic-qualified",
    display: "Synthetic Qualified",
    normalTemplate: "Synthetic normal.",
    priority: [
      {
        key: "finding-a",
        display: "Finding A",
        qualifiers: [
          { kind: "graded", key: "grade", display: "Grade", options: ["trace", "marked"], scheme: "synthetic-scheme" },
          {
            kind: "enum",
            key: "stability",
            display: "Stability",
            options: [
              { code: "stable", display: "Stable" },
              { code: "progressive", display: "Progressive" },
            ],
          },
          { kind: "numeric", key: "size", display: "Size", min: 0, max: 10, step: 0.5, unit: "mm" },
          { kind: "extent", key: "span", display: "Clock-hour span" },
        ],
      },
      {
        key: "finding-b",
        display: "Finding B",
        qualifiers: [{ kind: "graded", key: "grade", display: "Grade", options: ["low", "high"] }],
      },
    ],
    additional: [],
  }];
  const [definition] = buildOcularHealthDefinitions(
    structures,
    "ocular-health:synthetic:",
    SYNTHETIC_PROVENANCE,
  );
  assert.ok(definition);
  const field = Object.values(definition.valueSchema.fields as Record<string, {
    localCode: string;
    valueType: string;
    options?: Array<{ code: string; qualifiers?: unknown[] }>;
  }>).find((candidate) => candidate.valueType === "multi-select");
  assert.ok(field?.options);
  assert.deepEqual(field.options.find((option) => option.code === "finding-a")?.qualifiers, structures[0]!.priority[0] &&
    typeof structures[0]!.priority[0] !== "string" ? structures[0]!.priority[0].qualifiers : undefined);
  assert.equal(customFieldOptionInputSchema.safeParse(field.options[0]).success, true);

  const odDetails = {
    "finding-a": {
      grade: "trace",
      stability: "stable",
      size: 2.5,
      span: { from: 2, to: 5, clockwise: true },
    },
    "finding-b": { grade: "high" },
  };
  const osDetails = {
    "finding-a": {
      grade: "marked",
      stability: "progressive",
      size: 4,
      span: { from: 10, to: 1, clockwise: false },
    },
  };
  const fhir = new MemoryFhir();
  const capture = await handleCustomSectionCaptureRequest(
    clinicalDeps("provider", fhir, [definition]),
    {
      authHeader: AUTH,
      params: { stableKey: definition.stableKey },
      body: {
        patientReference: "Patient/p-qualified",
        encounterReference: "Encounter/e-qualified",
        eyes: {
          OD: {
            state: "abnormal",
            customFields: [{ code: field.localCode, value: ["finding-a", "finding-b"] }],
            findingDetails: odDetails,
          },
          OS: {
            state: "abnormal",
            customFields: [{ code: field.localCode, value: ["finding-a"] }],
            findingDetails: osDetails,
          },
        },
      },
    },
  );
  assert.equal(capture.status, 200, JSON.stringify(capture.body));
  const code = (eye: "OD" | "OS", finding: string, qualifier: string) =>
    `${eye}_${field.localCode}::${finding}::${qualifier}`;
  assert.equal(component(fhir.observations[0], code("OD", "finding-a", "grade"))?.valueCodeableConcept?.coding?.[0]?.code, "trace");
  assert.equal(component(fhir.observations[0], code("OD", "finding-a", "stability"))?.valueCodeableConcept?.coding?.[0]?.code, "stable");
  assert.equal(component(fhir.observations[0], code("OD", "finding-a", "size"))?.valueQuantity?.value, 2.5);
  assert.equal(component(fhir.observations[0], code("OD", "finding-a", "size"))?.valueQuantity?.unit, "mm");
  assert.equal(component(fhir.observations[0], code("OD", "finding-a", "span"))?.valueString, '{"from":2,"to":5,"clockwise":true}');
  assert.equal(component(fhir.observations[0], code("OD", "finding-b", "grade"))?.valueCodeableConcept?.coding?.[0]?.code, "high");
  assert.equal(component(fhir.observations[1], code("OS", "finding-a", "grade"))?.valueCodeableConcept?.coding?.[0]?.code, "marked");
  assert.equal(component(fhir.observations[0], `OD_${field.localCode}::finding-a`)?.valueBoolean, true);
  assert.equal(component(fhir.observations[0], `OD_${field.localCode}::finding-b`)?.valueBoolean, true);

  const history = await handleCustomSectionHistoryRequest(
    clinicalDeps("provider", fhir, [definition]),
    {
      authHeader: AUTH,
      params: { stableKey: definition.stableKey },
      query: { patient: "Patient/p-qualified", encounter: "Encounter/e-qualified" },
    },
  );
  const rows = (history.body as {
    rows: Array<{ eye: string; values: Array<{ value: string[] }>; findingDetails?: unknown }>;
  }).rows;
  assert.deepEqual(rows.map((row) => [row.eye, row.values[0]?.value, row.findingDetails]), [
    ["OD", ["finding-a", "finding-b"], odDetails],
    ["OS", ["finding-a"], osDetails],
  ]);

  const invalidFhir = new MemoryFhir();
  const invalid = await handleCustomSectionCaptureRequest(
    clinicalDeps("provider", invalidFhir, [definition]),
    {
      authHeader: AUTH,
      params: { stableKey: definition.stableKey },
      body: {
        patientReference: "Patient/p-invalid-extent",
        encounterReference: "Encounter/e-invalid-extent",
        eyes: {
          OD: {
            state: "abnormal",
            customFields: [{ code: field.localCode, value: ["finding-a"] }],
            findingDetails: {
              "finding-a": { span: { from: 0, to: 13, clockwise: true } },
            },
          },
        },
      },
    },
  );
  assert.equal(invalid.status, 400);
  assert.equal(invalidFhir.observations.length, 0);

  const storedExtent = component(fhir.observations[0], code("OD", "finding-a", "span"));
  assert.ok(storedExtent);
  storedExtent.valueString = '{"from":0,"to":13,"clockwise":true}';
  const readInvalid = await handleCustomSectionHistoryRequest(
    clinicalDeps("provider", fhir, [definition]),
    {
      authHeader: AUTH,
      params: { stableKey: definition.stableKey },
      query: { patient: "Patient/p-qualified", encounter: "Encounter/e-qualified" },
    },
  );
  const invalidRows = (readInvalid.body as {
    rows: Array<{ eye: string; findingDetails?: Record<string, Record<string, unknown>> }>;
  }).rows;
  assert.equal(invalidRows[0]?.findingDetails?.["finding-a"]?.span, undefined);
});

test("ocular-health saves round-trip normal and abnormal interpretations without interpreting deferred", async () => {
  const fhir = new MemoryFhir();
  const definitions = await catalog(fhir);
  const lids = definitions.find((definition) =>
    definition.stableKey === "ocular-health:anterior:lids-lashes"
  );
  const palpebral = definitions.find((definition) =>
    definition.stableKey === "ocular-health:anterior:palpebral-conjunctiva"
  );
  assert.ok(lids && palpebral);

  const interpreted = await handleCustomSectionCaptureRequest(
    clinicalDeps("provider", fhir, definitions),
    {
      authHeader: AUTH,
      params: { stableKey: lids.stableKey },
      body: {
        patientReference: "Patient/exam-overview-interpretation",
        encounterReference: "Encounter/exam-overview-interpretation",
        eyes: {
          OD: { state: "abnormal", customFields: [] },
          OS: { state: "normal", customFields: [] },
        },
      },
    },
  );
  assert.equal(interpreted.status, 200, JSON.stringify(interpreted.body));
  const deferred = await handleCustomSectionCaptureRequest(
    clinicalDeps("provider", fhir, definitions),
    {
      authHeader: AUTH,
      params: { stableKey: palpebral.stableKey },
      body: {
        patientReference: "Patient/exam-overview-interpretation",
        encounterReference: "Encounter/exam-overview-interpretation",
        eyes: {
          OD: {
            state: "deferred",
            customFields: [],
            other: "Patient declined lid eversion.",
          },
        },
      },
    },
  );
  assert.equal(deferred.status, 200, JSON.stringify(deferred.body));

  assert.deepEqual(fhir.observations[0]?.interpretation, [{
    coding: [{
      system: "http://terminology.hl7.org/CodeSystem/v3-ObservationInterpretation",
      code: "A",
      display: "Abnormal",
    }],
  }]);
  assert.deepEqual(fhir.observations[1]?.interpretation, [{
    coding: [{
      system: "http://terminology.hl7.org/CodeSystem/v3-ObservationInterpretation",
      code: "N",
      display: "Normal",
    }],
  }]);
  assert.equal(fhir.observations[2]?.interpretation, undefined);
  assert.deepEqual(fhir.observations.map((observation) =>
    component(observation, "EXAM_STATE")?.valueString
  ), ["abnormal", "normal", "deferred"]);

  const projection = buildExamOverviewProjection({
    encounterReference: "Encounter/exam-overview-interpretation",
    patientReference: "Patient/exam-overview-interpretation",
    definitions,
    currentObservations: fhir.observations,
    priorObservationCandidates: [],
    assessmentRows: [],
  });
  assert.deepEqual(projection.findings.map((finding) => [
    finding.findingKey,
    finding.laterality,
    finding.interpretation,
    finding.examination.state,
  ]), [
    ["ocular-health:anterior:lids-lashes", "OD", "abnormal", "examined"],
    ["ocular-health:anterior:lids-lashes", "OS", "normal", "examined"],
    ["ocular-health:anterior:palpebral-conjunctiva", "OD", "unknown", "deferred-with-reason"],
  ]);
});

test("OH-1 seeds nine editable structures and persists explicit normal, abnormal, nested, other, and deferred states", async () => {
  const fhir = new MemoryFhir();
  const definitions = await catalog(fhir);
  const anterior = definitions.filter((definition) => definition.stableKey.startsWith("ocular-health:anterior:"));
  assert.equal(anterior.length, 9);
  assert.equal(anterior.every((definition) => definition.valueSchema.perEye === true), true);
  assert.deepEqual(anterior.filter((definition) => definition.allowDiagnosisMapping).map((definition) => definition.stableKey), [
    "ocular-health:anterior:lids-lashes",
    "ocular-health:anterior:palpebral-conjunctiva",
    "ocular-health:anterior:conjunctiva",
    "ocular-health:anterior:tear-film",
    "ocular-health:anterior:cornea",
    "ocular-health:anterior:anterior-chamber",
    "ocular-health:anterior:iris",
    "ocular-health:anterior:lens",
  ]);
  assert.equal(anterior.filter((definition) => !definition.allowDiagnosisMapping)
    .every((definition) => definition.diagnosisCandidates === undefined), true);
  assert.equal(anterior.every((definition) => definition.notBillReady), true);

  const lids = anterior.find((definition) => definition.stableKey.endsWith(":lids-lashes"));
  assert.ok(lids);
  const field = Object.values(lids.valueSchema.fields as Record<string, {
    valueType?: string;
    localCode?: string;
    options?: Array<{ code: string; display: string; priority?: boolean }>;
  }>)
    .find((candidate) => candidate.valueType === "multi-select");
  assert.ok(field?.localCode && field.options);
  assert.equal(field.options.some((option) => option.code === "blepharitis"), false);
  assert.equal(field.options.find((option) => option.code === "trichiasis")?.priority, true);
  assert.equal(lids.diagnosisCandidates?.some((candidate) => candidate.trigger.kind === "option"
    && candidate.trigger.anyOf.includes("blepharitis")), false);

  const conjunctiva = anterior.find((definition) => definition.stableKey.endsWith(":conjunctiva"));
  assert.ok(conjunctiva);
  const conjunctivaField = Object.values(conjunctiva.valueSchema.fields as Record<string, {
    valueType?: string;
    options?: Array<{ code: string; priority?: boolean }>;
  }>).find((candidate) => candidate.valueType === "multi-select");
  assert.equal(conjunctivaField?.options?.some((option) => option.code === "papillae"), false);
  assert.equal(conjunctivaField?.options?.some((option) => option.code === "follicles"), false);
  const captured = await handleCustomSectionCaptureRequest(clinicalDeps("provider", fhir, anterior), {
    authHeader: AUTH,
    params: { stableKey: lids.stableKey },
    body: {
      patientReference: "Patient/p3",
      encounterReference: "Encounter/e3",
      eyes: {
        OD: {
          state: "abnormal",
          customFields: [{ code: field.localCode, value: ["demodex", "demodex::collarettes"] }],
          other: "Trace sleeves.",
        },
        OS: { state: "normal", customFields: [] },
      },
    },
  });
  assert.equal(captured.status, 200, JSON.stringify(captured.body));
  assert.equal(component(fhir.observations[0], "EXAM_STATE")?.valueString, "abnormal");
  assert.equal(component(fhir.observations[0], `OD_${field.localCode}::demodex`)?.valueBoolean, true);
  assert.equal(component(fhir.observations[0], `OD_${field.localCode}::demodex::collarettes`)?.valueBoolean, true);
  assert.equal(component(fhir.observations[0], "OTHER")?.valueString, "Trace sleeves.");
  assert.equal(component(fhir.observations[1], "EXAM_STATE")?.valueString, "normal");
  assert.equal(component(fhir.observations[1], "NORMAL_TEMPLATE")?.valueString, lids.normalSemantics?.template);

  const history = await handleCustomSectionHistoryRequest(clinicalDeps("provider", fhir, anterior), {
    authHeader: AUTH,
    params: { stableKey: lids.stableKey },
    query: { patient: "Patient/p3", encounter: "Encounter/e3" },
  });
  const rows = (history.body as { rows: Array<{ eye: string; state: string; values: Array<{ value: string[] }>; other?: string }> }).rows;
  assert.deepEqual(rows.map((row) => [row.eye, row.state]), [["OD", "abnormal"], ["OS", "normal"]]);
  assert.deepEqual(rows[0]?.values[0]?.value, ["demodex", "demodex::collarettes"]);
  assert.equal(rows[0]?.other, "Trace sleeves.");

  const missingOtherState = await handleCustomSectionCaptureRequest(clinicalDeps("provider", fhir, anterior), {
    authHeader: AUTH,
    params: { stableKey: lids.stableKey },
    body: {
      patientReference: "Patient/p3",
      encounterReference: "Encounter/e3",
      eyes: { OD: { customFields: [], other: "Trace sleeves." } },
    },
  });
  assert.equal(missingOtherState.status, 400);
  assert.deepEqual(missingOtherState.body, {
    error: "Ocular-health Other text requires choosing Normal, Abnormal, or Deferred for that eye, or clearing the text.",
  });
  assert.equal(fhir.observations.length, 2);

  const palpebral = anterior.find((definition) => definition.stableKey.endsWith(":palpebral-conjunctiva"));
  assert.ok(palpebral);
  const deferred = await handleCustomSectionCaptureRequest(clinicalDeps("provider", fhir, anterior), {
    authHeader: AUTH,
    params: { stableKey: palpebral.stableKey },
    body: {
      patientReference: "Patient/p3",
      encounterReference: "Encounter/e3",
      eyes: {
        OD: { state: "deferred", customFields: [], other: "Patient declined lid eversion." },
        OS: { state: "normal", customFields: [] },
      },
    },
  });
  assert.equal(deferred.status, 200, JSON.stringify(deferred.body));
  assert.equal(component(fhir.observations[2], "EXAM_STATE")?.valueString, "deferred");

  for (const definition of anterior.filter((candidate) => candidate !== lids && candidate !== palpebral)) {
    const result = await handleCustomSectionCaptureRequest(clinicalDeps("provider", fhir, anterior), {
      authHeader: AUTH,
      params: { stableKey: definition.stableKey },
      body: {
        patientReference: "Patient/p3",
        encounterReference: "Encounter/e3",
        eyes: {
          OD: { state: "normal", customFields: [] },
          OS: { state: "normal", customFields: [] },
        },
      },
    });
    assert.equal(result.status, 200, `${definition.display}: ${JSON.stringify(result.body)}`);
  }
  assert.equal(fhir.observations.length, 18);

  const unknown = await handleCustomSectionCaptureRequest(clinicalDeps("provider", fhir, anterior), {
    authHeader: AUTH,
    params: { stableKey: lids.stableKey },
    body: {
      patientReference: "Patient/p3",
      encounterReference: "Encounter/e3",
      eyes: { OD: { state: "abnormal", customFields: [{ code: field.localCode, value: ["invented-finding"] }] } },
    },
  });
  assert.equal(unknown.status, 400);
  assert.match(String((unknown.body as { error: string }).error), /unknown or inactive option/);
});

test("OH-1 finding options and normal templates are editable through finding-definition HTTP handlers", async () => {
  const fhir = new MemoryFhir();
  const definitions = await catalog(fhir);
  const cornea = definitions.find((definition) => definition.stableKey === "ocular-health:anterior:cornea");
  assert.ok(cornea);
  const field = Object.values(cornea.valueSchema.fields as Record<string, { valueType?: string; localCode?: string; options?: Array<Record<string, unknown>> }>)
    .find((candidate) => candidate.valueType === "multi-select");
  assert.ok(field?.localCode && field.options);
  const options = [
    ...field.options.map((option) => option.code === "arcus" ? { ...option, active: false } : option),
    { code: "practice-finding", display: "Practice finding", active: true },
  ];
  const updated = await handleFindingDefinitionMutationRequest(definitionDeps("admin", fhir, "unused000"), {
    authHeader: AUTH,
    params: { stableKey: cornea.stableKey },
    body: { action: "update-custom-field", localCode: field.localCode, options },
  });
  assert.equal(updated.status, 200, JSON.stringify(updated.body));
  const templated = await handleFindingDefinitionMutationRequest(definitionDeps("admin", fhir, "unused000"), {
    authHeader: AUTH,
    params: { stableKey: cornea.stableKey },
    body: { action: "update-normal-template", template: "Practice-normal cornea." },
  });
  assert.equal(templated.status, 200, JSON.stringify(templated.body));

  const stored = await catalog(fhir);
  const storedCornea = stored.find((definition) => definition.stableKey === cornea.stableKey);
  assert.equal(storedCornea?.normalSemantics?.template, "Practice-normal cornea.");
  const storedField = Object.values(storedCornea?.valueSchema.fields as Record<string, { localCode?: string; options?: Array<{ code: string; active: boolean }> }>)
    .find((candidate) => candidate.localCode === field.localCode);
  assert.equal(storedField?.options?.find((option) => option.code === "arcus")?.active, false);
  assert.equal(storedField?.options?.find((option) => option.code === "practice-finding")?.active, true);

  const seededCandidate = storedCornea?.diagnosisCandidates?.find((candidate) => candidate.diagnosisKey === "keratoconus_stable");
  assert.ok(seededCandidate);
  const mappingUpdate = await handleFindingDefinitionMutationRequest(definitionDeps("admin", fhir, "unused000"), {
    authHeader: AUTH,
    params: { stableKey: cornea.stableKey },
    body: { action: "update-diagnosis-candidate", id: seededCandidate.id, active: false },
  });
  assert.equal(mappingUpdate.status, 200, JSON.stringify(mappingUpdate.body));
  const editedCornea = (await catalog(fhir)).find((definition) => definition.stableKey === cornea.stableKey);
  assert.equal(editedCornea?.diagnosisCandidates?.find((candidate) => candidate.id === seededCandidate.id)?.active, false);
});

test("ocular-health cleanup keeps only clinically scoped chips and qualifiers", async () => {
  const definitions = await catalog(new MemoryFhir());
  const definition = (stableKey: string) => {
    const found = definitions.find((candidate) => candidate.stableKey === stableKey);
    assert.ok(found, stableKey);
    return found;
  };
  const fields = (stableKey: string) => Object.values(definition(stableKey).valueSchema.fields as Record<string, {
    display: string;
    valueType: string;
    options?: Array<{
      code: string;
      display: string;
      priority?: boolean;
      qualifiers?: Array<Record<string, unknown>>;
    }>;
  }>);
  const findings = (stableKey: string) => fields(stableKey)
    .find((field) => field.valueType === "multi-select")?.options ?? [];

  const conjunctiva = findings("ocular-health:anterior:conjunctiva");
  assert.deepEqual(
    conjunctiva.filter((option) => ["papillae", "follicles", "scleral-injection"].includes(option.code)),
    [],
  );
  assert.deepEqual(
    ["injection", "episcleritis", "scleritis"].map((code) => conjunctiva.some((option) => option.code === code)),
    [true, true, true],
  );

  const tearFilm = findings("ocular-health:anterior:tear-film");
  assert.equal(tearFilm.some((option) => option.code === "increased-decreased-lake"), false);
  assert.equal(tearFilm.some((option) => option.code === "frothing"), false);
  assert.deepEqual(tearFilm.find((option) => option.code === "foam"), {
    code: "foam",
    display: "foam/frothing",
    active: true,
    priority: false,
  });
  assert.equal(tearFilm.some((option) => option.code === "reduced-tear-meniscus"), true);

  const cornea = findings("ocular-health:anterior:cornea");
  assert.equal(cornea.some((option) => option.code === "corneal-staining"), false);
  const spk = cornea.find((option) => option.code === "superficial-punctate-keratitis-spk");
  assert.deepEqual(spk?.qualifiers, [
    {
      kind: "graded",
      key: "grade",
      display: "Corneal staining grade (grading scheme provisional)",
      options: ["Grade 0", "Grade 1", "Grade 2", "Grade 3", "Grade 4"],
      scheme: "grading scheme provisional",
    },
    {
      kind: "enum",
      key: "zone",
      display: "Corneal staining zone (grading scheme provisional)",
      options: [
        { code: "central", display: "Central" },
        { code: "nasal", display: "Nasal" },
        { code: "temporal", display: "Temporal" },
        { code: "superior", display: "Superior" },
        { code: "inferior", display: "Inferior" },
        { code: "diffuse", display: "Diffuse" },
      ],
    },
  ]);
  assert.deepEqual(
    fields("ocular-health:anterior:cornea")
      .filter((field) => field.display.startsWith("Corneal staining")),
    [],
  );
  assert.deepEqual(
    fields("ocular-health:anterior:cornea")
      .find((field) => field.display === "Vital dye")?.options?.map((option) => option.display),
    ["Fluorescein"],
  );

  const lens = findings("ocular-health:anterior:lens");
  const lensGrades = [
    "nuclear-sclerosis",
    "cortical-cataract",
    "posterior-subcapsular-psc",
    "posterior-capsular-opacification-pco",
    "mixed",
  ];
  for (const code of lensGrades) {
    assert.deepEqual(lens.find((option) => option.code === code)?.qualifiers, [{
      kind: "graded",
      key: "grade",
      display: "Grade",
      options: ["1+", "2+", "3+", "4+"],
    }], code);
  }
  assert.equal(
    lens.find((option) => option.code === "posterior-capsular-opacification-pco")?.display,
    "posterior capsular opacification (PCO) (after cataract)",
  );
  assert.equal(lens.find((option) => option.code === "mixed")?.priority, true);
  assert.equal(fields("ocular-health:anterior:lens").some((field) => field.display.startsWith("LOCS III")), false);

  const retinalDetachment = findings("ocular-health:posterior:periphery")
    .find((option) => option.code === "retinal-detachment");
  assert.deepEqual(retinalDetachment?.qualifiers, [{
    kind: "enum",
    key: "macula-status",
    display: "Macula",
    options: [
      { code: "macula-on", display: "Macula on" },
      { code: "macula-off", display: "Macula off" },
    ],
  }]);
});

test("anterior chamber cells and flare expose the operator-adapted SUN-derived options through the lens graded-qualifier shape", async () => {
  const definitions = await catalog(new MemoryFhir());
  const anteriorChamber = definitions.find((definition) =>
    definition.stableKey === "ocular-health:anterior:anterior-chamber"
  );
  const lens = definitions.find((definition) =>
    definition.stableKey === "ocular-health:anterior:lens"
  );
  assert.ok(anteriorChamber && lens);
  const findings = (definition: ClinicalFindingDefinition) => Object.values(
    definition.valueSchema.fields as Record<string, {
      valueType?: string;
      options?: Array<{
        code: string;
        qualifiers?: Array<Record<string, unknown>>;
      }>;
    }>,
  ).find((field) => field.valueType === "multi-select")?.options ?? [];
  const lensQualifier = findings(lens)
    .find((finding) => finding.code === "nuclear-sclerosis")
    ?.qualifiers?.[0];
  assert.ok(lensQualifier);

  const expected = {
    cells: [
      "Trace (1–5)",
      "1+ (6–15)",
      "2+ (16–25)",
      "3+ (26–50)",
      "4+ (>50)",
    ],
    flare: [
      "1+ (faint)",
      "2+ (moderate; iris and lens clear)",
      "3+ (marked; iris and lens hazy)",
      "4+ (intense; fibrin or plastic aqueous)",
    ],
  };
  for (const [findingCode, options] of Object.entries(expected)) {
    const qualifier = findings(anteriorChamber)
      .find((finding) => finding.code === findingCode)
      ?.qualifiers?.[0];
    assert.ok(qualifier, findingCode);
    assert.deepEqual(
      [qualifier.kind, qualifier.key, qualifier.display],
      [lensQualifier.kind, lensQualifier.key, lensQualifier.display],
      findingCode,
    );
    assert.deepEqual(qualifier, {
      kind: "graded",
      key: "grade",
      display: "Grade",
      options,
      scheme: "SUN-derived (ODOS present-finding scale)",
    }, findingCode);
  }
});

test("anterior chamber cell and flare grades round-trip without setting the sibling axis", async () => {
  const fhir = new MemoryFhir();
  const definitions = await catalog(fhir);
  const anteriorChamber = definitions.find((definition) =>
    definition.stableKey === "ocular-health:anterior:anterior-chamber"
  );
  assert.ok(anteriorChamber);
  const findingField = Object.values(anteriorChamber.valueSchema.fields as Record<string, {
    localCode?: string;
    valueType?: string;
  }>).find((field) => field.valueType === "multi-select");
  assert.ok(findingField?.localCode);
  const cellGrade = "2+ (16–25)";
  const flareGrade = "1+ (faint)";

  const capture = await handleCustomSectionCaptureRequest(
    clinicalDeps("provider", fhir, definitions),
    {
      authHeader: AUTH,
      params: { stableKey: anteriorChamber.stableKey },
      body: {
        patientReference: "Patient/p-sun-grades",
        encounterReference: "Encounter/e-sun-grades",
        eyes: {
          OD: {
            state: "abnormal",
            customFields: [{ code: findingField.localCode, value: ["cells", "flare"] }],
            findingDetails: { cells: { grade: cellGrade } },
          },
          OS: {
            state: "abnormal",
            customFields: [{ code: findingField.localCode, value: ["cells", "flare"] }],
            findingDetails: { flare: { grade: flareGrade } },
          },
        },
      },
    },
  );
  assert.equal(capture.status, 200, JSON.stringify(capture.body));
  const qualifierCode = (eye: "OD" | "OS", finding: "cells" | "flare") =>
    `${eye}_${findingField.localCode}::${finding}::grade`;
  assert.equal(
    component(fhir.observations[0], qualifierCode("OD", "cells"))
      ?.valueCodeableConcept?.coding?.[0]?.code,
    cellGrade,
  );
  assert.equal(component(fhir.observations[0], qualifierCode("OD", "flare")), undefined);
  assert.equal(component(fhir.observations[1], qualifierCode("OS", "cells")), undefined);
  assert.equal(
    component(fhir.observations[1], qualifierCode("OS", "flare"))
      ?.valueCodeableConcept?.coding?.[0]?.code,
    flareGrade,
  );

  const history = await handleCustomSectionHistoryRequest(
    clinicalDeps("provider", fhir, definitions),
    {
      authHeader: AUTH,
      params: { stableKey: anteriorChamber.stableKey },
      query: {
        patient: "Patient/p-sun-grades",
        encounter: "Encounter/e-sun-grades",
      },
    },
  );
  const rows = (history.body as {
    rows: Array<{
      eye: string;
      findingDetails?: Record<string, Record<string, string>>;
    }>;
  }).rows;
  assert.deepEqual(rows.map((row) => [row.eye, row.findingDetails]), [
    ["OD", { cells: { grade: cellGrade } }],
    ["OS", { flare: { grade: flareGrade } }],
  ]);
});

test("GET diagnosis candidates returns nuclear cataract after ocular-health capture regardless of grade", async (t) => {
  const fhir = new MemoryFhir();
  const definitions = await catalog(fhir);
  const lens = definitions.find((definition) => definition.stableKey === "ocular-health:anterior:lens");
  assert.ok(lens);
  const field = Object.values(lens.valueSchema.fields as Record<string, {
    localCode: string;
    valueType: string;
  }>).find((candidate) => candidate.valueType === "multi-select");
  assert.ok(field);
  assert.deepEqual(
    lens.diagnosisCandidates?.map((candidate) => [
      candidate.trigger.kind === "option" ? candidate.trigger.anyOf[0] : candidate.trigger.option,
      candidate.diagnosisKey,
    ]),
    [
      ["nuclear-sclerosis", "cataract_nuclear_sclerosis"],
      ["cortical-cataract", "cataract_cortical"],
      ["anterior-subcapsular", "cataract_anterior_subcapsular"],
      ["posterior-subcapsular-psc", "cataract_posterior_subcapsular"],
      ["mixed", "cataract_combined_forms"],
      ["posterior-capsular-opacification-pco", "cataract_posterior_capsular_opacification"],
      ["pseudophakia-pciol", "pseudophakia"],
      ["aphakia", "aphakia"],
      ["pseudoexfoliation", "pseudoexfoliation_lens"],
    ],
  );
  assert.equal(
    lens.diagnosisCandidates?.some((candidate) =>
      candidate.trigger.kind === "option" && candidate.trigger.anyOf.includes("dislocated-lens-iol")
    ),
    false,
  );

  const capture = await handleCustomSectionCaptureRequest(clinicalDeps("provider", fhir, [lens]), {
    authHeader: AUTH,
    params: { stableKey: lens.stableKey },
    body: {
      patientReference: "Patient/lens-mapping",
      encounterReference: "Encounter/lens-mapping",
      eyes: {
        OD: {
          state: "abnormal",
          customFields: [{ code: field.localCode, value: ["nuclear-sclerosis"] }],
          findingDetails: { "nuclear-sclerosis": { grade: "1+" } },
        },
        OS: {
          state: "abnormal",
          customFields: [{ code: field.localCode, value: ["nuclear-sclerosis"] }],
          findingDetails: { "nuclear-sclerosis": { grade: "4+" } },
        },
      },
    },
  });
  assert.equal(capture.status, 200, JSON.stringify(capture.body));
  const app = express();
  app.get("/clinical-graph/encounters/:encounterId/diagnosis-candidates", async (req, res) => {
    const result = await handleDiagnosisCandidatesRequest({
      authenticate: async () => ({
        staffReference: "Practitioner/doc-1",
        actorRole: "provider",
        fhir,
      }),
      now: () => NOW,
    }, {
      authHeader: req.header("authorization"),
      params: req.params,
    });
    res.status(result.status).json(result.body);
  });
  const listener = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => listener.once("listening", resolve));
  t.after(() => listener.close());
  const base = `http://127.0.0.1:${(listener.address() as AddressInfo).port}`;
  const response = await fetch(`${base}/clinical-graph/encounters/lens-mapping/diagnosis-candidates`, {
    headers: { Authorization: AUTH },
  });
  const candidates = await response.json() as {
    findings: Array<{ candidates: Array<{ diagnosisKey: string }> }>;
  };
  assert.equal(response.status, 200, JSON.stringify(candidates));
  const findings = candidates.findings;
  assert.deepEqual(findings.map((finding) => finding.candidates.map((candidate) => candidate.diagnosisKey)), [
    ["cataract_nuclear_sclerosis"],
    ["cataract_nuclear_sclerosis"],
  ]);
});

test("retinal-detachment macula status remains documentation-only for diagnosis proposals", async () => {
  const fhir = new MemoryFhir();
  const definitions = await catalog(fhir);
  const periphery = definitions.find((definition) => definition.stableKey === "ocular-health:posterior:periphery");
  assert.ok(periphery);
  const field = Object.values(periphery.valueSchema.fields as Record<string, {
    localCode: string;
    valueType: string;
  }>).find((candidate) => candidate.valueType === "multi-select");
  assert.ok(field);
  const capture = await handleCustomSectionCaptureRequest(clinicalDeps("provider", fhir, [periphery]), {
    authHeader: AUTH,
    params: { stableKey: periphery.stableKey },
    body: {
      patientReference: "Patient/retinal-detachment-mapping",
      encounterReference: "Encounter/retinal-detachment-mapping",
      eyes: {
        OD: {
          state: "abnormal",
          customFields: [{ code: field.localCode, value: ["retinal-detachment"] }],
          findingDetails: { "retinal-detachment": { "macula-status": "macula-on" } },
        },
        OS: {
          state: "abnormal",
          customFields: [{ code: field.localCode, value: ["retinal-detachment"] }],
          findingDetails: { "retinal-detachment": { "macula-status": "macula-off" } },
        },
      },
    },
  });
  assert.equal(capture.status, 200, JSON.stringify(capture.body));
  const candidates = await handleDiagnosisCandidatesRequest({
    authenticate: async () => ({
      staffReference: "Practitioner/doc-1",
      actorRole: "provider",
      fhir,
    }),
    now: () => NOW,
  }, {
    authHeader: AUTH,
    params: { encounterId: "retinal-detachment-mapping" },
  });
  assert.equal(candidates.status, 200, JSON.stringify(candidates.body));
  const findings = (candidates.body as {
    findings: Array<{ candidates: Array<{ diagnosisKey: string }> }>;
  }).findings;
  assert.deepEqual(findings.map((finding) => finding.candidates.map((candidate) => candidate.diagnosisKey)), [
    ["retinal_detachment_single_break"],
    ["retinal_detachment_single_break"],
  ]);
});

test("posterior drusen seeds preserve leaf ids and add staged-family targets in ruled order", async () => {
  const definitions = await catalog(new MemoryFhir());
  const targets = (stableKey: string) => definitions.find((definition) => definition.stableKey === stableKey)
    ?.diagnosisCandidates?.filter((candidate) => candidate.trigger.kind === "option" &&
      candidate.trigger.anyOf.some((option) => option === "drusen" || option === "occasional-drusen" || option === "dry-amd" || option === "wet-amd"))
    .map((candidate) => ({
      option: candidate.trigger.kind === "option" ? candidate.trigger.anyOf[0] : undefined,
      id: candidate.id,
      ...("diagnosisKey" in candidate
        ? { diagnosisKey: candidate.diagnosisKey }
        : { familyGroup: candidate.familyGroup }),
    }));

  assert.deepEqual(targets("ocular-health:posterior:macula"), [
    { option: "drusen", id: "SEED_MACULAR_DRUSEN_1", diagnosisKey: "macular_drusen" },
    { option: "drusen", id: "SEED_NONEXUDATIVE-AMD_2", familyGroup: "nonexudative-amd" },
    { option: "dry-amd", id: "SEED_NONEXUDATIVE-AMD_3", familyGroup: "nonexudative-amd" },
    { option: "wet-amd", id: "SEED_EXUDATIVE-AMD_4", familyGroup: "exudative-amd" },
  ]);
  assert.deepEqual(targets("ocular-health:posterior:fundus")?.slice(-4), [
    { option: "drusen", id: "SEED_MACULAR_DRUSEN_26", diagnosisKey: "macular_drusen" },
    { option: "drusen", id: "SEED_NONEXUDATIVE-AMD_27", familyGroup: "nonexudative-amd" },
    { option: "occasional-drusen", id: "SEED_MACULAR_DRUSEN_28", diagnosisKey: "macular_drusen" },
  ]);
  assert.deepEqual(targets("ocular-health:posterior:periphery")?.slice(-3), [
    { option: "drusen", id: "SEED_MACULAR_DRUSEN_7", diagnosisKey: "macular_drusen" },
    { option: "drusen", id: "SEED_NONEXUDATIVE-AMD_8", familyGroup: "nonexudative-amd" },
    { option: "occasional-drusen", id: "SEED_MACULAR_DRUSEN_9", diagnosisKey: "macular_drusen" },
  ]);
  const macula = definitions.find((definition) => definition.stableKey === "ocular-health:posterior:macula");
  assert.equal(macula?.allowDiagnosisMapping, true);
  assert.equal(macula?.diagnosisCandidates?.length, 4);
});

test("OH-2 seeds five posterior structures and round-trips their worksheet findings per eye without diagnosis codes", async () => {
  const fhir = new MemoryFhir();
  const definitions = await catalog(fhir);
  const posterior = definitions.filter((definition) => definition.stableKey.startsWith("ocular-health:posterior:"));
  assert.deepEqual(posterior.map((definition) => definition.display), ["Vitreous", "Fundus", "Macula", "Vessels", "Periphery"]);
  assert.equal(posterior.every((definition) => definition.valueSchema.perEye === true), true);
  assert.deepEqual(posterior.filter((definition) => definition.allowDiagnosisMapping).map((definition) => definition.stableKey), [
    "ocular-health:posterior:vitreous",
    "ocular-health:posterior:fundus",
    "ocular-health:posterior:macula",
    "ocular-health:posterior:vessels",
    "ocular-health:posterior:periphery",
  ]);
  assert.equal(posterior.filter((definition) => !definition.allowDiagnosisMapping)
    .every((definition) => definition.diagnosisCandidates === undefined), true);
  assert.equal(posterior.every((definition) => definition.notBillReady), true);

  const expectedRefinements = new Map([
    ["Fundus", {
      priority: ["diabetic retinopathy (background/NPDR)", "hypertensive retinopathy", "dot/blot hemorrhage", "hard exudate", "cotton-wool spot", "choroidal nevus", "chorioretinal scar"],
      additional: ["microaneurysm", "proliferative diabetic retinopathy (PDR)", "neovascularization elsewhere (NVE)", "preretinal hemorrhage", "choroidal lesion", "RPE atrophy", "Roth spot", "myelinated nerve fiber", "drusen", "occasional drusen"],
    }],
    ["Periphery", {
      priority: ["lattice degeneration", "cobblestone/paving-stone degeneration", "retinal hole", "white-without-pressure", "chorioretinal scar"],
      additional: ["retinal tear", "retinal detachment", "retinoschisis", "retinal tuft", "pigmentary changes", "cystoid degeneration", "operculated hole", "horseshoe tear", "drusen", "occasional drusen"],
    }],
  ]);
  for (const [display, expected] of expectedRefinements) {
    const definition = posterior.find((candidate) => candidate.display === display);
    assert.ok(definition);
    const field = Object.values(definition.valueSchema.fields as Record<string, { valueType?: string; options?: Array<{ display: string; priority?: boolean }> }>)
      .find((candidate) => candidate.valueType === "multi-select");
    assert.deepEqual(field?.options?.filter((option) => option.priority).map((option) => option.display), expected.priority);
    assert.deepEqual(field?.options?.filter((option) => !option.priority).map((option) => option.display), expected.additional);
  }

  const expectedPriority = new Map([
    ["Vitreous", "posterior vitreous detachment (PVD)"],
    ["Fundus", "diabetic retinopathy (background/NPDR)"],
    ["Macula", "drusen"],
    ["Vessels", "AV nicking"],
    ["Periphery", "lattice degeneration"],
  ]);
  for (const definition of posterior) {
    const field = Object.values(definition.valueSchema.fields as Record<string, { valueType?: string; localCode?: string; options?: Array<{ code: string; display: string; priority?: boolean }> }>)
      .find((candidate) => candidate.valueType === "multi-select");
    assert.ok(field?.localCode && field.options);
    const option = field.options.find((candidate) => candidate.display === expectedPriority.get(definition.display));
    assert.ok(option?.priority, `${definition.display} should expose its worksheet priority finding`);
    const captured = await handleCustomSectionCaptureRequest(clinicalDeps("provider", fhir, posterior), {
      authHeader: AUTH,
      params: { stableKey: definition.stableKey },
      body: {
        patientReference: "Patient/p-posterior",
        encounterReference: "Encounter/e-posterior",
        eyes: {
          OD: { state: "abnormal", customFields: [{ code: field.localCode, value: [option.code] }] },
          OS: { state: "normal", customFields: [] },
        },
      },
    });
    assert.equal(captured.status, 200, `${definition.display}: ${JSON.stringify(captured.body)}`);
    assert.equal(component(fhir.observations.at(-2), `OD_${field.localCode}::${option.code}`)?.valueBoolean, true);
  }
  assert.equal(fhir.observations.length, 10);

  for (const definition of posterior) {
    const history = await handleCustomSectionHistoryRequest(clinicalDeps("provider", fhir, posterior), {
      authHeader: AUTH,
      params: { stableKey: definition.stableKey },
      query: { patient: "Patient/p-posterior", encounter: "Encounter/e-posterior" },
    });
    const rows = (history.body as { rows: Array<{ eye: string; state: string; values: Array<{ value: string[] }>; normalTemplate?: string }> }).rows;
    assert.deepEqual(rows.map((row) => row.state), ["abnormal", "normal"]);
    assert.equal(rows[0]!.values[0]!.value.length, 1);
    assert.equal(rows[1]!.normalTemplate, definition.normalSemantics?.template);
  }
});

test("ocular-health history returns the Observation reference written by the save", async () => {
  const fhir = new MemoryFhir();
  const definitions = await catalog(fhir);
  const lens = definitions.find((definition) => definition.stableKey === "ocular-health:anterior:lens");
  assert.ok(lens);
  const field = Object.values(lens.valueSchema.fields as Record<string, {
    localCode?: string;
    valueType?: string;
    options?: Array<{ code: string; active: boolean }>;
  }>).find((candidate) => candidate.valueType === "multi-select");
  const finding = field?.options?.find((option) => option.active);
  assert.ok(field?.localCode && finding);

  const capture = await handleCustomSectionCaptureRequest(clinicalDeps("provider", fhir, definitions), {
    authHeader: AUTH,
    params: { stableKey: lens.stableKey },
    body: {
      patientReference: "Patient/p-history-reference",
      encounterReference: "Encounter/e-history-reference",
      eyes: {
        OD: {
          state: "abnormal",
          customFields: [{ code: field.localCode, value: [finding.code] }],
        },
      },
    },
  });
  assert.equal(capture.status, 200, JSON.stringify(capture.body));
  const savedReference = (capture.body as { eyes: { OD: { observationReference: string } } })
    .eyes.OD.observationReference;
  const savedObservation = fhir.observations.find((observation) =>
    `Observation/${observation.id}` === savedReference
  );
  assert.ok(savedObservation);

  const history = await handleCustomSectionHistoryRequest(clinicalDeps("provider", fhir, definitions), {
    authHeader: AUTH,
    params: { stableKey: lens.stableKey },
    query: { patient: "Patient/p-history-reference", encounter: "Encounter/e-history-reference" },
  });
  assert.equal(history.status, 200, JSON.stringify(history.body));
  const historyReference = (history.body as {
    rows: Array<{ eye?: string; observationReference?: string }>;
  }).rows.find((row) => row.eye === "OD")?.observationReference;
  assert.equal(historyReference, savedReference);
  assert.equal(historyReference, `Observation/${savedObservation.id}`);
});

test("OH-2b Vessels seeds and round-trips the per-eye A/V ratio grade on normal and abnormal eyes", async () => {
  const fhir = new MemoryFhir();
  const definitions = await catalog(fhir);
  const vessels = definitions.find((definition) => definition.stableKey === "ocular-health:posterior:vessels");
  assert.ok(vessels);
  const grade = Object.values(vessels.valueSchema.fields as Record<string, { valueType?: string; localCode?: string; display?: string; options?: Array<{ code: string; display: string; active: boolean }> }>)
    .find((candidate) => candidate.valueType === "select");
  assert.ok(grade?.localCode);
  assert.equal(grade.display, "A/V ratio");
  assert.deepEqual(grade.options?.map((option) => [option.code, option.display, option.active]), [
    ["2-3", "2:3", true],
    ["1-2", "1:2", true],
    ["1-3", "1:3", true],
    ["1-4", "1:4", true],
  ]);

  const captured = await handleCustomSectionCaptureRequest(clinicalDeps("provider", fhir, [vessels]), {
    authHeader: AUTH,
    params: { stableKey: vessels.stableKey },
    body: {
      patientReference: "Patient/p-vessels-grade",
      encounterReference: "Encounter/e-vessels-grade",
      eyes: {
        OD: { state: "normal", customFields: [{ code: grade.localCode, value: "2-3" }] },
        OS: { state: "abnormal", customFields: [{ code: grade.localCode, value: "1-2" }] },
      },
    },
  });
  assert.equal(captured.status, 200, JSON.stringify(captured.body));
  assert.equal(component(fhir.observations[0], `OD_${grade.localCode}`)?.valueCodeableConcept?.coding?.[0]?.code, "2-3");
  assert.equal(component(fhir.observations[1], `OS_${grade.localCode}`)?.valueCodeableConcept?.coding?.[0]?.code, "1-2");

  const history = await handleCustomSectionHistoryRequest(clinicalDeps("provider", fhir, [vessels]), {
    authHeader: AUTH,
    params: { stableKey: vessels.stableKey },
    query: { patient: "Patient/p-vessels-grade", encounter: "Encounter/e-vessels-grade" },
  });
  const rows = (history.body as { rows: Array<{ eye: string; state: string; values: Array<{ code: string; value: string }> }> }).rows;
  assert.deepEqual(rows.map((row) => [row.eye, row.state, row.values.find((value) => value.code === grade.localCode)?.value]), [
    ["OD", "normal", "2:3"],
    ["OS", "abnormal", "1:2"],
  ]);
});

test("anterior structure grades exclude retired LOCS III fields and round-trip the remaining fields per eye", async () => {
  const fhir = new MemoryFhir();
  const definitions = await catalog(fhir);
  const tearFilm = definitions.find((definition) => definition.stableKey === "ocular-health:anterior:tear-film");
  const anteriorChamber = definitions.find((definition) => definition.stableKey === "ocular-health:anterior:anterior-chamber");
  const lens = definitions.find((definition) => definition.stableKey === "ocular-health:anterior:lens");
  assert.ok(tearFilm && anteriorChamber && lens);
  const fields = (definition: ClinicalFindingDefinition) => Object.values(definition.valueSchema.fields as Record<string, {
    localCode?: string;
    display?: string;
    valueType?: string;
    unit?: string;
    min?: number;
    max?: number;
    step?: number;
    options?: Array<{ code: string; display: string; active: boolean }>;
  }>);
  const tbut = fields(tearFilm).find((field) => field.display === "TBUT");
  const vanHerick = fields(anteriorChamber).find((field) => field.display === "Van Herick");
  const locs = fields(lens).filter((field) => field.display?.startsWith("LOCS III"));
  assert.ok(tbut?.localCode && vanHerick?.localCode);
  assert.deepEqual(tbut, {
    localCode: "CUSTOM_GRADE_TBUT",
    display: "TBUT",
    origin: "practice",
    valueType: "number",
    unit: "s",
    min: 0,
    max: 60,
    step: 1,
    order: 1,
    active: true,
  });
  assert.deepEqual(vanHerick?.options?.map((option) => option.display), [
    "Grade 4 (wide open)",
    "Grade 3",
    "Grade 2",
    "Grade 1 (narrow)",
    "Grade 0 (closed)",
  ]);
  assert.deepEqual(locs, []);
  assert.equal(anteriorChamber.allowDiagnosisMapping, true);
  assert.equal(lens.allowDiagnosisMapping, true);
  assert.equal(anteriorChamber.notBillReady && tearFilm.notBillReady && lens.notBillReady, true);

  const vanHerickGrade2 = vanHerick.options!.find((option) => option.display === "Grade 2");
  assert.ok(vanHerickGrade2);
  assert.equal(vanHerickGrade2.code, "grade-2");
  for (const [definition, eye, field, captureValue, historyValue] of [
    [tearFilm, "OD", tbut, 6, 6],
    [anteriorChamber, "OS", vanHerick, vanHerickGrade2.code, "Grade 2"],
  ] as const) {
    assert.ok(field?.localCode);
    const captured = await handleCustomSectionCaptureRequest(clinicalDeps("provider", fhir, [definition]), {
      authHeader: AUTH,
      params: { stableKey: definition.stableKey },
      body: {
        patientReference: "Patient/p-anterior-grades",
        encounterReference: "Encounter/e-anterior-grades",
        eyes: { [eye]: { state: "normal", customFields: [{ code: field.localCode, value: captureValue }] } },
      },
    });
    assert.equal(captured.status, 200, JSON.stringify(captured.body));
    const history = await handleCustomSectionHistoryRequest(clinicalDeps("provider", fhir, [definition]), {
      authHeader: AUTH,
      params: { stableKey: definition.stableKey },
      query: { patient: "Patient/p-anterior-grades", encounter: "Encounter/e-anterior-grades" },
    });
    const rows = (history.body as { rows: Array<{ eye: string; values: Array<{ code: string; value: number | string }> }> }).rows;
    assert.deepEqual(rows.map((row) => [row.eye, row.values.find((candidate) => candidate.code === field.localCode)?.value]), [[eye, historyValue]]);
  }

  const editedTbut = await handleFindingDefinitionMutationRequest(definitionDeps("admin", fhir, "unused000"), {
    authHeader: AUTH,
    params: { stableKey: tearFilm.stableKey },
    body: { action: "update-custom-field", localCode: tbut.localCode, min: 1, max: 45, step: 0.5 },
  });
  assert.equal(editedTbut.status, 200, JSON.stringify(editedTbut.body));
  assert.deepEqual((editedTbut.body as { field: { localCode: string; min: number; max: number; step: number } }).field, {
    ...tbut,
    min: 1,
    max: 45,
    step: 0.5,
  });
  const editedVanHerick = await handleFindingDefinitionMutationRequest(definitionDeps("admin", fhir, "unused000"), {
    authHeader: AUTH,
    params: { stableKey: anteriorChamber.stableKey },
    body: {
      action: "update-custom-field",
      localCode: vanHerick.localCode,
      options: vanHerick.options!.map((option) => option.code === "grade-3"
        ? { ...option, display: "Practice Grade 3", active: false }
        : option),
    },
  });
  assert.equal(editedVanHerick.status, 200, JSON.stringify(editedVanHerick.body));
  assert.deepEqual((editedVanHerick.body as { field: { options: Array<{ code: string; display: string; active: boolean }> } })
    .field.options.find((option) => option.code === "grade-3"), {
    code: "grade-3",
    display: "Practice Grade 3",
    active: false,
  });
});

test("E1 entrance state sections emit coded attributes and round-trip normal and abnormal fields", async () => {
  const fhir = new MemoryFhir();
  const definitions = await catalog(fhir);
  const pupils = definitions.find((definition) => definition.stableKey === "entrance:pupils");
  assert.ok(pupils);
  const fields = pupils.valueSchema.fields as Record<string, { localCode: string }>;
  const normal = await handleCustomSectionCaptureRequest(clinicalDeps("provider", fhir, definitions), {
    authHeader: AUTH,
    params: { stableKey: pupils.stableKey },
    body: {
      patientReference: "Patient/entrance-pupils",
      encounterReference: "Encounter/entrance-pupils",
      eyes: { OD: { state: "normal", customFields: [] }, OS: { state: "normal", customFields: [] } },
    },
  });
  assert.equal(normal.status, 200, JSON.stringify(normal.body));
  assert.equal(component(fhir.observations[0], "entrance.pupils")?.valueCodeableConcept?.coding?.[0]?.code, "normal");
  assert.equal(component(fhir.observations[0], "NORMAL_TEMPLATE")?.valueString, "PERRLA; no RAPD OU");
  assert.equal(["CUSTOM", "PUPIL", "APD"].join("_") in fields, false);
  assert.equal(fields.CUSTOM_PUPIL_RAPD?.localCode, "CUSTOM_PUPIL_RAPD");
  assert.equal(fields.CUSTOM_PUPIL_NEUTRAL_DENSITY?.localCode, "CUSTOM_PUPIL_NEUTRAL_DENSITY");

  const abnormal = await handleCustomSectionCaptureRequest(clinicalDeps("provider", fhir, definitions), {
    authHeader: AUTH,
    params: { stableKey: pupils.stableKey },
    body: {
      patientReference: "Patient/entrance-pupils",
      encounterReference: "Encounter/entrance-pupils",
      eyes: {
        OD: {
          state: "abnormal",
          customFields: [
            { code: fields.CUSTOM_PUPIL_SIZE_BRIGHT!.localCode, value: 4 },
            { code: fields.CUSTOM_PUPIL_SHAPE!.localCode, value: "irregular" },
            { code: fields.CUSTOM_PUPIL_RAPD!.localCode, value: "trace" },
            { code: fields.CUSTOM_PUPIL_NEUTRAL_DENSITY!.localCode, value: "0-6" },
          ],
          other: "Trace anisocoria.",
        },
      },
    },
  });
  assert.equal(abnormal.status, 200, JSON.stringify(abnormal.body));
  const last = fhir.observations.at(-1);
  assert.equal(component(last, "entrance.pupils")?.valueCodeableConcept?.coding?.[0]?.code, "abnormal");
  assert.equal(component(last, `OD_${fields.CUSTOM_PUPIL_SIZE_BRIGHT!.localCode}`)?.valueQuantity?.value, 4);
  assert.equal(component(last, `OD_${fields.CUSTOM_PUPIL_SHAPE!.localCode}`)?.valueCodeableConcept?.coding?.[0]?.code, "irregular");
  assert.equal(component(last, `OD_${fields.CUSTOM_PUPIL_RAPD!.localCode}`)?.valueCodeableConcept?.coding?.[0]?.code, "trace");
  assert.equal(component(last, `OD_${fields.CUSTOM_PUPIL_NEUTRAL_DENSITY!.localCode}`)?.valueCodeableConcept?.coding?.[0]?.code, "0-6");

  const history = await handleCustomSectionHistoryRequest(clinicalDeps("provider", fhir, definitions), {
    authHeader: AUTH,
    params: { stableKey: pupils.stableKey },
    query: { patient: "Patient/entrance-pupils", encounter: "Encounter/entrance-pupils" },
  });
  const rows = (history.body as { rows: Array<{ state: string; other?: string; values: Array<{ code: string; value: unknown }> }> }).rows;
  assert.equal(rows.some((row) => row.state === "abnormal" && row.other === "Trace anisocoria."
    && row.values.some((value) => value.code === "CUSTOM_PUPIL_SIZE_BRIGHT" && value.value === 4)
    && row.values.some((value) => value.code === "CUSTOM_PUPIL_RAPD" && value.value === "trace")
    && row.values.some((value) => value.code === "CUSTOM_PUPIL_NEUTRAL_DENSITY" && value.value === "0.6")), true);
});

test("screenshot refinement stores binocular stereopsis once with top-level state", async () => {
  const fhir = new MemoryFhir();
  const definitions = await catalog(fhir);
  const stereo = definitions.find((definition) => definition.stableKey === "entrance:stereo");
  assert.ok(stereo);
  assert.equal(stereo.valueSchema.perEye, false);
  const result = await handleCustomSectionCaptureRequest(clinicalDeps("provider", fhir, definitions), {
    authHeader: AUTH,
    params: { stableKey: stereo.stableKey },
    body: {
      patientReference: "Patient/stereo",
      encounterReference: "Encounter/stereo",
      state: "abnormal",
      customFields: [
        { code: "CUSTOM_STEREO_TEST", value: "randot" },
        { code: "CUSTOM_STEREO_UNABLE", value: "yes" },
      ],
      other: "Binocular response recorded once.",
    },
  });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(fhir.observations.length, 1);
  assert.equal(component(fhir.observations[0], "EXAM_STATE")?.valueString, "abnormal");
  assert.equal(component(fhir.observations[0], "CUSTOM_STEREO_TEST")?.valueCodeableConcept?.coding?.[0]?.code, "randot");
  const history = await handleCustomSectionHistoryRequest(clinicalDeps("provider", fhir, definitions), {
    authHeader: AUTH,
    params: { stableKey: stereo.stableKey },
    query: { patient: "Patient/stereo", encounter: "Encounter/stereo" },
  });
  assert.deepEqual((history.body as { rows: Array<{ eye?: string; state?: string }> }).rows.map((row) => [row.eye, row.state]), [[undefined, "abnormal"]]);
});

test("CVF persists four-quadrant schematic values through the generic entrance endpoint", async () => {
  const fhir = new MemoryFhir();
  const definitions = await catalog(fhir);
  const cvf = definitions.find((definition) => definition.stableKey === "entrance:cvf");
  assert.ok(cvf);
  const normal = await handleCustomSectionCaptureRequest(clinicalDeps("provider", fhir, definitions), {
    authHeader: AUTH,
    params: { stableKey: cvf.stableKey },
    body: { patientReference: "Patient/cvf", encounterReference: "Encounter/cvf", eyes: { OD: { state: "normal", customFields: [] }, OS: { state: "normal", customFields: [] } } },
  });
  assert.equal(normal.status, 200, JSON.stringify(normal.body));
  assert.equal(component(fhir.observations[0], "entrance.cvf")?.valueCodeableConcept?.coding?.[0]?.code, "normal");
  assert.equal(component(fhir.observations[0], "NORMAL_TEMPLATE")?.valueString, "Full to finger counting OU");
  const abnormal = await handleCustomSectionCaptureRequest(clinicalDeps("provider", fhir, definitions), {
    authHeader: AUTH,
    params: { stableKey: cvf.stableKey },
    body: { patientReference: "Patient/cvf", encounterReference: "Encounter/cvf", eyes: { OD: { state: "abnormal", customFields: [{ code: "CUSTOM_CVF_UPPER_LEFT", value: "restricted" }, { code: "CUSTOM_CVF_LOWER_RIGHT", value: "full" }, { code: "CUSTOM_CVF_METHOD", value: "finger-count" }] } } },
  });
  assert.equal(abnormal.status, 200, JSON.stringify(abnormal.body));
  const history = await handleCustomSectionHistoryRequest(clinicalDeps("provider", fhir, definitions), { authHeader: AUTH, params: { stableKey: cvf.stableKey }, query: { patient: "Patient/cvf", encounter: "Encounter/cvf" } });
  assert.equal((history.body as { rows: Array<{ values: Array<{ code: string; value: unknown }> }> }).rows.some((row) => row.values.some((value) => value.code === "CUSTOM_CVF_UPPER_LEFT" && value.value === "restricted")), true);
});

test("E1 Pachymetry and Manual K use measurement capture without exam state", async () => {
  const fhir = new MemoryFhir();
  const definitions = await catalog(fhir);
  const pachymetry = definitions.find((definition) => definition.stableKey === "pachymetry_um");
  const manualK = definitions.find((definition) => definition.stableKey === "manual_keratometry");
  assert.ok(pachymetry && manualK);
  const pachy = await handleCustomSectionCaptureRequest(clinicalDeps("provider", fhir, definitions), {
    authHeader: AUTH,
    params: { stableKey: pachymetry.stableKey },
    body: {
      patientReference: "Patient/entrance-measurements",
      encounterReference: "Encounter/entrance-measurements",
      eyes: { OD: { customFields: [
        { code: "CUSTOM_CCT", value: 542 },
        { code: "CUSTOM_PACHYMETRY_METHOD", value: "optical" },
        { code: "CUSTOM_PACHYMETRY_TIME", value: "10:42" },
      ] } },
    },
  });
  assert.equal(pachy.status, 200, JSON.stringify(pachy.body));
  assert.equal(component(fhir.observations.at(-1), "entrance.pachymetry")?.valueCodeableConcept?.coding?.[0]?.code, "normal");
  assert.equal(component(fhir.observations.at(-1), "OD_CUSTOM_CCT")?.valueQuantity?.value, 542);
  assert.equal(component(fhir.observations.at(-1), "OD_CUSTOM_PACHYMETRY_TIME")?.valueString, "10:42");

  const partial = await handleCustomSectionCaptureRequest(clinicalDeps("provider", fhir, definitions), {
    authHeader: AUTH,
    params: { stableKey: manualK.stableKey },
    body: {
      patientReference: "Patient/entrance-measurements",
      encounterReference: "Encounter/entrance-measurements",
      eyes: { OD: { customFields: [{ code: "CUSTOM_FLAT_K", value: 43.25 }] } },
    },
  });
  assert.equal(partial.status, 400);
  assert.match(String((partial.body as { error: string }).error), /requires flat K/);
  const complete = await handleCustomSectionCaptureRequest(clinicalDeps("provider", fhir, definitions), {
    authHeader: AUTH,
    params: { stableKey: manualK.stableKey },
    body: {
      patientReference: "Patient/entrance-measurements",
      encounterReference: "Encounter/entrance-measurements",
      eyes: { OS: { customFields: [
        { code: "CUSTOM_FLAT_K", value: 43.25 },
        { code: "CUSTOM_FLAT_AXIS", value: 180 },
        { code: "CUSTOM_STEEP_K", value: 44 },
        { code: "CUSTOM_STEEP_AXIS", value: 90 },
        { code: "CUSTOM_MIRES_QUALITY", value: "clear" },
      ] } },
    },
  });
  assert.equal(complete.status, 200, JSON.stringify(complete.body));
  assert.equal(component(fhir.observations.at(-1), "OS_CUSTOM_FLAT_K")?.valueQuantity?.value, 43.25);
  assert.equal(component(fhir.observations.at(-1), "entrance.manual-keratometry"), undefined);
});

test("dry-eye total score cannot persist without its instrument", async () => {
  const fhir = new MemoryFhir();
  const definitions = await catalog(fhir);
  const result = await handleCustomSectionCaptureRequest(clinicalDeps("provider", fhir, definitions), {
    authHeader: AUTH,
    params: { stableKey: "dry-eye:symptoms" },
    body: {
      patientReference: "Patient/dry-eye-score",
      encounterReference: "Encounter/dry-eye-score",
      customFields: [{ code: "CUSTOM_TOTAL_SCORE", value: 30 }],
    },
  });
  assert.equal(result.status, 400);
  assert.match(String((result.body as { error: string }).error), /requires its questionnaire instrument/);
  assert.equal(fhir.observations.length, 0);
});

test("DE-1 dry-eye sections round-trip detail fields and per-eye anatomy through shared history", async () => {
  const fhir = new MemoryFhir();
  const definitions = await catalog(fhir);
  const dryEye = definitions.filter((definition) =>
    definition.sectionKey?.startsWith("dry-eye:")
  );
  const cases: Array<{
    stableKey: string;
    body: Record<string, unknown>;
    expectedRows: number;
  }> = [
    {
      stableKey: "dry-eye:symptoms",
      body: {
        customFields: [
          { code: "CUSTOM_INSTRUMENT", value: "SPEED" },
          { code: "CUSTOM_TOTAL_SCORE", value: 12 },
          { code: "CUSTOM_DATE_ADMINISTERED", value: "2026-07-26" },
          { code: "CUSTOM_UNABLE_TO_TEST", value: "unable" },
        ],
      },
      expectedRows: 1,
    },
    {
      stableKey: "dry-eye:tear-volume",
      body: {
        eyes: {
          OD: { customFields: [
            { code: "CUSTOM_SCHIRMER_MM", value: 8 },
            { code: "CUSTOM_VARIANT", value: "without-anesthesia" },
            { code: "CUSTOM_DURATION_MIN", value: 5 },
          ] },
          OS: { customFields: [
            { code: "CUSTOM_SCHIRMER_MM", value: 6 },
            { code: "CUSTOM_VARIANT", value: "without-anesthesia" },
            { code: "CUSTOM_DURATION_MIN", value: 5 },
          ] },
        },
      },
      expectedRows: 2,
    },
    {
      stableKey: "dry-eye:markers",
      body: {
        eyes: {
          OD: { customFields: [
            { code: "CUSTOM_OSMOLARITY_MOSM_L", value: 300 },
            { code: "CUSTOM_INSTRUMENT", value: "Synthetic analyzer" },
            { code: "CUSTOM_INFLAMMATORY_MARKER_TEST", value: "mmp-9-inflammadry" },
            { code: "CUSTOM_INFLAMMATORY_RESULT", value: "positive" },
          ] },
          OS: { customFields: [
            { code: "CUSTOM_OSMOLARITY_MOSM_L", value: 302 },
            { code: "CUSTOM_INFLAMMATORY_RESULT", value: "negative" },
          ] },
        },
      },
      expectedRows: 2,
    },
    {
      stableKey: "dry-eye:gland-structure",
      body: {
        eyes: {
          OD: { customFields: [
            { code: "CUSTOM_IMAGE_REFERENCE", value: "DocumentReference/meibo-1" },
            { code: "CUSTOM_DROPOUT_GRADE", value: "grade-2" },
          ] },
        },
      },
      expectedRows: 1,
    },
    {
      stableKey: "dry-eye:gland-function",
      body: {
        eyes: {
          OD: { customFields: [
            { code: "CUSTOM_EXPRESSIBILITY", value: "reduced" },
            { code: "CUSTOM_SECRETION_QUALITY", value: "granular" },
            { code: "CUSTOM_GLANDS_YIELDING_LIQUID", value: 4 },
          ] },
          OS: { customFields: [
            { code: "CUSTOM_EXPRESSIBILITY", value: "normal" },
            { code: "CUSTOM_SECRETION_QUALITY", value: "clear" },
            { code: "CUSTOM_GLANDS_YIELDING_LIQUID", value: 7 },
          ] },
        },
      },
      expectedRows: 2,
    },
    {
      stableKey: "dry-eye:conjunctival-staining",
      body: {
        eyes: {
          OD: {
            state: "abnormal",
            customFields: [
              { code: "CUSTOM_CONJUNCTIVAL_STAINING_GRADE", value: "grade-2" },
              { code: "CUSTOM_VITAL_DYE", value: "lissamine-green" },
            ],
          },
          OS: { state: "normal", customFields: [] },
        },
      },
      expectedRows: 2,
    },
    {
      stableKey: "dry-eye:staging",
      body: {
        customFields: [
          { code: "CUSTOM_SUBTYPE", value: "mixed" },
          { code: "CUSTOM_SEVERITY_LEVEL", value: "level-2" },
          { code: "CUSTOM_TREATMENT_PHASE_NOTE", value: "Escalation discussed." },
        ],
      },
      expectedRows: 1,
    },
  ];
  for (const row of cases) {
    const definition = dryEye.find((candidate) => candidate.stableKey === row.stableKey);
    assert.ok(definition, row.stableKey);
    const captured = await handleCustomSectionCaptureRequest(
      clinicalDeps("provider", fhir, dryEye),
      {
        authHeader: AUTH,
        params: { stableKey: row.stableKey },
        body: {
          patientReference: "Patient/dry-eye-roundtrip",
          encounterReference: "Encounter/dry-eye-roundtrip",
          ...row.body,
        },
      },
    );
    assert.equal(captured.status, 200, `${row.stableKey}: ${JSON.stringify(captured.body)}`);
    const history = await handleCustomSectionHistoryRequest(
      clinicalDeps("provider", fhir, dryEye),
      {
        authHeader: AUTH,
        params: { stableKey: row.stableKey },
        query: {
          patient: "Patient/dry-eye-roundtrip",
          encounter: "Encounter/dry-eye-roundtrip",
        },
      },
    );
    assert.equal(history.status, 200, row.stableKey);
    const rows = (history.body as {
      rows: Array<{ values: unknown[]; normalTemplate?: string }>;
    }).rows;
    assert.equal(rows.length, row.expectedRows, row.stableKey);
    assert.equal(rows.some((historyRow) => historyRow.values.length > 0), true, row.stableKey);
    if (row.stableKey === "dry-eye:conjunctival-staining") {
      assert.equal(
        rows.some((historyRow) => historyRow.normalTemplate === "No conjunctival staining."),
        true,
      );
    }
  }
});

test("DE-1 tear-stability and routine tear-film entry share one stableKey and one history", async () => {
  const fhir = new MemoryFhir();
  const definitions = await catalog(fhir);
  const tearFilm = definitions.find(
    (definition) => definition.stableKey === "ocular-health:anterior:tear-film",
  );
  assert.ok(tearFilm);
  assert.equal(
    definitions.some((definition) => definition.stableKey === "dry-eye:tear-stability"),
    false,
  );
  for (const [encounterReference, eye, seconds, method] of [
    ["Encounter/dry-eye-battery", "OD", 5, "fluorescein"],
    ["Encounter/routine-ocular-health", "OS", 7, "non-invasive"],
  ] as const) {
    const capture = await handleCustomSectionCaptureRequest(
      clinicalDeps("provider", fhir, [tearFilm]),
      {
        authHeader: AUTH,
        params: { stableKey: tearFilm.stableKey },
        body: {
          patientReference: "Patient/tbut-one-history",
          encounterReference,
          eyes: {
            [eye]: {
              state: "normal",
              customFields: [
                { code: "CUSTOM_GRADE_TBUT", value: seconds },
                { code: "CUSTOM_GRADE_TBUT_METHOD", value: method },
              ],
            },
          },
        },
      },
    );
    assert.equal(capture.status, 200, JSON.stringify(capture.body));
  }
  const history = await handleCustomSectionHistoryRequest(
    clinicalDeps("provider", fhir, [tearFilm]),
    {
      authHeader: AUTH,
      params: { stableKey: tearFilm.stableKey },
      query: { patient: "Patient/tbut-one-history" },
    },
  );
  const rows = (history.body as {
    rows: Array<{ eye: string; values: Array<{ code: string; value: unknown }> }>;
  }).rows;
  assert.deepEqual(rows.map((row) => [
    row.eye,
    row.values.find((value) => value.code === "CUSTOM_GRADE_TBUT")?.value,
    row.values.find((value) => value.code === "CUSTOM_GRADE_TBUT_METHOD")?.value,
  ]), [
    ["OD", 5, "Fluorescein"],
    ["OS", 7, "Non-invasive"],
  ]);
  assert.equal(
    fhir.observations.every((observation) =>
      observation.code.coding?.some((coding) =>
        coding.code === "ocular-health:anterior:tear-film"
      )
    ),
    true,
  );
});

test("DE-1 abnormal mappings return proposal badges and never auto-confirm a diagnosis", async () => {
  const fhir = new MemoryFhir();
  const definitions = await catalog(fhir);
  const markers = definitions.find(
    (definition) => definition.stableKey === "dry-eye:markers",
  );
  assert.ok(markers);
  const capture = await handleCustomSectionCaptureRequest(
    clinicalDeps("provider", fhir, [markers]),
    {
      authHeader: AUTH,
      params: { stableKey: markers.stableKey },
      body: {
        patientReference: "Patient/dry-eye-mapping",
        encounterReference: "Encounter/dry-eye-mapping",
        eyes: {
          OD: {
            customFields: [{
              code: "CUSTOM_INFLAMMATORY_RESULT",
              value: "positive",
            }],
          },
        },
      },
    },
  );
  assert.equal(capture.status, 200, JSON.stringify(capture.body));
  const candidates = await handleDiagnosisCandidatesRequest({
    authenticate: async () => ({
      staffReference: "Practitioner/doc-1",
      actorRole: "provider",
      fhir,
    }),
    now: () => NOW,
  }, {
    authHeader: AUTH,
    params: { encounterId: "dry-eye-mapping" },
  });
  assert.equal(candidates.status, 200, JSON.stringify(candidates.body));
  const findings = (candidates.body as {
    findings: Array<{
      findingDefinitionKey: string;
      candidates: Array<{ diagnosisKey: string; source: string }>;
    }>;
  }).findings;
  assert.deepEqual(findings.map((finding) => ({
    findingDefinitionKey: finding.findingDefinitionKey,
    candidates: finding.candidates.map((candidate) => ({
      diagnosisKey: candidate.diagnosisKey,
      source: candidate.source,
    })),
  })), [{
    findingDefinitionKey: "dry-eye:markers",
    candidates: [{
      diagnosisKey: "kcs_not_sjogren",
      source: "mapping",
    }],
  }]);
  assert.equal(
    JSON.stringify(candidates.body).includes('"verificationStatus":"confirmed"'),
    false,
  );
  assert.equal(fhir.captureWrites.filter((write) => write.resourceType === "Condition").length, 0);
});

class MemoryFhir {
  readonly basics: Basic[] = [];
  readonly observations: Observation[] = [];
  readonly captureWrites: Array<{ resourceType: string; header?: string; resource: Basic | Observation | Provenance }> = [];

  async search<T extends Basic | Observation>(
    resourceType: T["resourceType"],
    params: Record<string, string> = {},
  ): Promise<Bundle<T>> {
    const resources = resourceType === "Basic"
      ? this.basics
      : this.observations
        .filter((observation) =>
          !params.subject || observation.subject?.reference === params.subject
        )
        .filter((observation) =>
          !params.encounter || observation.encounter?.reference === params.encounter
        )
        .filter((observation) => {
          if (!params.code) return true;
          const [system, code] = params.code?.split("|") ?? [];
          return observation.code.coding?.some((coding) => coding.system === system && coding.code === code);
        });
    return { resourceType: "Bundle", type: "searchset", entry: resources.map((resource) => ({ resource: resource as T })) };
  }

  async create<T extends Basic | Observation | Provenance>(
    resource: T,
    headers?: Record<string, string>,
  ): Promise<T> {
    const saved = { ...resource, id: resource.id ?? `${resource.resourceType.toLowerCase()}-${this.basics.length + this.observations.length + this.captureWrites.length + 1}` } as T;
    if (saved.resourceType === "Basic") this.basics.push(saved as Basic);
    if (saved.resourceType === "Observation") this.observations.push(saved as Observation);
    if (saved.resourceType !== "Basic") {
      this.captureWrites.push({ resourceType: saved.resourceType, header: headers?.["X-ODOS-Source"], resource: saved });
    }
    return saved;
  }

  async update<T extends Basic>(
    _resourceType: T["resourceType"],
    id: string,
    resource: T,
  ): Promise<T> {
    const index = this.basics.findIndex((row) => row.id === id);
    const saved = { ...resource, id };
    this.basics[index] = saved;
    return saved;
  }
}

function scsDefinitionBody() {
  return {
    action: "create-definition",
    display: "Skin Carotenoid Score",
    perEye: false,
    fields: [{ display: "Score", valueType: "number", min: 0, max: 100, step: 1 }],
  };
}

function definitionDeps(role: PracticeRoleId, fhir: MemoryFhir, shortId: string) {
  return {
    authenticate: async (authHeader: string | undefined) => authHeader === AUTH
      ? { staffReference: "Practitioner/admin-1", actorRole: role, fhir }
      : null,
    now: () => NOW,
    shortId: () => shortId,
  };
}

function clinicalDeps(role: PracticeRoleId, fhir: MemoryFhir, definitions: ClinicalFindingDefinition[]) {
  return {
    authenticate: async (authHeader: string | undefined) => authHeader === AUTH
      ? { staffReference: "Practitioner/doc-1", actorRole: role, fhir }
      : null,
    findingDefinitions: () => definitions,
    now: () => NOW,
  };
}

async function catalog(fhir: MemoryFhir): Promise<ClinicalFindingDefinition[]> {
  return new FhirFindingDefinitionStore(fhir, buildFindingDefinitionSeeds()).list();
}

function component(observation: Observation | undefined, code: string) {
  return observation?.component?.find((item) => item.code.coding?.some((coding) => coding.code === code));
}

test("guard 3: custom-section history hides voided (entered-in-error) rows so a void leaves the sheet, not just the Overview", async () => {
  const fhir = new MemoryFhir();
  const definitions = await catalog(fhir);
  const cvf = definitions.find((definition) => definition.stableKey === "entrance:cvf");
  assert.ok(cvf);

  const capture = await handleCustomSectionCaptureRequest(clinicalDeps("provider", fhir, definitions), {
    authHeader: AUTH,
    params: { stableKey: cvf.stableKey },
    body: {
      patientReference: "Patient/p-void",
      encounterReference: "Encounter/e-void",
      eyes: {
        OD: { state: "normal", customFields: [] },
        OS: { state: "normal", customFields: [] },
      },
    },
  });
  assert.equal(capture.status, 200, JSON.stringify(capture.body));
  const osReference = (capture.body as { eyes: { OS: { observationReference: string } } }).eyes.OS.observationReference;
  const voided = fhir.observations.find((observation) => `Observation/${observation.id}` === osReference);
  assert.ok(voided);
  voided.status = "entered-in-error";

  const history = await handleCustomSectionHistoryRequest(clinicalDeps("provider", fhir, definitions), {
    authHeader: AUTH,
    params: { stableKey: cvf.stableKey },
    query: { patient: "Patient/p-void", encounter: "Encounter/e-void" },
  });
  assert.equal(history.status, 200, JSON.stringify(history.body));
  const rows = (history.body as { rows: Array<{ eye?: string; observationReference?: string }> }).rows;
  assert.deepEqual(rows.map((row) => row.eye), ["OD"], "the voided OS row must not be listed");
  assert.ok(rows.every((row) => row.observationReference !== osReference));
});
