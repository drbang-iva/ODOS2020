import assert from "node:assert/strict";
import { test } from "node:test";
import type { Observation } from "@medplum/fhirtypes";
import {
  CLINICAL_SECTION_REQUIREMENTS,
  buildExamOverviewProjection,
  deriveChangeFromPrior,
  deriveExamSectionState,
  normalizeObservationExamState,
  observationSnapshot,
  type ClinicalSectionApplicabilityRegistry,
} from "../src/clinical-graph/exam-overview-projection.js";
import type { ClinicalFindingDefinition } from "../src/clinical-graph/glaucoma-suspect.js";
import {
  buildAnteriorOcularHealthDefinitions,
  buildPosteriorOcularHealthDefinitions,
} from "../src/clinical-graph/ocular-health-definition.js";

const PROVENANCE = {
  source: "manual" as const,
  recordedAt: "2026-08-27T12:00:00.000Z",
  actorReference: "Practitioner/pr1",
};

test("the 14 ocular structures expose the approved affirmative worksheet labels in anatomical order", () => {
  const definitions = [
    ...buildAnteriorOcularHealthDefinitions(PROVENANCE),
    ...buildPosteriorOcularHealthDefinitions(PROVENANCE),
  ];

  assert.deepEqual(definitions.map((row) => [row.display, row.normalSemantics?.sheetLabel]), [
    ["Periocular Adnexa", "Periorbital region normal"],
    ["Lids & Lashes", "Normal lid position and lashes"],
    ["Palpebral Conjunctiva", "Smooth and pink"],
    ["Conjunctiva", "White and quiet"],
    ["Tear Film", "Adequate film and meniscus"],
    ["Cornea", "Clear and compact"],
    ["Anterior Chamber", "Deep and quiet"],
    ["Iris", "Flat and intact"],
    ["Lens", "Clear"],
    ["Vitreous", "Optically clear"],
    ["Fundus", "Healthy background"],
    ["Macula", "Healthy foveal reflex"],
    ["Vessels", "Normal caliber and course"],
    ["Periphery", "Flat and attached"],
  ]);
});

test("all three persisted deferred encodings normalize without rewriting source Observations", () => {
  const sources = [
    observation("custom-deferred", "ocular-health:anterior:cornea", {
      component: [
        stringComponent("EXAM_STATE", "deferred"),
        stringComponent("OTHER", "Unable to position"),
      ],
    }),
    observation("dilation-declined", "entrance:dilation", {
      component: [
        booleanComponent("DILATION_DECLINED", true),
        stringComponent("DECLINE_REASON", "Patient is driving"),
        stringComponent("COUNSELED_RISKS", "Retinal warning signs reviewed"),
      ],
    }),
    observation("iop-not-visualized", "intraocular_pressure", {
      valueString: JSON.stringify({ notVisualized: true, date: "2026-08-16" }),
    }),
    observation("cup-disc-not-visualized", "cup_disc_ratio", {
      valueString: JSON.stringify({ notVisualized: true, discAppearanceDescriptors: [] }),
    }),
  ];
  const before = structuredClone(sources);
  const projection = buildExamOverviewProjection({
    encounterReference: "Encounter/e1",
    patientReference: "Patient/p1",
    definitions: [
      definition("ocular-health:anterior:cornea", "ocular-health:anterior:cornea"),
      definition("entrance:dilation", "entrance:dilation"),
      definition("intraocular_pressure", "tonometry"),
      definition("cup_disc_ratio", "optic-nerve"),
    ],
    currentObservations: sources,
    priorObservationCandidates: [],
    assessmentRows: [],
  });

  assert.deepEqual(sources.map(normalizeObservationExamState), [
    { state: "deferred-with-reason", reason: "Unable to position", sourceEncoding: "exam-state" },
    { state: "deferred-with-reason", reason: "Patient is driving", sourceEncoding: "dilation-declined" },
    { state: "deferred-without-reason", sourceEncoding: "not-visualized-json" },
    { state: "deferred-without-reason", sourceEncoding: "not-visualized-json" },
  ]);
  assert.deepEqual(projection.findings.map((row) => row.examination), [
    { state: "deferred-with-reason", reason: "Unable to position", sourceEncoding: "exam-state" },
    { state: "deferred-with-reason", reason: "Patient is driving", sourceEncoding: "dilation-declined" },
    { state: "deferred-without-reason", sourceEncoding: "not-visualized-json" },
    { state: "deferred-without-reason", sourceEncoding: "not-visualized-json" },
  ]);
  assert.equal(projection.findings.find((row) => row.findingKey === "entrance:dilation")?.current.components
    .some((component) => component.code === "COUNSELED_RISKS"), true);
  assert.deepEqual(sources, before);
});

