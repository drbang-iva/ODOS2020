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
  diagnosisSearchOptions,
  diagnosisPinMoveDisabled,
  diagnosisRankActionsDisabled,
  diagnosisWorkspaceInstanceKey,
  movePinnedDiagnosis,
  mostRecentPriorStage,
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
import { conditionResolvedCodeLabel } from "../src/lib/diagnosis-code-resolution";

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

test("workspace keeps one-click Make Principal on the complete reorder endpoint and opens grouped reorder rows", async () => {
  const originalFetch = globalThis.fetch;
  const requests: Array<{ url: string; body?: unknown }> = [];
  const fallback = workspaceRaceFetch({
    findings: async (reference) => jsonResponse(raceFindingsPayload(reference, "Finding", "2026-08-01")),
  });
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("/procedure-charges")) {
      return jsonResponse({
        options: [],
        diagnoses: [],
        proposals: [],
        attachedProcedures: [{
          proposalId: "proposal-a",
          procedureConceptKey: "procedure-a",
          display: "Procedure attached to A",
          diagnosisReferences: ["Condition/a"],
        }],
      });
    }
    if (url.includes("/clinical-graph/encounters/e1/diagnosis-order")) {
      requests.push({ url, body: JSON.parse(String(init?.body)) });
      return jsonResponse({
        encounter: {
          resourceType: "Encounter",
          id: "e1",
          status: "in-progress",
          class: { code: "AMB" },
          diagnosis: [
            { condition: { reference: "Condition/a" }, rank: 2 },
            { condition: { reference: "Condition/b" }, rank: 1 },
          ],
        },
      });
    }
    return fallback(input, init);
  }) as typeof fetch;

  let renderer!: ReactTestRenderer;
  try {
    await act(async () => {
      renderer = create(
        <DiagnosisWorkspace
          patientReference="Patient/p1"
          encounterReference="Encounter/e1"
          selectedReference="Condition/b"
          onSelectDiagnosis={() => undefined}
        />,
      );
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    act(() => renderer.root.findByProps({ children: "Reorder Impressions" }).props.onClick());
    assert.match(JSON.stringify(renderer.toJSON()), /Procedure attached to A/);
    act(() => renderer.root.findByProps({ children: "Cancel" }).props.onClick());

    await act(async () => {
      await renderer.root.findByProps({ children: "Make Principal" }).props.onClick();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    assert.deepEqual(requests, [{
      url: "/clinical-graph/encounters/e1/diagnosis-order",
      body: { conditionReferences: ["Condition/b", "Condition/a"] },
    }]);
  } finally {
    act(() => renderer?.unmount());
    globalThis.fetch = originalFetch;
  }
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

test("staged family search resolves an explicit member statement without exposing member rows", () => {
  const family = stagedFamilyRow();
  const explicit = diagnosisSearchOptions([family], "poag severe");
  assert.equal(explicit.length, 1);
  assert.equal(explicit[0]?.value, "primary-open-angle-glaucoma");
  assert.equal(explicit[0]?.label, "Primary open-angle glaucoma");
  assert.equal(explicit[0]?.description, "Stage: Severe");
  assert.equal(explicit[0]?.item.selectedMemberKey, "poag_severe");
  assert.equal(explicit[0]?.item.stageSelectionSource, "search");
  assert.deepEqual(diagnosisSearchOptions([family], "primary open angle").map((row) => row.value), [
    "primary-open-angle-glaucoma",
  ]);
});

test("staged family add uses segmented Stage then Scope and never offers unspecified", async () => {
  const originalFetch = globalThis.fetch;
  const family = stagedFamilyRow();
  globalThis.fetch = stagedWorkspaceFetch(family);
  let renderer!: ReactTestRenderer;
  try {
    await act(async () => {
      renderer = create(<DiagnosisWorkspace patientReference="Patient/p1" encounterReference="Encounter/e1" onSelectDiagnosis={() => undefined} />);
      await Promise.resolve();
    });
    const familyButton = renderer.root.findAllByType("button").find((button) =>
      button.findAllByType("span").some((span) => span.children.includes("Primary open-angle glaucoma"))
    );
    assert.ok(familyButton);
    await act(async () => {
      familyButton.props.onClick();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    const stage = renderer.root.findByProps({ ariaLabel: "Stage for Primary open-angle glaucoma" });
    const scope = renderer.root.findByProps({ ariaLabel: "Scope for Primary open-angle glaucoma" });
    assert.deepEqual(stage.props.options.map((option: { label: string }) => option.label), ["Mild", "Moderate", "Severe", "Indeterminate"]);
    assert.equal(scope.props.disabled, true);
    assert.doesNotMatch(JSON.stringify(renderer.toJSON()), /unspecified/i);
    assert.equal(renderer.root.findByProps({ className: "odos-diagnosis-stage-prior" }).children.join(""), "was Moderate · 2026-03-14");

    act(() => stage.props.onChange(["poag_mild"]));
    assert.equal(renderer.root.findByProps({ ariaLabel: "Scope for Primary open-angle glaucoma" }).props.disabled, false);
  } finally {
    act(() => renderer?.unmount());
    globalThis.fetch = originalFetch;
  }
});

test("explicit stage search asks scope only and pending staged codes use the warning label", async () => {
  const originalFetch = globalThis.fetch;
  const family = stagedFamilyRow();
  globalThis.fetch = stagedWorkspaceFetch(family);
  let renderer!: ReactTestRenderer;
  try {
    await act(async () => {
      renderer = create(<DiagnosisWorkspace patientReference="Patient/p1" encounterReference="Encounter/e1" onSelectDiagnosis={() => undefined} />);
      await Promise.resolve();
    });
    const picker = renderer.root.findByType(OdosSearchPicker);
    const [option] = await picker.props.search("poag severe", new AbortController().signal);
    act(() => picker.props.onSelect(option));
    const add = renderer.root.findAllByType("button").find((button) => button.children.includes("Add to this visit"));
    assert.ok(add);
    act(() => add.props.onClick());
    assert.equal(renderer.root.findAllByProps({ ariaLabel: "Stage for Primary open-angle glaucoma" }).length, 0);
    assert.equal(renderer.root.findByProps({ ariaLabel: "Scope for Primary open-angle glaucoma" }).props.disabled, false);
  } finally {
    act(() => renderer?.unmount());
    globalThis.fetch = originalFetch;
  }

  const pending = condition("pending", "Primary open-angle glaucoma");
  pending.identifier = [{
    system: "https://odos2020.com/fhir/NamingSystem/diagnosis-catalog-stable-key",
    value: "e1::primary-open-angle-glaucoma::right",
  }];
  assert.equal(conditionResolvedCodeLabel(pending, [family]), "Code pending — stage required");
});

test("selected pending family renders warning badges and re-stages from the header control", async () => {
  const originalFetch = globalThis.fetch;
  const family = stagedFamilyRow();
  const pending: Condition = {
    ...condition("pending", "Primary open-angle glaucoma"),
    meta: { versionId: "4" },
    bodySite: [{ text: "OD" }],
    identifier: [{
      system: "https://odos2020.com/fhir/NamingSystem/diagnosis-catalog-stable-key",
      value: "e1::primary-open-angle-glaucoma::right",
    }],
  };
  let currentCondition = pending;
  let patchOperations: Array<{ path: string; value?: unknown }> | undefined;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("/fhir/R4/Encounter/e1")) {
      return jsonResponse({ resourceType: "Encounter", id: "e1", status: "in-progress", class: { code: "AMB" }, diagnosis: [{ condition: { reference: "Condition/pending" }, rank: 1 }] });
    }
    if (url.endsWith("/fhir/R4/Condition/pending") && init?.method === "PATCH") {
      patchOperations = JSON.parse(String(init.body));
      currentCondition = {
        ...pending,
        meta: { versionId: "5" },
        code: patchOperations?.find((operation) => operation.path === "/code")?.value as Condition["code"],
        identifier: patchOperations?.find((operation) => operation.path === "/identifier")?.value as Condition["identifier"],
      };
      return jsonResponse(currentCondition);
    }
    if (url.endsWith("/fhir/R4/Condition/pending")) return jsonResponse(currentCondition);
    if (url.includes("/fhir/R4/Condition?")) {
      return jsonResponse({ resourceType: "Bundle", type: "searchset", entry: [{ resource: stagedCondition("prior", "poag_moderate", "2026-03-14T12:00:00.000Z") }] });
    }
    if (url.endsWith("/fhir/R4/Provenance") && init?.method === "POST") {
      return jsonResponse({ resourceType: "Provenance", id: "stage-provenance", target: [], recorded: "2026-08-11T12:00:00Z", agent: [] });
    }
    if (url.includes("/clinical-graph/diagnosis-quick-list")) return jsonResponse({ canWrite: true, pinnedDiagnosisKeys: [], diagnoses: [family], catalog: [family] });
    if (url.includes("/clinical-graph/encounters/e1/findings")) return jsonResponse({ canWrite: true, findings: [], catalog: [], unassigned: [], bySection: {}, visitDiagnoses: [] });
    if (url.includes("/clinical-graph/encounters/e1/previous-exams")) return jsonResponse({ pageSize: 4, encounters: [] });
    if (url.includes("/clinical-graph/imaging")) return jsonResponse({ images: [] });
    throw new Error(`Unexpected request: ${init?.method ?? "GET"} ${url}`);
  }) as typeof fetch;

  let renderer!: ReactTestRenderer;
  try {
    await act(async () => {
      renderer = create(<DiagnosisWorkspace patientReference="Patient/p1" encounterReference="Encounter/e1" selectedReference="Condition/pending" onSelectDiagnosis={() => undefined} />);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    assert.equal(renderer.root.findAllByProps({ role: "status" }).length, 2);
    const stage = renderer.root.findByProps({ ariaLabel: "Stage for Primary open-angle glaucoma" });
    assert.deepEqual(stage.props.selected, []);
    assert.equal(renderer.root.findByProps({ className: "odos-diagnosis-stage-prior" }).children.join(""), "was Moderate · 2026-03-14");
    await act(async () => {
      stage.props.onChange(["poag_mild"]);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    assert.deepEqual(patchOperations?.map((operation) => operation.path), ["/code", "/identifier"]);
    assert.equal((patchOperations?.[1]?.value as Array<{ value?: string }>)[0]?.value, "e1::poag_mild::right");
    assert.equal(renderer.root.findAllByProps({ role: "status" }).length, 0);
    assert.deepEqual(renderer.root.findByProps({ ariaLabel: "Stage for Primary open-angle glaucoma" }).props.selected, ["poag_mild"]);
  } finally {
    act(() => renderer?.unmount());
    globalThis.fetch = originalFetch;
  }
});

test("most recent prior stage is dated, excludes the selected Condition, and never supplies a default", () => {
  const family = stagedFamilyRow();
  const older = stagedCondition("older", "poag_mild", "2025-11-02T12:00:00.000Z");
  const prior = stagedCondition("prior", "poag_moderate", "2026-03-14T12:00:00.000Z");
  const selected = stagedCondition("selected", "poag_severe", "2026-08-11T12:00:00.000Z");
  assert.deepEqual(mostRecentPriorStage([older, prior, selected], family, "selected"), {
    stableKey: "poag_moderate",
    stageLabel: "Moderate",
    recordedAt: "2026-03-14T12:00:00.000Z",
  });
  assert.equal(mostRecentPriorStage([selected], family, "selected"), undefined);
});

test("bilateral eyelid diagnoses render both resolved codes while legacy unspecified-eyelid codes remain visible", async () => {
  const originalFetch = globalThis.fetch;
  const bilateral: Condition = {
    resourceType: "Condition",
    id: "mgd-ou",
    subject: { reference: "Patient/p1" },
    encounter: { reference: "Encounter/e1" },
    identifier: [{
      system: "https://odos2020.com/fhir/NamingSystem/diagnosis-catalog-stable-key",
      value: "e1::meibomian_gland_dysfunction::bilateral",
    }],
    code: {
      coding: [{
        system: "https://odos2020.com/fhir/CodeSystem/diagnosis-catalog",
        code: "meibomian_gland_dysfunction",
        display: "Meibomian gland dysfunction",
      }],
      text: "Meibomian gland dysfunction",
    },
    bodySite: [{ text: "OU" }],
  };
  const legacy: Condition = {
    resourceType: "Condition",
    id: "legacy-ulcerative",
    subject: { reference: "Patient/p1" },
    encounter: { reference: "Encounter/e1" },
    identifier: [{
      system: "https://odos2020.com/fhir/NamingSystem/diagnosis-catalog-stable-key",
      value: "e1::ulcerative_blepharitis::right",
    }],
    code: {
      coding: [{
        system: "http://hl7.org/fhir/sid/icd-10-cm",
        code: "H01.013",
        display: "Ulcerative blepharitis right eye, unspecified eyelid",
      }],
      text: "Ulcerative blepharitis right eye, unspecified eyelid",
    },
    bodySite: [{ text: "OD" }],
  };
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    if (url.includes("/fhir/R4/Encounter/e1")) {
      return jsonResponse({
        resourceType: "Encounter",
        id: "e1",
        status: "in-progress",
        class: { code: "AMB" },
        diagnosis: [
          { condition: { reference: "Condition/mgd-ou" }, rank: 1 },
          { condition: { reference: "Condition/legacy-ulcerative" }, rank: 2 },
        ],
      });
    }
    if (url.includes("/fhir/R4/Condition/mgd-ou")) return jsonResponse(bilateral);
    if (url.includes("/fhir/R4/Condition/legacy-ulcerative")) return jsonResponse(legacy);
    if (url.includes("/clinical-graph/diagnosis-quick-list")) {
      return jsonResponse({
        canWrite: true,
        pinnedDiagnosisKeys: [],
        diagnoses: [],
        catalog: [{
          stableKey: "meibomian_gland_dysfunction",
          display: "Meibomian gland dysfunction",
          lateralityRequired: true,
          bilateralResolution: "emit-both-eyes",
          icd10: { pattern: { right: "H02.88A", left: "H02.88B" } },
          pinned: false,
          tallyCount: 0,
        }, {
          stableKey: "ulcerative_blepharitis",
          display: "Ulcerative blepharitis",
          lateralityRequired: true,
          bilateralResolution: "emit-both-eyes",
          icd10: { pattern: { right: "H01.01A", left: "H01.01B" } },
          pinned: false,
          tallyCount: 0,
        }],
      });
    }
    if (url.includes("/clinical-graph/encounters/e1/findings")) return jsonResponse({ canWrite: true, findings: [], catalog: [], unassigned: [], bySection: {}, visitDiagnoses: [] });
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
          selectedReference="Condition/mgd-ou"
          onSelectDiagnosis={() => undefined}
        />,
      );
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    const rendered = JSON.stringify(renderer.toJSON());
    assert.match(rendered, /H02\.88A \+ H02\.88B/);
    assert.match(rendered, /H01\.013/);
    assert.doesNotMatch(rendered, /H01\.01A/);
    assert.doesNotMatch(rendered, /meibomian_gland_dysfunction/);
  } finally {
    act(() => renderer?.unmount());
    globalThis.fetch = originalFetch;
  }
});

test("eyelid laterality edit fails closed before FHIR writes when its declared catalog row is unavailable", async () => {
  const originalFetch = globalThis.fetch;
  let bodyStructureReads = 0;
  const condition: Condition = {
    resourceType: "Condition",
    id: "mgd-od",
    meta: { versionId: "1" },
    subject: { reference: "Patient/p1" },
    encounter: { reference: "Encounter/e1" },
    identifier: [{
      system: "https://odos2020.com/fhir/NamingSystem/diagnosis-catalog-stable-key",
      value: "e1::meibomian_gland_dysfunction::right",
    }],
    code: {
      coding: [{ system: "http://hl7.org/fhir/sid/icd-10-cm", code: "H02.88A", display: "Meibomian gland dysfunction" }],
      text: "Meibomian gland dysfunction",
    },
    bodySite: [{ text: "OD" }],
  };
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    if (url.includes("/fhir/R4/Encounter/e1")) {
      return jsonResponse({
        resourceType: "Encounter",
        id: "e1",
        status: "in-progress",
        class: { code: "AMB" },
        diagnosis: [{ condition: { reference: "Condition/mgd-od" }, rank: 1 }],
      });
    }
    if (url.includes("/fhir/R4/Condition/mgd-od")) return jsonResponse(condition);
    if (url.includes("/clinical-graph/diagnosis-quick-list")) {
      return jsonResponse({ canWrite: true, pinnedDiagnosisKeys: [], diagnoses: [], catalog: [] });
    }
    if (url.includes("/clinical-graph/encounters/e1/findings")) return jsonResponse({ canWrite: true, findings: [], catalog: [], unassigned: [], bySection: {}, visitDiagnoses: [] });
    if (url.includes("/clinical-graph/encounters/e1/previous-exams")) return jsonResponse({ pageSize: 4, encounters: [] });
    if (url.includes("/clinical-graph/imaging")) return jsonResponse({ images: [] });
    if (url.includes("/fhir/R4/BodyStructure?")) {
      bodyStructureReads += 1;
      throw new Error("FHIR write path was reached");
    }
    throw new Error(`Unexpected request: ${url}`);
  }) as typeof fetch;

  let renderer!: ReactTestRenderer;
  try {
    await act(async () => {
      renderer = create(
        <DiagnosisWorkspace
          patientReference="Patient/p1"
          encounterReference="Encounter/e1"
          selectedReference="Condition/mgd-od"
          onSelectDiagnosis={() => undefined}
        />,
      );
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    const ouButton = renderer.root.findAllByType("button").find((button) => button.children.includes("OU"));
    assert.ok(ouButton);
    await act(async () => {
      ouButton.props.onClick();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    assert.equal(bodyStructureReads, 0);
    assert.match(JSON.stringify(renderer.toJSON()), /catalog row is unavailable/);
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

test("a failed same-diagnosis verification refresh cannot retain stale carry assertions", async () => {
  const originalFetch = globalThis.fetch;
  const initial = raceFindingsPayload("Condition/selected", "Carried finding", "2026-08-01");
  initial.findings[0]!.carried = true;
  initial.bySection.lens![0]!.carried = true;
  let findingsReads = 0;
  let findingWrites = 0;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("/fhir/R4/Encounter/e1")) {
      return jsonResponse({ resourceType: "Encounter", id: "e1", status: "in-progress", class: { code: "AMB" }, diagnosis: [{ condition: { reference: "Condition/selected" }, rank: 1 }] });
    }
    if (url.includes("/fhir/R4/Condition/selected")) return jsonResponse(condition("selected", "Dry eye syndrome"));
    if (url.includes("/clinical-graph/diagnosis-quick-list")) return jsonResponse({ canWrite: true, pinnedDiagnosisKeys: [], diagnoses: [], catalog: [] });
    if (url.includes("/clinical-graph/encounters/e1/findings")) {
      if (init?.method === "PUT") {
        findingWrites += 1;
        return jsonResponse({});
      }
      findingsReads += 1;
      return findingsReads === 1
        ? jsonResponse(initial)
        : new Response(JSON.stringify({ error: "Finding verification failed." }), { status: 500, headers: { "Content-Type": "application/json" } });
    }
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
    const loaded = JSON.stringify(renderer.toJSON());
    assert.match(loaded, /Carried finding/);
    assert.match(loaded, /is-unedited/);
    assert.match(loaded, /odos-finding-carried/);

    await act(async () => {
      renderer.root.findByProps({ "aria-label": "Clear present Carried finding" }).props.onClick();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    const failedRefresh = JSON.stringify(renderer.toJSON());
    assert.equal(findingWrites, 1);
    assert.ok(renderer.root.findAllByProps({ role: "alert" }).some((node) => node.children.join("") === "Finding verification failed."));
    assert.doesNotMatch(failedRefresh, /Carried finding|is-unedited|carried/);
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

test("unassigned tray renders quiet equal-weight suggestions in endpoint order and delegates the clinician pick", () => {
  const payload = findingsPayload();
  const selected: string[] = [];
  const suggestions = [{
    diagnosisKey: "macular_drusen",
    display: "Macular drusen",
    priority: true,
    source: "mapping" as const,
  }, {
    familyGroup: "nonexudative-amd",
    clinicalFamily: "nonexudative-amd",
    display: "Nonexudative AMD",
    axisLabel: "Stage",
    members: [{ stableKey: "dry_amd_early", stageLabel: "Early" }],
    priority: true,
    source: "mapping" as const,
  }];
  const renderer = create(
    <UnassignedFindingsTray
      rows={[payload.unassigned[0]!]}
      visitDiagnoses={[]}
      patientReference="Patient/p1"
      disabled={false}
      suggestionsByObservation={{ "Observation/unassigned": {
        findingInstanceId: "finding-unassigned",
        candidates: suggestions,
      } }}
      onSuggest={(suggestion) => { selected.push(suggestion.diagnosisKey ?? suggestion.familyGroup); }}
      onMutate={() => undefined}
    />,
  );
  const buttons = renderer.root.findAllByProps({ className: "odos-unassigned-finding-suggestion" });
  assert.equal(renderer.root.findByProps({ className: "odos-unassigned-finding-suggestions" }).findByType("small").children.join(""), "suggests:");
  assert.deepEqual(buttons.map((button) => button.children.join("")), ["Macular drusen", "Nonexudative AMD"]);
  assert.equal(buttons[0]?.props.className, buttons[1]?.props.className);
  act(() => buttons[1]?.props.onClick());
  assert.deepEqual(selected, ["nonexudative-amd"]);
});

test("tray leaf and family suggestions reuse the existing scope and stage prompt and persist only after explicit scope", async () => {
  const originalFetch = globalThis.fetch;
  const payload = findingsPayload();
  const leaf = { ...diagnosisRow("macular_drusen", "Macular drusen"), lateralityRequired: true };
  const family = {
    stableKey: "nonexudative-amd",
    clinicalFamily: "nonexudative-amd",
    display: "Nonexudative AMD",
    lateralityRequired: true,
    pinned: false,
    tallyCount: 0,
    axisLabel: "Stage",
    members: [{
      stableKey: "dry_amd_early",
      stageLabel: "Early",
      display: "Nonexudative AMD, early dry stage",
      lateralityRequired: true,
      icd10: { pattern: { right: "H35.3111", left: "H35.3121", bilateral: "H35.3131" } },
    }],
  };
  const pickBodies: unknown[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("/fhir/R4/Encounter/e1")) return jsonResponse({ resourceType: "Encounter", id: "e1", status: "in-progress", class: { code: "AMB" }, diagnosis: [] });
    if (url.includes("/clinical-graph/diagnosis-quick-list")) return jsonResponse({ canWrite: true, pinnedDiagnosisKeys: [], diagnoses: [], catalog: [leaf, family] });
    if (url.includes("/clinical-graph/encounters/e1/findings")) return jsonResponse({ ...payload, canWrite: true, findings: [], catalog: [], bySection: {}, visitDiagnoses: [] });
    if (url.includes("/clinical-graph/encounters/e1/diagnosis-candidates")) return jsonResponse({ findings: [{
      findingInstanceId: "finding-unassigned",
      observationReference: "Observation/unassigned",
      candidates: [{ diagnosisKey: "macular_drusen", display: "Macular drusen", priority: true, source: "mapping" }, {
        familyGroup: "nonexudative-amd", clinicalFamily: "nonexudative-amd", display: "Nonexudative AMD", axisLabel: "Stage",
        members: [{ stableKey: "dry_amd_early", stageLabel: "Early" }], priority: true, source: "mapping",
      }],
    }] });
    if (url.includes("/clinical-graph/encounters/e1/diagnosis-picks") && init?.method === "POST") {
      pickBodies.push(JSON.parse(String(init.body)));
      return jsonResponse({ condition: { resourceType: "Condition", id: "picked", subject: { reference: "Patient/p1" }, code: { text: "Macular drusen" } } });
    }
    if (url.includes("/fhir/R4/BodyStructure?")) return jsonResponse({ resourceType: "Bundle", type: "searchset", entry: [] });
    if (url.endsWith("/fhir/R4/BodyStructure") && init?.method === "POST") return jsonResponse({ resourceType: "BodyStructure", id: "eye", patient: { reference: "Patient/p1" } });
    if (url.includes("/fhir/R4/Condition/picked") && init?.method === "PATCH") return jsonResponse({ resourceType: "Condition", id: "picked", subject: { reference: "Patient/p1" }, code: { text: "Macular drusen" }, bodySite: [{ text: "OD" }] });
    if (url.endsWith("/fhir/R4/Provenance") && init?.method === "POST") return jsonResponse({ resourceType: "Provenance", id: "p", target: [], recorded: "2026-08-11T12:00:00Z", agent: [] });
    if (url.includes("/clinical-graph/encounters/e1/previous-exams")) return jsonResponse({ pageSize: 4, encounters: [] });
    if (url.includes("/clinical-graph/imaging")) return jsonResponse({ images: [] });
    throw new Error(`Unexpected request: ${init?.method ?? "GET"} ${url}`);
  }) as typeof fetch;
  let renderer!: ReactTestRenderer;
  try {
    await act(async () => {
      renderer = create(<DiagnosisWorkspace patientReference="Patient/p1" encounterReference="Encounter/e1" onSelectDiagnosis={() => undefined} />);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    const suggestion = (label: string) => renderer.root.findByProps({ "aria-label": `Add suggested diagnosis ${label}` });
    act(() => suggestion("Nonexudative AMD").props.onClick());
    assert.ok(renderer.root.findByProps({ ariaLabel: "Stage for Nonexudative AMD" }));
    act(() => renderer.root.findAllByType("button").find((button) => button.children.includes("Cancel"))?.props.onClick());
    act(() => suggestion("Macular drusen").props.onClick());
    assert.equal(pickBodies.length, 0);
    const scope = renderer.root.findByProps({ ariaLabel: "Scope for Macular drusen" });
    await act(async () => {
      scope.props.onChange(["OD"]);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    assert.deepEqual(pickBodies, [{
      diagnosisKey: "macular_drusen",
      action: "confirm",
      findingInstanceId: "finding-unassigned",
      laterality: "OD",
      source: "mapping",
    }]);
  } finally {
    act(() => renderer?.unmount());
    globalThis.fetch = originalFetch;
  }
});

test("same-encounter finding refresh reloads diagnosis candidates for newly charted findings", async () => {
  const originalFetch = globalThis.fetch;
  const payload = findingsPayload();
  const leaf = { ...diagnosisRow("macular_drusen", "Macular drusen"), lateralityRequired: true };
  let candidateReads = 0;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("/fhir/R4/Encounter/e1")) return jsonResponse({ resourceType: "Encounter", id: "e1", status: "in-progress", class: { code: "AMB" }, diagnosis: [] });
    if (url.includes("/clinical-graph/diagnosis-quick-list")) return jsonResponse({ canWrite: true, pinnedDiagnosisKeys: [], diagnoses: [], catalog: [leaf] });
    if (url.includes("/clinical-graph/encounters/e1/findings") && init?.method === "PUT") return jsonResponse({});
    if (url.includes("/clinical-graph/encounters/e1/findings")) return jsonResponse({ ...payload, canWrite: true, findings: [], catalog: [], bySection: {}, visitDiagnoses: [] });
    if (url.includes("/clinical-graph/encounters/e1/diagnosis-candidates")) {
      candidateReads += 1;
      return jsonResponse({ findings: candidateReads === 1 ? [] : [{
        findingInstanceId: "finding-unassigned",
        observationReference: "Observation/unassigned",
        candidates: [{ diagnosisKey: "macular_drusen", display: "Macular drusen", priority: true, source: "mapping" }],
      }] });
    }
    if (url.includes("/clinical-graph/encounters/e1/previous-exams")) return jsonResponse({ pageSize: 4, encounters: [] });
    if (url.includes("/clinical-graph/imaging")) return jsonResponse({ images: [] });
    throw new Error(`Unexpected request: ${init?.method ?? "GET"} ${url}`);
  }) as typeof fetch;
  let renderer!: ReactTestRenderer;
  try {
    await act(async () => {
      renderer = create(<DiagnosisWorkspace patientReference="Patient/p1" encounterReference="Encounter/e1" onSelectDiagnosis={() => undefined} />);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    assert.equal(candidateReads, 1);
    assert.equal(renderer.root.findAllByProps({ "aria-label": "Add suggested diagnosis Macular drusen" }).length, 0);
    await act(async () => {
      renderer.root.findByProps({ "aria-label": "Record Unassigned finding standalone" }).props.onClick();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    assert.equal(candidateReads, 2);
    assert.ok(renderer.root.findByProps({ "aria-label": "Add suggested diagnosis Macular drusen" }));
  } finally {
    act(() => renderer?.unmount());
    globalThis.fetch = originalFetch;
  }
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

function stagedFamilyRow() {
  const member = (stableKey: string, stageLabel: string, code: string) => ({
    stableKey,
    stageLabel,
    display: `Primary open-angle glaucoma, ${stageLabel.toLocaleLowerCase()} stage`,
    lateralityRequired: true,
    icd10: {
      pattern: {
        unspecifiedEye: `${code}0`,
        right: `${code}1`,
        left: `${code}2`,
        bilateral: `${code}3`,
      },
    },
  });
  return {
    stableKey: "primary-open-angle-glaucoma",
    clinicalFamily: "primary-open-angle-glaucoma",
    display: "Primary open-angle glaucoma",
    lateralityRequired: true,
    pinned: false,
    tallyCount: 0,
    axisLabel: "Stage",
    members: [
      member("poag_mild", "Mild", "H40.111"),
      member("poag_moderate", "Moderate", "H40.112"),
      member("poag_severe", "Severe", "H40.113"),
      member("poag_indeterminate", "Indeterminate", "H40.119"),
    ],
  };
}

function stagedCondition(id: string, stableKey: string, recordedDate: string): Condition {
  return {
    resourceType: "Condition",
    id,
    subject: { reference: "Patient/p1" },
    encounter: { reference: "Encounter/prior" },
    clinicalStatus: { coding: [{ code: "active" }] },
    verificationStatus: { coding: [{ code: "confirmed" }] },
    identifier: [{
      system: "https://odos2020.com/fhir/NamingSystem/diagnosis-catalog-stable-key",
      value: `prior::${stableKey}::right`,
    }],
    code: { text: stableKey },
    recordedDate,
  };
}

function stagedWorkspaceFetch(family: ReturnType<typeof stagedFamilyRow>): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = String(input);
    if (url.includes("/fhir/R4/Encounter/e1")) {
      return jsonResponse({ resourceType: "Encounter", id: "e1", status: "in-progress", class: { code: "AMB" }, diagnosis: [] });
    }
    if (url.includes("/fhir/R4/Condition?")) {
      return jsonResponse({
        resourceType: "Bundle",
        type: "searchset",
        entry: [{ resource: stagedCondition("prior", "poag_moderate", "2026-03-14T12:00:00.000Z") }],
      });
    }
    if (url.includes("/clinical-graph/diagnosis-quick-list")) {
      return jsonResponse({ canWrite: true, pinnedDiagnosisKeys: [], diagnoses: [family], catalog: [family] });
    }
    if (url.includes("/clinical-graph/encounters/e1/findings")) {
      return jsonResponse({ canWrite: true, findings: [], catalog: [], unassigned: [], bySection: {}, visitDiagnoses: [] });
    }
    if (url.includes("/clinical-graph/encounters/e1/previous-exams")) return jsonResponse({ pageSize: 4, encounters: [] });
    if (url.includes("/clinical-graph/imaging")) return jsonResponse({ images: [] });
    throw new Error(`Unexpected request: ${url}`);
  }) as typeof fetch;
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
