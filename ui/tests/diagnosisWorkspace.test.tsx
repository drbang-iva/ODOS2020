import assert from "node:assert/strict";
import { test } from "node:test";
import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import {
  loadDiagnosisImagingOpen,
  loadEncounterChartView,
  saveDiagnosisImagingOpen,
  saveEncounterChartView,
} from "../src/lib/diagnosis-workspace-preferences";
import type { Condition, Encounter } from "@medplum/fhirtypes";
import {
  conditionMatchesDiagnosisPick,
  DiagnosisWorkspace,
  diagnosisCatalogKey,
  diagnosisPinMoveDisabled,
  diagnosisRankActionsDisabled,
  diagnosisWorkspaceInstanceKey,
  movePinnedDiagnosis,
  orderedEncounterConditions,
} from "../src/components/charting/DiagnosisWorkspace";
import { OdosSearchPicker } from "../src/components/inputs/OdosSearchPicker";
import { DiagnosisImagingRegion } from "../src/components/charting/DiagnosisImagingRegion";
import {
  DiagnosisFindingsTable,
  UnassignedFindingsTray,
} from "../src/components/charting/DiagnosisFindingsTable";
import {
  orderedFindingRows,
  orderedFindingSearchRows,
  type DiagnosisFindingMutation,
  type DiagnosisFindingsPayload,
} from "../src/lib/diagnosis-findings";

test("diagnosis workspace preferences default safely and round-trip valid selections", () => {
  const storage = memoryStorage();

  assert.equal(loadEncounterChartView(storage), "diagnosis");
  assert.equal(loadDiagnosisImagingOpen(storage), true);

  saveEncounterChartView("structure", storage);
  saveDiagnosisImagingOpen(false, storage);
  assert.equal(loadEncounterChartView(storage), "structure");
  assert.equal(loadDiagnosisImagingOpen(storage), false);

  storage.setItem("odos:encounter-chart-view", "future-view");
  storage.setItem("odos:diagnosis-imaging-open", "maybe");
  assert.equal(loadEncounterChartView(storage), "diagnosis");
  assert.equal(loadDiagnosisImagingOpen(storage), true);
});

test("diagnosis rail follows Encounter.diagnosis rank order without normalizing gaps", () => {
  const conditions = [condition("second", "Second"), condition("first", "First"), condition("unlinked", "Unlinked")];
  const encounter = {
    resourceType: "Encounter",
    status: "in-progress",
    class: { system: "http://terminology.hl7.org/CodeSystem/v3-ActCode", code: "AMB" },
    diagnosis: [
      { condition: { reference: "Condition/second" }, rank: 8 },
      { condition: { reference: "Condition/first" }, rank: 3 },
    ],
  } satisfies Encounter;

  assert.deepEqual(orderedEncounterConditions(encounter, conditions).map((row) => row.id), ["first", "second"]);
  assert.deepEqual(encounter.diagnosis?.map((row) => row.rank), [8, 3]);
});

test("catalog identity and pin reorder are explicit and stable", () => {
  const row = condition("c1", "Presbyopia");
  row.identifier = [{
    system: "https://odos2020.com/fhir/NamingSystem/diagnosis-catalog-stable-key",
    value: "encounter-1::presbyopia::none",
  }];

  assert.equal(diagnosisCatalogKey(row), "presbyopia");
  assert.deepEqual(movePinnedDiagnosis(["myopia", "presbyopia", "hyperopia"], "presbyopia", -1), [
    "presbyopia", "myopia", "hyperopia",
  ]);
  assert.deepEqual(movePinnedDiagnosis(["myopia"], "myopia", -1), ["myopia"]);
});

test("laterality-required diagnosis identity keeps OD, OS, and OU picks distinct", () => {
  const existingOs = condition("c1", "Myopia");
  existingOs.identifier = [{
    system: "https://odos2020.com/fhir/NamingSystem/diagnosis-catalog-stable-key",
    value: "encounter-1::myopia::left",
  }];
  const row = {
    stableKey: "myopia",
    display: "Myopia",
    lateralityRequired: true,
    pinned: false,
    tallyCount: 0,
  };

  assert.equal(conditionMatchesDiagnosisPick(existingOs, row, "OS"), true);
  assert.equal(conditionMatchesDiagnosisPick(existingOs, row, "OD"), false);
  assert.equal(conditionMatchesDiagnosisPick(existingOs, row, "OU"), false);
  assert.equal(conditionMatchesDiagnosisPick(existingOs, row), false);
});

