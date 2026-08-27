import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import {
  ComplaintIntake,
  DEFAULT_HPI_ROS_OPTIONS,
  HpiSection,
  buildHpiRequestBody,
  complaintDefinitionForRos,
  markRemainingReviewedNegative,
} from "../src/components/charting/HpiSection";
import {
  blankComplaintDraft,
  effectiveComplaintOptions,
  renderComplaintNarrative,
  type ComplaintDefinition,
  type EncounterComplaint,
  type GenericComplaintOptions,
} from "../src/lib/complaints";
import { SpineNav } from "../src/components/charting/SpineNav";
import type { SectionSaveStatus } from "../src/components/charting/types";

const GENERIC: GenericComplaintOptions = {
  conditions: [{ code: "dry-eyes", display: "Dry Eyes", active: true }],
  qualities: [{ code: "constant", display: "constant", active: true }],
  treatments: [{ code: "no-treatment", display: "no treatment", active: true }],
};

const DRY_EYE: ComplaintDefinition = {
  id: "complaint-definition-dry-eye",
  stableKey: "dry-eye",
  display: "Patient (Dry Eye)",
  kind: "patient-symptom",
  conditionOptions: [],
  qualityOptions: [
    { code: "environmentally-sensitive", display: "environmentally sensitive", active: true },
    { code: "brought-on-by-drafts-or-fans", display: "brought on by drafts or fans", active: true },
  ],
  treatmentOptions: [
    { code: "artificial-tears", display: "artificial tears", active: true },
    { code: "warm-compresses", display: "warm compresses", active: true },
  ],
  seedRank: 10,
  status: "active",
};

const ROUTINE: ComplaintDefinition = {
  ...DRY_EYE,
  id: "complaint-definition-routine-eye-exam",
  stableKey: "routine-eye-exam",
  display: "Routine Eye Exam",
  kind: "evaluation-reason",
  qualityOptions: [],
  treatmentOptions: [],
  seedRank: 3,
};

test("HPI section renders Presenting Complaints, Top Complaints, persistent ROS controls, and no legacy free-text grid", () => {
  const html = renderToStaticMarkup(<HpiSection patientReference="Patient/p1" encounterReference="Encounter/e1" onSaved={() => undefined} />);
  assert.match(html, /Chief complaint \/ HPI \/ ROS/);
  assert.match(html, /Presenting Complaints/);
  assert.match(html, /Top Complaints/);
  assert.match(html, /Search complaints/);
  assert.match(html, /Other/);
  assert.match(html, /Eye-focused/);
  assert.match(html, /General medical/);
  assert.match(html, /Mark remaining reviewed: negative/);
  assert.match(html, /Add another medical flag/);
  assert.match(html, /Add flag/);
  assert.match(html, /Save reviewed ROS/);
  assert.doesNotMatch(html, /Save history/);
  assert.doesNotMatch(html, /aria-label="Chief complaint"/);
  for (const legacy of ["Modifying factors", "Associated signs / symptoms", "History of present illness"]) assert.doesNotMatch(html, new RegExp(legacy));
});

test("Complaint Intake renders all six clusters and the automated narrative controls", () => {
  const draft = blankComplaintDraft({ complaintKey: "dry-eye" });
  const html = renderToStaticMarkup(<ComplaintIntake
    draft={draft}
    definition={DRY_EYE}
    options={effectiveComplaintOptions(GENERIC, DRY_EYE)}
    preview="Patient reports dry eye. Current treatment: none."
    overrideDirty={false}
    saving={false}
    onUpdate={() => undefined}
    onToggle={() => undefined}
    onNarrativeMode={() => undefined}
    onRegenerate={() => undefined}
    onCancel={() => undefined}
    onSave={() => undefined}
  />);
  for (const label of ["Symptoms", "Laterality", "Character", "Duration", "Current treatment", "Referral &amp; history", "History Narrative"]) assert.match(html, new RegExp(label));
  assert.match(html, /environmentally sensitive/);
  assert.match(html, /artificial tears/);
  assert.match(html, /Automated/);
  assert.match(html, /Override/);
  assert.match(html, /Save and Add Another/);
  assert.match(html, /Save Complaint/);
});

test("dry eye layers its sourced vocabulary while every other seed remains generic-only", () => {
  const dry = effectiveComplaintOptions(GENERIC, DRY_EYE);
  const routine = effectiveComplaintOptions(GENERIC, ROUTINE);
  assert.deepEqual(dry.qualities.map((option) => option.code), ["constant", "environmentally-sensitive", "brought-on-by-drafts-or-fans"]);
  assert.deepEqual(dry.treatments.map((option) => option.code), ["no-treatment", "artificial-tears", "warm-compresses"]);
  assert.deepEqual(routine, GENERIC);
});