test("deferred with and without a reason remain independently testable", () => {
  const withReason = observation("deferred-with", "ocular-health:anterior:lens", {
    component: [
      stringComponent("EXAM_STATE", "deferred"),
      stringComponent("OTHER", "No view"),
    ],
  });
  const withoutReason = observation("deferred-without", "ocular-health:anterior:lens", {
    component: [stringComponent("EXAM_STATE", "deferred")],
  });

  assert.equal(normalizeObservationExamState(withReason).state, "deferred-with-reason");
  assert.equal(normalizeObservationExamState(withoutReason).state, "deferred-without-reason");
});

test("examined, not-examined, deferred, and not-indicated are separate section states", () => {
  const examined = normalizeObservationExamState(observation("examined", "hpi_ros", {
    valueString: "Routine examination",
  }));
  const deferred = normalizeObservationExamState(observation("deferred", "entrance:dilation", {
    component: [booleanComponent("DILATION_DECLINED", true)],
  }));

  assert.equal(deriveExamSectionState({ applicable: true, rows: [examined] }), "examined");
  assert.equal(deriveExamSectionState({ applicable: true, rows: [] }), "not-examined");
  assert.equal(deriveExamSectionState({ applicable: true, rows: [deferred] }), "deferred-without-reason");
  assert.equal(deriveExamSectionState({ applicable: false, rows: [] }), "not-indicated");
});

test("one resolved applicable row cannot make a multi-row section examined", () => {
  const examined = normalizeObservationExamState(observation("examined", "hpi_ros", {
    valueString: "Routine examination",
  }));

  assert.equal(deriveExamSectionState({
    applicable: true,
    rows: [examined, { state: "not-examined" }],
  }), "partial");

  const registry: ClinicalSectionApplicabilityRegistry = {
    limited: {
      required: [{
        sectionKey: "ocular-health",
        label: "Ocular Health",
        evidence: { kind: "finding", sectionKeyPrefixes: ["ocular-health:"] },
      }],
      notIndicated: [],
    },
  };
  const definitions = [
    definition("ocular-health:anterior:lids-lashes", "ocular-health:anterior:lids-lashes"),
    definition("ocular-health:anterior:cornea", "ocular-health:anterior:cornea"),
  ];
  const projection = buildExamOverviewProjection({
    encounterReference: "Encounter/e1",
    patientReference: "Patient/p1",
    visitTypeCategoryId: "limited",
    definitions,
    currentObservations: [observation("lids", definitions[0]!.stableKey)],
    priorObservationCandidates: [],
    assessmentRows: [],
    applicabilityRegistry: registry,
  });
  assert.equal(projection.sections[0]?.state, "partial");
  assert.equal(projection.completeness.trace[0]?.resolved, false);
  assert.equal(projection.completeness.resolvedSectionCount, 0);
});