test("diagnosis workspace remount identity changes at either patient or encounter boundary", () => {
  assert.notEqual(
    diagnosisWorkspaceInstanceKey("Patient/one", "Encounter/one"),
    diagnosisWorkspaceInstanceKey("Patient/two", "Encounter/one"),
  );
  assert.notEqual(
    diagnosisWorkspaceInstanceKey("Patient/one", "Encounter/one"),
    diagnosisWorkspaceInstanceKey("Patient/one", "Encounter/two"),
  );
});

test("diagnosis rank actions are disabled for read-only users and while a write is busy", () => {
  assert.equal(diagnosisRankActionsDisabled(false, undefined), true);
  assert.equal(diagnosisRankActionsDisabled(false, "rank"), true);
  assert.equal(diagnosisRankActionsDisabled(true, "rank"), true);
  assert.equal(diagnosisRankActionsDisabled(true, undefined), false);
});

test("diagnosis pin moves require write access and respect the ordered-list edges", () => {
  assert.equal(diagnosisPinMoveDisabled(false, undefined, 1, 3, -1), true);
  assert.equal(diagnosisPinMoveDisabled(false, undefined, 1, 3, 1), true);
  assert.equal(diagnosisPinMoveDisabled(true, undefined, 1, 3, -1), false);
  assert.equal(diagnosisPinMoveDisabled(true, undefined, 1, 3, 1), false);
  assert.equal(diagnosisPinMoveDisabled(true, undefined, 0, 3, -1), true);
  assert.equal(diagnosisPinMoveDisabled(true, undefined, 2, 3, 1), true);
});

test("Find dx searches the eligible catalog beyond bounded Common diagnoses", async () => {
  const originalFetch = globalThis.fetch;
  const common = diagnosisRow("myopia", "Myopia");
  const catalogOnly = diagnosisRow("pseudophakia", "Pseudophakia");
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    if (url.includes("/fhir/R4/Encounter/e1")) {
      return jsonResponse({
        resourceType: "Encounter",
        id: "e1",
        status: "in-progress",
        class: { code: "AMB" },
        diagnosis: [],
      });
    }
    if (url.includes("/clinical-graph/diagnosis-quick-list")) {
      return jsonResponse({
        canWrite: true,
        pinnedDiagnosisKeys: [],
        diagnoses: [common],
        catalog: [common, catalogOnly],
      });
    }
    if (url.includes("/clinical-graph/encounters/e1/findings")) {
      return jsonResponse({ canWrite: true, findings: [], catalog: [], unassigned: [], bySection: {}, visitDiagnoses: [] });
    }
    if (url.includes("/clinical-graph/encounters/e1/previous-exams")) {
      return jsonResponse({ pageSize: 4, encounters: [] });
    }
    if (url.includes("/clinical-graph/imaging")) return jsonResponse({ images: [] });
    throw new Error(`Unexpected request: ${url}`);
  }) as typeof fetch;

  let renderer!: ReactTestRenderer;
  try {
    await act(async () => {
      renderer = create(
        <DiagnosisWorkspace
          patientReference="Patient/p1"
          encounterReference="Encounter/e1"
          onSelectDiagnosis={() => undefined}
        />,
      );
      await Promise.resolve();
    });
    const results = await renderer.root.findByType(OdosSearchPicker).props.search(
      "pseudo",
      new AbortController().signal,
    );
    assert.deepEqual(results.map((row: { value: string }) => row.value), ["pseudophakia"]);
  } finally {
    act(() => renderer?.unmount());
    globalThis.fetch = originalFetch;
  }
});

