import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import {
  HpiSection,
  HistoryTemplateEditor,
  cycleHistoryTriState,
  historySectionComplete,
  type HistoryCatalogs,
  type HistoryTemplate,
  type HistoryTemplateAnswer,
} from "../src/components/charting/HpiSection";
import { EncounterEditContext } from "../src/components/charting/encounter-edit-context";

const TEMPLATE: HistoryTemplate = {
  complaint: "glaucoma",
  label: "Glaucoma",
  presentations: "glaucoma_presentations",
  sections: [
    { id: "symptoms", type: "symptoms", label: "Signs & symptoms", catalog: "glaucoma_symptoms", required: true },
    { id: "symptom-duration", type: "duration", label: "these symptoms" },
    { id: "glaucoma-duration", type: "duration", label: "glaucoma" },
    { id: "risk-factors", type: "risk_factors", label: "Risk factors", catalog: "glaucoma_risk", required: true },
    { id: "current-treatment", type: "treatment", label: "Current glaucoma treatment", catalog: "glaucoma_formulary", when: "current", per_eye: true, required: true },
    { id: "interval", type: "interval", label: "Since last visit", on: "follow-up" },
    { id: "presents-for", type: "presents_for", label: "Today the patient presents for", catalog: "glaucoma_workup", required: true },
    { id: "additional-history", type: "text", label: "Additional history" },
  ],
  narrative: "declaration-owned",
};

const CATALOGS: HistoryCatalogs = {
  glaucoma_presentations: [{ code: "follow-up", display: "Follow Up" }, { code: "pressure-check", display: "Pressure Check" }],
  glaucoma_symptoms: [{ code: "ocular-pain", display: "ocular pain" }],
  glaucoma_risk: [{ code: "family-history", display: "family history of glaucoma" }],
  glaucoma_formulary: [{ code: "latanoprost", display: "latanoprost" }],
  glaucoma_workup: [{ code: "iop-check", display: "IOP check" }],
};

test("the History surface starts open and contains no explicit Save control", () => {
  const html = renderToStaticMarkup(<HpiSection patientReference="Patient/p1" encounterReference="Encounter/e1" onSaved={() => undefined} />);
  assert.match(html, /Chief Complaint &amp; HPI/);
  assert.match(html, /Loading history templates/);
  assert.doesNotMatch(html, />Save(?: |<)/);
});

test("one generic renderer follows the declaration and shows interval only for follow-up", () => {
  const base = {
    complaintId: "complaint-1",
    template: TEMPLATE,
    catalogs: CATALOGS,
    answers: [answer("presentation", undefined, { kind: "selection", code: "pressure-check" })] as HistoryTemplateAnswer[],
    narrative: "",
    editMode: false,
    onChange: () => undefined,
    onRemoveTyped: () => undefined,
  };
  const pressure = renderToStaticMarkup(<HistoryTemplateEditor {...base} />);
  assert.match(pressure, /Signs &amp; symptoms/);
  assert.match(pressure, /these symptoms/);
  assert.match(pressure, /glaucoma/);
  assert.doesNotMatch(pressure, /Since last visit/);

  const followUp = renderToStaticMarkup(<HistoryTemplateEditor {...base} answers={[answer("presentation", undefined, { kind: "selection", code: "follow-up" })]} />);
  assert.match(followUp, /Since last visit/);
  assert.match(followUp, /ocular pain/);
  assert.match(followUp, /family history of glaucoma/);
  assert.match(followUp, /latanoprost/);
  assert.match(followUp, /IOP check/);
  assert.doesNotMatch(followUp, />Save(?: |<)/);
});