test("ocular findings project affirmative normal text and every selected qualifier without truncation", () => {
  const lens = buildAnteriorOcularHealthDefinitions(PROVENANCE)
    .find((row) => row.stableKey === "ocular-health:anterior:lens");
  assert.ok(lens);
  const field = Object.values(lens.valueSchema.fields as Record<string, {
    localCode: string;
    valueType: string;
  }>).find((row) => row.valueType === "multi-select");
  assert.ok(field);
  const prefix = `OD_${field.localCode}`;
  const projection = buildExamOverviewProjection({
    encounterReference: "Encounter/e1",
    patientReference: "Patient/p1",
    definitions: [lens],
    currentObservations: [
      observation("lens-normal", lens.stableKey, {
        extension: [{
          url: "https://odos2020.com/fhir/StructureDefinition/eye-laterality",
          valueCodeableConcept: { coding: [{ code: "OS" }] },
        }],
        interpretation: [{ coding: [{ code: "normal" }] }],
      }),
      observation("lens-abnormal", lens.stableKey, {
        extension: [{
          url: "https://odos2020.com/fhir/StructureDefinition/eye-laterality",
          valueCodeableConcept: { coding: [{ code: "OD" }] },
        }],
        interpretation: [{ coding: [{ code: "abnormal" }] }],
        component: [
          booleanComponent(`${prefix}::nuclear-sclerosis`, true),
          codeComponent(`${prefix}::nuclear-sclerosis::grade`, "2+", "2+"),
          booleanComponent(`${prefix}::posterior-subcapsular-psc`, true),
          codeComponent(`${prefix}::posterior-subcapsular-psc::grade`, "3+", "3+"),
        ],
      }),
    ],
    priorObservationCandidates: [],
    assessmentRows: [],
  });

  assert.equal(projection.findings.find((row) => row.laterality === "OS")?.normalLabel, "Clear");
  assert.deepEqual(projection.findings.find((row) => row.laterality === "OD")?.sheetFindings, [
    { display: "nuclear sclerosis", qualifiers: ["2+"] },
    { display: "posterior subcapsular (PSC)", qualifiers: ["3+"] },
  ]);
});

test("finding projection follows definition order instead of lexical section keys", () => {
  const definitions = [
    definition("ocular-health:anterior:lids-lashes", "ocular-health:anterior:lids-lashes"),
    definition("ocular-health:anterior:cornea", "ocular-health:anterior:cornea"),
  ];
  const projection = buildExamOverviewProjection({
    encounterReference: "Encounter/e1",
    patientReference: "Patient/p1",
    definitions,
    currentObservations: [
      observation("cornea", definitions[1]!.stableKey),
      observation("lids", definitions[0]!.stableKey),
    ],
    priorObservationCandidates: [],
    assessmentRows: [],
  });

  assert.deepEqual(projection.findings.map((row) => row.findingKey), definitions.map((row) => row.stableKey));
});

test("change from prior is derived from snapshots and no delta is persisted", () => {
  const prior = observation("iop-prior", "intraocular_pressure", {
    encounter: { reference: "Encounter/e0" },
    effectiveDateTime: "2026-07-10T14:00:00.000Z",
    valueQuantity: { value: 15, unit: "mmHg", system: "http://unitsofmeasure.org", code: "mm[Hg]" },
  });
  const current = observation("iop-current", "intraocular_pressure", {
    valueQuantity: { value: 18, unit: "mmHg", system: "http://unitsofmeasure.org", code: "mm[Hg]" },
    interpretation: [{ coding: [{ code: "abnormal" }] }],
  });
  const before = structuredClone([prior, current]);
  const priorSnapshot = observationSnapshot(prior);
  const currentSnapshot = observationSnapshot(current);

  assert.deepEqual(deriveChangeFromPrior(currentSnapshot, priorSnapshot), {
    kind: "numeric",
    delta: 3,
    unit: "mmHg",
  });
  assert.deepEqual([prior, current], before);
  assert.equal([prior, current].some((row) => row.component?.some((component) =>
    component.code.coding?.some((coding) => coding.code === "DELTA")
  )), false);
});

