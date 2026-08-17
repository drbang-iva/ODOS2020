import assert from "node:assert/strict";
import { test } from "node:test";
import React from "react";
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

test("structure view renders all projected sections and keeps every clinical state channel independent", async () => {
  const harness = await renderEncounter(PROJECTION);
  try {
    const sections = harness.renderer.root.findAllByProps({ "data-testid": "exam-overview-section" })
      .filter((section) => section.props["data-section-state"] !== "editor-only");
    assert.deepEqual(
      sections.map((section) => section.props["data-section-key"]),
      ["pretest", "history", "assessment"],
    );
    assert.deepEqual(
      sections.map((section) => section.props["data-section-state"]),
      ["examined", "not-examined", "not-indicated"],
    );
    assert.equal(harness.renderer.root.findAllByType(SpineNav).length, 0);

    const laterality = harness.renderer.root.findAllByProps({ "data-testid": "finding-laterality" });
    assert.deepEqual(laterality.map(textContent), ["OD", "OS", "OU", "UNKNOWN"]);

    const rowStates = harness.renderer.root.findAllByProps({ "data-channel": "examination" });
    assert.deepEqual(rowStates.map((node) => node.props["data-state"]), [
      "examined",
      "examined",
      "deferred-with-reason",
      "deferred-without-reason",
    ]);
    assert.match(textContent(rowStates[2]!), /Deferred — Patient declined/);
    assert.equal(textContent(rowStates[3]!), "Deferred — reason not recorded");

    const sectionStates = harness.renderer.root.findAllByProps({ "data-channel": "section-state" });
    assert.ok(sectionStates.some((node) => textContent(node) === "Not examined"));
    assert.ok(sectionStates.some((node) => textContent(node) === "Not indicated"));

    const interpretation = harness.renderer.root.findByProps({
      "data-channel": "interpretation",
      "data-state": "abnormal",
    });
    const provenance = harness.renderer.root.findByProps({
      "data-channel": "provenance",
      "data-state": "carried-unreasserted",
    });
    const change = harness.renderer.root.findByProps({ "data-channel": "change-from-prior" });
    assert.equal(textContent(interpretation), "Abnormal");
    assert.match(textContent(provenance), /Carried — not reasserted/);
    assert.match(textContent(change), /Changed \+4 mmHg/);
    assert.notEqual(interpretation.props.className, provenance.props.className);
    assert.notEqual(interpretation.props.className, change.props.className);
    assert.notEqual(provenance.props.className, change.props.className);

    assert.equal(harness.renderer.root.findAllByProps({ "data-testid": "finding-prior" }).length, 2);
    assert.match(JSON.stringify(harness.renderer.toJSON()), /1 deferred reason missing/);
    assert.doesNotMatch(JSON.stringify(harness.renderer.toJSON()), /not-visualized-json|sourceEncoding/);
  } finally {
    harness.restore();
  }
});

