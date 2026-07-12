import assert from "node:assert/strict";
import { test } from "node:test";
import type { Basic, Bundle, Observation, Provenance } from "@medplum/fhirtypes";
import type { PracticeRoleId } from "../src/authz/roles.js";
import {
  handleCustomSectionCaptureRequest,
  handleCustomSectionHistoryRequest,
} from "../src/clinical-graph/custom-section-endpoint.js";
import {
  handleFindingDefinitionCreationRequest,
  handleFindingDefinitionMutationRequest,
} from "../src/clinical-graph/finding-definition-endpoint.js";
import {
  FhirFindingDefinitionStore,
  buildFindingDefinitionSeeds,
} from "../src/clinical-graph/finding-definition-store.js";
import { observationCustomValue } from "../src/clinical-graph/custom-fields.js";
import type { ClinicalFindingDefinition } from "../src/clinical-graph/glaucoma-suspect.js";

const AUTH = "Bearer good";
const NOW = "2026-07-10T18:00:00.000Z";

test("Skin Carotenoid Score creates, captures, reads, renames, and deactivates without changing its stable key", async () => {
  const fhir = new MemoryFhir();
  const denied = await handleFindingDefinitionCreationRequest(definitionDeps("clinician", fhir, "scs00000"), {
    authHeader: AUTH,
    body: scsDefinitionBody(),
  });
  assert.equal(denied.status, 403);

  const created = await handleFindingDefinitionCreationRequest(definitionDeps("practice-admin", fhir, "scs00000"), {
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

  const backdated = await handleCustomSectionCaptureRequest(clinicalDeps("clinician", fhir, definitions), {
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

  const capture = await handleCustomSectionCaptureRequest(clinicalDeps("clinician", fhir, definitions), {
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
  assert.equal(fhir.observations.length, 1);
  assert.equal(fhir.observations[0]?.status, "preliminary");
  assert.equal(component(fhir.observations[0], localCode)?.valueQuantity?.value, 72);
  assert.equal(component(fhir.observations[0], "REMARKS")?.valueString, "Discussed nutrition.");
  assert.deepEqual(fhir.captureWrites.map((write) => write.resourceType), ["Observation", "Provenance"]);
  assert.equal(fhir.captureWrites.every((write) => write.header === "mcp/save_section_observations"), true);
  const provenance = fhir.captureWrites.find((write) => write.resourceType === "Provenance")?.resource as Provenance;
  assert.equal(provenance.target?.[0]?.reference?.startsWith("Observation/"), true);
  assert.equal(provenance.target?.[1]?.reference, "Patient/p1");

  const history = await handleCustomSectionHistoryRequest(clinicalDeps("clinician", fhir, definitions), {
    authHeader: AUTH,
    params: { stableKey },
    query: { patient: "Patient/p1" },
  });
  assert.equal(history.status, 200);
  assert.deepEqual((history.body as { rows: unknown[] }).rows, [{
    recordedAt: NOW,
    values: [{ code: localCode, label: "Score", value: 72 }],
    remarks: "Discussed nutrition.",
  }]);

  const renamed = await handleFindingDefinitionMutationRequest(definitionDeps("practice-admin", fhir, "unused000"), {
    authHeader: AUTH,
    params: { stableKey },
    body: { action: "update-definition", display: "Carotenoid Score" },
  });
  assert.equal(renamed.status, 200);
  assert.equal((renamed.body as { definition: { stableKey: string; display: string } }).definition.stableKey, stableKey);
  assert.equal((renamed.body as { definition: { display: string } }).definition.display, "Carotenoid Score");

  const fieldRenamed = await handleFindingDefinitionMutationRequest(definitionDeps("practice-admin", fhir, "unused000"), {
    authHeader: AUTH,
    params: { stableKey },
    body: { action: "update-custom-field", localCode, display: "SCS" },
  });
  assert.equal(fieldRenamed.status, 200);
  assert.equal((fieldRenamed.body as { field: { localCode: string } }).field.localCode, localCode);

  const deactivated = await handleFindingDefinitionMutationRequest(definitionDeps("practice-admin", fhir, "unused000"), {
    authHeader: AUTH,
    params: { stableKey },
    body: { action: "update-definition", active: false },
  });
  assert.equal(deactivated.status, 200);
  const inactiveDefinitions = await catalog(fhir);
  const blocked = await handleCustomSectionCaptureRequest(clinicalDeps("clinician", fhir, inactiveDefinitions), {
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

  await handleFindingDefinitionMutationRequest(definitionDeps("practice-admin", fhir, "unused000"), {
    authHeader: AUTH,
    params: { stableKey },
    body: { action: "update-definition", active: true },
  });
  const reactivated = await catalog(fhir);
  const restoredHistory = await handleCustomSectionHistoryRequest(clinicalDeps("clinician", fhir, reactivated), {
    authHeader: AUTH,
    params: { stableKey },
    query: { patient: "Patient/p1" },
  });
  assert.equal(restoredHistory.status, 200);
  assert.equal((restoredHistory.body as { rows: unknown[] }).rows.length, 1);
});

test("per-eye custom sections prefix field components and read OD and OS independently", async () => {
  const fhir = new MemoryFhir();
  const created = await handleFindingDefinitionCreationRequest(definitionDeps("practice-admin", fhir, "eye00000"), {
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
  const capture = await handleCustomSectionCaptureRequest(clinicalDeps("clinician", fhir, definitions), {
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

  const history = await handleCustomSectionHistoryRequest(clinicalDeps("clinician", fhir, definitions), {
    authHeader: AUTH,
    params: { stableKey: body.definition.stableKey },
    query: { patient: "Patient/p2" },
  });
  const rows = (history.body as { rows: Array<{ eye: string; values: Array<{ value: string }> }> }).rows;
  assert.deepEqual(rows.map((row) => [row.eye, row.values[0]?.value]), [["OD", "Stable"], ["OS", "Unstable"]]);

  const deniedRead = await handleCustomSectionHistoryRequest(clinicalDeps("auditor", fhir, definitions), {
    authHeader: AUTH,
    params: { stableKey: body.definition.stableKey },
    query: { patient: "Patient/p2" },
  });
  const deniedWrite = await handleCustomSectionCaptureRequest(clinicalDeps("front-desk", fhir, definitions), {
    authHeader: AUTH,
    params: { stableKey: body.definition.stableKey },
    body: {
      patientReference: "Patient/p2",
      encounterReference: "Encounter/e2",
      eyes: { OD: { customFields: [] } },
    },
  });
  assert.equal(deniedRead.status, 403);
  assert.equal(deniedWrite.status, 403);
});

test("per-eye multi-select fields namespace shared option codes, preserve legacy rows, and omit empty selections", async () => {
  const fhir = new MemoryFhir();
  const created = await handleFindingDefinitionCreationRequest(definitionDeps("practice-admin", fhir, "multi000"), {
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
  const captured = await handleCustomSectionCaptureRequest(clinicalDeps("clinician", fhir, definitions), {
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

  const history = await handleCustomSectionHistoryRequest(clinicalDeps("clinician", fhir, definitions), {
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

  const rejectedState = await handleCustomSectionCaptureRequest(clinicalDeps("clinician", fhir, definitions), {
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
  const rejectedOther = await handleCustomSectionCaptureRequest(clinicalDeps("clinician", fhir, definitions), {
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

test("OH-1 seeds nine editable structures and persists explicit normal, abnormal, nested, other, and deferred states", async () => {
  const fhir = new MemoryFhir();
  const definitions = await catalog(fhir);
  const anterior = definitions.filter((definition) => definition.stableKey.startsWith("ocular-health:anterior:"));
  assert.equal(anterior.length, 9);
  assert.equal(anterior.every((definition) => definition.valueSchema.perEye === true), true);
  assert.deepEqual(anterior.filter((definition) => definition.allowDiagnosisMapping).map((definition) => definition.stableKey), [
    "ocular-health:anterior:lids-lashes",
    "ocular-health:anterior:conjunctiva",
    "ocular-health:anterior:tear-film",
    "ocular-health:anterior:cornea",
  ]);
  assert.equal(anterior.filter((definition) => !definition.allowDiagnosisMapping)
    .every((definition) => definition.diagnosisCandidates === undefined), true);
  assert.equal(anterior.every((definition) => definition.notBillReady), true);

  const lids = anterior.find((definition) => definition.stableKey.endsWith(":lids-lashes"));
  assert.ok(lids);
  const field = Object.values(lids.valueSchema.fields as Record<string, { valueType?: string; localCode?: string }>)
    .find((candidate) => candidate.valueType === "multi-select");
  assert.ok(field?.localCode);
  const captured = await handleCustomSectionCaptureRequest(clinicalDeps("clinician", fhir, anterior), {
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

  const history = await handleCustomSectionHistoryRequest(clinicalDeps("clinician", fhir, anterior), {
    authHeader: AUTH,
    params: { stableKey: lids.stableKey },
    query: { patient: "Patient/p3", encounter: "Encounter/e3" },
  });
  const rows = (history.body as { rows: Array<{ eye: string; state: string; values: Array<{ value: string[] }>; other?: string }> }).rows;
  assert.deepEqual(rows.map((row) => [row.eye, row.state]), [["OD", "abnormal"], ["OS", "normal"]]);
  assert.deepEqual(rows[0]?.values[0]?.value, ["demodex", "demodex::collarettes"]);
  assert.equal(rows[0]?.other, "Trace sleeves.");

  const missingOtherState = await handleCustomSectionCaptureRequest(clinicalDeps("clinician", fhir, anterior), {
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
  const deferred = await handleCustomSectionCaptureRequest(clinicalDeps("clinician", fhir, anterior), {
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
    const result = await handleCustomSectionCaptureRequest(clinicalDeps("clinician", fhir, anterior), {
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

  const unknown = await handleCustomSectionCaptureRequest(clinicalDeps("clinician", fhir, anterior), {
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
  const updated = await handleFindingDefinitionMutationRequest(definitionDeps("practice-admin", fhir, "unused000"), {
    authHeader: AUTH,
    params: { stableKey: cornea.stableKey },
    body: { action: "update-custom-field", localCode: field.localCode, options },
  });
  assert.equal(updated.status, 200, JSON.stringify(updated.body));
  const templated = await handleFindingDefinitionMutationRequest(definitionDeps("practice-admin", fhir, "unused000"), {
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
  const mappingUpdate = await handleFindingDefinitionMutationRequest(definitionDeps("practice-admin", fhir, "unused000"), {
    authHeader: AUTH,
    params: { stableKey: cornea.stableKey },
    body: { action: "update-diagnosis-candidate", id: seededCandidate.id, active: false },
  });
  assert.equal(mappingUpdate.status, 200, JSON.stringify(mappingUpdate.body));
  const editedCornea = (await catalog(fhir)).find((definition) => definition.stableKey === cornea.stableKey);
  assert.equal(editedCornea?.diagnosisCandidates?.find((candidate) => candidate.id === seededCandidate.id)?.active, false);
});

test("OH-2 seeds five posterior structures and round-trips their worksheet findings per eye without diagnosis codes", async () => {
  const fhir = new MemoryFhir();
  const definitions = await catalog(fhir);
  const posterior = definitions.filter((definition) => definition.stableKey.startsWith("ocular-health:posterior:"));
  assert.deepEqual(posterior.map((definition) => definition.display), ["Vitreous", "Fundus", "Macula", "Vessels", "Periphery"]);
  assert.equal(posterior.every((definition) => definition.valueSchema.perEye === true), true);
  assert.deepEqual(posterior.filter((definition) => definition.allowDiagnosisMapping).map((definition) => definition.stableKey), [
    "ocular-health:posterior:fundus",
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
    const captured = await handleCustomSectionCaptureRequest(clinicalDeps("clinician", fhir, posterior), {
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
    const history = await handleCustomSectionHistoryRequest(clinicalDeps("clinician", fhir, posterior), {
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
    ["2:3", "2:3", true],
    ["1:2", "1:2", true],
    ["1:3", "1:3", true],
    ["1:4", "1:4", true],
  ]);

  const captured = await handleCustomSectionCaptureRequest(clinicalDeps("clinician", fhir, [vessels]), {
    authHeader: AUTH,
    params: { stableKey: vessels.stableKey },
    body: {
      patientReference: "Patient/p-vessels-grade",
      encounterReference: "Encounter/e-vessels-grade",
      eyes: {
        OD: { state: "normal", customFields: [{ code: grade.localCode, value: "2:3" }] },
        OS: { state: "abnormal", customFields: [{ code: grade.localCode, value: "1:2" }] },
      },
    },
  });
  assert.equal(captured.status, 200, JSON.stringify(captured.body));
  assert.equal(component(fhir.observations[0], `OD_${grade.localCode}`)?.valueCodeableConcept?.coding?.[0]?.code, "2:3");
  assert.equal(component(fhir.observations[1], `OS_${grade.localCode}`)?.valueCodeableConcept?.coding?.[0]?.code, "1:2");

  const history = await handleCustomSectionHistoryRequest(clinicalDeps("clinician", fhir, [vessels]), {
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

test("anterior optional grades seed, validate, remain editable, and round-trip per eye", async () => {
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
  assert.deepEqual(locs.map((field) => [field.display, field.valueType, field.min, field.max, field.step]), [
    ["LOCS III — NO (nuclear opalescence)", "number", 0.1, 6.9, 0.1],
    ["LOCS III — NC (nuclear color)", "number", 0.1, 6.9, 0.1],
    ["LOCS III — C (cortical)", "number", 0.1, 6.9, 0.1],
    ["LOCS III — P (posterior subcapsular)", "number", 0.1, 6.9, 0.1],
  ]);
  assert.equal(anteriorChamber.allowDiagnosisMapping, false);
  assert.equal(lens.allowDiagnosisMapping, false);
  assert.equal(anteriorChamber.notBillReady && tearFilm.notBillReady && lens.notBillReady, true);

  const invalidLocs = await handleCustomSectionCaptureRequest(clinicalDeps("clinician", fhir, [lens]), {
    authHeader: AUTH,
    params: { stableKey: lens.stableKey },
    body: {
      patientReference: "Patient/p-anterior-grades",
      encounterReference: "Encounter/e-anterior-grades",
      eyes: { OD: { state: "normal", customFields: [{ code: locs[0]!.localCode!, value: 0.15 }] } },
    },
  });
  assert.equal(invalidLocs.status, 400);
  assert.match(String((invalidLocs.body as { error: string }).error), /increments/);
  assert.equal(fhir.observations.length, 0);

  const vanHerickGrade2 = vanHerick.options!.find((option) => option.display === "Grade 2");
  assert.ok(vanHerickGrade2);
  assert.equal(vanHerickGrade2.code, "grade-2");
  for (const [definition, eye, field, captureValue, historyValue] of [
    [tearFilm, "OD", tbut, 6, 6],
    [anteriorChamber, "OS", vanHerick, vanHerickGrade2.code, "Grade 2"],
    [lens, "OD", locs[0], 6.9, 6.9],
  ] as const) {
    assert.ok(field?.localCode);
    const captured = await handleCustomSectionCaptureRequest(clinicalDeps("clinician", fhir, [definition]), {
      authHeader: AUTH,
      params: { stableKey: definition.stableKey },
      body: {
        patientReference: "Patient/p-anterior-grades",
        encounterReference: "Encounter/e-anterior-grades",
        eyes: { [eye]: { state: "normal", customFields: [{ code: field.localCode, value: captureValue }] } },
      },
    });
    assert.equal(captured.status, 200, JSON.stringify(captured.body));
    const history = await handleCustomSectionHistoryRequest(clinicalDeps("clinician", fhir, [definition]), {
      authHeader: AUTH,
      params: { stableKey: definition.stableKey },
      query: { patient: "Patient/p-anterior-grades", encounter: "Encounter/e-anterior-grades" },
    });
    const rows = (history.body as { rows: Array<{ eye: string; values: Array<{ code: string; value: number | string }> }> }).rows;
    assert.deepEqual(rows.map((row) => [row.eye, row.values.find((candidate) => candidate.code === field.localCode)?.value]), [[eye, historyValue]]);
  }

  const editedTbut = await handleFindingDefinitionMutationRequest(definitionDeps("practice-admin", fhir, "unused000"), {
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
  const editedVanHerick = await handleFindingDefinitionMutationRequest(definitionDeps("practice-admin", fhir, "unused000"), {
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
        .filter((observation) => observation.subject?.reference === params.subject)
        .filter((observation) => {
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
      this.captureWrites.push({ resourceType: saved.resourceType, header: headers?.["X-OSOD-Source"], resource: saved });
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