test("prior comparison ignores future and encounter-less Observations", () => {
  const projection = buildExamOverviewProjection({
    encounterReference: "Encounter/e1",
    patientReference: "Patient/p1",
    definitions: [definition("intraocular_pressure", "tonometry")],
    currentObservations: [observation("iop-current", "intraocular_pressure", {
      effectiveDateTime: "2026-08-16T12:00:00.000Z",
      valueQuantity: { value: 18, unit: "mmHg", code: "mm[Hg]" },
    })],
    priorObservationCandidates: [
      observation("iop-valid-prior", "intraocular_pressure", {
        encounter: { reference: "Encounter/e0" },
        effectiveDateTime: "2026-07-10T12:00:00.000Z",
        valueQuantity: { value: 15, unit: "mmHg", code: "mm[Hg]" },
      }),
      observation("iop-future", "intraocular_pressure", {
        encounter: { reference: "Encounter/e2" },
        effectiveDateTime: "2026-09-10T12:00:00.000Z",
        valueQuantity: { value: 30, unit: "mmHg", code: "mm[Hg]" },
      }),
      observation("iop-encounterless", "intraocular_pressure", {
        encounter: undefined,
        effectiveDateTime: "2026-08-01T12:00:00.000Z",
        valueQuantity: { value: 20, unit: "mmHg", code: "mm[Hg]" },
      }),
    ],
    assessmentRows: [],
  });

  assert.deepEqual(projection.findings[0]?.prior?.value, {
    kind: "quantity",
    value: 15,
    unit: "mmHg",
    code: "mm[Hg]",
  });
  assert.deepEqual(projection.findings[0]?.changeFromPrior, {
    kind: "numeric",
    delta: 3,
    unit: "mmHg",
  });
});

test("comprehensive clinical completeness is traceable and missing deferred documentation does not make it incomplete", () => {
  const definitions = [
    definition("hpi_ros", "hpi"),
    definition("entrance:pupils", "entrance:pupils"),
    definition("refraction", "refraction"),
    definition("wearing_rx", "wearing"),
    definition("ocular-health:anterior:cornea", "ocular-health:anterior:cornea"),
  ];
  const current = [
    observation("history", "hpi_ros", { valueString: "Routine examination" }),
    observation("entrance", "entrance:pupils", {
      component: [stringComponent("EXAM_STATE", "deferred")],
    }),
    observation("entrance-examined", "entrance:pupils", {
      component: [stringComponent("EXAM_STATE", "normal")],
    }),
    observation("refraction", "refraction", { valueString: "Manifest" }),
    observation("pretest", "wearing_rx", { valueString: "Current glasses" }),
    observation("ocular-health", "ocular-health:anterior:cornea", {
      component: [stringComponent("EXAM_STATE", "normal")],
    }),
  ];

  const projection = buildExamOverviewProjection({
    encounterReference: "Encounter/e1",
    patientReference: "Patient/p1",
    visitTypeCategoryId: "comprehensive",
    definitions,
    currentObservations: current,
    priorObservationCandidates: [],
    assessmentRows: [{ problemStatusRecorded: true }],
  });

  assert.equal(projection.completeness.status, "complete");
  assert.equal(projection.completeness.requiredSectionCount, 6);
  assert.equal(projection.completeness.resolvedSectionCount, 6);
  assert.deepEqual(projection.completeness.documentationIssues, [{
    sectionKey: "entrance",
    issue: "deferred-reason-missing",
  }]);
  assert.equal(projection.sections.find((row) => row.sectionKey === "entrance")?.state, "examined");
  assert.equal(projection.completeness.trace.find((row) => row.sectionKey === "entrance")?.resolved, true);
});

test("carried-unreasserted does not resolve today's section while carried-reasserted does", () => {
  const definitions = [definition("hpi_ros", "hpi")];
  const current = [observation("history", "hpi_ros", { valueString: "Carried history" })];
  const common = {
    encounterReference: "Encounter/e1",
    patientReference: "Patient/p1",
    visitTypeCategoryId: "comprehensive",
    definitions,
    currentObservations: current,
    priorObservationCandidates: [],
    assessmentRows: [],
  };
  const unreasserted = buildExamOverviewProjection({
    ...common,
    provenanceByObservation: {
      "Observation/history": { state: "carried-unreasserted", sourceDate: "2026-07-10" },
    },
  });
  const reasserted = buildExamOverviewProjection({
    ...common,
    provenanceByObservation: {
      "Observation/history": { state: "carried-reasserted", sourceDate: "2026-07-10" },
    },
  });

  assert.equal(unreasserted.sections.find((row) => row.sectionKey === "history")?.state, "not-examined");
  assert.equal(unreasserted.findings[0]?.provenance.state, "carried-unreasserted");
  assert.equal(reasserted.sections.find((row) => row.sectionKey === "history")?.state, "examined");
  assert.equal(reasserted.findings[0]?.provenance.state, "carried-reasserted");
});