test("History Narrative matches the worked dry-eye example and override text stays frozen", () => {
  const draft = {
    ...blankComplaintDraft({ complaintKey: "dry-eye" }),
    conditions: ["dry-eyes"],
    eyeLocation: "OU" as const,
    eyeComparison: "right-worse" as const,
    qualities: ["constant", "environmentally-sensitive", "brought-on-by-drafts-or-fans"],
    duration: { value: 3, unit: "months" as const },
    treatmentsTried: ["artificial-tears", "warm-compresses"],
    additionalHistory: "worse at end of workday",
  };
  const narrative = renderComplaintNarrative(draft, DRY_EYE, GENERIC);
  assert.equal(narrative, "Patient reports dry eyes, both eyes, right worse than left, ongoing for 3 months. Described as constant, environmentally sensitive, brought on by drafts or fans. Current treatment: artificial tears, warm compresses. Additional history: worse at end of workday.");
  assert.equal(renderComplaintNarrative({
    ...draft,
    conditions: [],
    narrative: { mode: "override", overrideText: "Clinician-authored paragraph." },
  }, DRY_EYE, GENERIC), "Clinician-authored paragraph.");
  assert.match(renderComplaintNarrative({
    ...draft,
    duration: { value: 1, unit: "weeks" },
  }, DRY_EYE, GENERIC), /ongoing for 1 week\./);
  const dirtyHtml = renderToStaticMarkup(<ComplaintIntake
    draft={{ ...draft, narrative: { mode: "override", overrideText: narrative } }}
    definition={DRY_EYE}
    options={effectiveComplaintOptions(GENERIC, DRY_EYE)}
    preview={narrative}
    overrideDirty={true}
    saving={false}
    onUpdate={() => undefined}
    onToggle={() => undefined}
    onNarrativeMode={() => undefined}
    onRegenerate={() => undefined}
    onCancel={() => undefined}
    onSave={() => undefined}
  />);
  assert.match(dirtyHtml, /Narrative is overridden and coded fields changed/);
  assert.match(dirtyHtml, /Regenerate from coded fields/);
});

test("ROS bulk-negative changes only Not reviewed items and positive rows map to pre-seeded complaints", () => {
  const statuses = markRemainingReviewedNegative(
    { "vision-changes": "positive", "eye-pain": "negative", diabetes: "" },
    DEFAULT_HPI_ROS_OPTIONS,
    "eye",
  );
  assert.equal(statuses["vision-changes"], "positive");
  assert.equal(statuses["eye-pain"], "negative");
  assert.equal(statuses["floaters-flashes"], "negative");
  assert.equal(statuses.diabetes, "");
  assert.equal(complaintDefinitionForRos(DEFAULT_HPI_ROS_OPTIONS.find((option) => option.code === "eye-pain")!, [DRY_EYE, ROUTINE, { ...DRY_EYE, stableKey: "patient-eye-pain" }])?.stableKey, "patient-eye-pain");
  assert.equal(complaintDefinitionForRos(DEFAULT_HPI_ROS_OPTIONS.find((option) => option.code === "diabetes")!, [DRY_EYE, ROUTINE]), undefined);
});

test("history request transmits only reviewed ROS values and bulk-attestation provenance inputs", () => {
  const body = buildHpiRequestBody({
    patientReference: "Patient/p1",
    encounterReference: "Encounter/e1",
    rosStatuses: { "vision-changes": "positive", diabetes: "negative" },
    rosOptions: DEFAULT_HPI_ROS_OPTIONS,
    reviewAttestations: ["general"],
  });
  assert.deepEqual(body.reviewOfSystems, [
    { code: "vision-changes", display: "Vision changes", category: "eye", status: "positive" },
    { code: "diabetes", display: "Diabetes", category: "general", status: "negative" },
  ]);
  assert.deepEqual(body.reviewAttestations, ["general"]);
});

test("remove complaint network failures surface a visible error", async () => {
  await assertRejectedMutationVisible(async (renderer) => {
    const remove = renderer.root.findAllByType("button").find((button) => button.children.join("") === "Remove");
    assert.ok(remove);
    await act(async () => {
      remove.props.onClick();
      await flushEffects();
    });
  });
});

