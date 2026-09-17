import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import type { Basic, Bundle, Observation, Provenance, Encounter, Resource } from "@medplum/fhirtypes";
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

test("bare-string ocular-health seeds keep the current definition and presence-only history shape — seed contract", async () => {
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

});

test("finding qualifiers — seed contract", async () => {
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

});

test("ocular-health saves — seed contract", async () => {
  const fhir = new MemoryFhir();
  const definitions = await catalog(fhir);
  const lids = definitions.find((definition) =>
    definition.stableKey === "ocular-health:anterior:lids-lashes"
  );
  const palpebral = definitions.find((definition) =>
    definition.stableKey === "ocular-health:anterior:palpebral-conjunctiva"
  );
  assert.ok(lids && palpebral);


});

test("OH-1 seeds nine editable structures — seed contract", async () => {
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
      display: "Corneal staining grade (FDA Appendix C; Efron-corroborated)",
      options: ["Grade 1", "Grade 2", "Grade 3", "Grade 4"],
      scheme: "FDA Appendix C; Efron-corroborated",
    },
    {
      kind: "enum",
      key: "zone",
      display: "Corneal staining zone",
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
    "cortical-cataract",
    "posterior-subcapsular-psc",
    "posterior-capsular-opacification-pco",
    "mixed",
    "anterior-subcapsular",
  ];
  for (const code of lensGrades) {
    assert.deepEqual(lens.find((option) => option.code === code)?.qualifiers, [{
      kind: "graded",
      key: "grade",
      display: "Grade",
      options: ["1+", "2+", "3+", "4+"],
      scheme: "Operator-ruled ODOS 1–4+ present-finding scale (2026-08-09)",
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

test("corneal findings expose sourced grade axes and arcus extent through live qualifier precedents", async () => {
  const definitions = await catalog(new MemoryFhir());
  const definition = (stableKey: string) => {
    const found = definitions.find((candidate) => candidate.stableKey === stableKey);
    assert.ok(found, stableKey);
    return found;
  };
  const findings = (stableKey: string) => Object.values(
    definition(stableKey).valueSchema.fields as Record<string, {
      valueType?: string;
      options?: Array<{
        code: string;
        qualifiers?: Array<Record<string, unknown>>;
      }>;
    }>,
  ).find((field) => field.valueType === "multi-select")?.options ?? [];
  const qualifier = (stableKey: string, findingCode: string) =>
    findings(stableKey).find((finding) => finding.code === findingCode)?.qualifiers?.[0];
  const lensQualifier = qualifier("ocular-health:anterior:lens", "nuclear-sclerosis");
  const anteriorChamberQualifier = qualifier("ocular-health:anterior:anterior-chamber", "cells");
  assert.ok(lensQualifier && anteriorChamberQualifier);
  assert.deepEqual(
    [anteriorChamberQualifier.kind, anteriorChamberQualifier.key, anteriorChamberQualifier.display],
    [lensQualifier.kind, lensQualifier.key, lensQualifier.display],
  );

  const expectedGrades = {
    neovascularization: {
      scheme: "FDA Appendix C; Efron-corroborated",
      options: [
        "1+ (<1.0 mm vessel penetration)",
        "2+ (≥1.0 to <1.5 mm vessel penetration)",
        "3+ (≥1.5 to 2.0 mm vessel penetration)",
        "4+ (>2.0 mm vessel penetration)",
      ],
    },
    edema: {
      scheme: "FDA Appendix C; Efron-corroborated",
      options: [
        "1+ (barely discernible localized epithelial/subepithelial or stromal haze; 1–20 microcysts)",
        "2+ (faint definite localized/generalized epithelial/stromal haze; 21–50 microcysts)",
        "3+ (significant localized/generalized epithelial/stromal haze; 51–100 microcysts)",
        "4+ (widespread epithelial/stromal clouding, coalescent bullae, or striae; >100 microcysts or bullae)",
      ],
    },
    infiltrate: {
      scheme: "FDA Appendix C; Efron-corroborated",
      options: [
        "1+ (one faint peripheral infiltrate without staining)",
        "2+ (a few faint infiltrates)",
        "3+ (multiple dense infiltrates)",
        "4+ (marked infiltrates with overlying staining)",
      ],
    },
    guttata: {
      scheme: "Modified Krachmer (ODOS 1–4+ collapse)",
      options: [
        "1+ (central/paracentral nonconfluent guttae)",
        "2+ (1–2 mm confluent central/paracentral guttae)",
        "3+ (>2–5 mm confluent central/paracentral guttae)",
        "4+ (>5 mm confluent central/paracentral guttae, with or without edema)",
      ],
    },
  };
  for (const [findingCode, expected] of Object.entries(expectedGrades)) {
    const cornealQualifier = qualifier("ocular-health:anterior:cornea", findingCode);
    assert.ok(cornealQualifier, findingCode);
    assert.deepEqual(
      [cornealQualifier.kind, cornealQualifier.key, cornealQualifier.display],
      [lensQualifier.kind, lensQualifier.key, lensQualifier.display],
      findingCode,
    );
    assert.deepEqual(cornealQualifier.options, expected.options, findingCode);
    assert.equal(cornealQualifier.scheme, expected.scheme, findingCode);
  }

  const arcusQualifier = qualifier("ocular-health:anterior:cornea", "arcus");
  assert.deepEqual(arcusQualifier, {
    kind: "enum",
    key: "extent",
    display: "Extent",
    options: [
      { code: "inferior", display: "Inferior" },
      { code: "superior", display: "Superior" },
      { code: "partial", display: "Partial" },
      { code: "complete-360", display: "Complete (360°)" },
    ],
  });
  assert.notEqual(arcusQualifier?.kind, lensQualifier.kind);
});

test("historical positive SPK grades remain editable after the provisional scale is sourced — seed contract", async () => {
  const fhir = new MemoryFhir();
  const definitions = await catalog(fhir);
  const cornea = definitions.find((definition) => definition.stableKey === "ocular-health:anterior:cornea");
  assert.ok(cornea);
  const field = Object.values(cornea.valueSchema.fields as Record<string, {
    localCode: string;
    valueType?: string;
  }>).find((candidate) => candidate.valueType === "multi-select");
  assert.ok(field);


});

test("historical SPK Grade 0 — seed contract", async () => {
  const fhir = new MemoryFhir();
  const definitions = await catalog(fhir);
  const cornea = definitions.find((definition) => definition.stableKey === "ocular-health:anterior:cornea");
  assert.ok(cornea);
  const field = Object.values(cornea.valueSchema.fields as Record<string, {
    localCode: string;
    valueType?: string;
  }>).find((candidate) => candidate.valueType === "multi-select");
  assert.ok(field);


});

test("a new SPK finding cannot be written with retired Grade 0 — seed contract", async () => {
  const fhir = new MemoryFhir();
  const definitions = await catalog(fhir);
  const cornea = definitions.find((definition) => definition.stableKey === "ocular-health:anterior:cornea");
  assert.ok(cornea);
  const field = Object.values(cornea.valueSchema.fields as Record<string, {
    localCode: string;
    valueType?: string;
  }>).find((candidate) => candidate.valueType === "multi-select");
  assert.ok(field);


});

test("retired SPK Grade 0 translation does not drop the same value from another corneal finding — seed contract", async () => {
  const fhir = new MemoryFhir();
  const definitions = await catalog(fhir);
  const cornea = definitions.find((definition) => definition.stableKey === "ocular-health:anterior:cornea");
  assert.ok(cornea);
  const field = Object.values(cornea.valueSchema.fields as Record<string, {
    localCode: string;
    valueType?: string;
  }>).find((candidate) => candidate.valueType === "multi-select");
  assert.ok(field);


});

test("lens exposes sourced independent grade and colour axes without a zero rung or selectable brunescent finding", async () => {
  const definitions = await catalog(new MemoryFhir());
  const lens = definitions.find((definition) => definition.stableKey === "ocular-health:anterior:lens");
  assert.ok(lens);
  const findings = Object.values(lens.valueSchema.fields as Record<string, {
    valueType?: string;
    options?: Array<{
      code: string;
      priority?: boolean;
      qualifiers?: Array<{
        kind: string;
        key: string;
        display: string;
        options?: string[];
        scheme?: string;
      }>;
    }>;
  }>).find((field) => field.valueType === "multi-select")?.options ?? [];
  const finding = (code: string) => findings.find((candidate) => candidate.code === code);
  const psc = finding("posterior-subcapsular-psc");
  const asc = finding("anterior-subcapsular");
  const nuclear = finding("nuclear-sclerosis");
  assert.ok(psc && asc && nuclear);

  assert.equal(psc.priority, true);
  assert.equal(asc.priority, false);
  assert.deepEqual(asc.qualifiers, psc.qualifiers);
  assert.deepEqual(nuclear.qualifiers, [
    {
      kind: "graded",
      key: "grade",
      display: "Grade",
      options: ["1+", "2+", "3+", "4+"],
      scheme: "Operator-ruled ODOS 1–4+ present-finding scale (2026-08-09)",
    },
    {
      kind: "graded",
      key: "colour",
      display: "Colour",
      options: [
        "1+ (pale yellow)",
        "2+ (yellow)",
        "3+ (dark yellow/amber)",
        "4+ (dark brown/black; brunescent)",
      ],
      scheme: "Shirao; Sharma; LOCS III two-axis architecture",
    },
  ]);
  assert.equal(finding("brunescent"), undefined);

  const gradedQualifiers = findings.flatMap((option) =>
    (option.qualifiers ?? []).filter((qualifier) => qualifier.kind === "graded")
  );
  for (const qualifier of gradedQualifiers) {
    assert.ok(qualifier.scheme);
    for (const option of qualifier.options ?? []) {
      const rung = option.replace(/\s*\(.*/, "").trim();
      assert.doesNotMatch(rung, /^(?:grade\s*)?0$|\bnone\b/i);
    }
  }
});

test("nuclear sclerosis grade and colour — seed contract", async () => {
  const fhir = new MemoryFhir();
  const definitions = await catalog(fhir);
  const lens = definitions.find((definition) => definition.stableKey === "ocular-health:anterior:lens");
  assert.ok(lens);
  const field = Object.values(lens.valueSchema.fields as Record<string, {
    localCode?: string;
    valueType?: string;
  }>).find((candidate) => candidate.valueType === "multi-select");
  assert.ok(field?.localCode);
  const grade = "2+";
  const colour = "3+ (dark yellow/amber)";


});

test("historical brunescent alone — seed contract", async () => {
  const fhir = new MemoryFhir();
  const definitions = await catalog(fhir);
  const lens = definitions.find((definition) => definition.stableKey === "ocular-health:anterior:lens");
  assert.ok(lens);
  const field = Object.values(lens.valueSchema.fields as Record<string, {
    localCode?: string;
    valueType?: string;
  }>).find((candidate) => candidate.valueType === "multi-select");
  assert.ok(field?.localCode);


});

test("historical brunescent merges with a recorded nuclear grade into one deduplicated finding — seed contract", async () => {
  const fhir = new MemoryFhir();
  const definitions = await catalog(fhir);
  const lens = definitions.find((definition) => definition.stableKey === "ocular-health:anterior:lens");
  assert.ok(lens);
  const field = Object.values(lens.valueSchema.fields as Record<string, {
    localCode?: string;
    valueType?: string;
  }>).find((candidate) => candidate.valueType === "multi-select");
  assert.ok(field?.localCode);


});

test("retired finding translation stays scoped to lens brunescent — seed contract", async () => {
  const [synthetic] = buildOcularHealthDefinitions([{
    key: "synthetic-lens-scope",
    display: "Synthetic lens scope",
    normalTemplate: "Synthetic normal.",
    priority: ["nuclear sclerosis"],
    additional: ["brunescent", "mature cataract"],
  }], "ocular-health:synthetic:", SYNTHETIC_PROVENANCE);
  assert.ok(synthetic);
  const field = Object.values(synthetic.valueSchema.fields as Record<string, {
    localCode?: string;
    valueType?: string;
  }>).find((candidate) => candidate.valueType === "multi-select");
  assert.ok(field?.localCode);
  const fhir = new MemoryFhir();

});

test("corneal graded qualifiers never offer a zero or none rung", async () => {
  const definitions = await catalog(new MemoryFhir());
  const cornea = definitions.find((definition) =>
    definition.stableKey === "ocular-health:anterior:cornea"
  );
  assert.ok(cornea);
  const findings = Object.values(cornea.valueSchema.fields as Record<string, {
    valueType?: string;
    options?: Array<{
      code: string;
      qualifiers?: Array<{ kind?: string; options?: unknown[] }>;
    }>;
  }>).find((field) => field.valueType === "multi-select")?.options ?? [];

  for (const finding of findings) {
    for (const qualifier of finding.qualifiers ?? []) {
      if (qualifier.kind !== "graded") continue;
      for (const option of qualifier.options ?? []) {
        assert.equal(typeof option, "string", finding.code);
        const rung = (option as string).replace(/\s*\(.*/, "").trim();
        assert.doesNotMatch(rung, /^(?:grade\s*)?0$|\bnone\b/i, `${finding.code}: ${rung}`);
      }
    }
  }
});

test("every corneal graded qualifier has exactly four options", async () => {
  const definitions = await catalog(new MemoryFhir());
  const cornea = definitions.find((definition) =>
    definition.stableKey === "ocular-health:anterior:cornea"
  );
  assert.ok(cornea);
  const findings = Object.values(cornea.valueSchema.fields as Record<string, {
    valueType?: string;
    options?: Array<{
      code: string;
      qualifiers?: Array<{ kind?: string; options?: unknown[] }>;
    }>;
  }>).find((field) => field.valueType === "multi-select")?.options ?? [];
  const gradedQualifiers = findings.flatMap((finding) =>
    (finding.qualifiers ?? [])
      .filter((qualifier) => qualifier.kind === "graded")
      .map((qualifier) => ({ finding: finding.code, options: qualifier.options ?? [] }))
  );

  assert.equal(gradedQualifiers.length, 5);
  for (const qualifier of gradedQualifiers) {
    assert.equal(qualifier.options.length, 4, qualifier.finding);
  }
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

test("anterior chamber cell and flare grades — seed contract", async () => {
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


});

test("GET diagnosis candidates returns nuclear cataract after ocular-health capture regardless of grade — seed contract", async () => {
  const fhir = new MemoryFhir();
  fhir.encounters.push(candidateEncounter("lens-mapping"));
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


});

test("retinal-detachment macula status remains documentation-only for diagnosis proposals — seed contract", async () => {
  const fhir = new MemoryFhir();
  fhir.encounters.push(candidateEncounter("retinal-detachment-mapping"));
  const definitions = await catalog(fhir);
  const periphery = definitions.find((definition) => definition.stableKey === "ocular-health:posterior:periphery");
  assert.ok(periphery);
  const field = Object.values(periphery.valueSchema.fields as Record<string, {
    localCode: string;
    valueType: string;
  }>).find((candidate) => candidate.valueType === "multi-select");
  assert.ok(field);

});

test("Macula splits the hole findings, keeps Gass as an enum, and declares every ruled candidate route", async () => {
  const definitions = await catalog(new MemoryFhir());
  const macula = definitions.find((definition) => definition.stableKey === "ocular-health:posterior:macula");
  assert.ok(macula);
  const findings = Object.values(macula.valueSchema.fields as Record<string, {
    valueType?: string;
    options?: Array<{
      code: string;
      display: string;
      qualifiers?: Array<Record<string, unknown>>;
    }>;
  }>).find((field) => field.valueType === "multi-select")?.options ?? [];
  const finding = (code: string) => findings.find((candidate) => candidate.code === code);

  assert.equal(finding("macular-hole-full-lamellar"), undefined);
  assert.equal(finding("macular-hole")?.display, "macular hole");
  assert.equal(finding("lamellar-macular-hole")?.display, "lamellar macular hole");
  assert.equal(finding("macular-pseudohole")?.display, "macular pseudohole");
  assert.deepEqual(finding("macular-hole")?.qualifiers, [{
    kind: "enum",
    key: "stage",
    display: "Gass stage",
    options: [
      { code: "stage-1", display: "Stage I (impending hole; yellow spot or ring, no vitreofoveal separation)" },
      { code: "stage-2", display: "Stage II (small full-thickness hole, <400 µm)" },
      { code: "stage-3", display: "Stage III (full-thickness hole, ≥400 µm, without complete PVD)" },
      { code: "stage-4", display: "Stage IV (full-thickness hole with complete PVD)" },
    ],
  }]);
  assert.equal(finding("lamellar-macular-hole")?.qualifiers, undefined);
  assert.equal(finding("macular-pseudohole")?.qualifiers, undefined);

  const targets = (option: string) => macula.diagnosisCandidates
    ?.filter((candidate) => candidate.trigger.kind === "option" && candidate.trigger.anyOf.includes(option))
    .map((candidate) => candidate.diagnosisKey ?? candidate.familyGroup);
  assert.deepEqual(targets("epiretinal-membrane-erm"), ["epiretinal_membrane"]);
  for (const option of ["macular-hole", "lamellar-macular-hole", "macular-pseudohole"]) {
    assert.deepEqual(targets(option), ["macular_hole"], option);
  }
  assert.deepEqual(targets("cystoid-macular-edema-cme"), [
    "cme_following_cataract_surgery",
    "cystoid_macular_degeneration",
    "retinal_edema",
  ]);
  assert.deepEqual(targets("geographic-atrophy"), ["nonexudative-amd"]);
  assert.deepEqual(targets("cnvm"), ["exudative-amd"]);
});



test("historical ambiguous macular-hole selections — seed contract", async () => {
  const fhir = new MemoryFhir();
  const definitions = await catalog(fhir);
  const macula = definitions.find((definition) => definition.stableKey === "ocular-health:posterior:macula");
  assert.ok(macula);
  const field = Object.values(macula.valueSchema.fields as Record<string, {
    localCode?: string;
    valueType?: string;
  }>).find((candidate) => candidate.valueType === "multi-select");
  assert.ok(field?.localCode);

});



test("posterior Slice 5 exposes the sourced vitreous hemorrhage scale and categorical retinal subtypes", async () => {
  const definitions = await catalog(new MemoryFhir());
  const finding = (
    stableKey: string,
    code: string,
  ) => {
    const definition = definitions.find((candidate) => candidate.stableKey === stableKey);
    assert.ok(definition);
    return Object.values(definition.valueSchema.fields as Record<string, {
      valueType?: string;
      options?: Array<{
        code: string;
        qualifiers?: Array<{
          kind: string;
          key: string;
          display: string;
          options?: Array<string | { code: string; display: string }>;
          scheme?: string;
        }>;
      }>;
    }>).find((field) => field.valueType === "multi-select")?.options?.find((option) => option.code === code);
  };
  const flareGrade = finding("ocular-health:anterior:anterior-chamber", "flare")?.qualifiers?.[0];
  const hemorrhageGrade = finding("ocular-health:posterior:vitreous", "vitreous-hemorrhage")?.qualifiers?.[0];
  assert.ok(flareGrade && hemorrhageGrade);
  assert.deepEqual(
    { kind: hemorrhageGrade.kind, key: hemorrhageGrade.key, display: hemorrhageGrade.display },
    { kind: flareGrade.kind, key: flareGrade.key, display: flareGrade.display },
  );
  assert.deepEqual(hemorrhageGrade.options, [
    "1+ (mild; retinal detail visible)",
    "2+ (moderate; large retinal vessels visible, central detail obscured)",
    "3+ (dense; red reflex present, no central detail posterior to the equator)",
    "4+ (very dense; no red reflex)",
  ]);
  assert.equal(hemorrhageGrade.scheme, "AOS vitreous hemorrhage scale; Roche BP41321 corroboration");
  for (const option of hemorrhageGrade.options ?? []) {
    assert.equal(typeof option, "string");
    assert.doesNotMatch(String(option).replace(/\s*\(.*/, "").trim(), /^(?:grade\s*)?0$|\bnone\b/i);
  }

  assert.equal(finding("ocular-health:posterior:periphery", "operculated-hole"), undefined);
  assert.equal(finding("ocular-health:posterior:periphery", "horseshoe-tear"), undefined);
  assert.deepEqual(finding("ocular-health:posterior:periphery", "retinal-hole")?.qualifiers, [{
    kind: "enum",
    key: "subtype",
    display: "Subtype",
    options: [
      { code: "non-operculated", display: "Non-operculated" },
      { code: "operculated", display: "Operculated" },
    ],
  }]);
  assert.deepEqual(finding("ocular-health:posterior:periphery", "retinal-tear")?.qualifiers, [{
    kind: "enum",
    key: "subtype",
    display: "Subtype",
    options: [
      { code: "other", display: "Other" },
      { code: "horseshoe", display: "Horseshoe (flap)" },
    ],
  }]);
});



test("surviving Periphery diagnosis mappings keep their pre-fold public ids", async () => {
  const definitions = await catalog(new MemoryFhir());
  const periphery = definitions.find((definition) => definition.stableKey === "ocular-health:posterior:periphery");
  assert.ok(periphery);
  assert.deepEqual(periphery.diagnosisCandidates?.map((candidate) => {
    assert.equal(candidate.trigger.kind, "option");
    return {
      id: candidate.id,
      option: candidate.trigger.kind === "option" ? candidate.trigger.anyOf[0] : undefined,
      target: candidate.diagnosisKey ?? candidate.familyGroup,
    };
  }), [
    { id: "SEED_RETINAL_HORSESHOE_TEAR_2", option: "retinal-tear", target: "retinal_horseshoe_tear" },
    { id: "SEED_RETINAL_ROUND_HOLE_3", option: "retinal-hole", target: "retinal_round_hole" },
    { id: "SEED_RETINOSCHISIS_5", option: "retinoschisis", target: "retinoschisis" },
    { id: "SEED_RETINAL_DETACHMENT_SINGLE_BREAK_6", option: "retinal-detachment", target: "retinal_detachment_single_break" },
    { id: "SEED_MACULAR_DRUSEN_7", option: "drusen", target: "macular_drusen" },
    { id: "SEED_NONEXUDATIVE-AMD_8", option: "drusen", target: "nonexudative-amd" },
  ]);
});







test("posterior drusen seeds preserve plain-drusen mappings while occasional drusen stays non-codeable", async () => {
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
  assert.deepEqual(targets("ocular-health:posterior:fundus")?.slice(-2), [
    { option: "drusen", id: "SEED_MACULAR_DRUSEN_26", diagnosisKey: "macular_drusen" },
    { option: "drusen", id: "SEED_NONEXUDATIVE-AMD_27", familyGroup: "nonexudative-amd" },
  ]);
  assert.deepEqual(targets("ocular-health:posterior:periphery")?.slice(-2), [
    { option: "drusen", id: "SEED_MACULAR_DRUSEN_7", diagnosisKey: "macular_drusen" },
    { option: "drusen", id: "SEED_NONEXUDATIVE-AMD_8", familyGroup: "nonexudative-amd" },
  ]);
  const macula = definitions.find((definition) => definition.stableKey === "ocular-health:posterior:macula");
  assert.equal(macula?.allowDiagnosisMapping, true);
  assert.equal(macula?.diagnosisCandidates?.length, 13);
});

test("OH-2 seeds five posterior structures — seed contract", async () => {
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
      additional: ["retinal tear", "retinal detachment", "retinoschisis", "retinal tuft", "pigmentary changes", "cystoid degeneration", "drusen", "occasional drusen"],
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

});

test("ocular-health history returns the Observation reference written by the save — seed contract", async () => {
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


});

test("OH-2b Vessels seeds — seed contract", async () => {
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


});

test("anterior structure grades exclude retired LOCS III fields — seed contract", async () => {
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
  // Conjunctival staining is shared Ocular Health; canonical save coverage lives in r10A3OcularDoor.test.ts (W96), not this legacy capture loop.
  for (const row of cases.filter(row => row.stableKey !== "dry-eye:conjunctival-staining")) {
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

  }
});

test("DE-1 tear-stability and routine tear-film entry share one stableKey and one history — seed contract", async () => {
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

});

test("DE-1 abnormal mappings return proposal badges and never auto-confirm a diagnosis", async () => {
  const fhir = new MemoryFhir();
  fhir.encounters.push(candidateEncounter("dry-eye-mapping"));
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

function candidateEncounter(id: string): Encounter {
  return { resourceType: "Encounter", id, status: "in-progress", class: { code: "AMB" }, subject: { reference: `Patient/${id}` } };
}

class MemoryFhir {
  readonly baseUrl = "http://localhost:8103/";
  readonly encounters: Encounter[] = [];
  async read<T extends Resource>(resourceType: T["resourceType"], id: string): Promise<T> {
    const resource = [...this.encounters, ...this.basics, ...this.observations].find(row => row.resourceType === resourceType && row.id === id);
    if (!resource) throw Object.assign(new Error(`Missing ${resourceType}/${id}`), { status: 404 });
    return structuredClone(resource) as T;
  }

  readonly basics: Basic[] = [];
  readonly observations: Observation[] = [];
  readonly captureWrites: Array<{ resourceType: string; header?: string; resource: Basic | Observation | Provenance }> = [];

  async search<T extends Resource>(
    resourceType: T["resourceType"],
    params: Record<string, string> = {},
  ): Promise<Bundle<T>> {
    const resources = resourceType === "Basic"
      ? this.basics
      : resourceType !== "Observation" ? [] : this.observations
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
    const condition = headers?.["If-None-Exist"];
    if (condition) {
      const params = new URLSearchParams(condition);
      const existing = this.captureWrites.find((write) => {
        if (write.resourceType !== resource.resourceType) return false;
        if (params.has("identifier") && write.resourceType === "Observation") {
          return (write.resource as Observation).identifier?.some((item) => `${item.system}|${item.value}` === params.get("identifier"));
        }
        return params.has("target") && write.resourceType === "Provenance" &&
          (write.resource as Provenance).target.some((target) => target.reference === params.get("target"));
      });
      if (existing) {
        if (resource.id && resource.id !== existing.resource.id) throw new Error("Resource ID did not match resolved ID");
        return existing.resource as T;
      }
    }
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













test("DEFER-1 guard 4: deferred Pupils save is refused without writes", async () => {
  const fhir = new MemoryFhir();
  const definitions = await catalog(fhir);
  const response = await handleCustomSectionCaptureRequest(clinicalDeps("provider", fhir, definitions), {
    authHeader: AUTH,
    params: { stableKey: "entrance:pupils" },
    body: {
      patientReference: "Patient/p1", encounterReference: "Encounter/e1",
      eyes: { OD: { state: "deferred", customFields: [] } },
    },
  });
  assert.equal(response.status, 400);
  assert.deepEqual(response.body, { error: "Deferred is not enabled for this ocular-health structure." });
  assert.equal(fhir.captureWrites.length, 0);
});

test("DEFER-1 guard 6: runtime grants refuse non-dilation and accept dilation", async () => {
  const fhir = new MemoryFhir();
  const denied = await handleFindingDefinitionMutationRequest(definitionDeps("admin", fhir, "unused000"), {
    authHeader: AUTH,
    params: { stableKey: "ocular-health:anterior:cornea" },
    body: { action: "update-normal-template", template: "Normal cornea.", allowDeferred: true },
  });
  assert.equal(denied.status, 400);
  assert.deepEqual(denied.body, { error: "Deferral is only permitted for dilation." });
  assert.equal(fhir.basics.length, 0);
  const accepted = await handleFindingDefinitionMutationRequest(definitionDeps("admin", fhir, "unused000"), {
    authHeader: AUTH,
    params: { stableKey: "entrance:dilation" },
    body: { action: "update-normal-template", template: "Dilation", allowDeferred: true },
  });
  assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
  const saved = (await catalog(fhir)).find((definition) => definition.stableKey === "entrance:dilation");
  assert.equal(saved?.normalSemantics?.allowDeferred, true);
});
