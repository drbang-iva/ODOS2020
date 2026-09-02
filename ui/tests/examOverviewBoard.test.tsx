import assert from "node:assert/strict";
import { test } from "node:test";
import React from "react";
import type { Bundle, Encounter, Observation, Provenance } from "@medplum/fhirtypes";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import {
  buildExamOverviewProjection,
  observationSnapshot,
  type ExamOverviewFindingProjection,
  type ExamOverviewProjection,
} from "../../mcp/src/clinical-graph/exam-overview-projection";
import {
  handleCustomSectionCaptureRequest,
  type CustomSectionEndpointDeps,
} from "../../mcp/src/clinical-graph/custom-section-endpoint";
import {
  handleCoverTestCaptureRequest,
  type CoverTestEndpointDeps,
} from "../../mcp/src/clinical-graph/cover-test-endpoint";
import { handleEomCaptureRequest, type EomEndpointDeps } from "../../mcp/src/clinical-graph/eom-endpoint";
import { buildFindingDefinitionSeeds } from "../../mcp/src/clinical-graph/finding-definition-store";
import {
  buildGlaucomaCupDiscSuggestion,
  projectFindingInstanceToObservation,
} from "../../mcp/src/clinical-graph/glaucoma-suspect";
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
import type { EncounterUndoLedger } from "../src/lib/encounter-undo";
import {
  ExamOverviewBoard,
  UNFORMATTED_FINDING_VALUE,
  UNFORMATTED_PENDING_PROJECTION,
  findingValue,
} from "../src/components/charting/ExamOverviewBoard";
import { GonioscopySection } from "../src/components/charting/GonioscopySection";
import { HpiSection } from "../src/components/charting/HpiSection";
import { IopSection } from "../src/components/charting/IopSection";
import { MyopiaManagementSection } from "../src/components/charting/MyopiaManagementSection";
import { OrthoKSection } from "../src/components/charting/OrthoKSection";
import { PrescriptionSection } from "../src/components/charting/PrescriptionSection";
import { RefractionHistorySection } from "../src/components/charting/RefractionHistorySection";
import { ProcedureChargeList } from "../src/components/charting/ProcedureChargeList";
import { BalanceChips } from "../src/components/commercial/BalanceChips";
import { chartEditorInventory, SpineNav } from "../src/components/charting/SpineNav";
import { VisitCodeSelector } from "../src/components/charting/VisitCodeSelector";
import { VaSection } from "../src/components/charting/VaSection";
import { RefractionSection } from "../src/components/charting/RefractionSection";
import { SoftContactLensSection } from "../src/components/charting/SoftContactLensSection";
import { SpecialtyContactLensSection } from "../src/components/charting/SpecialtyContactLensSection";
import { WearingSection } from "../src/components/charting/WearingSection";
import { ReferralCompose } from "../src/components/referral/ReferralCompose";
import type { CustomFindingDefinition } from "../src/components/charting/CustomFindingSection";
import {
  blankComplaintDraft,
  type ComplaintDefinition,
  type EncounterComplaint,
  type GenericComplaintOptions,
} from "../src/lib/complaints";
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

const HPI_GENERIC_OPTIONS: GenericComplaintOptions = {
  conditions: [{ code: "dry-eyes", display: "Dry Eyes", active: true }],
  qualities: [{ code: "constant", display: "constant", active: true }],
  treatments: [{ code: "artificial-tears", display: "artificial tears", active: true }],
};

const HPI_DRY_EYE: ComplaintDefinition = {
  id: "complaint-definition-dry-eye",
  stableKey: "dry-eye",
  display: "Patient (Dry Eye)",
  kind: "patient-symptom",
  conditionOptions: [],
  qualityOptions: [],
  treatmentOptions: [],
  seedRank: 1,
  status: "active",
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
    assert.equal(rows.length, 8);
    assert.deepEqual(rows.map((row) => row.props["data-row-pattern"]), [
      "eye-pair", "word", "eye-pair", "event", "diagram", "word", "rx", "word",
    ]);
    assert.equal(rows.filter((row) => row.props["data-finding-key"] === "pachymetry_um").length, 1);
    assert.equal(rows.filter((row) => row.props["data-finding-key"] === "intraocular_pressure").length, 0);
    assert.equal(renderer.root.findAllByProps({ "data-section-key": "history" }).length, 1);
    assert.equal(renderer.root.findAllByProps({ "data-section-key": "assessment" }).length, 0);
    const rendered = JSON.stringify(renderer.toJSON());
    assert.match(rendered, /Not examined/);
    assert.doesNotMatch(rendered, /not charted|No finding observations recorded/i);
    assert.equal(renderer.root.findAllByProps({ "data-testid": "chart-another-finding" }).length, 1);
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
    assert.match(
      rendered,
      new RegExp(`Dilation.*tropicamide 1%.*phenylephrine 2\\.5%.*${testTimeLabel("2026-08-24T14:42:00.000Z")}`),
    );
    assert.equal(renderer.root.findAllByProps({ "data-testid": "visual-field-diagram" }).length, 2);
    assert.equal(renderer.root.findAllByProps({ "data-eye": "OD", "data-restricted-quadrants": "upper-left" }).length, 1);
    assert.equal(renderer.root.findAllByProps({ "data-eye": "OS", "data-restricted-quadrants": "" }).length, 1);
    const cvf = renderer.root.findByProps({ "data-finding-key": "entrance:cvf" });
    assert.match(cvf.props.className, /is-exception/);
    assert.match(textContent(cvf), /filed under: Visual field defect — OD/);
    assert.match(
      textContent(cvf),
      new RegExp(`Attested by Dr\\. Avery Chen · ${testTimeLabel("2026-08-24T14:43:00.000Z")} · current visit`),
    );
    assert.match(rendered, /deferred — patient driving/);
    const findingText = renderer.root.findAllByProps({ "data-testid": "exam-finding-row" })
      .map(textContent).join(" ");
    assert.doesNotMatch(findingText, /Examined|Current visit|Interpretation not recorded|Exam state|Normal template/);
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

    const machineOnlyValues = create(
      <ExamOverviewBoard
        projection={machineOnlyValueProjection()}
        editorEntries={[]}
        refreshing={false}
        onOpenEditor={() => undefined}
        onRefresh={() => undefined}
      />,
    );
    try {
      const machineRendered = JSON.stringify(machineOnlyValues.toJSON());
      const leakedMachineValues = ["INTERNAL_CODE_ONLY", "serialized-bookkeeping-marker"]
        .filter((marker) => machineRendered.includes(marker));
      assert.deepEqual(leakedMachineValues, []);
    } finally {
      machineOnlyValues.unmount();
    }
  } finally {
    renderer.unmount();
  }
});