test("section abnormal counts exclude independently classified borderline findings", () => {
  const registry: ClinicalSectionApplicabilityRegistry = {
    limited: {
      required: [{
        sectionKey: "pretest",
        label: "Pretest",
        evidence: { kind: "finding", sectionKeyPrefixes: ["tonometry"] },
      }],
      notIndicated: [],
    },
  };
  const projection = buildExamOverviewProjection({
    encounterReference: "Encounter/e1",
    patientReference: "Patient/p1",
    visitTypeCategoryId: "limited",
    definitions: [definition("intraocular_pressure", "tonometry")],
    currentObservations: [
      observation("iop-abnormal", "intraocular_pressure", {
        interpretation: [{ coding: [{ code: "abnormal" }] }],
      }),
      observation("iop-borderline", "intraocular_pressure", {
        interpretation: [{ coding: [{ code: "borderline" }] }],
      }),
    ],
    priorObservationCandidates: [],
    assessmentRows: [],
    applicabilityRegistry: registry,
  });

  assert.equal(projection.sections[0]?.abnormalCount, 1);
});

test("standard Equivocal interpretation projects as borderline", () => {
  const projection = buildExamOverviewProjection({
    encounterReference: "Encounter/e1",
    patientReference: "Patient/p1",
    definitions: [definition("cup_disc_ratio", "ocular-health")],
    currentObservations: [
      observation("cup-disc-equivocal", "cup_disc_ratio", {
        interpretation: [{
          coding: [{
            system: "http://terminology.hl7.org/CodeSystem/v3-ObservationInterpretation",
            code: "E",
            display: "Equivocal",
          }],
        }],
      }),
    ],
    priorObservationCandidates: [],
    assessmentRows: [],
  });

  assert.equal(projection.findings[0]?.interpretation, "borderline");
});

test("an unpopulated visit category degrades safely without false completeness", () => {
  const projection = buildExamOverviewProjection({
    encounterReference: "Encounter/e1",
    patientReference: "Patient/p1",
    visitTypeCategoryId: "diagnostic-only",
    definitions: [],
    currentObservations: [],
    priorObservationCandidates: [],
    assessmentRows: [],
  });
  const prototypeNamedProjection = buildExamOverviewProjection({
    encounterReference: "Encounter/e1",
    patientReference: "Patient/p1",
    visitTypeCategoryId: "constructor",
    definitions: [],
    currentObservations: [],
    priorObservationCandidates: [],
    assessmentRows: [],
  });

  assert.equal(Object.hasOwn(CLINICAL_SECTION_REQUIREMENTS, "diagnostic-only"), false);
  assert.deepEqual(projection.completeness, {
    status: "unconfigured",
    requiredSectionCount: 0,
    resolvedSectionCount: 0,
    trace: [],
    documentationIssues: [],
  });
  assert.equal(prototypeNamedProjection.completeness.status, "unconfigured");
  assert.equal(prototypeNamedProjection.completeness.requiredSectionCount, 0);
});

test("the applicability registry supports visit-specific not-indicated sections without an office-visit entry", () => {
  const registry: ClinicalSectionApplicabilityRegistry = {
    limited: {
      required: [{ sectionKey: "history", label: "History", evidence: { kind: "finding", sectionKeyPrefixes: ["hpi"] } }],
      notIndicated: [{ sectionKey: "refraction", label: "Refraction", evidence: { kind: "finding", sectionKeyPrefixes: ["refraction"] } }],
    },
  };
  const projection = buildExamOverviewProjection({
    encounterReference: "Encounter/e1",
    patientReference: "Patient/p1",
    visitTypeCategoryId: "limited",
    definitions: [],
    currentObservations: [],
    priorObservationCandidates: [],
    assessmentRows: [],
    applicabilityRegistry: registry,
  });

  assert.equal(projection.sections.find((row) => row.sectionKey === "history")?.state, "not-examined");
  assert.equal(projection.sections.find((row) => row.sectionKey === "refraction")?.state, "not-indicated");
  assert.equal(Object.hasOwn(CLINICAL_SECTION_REQUIREMENTS, "office-visit"), false);
});

