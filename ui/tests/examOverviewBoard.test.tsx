import assert from "node:assert/strict";
import { test } from "node:test";
import React from "react";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import type { ExamOverviewProjection } from "../../mcp/src/clinical-graph/exam-overview-projection";
import { DiagnosisWorkspace } from "../src/components/charting/DiagnosisWorkspace";
import { SpineNav } from "../src/components/charting/SpineNav";
import { fhir } from "../src/lib/fhir";
import { RoleProvider } from "../src/lib/role-context";
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

test("structure view renders all projected sections and keeps every clinical state channel independent", async () => {
  const harness = await renderEncounter(PROJECTION);
  try {
    const sections = harness.renderer.root.findAllByProps({ "data-testid": "exam-overview-section" });
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

test("completeness footer opens a traceable section account and disclaims billing-code meaning", async () => {
  const harness = await renderEncounter(PROJECTION);
  try {
    const trigger = harness.renderer.root.findByProps({ "data-testid": "exam-completeness-trigger" });
    assert.equal(textContent(trigger), "Exam sections: 1 of 2");
    assert.equal(trigger.props["aria-expanded"], false);
    assert.equal(harness.renderer.root.findAllByProps({ id: "exam-completeness-trace" }).length, 0);

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

async function renderEncounter(projection: ExamOverviewProjection): Promise<{
  renderer: ReactTestRenderer;
  restore: () => void;
}> {
  const originalFetch = globalThis.fetch;
  const originalRead = fhir.read;
  const originalDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
  fhir.read = (async (_resourceType: string, id: string) => ({
    resourceType: "Encounter",
    id,
    status: "in-progress",
    class: { code: "AMB" },
    subject: { reference: "Patient/patient-1" },
  })) as typeof fhir.read;
  globalThis.fetch = (async (input) => {
    const url = String(input);
    if (url.endsWith("/clinical-graph/encounters/exam-1/exam-overview")) {
      return jsonResponse(projection);
    }
    if (url.includes("/clinical-graph/finding-definitions")) {
      return jsonResponse({ canWrite: false, definitions: [] });
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
    if (url.includes("/clinical-graph/diagnosis-quick-list")) {
      return jsonResponse({
        canWrite: false,
        pinnedDiagnosisKeys: [],
        diagnoses: [],
        catalog: [],
      });
    }
    if (url.includes("/clinical-graph/encounters/exam-1/findings")) {
      return jsonResponse({
        canWrite: false,
        findings: [],
        catalog: [],
        unassigned: [],
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
    } as unknown as Document,
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
    restore: () => {
      act(() => renderer.unmount());
      fhir.read = originalRead;
      globalThis.fetch = originalFetch;
      if (originalDocument) Object.defineProperty(globalThis, "document", originalDocument);
      else delete (globalThis as { document?: Document }).document;
    },
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