test("reorder complaint network failures surface a visible error", async () => {
  await assertRejectedMutationVisible(async (renderer) => {
    const complaints = renderer.root.findAllByType("article");
    assert.equal(complaints.length, 2);
    act(() => complaints[0]!.props.onDragStart());
    await act(async () => {
      complaints[1]!.props.onDrop();
      await flushEffects();
    });
  });
});

test("add medical flag network failures surface a visible error", async () => {
  await assertRejectedMutationVisible(async (renderer) => {
    const input = renderer.root.findByProps({ "aria-label": "New general-medical review flag" });
    act(() => input.props.onChange({ target: { value: "Asthma" } }));
    const add = renderer.root.findAllByType("button").find((button) => button.children.join("") === "Add flag");
    assert.ok(add);
    await act(async () => {
      add.props.onClick();
      await flushEffects();
    });
  });
});

test("Save and Add Another keeps a fresh complaint intake open", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith("/clinical-graph/hpi/definition")) {
      return jsonResponse({ definition: { fields: { reviewOfSystems: { options: DEFAULT_HPI_ROS_OPTIONS } } } });
    }
    if (url.endsWith("/clinical-graph/complaint-definitions")) {
      return jsonResponse({ definitions: [DRY_EYE, ROUTINE], genericOptions: GENERIC });
    }
    if (url.endsWith("/clinical-graph/encounters/e1/complaints") && init?.method === "POST") {
      return jsonResponse({ complaints: [complaintFixture("complaint-1", 1)] });
    }
    if (url.endsWith("/clinical-graph/hpi") && init?.method === "POST") {
      return jsonResponse({ observationReference: "Observation/history-1" });
    }
    if (url.endsWith("/clinical-graph/encounters/e1/complaints")) {
      return jsonResponse({ complaints: [] });
    }
    throw new Error(`Unexpected request: ${init?.method ?? "GET"} ${url}`);
  };
  let renderer!: ReactTestRenderer;
  try {
    await act(async () => {
      renderer = create(<HpiSection patientReference="Patient/p1" encounterReference="Encounter/e1" onSaved={() => undefined} />);
      await flushEffects();
    });
    const complaint = renderer.root.findAllByType("button")
      .find((button) => button.children.join("") === "Patient (Dry Eye)");
    assert.ok(complaint);
    act(() => complaint.props.onClick());
    const saveAndAdd = renderer.root.findAllByType("button")
      .find((button) => button.children.join("") === "Save and Add Another");
    assert.ok(saveAndAdd);
    await act(async () => {
      saveAndAdd.props.onClick();
      await flushEffects();
    });
    assert.ok(renderer.root.findAllByType("h3").some((heading) => heading.children.join("") === "Complaint Intake"));
    const concern = renderer.root.findAllByType("input")
      .find((input) => input.props.maxLength === 4000);
    assert.ok(concern);
    assert.equal(concern.props.value, "");
  } finally {
    renderer?.unmount();
    globalThis.fetch = originalFetch;
  }
});