function definition(stableKey: string, sectionKey: string): ClinicalFindingDefinition {
  return {
    id: `finding-def-${stableKey}`,
    stableKey,
    display: stableKey,
    sectionKey,
    anatomyTarget: "eye",
    valueSchema: {},
    normalSemantics: {},
    sourceStatus: "verified-seed",
    allowDiagnosisMapping: false,
    notBillReady: true,
    active: true,
    provenance: {
      source: "manual",
      recordedAt: "2026-08-16T12:00:00.000Z",
      actorReference: "Practitioner/pr1",
    },
  };
}

function observation(
  id: string,
  code: string,
  extra: Partial<Observation> = {},
): Observation {
  return {
    resourceType: "Observation",
    id,
    status: "final",
    code: { coding: [{ system: "https://odos2020.com/fhir/CodeSystem/odos", code }] },
    subject: { reference: "Patient/p1" },
    encounter: { reference: "Encounter/e1" },
    effectiveDateTime: "2026-08-16T12:00:00.000Z",
    ...extra,
  };
}

function stringComponent(code: string, value: string): NonNullable<Observation["component"]>[number] {
  return { code: { coding: [{ code }] }, valueString: value };
}

function booleanComponent(code: string, value: boolean): NonNullable<Observation["component"]>[number] {
  return { code: { coding: [{ code }] }, valueBoolean: value };
}

function codeComponent(
  code: string,
  value: string,
  display: string,
): NonNullable<Observation["component"]>[number] {
  return {
    code: { coding: [{ code }] },
    valueCodeableConcept: { coding: [{ code: value, display }] },
  };
}

test("guard 2: a voided (entered-in-error) CVF row leaves the Overview; when every row is voided the section has no findings", () => {
  const definitions = [definition("entrance:cvf", "entrance:cvf"), definition("entrance:pupils", "entrance:pupils")];
  const eye = (code: "OD" | "OS") => ({
    extension: [{ url: "https://odos2020.com/fhir/StructureDefinition/eye-laterality", valueCodeableConcept: { coding: [{ code }] } }],
  });
  const partial = buildExamOverviewProjection({
    encounterReference: "Encounter/e1",
    patientReference: "Patient/p1",
    definitions,
    currentObservations: [
      observation("cvf-od", "entrance:cvf", { ...eye("OD"), component: [stringComponent("EXAM_STATE", "normal")] }),
      observation("cvf-os", "entrance:cvf", { ...eye("OS"), status: "entered-in-error", component: [stringComponent("EXAM_STATE", "abnormal")] }),
      observation("pupils-od", "entrance:pupils", { ...eye("OD"), component: [stringComponent("EXAM_STATE", "normal")] }),
    ],
    priorObservationCandidates: [],
    assessmentRows: [],
  });
  assert.deepEqual(
    partial.findings.filter((finding) => finding.sectionKey === "entrance:cvf").map((finding) => finding.observationReference),
    ["Observation/cvf-od"],
  );
  assert.ok(partial.sections.every((section) => !section.findingObservationReferences.includes("Observation/cvf-os")));

  const allVoided = buildExamOverviewProjection({
    encounterReference: "Encounter/e1",
    patientReference: "Patient/p1",
    definitions,
    currentObservations: [
      observation("cvf-od", "entrance:cvf", { ...eye("OD"), status: "entered-in-error", component: [stringComponent("EXAM_STATE", "normal")] }),
      observation("cvf-os", "entrance:cvf", { ...eye("OS"), status: "entered-in-error", component: [stringComponent("EXAM_STATE", "normal")] }),
      observation("pupils-od", "entrance:pupils", { ...eye("OD"), component: [stringComponent("EXAM_STATE", "normal")] }),
    ],
    priorObservationCandidates: [],
    assessmentRows: [],
  });
  assert.equal(allVoided.findings.some((finding) => finding.sectionKey === "entrance:cvf"), false, "no CVF finding may survive a full void");
  const cvfSection = allVoided.sections.find((section) => section.sectionKey === "entrance:cvf");
  assert.deepEqual(cvfSection?.findingObservationReferences ?? [], []);
  assert.deepEqual(allVoided.findings.map((finding) => finding.observationReference), ["Observation/pupils-od"]);
});
