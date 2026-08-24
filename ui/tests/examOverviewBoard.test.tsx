import assert from "node:assert/strict";
import { test } from "node:test";
import React from "react";
import type { Encounter } from "@medplum/fhirtypes";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import type { ExamOverviewProjection } from "../../mcp/src/clinical-graph/exam-overview-projection";
import { DiagnosisWorkspace } from "../src/components/charting/DiagnosisWorkspace";
import { AssessmentSection } from "../src/components/charting/AssessmentSection";
import { AutoRefractionSection } from "../src/components/charting/AutoRefractionSection";
import { CoverTestSection } from "../src/components/charting/CoverTestSection";
import { CupDiscSection } from "../src/components/charting/CupDiscSection";
import { CvfSection } from "../src/components/charting/CvfSection";
import { DilationSection } from "../src/components/charting/DilationSection";
import { DryEyeSection } from "../src/components/charting/DryEyeSection";
import { EntranceMeasurementSection } from "../src/components/charting/EntranceMeasurementSection";
import { EntranceStateSection } from "../src/components/charting/EntranceStateSection";
import { EomSection } from "../src/components/charting/EomSection";
import { EncounterHeader } from "../src/components/charting/EncounterHeader";
import { EyeGrowthSection } from "../src/components/charting/EyeGrowthSection";
import { ExamEntrySheet } from "../src/components/charting/ExamEntrySheet";
import { ExamOverviewBoard } from "../src/components/charting/ExamOverviewBoard";
import { GonioscopySection } from "../src/components/charting/GonioscopySection";
import { HpiSection } from "../src/components/charting/HpiSection";
import { ImagingSection } from "../src/components/charting/ImagingSection";
import { IopSection } from "../src/components/charting/IopSection";
import { MyopiaManagementSection } from "../src/components/charting/MyopiaManagementSection";
import { OrthoKSection } from "../src/components/charting/OrthoKSection";
import { PrescriptionSection } from "../src/components/charting/PrescriptionSection";
import { RefractionHistorySection } from "../src/components/charting/RefractionHistorySection";
import { ProcedureChargeList } from "../src/components/charting/ProcedureChargeList";
import { BalanceChips } from "../src/components/commercial/BalanceChips";
import { SpineNav } from "../src/components/charting/SpineNav";
import { VisitCodeSelector } from "../src/components/charting/VisitCodeSelector";
import { VaSection } from "../src/components/charting/VaSection";
import { RefractionSection } from "../src/components/charting/RefractionSection";
import { SoftContactLensSection } from "../src/components/charting/SoftContactLensSection";
import { SpecialtyContactLensSection } from "../src/components/charting/SpecialtyContactLensSection";
import { WearingSection } from "../src/components/charting/WearingSection";
import { ReferralCompose } from "../src/components/referral/ReferralCompose";
import type { CustomFindingDefinition } from "../src/components/charting/CustomFindingSection";
import type { EncounterFindingRow } from "../src/lib/diagnosis-findings";
import { fhir } from "../src/lib/fhir";
import { RoleProvider } from "../src/lib/role-context";
import { ODOS_DISCIPLINE_SYSTEM, type SchedulingDiscipline } from "../src/lib/scheduling";
import { EncounterCharting } from "../src/scenes/EncounterCharting";

(globalThis as typeof globalThis & { React: typeof React }).React = React;

const PROJECTION: ExamOverviewProjection = {
  encounterReference: "Encounter/exam-1",
  patientReference: "Patient/patient-1",
  visitTypeCategoryId: "comprehensive",
  findings: [
    {
      observationReference: "Observation/iop-os",
      findingKey: "intraocular-pressure",
      sectionKey: "tonometry",
      display: "Intraocular pressure",
      laterality: "OS",
      examination: { state: "examined", sourceEncoding: "observation" },
      interpretation: "normal",
      provenance: { state: "current" },
      current: { value: { kind: "quantity", value: 15, unit: "mmHg" }, components: [] },
      prior: { value: { kind: "quantity", value: 15, unit: "mmHg" }, components: [] },
    },
    {
      observationReference: "Observation/iop-od",
      findingKey: "intraocular-pressure",
      sectionKey: "tonometry",
      display: "Intraocular pressure",
      laterality: "OD",
      examination: { state: "examined", sourceEncoding: "observation" },
      interpretation: "abnormal",
      provenance: { state: "carried-unreasserted", sourceDate: "2026-07-01" },
      current: { value: { kind: "quantity", value: 19, unit: "mmHg" }, components: [] },
      prior: { value: { kind: "quantity", value: 15, unit: "mmHg" }, components: [] },
      changeFromPrior: { kind: "numeric", delta: 4, unit: "mmHg" },
    },
    {
      observationReference: "Observation/cvf-ou",
      findingKey: "confrontation-visual-fields",
      sectionKey: "entrance:cvf",
      display: "Confrontation visual fields",
      laterality: "OU",
      examination: {
        state: "deferred-with-reason",
        reason: "Patient declined",
        sourceEncoding: "exam-state",
      },
      interpretation: "unknown",
      provenance: { state: "carried-reasserted", sourceDate: "2026-07-01" },
      current: { value: { kind: "string", value: "Deferred" }, components: [] },
    },
    {
      observationReference: "Observation/dilation-unknown",
      findingKey: "dilation",
      sectionKey: "entrance:dilation",
      display: "Dilation",
      laterality: "UNKNOWN",
      examination: {
        state: "deferred-without-reason",
        sourceEncoding: "not-visualized-json",
      },
      interpretation: "unknown",
      provenance: { state: "current" },
      current: { value: { kind: "string", value: "Not visualized" }, components: [] },
    },
  ],
  sections: [
    {
      sectionKey: "pretest",
      label: "Pretest",
      state: "examined",
      findingObservationReferences: [
        "Observation/iop-os",
        "Observation/iop-od",
        "Observation/cvf-ou",
        "Observation/dilation-unknown",
      ],
      abnormalCount: 1,
      carriedUnreassertedCount: 1,
      deferredWithoutReasonCount: 1,
    },
    {
      sectionKey: "history",
      label: "History",
      state: "not-examined",
      findingObservationReferences: [],
      abnormalCount: 0,
      carriedUnreassertedCount: 0,
      deferredWithoutReasonCount: 0,
    },
    {
      sectionKey: "assessment",
      label: "Assessment",
      state: "not-indicated",
      findingObservationReferences: [],
      abnormalCount: 0,
      carriedUnreassertedCount: 0,
      deferredWithoutReasonCount: 0,
    },
  ],
  completeness: {
    status: "incomplete",
    requiredSectionCount: 2,
    resolvedSectionCount: 1,
    trace: [
      {
        sectionKey: "pretest",
        label: "Pretest",
        state: "examined",
        resolved: true,
        carriedUnreassertedCount: 1,
      },
      {
        sectionKey: "history",
        label: "History",
        state: "not-examined",
        resolved: false,
        carriedUnreassertedCount: 0,
      },
    ],
    documentationIssues: [{ sectionKey: "pretest", issue: "deferred-reason-missing" }],
  },
};