test("a failed automatic History capture keeps the saved complaint visible and retries without saving it twice", async () => {
  const originalFetch = globalThis.fetch;
  let complaintPosts = 0;
  let historyPosts = 0;
  let failHistory = true;
  const savedReports: Array<{ status: SectionSaveStatus; keepOpen?: boolean }> = [];
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith("/clinical-graph/hpi/definition")) {
      return jsonResponse({ definition: { fields: { reviewOfSystems: { options: DEFAULT_HPI_ROS_OPTIONS } } } });
    }
    if (url.endsWith("/clinical-graph/complaint-definitions")) {
      return jsonResponse({ definitions: [DRY_EYE, ROUTINE], genericOptions: GENERIC });
    }
    if (url.endsWith("/clinical-graph/encounters/e1/complaints") && init?.method === "POST") {
      complaintPosts += 1;
      return jsonResponse({ complaints: [complaintFixture("complaint-1", 1)] });
    }
    if (url.endsWith("/clinical-graph/encounters/e1/complaints")) {
      return jsonResponse({ complaints: [] });
    }
    if (url.endsWith("/clinical-graph/hpi") && init?.method === "POST") {
      historyPosts += 1;
      return failHistory
        ? new Response(JSON.stringify({ error: "FHIR write unavailable" }), { status: 503, headers: { "Content-Type": "application/json" } })
        : jsonResponse({ observationReference: "Observation/history-1" });
    }
    throw new Error(`Unexpected request: ${init?.method ?? "GET"} ${url}`);
  };
  let renderer!: ReactTestRenderer;
  try {
    await act(async () => {
      renderer = create(<HpiSection
        patientReference="Patient/p1"
        encounterReference="Encounter/e1"
        onSaved={(status, keepOpen) => { savedReports.push({ status, keepOpen }); }}
      />);
      await flushEffects();
    });
    const complaint = renderer.root.findAllByType("button")
      .find((button) => button.children.join("") === "Patient (Dry Eye)");
    assert.ok(complaint);
    act(() => complaint.props.onClick());
    const save = renderer.root.findAllByType("button")
      .find((button) => button.children.join("") === "Save Complaint");
    assert.ok(save);
    await act(async () => {
      save.props.onClick();
      await flushEffects();
    });

    assert.equal(complaintPosts, 1);
    assert.equal(historyPosts, 1);
    assert.equal(savedReports.length, 1);
    assert.equal(savedReports[0]?.status.completed, false);
    assert.equal(savedReports[0]?.keepOpen, true);
    assert.match(renderer.root.findByProps({ role: "alert" }).children.join(""), /complaint was saved.*History was not recorded/i);
    assert.ok(renderer.root.findAllByType("p").some((paragraph) =>
      paragraph.children.join("") === "Complaint 1"
    ));
    const nav = renderToStaticMarkup(<SpineNav
      active="hpi"
      statuses={{ hpi: savedReports[0]!.status }}
      onSelect={() => undefined}
    />);
    assert.match(nav, /aria-label="Incomplete — Complaint 1"/);
    assert.doesNotMatch(nav, /aria-label="Complete — Complaint 1"/);

    failHistory = false;
    const retry = renderer.root.findAllByType("button")
      .find((button) => button.children.join("") === "Retry recording History");
    assert.ok(retry);
    await act(async () => {
      retry.props.onClick();
      await flushEffects();
    });
    assert.equal(complaintPosts, 1);
    assert.equal(historyPosts, 2);
    assert.equal(savedReports.length, 2);
    assert.equal(savedReports[1]?.status.completed, true);
  } finally {
    renderer?.unmount();
    globalThis.fetch = originalFetch;
  }
});

test("legacy next-field wiring is fully removed from the source", () => {
  const source = readFileSync(new URL("../src/components/charting/HpiSection.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(source, /HPI_ELEMENTS|EMPTY_HPI|chiefComplaint|modifyingFactors|associatedSignsSymptoms/);
});

test("History is the first top-level spine group before Pretest", () => {
  const html = renderToStaticMarkup(<SpineNav active="hpi" statuses={{}} onSelect={() => undefined} />);
  const historyIndex = html.indexOf("HISTORY");
  const hpiIndex = html.indexOf("Chief Complaint / HPI / ROS");
  const pretestIndex = html.indexOf("PRETEST");
  assert.ok(historyIndex >= 0 && hpiIndex > historyIndex && pretestIndex > hpiIndex);
});

async function assertRejectedMutationVisible(action: (renderer: ReactTestRenderer) => Promise<void>): Promise<void> {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    if (init?.method === "POST") throw new Error("Network unavailable");
    const url = String(input);
    if (url.endsWith("/clinical-graph/hpi/definition")) {
      return jsonResponse({ definition: { fields: { reviewOfSystems: { options: DEFAULT_HPI_ROS_OPTIONS } } } });
    }
    if (url.endsWith("/clinical-graph/complaint-definitions")) {
      return jsonResponse({ definitions: [DRY_EYE, ROUTINE], genericOptions: GENERIC });
    }
    if (url.endsWith("/clinical-graph/encounters/e1/complaints")) {
      return jsonResponse({ complaints: [complaintFixture("complaint-1", 1), complaintFixture("complaint-2", 2)] });
    }
    throw new Error(`Unexpected request: ${init?.method ?? "GET"} ${url}`);
  };
  let renderer!: ReactTestRenderer;
  try {
    await act(async () => {
      renderer = create(<HpiSection patientReference="Patient/p1" encounterReference="Encounter/e1" onSaved={() => undefined} />);
      await flushEffects();
    });
    await action(renderer);
    assert.match(renderer.root.findByProps({ role: "alert" }).children.join(""), /Network unavailable/);
  } finally {
    renderer?.unmount();
    globalThis.fetch = originalFetch;
  }
}

function complaintFixture(id: string, ordinal: number): EncounterComplaint {
  return {
    ...blankComplaintDraft({ complaintKey: "dry-eye" }),
    id,
    encounterId: "e1",
    patientId: "p1",
    ordinal,
    status: "active",
    renderedNarrative: `Complaint ${ordinal}`,
  };
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
}

async function flushEffects(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}