test("per-eye treatment flags retain distinct OD and OS answers for the same catalog option", () => {
  const presentation = answer("presentation", undefined, { kind: "selection", code: "follow-up" });
  const recorded: HistoryTemplateAnswer[] = [];
  let current = [presentation];
  const props = () => ({
    complaintId: "complaint-1",
    template: TEMPLATE,
    catalogs: CATALOGS,
    answers: current,
    narrative: "",
    editMode: false,
    onChange: (next: HistoryTemplateAnswer | undefined) => {
      if (next) recorded.push(next);
    },
    onRemoveTyped: () => undefined,
  });
  const renderer = create(<HistoryTemplateEditor {...props()} />);

  act(() => renderer.root.findByProps({ "aria-label": "latanoprost OD: unasked" }).props.onClick());
  current = [...current, recorded[0]!];
  act(() => renderer.update(<HistoryTemplateEditor {...props()} />));
  act(() => renderer.root.findByProps({ "aria-label": "latanoprost OS: unasked" }).props.onClick());

  assert.deepEqual(recorded.map((item) => [item.id, item.eye]), [
    ["history-complaint-1-current-treatment-latanoprost-OD", "OD"],
    ["history-complaint-1-current-treatment-latanoprost-OS", "OS"],
  ]);
  renderer.unmount();
});

test("three-state chips cycle unasked to positive to negative to unasked", () => {
  assert.equal(cycleHistoryTriState(undefined), "positive");
  assert.equal(cycleHistoryTriState("positive"), "negative");
  assert.equal(cycleHistoryTriState("negative"), undefined);
});

test("a persisted negative chip's third tap requests clearing that exact Observation without a delete control", () => {
  const negative = { ...answer("symptoms", "ocular-pain", { kind: "tri-state", status: "negative" }), observationReference: "Observation/answer-pain" };
  let change: { next: HistoryTemplateAnswer | undefined; prior: HistoryTemplateAnswer | undefined } | undefined;
  const renderer = create(<HistoryTemplateEditor
    complaintId="complaint-1"
    template={TEMPLATE}
    catalogs={CATALOGS}
    answers={[answer("presentation", undefined, { kind: "selection", code: "follow-up" }), negative]}
    narrative=""
    editMode={false}
    onChange={(next, prior) => { change = { next, prior }; }}
    onRemoveTyped={() => undefined}
  />);
  const chip = renderer.root.findByProps({ "aria-label": "ocular pain: negative" });
  act(() => chip.props.onClick());
  assert.equal(change?.next, undefined);
  assert.equal(change?.prior?.observationReference, "Observation/answer-pain");
  assert.equal(renderer.root.findAllByType("button").some((button) => button.children.join("") === "Remove"), false);
  renderer.unmount();
});

test("computed completeness follows required declaration sections, not a completion button", () => {
  const incomplete = [answer("presentation", undefined, { kind: "selection", code: "follow-up" })];
  assert.equal(historySectionComplete(TEMPLATE, incomplete), false);
  assert.equal(historySectionComplete(TEMPLATE, [
    ...incomplete,
    answer("symptoms", "ocular-pain", { kind: "tri-state", status: "negative" }),
    answer("risk-factors", "family-history", { kind: "tri-state", status: "negative" }),
    answer("current-treatment", "latanoprost", { kind: "tri-state", status: "positive" }),
    answer("presents-for", "iop-check", { kind: "tri-state", status: "positive" }),
  ]), true);
});