test("editor-entry rows live in their cards, preserve empty-card reachability, and disclose sheet versus full-page behavior", () => {
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

    const history = renderer.root.findByProps({ "data-section-key": "history" });
    assert.equal(history.findAllByProps({ "data-editor-section-id": "hpi" }).length, 1);
    assert.match(textContent(history), /No finding observations recorded/);

    const pretest = renderer.root.findByProps({ "data-section-key": "pretest" });
    const va = pretest.findByProps({ "data-editor-section-id": "va" });
    assert.equal(va.props["data-editor-presentation"], "sheet");
    assert.equal(va.props["aria-pressed"], true);
    assert.match(textContent(va), /Entry sheet/);
    assert.equal(pretest.findAllByProps({ "data-finding-key": "intraocular-pressure" }).length, 2);

    const refraction = renderer.root.findByProps({ "data-section-key": "refraction" });
    const refractionRow = refraction.findByProps({ "data-editor-section-id": "refraction" });
    assert.equal(refractionRow.props["data-editor-presentation"], "full-page");
    assert.match(textContent(refractionRow), /Full page/);

    const contactLenses = renderer.root.findByProps({ "data-section-key": "contact-lenses" });
    assert.equal(contactLenses.findAllByProps({ "data-editor-section-id": "soft-contact-lens" }).length, 1);

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

test("blackout preserves the structure editor, open visit controls, and focused control through keyboard restore", async () => {
  const harness = await renderEncounter(PROJECTION);
  try {
    const vaLauncher = harness.renderer.root.findByProps({ "data-editor-section-id": "va" });
    await act(async () => vaLauncher.props.onClick());
    assert.equal(harness.renderer.root.findAllByType(VaSection).length, 1);

    const visitChips = harness.renderer.root.findAllByProps({ "data-testid": "visit-chip" });
    assert.equal(visitChips.length, 1);
    const visitChip = visitChips[0]!;
    await act(async () => visitChip.props.onClick());
    const visitSurface = harness.renderer.root.findByProps({ "data-testid": "visit-controls-surface" });
    assert.equal(visitSurface.findAllByType(VisitCodeSelector).length, 1);
    assert.equal(visitSurface.findAllByType(ProcedureChargeList).length, 1);

    const blackout = harness.renderer.root.findByProps({ "data-testid": "blackout-control" });
    assert.equal(blackout.type, "button");
    await act(async () => blackout.props.onClick());
    const overlay = harness.renderer.root.findByProps({ "data-testid": "blackout-overlay" });
    assert.equal(harness.renderer.root.findAllByType(VaSection).length, 1);
    assert.equal(harness.renderer.root.findAllByProps({ "data-testid": "visit-controls-surface" }).length, 1);

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
    assert.equal(harness.renderer.root.findAllByType(VaSection).length, 1);
    assert.equal(harness.renderer.root.findAllByProps({ "data-testid": "visit-controls-surface" }).length, 1);
    assert.equal(harness.focusRestoreCount(), 1);
  } finally {
    harness.restore();
  }
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
      "dilation",
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
    for (const pretestId of ["va", "pupils", "iop", "cover-test", "dilation"]) {
      assert.ok(editorIds.includes(pretestId), `${pretestId} must remain reachable`);
    }

    const vaLauncher = harness.renderer.root.findByProps({ "data-editor-section-id": "va" });
    await act(async () => vaLauncher.props.onClick());
    assert.equal(harness.renderer.root.findAllByType(VaSection).length, 1);
    assert.equal(harness.renderer.root.findAllByType(SpineNav).length, 0);
    assert.equal(harness.renderer.root.findAllByType(ExamOverviewBoard).length, 1);
    assert.equal(harness.renderer.root.findAllByProps({ "data-testid": "exam-entry-sheet" }).length, 1);
    assert.equal(vaLauncher.props["aria-pressed"], true);

    const cancel = harness.renderer.root.findByProps({ "data-testid": "cancel-exam-entry-sheet" });
    await act(async () => cancel.props.onClick());
    assert.equal(harness.renderer.root.findAllByProps({ "data-testid": "exam-entry-sheet" }).length, 0);
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
      const launcher = harness.renderer.root.findByProps({ "data-editor-section-id": contract.sectionId });
      await act(async () => launcher.props.onClick());
      const sheet = harness.renderer.root.findByProps({
        "data-testid": "exam-entry-sheet",
        "data-entry-sheet-section": contract.sectionId,
      });
      assert.equal(sheet.findAllByType(contract.component).length, 1, `${contract.sectionId} existing editor`);
      assert.equal(harness.renderer.root.findAllByType(ExamOverviewBoard).length, 1);

      await act(async () => harness.renderer.root.findByProps({ "data-testid": "cancel-exam-entry-sheet" }).props.onClick());
      assert.equal(harness.renderer.root.findAllByProps({ "data-testid": "exam-entry-sheet" }).length, 0);

      await act(async () => harness.renderer.root.findByProps({ "data-editor-section-id": contract.sectionId }).props.onClick());
      await act(async () => {
        harness.renderer.root.findByType(contract.component).props.onSaved({ completed: true });
        await flushEffects();
        await flushEffects();
      });
      assert.equal(harness.renderer.root.findAllByProps({ "data-testid": "exam-entry-sheet" }).length, 0);
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
    assert.equal(harness.renderer.root.findAllByProps({ "data-testid": "exam-entry-sheet" }).length, 0);
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
    assert.equal(harness.renderer.root.findByType(ExamEntrySheet).props.active, false);
    assert.equal(harness.renderer.root.findAllByType(AssessmentSection).length, 1);

    await act(async () => harness.renderer.root.findByType(ReferralCompose).props.onClose());

    assert.equal(harness.renderer.root.findAllByType(ReferralCompose).length, 0);
    assert.equal(harness.renderer.root.findByType(ExamEntrySheet).props.active, true);
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
  fhir.read = (async (_resourceType: string, id: string) => ({
    resourceType: "Encounter",
    id,
    status: "in-progress",
    class: { code: "AMB" },
    subject: { reference: "Patient/patient-1" },
    ...(options.discipline
      ? { serviceType: { coding: [{ system: ODOS_DISCIPLINE_SYSTEM, code: options.discipline }] } }
      : {}),
  })) as typeof fhir.read;
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