const BY_EXCEPTION_PROJECTION = {
  encounterReference: "Encounter/exam-1",
  patientReference: "Patient/patient-1",
  visitTypeCategoryId: "comprehensive",
  findings: [
    {
      observationReference: "Observation/eom-od",
      findingKey: "entrance:eom",
      sectionKey: "entrance:eom",
      display: "EOM",
      laterality: "OD",
      examination: { state: "examined", sourceEncoding: "observation" },
      interpretation: "normal",
      provenance: { state: "current" },
      current: { recordedAt: "2026-08-24T14:35:00.000Z", components: [] },
    },
    {
      observationReference: "Observation/eom-os",
      findingKey: "entrance:eom",
      sectionKey: "entrance:eom",
      display: "EOM",
      laterality: "OS",
      examination: { state: "examined", sourceEncoding: "observation" },
      interpretation: "normal",
      provenance: { state: "current" },
      current: { recordedAt: "2026-08-24T14:35:00.000Z", components: [] },
    },
    {
      observationReference: "Observation/cover",
      findingKey: "entrance:cover",
      sectionKey: "entrance:cover",
      display: "Cover test",
      laterality: "OU",
      examination: { state: "examined", sourceEncoding: "observation" },
      interpretation: "normal",
      provenance: { state: "current" },
      summary: "NEAR 3 XP",
      current: { recordedAt: "2026-08-24T14:36:00.000Z", components: [] },
    },
    {
      observationReference: "Observation/pachy-od",
      findingKey: "pachymetry_um",
      sectionKey: "entrance:pachymetry",
      display: "Pachymetry",
      laterality: "OD",
      examination: { state: "examined", sourceEncoding: "observation" },
      interpretation: "normal",
      provenance: { state: "current" },
      current: {
        recordedAt: "2026-08-24T14:37:00.000Z",
        components: [
          { code: "CUSTOM_CCT", display: "Central corneal thickness", value: { kind: "quantity", value: 541, unit: "um" } },
          { code: "entrance.pachymetry", value: { kind: "string", value: "must-not-render" } },
        ],
      },
    },
    {
      observationReference: "Observation/pachy-os",
      findingKey: "pachymetry_um",
      sectionKey: "entrance:pachymetry",
      display: "Pachymetry",
      laterality: "OS",
      examination: { state: "examined", sourceEncoding: "observation" },
      interpretation: "normal",
      provenance: { state: "current" },
      current: {
        recordedAt: "2026-08-24T14:37:00.000Z",
        components: [{ code: "CUSTOM_CCT", display: "Central corneal thickness", value: { kind: "quantity", value: 538, unit: "um" } }],
      },
    },
    {
      observationReference: "Observation/dilation",
      findingKey: "entrance:dilation",
      sectionKey: "entrance:dilation",
      display: "Dilation",
      laterality: "OU",
      examination: { state: "examined", sourceEncoding: "observation" },
      interpretation: "unknown",
      provenance: { state: "current" },
      event: {
        administrations: [
          { agent: "tropicamide 1%", occurredAt: "2026-08-24T14:42:00.000Z" },
          { agent: "phenylephrine 2.5%", occurredAt: "2026-08-24T14:42:00.000Z" },
        ],
      },
      current: { recordedAt: "2026-08-24T14:42:00.000Z", components: [] },
    },
    {
      observationReference: "Observation/cvf-od",
      findingKey: "entrance:cvf",
      sectionKey: "entrance:cvf",
      display: "Confrontation fields",
      laterality: "OD",
      examination: { state: "examined", sourceEncoding: "observation" },
      interpretation: "abnormal",
      provenance: { state: "current" },
      diagnoses: [{ display: "Visual field defect", laterality: "OD" }],
      attestation: { attestedBy: ["Dr. Avery Chen"], recordedAt: "2026-08-24T14:43:00.000Z" },
      current: {
        recordedAt: "2026-08-24T14:43:00.000Z",
        components: [
          { code: "CUSTOM_CVF_UPPER_LEFT", display: "Upper left", value: { kind: "string", value: "restricted" } },
          { code: "CUSTOM_CVF_UPPER_RIGHT", display: "Upper right", value: { kind: "string", value: "full" } },
          { code: "CUSTOM_CVF_LOWER_LEFT", display: "Lower left", value: { kind: "string", value: "full" } },
          { code: "CUSTOM_CVF_LOWER_RIGHT", display: "Lower right", value: { kind: "string", value: "full" } },
          { code: "EXAM_STATE", display: "Exam state", value: { kind: "string", value: "abnormal" } },
        ],
      },
    },
    {
      observationReference: "Observation/cvf-os",
      findingKey: "entrance:cvf",
      sectionKey: "entrance:cvf",
      display: "Confrontation fields",
      laterality: "OS",
      examination: { state: "examined", sourceEncoding: "observation" },
      interpretation: "normal",
      provenance: { state: "current" },
      current: { recordedAt: "2026-08-24T14:43:00.000Z", components: [] },
    },
    ...refractionFixtureRows(),
    {
      observationReference: "Observation/dilation-deferred",
      findingKey: "entrance:dilation-deferred",
      sectionKey: "entrance:dilation",
      display: "Dilation",
      laterality: "OU",
      examination: { state: "deferred-with-reason", reason: "patient driving", sourceEncoding: "exam-state" },
      interpretation: "unknown",
      provenance: { state: "current" },
      current: { recordedAt: "2026-08-24T14:46:00.000Z", components: [] },
    },
    {
      observationReference: "Observation/carried-iop",
      findingKey: "intraocular_pressure",
      sectionKey: "tonometry",
      display: "Intraocular pressure",
      laterality: "OD",
      examination: { state: "examined", sourceEncoding: "observation" },
      interpretation: "abnormal",
      provenance: { state: "carried-reasserted", sourceDate: "2026-07-01" },
      current: { value: { kind: "quantity", value: 24, unit: "mmHg" }, components: [] },
    },
  ],
  sections: [
    overviewSection("entrance", "Entrance", [
      "Observation/eom-od", "Observation/eom-os", "Observation/cover", "Observation/pachy-od",
      "Observation/pachy-os", "Observation/dilation", "Observation/cvf-od", "Observation/cvf-os",
      "Observation/dilation-deferred",
    ]),
    overviewSection("refraction", "Refraction", [
      "Observation/manifest-old-od", "Observation/manifest-old-os", "Observation/manifest-new-od",
      "Observation/manifest-new-os", "Observation/final-od", "Observation/final-os", "Observation/wearing",
    ]),
    overviewSection("pretest", "Pretest", ["Observation/carried-iop"]),
    overviewSection("history", "History", [], "not-examined"),
    overviewSection("assessment", "Assessment", [], "not-indicated"),
  ],
  completeness: PROJECTION.completeness,
} as ExamOverviewProjection;

test("by-exception board renders exactly one row per performed or deferred finding", () => {
  const renderer = create(
    <ExamOverviewBoard
      projection={BY_EXCEPTION_PROJECTION}
      editorEntries={[
        { id: "eom", label: "EOM", group: "ENTRANCE" },
        { id: "color-vision", label: "Color vision", group: "ENTRANCE" },
        { id: "stereopsis", label: "Stereopsis", group: "ENTRANCE" },
        { id: "refraction", label: "Refraction", group: "REFRACTION" },
        { id: "hpi", label: "History", group: "HISTORY" },
      ]}
      refreshing={false}
      onOpenEditor={() => undefined}
      onRefresh={() => undefined}
    />,
  );
  try {
    const rows = renderer.root.findAllByProps({ "data-testid": "exam-finding-row" });
    assert.equal(rows.length, 7);
    assert.deepEqual(rows.map((row) => row.props["data-row-pattern"]), [
      "eye-pair", "word", "eye-pair", "event", "diagram", "word", "rx",
    ]);
    assert.equal(rows.filter((row) => row.props["data-finding-key"] === "pachymetry_um").length, 1);
    assert.equal(rows.filter((row) => row.props["data-finding-key"] === "intraocular_pressure").length, 0);
    assert.equal(renderer.root.findAllByProps({ "data-section-key": "history" }).length, 0);
    assert.equal(renderer.root.findAllByProps({ "data-section-key": "assessment" }).length, 0);
    const rendered = JSON.stringify(renderer.toJSON());
    assert.doesNotMatch(rendered, /not charted|not examined|not indicated|No finding observations recorded/i);
    assert.equal(renderer.root.findAllByProps({ "data-testid": "chart-another-finding" }).length, 2);
  } finally {
    renderer.unmount();
  }
});