test("field changes autosave after the 800ms debounce and report saved in the section header", async () => {
  const originalFetch = globalThis.fetch;
  let historyPosts = 0;
  const submittedAnswers: HistoryTemplateAnswer[][] = [];
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith("/clinical-graph/hpi/definition")) return json({ templates: [TEMPLATE], catalogs: CATALOGS, definition: {} });
    if (url.endsWith("/clinical-graph/encounters/e1/complaints") && init?.method === "POST") return json({ complaints: [complaint()] });
    if (url.endsWith("/clinical-graph/encounters/e1/complaints")) return json({ complaints: [] });
    if (url.endsWith("/clinical-graph/encounters/e1/hpi")) return json({
      answers: [],
      followUpPrefills: [
        answer("symptoms", "ocular-pain", { kind: "tri-state", status: "negative" }),
        answer("presents-for", "iop-check", { kind: "tri-state", status: "positive" }),
      ],
      templateNarratives: [],
    });
    if (url.endsWith("/clinical-graph/hpi") && init?.method === "POST") {
      historyPosts += 1;
      const submitted = JSON.parse(String(init.body)) as { templateAnswers: HistoryTemplateAnswer[] };
      submittedAnswers.push(submitted.templateAnswers);
      return json({
        observationReference: "Observation/history-1",
        answers: submitted.templateAnswers.map((item, index) => ({ ...item, observationReference: `Observation/answer-${index + 1}` })),
        templateNarratives: [{ complaintId: "complaint-1", narrative: "is being seen for follow up." }],
      });
    }
    throw new Error(`Unexpected request: ${init?.method ?? "GET"} ${url}`);
  };
  let renderer!: ReactTestRenderer;
  try {
    await act(async () => {
      renderer = create(<EncounterEditContext.Provider value={{}}><HpiSection patientReference="Patient/p1" encounterReference="Encounter/e1" onSaved={() => undefined} /></EncounterEditContext.Provider>);
      await delay(0);
    });
    const add = renderer.root.findAllByType("button").find((button) => button.children.join("") === "Glaucoma");
    assert.ok(add);
    await act(async () => { add.props.onClick(); await delay(0); });
    assert.equal(historyPosts, 1, "creating the first complaint creates hpi_ros");
    const followUp = renderer.root.findAllByType("button").find((button) => button.children.join("") === "Follow Up");
    assert.ok(followUp);
    act(() => followUp.props.onClick());
    await act(async () => { await delay(700); });
    assert.equal(historyPosts, 1);
    await act(async () => { await delay(150); });
    assert.equal(historyPosts, 2);
    assert.deepEqual(submittedAnswers[1]?.map((item) => [item.sectionId, item.optionCode, item.value]), [
      ["presentation", undefined, { kind: "selection", code: "follow-up" }],
      ["symptoms", "ocular-pain", { kind: "tri-state", status: "negative" }],
      ["presents-for", "iop-check", { kind: "tri-state", status: "positive" }],
    ]);
    assert.match(renderer.root.findByProps({ role: "status" }).children.join(""), /saved · just now/i);
  } finally {
    renderer?.unmount();
    globalThis.fetch = originalFetch;
  }
});

test("clearing a chip waits for an in-flight autosave and voids the Observation it created", async () => {
  const originalFetch = globalThis.fetch;
  let historyPosts = 0;
  let resolveInFlight!: (response: Response) => void;
  const inFlight = new Promise<Response>((resolve) => { resolveInFlight = resolve; });
  const voidBodies: Array<{ scope?: string; observationReference?: string }> = [];
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith("/clinical-graph/hpi/definition")) return json({ templates: [TEMPLATE], catalogs: CATALOGS, definition: {} });
    if (url.endsWith("/clinical-graph/encounters/e1/complaints") && init?.method === "POST") return json({ complaints: [complaint()] });
    if (url.endsWith("/clinical-graph/encounters/e1/complaints")) return json({ complaints: [] });
    if (url.endsWith("/clinical-graph/encounters/e1/hpi")) return json({
      answers: [],
      followUpPrefills: [answer("symptoms", "ocular-pain", { kind: "tri-state", status: "negative" })],
      templateNarratives: [],
    });
    if (url.endsWith("/clinical-graph/encounters/e1/void") && init?.method === "POST") {
      voidBodies.push(JSON.parse(String(init.body)) as { scope?: string; observationReference?: string });
      return json({ voided: ["Observation/answer-pain"], count: 1, sections: [], entries: [], preview: false });
    }
    if (url.endsWith("/clinical-graph/hpi") && init?.method === "POST") {
      historyPosts += 1;
      const submitted = JSON.parse(String(init.body)) as { templateAnswers: HistoryTemplateAnswer[] };
      if (historyPosts === 2) return inFlight;
      return json({
        answers: submitted.templateAnswers.map((item) => ({ ...item, observationReference: `Observation/${item.optionCode === "ocular-pain" ? "answer-pain" : item.id}` })),
        templateNarratives: [],
      });
    }
    throw new Error(`Unexpected request: ${init?.method ?? "GET"} ${url}`);
  };
  let renderer!: ReactTestRenderer;
  try {
    await act(async () => {
      renderer = create(<EncounterEditContext.Provider value={{}}><HpiSection patientReference="Patient/p1" encounterReference="Encounter/e1" onSaved={() => undefined} /></EncounterEditContext.Provider>);
      await delay(0);
    });
    await act(async () => {
      renderer.root.findAllByType("button").find((button) => button.children.join("") === "Glaucoma")!.props.onClick();
      await delay(0);
    });
    act(() => renderer.root.findAllByType("button").find((button) => button.children.join("") === "Follow Up")!.props.onClick());
    await act(async () => { await delay(850); });
    assert.equal(historyPosts, 2, "the answer save is in flight");
    act(() => renderer.root.findByProps({ "aria-label": "ocular pain: negative" }).props.onClick());
    assert.deepEqual(voidBodies, [], "the clear waits for the save response to identify the Observation");

    await act(async () => {
      resolveInFlight(json({
        answers: [
          { ...answer("presentation", undefined, { kind: "selection", code: "follow-up" }), observationReference: "Observation/answer-presentation" },
          { ...answer("symptoms", "ocular-pain", { kind: "tri-state", status: "negative" }), observationReference: "Observation/answer-pain" },
        ],
        templateNarratives: [],
      }));
      await delay(0);
      await delay(0);
    });
    assert.deepEqual(voidBodies, [{
      scope: "observation",
      observationReference: "Observation/answer-pain",
      sectionKey: "hpi",
      label: "ocular-pain",
    }]);
  } finally {
    renderer?.unmount();
    globalThis.fetch = originalFetch;
  }
});