test("finding rows keep native disclosures accessible beside a finite editor button", () => {
  const opened: string[] = [];
  const renderer = create(
    <ExamOverviewBoard
      projection={BY_EXCEPTION_PROJECTION}
      editorEntries={[{ id: "cvf", label: "Confrontation fields", group: "ENTRANCE" }]}
      refreshing={false}
      onOpenEditor={(id) => opened.push(id)}
      onRefresh={() => undefined}
    />,
  );
  try {
    const row = renderer.root.findByProps({ "data-finding-key": "entrance:cvf" });
    assert.equal(row.props.role, undefined);
    assert.equal(row.props.tabIndex, undefined);
    assert.equal(row.props.onKeyDown, undefined);
    assert.equal(row.findAllByType("details").length, 1);
    assert.deepEqual(opened, []);

    let propagationStopped = false;
    const edit = row.findByProps({ "data-testid": "exam-finding-editor" });
    assert.equal(edit.type, "button");
    assert.equal(edit.props["aria-label"], "Edit Confrontation fields");
    act(() => edit.props.onClick({ stopPropagation: () => { propagationStopped = true; } }));
    assert.equal(propagationStopped, true);
    assert.deepEqual(opened, ["cvf"]);
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
    assert.match(rendered, /Full battery · 2 blocks/);
    assert.doesNotMatch(rendered, /−2\.00|Final Rx|refraction-block-/);

    const positiveCylinder = create(
      <ExamOverviewBoard
        projection={manifestOnlyProjection()}
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

    const offsetMixed = create(
      <ExamOverviewBoard
        projection={offsetMixedRxProjection()}
        editorEntries={[]}
        refreshing={false}
        onOpenEditor={() => undefined}
        onRefresh={() => undefined}
      />,
    );
    try {
      const offsetText = textContent(offsetMixed.root.findByProps({ "data-finding-key": "refraction" }));
      assert.match(offsetText, /OD −1\.00 sph/);
      assert.match(offsetText, /Wearing Rx OD −0\.75 sph/);
      assert.doesNotMatch(offsetText, /−2\.00|−3\.00/);
    } finally {
      offsetMixed.unmount();
    }
  } finally {
    renderer.unmount();
  }
});

test("refraction uses a manifest when present and otherwise labels the recorded non-final block by type", () => {
  const manifestOnly = renderRefraction(manifestOnlyProjection());
  assert.match(manifestOnly, /Refraction — Manifest/);
  assert.doesNotMatch(manifestOnly, /not recorded/i);

  const cycloplegicOnly = renderRefraction(cycloplegicOnlyProjection());
  assert.match(cycloplegicOnly, /Refraction — Cycloplegic/);
  assert.match(cycloplegicOnly, /OD −0\.25 sph 20\/20/);
  assert.doesNotMatch(cycloplegicOnly, /Manifest|not recorded|Final Rx/i);

  const manifestAndFinal = renderRefraction(manifestAndFinalProjection());
  assert.match(manifestAndFinal, /Refraction — Manifest/);
  assert.match(manifestAndFinal, /OD −1\.00 sph 20\/20/);
  assert.match(manifestAndFinal, /Full battery · 1 block/);
  assert.doesNotMatch(manifestAndFinal, /−9\.00|Final Rx|not recorded/i);
});

test("refraction distance acuity never renders a code-only machine value", () => {
  const rendered = renderRefraction(codeOnlyDistanceVaProjection());
  assert.match(rendered, /Refraction — Manifest/);
  assert.match(rendered, /OD −1\.00 sph/);
  assert.doesNotMatch(rendered, /INTERNAL_DISTANCE_VA_CODE/);
});

test("manual keratometry projects only its allowlisted measurements in OD-first order", () => {
  const renderer = create(
    <ExamOverviewBoard
      projection={manualKeratometryProjection()}
      editorEntries={[]}
      refreshing={false}
      onOpenEditor={() => undefined}
      onRefresh={() => undefined}
    />,
  );
  try {
    const rendered = textContent(renderer.root.findByProps({ "data-finding-key": "manual_keratometry" }));
    assert.equal(
      rendered,
      "Manual keratometryOD 43.25 @180 / 44.00 @090OS 42.75 @175 / 43.50 @085",
    );
    assert.doesNotMatch(rendered, /CUSTOM_|Observation\/|recorded/);
  } finally {
    renderer.unmount();
  }
});

test("stored visual acuity renders the raw Snellen value and correction", () => {
  const renderer = renderOverviewTruthBoard();
  try {
    assert.equal(
      findingValueText(renderer, "VISUAL_ACUITY"),
      "OD 20/70 SC",
    );
  } finally {
    renderer.unmount();
  }
});

test("stored non-Snellen visual acuity discloses its chart type", () => {
  const renderer = renderOverviewTruthBoard("ETDRS", "65", "CC");
  try {
    assert.equal(
      findingValueText(renderer, "VISUAL_ACUITY"),
      "OD 65 CC · ETDRS",
    );
  } finally {
    renderer.unmount();
  }
});

test("stored pachymetry resolves laterality-prefixed CCT components", () => {
  const renderer = renderOverviewTruthBoard();
  try {
    assert.equal(
      findingValueText(renderer, "pachymetry_um"),
      "OD 213 umOS 208 um",
    );
  } finally {
    renderer.unmount();
  }
});

test("stored auto keratometry shares the manual keratometry display convention", () => {
  const renderer = renderOverviewTruthBoard();
  try {
    assert.equal(
      findingValueText(renderer, "auto_keratometry"),
      "OD 42.50 @180 / 43.25 @090OS 41.75 @175 / 42.50 @085",
    );
  } finally {
    renderer.unmount();
  }
});

test("stored Wearing Rx renders in its own worksheet row", () => {
  const renderer = renderOverviewTruthBoard();
  try {
    assert.equal(
      findingValueText(renderer, "wearing_rx"),
      "OD −0.25 sph OS −0.25 sph",
    );
  } finally {
    renderer.unmount();
  }
});

test("a newer OD-only Wearing save retains the latest stored OS in the worksheet row", () => {
  const renderer = renderSplitWearingHistoryBoard();
  try {
    assert.equal(
      findingValueText(renderer, "wearing_rx"),
      "OD −0.50 sph OS −2.00 −0.75 ×170",
    );
  } finally {
    renderer.unmount();
  }
});

test("a newer OD-only Wearing save retains both eyes in the refraction comparison", () => {
  const renderer = renderSplitWearingHistoryBoard();
  try {
    const rendered = textContent(renderer.root.findByProps({ "data-finding-key": "refraction" }));
    assert.match(rendered, /Wearing Rx OD −0\.50 sph OS −2\.00 −0\.75 ×170/);
  } finally {
    renderer.unmount();
  }
});

test("overview truth changes preserve the exact IOP value", () => {
  const renderer = renderOverviewTruthBoard();
  try {
    assert.equal(
      findingValueText(renderer, "intraocular_pressure"),
      "OD 21 mmHgOS 16 mmHg",
    );
  } finally {
    renderer.unmount();
  }
});

test("overview truth changes preserve the exact Dilation event value", () => {
  const renderer = renderOverviewTruthBoard();
  try {
    assert.equal(
      findingValueText(renderer, "entrance:dilation"),
      "Tropicamide 1% · 20:31",
    );
  } finally {
    renderer.unmount();
  }
});

test("the pending overview projection exception map is empty after History is formatted", () => {
  const pending = pendingOverviewProjectionExceptions();
  assert.equal(Object.keys(pending).length, 0);
  assert.equal(Object.hasOwn(pending, "hpi_ros"), false);
  assert.equal(findingValue(FIXTURES.hpi_ros!.charted), "Blurred vision · ROS reviewed");
});

test("complaint-only History renders its summary while completeness remains Not examined", () => {
  const projection = {
    ...zeroFindingComprehensiveProjection(),
    historySummary: "Blurred vision, Discharge +1 more",
  } as ExamOverviewProjection;
  const renderer = create(
    <ExamOverviewBoard
      projection={projection}
      editorEntries={chartEditorInventory()}
      refreshing={false}
      onOpenEditor={() => undefined}
      onRefresh={() => undefined}
    />,
  );
  try {
    const history = renderer.root.findByProps({ "data-section-key": "history" });
    assert.match(textContent(history), /Blurred vision, Discharge \+1 more/);
    assert.match(textContent(history), /Not examined/);
    assert.doesNotMatch(textContent(history), /ROS reviewed/);
  } finally {
    renderer.unmount();
  }
});

test("the finding formatter exposes one exact unformatted sentinel", () => {
  assert.equal(UNFORMATTED_FINDING_VALUE, "recorded");
  assert.equal(findingValue(bareCatalogFinding(FIXTURE_DEFINITIONS.get("entrance:eom")!)), "recorded");
});

test("every active catalog finding has a fixture and no pending exception", () => {
  const activeKeys = buildFindingDefinitionSeeds()
    .filter((definition) => definition.active)
    .map((definition) => definition.stableKey);
  const missing = activeKeys.filter((key) =>
    !Object.hasOwn(FIXTURES, key) && !Object.hasOwn(UNFORMATTED_PENDING_PROJECTION, key)
  );
  const stale = Object.keys(FIXTURES).filter((key) => !activeKeys.includes(key));
  assert.deepEqual({ missing, stale }, { missing: [], stale: [] });
});

test("every catalog fixture control reaches the exact unformatted sentinel", () => {
  const failures = Object.entries(FIXTURES).flatMap(([key, fixture]) => {
    const value = findingValue(fixture.control);
    return value === UNFORMATTED_FINDING_VALUE ? [] : [`${key}: ${value}`];
  });
  assert.deepEqual(failures, []);
});

test("every charted catalog fixture leaves the exact unformatted sentinel", () => {
  const failures = Object.entries(FIXTURES).flatMap(([key, fixture]) => {
    const value = findingValue(fixture.charted);
    return value !== UNFORMATTED_FINDING_VALUE ? [] : [`${key}: ${value}`];
  });
  assert.deepEqual(failures, []);
});

test("charted EOM renders writer-shaped OU positions in anatomical eye groups on the preserved grading scale", () => {
  const definition = buildFindingDefinitionSeeds().find((row) => row.stableKey === "entrance:eom");
  assert.ok(definition);
  const projection = catalogGuardProjection(definition);
  const renderer = create(
    <ExamOverviewBoard
      projection={projection}
      editorEntries={[]}
      refreshing={false}
      onOpenEditor={() => undefined}
      onRefresh={() => undefined}
    />,
  );
  try {
    assert.equal(
      findingValueText(renderer, "entrance:eom"),
      "OD Up left -4 · Primary 0 · Down right +4 · OS Up left -3 · Primary +1 · Down right +3",
    );
  } finally {
    renderer.unmount();
  }
});

test("charted EOM renders writer-permitted abnormal details and the normal template", async () => {
  const eyes = {
    OD: { "up-left": "-4", primary: "0", "down-right": "+4" },
    OS: { "up-left": "-3", primary: "+1", "down-right": "+3" },
  };
  const diplopia = {
    present: true,
    type: "binocular",
    direction: "horizontal",
    comitancy: "incomitant",
    worstGaze: "right",
    frequency: "intermittent",
    onset: "2026-07-20",
    note: "Distance only",
  };
  const actual = {
    gazeOnly: await renderedWriterEomValue({ eyes }),
    diplopiaOnly: await renderedWriterEomValue({ diplopia }),
    combined: await renderedWriterEomValue({
      eyes,
      nystagmus: { present: true, note: "Gaze evoked" },
      diplopia,
    }),
    normal: await renderedWriterEomValue({}, "normal"),
  };
  assert.deepEqual(actual, {
    gazeOnly: "OD Up left -4 · Primary 0 · Down right +4 · OS Up left -3 · Primary +1 · Down right +3",
    diplopiaOnly: "Diplopia present Yes · binocular Yes · incomitant Yes · Diplopia direction horizontal · Worst gaze right · Frequency intermittent · Onset 2026-07-20 · Diplopia note Distance only",
    combined: "OD Up left -4 · Primary 0 · Down right +4 · OS Up left -3 · Primary +1 · Down right +3 · Nystagmus present Yes · Nystagmus note Gaze evoked · Diplopia present Yes · binocular Yes · incomitant Yes · Diplopia direction horizontal · Worst gaze right · Frequency intermittent · Onset 2026-07-20 · Diplopia note Distance only",
    normal: "Full OU — SAFE",
  });
});

test("charted CVF defects survive the persisted per-eye prefixes into the review diagrams", async () => {
  const definitions = buildFindingDefinitionSeeds();
  const definition = definitions.find((candidate) => candidate.stableKey === "entrance:cvf");
  assert.ok(definition);
  const fhir = new EomWriterFhir();
  const deps: CustomSectionEndpointDeps = {
    authenticate: async () => ({
      staffReference: "Practitioner/cvf-writer-fixture",
      actorRole: "provider",
      fhir,
    }),
    findingDefinitions: () => definitions,
    now: () => "2026-09-01T12:00:00.000Z",
  };
  const result = await handleCustomSectionCaptureRequest(deps, {
    authHeader: "Bearer cvf-writer-fixture",
    params: { stableKey: "entrance:cvf" },
    body: {
      patientReference: "Patient/cvf-writer-fixture",
      encounterReference: "Encounter/cvf-writer-fixture",
      eyes: {
        OD: {
          state: "abnormal",
          customFields: [
            { code: "CUSTOM_CVF_UPPER_LEFT", value: "restricted" },
            { code: "CUSTOM_CVF_UPPER_RIGHT", value: "full" },
            { code: "CUSTOM_CVF_LOWER_LEFT", value: "full" },
            { code: "CUSTOM_CVF_LOWER_RIGHT", value: "full" },
          ],
        },
        OS: {
          state: "abnormal",
          customFields: [
            { code: "CUSTOM_CVF_UPPER_LEFT", value: "full" },
            { code: "CUSTOM_CVF_UPPER_RIGHT", value: "restricted" },
            { code: "CUSTOM_CVF_LOWER_LEFT", value: "full" },
            { code: "CUSTOM_CVF_LOWER_RIGHT", value: "full" },
          ],
        },
      },
    },
  });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  const observations = fhir.resources.filter((resource): resource is Observation => resource.resourceType === "Observation");
  assert.deepEqual(
    observations.map((observation) => observation.component?.map((component) => component.code.coding?.[0]?.code)
      .filter((code) => code?.includes("CUSTOM_CVF"))),
    [
      ["OD_CUSTOM_CVF_UPPER_LEFT", "OD_CUSTOM_CVF_UPPER_RIGHT", "OD_CUSTOM_CVF_LOWER_LEFT", "OD_CUSTOM_CVF_LOWER_RIGHT"],
      ["OS_CUSTOM_CVF_UPPER_LEFT", "OS_CUSTOM_CVF_UPPER_RIGHT", "OS_CUSTOM_CVF_LOWER_LEFT", "OS_CUSTOM_CVF_LOWER_RIGHT"],
    ],
  );
  const writerProjection = buildExamOverviewProjection({
    encounterReference: "Encounter/cvf-writer-fixture",
    patientReference: "Patient/cvf-writer-fixture",
    definitions,
    currentObservations: observations,
    priorObservationCandidates: [],
    assessmentRows: [],
  });
  const projection = catalogGuardProjection(definition);
  projection.findings = writerProjection.findings;
  projection.sections = [overviewSection(
    "pretest",
    "Pretest",
    writerProjection.findings.map((finding) => finding.observationReference),
  )];
  const renderer = create(
    <ExamOverviewBoard
      projection={projection}
      editorEntries={[]}
      refreshing={false}
      onOpenEditor={() => undefined}
      onRefresh={() => undefined}
    />,
  );
  try {
    assert.equal(renderer.root.findAllByProps({ "data-testid": "visual-field-diagram" }).length, 2);
    assert.equal(renderer.root.findAllByProps({ "data-eye": "OD", "data-restricted-quadrants": "upper-left" }).length, 1);
    assert.equal(renderer.root.findAllByProps({ "data-eye": "OS", "data-restricted-quadrants": "upper-right" }).length, 1);
  } finally {
    renderer.unmount();
  }
});

test("abnormal cover-test endpoint persistence projects an exception row with details", async () => {
  const definitions = buildFindingDefinitionSeeds();
  const fhir = new EomWriterFhir();
  const deps: CoverTestEndpointDeps = {
    authenticate: async () => ({
      staffReference: "Practitioner/cover-writer-fixture",
      actorRole: "provider",
      fhir,
    }),
    findingDefinitions: () => definitions,
    now: () => "2026-08-28T12:00:00.000Z",
  };
  const result = await handleCoverTestCaptureRequest(deps, {
    authHeader: "Bearer writer-fixture",
    body: {
      patientReference: "Patient/cover-writer-fixture",
      encounterReference: "Encounter/cover-writer-fixture",
      rows: [{
        slot: "near-sc",
        state: "deviation",
        deviationType: "phoria",
        direction: "exo",
        magnitude: 3,
        laterality: "alternating",
        comitancy: "comitant",
      }],
    },
  });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  const observation = fhir.resources.find((resource): resource is Observation => resource.resourceType === "Observation");
  assert.ok(observation);
  const projection = buildExamOverviewProjection({
    encounterReference: "Encounter/cover-writer-fixture",
    patientReference: "Patient/cover-writer-fixture",
    definitions,
    currentObservations: [observation],
    priorObservationCandidates: [],
    assessmentRows: [],
  });
  const finding = projection.findings.find((candidate) => candidate.findingKey === "entrance:cover");
  assert.ok(finding);
  assert.equal(finding.interpretation, "abnormal");
  const boardProjection = { ...projection, findings: [finding], sections: [overviewSection("entrance", "Entrance", [finding.observationReference])] };
  const renderer = create(
    <ExamOverviewBoard
      projection={boardProjection}
      editorEntries={[]}
      refreshing={false}
      onOpenEditor={() => undefined}
      onRefresh={() => undefined}
    />,
  );
  try {
    const row = renderer.root.findByProps({ "data-finding-key": "entrance:cover" });
    assert.match(row.props.className, /is-exception/);
    assert.equal(row.findAllByProps({ className: "odos-exam-finding-expansion" }).length, 1);
  } finally {
    renderer.unmount();
  }
});

test("high-risk cup-disc capture path projects an exception row with details", () => {
  const definitions = buildFindingDefinitionSeeds();
  const definition = definitions.find((candidate) => candidate.stableKey === "cup_disc_ratio");
  assert.ok(definition);
  const captured = buildGlaucomaCupDiscSuggestion({
    cupDiscRatio: 0.75,
    laterality: "OD",
    patientReference: "Patient/cup-disc-writer-fixture",
    encounterReference: "Encounter/cup-disc-writer-fixture",
    findingDefinitionId: definition.id,
    findingInstanceId: "cup-disc-high-risk",
    recordedAt: "2026-08-28T12:00:00.000Z",
    provenance: {
      source: "manual",
      recordedAt: "2026-08-28T12:00:00.000Z",
      actorReference: "Practitioner/cup-disc-writer-fixture",
    },
  });
  const observation = {
    ...projectFindingInstanceToObservation(captured.finding, definition),
    id: "cup-disc-high-risk",
  };
  const projection = buildExamOverviewProjection({
    encounterReference: "Encounter/cup-disc-writer-fixture",
    patientReference: "Patient/cup-disc-writer-fixture",
    definitions,
    currentObservations: [observation],
    priorObservationCandidates: [],
    assessmentRows: [],
  });
  const finding = projection.findings.find((candidate) => candidate.findingKey === "cup_disc_ratio");
  assert.ok(finding);
  assert.equal(finding.interpretation, "abnormal");
  const boardProjection = { ...projection, findings: [finding], sections: [overviewSection("ocular-health", "Ocular health", [finding.observationReference])] };
  const renderer = create(
    <ExamOverviewBoard
      projection={boardProjection}
      editorEntries={[]}
      refreshing={false}
      onOpenEditor={() => undefined}
      onRefresh={() => undefined}
    />,
  );
  try {
    const row = renderer.root.findByProps({ "data-finding-key": "cup_disc_ratio" });
    assert.match(row.props.className, /is-exception/);
    assert.equal(row.findAllByProps({ className: "odos-exam-finding-expansion" }).length, 1);
  } finally {
    renderer.unmount();
  }
});

test("EOM free-text notes preserve delimiter text as one atomic segment", async () => {
  const value = await renderedWriterEomValue({
    diplopia: {
      present: true,
      type: "binocular",
      direction: "horizontal",
      comitancy: "incomitant",
      worstGaze: "right",
      frequency: "intermittent",
      onset: "2026-07-20",
      note: "Distance only · Diplopia present Yes",
    },
  });

  assert.equal(
    value,
    "Diplopia present Yes · binocular Yes · incomitant Yes · Diplopia direction horizontal · Worst gaze right · Frequency intermittent · Onset 2026-07-20 · Diplopia note Distance only · Diplopia present Yes",
  );
});

test("custom state writer preserves other-only notes and uses OTHER once as a deferred reason", async () => {
  const abnormal = await renderedWriterStateSectionValue(
    "ocular-health:anterior:conjunctiva",
    "abnormal",
    "Reports intermittent shimmer",
  );
  const normal = await renderedWriterStateSectionValue(
    "entrance:stereo",
    "normal",
    "Reliable responses throughout",
  );
  const deferred = await renderedWriterStateSectionValue(
    "entrance:stereo",
    "deferred",
    "Unable through language barrier",
  );
  assert.deepEqual({
    abnormal: abnormal.value,
    normal: normal.value,
    deferred: deferred.value,
  }, {
    abnormal: "OD Other Reports intermittent shimmer",
    normal: "Stereo present · Other Reliable responses throughout",
    deferred: "deferred — Unable through language barrier",
  });
  assert.equal(abnormal.formattedValue, "Other Reports intermittent shimmer");
  assert.equal(deferred.value.match(/Unable through language barrier/g)?.length, 1);
  assert.doesNotMatch(`${abnormal.value} ${normal.value}`, /Exam state|Normal template|entrance\.stereo/);
  assert.deepEqual(normal.componentCodes, ["entrance.stereo", "EXAM_STATE", "NORMAL_TEMPLATE", "OTHER"]);
});

test("normal OTHER notes preserve delimiter text exactly once", async () => {
  const normal = await renderedWriterStateSectionValue(
    "entrance:pupils",
    "normal",
    "dim light · repeat next visit",
  );

  assert.equal(normal.value, "OD PERRLA; no RAPD OU · Other dim light · repeat next visit");
});

test("abnormal custom state other-only value leaves the exact unformatted sentinel behind", async () => {
  const abnormal = await renderedWriterStateSectionValue(
    "ocular-health:anterior:conjunctiva",
    "abnormal",
    "Reports intermittent shimmer",
  );
  assert.equal(abnormal.formattedValue, "Other Reports intermittent shimmer");
});

test("normal other composition preserves the template and every selected sheet finding", () => {
  const finding: ExamOverviewFindingProjection = {
    observationReference: "Observation/normal-other-sheet-probe",
    findingKey: "normal-other-sheet-probe",
    sectionKey: "normal-other-sheet-probe",
    display: "Normal other sheet probe",
    laterality: "UNKNOWN",
    examination: { state: "examined", sourceEncoding: "observation" },
    interpretation: "normal",
    provenance: { state: "current" },
    sheetFindings: [{ display: "Trace anomaly", qualifiers: [] }],
    current: {
      components: [
        { code: "NORMAL_TEMPLATE", display: "Normal template", value: { kind: "string", value: "normal" } },
        { code: "OTHER", display: "Other", value: { kind: "string", value: "Patient reports glare" } },
      ],
    },
  };

  assert.equal(findingValue(finding), "normal · Trace anomaly · Other Patient reports glare");
});

test("normal other composition preserves sheet findings when a normal label wins the base formatter", () => {
  const normalLabelFinding: ExamOverviewFindingProjection = {
    observationReference: "Observation/normal-label-other-sheet-probe",
    findingKey: "entrance:pupils",
    sectionKey: "entrance:pupils",
    display: "Pupils",
    laterality: "OU",
    examination: { state: "examined", sourceEncoding: "observation" },
    interpretation: "normal",
    normalLabel: "PERRLA; no RAPD OU",
    provenance: { state: "current" },
    sheetFindings: [{ display: "Trace anomaly", qualifiers: [] }],
    current: {
      components: [
        { code: "OTHER", display: "Other", value: { kind: "string", value: "Sluggish left" } },
      ],
    },
  };
  const normalWordFinding: ExamOverviewFindingProjection = {
    ...normalLabelFinding,
    observationReference: "Observation/normal-word-other-sheet-probe",
    findingKey: "entrance:color",
    sectionKey: "entrance:color",
    display: "Color vision",
    normalLabel: undefined,
    sheetFindings: [{ display: "Ishihara 7/7", qualifiers: [] }],
    current: {
      components: [
        { code: "OTHER", display: "Other", value: { kind: "string", value: "Testing repeated" } },
      ],
    },
  };

  assert.deepEqual({
    normalLabel: findingValue(normalLabelFinding),
    normalWord: findingValue(normalWordFinding),
  }, {
    normalLabel: "PERRLA; no RAPD OU · Trace anomaly · Other Sluggish left",
    normalWord: "normal · Ishihara 7/7 · Other Testing repeated",
  });
});

test("slice-added component formatters preserve a stored scalar value", () => {
  const base: ExamOverviewFindingProjection = {
    observationReference: "Observation/additive-component-probe",
    findingKey: "additive-component-probe",
    sectionKey: "additive-component-probe",
    display: "Additive component probe",
    laterality: "UNKNOWN",
    examination: { state: "examined", sourceEncoding: "observation" },
    interpretation: "unknown",
    provenance: { state: "current" },
    current: {
      value: { kind: "string", value: "Scalar context" },
      components: [{ code: "DETAIL", display: "Detail", value: { kind: "string", value: "Component detail" } }],
    },
  };
  const eom: ExamOverviewFindingProjection = {
    ...base,
    observationReference: "Observation/additive-eom-probe",
    findingKey: "entrance:eom",
    sectionKey: "entrance:eom",
    display: "EOM / diplopia",
    laterality: "OU",
    current: {
      ...base.current,
      components: [{ code: "OD_CUSTOM_EOM_POS_UP_LEFT", display: "OD up-left", value: { kind: "string", value: "-4" } }],
    },
  };

  assert.deepEqual({
    components: findingValue(base),
    eom: findingValue(eom),
  }, {
    components: "Detail Component detail · Scalar context",
    eom: "OD Up left -4 · Scalar context",
  });
});

test("normal other composition preserves downstream summary and scalar values", () => {
  const base: ExamOverviewFindingProjection = {
    observationReference: "Observation/normal-other-downstream-probe",
    findingKey: "normal-other-downstream-probe",
    sectionKey: "normal-other-downstream-probe",
    display: "Normal other downstream probe",
    laterality: "UNKNOWN",
    examination: { state: "examined", sourceEncoding: "observation" },
    interpretation: "normal",
    provenance: { state: "current" },
    current: {
      components: [
        { code: "NORMAL_TEMPLATE", display: "Normal template", value: { kind: "string", value: "normal" } },
        { code: "OTHER", display: "Other", value: { kind: "string", value: "Patient reports glare" } },
      ],
    },
  };

  assert.deepEqual({
    summary: findingValue({ ...base, summary: "Stored summary" }),
    scalar: findingValue({
      ...base,
      current: { ...base.current, value: { kind: "string", value: "Scalar context" } },
    }),
  }, {
    summary: "normal · Stored summary · Other Patient reports glare",
    scalar: "normal · Scalar context · Other Patient reports glare",
  });
});

const KNOWN_EXERCISED_WRITER_SCHEMA_BLIND_SPOTS: Readonly<Record<string, string>> = {
  "entrance:eom:DIPLOPIA_DIRECTION": "Covered by the endpoint-backed EOM detail fixture.",
  "entrance:eom:DIPLOPIA_FREQUENCY": "Covered by the endpoint-backed EOM detail fixture.",
  "entrance:eom:DIPLOPIA_NOTE": "Covered by the endpoint-backed EOM detail fixture.",
  "entrance:eom:DIPLOPIA_ONSET": "Covered by the endpoint-backed EOM detail fixture.",
  "entrance:eom:DIPLOPIA_PRESENT": "Covered by the endpoint-backed EOM detail fixture.",
  "entrance:eom:DIPLOPIA_WORST_GAZE": "Covered by the endpoint-backed EOM detail fixture.",
  "entrance:eom:EXAM_STATE": "Internal state is asserted through the projected interpretation and rendered value.",
  "entrance:eom:NORMAL_TEMPLATE": "Covered by the endpoint-backed normal EOM fixture.",
  "entrance:eom:NYSTAGMUS_NOTE": "Covered by the endpoint-backed EOM detail fixture.",
  "entrance:eom:NYSTAGMUS_PRESENT": "Covered by the endpoint-backed EOM detail fixture.",
  "entrance:eom:OD_CUSTOM_EOM_POS_DOWN_RIGHT": "Covered; the writer adds an OD prefix to the schema position code.",
  "entrance:eom:OD_CUSTOM_EOM_POS_PRIMARY": "Covered; the writer adds an OD prefix to the schema position code.",
  "entrance:eom:OD_CUSTOM_EOM_POS_UP_LEFT": "Covered; the writer adds an OD prefix to the schema position code.",
  "entrance:eom:OS_CUSTOM_EOM_POS_DOWN_RIGHT": "Covered; the writer adds an OS prefix to the schema position code.",
  "entrance:eom:OS_CUSTOM_EOM_POS_PRIMARY": "Covered; the writer adds an OS prefix to the schema position code.",
  "entrance:eom:OS_CUSTOM_EOM_POS_UP_LEFT": "Covered; the writer adds an OS prefix to the schema position code.",
  "entrance:eom:binocular::yes": "Covered by stored-display rendering in the endpoint-backed EOM fixture.",
  "entrance:eom:entrance.eom": "Internal documentation marker is suppressed by the EOM formatter.",
  "entrance:eom:incomitant::yes": "Covered by stored-display rendering in the endpoint-backed EOM fixture.",
  "entrance:stereo:EXAM_STATE": "Internal state is asserted through the rendered normal and deferred branches.",
  "entrance:stereo:NORMAL_TEMPLATE": "Covered by the endpoint-backed normal custom-state fixture.",
  "entrance:stereo:OTHER": "Covered by the endpoint-backed normal and deferred custom-state fixtures.",
  "entrance:stereo:entrance.stereo": "Internal documentation marker is bypassed by the normal and deferred render paths.",
  "ocular-health:anterior:conjunctiva:EXAM_STATE": "Internal state is asserted through the abnormal projection branch.",
  "ocular-health:anterior:conjunctiva:OTHER": "Covered by the endpoint-backed abnormal other-only fixture.",
};

test("exercised EOM and custom-state writers declare every schema-blind component code", async () => {
  const eom = await renderedWriterEomFinding({
    eyes: {
      OD: { "up-left": "-4", primary: "0", "down-right": "+4" },
      OS: { "up-left": "-3", primary: "+1", "down-right": "+3" },
    },
    nystagmus: { present: true, note: "Gaze evoked" },
    diplopia: {
      present: true,
      type: "binocular",
      direction: "horizontal",
      comitancy: "incomitant",
      worstGaze: "right",
      frequency: "intermittent",
      onset: "2026-07-20",
      note: "Distance only",
    },
  });
  const normalEom = await renderedWriterEomFinding({}, "normal");
  const abnormalState = await renderedWriterStateSectionValue(
    "ocular-health:anterior:conjunctiva",
    "abnormal",
    "Reports intermittent shimmer",
  );
  const normalState = await renderedWriterStateSectionValue(
    "entrance:stereo",
    "normal",
    "Reliable responses throughout",
  );
  const definitions = buildFindingDefinitionSeeds();
  const actual = [eom.finding, normalEom.finding, abnormalState.finding, normalState.finding]
    .flatMap((finding) => writerSchemaBlindSpots(finding, definitions))
    .filter((value, index, values) => values.indexOf(value) === index)
    .sort();
  assert.deepEqual(actual, Object.keys(KNOWN_EXERCISED_WRITER_SCHEMA_BLIND_SPOTS).sort());
  assert.equal(Object.values(KNOWN_EXERCISED_WRITER_SCHEMA_BLIND_SPOTS).every((reason) => reason.trim().length > 0), true);
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
    distanceVisualAcuityCode?: string;
  },
) {
  const typeDisplay = {
    MANIFEST: "Manifest",
    CYCLOPLEGIC: "Cycloplegic",
    FINAL_RX: "Final Rx",
  }[type] ?? "Other refraction";
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
        { code: "REFRACTION_TYPE", display: "Refraction type", value: { kind: "code", code: type, display: typeDisplay } },
        { code: "REFRACTION_BLOCK_ID", display: "Refraction block ID", value: { kind: "string", value: `refraction-block-${blockId}-af27abe2-90b0-435f-806e-1c596cdafc66` } },
        ...(values.sphere === undefined ? [] : [component("SPHERE", "Sphere", values.sphere, "D")]),
        ...(values.cylinder === undefined ? [] : [component("CYLINDER", "Cylinder", values.cylinder, "D")]),
        ...(values.axis === undefined ? [] : [component("AXIS", "Axis", values.axis, "degrees")]),
        ...(values.add === undefined ? [] : [component("ADD", "Near add", values.add, "D")]),
        ...(values.distanceVisualAcuity === undefined ? [] : [{ code: "DISTANCE_VA", display: "Distance visual acuity", value: { kind: "string", value: values.distanceVisualAcuity } }]),
        ...(values.distanceVisualAcuityCode === undefined ? [] : [{ code: "DISTANCE_VA", display: "Distance visual acuity", value: { kind: "code", code: values.distanceVisualAcuityCode } }]),
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

function hpiComplaintFixture(id: string, renderedNarrative: string): EncounterComplaint {
  return {
    ...blankComplaintDraft({ complaintKey: "dry-eye" }),
    id,
    encounterId: "exam-1",
    patientId: "patient-1",
    ordinal: 1,
    status: "active",
    renderedNarrative,
  };
}

function manifestOnlyProjection(): ExamOverviewProjection {
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

function cycloplegicOnlyProjection(): ExamOverviewProjection {
  return refractionOnlyProjection([
    refractionFinding("cycloplegic-od", "OD", "2026-08-24T15:00:00.000Z", "cycloplegic", "CYCLOPLEGIC", {
      sphere: -0.25,
      distanceVisualAcuity: "20/20",
    }),
  ]);
}

function manifestAndFinalProjection(): ExamOverviewProjection {
  return refractionOnlyProjection([
    refractionFinding("manifest-only-od", "OD", "2026-08-24T15:00:00.000Z", "manifest-only", "MANIFEST", {
      sphere: -1,
      distanceVisualAcuity: "20/20",
    }),
    refractionFinding("final-only-od", "OD", "2026-08-24T15:01:00.000Z", "final-only", "FINAL_RX", {
      sphere: -9,
      distanceVisualAcuity: "20/400",
    }),
  ]);
}

function codeOnlyDistanceVaProjection(): ExamOverviewProjection {
  return refractionOnlyProjection([
    refractionFinding("code-only-distance-va", "OD", "2026-08-24T15:00:00.000Z", "code-only-va", "MANIFEST", {
      sphere: -1,
      distanceVisualAcuityCode: "INTERNAL_DISTANCE_VA_CODE",
    }),
  ]);
}

function refractionOnlyProjection(rows: ReturnType<typeof refractionFinding>[]): ExamOverviewProjection {
  return {
    encounterReference: "Encounter/exam-1",
    patientReference: "Patient/patient-1",
    findings: rows,
    sections: [overviewSection("refraction", "Refraction", rows.map((row) => row.observationReference))],
    completeness: PROJECTION.completeness,
  } as ExamOverviewProjection;
}

function renderRefraction(projection: ExamOverviewProjection): string {
  const renderer = create(
    <ExamOverviewBoard
      projection={projection}
      editorEntries={[]}
      refreshing={false}
      onOpenEditor={() => undefined}
      onRefresh={() => undefined}
    />,
  );
  try {
    return textContent(renderer.root.findByProps({ "data-finding-key": "refraction" }));
  } finally {
    renderer.unmount();
  }
}

function machineOnlyValueProjection(): ExamOverviewProjection {
  const findings = [
    {
      observationReference: "Observation/code-only-value",
      findingKey: "code-only-value",
      sectionKey: "entrance",
      display: "Code-only value",
      laterality: "OU",
      examination: { state: "examined", sourceEncoding: "observation" },
      interpretation: "unknown",
      provenance: { state: "current" },
      current: {
        value: { kind: "code", code: "INTERNAL_CODE_ONLY" },
        components: [],
      },
    },
    {
      observationReference: "Observation/json-only-value",
      findingKey: "json-only-value",
      sectionKey: "entrance",
      display: "JSON-only value",
      laterality: "OU",
      examination: { state: "examined", sourceEncoding: "observation" },
      interpretation: "unknown",
      provenance: { state: "current" },
      current: {
        value: { kind: "json", value: { internalId: "serialized-bookkeeping-marker" } },
        components: [],
      },
    },
  ];
  return {
    encounterReference: "Encounter/exam-1",
    patientReference: "Patient/patient-1",
    findings,
    sections: [overviewSection("entrance", "Entrance", findings.map((finding) => finding.observationReference))],
    completeness: PROJECTION.completeness,
  } as ExamOverviewProjection;
}

function offsetMixedRxProjection(): ExamOverviewProjection {
  const rows = [
    refractionFinding("offset-old", "OD", "2026-08-24T14:00:00Z", "offset-old", "MANIFEST", { sphere: -2 }),
    refractionFinding("offset-new", "OD", "2026-08-24T10:00:00-05:00", "offset-new", "MANIFEST", { sphere: -1 }),
    wearingFinding("wearing-offset-old", "2026-08-24T14:30:00Z", -3),
    wearingFinding("wearing-offset-new", "2026-08-24T10:00:00-05:00", -0.75),
  ];
  return {
    encounterReference: "Encounter/exam-1",
    patientReference: "Patient/patient-1",
    findings: rows,
    sections: [overviewSection("refraction", "Refraction", rows.map((row) => row.observationReference))],
    completeness: PROJECTION.completeness,
  } as ExamOverviewProjection;
}

function wearingFinding(id: string, recordedAt: string, sphere: number) {
  return {
    observationReference: `Observation/${id}`,
    findingKey: "wearing_rx",
    sectionKey: "wearing",
    display: "Wearing Rx",
    laterality: "OU",
    examination: { state: "examined", sourceEncoding: "observation" },
    interpretation: "unknown",
    provenance: { state: "current" },
    current: {
      recordedAt,
      components: [component("OD_SPHERE", "OD sphere", sphere, "D")],
    },
  };
}

function renderSplitWearingHistoryBoard(): ReactTestRenderer {
  return create(
    <ExamOverviewBoard
      projection={splitWearingHistoryProjection()}
      editorEntries={chartEditorInventory()}
      refreshing={false}
      onOpenEditor={() => undefined}
      onRefresh={() => undefined}
    />,
  );
}

function splitWearingHistoryProjection(): ExamOverviewProjection {
  const findings = [
    refractionFinding("split-wearing-manifest-od", "OD", "2026-08-24T15:00:00.000Z", "split-wearing", "MANIFEST", {
      sphere: -0.75,
    }),
    refractionFinding("split-wearing-manifest-os", "OS", "2026-08-24T15:00:00.000Z", "split-wearing", "MANIFEST", {
      sphere: -1.25,
    }),
    wearingSnapshotFinding("split-wearing-bilateral", "2026-08-24T14:00:00.000Z", {
      OD: { sphere: -1 },
      OS: { sphere: -2, cylinder: -0.75, axis: 170 },
    }),
    wearingSnapshotFinding("split-wearing-od-only", "2026-08-24T16:00:00.000Z", {
      OD: { sphere: -0.5 },
    }),
  ];
  return {
    encounterReference: "Encounter/exam-1",
    patientReference: "Patient/patient-1",
    findings,
    sections: [overviewSection("refraction", "Refraction", findings.map((finding) => finding.observationReference))],
    completeness: PROJECTION.completeness,
  } as ExamOverviewProjection;
}

function wearingSnapshotFinding(
  id: string,
  recordedAt: string,
  eyes: Partial<Record<"OD" | "OS", { sphere: number; cylinder?: number; axis?: number; add?: number }>>,
) {
  return {
    observationReference: `Observation/${id}`,
    findingKey: "wearing_rx",
    sectionKey: "wearing",
    display: "Wearing Rx",
    laterality: "OU",
    examination: { state: "examined", sourceEncoding: "observation" },
    interpretation: "unknown",
    provenance: { state: "current" },
    current: {
      recordedAt,
      components: (Object.entries(eyes) as Array<["OD" | "OS", NonNullable<(typeof eyes)["OD"]>]>).flatMap(([eye, values]) => [
        component(`${eye}_SPHERE`, `${eye} sphere`, values.sphere, "D"),
        ...(values.cylinder === undefined ? [] : [component(`${eye}_CYLINDER`, `${eye} cylinder`, values.cylinder, "D")]),
        ...(values.axis === undefined ? [] : [component(`${eye}_AXIS`, `${eye} axis`, values.axis, "degrees")]),
        ...(values.add === undefined ? [] : [component(`${eye}_ADD`, `${eye} add`, values.add, "D")]),
      ]),
    },
  };
}

function manualKeratometryProjection(): ExamOverviewProjection {
  const findings = [
    manualKeratometryFinding("OD", 43.25, 180, 44, 90),
    manualKeratometryFinding("OS", 42.75, 175, 43.5, 85),
  ];
  return {
    encounterReference: "Encounter/exam-1",
    patientReference: "Patient/patient-1",
    findings,
    sections: [overviewSection("entrance", "Entrance", findings.map((finding) => finding.observationReference))],
    completeness: PROJECTION.completeness,
  } as ExamOverviewProjection;
}

function manualKeratometryFinding(
  laterality: "OD" | "OS",
  flatK: number,
  flatAxis: number,
  steepK: number,
  steepAxis: number,
) {
  return {
    observationReference: `Observation/manual-k-${laterality.toLowerCase()}`,
    findingKey: "manual_keratometry",
    sectionKey: "entrance:manual-keratometry",
    display: "Manual keratometry",
    laterality,
    examination: { state: "examined", sourceEncoding: "observation" },
    interpretation: "unknown",
    provenance: { state: "current" },
    current: {
      recordedAt: "2026-08-24T15:00:00.000Z",
      components: [
        component(`${laterality}_CUSTOM_FLAT_K`, "Flat K", flatK, "[diop]"),
        component(`${laterality}_CUSTOM_FLAT_AXIS`, "Flat axis", flatAxis, "degrees"),
        component(`${laterality}_CUSTOM_STEEP_K`, "Steep K", steepK, "[diop]"),
        component(`${laterality}_CUSTOM_STEEP_AXIS`, "Steep axis", steepAxis, "degrees"),
      ],
    },
  };
}

function renderOverviewTruthBoard(
  chartType = "SNELLEN",
  acuity = "20/70",
  correction = "SC",
): ReactTestRenderer {
  return create(
    <ExamOverviewBoard
      projection={overviewTruthProjection(chartType, acuity, correction)}
      editorEntries={chartEditorInventory()}
      refreshing={false}
      onOpenEditor={() => undefined}
      onRefresh={() => undefined}
    />,
  );
}

function overviewTruthProjection(chartType: string, acuity: string, correction: string): ExamOverviewProjection {
  const findings = [
    {
      observationReference: "Observation/va-od",
      findingKey: "VISUAL_ACUITY",
      sectionKey: "va",
      display: "Visual acuity",
      laterality: "OD",
      examination: { state: "examined", sourceEncoding: "observation" },
      interpretation: "unknown",
      provenance: { state: "current" },
      current: {
        recordedAt: "2026-08-24T15:00:00.000Z",
        components: [
          snapshotStringComponent("VA_SNELLEN_RAW", "Visual acuity Snellen raw", acuity),
          snapshotCodeComponent("VA_CHART_TYPE", "Visual acuity chart type", chartType),
          snapshotCodeComponent("VA_CORRECTION", "Visual acuity correction", correction),
          component("VA_LOGMAR", "Visual acuity logMAR", 0.544, "logMAR"),
        ],
      },
    },
    measurementFinding("pachy-od", "pachymetry_um", "entrance:pachymetry", "Pachymetry", "OD", [
      component("OD_CUSTOM_CCT", "Central corneal thickness", 213, "um"),
    ]),
    measurementFinding("pachy-os", "pachymetry_um", "entrance:pachymetry", "Pachymetry", "OS", [
      component("OS_CUSTOM_CCT", "Central corneal thickness", 208, "um"),
    ]),
    measurementFinding("auto-k-od", "auto_keratometry", "auto-refraction", "Auto-keratometry", "OD", [
      component("FLAT_K", "Flat K", 42.5, "D"),
      component("FLAT_AXIS", "Flat axis", 180, "degrees"),
      component("STEEP_K", "Steep K", 43.25, "D"),
      component("STEEP_AXIS", "Steep axis", 90, "degrees"),
    ]),
    measurementFinding("auto-k-os", "auto_keratometry", "auto-refraction", "Auto-keratometry", "OS", [
      component("FLAT_K", "Flat K", 41.75, "D"),
      component("FLAT_AXIS", "Flat axis", 175, "degrees"),
      component("STEEP_K", "Steep K", 42.5, "D"),
      component("STEEP_AXIS", "Steep axis", 85, "degrees"),
    ]),
    {
      observationReference: "Observation/wearing-old-overview",
      findingKey: "wearing_rx",
      sectionKey: "wearing",
      display: "Wearing spectacle prescription",
      laterality: "OU",
      examination: { state: "examined", sourceEncoding: "observation" },
      interpretation: "unknown",
      provenance: { state: "current" },
      current: {
        recordedAt: "2026-08-24T14:00:00.000Z",
        components: [
          component("OD_SPHERE", "OD sphere", -3, "D"),
          component("OS_SPHERE", "OS sphere", -3, "D"),
        ],
      },
    },
    {
      observationReference: "Observation/wearing",
      findingKey: "wearing_rx",
      sectionKey: "wearing",
      display: "Wearing spectacle prescription",
      laterality: "OU",
      examination: { state: "examined", sourceEncoding: "observation" },
      interpretation: "unknown",
      provenance: { state: "current" },
      current: {
        recordedAt: "2026-08-24T15:00:00.000Z",
        components: [
          component("OD_SPHERE", "OD sphere", -0.25, "D"),
          component("OS_SPHERE", "OS sphere", -0.25, "D"),
        ],
      },
    },
    measurementFinding("iop-od", "intraocular_pressure", "tonometry", "Intraocular pressure", "OD", [], {
      kind: "quantity", value: 21, unit: "mmHg",
    }),
    measurementFinding("iop-os", "intraocular_pressure", "tonometry", "Intraocular pressure", "OS", [], {
      kind: "quantity", value: 16, unit: "mmHg",
    }),
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
        administrations: [{
          agent: "Tropicamide 1%",
          occurredAt: new Date(2026, 7, 26, 20, 31).toISOString(),
        }],
      },
      current: { components: [] },
    },
  ];
  return {
    encounterReference: "Encounter/exam-1",
    patientReference: "Patient/patient-1",
    findings,
    sections: [overviewSection("pretest", "Pretest", findings.map((finding) => finding.observationReference))],
    completeness: PROJECTION.completeness,
  } as ExamOverviewProjection;
}

type CatalogDefinition = ReturnType<typeof buildFindingDefinitionSeeds>[number];
type CatalogFindingFixture = {
  control: ExamOverviewFindingProjection;
  charted: ExamOverviewFindingProjection;
};

const FIXTURE_DEFINITIONS = new Map(
  buildFindingDefinitionSeeds().filter((definition) => definition.active)
    .map((definition) => [definition.stableKey, definition] as const),
);

const FIXTURES: Record<string, CatalogFindingFixture> = {
  hpi_ros: historyCatalogFixture(),
  cup_disc_ratio: catalogFixture("cup_disc_ratio"),
  intraocular_pressure: catalogFixture("intraocular_pressure"),
  corneal_hysteresis: catalogFixture("corneal_hysteresis"),
  rnfl_gcc: catalogFixture("rnfl_gcc"),
  gonio_angle_structures: catalogFixture("gonio_angle_structures"),
  gonio_tm_pigmentation: catalogFixture("gonio_tm_pigmentation"),
  gonio_note: catalogFixture("gonio_note"),
  refraction: catalogFixture("refraction"),
  soft_contact_lens: catalogFixture("soft_contact_lens"),
  specialty_contact_lens: catalogFixture("specialty_contact_lens"),
  wearing_rx: catalogFixture("wearing_rx"),
  auto_refraction: catalogFixture("auto_refraction"),
  auto_keratometry: catalogFixture("auto_keratometry"),
  "entrance:pupils": catalogFixture("entrance:pupils"),
  "entrance:stereo": catalogFixture("entrance:stereo"),
  "entrance:color": catalogFixture("entrance:color"),
  "entrance:eom": catalogFixture("entrance:eom"),
  "entrance:cvf": catalogFixture("entrance:cvf"),
  "entrance:visual-field-defect": catalogFixture("entrance:visual-field-defect"),
  "entrance:cover": catalogFixture("entrance:cover"),
  pachymetry_um: catalogFixture("pachymetry_um"),
  manual_keratometry: catalogFixture("manual_keratometry"),
  "entrance:dilation": catalogFixture("entrance:dilation"),
  AXIAL_LENGTH: catalogFixture("AXIAL_LENGTH"),
  CORNEAL_RADIUS: catalogFixture("CORNEAL_RADIUS"),
  "dry-eye:symptoms": catalogFixture("dry-eye:symptoms"),
  "dry-eye:tear-volume": catalogFixture("dry-eye:tear-volume"),
  "dry-eye:markers": catalogFixture("dry-eye:markers"),
  "dry-eye:gland-structure": catalogFixture("dry-eye:gland-structure"),
  "dry-eye:gland-function": catalogFixture("dry-eye:gland-function"),
  "dry-eye:conjunctival-staining": catalogFixture("dry-eye:conjunctival-staining"),
  "dry-eye:staging": catalogFixture("dry-eye:staging"),
  "ocular-health:anterior:periocular-adnexa": catalogFixture("ocular-health:anterior:periocular-adnexa"),
  "ocular-health:anterior:lids-lashes": catalogFixture("ocular-health:anterior:lids-lashes"),
  "ocular-health:anterior:palpebral-conjunctiva": catalogFixture("ocular-health:anterior:palpebral-conjunctiva"),
  "ocular-health:anterior:conjunctiva": catalogFixture("ocular-health:anterior:conjunctiva"),
  "ocular-health:anterior:tear-film": catalogFixture("ocular-health:anterior:tear-film"),
  "ocular-health:anterior:cornea": catalogFixture("ocular-health:anterior:cornea"),
  "ocular-health:anterior:anterior-chamber": catalogFixture("ocular-health:anterior:anterior-chamber"),
  "ocular-health:anterior:iris": catalogFixture("ocular-health:anterior:iris"),
  "ocular-health:anterior:lens": catalogFixture("ocular-health:anterior:lens"),
  "ocular-health:posterior:vitreous": catalogFixture("ocular-health:posterior:vitreous"),
  "ocular-health:posterior:fundus": catalogFixture("ocular-health:posterior:fundus"),
  "ocular-health:posterior:macula": catalogFixture("ocular-health:posterior:macula"),
  "ocular-health:posterior:vessels": catalogFixture("ocular-health:posterior:vessels"),
  "ocular-health:posterior:periphery": catalogFixture("ocular-health:posterior:periphery"),
};

function pendingOverviewProjectionExceptions(): Readonly<Record<string, string>> {
  return UNFORMATTED_PENDING_PROJECTION;
}

function catalogFixture(stableKey: string): CatalogFindingFixture {
  const definition = FIXTURE_DEFINITIONS.get(stableKey);
  assert.ok(definition, `Missing active catalog definition for fixture ${stableKey}`);
  return {
    control: bareCatalogFinding(definition),
    charted: chartedCatalogFinding(definition),
  };
}

function historyCatalogFixture(): CatalogFindingFixture {
  const definition = FIXTURE_DEFINITIONS.get("hpi_ros");
  assert.ok(definition, "Missing active catalog definition for fixture hpi_ros");
  return {
    control: bareCatalogFinding(definition),
    charted: {
      ...bareCatalogFinding(definition),
      observationReference: "Observation/catalog-hpi-ros",
      summary: "Blurred vision · ROS reviewed",
    },
  };
}

function bareCatalogFinding(definition: CatalogDefinition): ExamOverviewFindingProjection {
  return {
    observationReference: `Observation/catalog-control-${definition.stableKey.replaceAll(/[^A-Za-z0-9.-]/g, "-")}`,
    findingKey: definition.stableKey,
    sectionKey: definition.sectionKey ?? definition.stableKey,
    display: definition.display,
    laterality: definition.valueSchema.perEye === true ? "OD" : "UNKNOWN",
    examination: { state: "examined", sourceEncoding: "observation" },
    interpretation: "unknown",
    provenance: { state: "current" },
    current: { components: [] },
  };
}

function catalogGuardProjection(definition: CatalogDefinition): ExamOverviewProjection {
  const finding = chartedCatalogFinding(definition);
  return {
    encounterReference: "Encounter/catalog-guard",
    patientReference: "Patient/catalog-guard",
    findings: [finding],
    sections: [overviewSection("pretest", "Pretest", [finding.observationReference])],
    completeness: PROJECTION.completeness,
  };
}

function chartedCatalogFinding(definition: CatalogDefinition): ExamOverviewFindingProjection {
  if (definition.stableKey === "entrance:eom") {
    return {
      ...bareCatalogFinding(definition),
      observationReference: "Observation/catalog-entrance-eom",
      laterality: "OU",
      current: writerShapedEomSnapshot(),
    };
  }
  const valueSchema = definition.valueSchema as Record<string, unknown>;
  const fields = Object.values((valueSchema.fields ?? {}) as Record<string, Record<string, unknown>>);
  const components = fields.flatMap((field) => {
    const fieldKey = Object.entries((valueSchema.fields ?? {}) as Record<string, Record<string, unknown>>)
      .find(([, candidate]) => candidate === field)?.[0];
    const code = typeof field.localCode === "string" ? field.localCode : fieldKey
      ?.replace(/([a-z0-9])([A-Z])/g, "$1_$2").replaceAll("-", "_").toUpperCase();
    if (!code) return [];
    const display = typeof field.display === "string" ? field.display : code;
    const numeric = field.valueType === "number" || field.valueType === "integer" ||
      typeof field.type === "string" && [
        "number", "derived-number", "number-input", "integer-input", "integer-select",
        "decimal-input", "quarter-diopter-select",
      ].includes(field.type);
    return [{
      code,
      display,
      value: numeric
        ? { kind: "number" as const, value: typeof field.defaultValue === "number" ? field.defaultValue : 1 }
        : { kind: "string" as const, value: representativeFieldValue(field) },
    }];
  });
  const sheetFindings = fields.flatMap((field) => {
    if (field.valueType !== "multi-select" || !Array.isArray(field.options)) return [];
    const option = field.options.find((candidate) => isRecord(candidate) && candidate.active !== false);
    return isRecord(option) && typeof option.display === "string"
      ? [{ display: option.display, qualifiers: [] }]
      : [];
  });
  const value = catalogScalarValue(valueSchema);
  const type = typeof valueSchema.type === "string" ? valueSchema.type : undefined;
  return {
    observationReference: `Observation/catalog-${definition.stableKey.replaceAll(/[^A-Za-z0-9.-]/g, "-")}`,
    findingKey: definition.stableKey,
    sectionKey: definition.sectionKey ?? definition.stableKey,
    display: definition.display,
    laterality: definition.valueSchema.perEye === true ? "OD" as const : "UNKNOWN" as const,
    examination: { state: "examined" as const, sourceEncoding: "observation" as const },
    interpretation: "unknown" as const,
    provenance: { state: "current" as const },
    current: { ...(value ? { value } : {}), components },
    ...(sheetFindings.length ? { sheetFindings } : {}),
    ...(type === "cover-test-section" ? { summary: "Near orthophoria" } : {}),
    ...(type === "dilation-administration" ? {
      event: { administrations: [{ agent: "Tropicamide 1%", occurredAt: "2026-08-28T14:00:00.000Z" }] },
    } : {}),
  };
}

function representativeFieldValue(field: Record<string, unknown>): string {
  if (Array.isArray(field.options)) {
    const option = field.options.find((candidate) => isRecord(candidate) && candidate.active !== false);
    if (isRecord(option)) {
      if (typeof option.display === "string") return option.display;
      if (typeof option.code === "string") return option.code;
    }
  }
  return "charted";
}

function catalogScalarValue(valueSchema: Record<string, unknown>) {
  if (valueSchema.valueKind === "coded" && Array.isArray(valueSchema.options)) {
    const option = valueSchema.options.find(isRecord);
    if (option) return {
      kind: "code" as const,
      ...(typeof option.code === "string" ? { code: option.code } : {}),
      ...(typeof option.display === "string" ? { display: option.display } : {}),
    };
  }
  if (valueSchema.valueKind === "string" || valueSchema.valueKind === "component-panel") {
    return { kind: "string" as const, value: "charted" };
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function measurementFinding(
  id: string,
  findingKey: string,
  sectionKey: string,
  display: string,
  laterality: "OD" | "OS",
  components: Array<ReturnType<typeof component>>,
  value?: { kind: "quantity"; value: number; unit: string },
) {
  return {
    observationReference: `Observation/${id}`,
    findingKey,
    sectionKey,
    display,
    laterality,
    examination: { state: "examined" as const, sourceEncoding: "observation" as const },
    interpretation: "unknown" as const,
    provenance: { state: "current" as const },
    current: { ...(value ? { value } : {}), components },
  };
}

function snapshotStringComponent(code: string, display: string, value: string) {
  return { code, display, value: { kind: "string" as const, value } };
}

function writerShapedEomSnapshot() {
  const components = [
    { code: "EXAM_STATE", display: "Exam state", value: "abnormal" },
    { code: "OD_CUSTOM_EOM_POS_UP_LEFT", display: "OD up-left", value: "-4" },
    { code: "OD_CUSTOM_EOM_POS_PRIMARY", display: "OD primary", value: "0" },
    { code: "OD_CUSTOM_EOM_POS_DOWN_RIGHT", display: "OD down-right", value: "+4" },
    { code: "OS_CUSTOM_EOM_POS_UP_LEFT", display: "OS up-left", value: "-3" },
    { code: "OS_CUSTOM_EOM_POS_PRIMARY", display: "OS primary", value: "+1" },
    { code: "OS_CUSTOM_EOM_POS_DOWN_RIGHT", display: "OS down-right", value: "+3" },
  ];
  return observationSnapshot({
    resourceType: "Observation",
    status: "final",
    code: { coding: [{ code: "entrance:eom" }] },
    component: components.map((component) => ({
      code: { coding: [{ code: component.code, display: component.display }] },
      valueString: component.value,
    })),
  } satisfies Observation);
}

class EomWriterFhir {
  resources: Array<Observation | Provenance> = [];

  async create<T extends Observation | Provenance>(resource: T): Promise<T> {
    const saved = { ...resource, id: resource.id ?? `${resource.resourceType.toLowerCase()}-${this.resources.length + 1}` } as T;
    this.resources.push(saved);
    return saved;
  }

  async search<T extends Observation>(resourceType: T["resourceType"]): Promise<Bundle<T>> {
    return {
      resourceType: "Bundle",
      type: "searchset",
      entry: this.resources.filter((resource) => resource.resourceType === resourceType)
        .map((resource) => ({ resource: resource as T })),
    };
  }
}

async function renderedWriterEomValue(
  details: Record<string, unknown>,
  state: "normal" | "abnormal" = "abnormal",
): Promise<string> {
  return (await renderedWriterEomFinding(details, state)).value;
}

async function renderedWriterEomFinding(
  details: Record<string, unknown>,
  state: "normal" | "abnormal" = "abnormal",
): Promise<{ value: string; componentCodes: string[]; finding: ExamOverviewFindingProjection }> {
  const definitions = buildFindingDefinitionSeeds();
  const fhir = new EomWriterFhir();
  const deps: EomEndpointDeps = {
    authenticate: async () => ({
      staffReference: "Practitioner/eom-writer-fixture",
      actorRole: "provider",
      fhir,
    }),
    findingDefinitions: () => definitions,
    now: () => "2026-07-22T12:00:00.000Z",
  };
  const result = await handleEomCaptureRequest(deps, {
    authHeader: "Bearer writer-fixture",
    body: {
      patientReference: "Patient/eom-writer-fixture",
      encounterReference: "Encounter/eom-writer-fixture",
      state,
      ...details,
    },
  });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  const observation = fhir.resources.find((resource): resource is Observation => resource.resourceType === "Observation");
  assert.ok(observation);
  const writerProjection = buildExamOverviewProjection({
    encounterReference: "Encounter/eom-writer-fixture",
    patientReference: "Patient/eom-writer-fixture",
    definitions,
    currentObservations: [observation],
    priorObservationCandidates: [],
    assessmentRows: [],
  });
  const finding = writerProjection.findings.find((candidate) => candidate.findingKey === "entrance:eom");
  assert.ok(finding);
  const renderedFinding = finding;
  assert.equal(renderedFinding.interpretation, state);
  const projection = catalogGuardProjection(definitions.find((definition) => definition.stableKey === "entrance:eom")!);
  projection.findings = [renderedFinding];
  projection.sections = [overviewSection("pretest", "Pretest", [renderedFinding.observationReference])];
  const renderer = create(
    <ExamOverviewBoard
      projection={projection}
      editorEntries={[]}
      refreshing={false}
      onOpenEditor={() => undefined}
      onRefresh={() => undefined}
    />,
  );
  try {
    return {
      value: findingValueText(renderer, "entrance:eom"),
      componentCodes: finding.current.components.map((component) => component.code),
      finding,
    };
  } finally {
    renderer.unmount();
  }
}

async function renderedWriterStateSectionValue(
  stableKey: "entrance:pupils" | "entrance:stereo" | "ocular-health:anterior:conjunctiva",
  state: "normal" | "abnormal" | "deferred",
  other: string,
): Promise<{
  value: string;
  formattedValue: string;
  componentCodes: string[];
  finding: ExamOverviewFindingProjection;
}> {
  const definitions = buildFindingDefinitionSeeds();
  const definition = definitions.find((candidate) => candidate.stableKey === stableKey);
  assert.ok(definition);
  const fhir = new EomWriterFhir();
  const deps: CustomSectionEndpointDeps = {
    authenticate: async () => ({
      staffReference: "Practitioner/state-writer-fixture",
      actorRole: "provider",
      fhir,
    }),
    findingDefinitions: () => definitions,
    now: () => "2026-07-22T12:00:00.000Z",
  };
  const result = await handleCustomSectionCaptureRequest(deps, {
    authHeader: "Bearer state-writer-fixture",
    params: { stableKey },
    body: {
      patientReference: "Patient/state-writer-fixture",
      encounterReference: "Encounter/state-writer-fixture",
      ...(definition.valueSchema.perEye === true
        ? { eyes: { OD: { customFields: [], state, other } } }
        : { customFields: [], state, other }),
    },
  });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  const observation = fhir.resources.find((resource): resource is Observation => resource.resourceType === "Observation");
  assert.ok(observation);
  const writerProjection = buildExamOverviewProjection({
    encounterReference: "Encounter/state-writer-fixture",
    patientReference: "Patient/state-writer-fixture",
    definitions,
    currentObservations: [observation],
    priorObservationCandidates: [],
    assessmentRows: [],
  });
  const finding = writerProjection.findings.find((candidate) => candidate.findingKey === stableKey);
  assert.ok(finding);
  const projection = catalogGuardProjection(definition);
  projection.findings = [finding];
  projection.sections = [overviewSection("pretest", "Pretest", [finding.observationReference])];
  const renderer = create(
    <ExamOverviewBoard
      projection={projection}
      editorEntries={[]}
      refreshing={false}
      onOpenEditor={() => undefined}
      onRefresh={() => undefined}
    />,
  );
  try {
    return {
      value: findingValueText(renderer, stableKey),
      formattedValue: findingValue(finding),
      componentCodes: finding.current.components.map((component) => component.code),
      finding,
    };
  } finally {
    renderer.unmount();
  }
}

function writerSchemaBlindSpots(
  finding: ExamOverviewFindingProjection,
  definitions: ReturnType<typeof buildFindingDefinitionSeeds>,
): string[] {
  const definition = definitions.find((candidate) => candidate.stableKey === finding.findingKey);
  assert.ok(definition);
  const fields = (definition.valueSchema.fields ?? {}) as Record<string, { localCode?: string }>;
  const schemaCodes = new Set(Object.entries(fields).flatMap(([key, field]) => field.localCode ?? key));
  return finding.current.components.flatMap((component) =>
    schemaCodes.has(component.code) ? [] : [`${finding.findingKey}:${component.code}`]
  );
}

function snapshotCodeComponent(code: string, display: string, value: string) {
  return { code, display, value: { kind: "code" as const, code: value, display: value } };
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

// ---------------------------------------------------------------------------
// Fixback after evaluation of 02c8155c — the Undo ledger through EncounterCharting itself
// ---------------------------------------------------------------------------

const PENDING_UNDO_LEDGER: EncounterUndoLedger = {
  encounterId: "exam-1",
  encounter: {
    voided: [{ ref: "Observation/o1", priorStatus: "final" }],
    label: "everything charted",
    count: 31,
    at: "2026-09-01T15:00:00.000Z",
    sectionKeys: [],
    scope: "encounter",
  },
  sections: {
    va: {
      voided: [{ ref: "Observation/va-od", priorStatus: "preliminary" }],
      label: "Visual acuity",
      count: 2,
      at: "2026-09-01T14:00:00.000Z",
      sectionKeys: ["va"],
      scope: "section",
    },
  },
};

/**
 * Restraint pass (2026-09-02): every clear confirms in the in-app dialog. Press the control, let
 * the preview land, then press the dialog's one red button.
 */
async function confirmClearInDialog(harness: { renderer: ReactTestRenderer }, control: ReactTestInstance): Promise<void> {
  await act(async () => { void control.props.onClick(); await flushEffects(); });
  const dialog = harness.renderer.root.findAll((node) => node.props.role === "alertdialog")[0];
  assert.ok(dialog, "the clear asks in the in-app dialog");
  const destroy = dialog.findAll((node) => node.type === "button" && String(node.props.className).includes("odos-confirm-destroy"))[0];
  assert.ok(destroy, "the dialog carries its confirm button");
  await act(async () => { destroy.props.onClick(); await flushEffects(); await flushEffects(); });
}

function visibleSheet(harness: { renderer: ReactTestRenderer }): ReactTestInstance {
  const sheet = harness.renderer.root.findAllByType(ExamEntrySheet).find((candidate) => !candidate.props.hidden);
  assert.ok(sheet, "an entry sheet is open");
  return sheet;
}

function undoButtonIn(node: ReactTestInstance): ReactTestInstance {
  const strip = node.findByProps({ role: "status" });
  return strip.findAllByType("button").find((button) => textContent(button) === "Undo")!;
}

test("fixback P2#3: the ledger loads with the encounter, both placements render from it, and an Undo removes its strip from the response ledger", async () => {
  const harness = await renderEncounter(PROJECTION, { undoLedger: PENDING_UNDO_LEDGER });
  try {
    const bar = harness.renderer.root.findByProps({ "data-testid": "exam-chart-bar" });
    const slots = bar.findAll((node) => typeof node.props["data-chart-bar-slot"] === "string").map((node) => node.props["data-chart-bar-slot"]);
    assert.deepEqual(slots.slice(0, 4), ["patient", "cc-hpi-reserved", "exam-sections", "undo"], "the visit Undo sits beside exam-sections");
    const visitSlot = bar.findByProps({ "data-chart-bar-slot": "undo" });
    assert.match(textContent(visitSlot), /Cleared everything charted · up to 31 values/, "a slot read back from the server is intent-derived: its count is an upper bound");

    act(() => harness.renderer.root.findByType(ExamOverviewBoard).props.onOpenEditor("va"));
    const sheet = visibleSheet(harness);
    assert.equal(sheet.props.sectionId, "va");
    const strip = sheet.findByProps({ "data-undo-scope": "section" });
    assert.match(textContent(strip), /Cleared Visual acuity · up to 2 values/, "the sheet strip is scoped to VA's own slot, and a loaded slot reads as an upper bound");

    await act(async () => { await undoButtonIn(sheet).props.onClick(); await flushEffects(); await flushEffects(); });
    assert.deepEqual(harness.undoRequests, [{ scope: "section", sectionKey: "va" }]);
    assert.equal(visibleSheet(harness).findAllByProps({ "data-undo-scope": "section" }).length, 0, "the strip is gone: the response ledger replaced ours");
    assert.equal(harness.renderer.root.findAllByProps({ "data-chart-bar-slot": "undo" }).length, 1, "the visit slot the response ledger still holds stays");

    await act(async () => { await undoButtonIn(harness.renderer.root.findByProps({ "data-chart-bar-slot": "undo" })).props.onClick(); await flushEffects(); await flushEffects(); });
    assert.deepEqual(harness.undoRequests, [{ scope: "section", sectionKey: "va" }, { scope: "encounter" }]);
    assert.equal(harness.renderer.root.findAllByProps({ "data-chart-bar-slot": "undo" }).length, 0, "the visit Undo is gone once the response ledger no longer holds it");
  } finally {
    harness.restore();
  }
});

test("a failed Clear everything re-reads the overview alongside its error, so the screen cannot contradict the database", async () => {
  const harness = await renderEncounter(PROJECTION);
  const confirmations: string[] = [];
  Object.assign(globalThis.window, { confirm: (message: string) => { confirmations.push(message); return true; } });
  try {
    act(() => harness.renderer.root.findByType(ExamOverviewBoard).props.onOpenEditor("va"));
    const sheet = visibleSheet(harness);
    const overviewBefore = harness.overviewFetchCount();
    const findingsBefore = harness.findingsFetchCount();
    const ledgerBefore = harness.ledgerFetchCount();
    harness.voidFailure.status = 502;
    harness.voidFailure.body = {
      error: "This clear only partly applied: 50 of 51 changes were saved before the record server refused entry 3 of 98 (PUT Observation, HTTP 403); 1 of 98 entries refused. Review the chart before continuing. Undo, where offered, restores only what was actually cleared.",
      code: "void-transaction-failed",
      outcome: "applied-partial",
    };
    const clearAll = sheet.findAll((node) => node.type === "button" && textContent(node) === "Clear chart")[0];
    assert.ok(clearAll, "the tier-3 control is in the sheet chrome");

    await confirmClearInDialog(harness, clearAll);

    assert.equal(confirmations.length, 0, "the clear was confirmed in the in-app dialog, never through window.confirm");
    // The VA sheet's own Clear section probes on mount; only the visit-scope traffic is this test's.
    const visitRequests = harness.voidRequests.filter((request) => (request as { scope: string }).scope === "encounter");
    assert.deepEqual(visitRequests, [{ scope: "encounter", preview: true }, { scope: "encounter" }]);
    assert.equal(harness.overviewFetchCount(), overviewBefore + 1, "the failed clear re-reads the overview");
    assert.equal(harness.findingsFetchCount(), findingsBefore + 1, "…and the unassigned-findings count that rides with it");
    assert.equal(harness.ledgerFetchCount(), ledgerBefore + 1, "…and the undo ledger, so a partial clear's Undo is offered from the slot the server actually holds");
    const status = visibleSheet(harness).findByProps({ className: "odos-exam-entry-sheet-clear-all" }).findByProps({ role: "status" });
    assert.equal(textContent(status), (harness.voidFailure.body as { error: string }).error, "the error is still on screen: refresh AND report");
    // F3: the OUTCOME, not the fetch — the clinician can see and press Undo for the slot the
    // refused clear still wrote, and the strip does not claim an exact count it cannot know.
    const undoSlots = harness.renderer.root.findAllByProps({ "data-chart-bar-slot": "undo" });
    assert.equal(undoSlots.length, 1, "the visit Undo is offered from the re-read ledger");
    const strip = undoSlots[0]!.findByProps({ role: "status" });
    assert.match(textContent(strip), /Cleared everything charted · up to 3 values/, textContent(strip));
    const undoButton = strip.findAllByType("button").find((button) => textContent(button) === "Undo");
    assert.ok(undoButton, "Undo is present");
    assert.equal(undoButton.props.disabled, undefined, "…and enabled");
    assert.equal(undoButton.props.title, "Restore whatever this action actually removed, up to 3 values");
  } finally {
    harness.restore();
  }
});

test("F2: a successful Clear everything renders the exact count — this page saw the slot confirmed by the void's own response", async () => {
  const harness = await renderEncounter(PROJECTION);
  Object.assign(globalThis.window, { confirm: () => true });
  try {
    act(() => harness.renderer.root.findByType(ExamOverviewBoard).props.onOpenEditor("va"));
    const sheet = visibleSheet(harness);
    const clearAll = sheet.findAll((node) => node.type === "button" && textContent(node) === "Clear chart")[0];
    assert.ok(clearAll);

    await confirmClearInDialog(harness, clearAll);

    const undoSlots = harness.renderer.root.findAllByProps({ "data-chart-bar-slot": "undo" });
    assert.equal(undoSlots.length, 1);
    const strip = undoSlots[0]!.findByProps({ role: "status" });
    assert.match(textContent(strip), /Cleared everything charted · 3 values/, textContent(strip));
    assert.doesNotMatch(textContent(strip), /up to/, "a confirmed slot is not hedged");
    assert.equal(strip.findAllByType("button").find((button) => textContent(button) === "Undo")?.props.title, "Restore the 3 values this action removed");
  } finally {
    harness.restore();
  }
});

test("G2: a successful no-op clear must not promote an older partial slot from 'up to 3' to an exact '3'", async () => {
  // A prior visit clear left an intent-derived slot naming three rows; only two were actually voided.
  const olderPartial: EncounterUndoLedger = {
    encounterId: "exam-1",
    encounter: {
      voided: [{ ref: "Observation/o1", priorStatus: "final" }, { ref: "Observation/o2", priorStatus: "final" }, { ref: "Observation/o3", priorStatus: "final" }],
      label: "everything charted",
      count: 3,
      at: "2026-09-02T09:00:00.000Z",
      sectionKeys: [],
      scope: "encounter",
    },
    sections: {},
  };
  const harness = await renderEncounter(PROJECTION, { undoLedger: olderPartial });
  Object.assign(globalThis.window, { confirm: () => true });
  try {
    const stripText = () => textContent(harness.renderer.root.findByProps({ "data-chart-bar-slot": "undo" }).findByProps({ role: "status" }));
    assert.match(stripText(), /Cleared everything charted · up to 3 values/, "loaded: hedged");

    // The preview says 3, the clinician confirms, and by the time the write runs nothing qualifies:
    // HTTP 200, zero writes, the same ledger carried over.
    harness.voidNoop.enabled = true;
    act(() => harness.renderer.root.findByType(ExamOverviewBoard).props.onOpenEditor("va"));
    const clearAll = visibleSheet(harness).findAll((node) => node.type === "button" && textContent(node) === "Clear chart")[0];
    assert.ok(clearAll);
    await confirmClearInDialog(harness, clearAll);

    const visitRequests = harness.voidRequests.filter((request) => (request as { scope: string }).scope === "encounter");
    assert.deepEqual(visitRequests, [{ scope: "encounter", preview: true }, { scope: "encounter" }], "the no-op void really ran");
    assert.match(stripText(), /Cleared everything charted · up to 3 values/, "a response that wrote nothing observed nothing and vouches for nothing");
    assert.doesNotMatch(stripText(), /· 3 values/, "the older slot must not be promoted to an exact count");
  } finally {
    harness.restore();
  }
});

test("fixback P2#1: Undo on a dirty sheet asks before discarding unsaved edits, and a declined confirm sends nothing", async () => {
  const harness = await renderEncounter(PROJECTION, { undoLedger: PENDING_UNDO_LEDGER });
  const confirmations: string[] = [];
  let answer = false;
  Object.assign(globalThis.window, { confirm: (message: string) => { confirmations.push(message); return answer; } });
  try {
    act(() => harness.renderer.root.findByType(ExamOverviewBoard).props.onOpenEditor("va"));
    const sheet = visibleSheet(harness);
    const aside = sheet.findByProps({ "data-testid": "exam-entry-sheet" });
    act(() => { aside.props.onInputCapture({ target: null }); });

    await act(async () => { await undoButtonIn(sheet).props.onClick(); await flushEffects(); });
    assert.equal(confirmations.length, 1, "a dirty sheet asks first");
    assert.match(confirmations[0]!, /unsaved changes in Visual Acuity/i);
    assert.deepEqual(harness.undoRequests, [], "declined: nothing is undone and nothing is discarded");
    assert.equal(visibleSheet(harness).findAllByProps({ "data-undo-scope": "section" }).length, 1, "the strip stays");

    answer = true;
    await act(async () => { await undoButtonIn(visibleSheet(harness)).props.onClick(); await flushEffects(); await flushEffects(); });
    assert.equal(confirmations.length, 2);
    assert.deepEqual(harness.undoRequests, [{ scope: "section", sectionKey: "va" }], "accepted: the undo proceeds");

    // The visit-level Undo in the chart bar guards the open sheet the same way.
    act(() => harness.renderer.root.findByType(ExamOverviewBoard).props.onOpenEditor("va"));
    act(() => { visibleSheet(harness).findByProps({ "data-testid": "exam-entry-sheet" }).props.onInputCapture({ target: null }); });
    answer = false;
    const before = harness.undoRequests.length;
    await act(async () => { await undoButtonIn(harness.renderer.root.findByProps({ "data-chart-bar-slot": "undo" })).props.onClick(); await flushEffects(); });
    assert.equal(confirmations.length, 3, "the chart-bar Undo asks too while a dirty sheet is open");
    assert.equal(harness.undoRequests.length, before);
  } finally {
    harness.restore();
  }
});

test("fixback 56ff8d36 P2#B: a failed Undo keeps the dirty-sheet guard armed — the typed edit stays, and leaving still asks", async () => {
  const harness = await renderEncounter(PROJECTION, { undoLedger: PENDING_UNDO_LEDGER });
  const confirmations: string[] = [];
  let answer = true;
  Object.assign(globalThis.window, { confirm: (message: string) => { confirmations.push(message); return answer; } });
  try {
    act(() => harness.renderer.root.findByType(ExamOverviewBoard).props.onOpenEditor("va"));
    act(() => { visibleSheet(harness).findByProps({ "data-testid": "exam-entry-sheet" }).props.onInputCapture({ target: null }); });

    harness.undoFailure.status = 503;
    await act(async () => { await undoButtonIn(visibleSheet(harness)).props.onClick(); await flushEffects(); await flushEffects(); });
    assert.equal(confirmations.length, 1, "the discard warning was asked and accepted");
    assert.deepEqual(harness.undoRequests, [{ scope: "section", sectionKey: "va" }], "the undo was attempted");
    const sheet = visibleSheet(harness);
    assert.equal(sheet.props.sectionId, "va", "the sheet stays mounted with the typed edit");
    assert.match(textContent(sheet.findByProps({ "data-undo-scope": "section" })), /Undo could not be applied/, "the failure is reported in the strip");

    answer = false;
    act(() => { sheet.findByProps({ "data-testid": "cancel-exam-entry-sheet" }).props.onClick(); });
    assert.equal(confirmations.length, 2, "the failed Undo must leave the sheet dirty for the next transition");
    assert.equal(visibleSheet(harness).props.sectionId, "va", "declined: the sheet with the typed edit is still there");

    // And once an Undo succeeds, the guard is released so the remount does not ask twice.
    harness.undoFailure.status = undefined;
    answer = true;
    await act(async () => { await undoButtonIn(visibleSheet(harness)).props.onClick(); await flushEffects(); await flushEffects(); });
    assert.equal(confirmations.length, 3);
    assert.equal(harness.undoRequests.length, 2);
    act(() => { visibleSheet(harness).findByProps({ "data-testid": "cancel-exam-entry-sheet" }).props.onClick(); });
    assert.equal(confirmations.length, 3, "a successful Undo committed the discard; leaving no longer asks");
  } finally {
    harness.restore();
  }
});

test("a zero-finding comprehensive encounter renders every required trace row with its projected state", () => {
  const renderer = create(
    <ExamOverviewBoard
      projection={zeroFindingComprehensiveProjection()}
      editorEntries={chartEditorInventory()}
      refreshing={false}
      onOpenEditor={() => undefined}
      onRefresh={() => undefined}
    />,
  );
  try {
    const sections = renderer.root.findAllByProps({ "data-testid": "exam-overview-section" });
    assert.deepEqual(
      sections.map((section) => section.props["data-section-key"]),
      ["history", "pretest", "refraction", "contact-lenses", "ocular-health", "assessment"],
    );
    const traceRows = renderer.root.findAllByProps({ "data-testid": "exam-overview-trace-row" });
    assert.deepEqual(
      traceRows.map((row) => [
        row.props["data-trace-section-key"],
        row.props["data-section-state"],
        row.props["data-resolved"],
      ]),
      [
        ["history", "not-examined", false],
        ["entrance", "not-examined", false],
        ["pretest", "not-examined", false],
        ["refraction", "not-examined", false],
        ["ocular-health", "not-examined", false],
        ["assessment", "not-examined", false],
      ],
    );
  } finally {
    renderer.unmount();
  }
});

test("the worksheet omits Imaging because patient studies live in the permanent Images tab", () => {
  const renderer = create(
    <ExamOverviewBoard
      projection={zeroFindingComprehensiveProjection()}
      editorEntries={chartEditorInventory()}
      refreshing={false}
      onOpenEditor={() => undefined}
      onRefresh={() => undefined}
    />,
  );
  try {
    assert.equal(renderer.root.findAllByProps({ "data-section-key": "imaging" }).length, 0);
  } finally {
    renderer.unmount();
  }
});

test("the combined Pretest row resolves only when both Entrance and Pretest traces resolve", () => {
  const projection = zeroFindingComprehensiveProjection();
  const oneResolved: ExamOverviewProjection = {
    ...projection,
    completeness: {
      ...projection.completeness,
      trace: projection.completeness.trace.map((row) =>
        row.sectionKey === "entrance"
          ? { ...row, state: "examined", resolved: true }
          : row
      ),
    },
  };
  const renderer = create(
    <ExamOverviewBoard
      projection={oneResolved}
      editorEntries={chartEditorInventory()}
      refreshing={false}
      onOpenEditor={() => undefined}
      onRefresh={() => undefined}
    />,
  );
  try {
    assert.equal(
      renderer.root.findByProps({ "data-section-key": "pretest" }).props["data-resolved"],
      false,
    );
    renderer.update(
      <ExamOverviewBoard
        projection={{
          ...oneResolved,
          completeness: {
            ...oneResolved.completeness,
            trace: oneResolved.completeness.trace.map((row) =>
              row.sectionKey === "pretest"
                ? { ...row, state: "examined", resolved: true }
                : row
            ),
          },
        }}
        editorEntries={chartEditorInventory()}
        refreshing={false}
        onOpenEditor={() => undefined}
        onRefresh={() => undefined}
      />,
    );
    assert.equal(
      renderer.root.findByProps({ "data-section-key": "pretest" }).props["data-resolved"],
      true,
    );
  } finally {
    renderer.unmount();
  }
});

test("worksheet rows expose owners and keep Contact Lenses visibly optional", () => {
  const renderer = create(
    <ExamOverviewBoard
      projection={zeroFindingComprehensiveProjection()}
      editorEntries={chartEditorInventory()}
      refreshing={false}
      onOpenEditor={() => undefined}
      onRefresh={() => undefined}
    />,
  );
  try {
    const owners = renderer.root.findAllByProps({ "data-testid": "exam-section-owner" });
    assert.deepEqual(
      owners.map((owner) => [owner.props["data-owner-section-key"], textContent(owner)]),
      [
        ["history", "Doctor"],
        ["pretest", "Tech"],
        ["refraction", "Doctor"],
        ["contact-lenses", "Doctor"],
        ["ocular-health", "Doctor"],
        ["assessment", "Doctor"],
      ],
    );
    for (const sectionKey of ["contact-lenses"]) {
      const section = renderer.root.findByProps({ "data-section-key": sectionKey });
      assert.equal(section.props["data-required"], false);
      assert.match(section.props.className, /is-optional/);
      assert.match(textContent(section), /Not required for this visit type/);
      assert.doesNotMatch(textContent(section), /Not configured/);
    }
  } finally {
    renderer.unmount();
  }
});

test("a zero-finding Pretest section renders one labeled blank per chartable editor", () => {
  const opened: string[] = [];
  const renderer = create(
    <ExamOverviewBoard
      projection={zeroFindingComprehensiveProjection()}
      editorEntries={chartEditorInventory()}
      refreshing={false}
      onOpenEditor={(sectionId) => opened.push(sectionId)}
      onRefresh={() => undefined}
    />,
  );
  try {
    const bodies = renderer.root.findAllByProps({ "data-testid": "exam-section-body" });
    assert.equal(bodies.length, 6);
    for (const body of bodies) {
      assert.equal(body.props.style, undefined);
    }

    const pretest = renderer.root.findByProps({ "data-section-key": "pretest" });
    const blanks = pretest.findAllByProps({ "data-testid": "exam-section-blank" });
    const expectedSlots = [
      ["wearing", "Wearing (WRx)"],
      ["auto-refraction", "Auto-Refraction / Auto-K"],
      ["pretest-vitals", "Vitals / BioPhotonic"],
      ["manual-keratometry", "Manual Keratometry"],
      ["pachymetry", "Pachymetry"],
      ["va", "Visual Acuity"],
      ["pupils", "Pupils"],
      ["stereopsis", "Stereopsis"],
      ["color-vision", "Color Vision"],
      ["eom", "EOM / Diplopia"],
      ["cvf", "Confrontation visual fields"],
      ["cover-test", "Cover Test"],
      ["iop", "IOP"],
      ["dilation", "Dilation"],
    ];
    assert.equal(blanks.length, 14);
    assert.deepEqual(
      blanks.map((blank) => [blank.props["data-editor-section-id"], textContent(blank).replace("Tap to chart", "")]),
      expectedSlots,
    );

    for (const blank of blanks) act(() => blank.props.onClick());
    assert.deepEqual(opened, expectedSlots.map(([editorId]) => editorId));
  } finally {
    renderer.unmount();
  }
});

test("only the single-slot Refraction group keeps Chart another finding", () => {
  const renderer = create(
    <ExamOverviewBoard
      projection={zeroFindingComprehensiveProjection()}
      editorEntries={chartEditorInventory()}
      refreshing={false}
      onOpenEditor={() => undefined}
      onRefresh={() => undefined}
    />,
  );
  try {
    const expectedBlankIdsBySection = {
      history: ["hpi"],
      refraction: ["refraction"],
      "contact-lenses": ["soft-contact-lens", "specialty-contact-lens", "ortho-k", "myopia-management"],
      "ocular-health": ["cup-disc", "gonioscopy", "dry-eye"],
      assessment: ["assessment", "prescription"],
    } as const;
    for (const [sectionKey, expectedEditorIds] of Object.entries(expectedBlankIdsBySection)) {
      const section = renderer.root.findByProps({ "data-section-key": sectionKey });
      assert.deepEqual(
        section.findAllByProps({ "data-testid": "exam-section-blank" })
          .map((blank) => blank.props["data-editor-section-id"]),
        expectedEditorIds,
      );
    }

    const blankEditorIds = renderer.root.findAllByProps({ "data-testid": "exam-section-blank" })
      .map((blank) => blank.props["data-editor-section-id"]);
    assert.equal(blankEditorIds.includes("refraction-history"), false);

    const disclosures = renderer.root.findAllByProps({ "data-testid": "chart-another-finding" });
    assert.equal(disclosures.length, 1);
    assert.deepEqual(
      disclosures[0]!.findAllByProps({ "data-testid": "exam-editor-entry-row" })
        .map((row) => row.props["data-editor-section-id"]),
      ["refraction", "refraction-history", "eye-growth"],
    );
  } finally {
    renderer.unmount();
  }
});

test("Assessment keeps prescription available but visibly not required", () => {
  const projection = zeroFindingComprehensiveProjection();
  projection.sections = projection.sections.map((section) =>
    section.sectionKey === "assessment" ? { ...section, state: "examined" } : section
  );
  projection.completeness.trace = projection.completeness.trace.map((row) =>
    row.sectionKey === "assessment" ? { ...row, state: "examined", resolved: true } : row
  );
  const renderer = create(
    <ExamOverviewBoard
      projection={projection}
      editorEntries={chartEditorInventory()}
      refreshing={false}
      onOpenEditor={() => undefined}
      onRefresh={() => undefined}
    />,
  );
  try {
    const assessment = renderer.root.findByProps({ "data-section-key": "assessment" });
    const plan = assessment.findByProps({ "data-editor-section-id": "prescription" });
    assert.equal(plan.props["data-required"], false);
    assert.match(textContent(plan), /Available when needed/);
    assert.doesNotMatch(textContent(plan), /Tap to chart/);
  } finally {
    renderer.unmount();
  }
});

test("partial sections use a clinical label and remain unresolved", () => {
  const projection = zeroFindingComprehensiveProjection();
  projection.sections = projection.sections.map((section) =>
    section.sectionKey === "ocular-health" ? { ...section, state: "partial" } : section
  );
  projection.completeness.trace = projection.completeness.trace.map((row) =>
    row.sectionKey === "ocular-health" ? { ...row, state: "partial", resolved: false } : row
  );
  const renderer = create(
    <ExamOverviewBoard
      projection={projection}
      editorEntries={chartEditorInventory()}
      refreshing={false}
      onOpenEditor={() => undefined}
      onRefresh={() => undefined}
    />,
  );
  try {
    const state = renderer.root.findByProps({
      "data-testid": "exam-overview-trace-row",
      "data-trace-section-key": "ocular-health",
    });
    assert.equal(textContent(state), "Partial examination");
    assert.equal(state.props["data-resolved"], false);
    assert.match(state.props.className, /is-partial/);
  } finally {
    renderer.unmount();
  }
});

test("ocular rows stay in anatomical slots and render findings instead of status words", () => {
  const base = zeroFindingComprehensiveProjection();
  const findings: ExamOverviewProjection["findings"] = [
    ocularSheetFinding("Observation/cornea", "ocular-health:anterior:cornea", "Cornea", "OD", {
      interpretation: "abnormal",
      sheetFindings: [
        { display: "nuclear sclerosis", qualifiers: ["2+"] },
        { display: "posterior subcapsular (PSC)", qualifiers: ["3+"] },
      ],
    }),
    ocularSheetFinding("Observation/lids", "ocular-health:anterior:lids-lashes", "Lids & Lashes", "OU", {
      interpretation: "normal",
      normalLabel: "Normal lid position and lashes",
    }),
  ];
  const projection: ExamOverviewProjection = {
    ...base,
    findings,
    sections: base.sections.map((section) => section.sectionKey === "ocular-health"
      ? { ...section, findingObservationReferences: findings.map((row) => row.observationReference) }
      : section),
  };
  const renderer = create(
    <ExamOverviewBoard
      projection={projection}
      editorEntries={chartEditorInventory({ ocularHealthSections: [
        { id: "ocular-health:anterior:lids-lashes", label: "Lids & Lashes", segment: "anterior" },
        { id: "ocular-health:anterior:conjunctiva", label: "Conjunctiva", segment: "anterior" },
        { id: "ocular-health:anterior:cornea", label: "Cornea", segment: "anterior" },
      ] })}
      refreshing={false}
      onOpenEditor={() => undefined}
      onRefresh={() => undefined}
    />,
  );
  try {
    const ocular = renderer.root.findByProps({ "data-section-key": "ocular-health" });
    const slots = ocular.findAll((node) =>
      node.props["data-testid"] === "exam-finding-row" || node.props["data-testid"] === "exam-section-blank"
    );
    assert.deepEqual(slots.slice(0, 3).map((row) =>
      row.props["data-finding-key"] ?? row.props["data-editor-section-id"]
    ), [
      "ocular-health:anterior:lids-lashes",
      "ocular-health:anterior:conjunctiva",
      "ocular-health:anterior:cornea",
    ]);
    const normalValue = textContent(slots[0]!.findByProps({ className: "odos-exam-finding-value" }));
    const abnormalValue = textContent(slots[2]!.findByProps({ className: "odos-exam-finding-value" }));
    assert.doesNotMatch(normalValue, /^(?:normal|WNL)$/i);
    assert.equal(normalValue, "Normal lid position and lashes");
    assert.doesNotMatch(abnormalValue.replace(/^OD /, ""), /^abnormal$/i);
    assert.match(abnormalValue, /OD nuclear sclerosis 2\+; posterior subcapsular \(PSC\) 3\+/);
  } finally {
    renderer.unmount();
  }
});

test("the encounter screen renders only the registry-backed completeness count", async () => {
  const projection = zeroFindingComprehensiveProjection();
  const harness = await renderEncounter(projection);
  try {
    const triggers = harness.renderer.root.findAllByProps({ "data-testid": "exam-completeness-trigger" });
    assert.equal(triggers.length, 1);
    assert.equal(textContent(triggers[0]!), "Exam sections: 0 of 6");
    const secondaryCounts = harness.renderer.root.findAll((node) =>
      node.type === "span" && /^\d+ sections$/.test(textContent(node))
    );
    assert.equal(secondaryCounts.length, 0);
  } finally {
    harness.restore();
  }
});

test("structure view keeps required blanks while collapsing performed findings into by-exception rows", async () => {
  const harness = await renderEncounter(PROJECTION);
  try {
    const sections = harness.renderer.root.findAllByProps({ "data-testid": "exam-overview-section" })
      .filter((section) => section.props["data-section-state"] !== "editor-only");
    assert.deepEqual(
      sections.map((section) => section.props["data-section-key"]),
      ["history", "pretest", "contact-lenses"],
    );
    assert.equal(harness.renderer.root.findAllByType(SpineNav).length, 0);
    const rows = harness.renderer.root.findAllByProps({ "data-testid": "exam-finding-row" });
    assert.equal(rows.length, 2);
    assert.equal(rows.filter((row) => row.props["data-finding-key"] === "intraocular-pressure").length, 1);
    const rendered = JSON.stringify(harness.renderer.toJSON());
    assert.match(rendered, /deferred — reason not recorded/);
    const findingText = rows.map(textContent).join(" ");
    assert.doesNotMatch(findingText, /Examined|Current visit|Interpretation not recorded|not-visualized-json|sourceEncoding/);
  } finally {
    harness.restore();
  }
});

test("charted findings keep their FindingRow while sibling editors receive distinct empty slots", () => {
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
    const pretest = renderer.root.findByProps({ "data-section-key": "pretest" });
    assert.equal(pretest.findAllByProps({ "data-finding-key": "intraocular-pressure" }).length, 1);
    assert.equal(pretest.findAllByProps({ "data-editor-section-id": "iop" }).length, 0);
    const va = pretest.findByProps({ "data-editor-section-id": "va" });
    assert.match(textContent(va), /Visual Acuity/);

    const refractionRow = renderer.root.findByProps({ "data-editor-section-id": "refraction" });
    assert.equal(refractionRow.props["data-editor-presentation"], "full-page");
    assert.match(textContent(refractionRow), /Expand/);
    assert.doesNotMatch(textContent(refractionRow), /Full page/);

    assert.equal(renderer.root.findAllByProps({ "data-testid": "chart-another-finding" }).length, 1);
    assert.equal(renderer.root.findAllByProps({ "data-section-key": "history" }).length, 1);
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

test("EncounterCharting passes the clinical sheet guard to enabled and disabled header actions", async () => {
  const harness = await renderEncounter(PROJECTION);
  try {
    let header = harness.renderer.root.findByType(EncounterHeader);
    let sign = header.findByProps({ "data-chart-bar-slot": "sign" });
    let abandon = header.findAllByType("button").find((button) => textContent(button) === "Abandon encounter");

    assert.equal(header.props.clinicalActionUnavailableReason, undefined);
    assert.equal(sign.props.disabled, false);
    assert.equal(abandon?.props.disabled, false);

    await act(async () => harness.renderer.root.findByProps({ "data-editor-section-id": "pupils" }).props.onClick());

    header = harness.renderer.root.findByType(EncounterHeader);
    sign = header.findByProps({ "data-chart-bar-slot": "sign" });
    abandon = header.findAllByType("button").find((button) => textContent(button) === "Abandon encounter");
    assert.equal(header.props.clinicalActionUnavailableReason, "Finish or cancel Pupils first");
    assert.equal(sign.props.disabled, true);
    assert.equal(abandon?.props.disabled, true);
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

test("EncounterCharting keeps a dirty mapped sheet mounted until its guarded transition is accepted", async () => {
  const harness = await renderEncounter(PROJECTION);
  const prompts: string[] = [];
  try {
    Object.assign(globalThis.window, {
      confirm(message: string) {
        prompts.push(message);
        return false;
      },
    });
    await act(async () => editorControl(harness.renderer.root, "hpi").props.onClick());
    const hpiSheet = harness.renderer.root.findAllByType(ExamEntrySheet).find((sheet) => !sheet.props.hidden);
    assert.ok(hpiSheet);
    await act(async () => hpiSheet.props.onDirty());

    await act(async () => editorControl(harness.renderer.root, "va").props.onClick());
    assert.equal(harness.renderer.root.findAllByType(ExamEntrySheet).find((sheet) => !sheet.props.hidden)?.props.sectionId, "hpi");
    assert.deepEqual(prompts, [
      "Discard unsaved changes in Chief Complaint / HPI / ROS and open Visual Acuity?",
    ]);

    Object.assign(globalThis.window, { confirm: () => true });
    await act(async () => editorControl(harness.renderer.root, "va").props.onClick());
    assert.equal(harness.renderer.root.findAllByType(ExamEntrySheet).find((sheet) => !sheet.props.hidden)?.props.sectionId, "va");
    assert.equal(harness.renderer.root.findAllByType(HpiSection).length, 0);
    assert.equal(harness.renderer.root.findAllByType(VaSection).length, 1);
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
    assert.equal(dilationFinding.props.role, undefined);
    assert.equal(dilationFinding.findByProps({ "data-testid": "exam-finding-editor" }).type, "button");

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

test("HPI entry sheet stays open with a blank intake and the saved complaint after Save and Add Another", async () => {
  const savedComplaint = hpiComplaintFixture("complaint-1", "Patient reports dry eyes.");
  const harness = await renderEncounter(PROJECTION, {
    hpiDefinitions: [HPI_DRY_EYE],
    hpiGenericOptions: HPI_GENERIC_OPTIONS,
    hpiSavedComplaints: [savedComplaint],
  });
  try {
    await act(async () => editorControl(harness.renderer.root, "hpi").props.onClick());
    await act(async () => {
      await flushEffects();
      await flushEffects();
    });

    const complaint = harness.renderer.root.findAllByType("button")
      .find((button) => textContent(button) === "Patient (Dry Eye)");
    assert.ok(complaint);
    await act(async () => complaint.props.onClick());

    const saveAndAdd = harness.renderer.root.findAllByType("button")
      .find((button) => textContent(button) === "Save and Add Another");
    assert.ok(saveAndAdd);
    await act(async () => {
      saveAndAdd.props.onClick();
      await flushEffects();
      await flushEffects();
    });

    const sheet = harness.renderer.root.findByProps({
      "data-testid": "exam-entry-sheet",
      "data-entry-sheet-section": "hpi",
    });
    assert.match(textContent(sheet), /Patient reports dry eyes\./);
    const concern = sheet.findAllByType("input").find((input) => input.props.maxLength === 4000);
    assert.ok(concern);
    assert.equal(concern.props.value, "");
  } finally {
    harness.restore();
  }
});

test("HPI entry sheet closes after plain Save Complaint", async () => {
  const harness = await renderEncounter(PROJECTION, {
    hpiDefinitions: [HPI_DRY_EYE],
    hpiGenericOptions: HPI_GENERIC_OPTIONS,
    hpiSavedComplaints: [hpiComplaintFixture("complaint-1", "Patient reports dry eyes.")],
  });
  try {
    await act(async () => editorControl(harness.renderer.root, "hpi").props.onClick());
    await act(async () => {
      await flushEffects();
      await flushEffects();
    });

    const complaint = harness.renderer.root.findAllByType("button")
      .find((button) => textContent(button) === "Patient (Dry Eye)");
    assert.ok(complaint);
    await act(async () => complaint.props.onClick());

    const save = harness.renderer.root.findAllByType("button")
      .find((button) => textContent(button) === "Save Complaint");
    assert.ok(save);
    await act(async () => {
      save.props.onClick();
      await flushEffects();
      await flushEffects();
    });

    assert.equal(harness.renderer.root.findAllByProps({
      "data-testid": "exam-entry-sheet",
      "data-entry-sheet-section": "hpi",
    }).length, 0);
    assert.equal(harness.renderer.root.findAllByType(ExamOverviewBoard).length, 1);
  } finally {
    harness.restore();
  }
});

test("saving a complaint records History and refreshes the exam overview to Examined", async () => {
  const charted: ExamOverviewProjection = {
    ...PROJECTION,
    findings: [
      ...PROJECTION.findings,
      {
        observationReference: "Observation/history-1",
        findingKey: "hpi_ros",
        sectionKey: "hpi",
        display: "History",
        laterality: "UNKNOWN",
        examination: { state: "examined", sourceEncoding: "observation" },
        interpretation: "unknown",
        provenance: { state: "current" },
        current: { components: [{ code: "HISTORY_COMPLAINT_1", value: { kind: "string", value: "Patient reports dry eyes." } }] },
      },
    ],
    sections: PROJECTION.sections.map((section) => section.sectionKey === "history"
      ? { ...section, state: "examined", findingObservationReferences: ["Observation/history-1"] }
      : section),
    completeness: {
      ...PROJECTION.completeness,
      status: "complete",
      resolvedSectionCount: 2,
      trace: PROJECTION.completeness.trace.map((row) => row.sectionKey === "history"
        ? { ...row, state: "examined", resolved: true }
        : row),
    },
  };
  const harness = await renderEncounter(PROJECTION, {
    hpiDefinitions: [HPI_DRY_EYE],
    hpiGenericOptions: HPI_GENERIC_OPTIONS,
    hpiSavedComplaints: [hpiComplaintFixture("complaint-1", "Patient reports dry eyes.")],
    overviewAfterHpiCapture: charted,
  });
  try {
    await act(async () => editorControl(harness.renderer.root, "hpi").props.onClick());
    await act(async () => {
      await flushEffects();
      await flushEffects();
    });
    const complaint = harness.renderer.root.findAllByType("button")
      .find((button) => textContent(button) === "Patient (Dry Eye)");
    assert.ok(complaint);
    await act(async () => complaint.props.onClick());
    const save = harness.renderer.root.findAllByType("button")
      .find((button) => textContent(button) === "Save Complaint");
    assert.ok(save);
    await act(async () => {
      save.props.onClick();
      await flushEffects();
      await flushEffects();
    });

    assert.equal(harness.hpiCaptureCount(), 1);
    const historyTrace = harness.renderer.root.findAllByProps({ "data-testid": "exam-overview-trace-row" })
      .find((row) => row.props["data-trace-section-key"] === "history");
    assert.ok(historyTrace);
    assert.equal(historyTrace.props["data-section-state"], "examined");
    assert.equal(textContent(historyTrace), "Examined");
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
    completeness: {
      ...PROJECTION.completeness,
      trace: PROJECTION.completeness.trace.map((row) =>
        row.sectionKey === "pretest"
          ? { ...row, state: "deferred-with-reason", resolved: true }
          : row
      ),
    },
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
    const pretestTrace = harness.renderer.root.findByProps({ "data-trace-section-key": "pretest" });
    assert.equal(pretestTrace.props["data-section-state"], "deferred-with-reason");
    assert.match(textContent(pretestTrace), /Deferred/);
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
  hpiDefinitions?: ComplaintDefinition[];
  hpiGenericOptions?: GenericComplaintOptions;
  hpiSavedComplaints?: EncounterComplaint[];
  overviewAfterHpiCapture?: unknown;
  /** Served at GET .../void/ledger when the encounter loads. */
  undoLedger?: EncounterUndoLedger;
}

async function renderEncounter(projection: unknown, options: RenderEncounterOptions = {}): Promise<{
  renderer: ReactTestRenderer;
  overviewFetchCount: () => number;
  findingsFetchCount: () => number;
  hpiCaptureCount: () => number;
  overviewErrors: unknown[][];
  focusRestoreCount: () => number;
  /** Every POST .../void/undo body, in order. The fake clears that slot and returns what remains. */
  undoRequests: unknown[];
  /** Set `status` to make the next undo requests fail with that HTTP status. */
  undoFailure: { status?: number };
  /** Every POST .../void body, in order (preview and real). */
  voidRequests: unknown[];
  /** Set `status` (+ `body`) to make the next non-preview void POST fail with that HTTP status. */
  voidFailure: { status?: number; body?: unknown };
  /** Set `enabled` to make the next non-preview void POST answer 200 with ZERO writes and the unchanged ledger (the endpoint's no-op shape). */
  voidNoop: { enabled?: boolean };
  ledgerFetchCount: () => number;
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
  let hpiCaptures = 0;
  let focusRestores = 0;
  const undoRequests: unknown[] = [];
  const undoFailure: { status?: number } = {};
  const voidRequests: unknown[] = [];
  const voidFailure: { status?: number; body?: unknown } = {};
  const voidNoop: { enabled?: boolean } = {};
  let ledgerFetches = 0;
  let undoLedgerState: EncounterUndoLedger | undefined = options.undoLedger;
  globalThis.fetch = (async (input, init) => {
    const url = String(input);
    if (url.endsWith("/clinical-graph/encounters/exam-1/void/ledger")) {
      ledgerFetches += 1;
      return jsonResponse({ ledger: undoLedgerState ?? { encounterId: "exam-1", encounter: null, sections: {} } });
    }
    if (url.endsWith("/clinical-graph/encounters/exam-1/void") && init?.method === "POST") {
      const body = JSON.parse(String(init.body)) as { scope: string; preview?: boolean };
      voidRequests.push(body);
      const voided = ["Observation/va-od", "Observation/va-os", "Observation/va-ou"];
      const sections = [{ sectionKey: "va", label: "Visual acuity", count: 3 }];
      if (!body.preview && voidNoop.enabled) {
        // Like the endpoint when nothing qualifies any more: HTTP 200, no transaction, count 0,
        // and the CURRENT ledger carried over unchanged.
        return jsonResponse({ voided: [], count: 0, sections: [], entries: [], preview: false, ledger: undoLedgerState ?? { encounterId: "exam-1", encounter: null, sections: {} } });
      }
      if (!body.preview && body.scope === "encounter") {
        // Like the server on this non-atomic stack: the visit slot is written from INTENT — every
        // row the clear meant to void — whether or not the transaction is then refused.
        undoLedgerState = {
          encounterId: "exam-1",
          encounter: { voided: voided.map((ref) => ({ ref, priorStatus: "final" })), label: "everything charted", count: 3, at: "2026-09-02T10:00:00.000Z", sectionKeys: [], scope: "encounter" },
          sections: {},
        };
      }
      if (!body.preview && voidFailure.status) {
        return new Response(JSON.stringify(voidFailure.body ?? { error: "void failed" }), { status: voidFailure.status, headers: { "Content-Type": "application/json" } });
      }
      return jsonResponse({ voided, count: 3, sections, entries: [], preview: Boolean(body.preview), ...(body.preview ? {} : { ledger: undoLedgerState }) });
    }
    if (url.endsWith("/clinical-graph/encounters/exam-1/void/undo") && init?.method === "POST") {
      const body = JSON.parse(String(init.body)) as { scope: string; sectionKey?: string };
      undoRequests.push(body);
      if (undoFailure.status) {
        return new Response(JSON.stringify({ error: "Undo could not be applied.", code: "undo-entry-unavailable" }), { status: undoFailure.status, headers: { "Content-Type": "application/json" } });
      }
      // Like the server: an undo clears exactly its own slot and returns the ledger that remains.
      const current = undoLedgerState ?? { encounterId: "exam-1", encounter: null, sections: {} };
      undoLedgerState = body.scope === "encounter"
        ? { ...current, encounter: null }
        : { ...current, sections: Object.fromEntries(Object.entries(current.sections).filter(([key]) => key !== body.sectionKey)) };
      return jsonResponse({ restored: ["Observation/o1"], count: 1, skipped: [], ...body, ledger: undoLedgerState });
    }
    if (url.endsWith("/clinical-graph/encounters/exam-1/exam-overview")) {
      const responses = options.overviewResponses ?? [projection];
      const response = options.overviewAfterHpiCapture !== undefined && hpiCaptures > 0
        ? options.overviewAfterHpiCapture
        : responses[Math.min(overviewFetches, responses.length - 1)];
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
    if (url.endsWith("/clinical-graph/hpi/definition")) {
      return jsonResponse({ definition: { fields: { reviewOfSystems: { options: [] } } } });
    }
    if (url.endsWith("/clinical-graph/complaint-definitions")) {
      return jsonResponse({
        definitions: options.hpiDefinitions ?? [],
        genericOptions: options.hpiGenericOptions ?? { conditions: [], qualities: [], treatments: [] },
      });
    }
    if (url.endsWith("/clinical-graph/encounters/exam-1/complaints")) {
      return jsonResponse({ complaints: init?.method === "POST" ? options.hpiSavedComplaints ?? [] : [] });
    }
    if (url.endsWith("/clinical-graph/hpi") && init?.method === "POST") {
      hpiCaptures += 1;
      return jsonResponse({ observationReference: "Observation/history-1" });
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
    hpiCaptureCount: () => hpiCaptures,
    overviewErrors,
    focusRestoreCount: () => focusRestores,
    undoRequests,
    undoFailure,
    voidRequests,
    voidFailure,
    voidNoop,
    ledgerFetchCount: () => ledgerFetches,
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

function ocularSheetFinding(
  observationReference: string,
  findingKey: string,
  display: string,
  laterality: "OD" | "OS" | "OU",
  sheet: {
    interpretation: "normal" | "abnormal";
    normalLabel?: string;
    sheetFindings?: Array<{ display: string; qualifiers: string[] }>;
  },
): ExamOverviewProjection["findings"][number] {
  return {
    observationReference,
    findingKey,
    sectionKey: findingKey,
    display,
    laterality,
    examination: { state: "examined", sourceEncoding: "observation" },
    interpretation: sheet.interpretation,
    provenance: { state: "current" },
    current: { components: [] },
    ...(sheet.normalLabel ? { normalLabel: sheet.normalLabel } : {}),
    ...(sheet.sheetFindings ? { sheetFindings: sheet.sheetFindings } : {}),
  };
}

function zeroFindingComprehensiveProjection(): ExamOverviewProjection {
  return buildExamOverviewProjection({
    encounterReference: "Encounter/exam-1",
    patientReference: "Patient/patient-1",
    visitTypeCategoryId: "comprehensive",
    definitions: [],
    currentObservations: [],
    priorObservationCandidates: [],
    assessmentRows: [],
  });
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

function testTimeLabel(value: string): string {
  return new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(value));
}

function textContent(node: ReactTestInstance): string {
  return node.children.map((child) =>
    typeof child === "string" ? child : textContent(child)
  ).join("");
}

function findingValueText(renderer: ReactTestRenderer, findingKey: string): string {
  const row = renderer.root.findByProps({ "data-finding-key": findingKey });
  return textContent(row.findByProps({ className: "odos-exam-finding-value" }));
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