test("five row patterns use clinical display values without exposing machine state", () => {
  const renderer = create(
    <ExamOverviewBoard
      projection={BY_EXCEPTION_PROJECTION}
      editorEntries={[]}
      refreshing={false}
      onOpenEditor={() => undefined}
      onRefresh={() => undefined}
    />,
  );
  try {
    const rendered = JSON.stringify(renderer.toJSON());
    const eom = renderer.root.findByProps({ "data-finding-key": "entrance:eom" });
    assert.equal(textContent(eom), "EOMfull");
    assert.doesNotMatch(textContent(eom), /OD|OS/);
    assert.match(rendered, /Cover test.*NEAR 3 XP/);
    assert.match(rendered, /Pachymetry.*OD.*541.*OS.*538/);
    assert.match(rendered, /Dilation.*tropicamide 1%.*phenylephrine 2\.5%.*10:42/);
    assert.equal(renderer.root.findAllByProps({ "data-testid": "visual-field-diagram" }).length, 2);
    assert.equal(renderer.root.findAllByProps({ "data-eye": "OD", "data-restricted-quadrants": "upper-left" }).length, 1);
    assert.equal(renderer.root.findAllByProps({ "data-eye": "OS", "data-restricted-quadrants": "" }).length, 1);
    const cvf = renderer.root.findByProps({ "data-finding-key": "entrance:cvf" });
    assert.match(cvf.props.className, /is-exception/);
    assert.match(textContent(cvf), /filed under: Visual field defect — OD/);
    assert.match(textContent(cvf), /Attested by Dr\. Avery Chen · 10:43 · current visit/);
    assert.match(rendered, /deferred — patient driving/);
    assert.doesNotMatch(rendered, /Examined|Current visit|Interpretation not recorded|Exam state|Normal template/);
    assert.doesNotMatch(rendered, /entrance\.pachymetry|must-not-render|refraction-block-|Observation\/|Encounter\//);

    const normalCvf = create(
      <ExamOverviewBoard
        projection={normalCvfProjection()}
        editorEntries={[]}
        refreshing={false}
        onOpenEditor={() => undefined}
        onRefresh={() => undefined}
      />,
    );
    try {
      const normalRow = normalCvf.root.findByProps({ "data-finding-key": "entrance:cvf" });
      assert.equal(normalRow.props["data-row-pattern"], "diagram");
      assert.equal(textContent(normalRow), "Confrontation fieldsfull");
      assert.equal(normalRow.findAllByProps({ "data-testid": "visual-field-diagram" }).length, 0);
    } finally {
      normalCvf.unmount();
    }
  } finally {
    renderer.unmount();
  }
});

test("refraction chooses the latest manifest, preserves stored signs, and keeps non-primary blocks collapsed", () => {
  const renderer = create(
    <ExamOverviewBoard
      projection={BY_EXCEPTION_PROJECTION}
      editorEntries={[]}
      refreshing={false}
      onOpenEditor={() => undefined}
      onRefresh={() => undefined}
    />,
  );
  try {
    const row = renderer.root.findByProps({ "data-finding-key": "refraction" });
    const rendered = textContent(row);
    assert.match(rendered, /Refraction — Manifest/);
    assert.match(rendered, /OD −1\.00 −0\.50 ×180 20\/20/);
    assert.match(rendered, /OS −1\.25 sph 20\/20/);
    assert.match(rendered, /Add \+2\.00/);
    assert.match(rendered, /Wearing Rx OD −0\.75 −0\.50 ×175 OS −1\.00 sph/);
    assert.match(rendered, /Full battery · 3 blocks/);
    assert.doesNotMatch(rendered, /−2\.00|Final Rx|refraction-block-/);

    const positiveCylinder = create(
      <ExamOverviewBoard
        projection={positiveCylinderProjection()}
        editorEntries={[]}
        refreshing={false}
        onOpenEditor={() => undefined}
        onRefresh={() => undefined}
      />,
    );
    try {
      assert.match(textContent(positiveCylinder.root.findByProps({ "data-finding-key": "refraction" })), /\+0\.50 ×090/);
    } finally {
      positiveCylinder.unmount();
    }

    const priorComparison = create(
      <ExamOverviewBoard
        projection={priorRefractionProjection()}
        editorEntries={[]}
        refreshing={false}
        onOpenEditor={() => undefined}
        onRefresh={() => undefined}
      />,
    );
    try {
      assert.match(
        textContent(priorComparison.root.findByProps({ "data-finding-key": "refraction" })),
        /Prior refraction OD −1\.50 sph OS −1\.75 sph/,
      );
    } finally {
      priorComparison.unmount();
    }
  } finally {
    renderer.unmount();
  }
});

function refractionFixtureRows() {
  return [
    refractionFinding("manifest-old-od", "OD", "2026-08-24T14:30:00.000Z", "old-block", "MANIFEST", {
      sphere: -2,
      cylinder: -0.5,
      axis: 170,
      distanceVisualAcuity: "20/25",
    }),
    refractionFinding("manifest-old-os", "OS", "2026-08-24T14:30:00.000Z", "old-block", "MANIFEST", {
      sphere: -2.25,
      distanceVisualAcuity: "20/25",
    }),
    refractionFinding("manifest-new-od", "OD", "2026-08-24T14:45:00.000Z", "new-block", "MANIFEST", {
      sphere: -1,
      cylinder: -0.5,
      axis: 180,
      add: 2,
      distanceVisualAcuity: "20/20",
    }),
    refractionFinding("manifest-new-os", "OS", "2026-08-24T14:45:00.000Z", "new-block", "MANIFEST", {
      sphere: -1.25,
      add: 2,
      distanceVisualAcuity: "20/20",
    }),
    refractionFinding("final-od", "OD", "2026-08-24T14:45:00.000Z", "final-block", "FINAL_RX", {
      sphere: -0.75,
    }),
    refractionFinding("final-os", "OS", "2026-08-24T14:45:00.000Z", "final-block", "FINAL_RX", {
      sphere: -1,
    }),
    {
      observationReference: "Observation/wearing",
      findingKey: "wearing_rx",
      sectionKey: "wearing",
      display: "Wearing Rx",
      laterality: "OU",
      examination: { state: "examined", sourceEncoding: "observation" },
      interpretation: "unknown",
      provenance: { state: "current" },
      current: {
        recordedAt: "2026-08-24T14:20:00.000Z",
        components: [
          component("OD_SPHERE", "OD sphere", -0.75, "D"),
          component("OD_CYLINDER", "OD cylinder", -0.5, "D"),
          component("OD_AXIS", "OD axis", 175, "degrees"),
          component("OS_SPHERE", "OS sphere", -1, "D"),
        ],
      },
    },
  ];
}

function refractionFinding(
  id: string,
  laterality: "OD" | "OS",
  recordedAt: string,
  blockId: string,
  type: string,
  values: {
    sphere?: number;
    cylinder?: number;
    axis?: number;
    add?: number;
    distanceVisualAcuity?: string;
  },
) {
  return {
    observationReference: `Observation/${id}`,
    findingKey: "refraction",
    sectionKey: "refraction",
    display: "Refraction",
    laterality,
    examination: { state: "examined", sourceEncoding: "observation" },
    interpretation: "normal",
    provenance: { state: "current" },
    current: {
      recordedAt,
      components: [
        { code: "REFRACTION_TYPE", display: "Refraction type", value: { kind: "code", code: type, display: type === "MANIFEST" ? "Manifest" : "Final Rx" } },
        { code: "REFRACTION_BLOCK_ID", display: "Refraction block ID", value: { kind: "string", value: `refraction-block-${blockId}-af27abe2-90b0-435f-806e-1c596cdafc66` } },
        ...(values.sphere === undefined ? [] : [component("SPHERE", "Sphere", values.sphere, "D")]),
        ...(values.cylinder === undefined ? [] : [component("CYLINDER", "Cylinder", values.cylinder, "D")]),
        ...(values.axis === undefined ? [] : [component("AXIS", "Axis", values.axis, "degrees")]),
        ...(values.add === undefined ? [] : [component("ADD", "Near add", values.add, "D")]),
        ...(values.distanceVisualAcuity === undefined ? [] : [{ code: "DISTANCE_VA", display: "Distance visual acuity", value: { kind: "string", value: values.distanceVisualAcuity } }]),
      ],
    },
  };
}

function component(code: string, display: string, value: number, unit: string) {
  return { code, display, value: { kind: "quantity" as const, value, unit } };
}

function overviewSection(
  sectionKey: string,
  label: string,
  findingObservationReferences: string[],
  state: "examined" | "not-examined" | "not-indicated" = "examined",
) {
  return {
    sectionKey,
    label,
    state,
    findingObservationReferences,
    abnormalCount: 0,
    carriedUnreassertedCount: 0,
    deferredWithoutReasonCount: 0,
  };
}

function positiveCylinderProjection(): ExamOverviewProjection {
  const rows = [refractionFinding("positive-od", "OD", "2026-08-24T15:00:00.000Z", "positive", "MANIFEST", {
    sphere: 1,
    cylinder: 0.5,
    axis: 90,
  })];
  return {
    encounterReference: "Encounter/exam-1",
    patientReference: "Patient/patient-1",
    findings: rows,
    sections: [overviewSection("refraction", "Refraction", ["Observation/positive-od"])],
    completeness: PROJECTION.completeness,
  } as ExamOverviewProjection;
}

function normalCvfProjection(): ExamOverviewProjection {
  const findings = (["OD", "OS"] as const).map((laterality) => ({
    observationReference: `Observation/cvf-${laterality.toLowerCase()}`,
    findingKey: "entrance:cvf",
    sectionKey: "entrance:cvf",
    display: "Confrontation fields",
    laterality,
    examination: { state: "examined" as const, sourceEncoding: "observation" as const },
    interpretation: "normal" as const,
    provenance: { state: "current" as const },
    current: { recordedAt: "2026-08-24T15:00:00.000Z", components: [] },
  }));
  return {
    encounterReference: "Encounter/exam-1",
    patientReference: "Patient/patient-1",
    findings,
    sections: [overviewSection("entrance", "Entrance", findings.map((finding) => finding.observationReference))],
    completeness: PROJECTION.completeness,
  };
}

function priorRefractionProjection(): ExamOverviewProjection {
  const rows = [
    refractionFinding("current-od", "OD", "2026-08-24T15:00:00.000Z", "current", "MANIFEST", { sphere: -1 }),
    refractionFinding("current-os", "OS", "2026-08-24T15:00:00.000Z", "current", "MANIFEST", { sphere: -1.25 }),
  ];
  rows[0]!.prior = { components: [component("SPHERE", "Sphere", -1.5, "D")] };
  rows[1]!.prior = { components: [component("SPHERE", "Sphere", -1.75, "D")] };
  return {
    encounterReference: "Encounter/exam-1",
    patientReference: "Patient/patient-1",
    findings: rows,
    sections: [overviewSection("refraction", "Refraction", rows.map((row) => row.observationReference))],
    completeness: PROJECTION.completeness,
  } as ExamOverviewProjection;
}

const UNASSIGNED_FINDINGS: EncounterFindingRow[] = [
  {
    atomicFindingId: "tonometry::iop::high",
    findingDefinitionId: "FindingDefinition/tonometry-iop",
    findingDefinitionKey: "tonometry-iop",
    fieldCode: "iop",
    optionCode: "high",
    display: "Elevated intraocular pressure",
    sectionKey: "tonometry",
    gradeScale: [],
    diagnosisKeys: ["ocular-hypertension"],
    origin: "shipped",
    laterality: "OD",
    lateralitySource: "explicit",
    source: "atomic",
    presence: "present",
    observationReference: "Observation/unassigned-iop",
  },
  {
    atomicFindingId: "anterior::cornea::staining",
    findingDefinitionId: "FindingDefinition/cornea-staining",
    findingDefinitionKey: "cornea-staining",
    fieldCode: "cornea",
    optionCode: "staining",
    display: "Corneal staining",
    sectionKey: "ocular-health:anterior:cornea",
    gradeScale: ["trace", "1+", "2+", "3+", "4+"],
    diagnosisKeys: ["keratitis"],
    origin: "shipped",
    laterality: "OS",
    lateralitySource: "explicit",
    source: "atomic",
    presence: "present",
    grade: "1+",
    observationReference: "Observation/unassigned-cornea",
  },
];

test("the permanent chart bar keeps draft state reserved instead of inferring it from section status", async () => {
  const harness = await renderEncounter(PROJECTION, { unassignedFindings: UNASSIGNED_FINDINGS });
  try {
    const bars = harness.renderer.root.findAllByProps({ "data-testid": "exam-chart-bar" });
    assert.equal(bars.length, 1);
    const bar = bars[0]!;
    const slots = bar.findAll((node) => typeof node.props["data-chart-bar-slot"] === "string");
    assert.deepEqual(slots.map((slot) => slot.props["data-chart-bar-slot"]), [
      "patient",
      "cc-hpi-reserved",
      "exam-sections",
      "drafts",
      "unassigned",
      "visit",
      "blackout",
      "sign",
    ]);
    assert.equal(textContent(slots[1]!), "");
    assert.equal(slots[1]!.props["aria-hidden"], true);
    assert.equal(textContent(slots[4]!), "2 unassigned");

    act(() => harness.renderer.root.findByType(ExamOverviewBoard).props.onOpenEditor("va"));
    act(() => harness.renderer.root.findByType(VaSection).props.onSaved({
      completed: false,
      summary: "Unsaved local section state",
    }));

    const updatedBar = harness.renderer.root.findByProps({ "data-testid": "exam-chart-bar" });
    const updatedSlots = updatedBar.findAll((node) =>
      typeof node.props["data-chart-bar-slot"] === "string"
    );
    assert.equal(textContent(updatedSlots[3]!), "");
    assert.equal(updatedSlots[3]!.props["aria-hidden"], true);
    assert.equal(updatedSlots[3]!.props["data-reserved-for"], "slice-4-drafts");
  } finally {
    harness.restore();
  }
});

test("structure view omits empty sections and collapses performed findings into by-exception rows", async () => {
  const harness = await renderEncounter(PROJECTION);
  try {
    const sections = harness.renderer.root.findAllByProps({ "data-testid": "exam-overview-section" })
      .filter((section) => section.props["data-section-state"] !== "editor-only");
    assert.deepEqual(
      sections.map((section) => section.props["data-section-key"]),
      ["pretest"],
    );
    assert.equal(harness.renderer.root.findAllByType(SpineNav).length, 0);
    const rows = harness.renderer.root.findAllByProps({ "data-testid": "exam-finding-row" });
    assert.equal(rows.length, 2);
    assert.equal(rows.filter((row) => row.props["data-finding-key"] === "intraocular-pressure").length, 1);
    const rendered = JSON.stringify(harness.renderer.toJSON());
    assert.match(rendered, /deferred — reason not recorded/);
    assert.doesNotMatch(rendered, /Examined|Current visit|Interpretation not recorded|not-visualized-json|sourceEncoding/);
  } finally {
    harness.restore();
  }
});

test("one chart-another-finding affordance per group preserves editor reachability without placeholder rows", () => {
  const opened: string[] = [];
  const renderer = create(
    <ExamOverviewBoard
      projection={PROJECTION}
      editorEntries={[
        { id: "hpi", label: "Chief Complaint / HPI / ROS", group: "HISTORY" },
        { id: "va", label: "Visual Acuity", group: "PRETEST" },
        { id: "refraction", label: "Refraction", group: "REFRACTION" },
        { id: "soft-contact-lens", label: "Soft Contact Lenses", group: "CONTACT LENSES" },
      ]}
      activeEditorId="va"
      refreshing={false}
      onOpenEditor={(sectionId) => opened.push(sectionId)}
      onRefresh={() => undefined}
    />,
  );
  try {
    assert.equal(renderer.root.findAllByProps({ "data-testid": "interim-editor-launcher" }).length, 0);
    const rows = renderer.root.findAllByProps({ "data-testid": "exam-editor-entry-row" });
    assert.equal(rows.length, 4);

    const pretest = renderer.root.findByProps({ "data-section-key": "pretest" });
    const va = renderer.root.findByProps({ "data-editor-section-id": "va" });
    assert.equal(va.props["data-editor-presentation"], "sheet");
    assert.equal(va.props["aria-pressed"], true);
    assert.match(textContent(va), /Entry sheet/);
    assert.equal(pretest.findAllByProps({ "data-finding-key": "intraocular-pressure" }).length, 1);

    const refractionRow = renderer.root.findByProps({ "data-editor-section-id": "refraction" });
    assert.equal(refractionRow.props["data-editor-presentation"], "full-page");
    assert.match(textContent(refractionRow), /Expand/);
    assert.doesNotMatch(textContent(refractionRow), /Full page/);

    assert.equal(renderer.root.findAllByProps({ "data-testid": "chart-another-finding" }).length, 4);
    assert.equal(renderer.root.findAllByProps({ "data-section-key": "history" }).length, 0);
    assert.equal(renderer.root.findAllByProps({ "data-section-key": "refraction" }).length, 0);
    assert.equal(renderer.root.findAllByProps({ "data-editor-section-id": "soft-contact-lens" }).length, 1);

    act(() => va.props.onClick());
    assert.deepEqual(opened, ["va"]);
  } finally {
    renderer.unmount();
  }
});

test("completeness moves to the chart bar, opens its trace, and disclaims billing-code meaning", async () => {
  const harness = await renderEncounter(PROJECTION);
  try {
    const chartBars = harness.renderer.root.findAllByProps({ "data-testid": "exam-chart-bar" });
    assert.equal(chartBars.length, 1);
    const chartBar = chartBars[0]!;
    const trigger = chartBar.findByProps({ "data-testid": "exam-completeness-trigger" });
    assert.equal(textContent(trigger), "Exam sections: 1 of 2");
    assert.equal(trigger.props["aria-expanded"], false);
    assert.equal(harness.renderer.root.findAllByProps({ id: "exam-completeness-trace" }).length, 0);
    assert.equal(
      harness.renderer.root.findByType(ExamOverviewBoard)
        .findAllByProps({ "data-testid": "exam-completeness-trigger" }).length,
      0,
    );

    await act(async () => trigger.props.onClick());

    assert.equal(trigger.props["aria-expanded"], true);
    const trace = harness.renderer.root.findByProps({ id: "exam-completeness-trace" });
    assert.match(textContent(trace), /History/);
    assert.match(textContent(trace), /Not examined/);
    assert.match(
      textContent(trace),
      /This count is relative to the visit type and is not a billing-code check\./,
    );
    assert.doesNotMatch(textContent(trace), /Comprehensive: 1 of 2/);
  } finally {
    harness.restore();
  }
});

test("unconfigured completeness renders as a neutral state instead of complete or erroneous", async () => {
  const harness = await renderEncounter({
    ...PROJECTION,
    visitTypeCategoryId: undefined,
    sections: [],
    findings: [],
    completeness: {
      status: "unconfigured",
      requiredSectionCount: 0,
      resolvedSectionCount: 0,
      trace: [],
      documentationIssues: [],
    },
  });
  try {
    const footer = harness.renderer.root.findByProps({ "data-completeness-status": "unconfigured" });
    assert.match(textContent(footer), /Exam sections: Not configured/);
    assert.doesNotMatch(textContent(footer), /Complete|Error/);
    assert.equal(footer.props.role, "status");
  } finally {
    harness.restore();
  }
});

test("blackout preserves the open Visit sheet and focused control through keyboard restore", async () => {
  const harness = await renderEncounter(PROJECTION);
  try {
    const visitChips = harness.renderer.root.findAllByProps({ "data-testid": "visit-chip" });
    assert.equal(visitChips.length, 1);
    const visitChip = visitChips[0]!;
    await act(async () => visitChip.props.onClick());
    const visitSheet = harness.renderer.root.findByProps({ "data-entry-sheet-section": "visit-charges" });
    assert.equal(visitSheet.findAllByType(VisitCodeSelector).length, 1);
    assert.equal(visitSheet.findAllByType(ProcedureChargeList).length, 1);

    const blackout = harness.renderer.root.findByProps({ "data-testid": "blackout-control" });
    assert.equal(blackout.type, "button");
    await act(async () => blackout.props.onClick());
    const overlay = harness.renderer.root.findByProps({ "data-testid": "blackout-overlay" });
    assert.equal(harness.renderer.root.findAllByProps({ "data-entry-sheet-section": "visit-charges" }).length, 1);

    let tabPrevented = 0;
    await act(async () => overlay.props.onKeyDown({
      key: "Tab",
      preventDefault() { tabPrevented += 1; },
    }));
    assert.equal(tabPrevented, 1);
    assert.equal(harness.renderer.root.findAllByProps({ "data-testid": "blackout-overlay" }).length, 1);
    assert.equal(harness.focusRestoreCount(), 0);

    await act(async () => overlay.props.onKeyDown({ key: "Escape", preventDefault() {} }));
    assert.equal(harness.renderer.root.findAllByProps({ "data-testid": "blackout-overlay" }).length, 0);
    assert.equal(harness.renderer.root.findAllByProps({ "data-entry-sheet-section": "visit-charges" }).length, 1);
    assert.equal(harness.focusRestoreCount(), 1);
  } finally {
    harness.restore();
  }
});

test("Visit opens the shared sheet with exact booking coverage and every relocated billing surface", async () => {
  const harness = await renderEncounter(PROJECTION, {
    encounterExtensions: [
      { url: "https://odos2020.com/fhir/StructureDefinition/intended-coverage", valueReference: { reference: "Coverage/vision-booking" } },
      { url: "https://odos2020.com/fhir/StructureDefinition/intended-coverage", valueReference: { reference: "Coverage/medical-booking" } },
    ],
  });
  try {
    const header = harness.renderer.root.findByType(EncounterHeader);
    assert.equal(header.findAllByType(BalanceChips).length, 0, "balances leave the encounter header");

    const visitChip = harness.renderer.root.findByProps({ "data-testid": "visit-chip" });
    await act(async () => visitChip.props.onClick());

    const sheet = harness.renderer.root.findByProps({ "data-entry-sheet-section": "visit-charges" });
    assert.equal(sheet.props.role, "dialog");
    assert.equal(sheet.findAllByType(VisitCodeSelector).length, 1);
    assert.equal(sheet.findAllByType(ProcedureChargeList).length, 1);
    assert.equal(sheet.findAllByType(BalanceChips).length, 1);
    const copy = textContent(sheet);
    assert.match(copy, /Coverage recorded at booking/i);
    assert.match(copy, /Coverage\/vision-booking/);
    assert.match(copy, /Coverage\/medical-booking/);
    assert.match(copy, /recorded on the encounter from booking/i);
    assert.match(copy, /operator-selected link, not a code-support determination/i);
    assert.match(copy, /does not establish that a changed diagnosis stays aligned with its supporting interpretation/i);
    assert.equal(harness.renderer.root.findAllByProps({ "data-testid": "visit-controls-surface" }).length, 0);
  } finally {
    harness.restore();
  }
});

test("an open finding sheet visibly requires Finish or Cancel before Visit can open", async () => {
  const harness = await renderEncounter(PROJECTION);
  try {
    await act(async () => harness.renderer.root.findByProps({ "data-editor-section-id": "pupils" }).props.onClick());
    assert.equal(harness.renderer.root.findAllByProps({ "data-entry-sheet-section": "pupils" }).length, 1);

    const visitChip = harness.renderer.root.findByProps({ "data-testid": "visit-chip" });
    assert.equal(visitChip.props["aria-disabled"], true);
    assert.match(textContent(visitChip), /Finish or cancel Pupils first/i);
    assert.doesNotMatch(textContent(visitChip), /blocked/i);

    await act(async () => visitChip.props.onClick());
    assert.equal(harness.renderer.root.findAllByProps({ "data-entry-sheet-section": "pupils" }).length, 1);
    const visitSheet = harness.renderer.root.findAllByType(ExamEntrySheet).find((sheet) => sheet.props.sectionId === "visit-charges");
    assert.equal(visitSheet?.props.active, false);
    assert.equal(visitSheet?.props.hidden, true);
    assert.equal(harness.renderer.root.findAllByProps({ "data-entry-sheet-section": "pupils" }).length, 1);
  } finally {
    harness.restore();
  }
});

test("unknown encounter keeps both Visit write surfaces locked during load and after fetch failure", async (t) => {
  async function assertBillingLocked(
    harness: Awaited<ReturnType<typeof renderEncounter>>,
    visibleReason: RegExp,
  ) {
    const visitChip = harness.renderer.root.findByProps({ "data-testid": "visit-chip" });
    assert.equal(visitChip.props["aria-disabled"], true);
    assert.match(textContent(visitChip), visibleReason);
    assert.equal(harness.renderer.root.findByType(VisitCodeSelector).props.disabled, true);
    assert.equal(harness.renderer.root.findByType(ProcedureChargeList).props.disabled, true);

    await act(async () => visitChip.props.onClick());

    const visitSheet = harness.renderer.root.findAllByType(ExamEntrySheet)
      .find((sheet) => sheet.props.sectionId === "visit-charges");
    assert.equal(visitSheet?.props.active, false);
    assert.equal(visitSheet?.props.hidden, true);
  }

  await t.test("initial encounter load", async () => {
    const pendingEncounter = new Promise<Encounter>(() => undefined);
    const harness = await renderEncounter(PROJECTION, {
      encounterRead: async () => pendingEncounter,
    });
    try {
      await assertBillingLocked(harness, /Loading encounter details.*Visit & charges unavailable/i);
    } finally {
      harness.restore();
    }
  });

  await t.test("persistent encounter fetch failure", async () => {
    const harness = await renderEncounter(PROJECTION, {
      captureOverviewErrors: true,
      encounterRead: async () => { throw new Error("Synthetic encounter 403"); },
    });
    try {
      await act(async () => {
        await flushEffects();
        await flushEffects();
      });
      await assertBillingLocked(harness, /Encounter details unavailable.*Visit & charges cannot be changed/i);
    } finally {
      harness.restore();
    }
  });
});

test("switching to the diagnosis view preserves the existing DiagnosisWorkspace branch", async () => {
  const harness = await renderEncounter(PROJECTION);
  try {
    const diagnosisToggle = harness.renderer.root.findAllByType("button")
      .find((button) => textContent(button) === "By diagnosis");
    assert.ok(diagnosisToggle);
    await act(async () => {
      diagnosisToggle.props.onClick();
      await flushEffects();
    });
    assert.equal(harness.renderer.root.findAllByType(DiagnosisWorkspace).length, 1);
  } finally {
    harness.restore();
  }
});

test("distributed board rows anchor mapped editors and retain full-page fallback for deferred editors", async () => {
  const findingDefinitions: CustomFindingDefinition[] = [
    findingDefinition("entrance:pupils", "Pupils"),
    findingDefinition("entrance:dilation", "Dilation"),
    findingDefinition("ocular-health:anterior:cornea", "Cornea"),
    findingDefinition("dry-eye:symptoms", "Dry eye symptoms"),
    findingDefinition("custom:binocular-vision", "Binocular vision"),
  ];
  const procedureDefinitions: CustomFindingDefinition[] = [{
    ...findingDefinition("procedure:aesthetics:test", "Aesthetic procedure"),
    resourceKind: "procedure",
    discipline: "aesthetics",
  }];
  const harness = await renderEncounter(PROJECTION, {
    discipline: "aesthetics",
    findingDefinitions,
    procedureDefinitions,
  });
  try {
    const editorIds = harness.renderer.root
      .findAll((node) => typeof node.props["data-editor-section-id"] === "string")
      .map((node) => node.props["data-editor-section-id"] as string)
      .sort();
    assert.deepEqual(editorIds, [
      "aesthetics-consent",
      "assessment",
      "auto-refraction",
      "color-vision",
      "cover-test",
      "cup-disc",
      "custom:binocular-vision",
      "cvf",
      "dry-eye",
      "dry-eye:symptoms",
      "eom",
      "eye-growth",
      "gonioscopy",
      "hpi",
      "imaging",
      "iop",
      "manual-keratometry",
      "myopia-management",
      "ocular-health:anterior:cornea",
      "ortho-k",
      "pachymetry",
      "pretest-vitals",
      "prescription",
      "procedure:aesthetics:test",
      "pupils",
      "refraction",
      "refraction-history",
      "soft-contact-lens",
      "specialty-contact-lens",
      "stereopsis",
      "va",
      "wearing",
    ].sort());
    for (const pretestId of ["va", "pupils", "iop", "cover-test"]) {
      assert.ok(editorIds.includes(pretestId), `${pretestId} must remain reachable`);
    }
    const dilationFinding = harness.renderer.root.findByProps({ "data-finding-key": "dilation" });
    assert.equal(dilationFinding.props.role, "button");

    const vaLauncher = harness.renderer.root.findByProps({ "data-editor-section-id": "va" });
    await act(async () => vaLauncher.props.onClick());
    assert.equal(harness.renderer.root.findAllByType(VaSection).length, 1);
    assert.equal(harness.renderer.root.findAllByType(SpineNav).length, 0);
    assert.equal(harness.renderer.root.findAllByType(ExamOverviewBoard).length, 1);
    assert.equal(harness.renderer.root.findAllByType(ExamEntrySheet).filter((sheet) => !sheet.props.hidden).length, 1);
    assert.equal(vaLauncher.props["aria-pressed"], true);

    const cancel = harness.renderer.root.findByProps({
      "data-testid": "exam-entry-sheet",
      "data-entry-sheet-section": "va",
    }).findByProps({ "data-testid": "cancel-exam-entry-sheet" });
    await act(async () => cancel.props.onClick());
    assert.equal(harness.renderer.root.findAllByType(ExamEntrySheet).filter((sheet) => !sheet.props.hidden).length, 0);
    assert.equal(harness.renderer.root.findAllByType(ExamOverviewBoard).length, 1);

    const refractionLauncher = harness.renderer.root.findByProps({ "data-editor-section-id": "refraction" });
    await act(async () => refractionLauncher.props.onClick());
    assert.equal(harness.renderer.root.findAllByType(ExamOverviewBoard).length, 0);
    assert.equal(harness.renderer.root.findAllByType(RefractionSection).length, 1);

    const back = harness.renderer.root.findByProps({ "data-testid": "return-to-exam-overview" });
    await act(async () => {
      back.props.onClick();
      await flushEffects();
    });
    assert.equal(harness.renderer.root.findAllByType(ExamOverviewBoard).length, 1);
  } finally {
    harness.restore();
  }
});

test("each mapped layout wraps its existing section and supports both cancel and saved close paths", async () => {
  const harness = await renderEncounter(PROJECTION, {
    findingDefinitions: [
      { ...findingDefinition("entrance:pupils", "Pupils"), perEye: true },
      findingDefinition("entrance:stereo", "Stereopsis"),
      { ...findingDefinition("entrance:color", "Color Vision"), perEye: true },
      { ...findingDefinition("entrance:eom", "EOM / diplopia"), perEye: true },
      { ...findingDefinition("entrance:cvf", "Visual Field"), perEye: true },
      findingDefinition("entrance:visual-field-defect", "Visual Field Defect"),
      { ...findingDefinition("manual_keratometry", "Manual keratometry"), sectionKey: "entrance:manual-keratometry", perEye: true },
      { ...findingDefinition("pachymetry_um", "Pachymetry"), sectionKey: "entrance:pachymetry", perEye: true },
      { ...findingDefinition("entrance:dilation", "Dilation"), fields: { agent: { options: [] } } },
    ],
  });
  const contracts = [
    { sectionId: "hpi", component: HpiSection },
    { sectionId: "manual-keratometry", component: EntranceMeasurementSection },
    { sectionId: "pachymetry", component: EntranceMeasurementSection },
    { sectionId: "va", component: VaSection },
    { sectionId: "pupils", component: EntranceStateSection },
    { sectionId: "stereopsis", component: EntranceStateSection },
    { sectionId: "color-vision", component: EntranceStateSection },
    { sectionId: "eom", component: EomSection },
    { sectionId: "cvf", component: CvfSection },
    { sectionId: "cover-test", component: CoverTestSection },
    { sectionId: "iop", component: IopSection },
    { sectionId: "dilation", component: DilationSection },
    { sectionId: "ortho-k", component: OrthoKSection },
    { sectionId: "myopia-management", component: MyopiaManagementSection },
    { sectionId: "cup-disc", component: CupDiscSection },
    { sectionId: "gonioscopy", component: GonioscopySection },
    { sectionId: "dry-eye", component: DryEyeSection },
    { sectionId: "imaging", component: ImagingSection },
    { sectionId: "assessment", component: AssessmentSection },
    { sectionId: "prescription", component: PrescriptionSection },
  ] as const;
  try {
    for (const contract of contracts) {
      const launcher = editorControl(harness.renderer.root, contract.sectionId);
      await act(async () => launcher.props.onClick());
      const sheet = harness.renderer.root.findByProps({
        "data-testid": "exam-entry-sheet",
        "data-entry-sheet-section": contract.sectionId,
      });
      assert.equal(sheet.findAllByType(contract.component).length, 1, `${contract.sectionId} existing editor`);
      assert.equal(harness.renderer.root.findAllByType(ExamOverviewBoard).length, 1);

      await act(async () => sheet.findByProps({ "data-testid": "cancel-exam-entry-sheet" }).props.onClick());
      assert.equal(harness.renderer.root.findAllByType(ExamEntrySheet).filter((entrySheet) => !entrySheet.props.hidden).length, 0);

      await act(async () => editorControl(harness.renderer.root, contract.sectionId).props.onClick());
      await act(async () => {
        harness.renderer.root.findByType(contract.component).props.onSaved({ completed: true });
        await flushEffects();
        await flushEffects();
      });
      assert.equal(harness.renderer.root.findAllByType(ExamEntrySheet).filter((entrySheet) => !entrySheet.props.hidden).length, 0);
      assert.equal(harness.renderer.root.findAllByType(ExamOverviewBoard).length, 1);
    }
  } finally {
    harness.restore();
  }
});

test("every measured deferred editor retains its existing full-page route", async () => {
  const harness = await renderEncounter(PROJECTION);
  const contracts = [
    { sectionId: "wearing", component: WearingSection },
    { sectionId: "auto-refraction", component: AutoRefractionSection },
    { sectionId: "refraction", component: RefractionSection },
    { sectionId: "refraction-history", component: RefractionHistorySection },
    { sectionId: "eye-growth", component: EyeGrowthSection },
    { sectionId: "soft-contact-lens", component: SoftContactLensSection },
    { sectionId: "specialty-contact-lens", component: SpecialtyContactLensSection },
  ] as const;
  try {
    for (const contract of contracts) {
      const row = harness.renderer.root.findByProps({ "data-editor-section-id": contract.sectionId });
      assert.equal(row.props["data-editor-presentation"], "full-page");
      await act(async () => row.props.onClick());
      assert.equal(harness.renderer.root.findAllByType(ExamOverviewBoard).length, 0);
      assert.equal(harness.renderer.root.findAllByType(contract.component).length, 1);
      await act(async () => {
        harness.renderer.root.findByProps({ "data-testid": "return-to-exam-overview" }).props.onClick();
        await flushEffects();
      });
    }
  } finally {
    harness.restore();
  }
});

test("malformed nested finding, section, and completeness rows use the editor fallback", async (context) => {
  const malformedPayloads: Array<{ label: string; value: unknown }> = [
    { label: "finding", value: { ...PROJECTION, findings: [null] } },
    {
      label: "section",
      value: {
        ...PROJECTION,
        sections: [{ ...PROJECTION.sections[0], findingObservationReferences: undefined }],
      },
    },
    {
      label: "completeness trace",
      value: {
        ...PROJECTION,
        completeness: {
          ...PROJECTION.completeness,
          trace: [{ ...PROJECTION.completeness.trace[0], label: undefined }],
        },
      },
    },
  ];
  for (const malformed of malformedPayloads) {
    await context.test(malformed.label, async () => {
      const harness = await renderEncounter(malformed.value, { captureOverviewErrors: true });
      try {
        assert.equal(harness.renderer.root.findAllByType(ExamOverviewBoard).length, 0);
        assert.equal(harness.renderer.root.findAllByType(SpineNav).length, 1);
        assert.equal(harness.overviewErrors.length, 1);
        assert.match(String(harness.overviewErrors[0]?.[0]), /retaining the section editor/i);
      } finally {
        harness.restore();
      }
    });
  }
});

test("manual refresh replaces the mounted board projection", async () => {
  const refreshed: ExamOverviewProjection = {
    ...PROJECTION,
    sections: PROJECTION.sections.map((section) =>
      section.sectionKey === "pretest" ? { ...section, label: "Pretest refreshed" } : section
    ),
  };
  const harness = await renderEncounter(PROJECTION, { overviewResponses: [PROJECTION, refreshed] });
  try {
    assert.equal(harness.overviewFetchCount(), 1);
    const refresh = harness.renderer.root.findByProps({ "data-testid": "refresh-exam-overview" });
    await act(async () => {
      refresh.props.onClick();
      await flushEffects();
      await flushEffects();
    });
    assert.equal(harness.overviewFetchCount(), 2);
    assert.match(JSON.stringify(harness.renderer.toJSON()), /Pretest refreshed/);
  } finally {
    harness.restore();
  }
});

test("a mapped editor save closes its sheet while a deferred editor retains the explicit return path", async () => {
  const harness = await renderEncounter(PROJECTION);
  try {
    const vaLauncher = harness.renderer.root.findByProps({ "data-editor-section-id": "va" });
    await act(async () => vaLauncher.props.onClick());
    assert.equal(harness.overviewFetchCount(), 1);

    const va = harness.renderer.root.findByType(VaSection);
    await act(async () => {
      va.props.onSaved({ completed: true });
      await flushEffects();
      await flushEffects();
    });
    assert.equal(harness.overviewFetchCount(), 2);
    assert.equal(harness.renderer.root.findAllByType(ExamEntrySheet).filter((sheet) => !sheet.props.hidden).length, 0);
    assert.equal(harness.renderer.root.findAllByType(ExamOverviewBoard).length, 1);

    const refractionLauncher = harness.renderer.root.findByProps({ "data-editor-section-id": "refraction" });
    await act(async () => refractionLauncher.props.onClick());
    const back = harness.renderer.root.findByProps({ "data-testid": "return-to-exam-overview" });
    await act(async () => {
      back.props.onClick();
      await flushEffects();
      await flushEffects();
    });
    assert.equal(harness.overviewFetchCount(), 3);
    assert.equal(harness.renderer.root.findAllByType(ExamOverviewBoard).length, 1);
  } finally {
    harness.restore();
  }
});

test("a referral suspends the underlying Assessment sheet layer without discarding it", async () => {
  const harness = await renderEncounter(PROJECTION);
  try {
    await act(async () => harness.renderer.root.findByProps({ "data-editor-section-id": "assessment" }).props.onClick());
    const assessment = harness.renderer.root.findByType(AssessmentSection);

    await act(async () => assessment.props.onRefer());

    assert.equal(harness.renderer.root.findAllByType(ReferralCompose).length, 1);
    assert.equal(harness.renderer.root.findAllByType(ExamEntrySheet).find((sheet) => sheet.props.sectionId === "assessment")?.props.active, false);
    assert.equal(harness.renderer.root.findAllByType(AssessmentSection).length, 1);

    await act(async () => harness.renderer.root.findByType(ReferralCompose).props.onClose());

    assert.equal(harness.renderer.root.findAllByType(ReferralCompose).length, 0);
    assert.equal(harness.renderer.root.findAllByType(ExamEntrySheet).find((sheet) => sheet.props.sectionId === "assessment")?.props.active, true);
    assert.equal(harness.renderer.root.findAllByType(AssessmentSection).length, 1);
  } finally {
    harness.restore();
  }
});

test("a section save refreshes the permanent unassigned count", async () => {
  const harness = await renderEncounter(PROJECTION, {
    unassignedResponses: [[], [], UNASSIGNED_FINDINGS],
  });
  try {
    assert.equal(harness.findingsFetchCount(), 2);
    const vaLauncher = harness.renderer.root.findByProps({ "data-editor-section-id": "va" });
    await act(async () => vaLauncher.props.onClick());
    const fetchesBeforeSave = harness.findingsFetchCount();

    const va = harness.renderer.root.findByType(VaSection);
    await act(async () => {
      va.props.onSaved({ completed: true });
      await flushEffects();
      await flushEffects();
    });

    assert.equal(harness.findingsFetchCount(), fetchesBeforeSave + 1);
    const unassigned = harness.renderer.root.findByProps({ "data-chart-bar-slot": "unassigned" });
    assert.equal(textContent(unassigned), "2 unassigned");
  } finally {
    harness.restore();
  }
});

test("a diagnosis-led finding mutation refreshes permanent completeness", async () => {
  const refreshed: ExamOverviewProjection = {
    ...PROJECTION,
    completeness: {
      ...PROJECTION.completeness,
      status: "complete",
      resolvedSectionCount: 2,
      trace: PROJECTION.completeness.trace.map((row) => ({ ...row, resolved: true })),
    },
  };
  const harness = await renderEncounter(PROJECTION, {
    overviewResponses: [PROJECTION, refreshed],
  });
  try {
    window.dispatchEvent(new CustomEvent("odos:encounter-findings-changed", {
      detail: { encounterReference: "Encounter/exam-1" },
    }));
    await act(async () => {
      await flushEffects();
      await flushEffects();
    });

    assert.equal(harness.overviewFetchCount(), 2);
    const completeness = harness.renderer.root.findByProps({
      "data-testid": "exam-completeness-trigger",
    });
    assert.equal(textContent(completeness), "Exam sections: 2 of 2");
  } finally {
    harness.restore();
  }
});

interface RenderEncounterOptions {
  discipline?: SchedulingDiscipline;
  findingDefinitions?: CustomFindingDefinition[];
  procedureDefinitions?: CustomFindingDefinition[];
  overviewResponses?: unknown[];
  captureOverviewErrors?: boolean;
  unassignedFindings?: EncounterFindingRow[];
  unassignedResponses?: EncounterFindingRow[][];
  encounterExtensions?: Encounter["extension"];
  encounterRead?: (resourceType: string, id: string) => Promise<Encounter>;
}

async function renderEncounter(projection: unknown, options: RenderEncounterOptions = {}): Promise<{
  renderer: ReactTestRenderer;
  overviewFetchCount: () => number;
  findingsFetchCount: () => number;
  overviewErrors: unknown[][];
  focusRestoreCount: () => number;
  restore: () => void;
}> {
  const originalFetch = globalThis.fetch;
  const originalRead = fhir.read;
  const originalDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const originalConsoleError = console.error;
  const overviewErrors: unknown[][] = [];
  if (options.captureOverviewErrors) {
    console.error = (...args: unknown[]) => { overviewErrors.push(args); };
  }
  fhir.read = (async (resourceType: string, id: string) => {
    if (options.encounterRead) return options.encounterRead(resourceType, id);
    return {
      resourceType: "Encounter",
      id,
      status: "in-progress",
      class: { code: "AMB" },
      subject: { reference: "Patient/patient-1" },
      ...(options.encounterExtensions ? { extension: options.encounterExtensions } : {}),
      ...(options.discipline
        ? { serviceType: { coding: [{ system: ODOS_DISCIPLINE_SYSTEM, code: options.discipline }] } }
        : {}),
    };
  }) as typeof fhir.read;
  let overviewFetches = 0;
  let findingsFetches = 0;
  let focusRestores = 0;
  globalThis.fetch = (async (input) => {
    const url = String(input);
    if (url.endsWith("/clinical-graph/encounters/exam-1/exam-overview")) {
      const responses = options.overviewResponses ?? [projection];
      const response = responses[Math.min(overviewFetches, responses.length - 1)];
      overviewFetches += 1;
      return jsonResponse(response);
    }
    if (url.includes("/clinical-graph/finding-definitions")) {
      return jsonResponse({ canWrite: false, definitions: options.findingDefinitions ?? [] });
    }
    if (url.includes("/clinical-graph/procedure-definitions")) {
      return jsonResponse({ definitions: options.procedureDefinitions ?? [] });
    }
    if (url.includes("/clinical-graph/finding-section-groups")) {
      return jsonResponse({
        canWrite: false,
        canPullIn: false,
        groups: [],
        visitTypeCategories: [],
        overrideGroupKeys: [],
        effectiveGroupKeys: [],
      });
    }
    if (url.includes("/clinical-graph/eye-growth/visibility")) {
      return jsonResponse({ defaultVisible: false });
    }
    if (url.includes("/clinical-graph/iop/history")) {
      return jsonResponse({
        readings: [],
        cornealHysteresis: [],
        perEye: {
          OD: { average: null, tMax: null, count: 0, target: null },
          OS: { average: null, tMax: null, count: 0, target: null },
        },
        threshold: 22,
      });
    }
    if (url.endsWith("/clinical-graph/iop/definition")) {
      return jsonResponse({
        definitions: {
          intraocularPressure: { fields: {} },
          cornealHysteresis: { fields: {} },
        },
      });
    }
    if (url.endsWith("/clinical-graph/wearing/definition")) {
      return jsonResponse({ definition: { fields: { eyeglassType: { options: [] }, sourceType: { options: [] } } } });
    }
    if (url.endsWith("/clinical-graph/auto-refraction/definition")) {
      return jsonResponse({ definitions: { autoRefraction: { fields: {} }, autoKeratometry: { fields: {} } } });
    }
    if (url.endsWith("/clinical-graph/contact-lens/soft/definition")) {
      return jsonResponse({ definition: { fields: {} } });
    }
    if (url.endsWith("/clinical-graph/contact-lens/specialty/definition")) {
      return jsonResponse({ definition: { fields: {} }, canManageFields: false });
    }
    if (url.includes("/clinical-graph/contact-lens/keratometry")) {
      return jsonResponse({ eyes: { OD: null, OS: null } });
    }
    if (url.endsWith("/clinical-graph/refraction/definition")) {
      return jsonResponse({ definition: { fields: {} }, diagnosisOptions: [], refractiveThreshold: 0 });
    }
    if (url.includes("/clinical-graph/refraction/history")) {
      return jsonResponse({ glasses: [], softCl: [], specialtyCl: [] });
    }
    if (url.includes("/clinical-graph/dilation/history")) {
      return jsonResponse({ notes: [], administrations: [] });
    }
    if (url.includes("/clinical-graph/cover-test/history")) {
      return jsonResponse({ rows: [] });
    }
    if (url.includes("/clinical-graph/custom/") && url.includes("/history")) {
      return jsonResponse({ rows: [] });
    }
    if (url.includes("/clinical-graph/diagnosis-quick-list")) {
      return jsonResponse({
        canWrite: false,
        pinnedDiagnosisKeys: [],
        diagnoses: [],
        catalog: [],
      });
    }
    if (url.includes("/clinical-graph/encounters/exam-1/findings")) {
      const responses = options.unassignedResponses ?? [options.unassignedFindings ?? []];
      const unassigned = responses[Math.min(findingsFetches, responses.length - 1)] ?? [];
      findingsFetches += 1;
      return jsonResponse({
        canWrite: false,
        findings: [],
        catalog: [],
        unassigned,
        bySection: {},
        visitDiagnoses: [],
      });
    }
    if (url.includes("/clinical-graph/encounters/exam-1/diagnosis-candidates")) {
      return jsonResponse({ findings: [] });
    }
    if (url.includes("/clinical-graph/protocols/encounters/exam-1/procedure-charges")) {
      return jsonResponse({ canWrite: false, proposals: [], attachedProcedures: [] });
    }
    if (url.includes("/clinical-graph/encounters/exam-1/previous-exams")) {
      return jsonResponse({ pageSize: 4, encounters: [] });
    }
    if (url.includes("/clinical-graph/imaging")) {
      return jsonResponse({ images: [] });
    }
    return jsonResponse({ resourceType: "Bundle", type: "searchset", entry: [] });
  }) as typeof fetch;
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: {
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      activeElement: { focus: () => { focusRestores += 1; } },
    } as unknown as Document,
  });
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: Object.assign(new EventTarget(), {
      localStorage: {
        length: 1,
        clear() {},
        getItem(key: string) { return key === "odos:encounter-chart-view" ? "structure" : null; },
        key() { return null; },
        removeItem() {},
        setItem() {},
      } satisfies Storage,
    }) as Window,
  });

  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(
      <RoleProvider>
        <EncounterCharting
          patient={{ resourceType: "Patient", id: "patient-1" }}
          encounterId="exam-1"
        />
      </RoleProvider>,
    );
    await flushEffects();
    await flushEffects();
  });
  return {
    renderer,
    overviewFetchCount: () => overviewFetches,
    findingsFetchCount: () => findingsFetches,
    overviewErrors,
    focusRestoreCount: () => focusRestores,
    restore: () => {
      act(() => renderer.unmount());
      fhir.read = originalRead;
      globalThis.fetch = originalFetch;
      console.error = originalConsoleError;
      if (originalDocument) Object.defineProperty(globalThis, "document", originalDocument);
      else delete (globalThis as { document?: Document }).document;
      if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
      else delete (globalThis as { window?: Window }).window;
    },
  };
}

function findingDefinition(stableKey: string, display: string): CustomFindingDefinition {
  return {
    resourceKind: "finding",
    discipline: "eyecare",
    stableKey,
    sectionKey: stableKey,
    display,
    active: true,
    perEye: false,
    customFields: [],
  };
}

function editorControl(root: ReactTestInstance, sectionId: string): ReactTestInstance {
  const launcher = root.findAllByProps({ "data-editor-section-id": sectionId })[0];
  if (launcher) return launcher;
  if (sectionId === "dilation") {
    const finding = root.findAll((node) =>
      node.props["data-finding-key"] === "dilation" || node.props["data-finding-key"] === "entrance:dilation"
    )[0];
    if (finding) return finding;
  }
  throw new Error(`No editor control found for ${sectionId}`);
}

function textContent(node: ReactTestInstance): string {
  return node.children.map((child) =>
    typeof child === "string" ? child : textContent(child)
  ).join("");
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

async function flushEffects(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}