test("selected diagnosis fails closed to edited when carry integrity is uncertain", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    if (url.includes("/fhir/R4/Encounter/e1")) {
      return jsonResponse({
        resourceType: "Encounter",
        id: "e1",
        status: "in-progress",
        class: { code: "AMB" },
        diagnosis: [{ condition: { reference: "Condition/selected" }, rank: 1 }],
      });
    }
    if (url.includes("/fhir/R4/Condition/selected")) return jsonResponse(condition("selected", "Dry eye syndrome"));
    if (url.includes("/clinical-graph/diagnosis-quick-list")) {
      return jsonResponse({ canWrite: true, pinnedDiagnosisKeys: [], diagnoses: [], catalog: [] });
    }
    if (url.includes("/clinical-graph/encounters/e1/findings")) {
      return jsonResponse({
        canWrite: true,
        carryProvenance: {
          pulledFromDate: "2026-08-01",
          unchangedSinceDate: "2026-06-15",
          edited: false,
          integrityWarning: "Diagnosis carry provenance cycle detected.",
        },
        findings: [],
        catalog: [],
        unassigned: [],
        bySection: {},
        visitDiagnoses: [{ conditionReference: "Condition/selected", diagnosisKey: "dry-eye", display: "Dry eye syndrome", laterality: "OU" }],
      });
    }
    if (url.includes("/clinical-graph/encounters/e1/previous-exams")) return jsonResponse({ pageSize: 4, encounters: [] });
    if (url.includes("/clinical-graph/imaging")) return jsonResponse({ images: [] });
    throw new Error(`Unexpected request: ${url}`);
  }) as typeof fetch;
  let renderer!: ReactTestRenderer;
  try {
    await act(async () => {
      renderer = create(
        <DiagnosisWorkspace
          patientReference="Patient/p1"
          encounterReference="Encounter/e1"
          selectedReference="Condition/selected"
          onSelectDiagnosis={() => undefined}
        />,
      );
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    const carry = renderer.root.findByProps({ className: "odos-diagnosis-carry-state is-edited" });
    const carryLines = carry.findAllByType("p").map((node) => node.children.join(""));
    assert.deepEqual(carryLines, [
      "pulled from Aug 1, 2026 · edited",
      "Diagnosis carry provenance cycle detected.",
    ]);
    assert.ok(renderer.root.findAllByProps({ role: "alert" }).some((node) => node.children.join("").includes("cycle detected")));
  } finally {
    act(() => renderer?.unmount());
    globalThis.fetch = originalFetch;
  }
});

test("edited diagnosis carry is named distinctly without unchanged aging", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    if (url.includes("/fhir/R4/Encounter/e1")) {
      return jsonResponse({ resourceType: "Encounter", id: "e1", status: "in-progress", class: { code: "AMB" }, diagnosis: [{ condition: { reference: "Condition/selected" }, rank: 1 }] });
    }
    if (url.includes("/fhir/R4/Condition/selected")) return jsonResponse(condition("selected", "Dry eye syndrome"));
    if (url.includes("/clinical-graph/diagnosis-quick-list")) return jsonResponse({ canWrite: true, pinnedDiagnosisKeys: [], diagnoses: [], catalog: [] });
    if (url.includes("/clinical-graph/encounters/e1/findings")) return jsonResponse({ canWrite: true, carryProvenance: { pulledFromDate: "2026-08-01", unchangedSinceDate: "2026-06-15", edited: true }, findings: [], catalog: [], unassigned: [], bySection: {}, visitDiagnoses: [] });
    if (url.includes("/clinical-graph/encounters/e1/previous-exams")) return jsonResponse({ pageSize: 4, encounters: [] });
    if (url.includes("/clinical-graph/imaging")) return jsonResponse({ images: [] });
    throw new Error(`Unexpected request: ${url}`);
  }) as typeof fetch;
  let renderer!: ReactTestRenderer;
  try {
    await act(async () => {
      renderer = create(<DiagnosisWorkspace patientReference="Patient/p1" encounterReference="Encounter/e1" selectedReference="Condition/selected" onSelectDiagnosis={() => undefined} />);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    const carry = renderer.root.findByProps({ className: "odos-diagnosis-carry-state is-edited" });
    assert.deepEqual(carry.findAllByType("p").map((node) => node.children.join("")), [
      "pulled from Aug 1, 2026 · edited",
    ]);
  } finally {
    act(() => renderer?.unmount());
    globalThis.fetch = originalFetch;
  }
});