test("a failed autosave turns only the History header red with its reason and Retry", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith("/clinical-graph/hpi/definition")) return json({ templates: [TEMPLATE], catalogs: CATALOGS, definition: {} });
    if (url.endsWith("/clinical-graph/encounters/e1/complaints") && init?.method === "POST") return json({ complaints: [complaint()] });
    if (url.endsWith("/clinical-graph/encounters/e1/complaints")) return json({ complaints: [] });
    if (url.endsWith("/clinical-graph/encounters/e1/hpi")) return json({ answers: [], templateNarratives: [] });
    if (url.endsWith("/clinical-graph/hpi") && init?.method === "POST") {
      return new Response(JSON.stringify({ error: "Synthetic FHIR refusal" }), { status: 503, headers: { "Content-Type": "application/json" } });
    }
    throw new Error(`Unexpected request: ${init?.method ?? "GET"} ${url}`);
  };
  let renderer!: ReactTestRenderer;
  try {
    await act(async () => {
      renderer = create(<HpiSection patientReference="Patient/p1" encounterReference="Encounter/e1" onSaved={() => undefined} />);
      await delay(0);
    });
    await act(async () => {
      renderer.root.findAllByType("button").find((button) => button.children.join("") === "Glaucoma")!.props.onClick();
      await delay(0);
    });
    act(() => renderer.root.findAllByType("button").find((button) => button.children.join("") === "Follow Up")!.props.onClick());
    await act(async () => { await delay(850); });
    const alert = renderer.root.findByProps({ role: "alert" });
    assert.match(alert.children.join(""), /Synthetic FHIR refusal/);
    assert.ok(alert.findAllByType("button").some((button) => button.children.join("") === "Retry"));
    assert.match(renderer.root.findByType("header").props.className, /border-red/);
  } finally {
    renderer?.unmount();
    globalThis.fetch = originalFetch;
  }
});

test("the renderer contains no complaint-specific branch and no final-status write", () => {
  const source = readFileSync(new URL("../src/components/charting/HpiSection.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(source, /template\.complaint\s*===|complaintKey\s*===/);
  assert.doesNotMatch(source, /status:\s*["']final["']/);
  assert.doesNotMatch(source, /Save Complaint|Save reviewed ROS|Save and Add Another/);
});

function complaint() {
  return {
    id: "complaint-1", encounterId: "e1", patientId: "p1", ordinal: 1, templateKey: "glaucoma",
    complaintKey: "glaucoma", conditions: [], eyeLocation: "not-applicable", qualities: [],
    treatmentsTried: [], additionalHistory: "", narrative: { mode: "automated" }, resolvedDx: [],
    status: "active", renderedNarrative: "Glaucoma history not yet recorded.",
  };
}

function answer(sectionId: string, optionCode: string | undefined, value: HistoryTemplateAnswer["value"]): HistoryTemplateAnswer {
  return { id: `answer-${sectionId}-${optionCode ?? "value"}`, complaintId: "complaint-1", templateKey: "glaucoma", sectionId, ...(optionCode ? { optionCode } : {}), value };
}

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