test("ordinary unedited carry renders the immediate source and oldest unchanged exam", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = workspaceRaceFetch({
    findings: async (conditionReference) => jsonResponse(conditionReference === "Condition/a"
      ? raceFindingsPayload("Condition/a", "A finding", "2026-08-01", "2026-05-01")
      : raceFindingsPayload("Condition/b", "B finding", "2026-07-01")),
    previousExams: {
      pageSize: 4,
      encounters: [
        { encounterReference: "Encounter/prior-1", date: "2026-08-01", visitType: "Medical", diagnoses: [] },
        { encounterReference: "Encounter/prior-2", date: "2026-07-01", visitType: "Follow-up", diagnoses: [] },
        { encounterReference: "Encounter/prior-3", date: "2026-05-01", visitType: "Annual", diagnoses: [] },
      ],
    },
  });
  let renderer!: ReactTestRenderer;
  try {
    await act(async () => {
      renderer = create(<DiagnosisWorkspace patientReference="Patient/p1" encounterReference="Encounter/e1" selectedReference="Condition/a" onSelectDiagnosis={() => undefined} />);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    const carry = renderer.root.findByProps({ className: "odos-diagnosis-carry-state is-unedited" });
    assert.deepEqual(carry.findAllByType("p").map((node) => node.children.join("")), [
      "pulled from Aug 1, 2026 · unedited",
      "unchanged since May 1, 2026",
    ]);
    assert.equal(renderer.root.findAll((node) => typeof node.props["data-encounter-reference"] === "string").length, 3);
  } finally {
    act(() => renderer?.unmount());
    globalThis.fetch = originalFetch;
  }
});

test("switching diagnoses hides the prior findings payload while the new request is pending", async () => {
  const originalFetch = globalThis.fetch;
  const pendingB = deferred<Response>();
  globalThis.fetch = workspaceRaceFetch({
    findings: async (conditionReference) => conditionReference === "Condition/a"
      ? jsonResponse(raceFindingsPayload("Condition/a", "A finding", "2026-08-01"))
      : pendingB.promise,
  });
  let renderer!: ReactTestRenderer;
  try {
    await act(async () => {
      renderer = create(<DiagnosisWorkspace patientReference="Patient/p1" encounterReference="Encounter/e1" selectedReference="Condition/a" onSelectDiagnosis={() => undefined} />);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    assert.match(JSON.stringify(renderer.toJSON()), /A finding/);

    await act(async () => {
      renderer.update(<DiagnosisWorkspace patientReference="Patient/p1" encounterReference="Encounter/e1" selectedReference="Condition/b" onSelectDiagnosis={() => undefined} />);
      await Promise.resolve();
    });
    const pending = JSON.stringify(renderer.toJSON());
    assert.doesNotMatch(pending, /A finding|pulled from Aug 1, 2026/);
    assert.match(pending, /Loading findings/);

    await act(async () => {
      pendingB.resolve(jsonResponse(raceFindingsPayload("Condition/b", "B finding", "2026-07-01")));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  } finally {
    act(() => renderer?.unmount());
    globalThis.fetch = originalFetch;
  }
});

test("an older findings response cannot overwrite the newer selected diagnosis", async () => {
  const originalFetch = globalThis.fetch;
  const pendingA = deferred<Response>();
  const pendingB = deferred<Response>();
  globalThis.fetch = workspaceRaceFetch({
    findings: async (conditionReference) => conditionReference === "Condition/a" ? pendingA.promise : pendingB.promise,
  });
  let renderer!: ReactTestRenderer;
  try {
    await act(async () => {
      renderer = create(<DiagnosisWorkspace patientReference="Patient/p1" encounterReference="Encounter/e1" selectedReference="Condition/a" onSelectDiagnosis={() => undefined} />);
      await Promise.resolve();
      renderer.update(<DiagnosisWorkspace patientReference="Patient/p1" encounterReference="Encounter/e1" selectedReference="Condition/b" onSelectDiagnosis={() => undefined} />);
      await Promise.resolve();
    });
    await act(async () => {
      pendingB.resolve(jsonResponse(raceFindingsPayload("Condition/b", "B finding", "2026-07-01")));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    assert.match(JSON.stringify(renderer.toJSON()), /B finding/);

    await act(async () => {
      pendingA.resolve(jsonResponse(raceFindingsPayload("Condition/a", "A finding", "2026-08-01")));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    const final = JSON.stringify(renderer.toJSON());
    assert.match(final, /B finding/);
    assert.doesNotMatch(final, /A finding/);
    assert.doesNotMatch(final, /pulled from Aug 1, 2026/);
    const carry = renderer.root.findByProps({ className: "odos-diagnosis-carry-state is-unedited" });
    assert.deepEqual(carry.findAllByType("p").map((node) => node.children.join("")), [
      "pulled from Jul 1, 2026 · unedited",
    ]);
  } finally {
    act(() => renderer?.unmount());
    globalThis.fetch = originalFetch;
  }
});

test("finding rows sort charted before offered and search prioritizes selected-diagnosis candidates", () => {
  const payload = findingsPayload();

  assert.deepEqual(
    orderedFindingRows(payload.findings).map((row) => row.display),
    ["Absent finding", "Charted finding", "Offered finding"],
  );
  assert.deepEqual(
    orderedFindingSearchRows(payload.catalog, "dx-selected").map((row) => row.display),
    ["Offered finding", "Charted finding", "Absent finding", "General catalog finding"],
  );
});

test("findings table keeps presence explicit, grade unanswered, laterality source visible, and re-click clears", () => {
  const mutations: DiagnosisFindingMutation[] = [];
  const renderer = create(
    <DiagnosisFindingsTable
      payload={findingsPayload()}
      patientReference="Patient/p1"
      conditionReference="Condition/selected"
      disabled={false}
      onMutate={(mutation) => { mutations.push(mutation); }}
    />,
  );
  const json = JSON.stringify(renderer.toJSON());

  assert.match(json, /Present/);
  assert.match(json, /Absent/);
  assert.match(json, /Not graded/);
  assert.match(json, /is-inherited/);
  assert.match(json, /is-explicit/);
  const offeredPresent = renderer.root.findByProps({ "aria-label": "Record Offered finding present" });
  const offeredAbsent = renderer.root.findByProps({ "aria-label": "Record Offered finding absent" });
  const flipAbsentToPresent = renderer.root.findByProps({ "aria-label": "Record Absent finding present" });
  const clearPresent = renderer.root.findByProps({ "aria-label": "Clear present Charted finding" });
  const clearAbsent = renderer.root.findByProps({ "aria-label": "Clear absent Absent finding" });
  act(() => offeredPresent.props.onClick());
  act(() => offeredAbsent.props.onClick());
  act(() => flipAbsentToPresent.props.onClick());
  act(() => clearPresent.props.onClick());
  act(() => clearAbsent.props.onClick());
  act(() => renderer.root.findByProps({ "aria-label": "Laterality Charted finding" }).props.onChange({
    target: { value: "OS" },
  }));

  assert.deepEqual(mutations, [
    {
      action: "assert",
      patientReference: "Patient/p1",
      conditionReference: "Condition/selected",
      atomicFindingId: "section::field::offered",
      presence: "present",
    },
    {
      action: "assert",
      patientReference: "Patient/p1",
      conditionReference: "Condition/selected",
      atomicFindingId: "section::field::offered",
      presence: "absent",
    },
    {
      action: "assert",
      patientReference: "Patient/p1",
      conditionReference: "Condition/selected",
      atomicFindingId: "section::field::absent",
      presence: "present",
      laterality: "OS",
    },
    {
      action: "clear",
      patientReference: "Patient/p1",
      observationReference: "Observation/charted",
    },
    {
      action: "clear",
      patientReference: "Patient/p1",
      observationReference: "Observation/absent",
    },
    {
      action: "laterality",
      patientReference: "Patient/p1",
      observationReference: "Observation/charted",
      laterality: "OS",
    },
  ]);
});

test("unassigned tray offers current visit assignment and standalone without diagnosis creation", () => {
  const mutations: DiagnosisFindingMutation[] = [];
  const payload = findingsPayload();
  const renderer = create(
    <UnassignedFindingsTray
      rows={[payload.unassigned[0]!]}
      visitDiagnoses={payload.visitDiagnoses}
      patientReference="Patient/p1"
      disabled={false}
      onMutate={(mutation) => { mutations.push(mutation); }}
    />,
  );
  const json = JSON.stringify(renderer.toJSON());

  assert.match(json, /Unassigned findings/);
  assert.match(json, /Assign to Selected diagnosis/);
  assert.match(json, /Record standalone/);
  assert.doesNotMatch(json, /Create diagnosis/);
  act(() => renderer.root.findByProps({ "aria-label": "Assign Unassigned finding to Selected diagnosis" }).props.onClick());
  act(() => renderer.root.findByProps({ "aria-label": "Record Unassigned finding standalone" }).props.onClick());
  assert.deepEqual(mutations, [
    {
      action: "assign",
      patientReference: "Patient/p1",
      observationReference: "Observation/unassigned",
      conditionReference: "Condition/selected",
    },
    {
      action: "standalone",
      patientReference: "Patient/p1",
      observationReference: "Observation/unassigned",
    },
  ]);

  const empty = create(
    <UnassignedFindingsTray
      rows={[]}
      visitDiagnoses={payload.visitDiagnoses}
      patientReference="Patient/p1"
      disabled={false}
      onMutate={() => undefined}
    />,
  );
  assert.equal(empty.toJSON(), null);
});

test("imaging hides the prior patient's rows as soon as the patient reference changes", async () => {
  const originalFetch = globalThis.fetch;
  let resolveFirst!: (response: Response) => void;
  globalThis.fetch = ((input: string | URL | Request) => {
    const url = String(input);
    if (url.includes("Patient%2Fone")) {
      return new Promise<Response>((resolve) => { resolveFirst = resolve; });
    }
    return new Promise<Response>(() => undefined);
  }) as typeof fetch;
  let renderer!: ReactTestRenderer;
  try {
    await act(async () => {
      renderer = create(<DiagnosisImagingRegion patientReference="Patient/one" />);
    });
    await act(async () => {
      resolveFirst(new Response(JSON.stringify({ images: [{
        id: "old-image",
        title: "Prior patient OCT",
        date: "2026-08-09",
        contentState: "missing",
      }] }), { status: 200, headers: { "Content-Type": "application/json" } }));
      await Promise.resolve();
    });
    assert.match(JSON.stringify(renderer.toJSON()), /Prior patient OCT/);

    act(() => renderer.update(<DiagnosisImagingRegion patientReference="Patient/two" />));
    assert.doesNotMatch(JSON.stringify(renderer.toJSON()), /Prior patient OCT/);
  } finally {
    act(() => renderer?.unmount());
    globalThis.fetch = originalFetch;
  }
});

function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() { return values.size; },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => { values.delete(key); },
    setItem: (key, value) => { values.set(key, value); },
  };
}

function condition(id: string, display: string): Condition {
  return {
    resourceType: "Condition",
    id,
    subject: { reference: "Patient/p1" },
    code: { text: display },
  };
}

function diagnosisRow(stableKey: string, display: string) {
  return {
    stableKey,
    display,
    lateralityRequired: false,
    pinned: false,
    tallyCount: 0,
  };
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => { resolve = next; });
  return { promise, resolve };
}

function workspaceRaceFetch({
  findings,
  previousExams = { pageSize: 4, encounters: [] },
}: {
  findings: (conditionReference: string) => Promise<Response>;
  previousExams?: unknown;
}): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = String(input);
    if (url.includes("/fhir/R4/Encounter/e1")) {
      return jsonResponse({
        resourceType: "Encounter",
        id: "e1",
        status: "in-progress",
        class: { code: "AMB" },
        diagnosis: [
          { condition: { reference: "Condition/a" }, rank: 1 },
          { condition: { reference: "Condition/b" }, rank: 2 },
        ],
      });
    }
    if (url.includes("/fhir/R4/Condition/a")) return jsonResponse(condition("a", "Diagnosis A"));
    if (url.includes("/fhir/R4/Condition/b")) return jsonResponse(condition("b", "Diagnosis B"));
    if (url.includes("/clinical-graph/diagnosis-quick-list")) return jsonResponse({ canWrite: true, pinnedDiagnosisKeys: [], diagnoses: [], catalog: [] });
    if (url.includes("/clinical-graph/encounters/e1/findings")) {
      const conditionReference = new URL(url, "http://localhost").searchParams.get("condition") ?? "";
      return findings(conditionReference);
    }
    if (url.includes("/clinical-graph/encounters/e1/previous-exams")) return jsonResponse(previousExams);
    if (url.includes("/clinical-graph/imaging")) return jsonResponse({ images: [] });
    throw new Error(`Unexpected request: ${url}`);
  }) as typeof fetch;
}

function raceFindingsPayload(
  conditionReference: string,
  findingDisplay: string,
  pulledFromDate: string,
  unchangedSinceDate?: string,
): DiagnosisFindingsPayload {
  const row = {
    findingDefinitionId: "definition",
    findingDefinitionKey: "section",
    fieldCode: "field",
    sectionKey: "lens",
    gradeScale: [] as string[],
    diagnosisKeys: [conditionReference],
    origin: "shipped" as const,
    atomicFindingId: `section::field::${conditionReference}`,
    optionCode: conditionReference,
    display: findingDisplay,
    laterality: "OU" as const,
    lateralitySource: "inherited" as const,
    source: "atomic" as const,
    presence: "present" as const,
    observationReference: `Observation/${conditionReference.replace("Condition/", "")}`,
    conditionReference,
  };
  return {
    canWrite: true,
    carryProvenance: { pulledFromDate, ...(unchangedSinceDate ? { unchangedSinceDate } : {}), edited: false },
    findings: [row],
    catalog: [],
    unassigned: [],
    bySection: { lens: [row] },
    visitDiagnoses: [],
  };
}

function findingsPayload(): DiagnosisFindingsPayload {
  const base = {
    findingDefinitionId: "definition",
    findingDefinitionKey: "section",
    fieldCode: "field",
    sectionKey: "lens",
    gradeScale: [] as string[],
    origin: "shipped" as const,
  };
  const offered = {
    ...base,
    atomicFindingId: "section::field::offered",
    optionCode: "offered",
    display: "Offered finding",
    diagnosisKeys: ["dx-selected"],
    laterality: "OD" as const,
    lateralitySource: "inherited" as const,
    source: "offered" as const,
  };
  const charted = {
    ...base,
    atomicFindingId: "section::field::charted",
    optionCode: "charted",
    display: "Charted finding",
    gradeScale: ["1+", "2+"],
    diagnosisKeys: ["dx-selected"],
    laterality: "OD" as const,
    lateralitySource: "inherited" as const,
    source: "atomic" as const,
    presence: "present" as const,
    observationReference: "Observation/charted",
    conditionReference: "Condition/selected",
  };
  const absent = {
    ...base,
    atomicFindingId: "section::field::absent",
    optionCode: "absent",
    display: "Absent finding",
    diagnosisKeys: [],
    laterality: "OS" as const,
    lateralitySource: "explicit" as const,
    source: "atomic" as const,
    presence: "absent" as const,
    observationReference: "Observation/absent",
    conditionReference: "Condition/selected",
  };
  const unassigned = {
    ...base,
    atomicFindingId: "section::field::unassigned",
    optionCode: "unassigned",
    display: "Unassigned finding",
    diagnosisKeys: [],
    laterality: "OU" as const,
    lateralitySource: "explicit" as const,
    source: "section" as const,
    presence: "present" as const,
    observationReference: "Observation/unassigned",
  };
  return {
    canWrite: true,
    diagnosis: {
      id: "diagnosis-dx-selected",
      stableKey: "dx-selected",
      display: "Selected diagnosis",
      applicableFindingDefinitionIds: ["definition"],
    },
    findings: [offered, charted, absent],
    catalog: [
      { ...offered, source: undefined, laterality: undefined, lateralitySource: undefined },
      { ...charted, source: undefined, laterality: undefined, lateralitySource: undefined, presence: undefined, observationReference: undefined, conditionReference: undefined },
      { ...absent, source: undefined, laterality: undefined, lateralitySource: undefined, presence: undefined, observationReference: undefined, conditionReference: undefined },
      {
        ...base,
        atomicFindingId: "section::field::general",
        optionCode: "general",
        display: "General catalog finding",
        diagnosisKeys: [],
      },
    ],
    unassigned: [unassigned],
    bySection: { lens: [charted, absent, unassigned] },
    visitDiagnoses: [{
      conditionReference: "Condition/selected",
      diagnosisKey: "dx-selected",
      display: "Selected diagnosis",
      laterality: "OD",
    }],
  };
}
