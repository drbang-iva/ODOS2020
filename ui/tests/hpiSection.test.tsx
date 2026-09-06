import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import {
  HpiSection,
  HistorySubjectSectionEditor,
  HistoryTemplateEditor,
  cycleHistoryTriState,
  historySectionComplete,
  historyComplaintState,
  type HistoryCatalogs,
  type HistoryTemplate,
  type HistoryTemplateAnswer,
  type HistorySubjectSection,
} from "../src/components/charting/HpiSection";
import { EncounterEditContext } from "../src/components/charting/encounter-edit-context";
import { buildHistoryAnswerObservation, parseHistoryAnswerObservation } from "../../mcp/src/clinical-graph/history-answer-observation.js";

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
    ]);
    assert.equal(renderer.root.findByProps({ "aria-label": "ocular pain: suggested from last visit" }).children.join(""), "no ocular pain");
    assert.ok(renderer.root.findByProps({ "aria-label": "IOP check: suggested from last visit" }));
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
  let inFlightAnswers: HistoryTemplateAnswer[] = [];
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
      if (historyPosts === 3) {
        inFlightAnswers = submitted.templateAnswers;
        return inFlight;
      }
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
    act(() => renderer.root.findByProps({ "aria-label": "ocular pain: suggested from last visit" }).props.onClick());
    await act(async () => { await delay(850); });
    assert.equal(historyPosts, 3, "the answer save is in flight");
    act(() => renderer.root.findByProps({ "aria-label": "ocular pain: negative" }).props.onClick());
    assert.deepEqual(voidBodies, [], "the clear waits for the save response to identify the Observation");

    await act(async () => {
      resolveInFlight(json({
        answers: inFlightAnswers.map((item) => ({ ...item, observationReference: "Observation/answer-pain" })),
        templateNarratives: [],
      }));
      await delay(0);
      await delay(25);
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

test("changing presentation voids follow-up-only answers before autosaving the new path", async () => {
  const originalFetch = globalThis.fetch;
  const submittedAnswers: HistoryTemplateAnswer[][] = [];
  const voidBodies: Array<{ scope?: string; observationReference?: string | string[] }> = [];
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith("/clinical-graph/hpi/definition")) return json({ templates: [TEMPLATE], catalogs: CATALOGS, definition: {} });
    if (url.endsWith("/clinical-graph/encounters/e1/complaints")) return json({ complaints: [complaint()] });
    if (url.endsWith("/clinical-graph/encounters/e1/hpi")) return json({
      answers: [
        { ...answer("presentation", undefined, { kind: "selection", code: "follow-up" }), observationReference: "Observation/answer-presentation" },
        { ...answer("interval", undefined, { kind: "interval", code: "same", note: "Stable" }), observationReference: "Observation/answer-interval" },
      ],
      followUpPrefills: [],
      templateNarratives: [],
    });
    if (url.endsWith("/clinical-graph/encounters/e1/void") && init?.method === "POST") {
      voidBodies.push(JSON.parse(String(init.body)) as { scope?: string; observationReference?: string | string[] });
      return json({ voided: ["Observation/answer-interval"], count: 1, sections: [], entries: [], preview: false });
    }
    if (url.endsWith("/clinical-graph/hpi") && init?.method === "POST") {
      const submitted = JSON.parse(String(init.body)) as { templateAnswers: HistoryTemplateAnswer[] };
      submittedAnswers.push(submitted.templateAnswers);
      return json({ answers: submitted.templateAnswers, templateNarratives: [] });
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
      renderer.root.findAllByType("button").find((button) => button.children.join("") === "Pressure Check")!.props.onClick();
      await delay(0);
    });
    await act(async () => { await delay(850); });

    assert.deepEqual(voidBodies, [{
      scope: "observation",
      observationReference: ["Observation/answer-interval"],
      sectionKey: "hpi",
      label: "Follow-up details",
    }]);
    assert.equal(submittedAnswers.at(-1)?.some((item) => item.sectionId === "interval"), false);
    assert.equal((submittedAnswers.at(-1)?.find((item) => item.sectionId === "presentation")?.value as { code?: string })?.code, "pressure-check");
  } finally {
    renderer?.unmount();
    globalThis.fetch = originalFetch;
  }
});

test("typed selects expose a disabled prompt instead of an unconfirmed clear action", () => {
  const html = renderToStaticMarkup(<HistoryTemplateEditor
    complaintId="complaint-1"
    template={TEMPLATE}
    catalogs={CATALOGS}
    answers={[answer("presentation", undefined, { kind: "selection", code: "follow-up" })]}
    narrative=""
    editMode={false}
    onChange={() => undefined}
    onRemoveTyped={() => undefined}
  />);
  assert.doesNotMatch(html, /<option value="">Not recorded<\/option>/);
  assert.match(html, /<option value="" disabled="" selected="">Select…<\/option>/);
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

test("Ocular History renders from its declaration, including catalog-owned laterality and positive notes", () => {
  const declaration: HistorySubjectSection = {
    key: "ocular-history",
    label: "Ocular History",
    subjectScope: "patient",
    completionAnchor: "conditions",
    sections: [{ id: "conditions", type: "risk_factors", label: "Conditions", catalog: "ocular_conditions", required: true }],
  };
  const catalogs: HistoryCatalogs = {
    ocular_conditions: [
      { code: "strabismus", display: "Strabismus", per_eye: false, note_on_positive: true },
      { code: "keratoconus", display: "Keratoconus", per_eye: true, note_on_positive: true },
    ],
  };
  const html = renderToStaticMarkup(<HistorySubjectSectionEditor
    encounterId="e1"
    declaration={declaration}
    catalogs={catalogs}
    answers={[{
      id: "history-e1-ocular-history-conditions-keratoconus-OD",
      subjectScope: "patient",
      templateKey: "ocular-history",
      sectionId: "conditions",
      optionCode: "keratoconus",
      eye: "OD",
      value: { kind: "tri-state", status: "positive", note: "Diagnosed 2022" },
    }]}
    editMode={false}
    onChange={() => undefined}
    onRemoveTyped={() => undefined}
  />);

  assert.match(html, /Strabismus/);
  assert.match(html, /Keratoconus OD: positive/);
  assert.match(html, /Keratoconus OS: unasked/);
  assert.match(html, /Keratoconus OD note/);
  assert.match(html, /Diagnosed 2022/);
});

test("a declared single-select replaces one answer and then clears that same answer", () => {
  const declaration: HistorySubjectSection = {
    key: "social-history",
    label: "Social History",
    subjectScope: "patient",
    completionAnchor: "tobacco",
    sections: [{ id: "tobacco", type: "single_select", label: "Tobacco", catalog: "tobacco_status", required: true }],
  };
  const catalogs: HistoryCatalogs = {
    tobacco_status: [
      { code: "never", display: "Never" },
      { code: "former-smoker", display: "Former smoker" },
      { code: "current", display: "Current" },
    ],
  };
  const changes: Array<{ next: HistoryTemplateAnswer | undefined; prior: HistoryTemplateAnswer | undefined }> = [];
  let answers: HistoryTemplateAnswer[] = [];
  const props = () => ({
    encounterId: "e1",
    declaration,
    catalogs,
    answers,
    editMode: false,
    onChange: (next: HistoryTemplateAnswer | undefined, prior: HistoryTemplateAnswer | undefined) => changes.push({ next, prior }),
    onRemoveTyped: () => undefined,
  });
  const renderer = create(<HistorySubjectSectionEditor {...props()} />);

  act(() => renderer.root.findByProps({ "aria-label": "Current: unselected" }).props.onClick());
  const current = changes.at(-1)?.next;
  assert.deepEqual(current, {
    id: "history-e1-social-history-tobacco-value",
    subjectScope: "patient",
    templateKey: "social-history",
    sectionId: "tobacco",
    value: { kind: "selection", code: "current" },
  });

  answers = [current!];
  act(() => renderer.update(<HistorySubjectSectionEditor {...props()} />));
  act(() => renderer.root.findByProps({ "aria-label": "Former smoker: unselected" }).props.onClick());
  const former = changes.at(-1);
  assert.equal(former?.prior?.id, current?.id);
  assert.equal(former?.next?.id, current?.id);
  assert.deepEqual(former?.next?.value, { kind: "selection", code: "former-smoker" });

  answers = [former!.next!];
  act(() => renderer.update(<HistorySubjectSectionEditor {...props()} />));
  act(() => renderer.root.findByProps({ "aria-label": "Former smoker: selected" }).props.onClick());
  assert.equal(changes.at(-1)?.next, undefined);
  assert.equal(changes.at(-1)?.prior?.id, current?.id);
  renderer.unmount();
});

test("Family History keeps a three-state relative value per condition and removes an empty row", () => {
  const declaration: HistorySubjectSection = {
    key: "family-history",
    label: "Family History",
    subjectScope: "patient",
    completionAnchor: "conditions",
    sections: [{
      id: "conditions",
      type: "family_conditions",
      label: "Conditions",
      catalog: "family_conditions",
      relations: "family_relations",
      required: true,
    }],
  };
  const catalogs: HistoryCatalogs = {
    family_conditions: [{ code: "glaucoma", display: "Glaucoma" }],
    family_relations: [
      { code: "mother", display: "Mother" },
      { code: "father", display: "Father" },
      { code: "sister", display: "Sister" },
    ],
  };
  const changes: Array<{ next: HistoryTemplateAnswer | undefined; prior: HistoryTemplateAnswer | undefined }> = [];
  let answers: HistoryTemplateAnswer[] = [];
  const props = () => ({
    encounterId: "e1",
    declaration,
    catalogs,
    answers,
    editMode: false,
    onChange: (next: HistoryTemplateAnswer | undefined, prior: HistoryTemplateAnswer | undefined) => changes.push({ next, prior }),
    onRemoveTyped: () => undefined,
  });
  const renderer = create(<HistorySubjectSectionEditor {...props()} />);
  const click = (label: string) => {
    act(() => renderer.root.findByProps({ "aria-label": label }).props.onClick());
    const next = changes.at(-1)?.next;
    answers = next ? [next] : [];
    act(() => renderer.update(<HistorySubjectSectionEditor {...props()} />));
  };

  const father = renderer.root.findByProps({ "aria-label": "Glaucoma Father: unasked" });
  assert.match(father.props.className, /min-h-11/);
  click("Glaucoma Father: unasked");
  click("Glaucoma Mother: unasked");
  assert.match(renderer.root.findAllByType("p").map((node) => node.children.join("")).join(" "), /Glaucoma — mother, father/);
  click("Glaucoma Mother: positive");

  assert.deepEqual(changes.at(-1)?.next?.value, {
    kind: "relations",
    positive: ["father"],
    negative: ["mother"],
  });
  assert.ok(renderer.root.findByProps({ "aria-label": "Glaucoma Sister: unasked" }));

  click("Glaucoma Mother: negative");
  click("Glaucoma Father: positive");
  click("Glaucoma Father: negative");
  assert.equal(changes.at(-1)?.next, undefined, "a condition with no marked relatives is not an answer");
  renderer.unmount();
});

test("Family History restores a persisted relation note in its editor", () => {
  const declaration: HistorySubjectSection = {
    key: "family-history",
    label: "Family History",
    subjectScope: "patient",
    completionAnchor: "conditions",
    sections: [{
      id: "conditions",
      type: "family_conditions",
      label: "Conditions",
      catalog: "family_conditions",
      relations: "family_relations",
      required: true,
    }],
  };
  const renderer = create(<HistorySubjectSectionEditor
    encounterId="e1"
    declaration={declaration}
    catalogs={{
      family_conditions: [{ code: "glaucoma", display: "Glaucoma" }],
      family_relations: [{ code: "father", display: "Father" }, { code: "mother", display: "Mother" }],
    }}
    answers={[{
      id: "family-e1-conditions-glaucoma",
      subjectScope: "patient",
      templateKey: "family-history",
      sectionId: "conditions",
      optionCode: "glaucoma",
      value: { kind: "relations", positive: ["father"], negative: ["mother"], note: "Mother denied disease; father diagnosed at 42." },
    }]}
    editMode={false}
    onChange={() => undefined}
    onRemoveTyped={() => undefined}
  />);

  assert.equal(renderer.root.findByProps({ "aria-label": "Glaucoma note" }).props.value, "Mother denied disease; father diagnosed at 42.");
  renderer.unmount();
});

test("clearing a selected tobacco chip voids its one Observation before saving the empty section", async () => {
  const originalFetch = globalThis.fetch;
  const voidBodies: unknown[] = [];
  const submittedAnswers: HistoryTemplateAnswer[][] = [];
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith("/clinical-graph/hpi/definition")) return json({
      templates: [],
      catalogs: { tobacco_status: [{ code: "current", display: "Current" }] },
      subjectSections: [{
        key: "social-history",
        label: "Social History",
        subjectScope: "patient",
        completionAnchor: "tobacco",
        sections: [{ id: "tobacco", type: "single_select", label: "Tobacco", catalog: "tobacco_status", required: true }],
      }],
      definition: {},
    });
    if (url.endsWith("/clinical-graph/encounters/e1/complaints")) return json({ complaints: [] });
    if (url.endsWith("/clinical-graph/encounters/e1/hpi")) return json({
      answers: [{
        id: "history-e1-social-history-tobacco-value",
        subjectScope: "patient",
        templateKey: "social-history",
        sectionId: "tobacco",
        observationReference: "Observation/today-tobacco",
        value: { kind: "selection", code: "current" },
      }],
      carriedForwardAnswers: [],
      reviewAttestations: [],
      templateNarratives: [],
    });
    if (url.endsWith("/clinical-graph/encounters/e1/void") && init?.method === "POST") {
      voidBodies.push(JSON.parse(String(init.body)));
      return json({ voided: ["Observation/today-tobacco"], count: 1, sections: [], entries: [], preview: false });
    }
    if (url.endsWith("/clinical-graph/hpi") && init?.method === "POST") {
      const submitted = JSON.parse(String(init.body)) as { templateAnswers: HistoryTemplateAnswer[] };
      submittedAnswers.push(submitted.templateAnswers);
      return json({ answers: submitted.templateAnswers, templateNarratives: [] });
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
      renderer.root.findByProps({ "aria-label": "Current: selected" }).props.onClick();
      await delay(0);
      await delay(0);
    });
    assert.deepEqual(voidBodies, [{
      scope: "observation",
      observationReference: "Observation/today-tobacco",
      sectionKey: "social-history",
      label: "current",
    }]);
    assert.deepEqual(submittedAnswers.at(-1), []);
  } finally {
    renderer?.unmount();
    globalThis.fetch = originalFetch;
  }
});

test("Ocular History keeps prior-chart answers distinct and review attestation does not save an edit", async () => {
  const originalFetch = globalThis.fetch;
  let historyPosts = 0;
  let includeTodayEdit = true;
  const reviewBodies: unknown[] = [];
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith("/clinical-graph/hpi/definition")) return json({
      templates: [],
      catalogs: {
        ocular_history_conditions: [{ code: "glaucoma", display: "Glaucoma", per_eye: true, note_on_positive: true }],
        ocular_history_surgeries: [{ code: "cataract-surgery", display: "Cataract surgery", per_eye: true, note_on_positive: true }],
      },
      subjectSections: [{
        key: "ocular-history",
        label: "Ocular History",
        subjectScope: "patient",
        completionAnchor: "conditions",
        sections: [
          { id: "conditions", type: "risk_factors", label: "Conditions", catalog: "ocular_history_conditions", required: true },
          { id: "surgeries", type: "risk_factors", label: "Surgeries", catalog: "ocular_history_surgeries", required: true },
        ],
      }],
      definition: {},
    });
    if (url.endsWith("/clinical-graph/encounters/e1/complaints")) return json({ complaints: [] });
    if (url.endsWith("/clinical-graph/encounters/e1/hpi")) return json({
      answers: includeTodayEdit ? [{
        id: "ocular-e1-surgeries-cataract-surgery-OS",
        subjectScope: "patient",
        templateKey: "ocular-history",
        sectionId: "surgeries",
        optionCode: "cataract-surgery",
        eye: "OS",
        observationReference: "Observation/today-surgery",
        value: { kind: "tri-state", status: "positive" },
      }] : [],
      carriedForwardAnswers: [{
        answer: {
          id: "prior-glaucoma",
          subjectScope: "patient",
          templateKey: "ocular-history",
          sectionId: "conditions",
          optionCode: "glaucoma",
          eye: "OD",
          observationReference: "Observation/prior-glaucoma",
          value: { kind: "tri-state", status: "positive", note: "Diagnosed 2024" },
        },
        encounterReference: "Encounter/prior",
        recordedAt: "2026-08-01T12:00:00.000Z",
      }],
      reviewAttestations: [],
      templateNarratives: [],
    });
    if (url.endsWith("/clinical-graph/history/review") && init?.method === "POST") {
      reviewBodies.push(JSON.parse(String(init.body)));
      return json({
        sectionKey: "ocular-history",
        actorReference: "Practitioner/doc1",
        recordedAt: "2026-09-03T15:00:00.000Z",
        attestationReference: "Observation/review-1",
        priorAnswerReferences: ["Observation/prior-glaucoma"],
      });
    }
    if (url.endsWith("/clinical-graph/hpi") && init?.method === "POST") {
      historyPosts += 1;
      return json({ answers: [], templateNarratives: [], retiredReviewSections: ["ocular-history"] });
    }
    throw new Error(`Unexpected request: ${init?.method ?? "GET"} ${url}`);
  };
  let renderer!: ReactTestRenderer;
  try {
    await act(async () => {
      renderer = create(<EncounterEditContext.Provider value={{}}><HpiSection patientReference="Patient/p1" encounterReference="Encounter/e1" onSaved={() => undefined} /></EncounterEditContext.Provider>);
      await delay(0);
    });
    const chartStrip = renderer.root.findByProps({ "aria-label": "Ocular History on this chart" });
    assert.ok(chartStrip);
    assert.match(JSON.stringify(renderer.toJSON()), /Glaucoma OD/);
    assert.match(JSON.stringify(renderer.toJSON()), /Diagnosed 2024/);
    assert.ok(renderer.root.findByProps({ "aria-label": "Cataract surgery OS: positive" }));
    const noChangeButton = renderer.root.findAllByType("button").find((button) => button.children.join("") === "Reviewed today, no change")!;
    assert.equal(noChangeButton.props.disabled, true);
    assert.equal(historyPosts, 0);
    assert.deepEqual(reviewBodies, []);

    renderer.unmount();
    includeTodayEdit = false;
    await act(async () => {
      renderer = create(<EncounterEditContext.Provider value={{}}><HpiSection patientReference="Patient/p1" encounterReference="Encounter/e1" onSaved={() => undefined} /></EncounterEditContext.Provider>);
      await delay(0);
    });

    await act(async () => {
      renderer.root.findAllByType("button").find((button) => button.children.join("") === "Reviewed today, no change")!.props.onClick();
      await delay(0);
    });
    assert.equal(historyPosts, 0);
    assert.deepEqual(reviewBodies, [{
      patientReference: "Patient/p1",
      encounterReference: "Encounter/e1",
      sectionKey: "ocular-history",
    }]);
    const reviewed = renderer.root.findAllByType("p").find((node) => node.children.join("").includes("Reviewed by"));
    assert.equal(reviewed?.children.join(""), "Reviewed by Practitioner/doc1 · 2026-09-03");

    await act(async () => {
      renderer.root.findByProps({ "aria-label": "Glaucoma OD: unasked" }).props.onClick();
      await delay(850);
    });
    assert.equal(historyPosts, 1);
    assert.equal(renderer.root.findAllByType("p").some((node) => node.children.join("").includes("Reviewed by")), false);
  } finally {
    renderer?.unmount();
    globalThis.fetch = originalFetch;
  }
});

test("a carried-forward single-select displays its catalog choice in the prior-encounter strip", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.endsWith("/clinical-graph/hpi/definition")) return json({
      templates: [],
      catalogs: { tobacco_status: [{ code: "former-smoker", display: "Former smoker" }] },
      subjectSections: [{
        key: "social-history",
        label: "Social History",
        subjectScope: "patient",
        completionAnchor: "tobacco",
        sections: [{ id: "tobacco", type: "single_select", label: "Tobacco", catalog: "tobacco_status", required: true }],
      }],
      definition: {},
    });
    if (url.endsWith("/clinical-graph/encounters/e1/complaints")) return json({ complaints: [] });
    if (url.endsWith("/clinical-graph/encounters/e1/hpi")) return json({
      answers: [],
      carriedForwardAnswers: [{
        answer: {
          id: "prior-tobacco",
          subjectScope: "patient",
          templateKey: "social-history",
          sectionId: "tobacco",
          observationReference: "Observation/prior-tobacco",
          value: { kind: "selection", code: "former-smoker" },
        },
        encounterReference: "Encounter/prior",
        recordedAt: "2026-08-01T12:00:00.000Z",
      }],
      reviewAttestations: [],
      templateNarratives: [],
    });
    throw new Error(`Unexpected request: ${url}`);
  };
  let renderer!: ReactTestRenderer;
  try {
    await act(async () => {
      renderer = create(<EncounterEditContext.Provider value={{}}><HpiSection patientReference="Patient/p1" encounterReference="Encounter/e1" onSaved={() => undefined} /></EncounterEditContext.Provider>);
      await delay(0);
    });
    const chartStrip = renderer.root.findByProps({ "aria-label": "Social History on this chart" });
    assert.match(chartStrip.findByType("li").children.join(""), /^Former smoker/);
  } finally {
    renderer?.unmount();
    globalThis.fetch = originalFetch;
  }
});

test("a carried-forward text section displays its recorded value in the prior-encounter strip", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.endsWith("/clinical-graph/hpi/definition")) return json({
      templates: [],
      catalogs: {},
      subjectSections: [{
        key: "social-history",
        label: "Social History",
        subjectScope: "patient",
        completionAnchor: "tobacco",
        sections: [{ id: "occupation", type: "text", label: "Occupation" }],
      }],
      definition: {},
    });
    if (url.endsWith("/clinical-graph/encounters/e1/complaints")) return json({ complaints: [] });
    if (url.endsWith("/clinical-graph/encounters/e1/hpi")) return json({
      answers: [],
      carriedForwardAnswers: [{
        answer: {
          id: "prior-occupation",
          subjectScope: "patient",
          templateKey: "social-history",
          sectionId: "occupation",
          observationReference: "Observation/prior-occupation",
          value: { kind: "text", text: "Accountant" },
        },
        encounterReference: "Encounter/prior",
        recordedAt: "2026-08-01T12:00:00.000Z",
      }],
      reviewAttestations: [],
      templateNarratives: [],
    });
    throw new Error(`Unexpected request: ${url}`);
  };
  let renderer!: ReactTestRenderer;
  try {
    await act(async () => {
      renderer = create(<EncounterEditContext.Provider value={{}}><HpiSection patientReference="Patient/p1" encounterReference="Encounter/e1" onSaved={() => undefined} /></EncounterEditContext.Provider>);
      await delay(0);
    });
    const chartStrip = renderer.root.findByProps({ "aria-label": "Social History on this chart" });
    assert.match(chartStrip.findByType("li").children.join(""), /^Accountant/);
  } finally {
    renderer?.unmount();
    globalThis.fetch = originalFetch;
  }
});

test("a carried-forward family condition displays its positive relatives in the prior-encounter strip", async () => {
  const observation = buildHistoryAnswerObservation({
    id: "prior-family-glaucoma",
    subjectScope: "patient",
    templateKey: "family-history",
    sectionId: "conditions",
    optionCode: "glaucoma",
    value: { kind: "relations", positive: ["father", "brother"], negative: ["mother"] },
  }, {
    patientReference: "Patient/p1",
    encounterReference: "Encounter/prior",
    recordedAt: "2026-08-01T12:00:00.000Z",
  });
  const restored = parseHistoryAnswerObservation(JSON.parse(JSON.stringify({ ...observation, id: "prior-family-glaucoma" })));
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.endsWith("/clinical-graph/hpi/definition")) return json({
      templates: [],
      catalogs: {
        family_conditions: [{ code: "glaucoma", display: "Glaucoma" }],
        family_relations: [
          { code: "mother", display: "Mother" },
          { code: "father", display: "Father" },
          { code: "brother", display: "Brother" },
        ],
      },
      subjectSections: [{
        key: "family-history",
        label: "Family History",
        subjectScope: "patient",
        completionAnchor: "conditions",
        sections: [{ id: "conditions", type: "family_conditions", label: "Conditions", catalog: "family_conditions", relations: "family_relations", required: true }],
      }],
      definition: {},
    });
    if (url.endsWith("/clinical-graph/encounters/e1/complaints")) return json({ complaints: [] });
    if (url.endsWith("/clinical-graph/encounters/e1/hpi")) return json({
      answers: [],
      carriedForwardAnswers: [{
        answer: restored,
        encounterReference: "Encounter/prior",
        recordedAt: "2026-08-01T12:00:00.000Z",
      }],
      reviewAttestations: [],
      templateNarratives: [],
    });
    throw new Error(`Unexpected request: ${url}`);
  };
  let renderer!: ReactTestRenderer;
  try {
    await act(async () => {
      renderer = create(<EncounterEditContext.Provider value={{}}><HpiSection patientReference="Patient/p1" encounterReference="Encounter/e1" onSaved={() => undefined} /></EncounterEditContext.Provider>);
      await delay(0);
    });
    const chartStrip = renderer.root.findByProps({ "aria-label": "Family History on this chart" });
    assert.match(chartStrip.findByType("li").children.join(""), /^Glaucoma — father, brother/);
    const detail = chartStrip.findByProps({ "aria-label": "Glaucoma family relation details" });
    assert.match(detail.findByType("summary").children.join(""), /Review family details/);
    assert.match(detail.findAllByType("p").map((node) => node.children.join("")).join(" "), /Positive: father, brother/);
    assert.match(detail.findAllByType("p").map((node) => node.children.join("")).join(" "), /Denied: mother/);
  } finally {
    renderer?.unmount();
    globalThis.fetch = originalFetch;
  }
});

test("a carried-forward denial-only family condition exposes the denied relative in review detail", async () => {
  const observation = buildHistoryAnswerObservation({
    id: "prior-family-glaucoma",
    subjectScope: "patient",
    templateKey: "family-history",
    sectionId: "conditions",
    optionCode: "glaucoma",
    value: { kind: "relations", positive: [], negative: ["mother"] },
  }, {
    patientReference: "Patient/p1",
    encounterReference: "Encounter/prior",
    recordedAt: "2026-08-01T12:00:00.000Z",
  });
  const restored = parseHistoryAnswerObservation(JSON.parse(JSON.stringify({ ...observation, id: "prior-family-glaucoma" })));
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.endsWith("/clinical-graph/hpi/definition")) return json({
      templates: [],
      catalogs: {
        family_conditions: [{ code: "glaucoma", display: "Glaucoma" }],
        family_relations: [{ code: "father", display: "Father" }, { code: "mother", display: "Mother" }],
      },
      subjectSections: [{
        key: "family-history",
        label: "Family History",
        subjectScope: "patient",
        completionAnchor: "conditions",
        sections: [{ id: "conditions", type: "family_conditions", label: "Conditions", catalog: "family_conditions", relations: "family_relations", required: true }],
      }],
      definition: {},
    });
    if (url.endsWith("/clinical-graph/encounters/e1/complaints")) return json({ complaints: [] });
    if (url.endsWith("/clinical-graph/encounters/e1/hpi")) return json({
      answers: [],
      carriedForwardAnswers: [{ answer: restored, encounterReference: "Encounter/prior", recordedAt: "2026-08-01T12:00:00.000Z" }],
      reviewAttestations: [],
      templateNarratives: [],
    });
    throw new Error(`Unexpected request: ${url}`);
  };
  let renderer!: ReactTestRenderer;
  try {
    await act(async () => {
      renderer = create(<EncounterEditContext.Provider value={{}}><HpiSection patientReference="Patient/p1" encounterReference="Encounter/e1" onSaved={() => undefined} /></EncounterEditContext.Provider>);
      await delay(0);
    });
    const chartStrip = renderer.root.findByProps({ "aria-label": "Family History on this chart" });
    assert.match(chartStrip.findByType("li").children.join(""), /^Glaucoma/);
    const detail = chartStrip.findByProps({ "aria-label": "Glaucoma family relation details" });
    assert.match(detail.findByType("summary").children.join(""), /Review family details/);
    assert.match(detail.findAllByType("p").map((node) => node.children.join("")).join(" "), /Denied: mother/);
  } finally {
    renderer?.unmount();
    globalThis.fetch = originalFetch;
  }
});

test("a persisted family relations note appears in the prior-encounter strip after read-back", async () => {
  const observation = buildHistoryAnswerObservation({
    id: "prior-family-glaucoma",
    subjectScope: "patient",
    templateKey: "family-history",
    sectionId: "conditions",
    optionCode: "glaucoma",
    value: { kind: "relations", positive: ["father"], negative: ["mother"], note: "Father diagnosed in his forties." },
  }, {
    patientReference: "Patient/p1",
    encounterReference: "Encounter/prior",
    recordedAt: "2026-08-01T12:00:00.000Z",
  });
  const restored = parseHistoryAnswerObservation(JSON.parse(JSON.stringify({ ...observation, id: "prior-family-glaucoma" })));
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.endsWith("/clinical-graph/hpi/definition")) return json({
      templates: [],
      catalogs: {
        family_conditions: [{ code: "glaucoma", display: "Glaucoma" }],
        family_relations: [{ code: "father", display: "Father" }, { code: "mother", display: "Mother" }],
      },
      subjectSections: [{
        key: "family-history",
        label: "Family History",
        subjectScope: "patient",
        completionAnchor: "conditions",
        sections: [{ id: "conditions", type: "family_conditions", label: "Conditions", catalog: "family_conditions", relations: "family_relations", required: true }],
      }],
      definition: {},
    });
    if (url.endsWith("/clinical-graph/encounters/e1/complaints")) return json({ complaints: [] });
    if (url.endsWith("/clinical-graph/encounters/e1/hpi")) return json({
      answers: [],
      carriedForwardAnswers: [{ answer: restored, encounterReference: "Encounter/prior", recordedAt: "2026-08-01T12:00:00.000Z" }],
      reviewAttestations: [],
      templateNarratives: [],
    });
    throw new Error(`Unexpected request: ${url}`);
  };
  let renderer!: ReactTestRenderer;
  try {
    await act(async () => {
      renderer = create(<EncounterEditContext.Provider value={{}}><HpiSection patientReference="Patient/p1" encounterReference="Encounter/e1" onSaved={() => undefined} /></EncounterEditContext.Provider>);
      await delay(0);
    });
    const chartStrip = renderer.root.findByProps({ "aria-label": "Family History on this chart" });
    assert.match(chartStrip.findByType("li").children.join(""), /^Glaucoma — father · Father diagnosed in his forties\./);
  } finally {
    renderer?.unmount();
    globalThis.fetch = originalFetch;
  }
});

test("History completeness uses Not started, Started, and Charted rather than Examined", () => {
  const html = renderToStaticMarkup(<HpiSection patientReference="Patient/p1" encounterReference="Encounter/e1" onSaved={() => undefined} />);
  assert.match(html, /Not started/);
  assert.doesNotMatch(html, /Examined|Not examined/);
});

test("an opened complaint with zero answers remains Not started", () => {
  assert.equal(historyComplaintState([complaint()], [TEMPLATE], []), "not-started");
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

test("delta autosave sends only the changed chip and zero answers for an unmodified section", async () => {
  const originalFetch = globalThis.fetch;
  const presentation = answer("presentation", undefined, { kind: "selection", code: "pressure-check" });
  const pain = answer("symptoms", "ocular-pain", { kind: "tri-state", status: "negative" });
  const submitted: HistoryTemplateAnswer[][] = [];
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith("/hpi/definition")) return json({ templates: [TEMPLATE], catalogs: CATALOGS });
    if (url.endsWith("/complaints")) return json({ complaints: [complaint()] });
    if (url.endsWith("/encounters/e1/hpi")) return json({ answers: [presentation, pain], requiresAggregateRefresh: true });
    if (url.endsWith("/clinical-graph/hpi") && init?.method === "POST") {
      const body = JSON.parse(String(init.body));
      submitted.push(body.templateAnswers);
      return json({ answers: body.templateAnswers.map((row: HistoryTemplateAnswer) => ({ ...row, observationReference: `Observation/${row.id}` })) });
    }
    throw new Error(`Unexpected fetch ${url}`);
  };
  let renderer: ReactTestRenderer | undefined;
  try {
    await act(async () => { renderer = create(<HpiSection patientReference="Patient/p1" encounterReference="Encounter/e1" onSaved={() => undefined} />); await delay(0); });
    assert.deepEqual(submitted, [[]], "aggregate refresh of an unmodified section sends zero answers");
    act(() => renderer!.root.findByProps({ "aria-label": "family history of glaucoma: unasked" }).props.onClick());
    await act(async () => { await delay(850); });
    assert.equal(submitted[1]?.length, 1);
    assert.equal(submitted[1]?.[0]?.optionCode, "family-history");
    assert.equal(renderer!.root.findByProps({ "aria-label": "ocular pain: negative" }).type, "button");
  } finally {
    renderer?.unmount(); globalThis.fetch = originalFetch;
  }
});

test("delta retries retain failed answers and edits made during a save remain pending", async () => {
  const originalFetch = globalThis.fetch;
  const submitted: HistoryTemplateAnswer[][] = [];
  let resolveSave!: (response: Response) => void;
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith("/hpi/definition")) return json({ templates: [TEMPLATE], catalogs: CATALOGS });
    if (url.endsWith("/complaints")) return json({ complaints: [complaint()] });
    if (url.endsWith("/encounters/e1/hpi")) return json({ answers: [answer("presentation", undefined, { kind: "selection", code: "pressure-check" })] });
    if (url.endsWith("/clinical-graph/hpi") && init?.method === "POST") {
      const body = JSON.parse(String(init.body));
      submitted.push(body.templateAnswers);
      if (submitted.length === 1) return new Response(JSON.stringify({ error: "Synthetic save failure" }), { status: 503 });
      if (submitted.length === 2) return new Promise<Response>((resolve) => { resolveSave = resolve; });
      return json({ answers: body.templateAnswers });
    }
    throw new Error(`Unexpected fetch ${url}`);
  };
  let renderer: ReactTestRenderer | undefined;
  try {
    await act(async () => { renderer = create(<HpiSection patientReference="Patient/p1" encounterReference="Encounter/e1" onSaved={() => undefined} />); await delay(0); });
    act(() => renderer!.root.findByProps({ "aria-label": "ocular pain: unasked" }).props.onClick());
    await act(async () => { await delay(850); });
    await act(async () => { renderer!.root.findAllByType("button").find((button) => button.children.join("") === "Retry")!.props.onClick(); await delay(0); });
    assert.deepEqual(submitted[1], submitted[0], "failed delta is retried unchanged");
    act(() => renderer!.root.findByProps({ "aria-label": "ocular pain: positive" }).props.onClick());
    await act(async () => { await delay(850); });
    assert.equal(submitted.length, 2, "later save waits for the in-flight save");
    await act(async () => { resolveSave(json({ answers: submitted[1] })); await delay(0); });
    assert.equal(submitted.length, 3);
    assert.equal(submitted[2]?.length, 1);
    assert.deepEqual(submitted[2]?.[0]?.value, { kind: "tri-state", status: "negative" });
  } finally { renderer?.unmount(); globalThis.fetch = originalFetch; }
});

const FOLLOW_UP_WORKUP_CODES = [
  "iop-check",
  "visual-field",
  "optic-nerve-imaging",
  "gonioscopy",
  "pachymetry",
  "fundus-photos",
  "ocular-exam",
] as const;

const FOLLOW_UP_TEMPLATE: HistoryTemplate = {
  complaint: "glaucoma",
  label: "Glaucoma",
  presentations: "follow_up_presentations",
  sections: [
    { id: "presents-for", type: "presents_for", label: "Today the patient presents for", catalog: "follow_up_workup", required: true, on: "follow-up" },
  ],
  narrative: "declaration-owned",
};

const FOLLOW_UP_CATALOGS: HistoryCatalogs = {
  follow_up_presentations: [{ code: "follow-up", display: "Follow Up" }],
  follow_up_workup: FOLLOW_UP_WORKUP_CODES.map((code) => ({ code, display: code.replaceAll("-", " ") })),
};

function followUpPrefills(): HistoryTemplateAnswer[] {
  return FOLLOW_UP_WORKUP_CODES.map((code) => ({
    id: `answer-presents-for-${code}`,
    complaintId: "complaint-1",
    templateKey: "glaucoma",
    sectionId: "presents-for",
    optionCode: code,
    value: { kind: "tri-state", status: "positive" },
  }));
}

test("a follow-up with seven prefills saves the presentation without a 413", async () => {
  const originalFetch = globalThis.fetch;
  const submitted: HistoryTemplateAnswer[][] = [];
  let refusedStatus: number | undefined;
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith("/hpi/definition")) return json({ templates: [FOLLOW_UP_TEMPLATE], catalogs: FOLLOW_UP_CATALOGS });
    if (url.endsWith("/complaints")) return json({ complaints: [complaint()] });
    if (url.endsWith("/encounters/e1/hpi")) return json({ answers: [], followUpPrefills: followUpPrefills(), templateNarratives: [] });
    if (url.endsWith("/clinical-graph/hpi") && init?.method === "POST") {
      const body = JSON.parse(String(init.body)) as { templateAnswers: HistoryTemplateAnswer[] };
      submitted.push(body.templateAnswers);
      if (body.templateAnswers.length + 1 > 8) {
        refusedStatus = 413;
        return new Response(JSON.stringify({ error: "History save refused: conditional bundles allow at most 8 total entries" }), {
          status: 413,
          headers: { "Content-Type": "application/json" },
        });
      }
      return json({ answers: body.templateAnswers, templateNarratives: [{ complaintId: "complaint-1", narrative: "Follow-up selected." }] });
    }
    throw new Error(`Unexpected fetch ${url}`);
  };
  let renderer: ReactTestRenderer | undefined;
  try {
    await act(async () => { renderer = create(<HpiSection patientReference="Patient/p1" encounterReference="Encounter/e1" onSaved={() => undefined} />); await delay(0); });
    const followUpButton = renderer!.root.findAllByType("button").find((button) => button.children.includes("Follow Up"));
    assert.ok(followUpButton);
    act(() => followUpButton.props.onClick());
    await act(async () => { await delay(850); });
    assert.equal(refusedStatus, undefined, "follow-up save must not hit the 413 bundle guard");
    assert.deepEqual(submitted[0]?.map((answer) => answer.sectionId), ["presentation"]);
    assert.equal(renderer!.root.findAllByProps({ role: "alert" }).length, 0);
    assert.match(renderer!.root.findByProps({ role: "status" }).children.join(""), /saved · just now/i);
  } finally { renderer?.unmount(); globalThis.fetch = originalFetch; }
});

test("untapped follow-up suggestions stay out of requests, persisted answers, narrative, and completeness until one is tapped", async () => {
  const originalFetch = globalThis.fetch;
  const submitted: HistoryTemplateAnswer[][] = [];
  const persisted = new Map<string, HistoryTemplateAnswer>();
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith("/hpi/definition")) return json({ templates: [FOLLOW_UP_TEMPLATE], catalogs: FOLLOW_UP_CATALOGS });
    if (url.endsWith("/complaints")) return json({ complaints: [complaint()] });
    if (url.endsWith("/encounters/e1/hpi")) return json({ answers: [], followUpPrefills: followUpPrefills(), templateNarratives: [] });
    if (url.endsWith("/clinical-graph/hpi") && init?.method === "POST") {
      const body = JSON.parse(String(init.body)) as { templateAnswers: HistoryTemplateAnswer[] };
      submitted.push(body.templateAnswers);
      for (const answer of body.templateAnswers) persisted.set(answer.id, answer);
      const recordedWorkup = [...persisted.values()].find((answer) => answer.sectionId === "presents-for");
      return json({
        answers: body.templateAnswers.map((answer) => ({ ...answer, observationReference: `Observation/${answer.id}` })),
        templateNarratives: [{ complaintId: "complaint-1", narrative: recordedWorkup ? "Follow-up for iop check." : "Follow-up selected." }],
      });
    }
    throw new Error(`Unexpected fetch ${url}`);
  };
  let renderer: ReactTestRenderer | undefined;
  try {
    await act(async () => { renderer = create(<HpiSection patientReference="Patient/p1" encounterReference="Encounter/e1" onSaved={() => undefined} />); await delay(0); });
    const followUpButton = renderer!.root.findAllByType("button").find((button) => button.children.includes("Follow Up"));
    assert.ok(followUpButton);
    act(() => followUpButton.props.onClick());
    await act(async () => { await delay(850); });

    assert.deepEqual(submitted[0]?.map((answer) => answer.sectionId), ["presentation"]);
    assert.equal([...persisted.values()].some((answer) => answer.sectionId === "presents-for"), false);
    assert.doesNotMatch(renderer!.toJSON() ? JSON.stringify(renderer!.toJSON()) : "", /Follow-up for iop check/);
    assert.ok(renderer!.root.findByProps({ "aria-label": "Started" }));
    const suggestion = renderer!.root.findByProps({ "aria-label": "iop check: suggested from last visit" });
    assert.match(suggestion.props.className, /sky/);

    act(() => suggestion.props.onClick());
    await act(async () => { await delay(850); });
    assert.equal(submitted[1]?.length, 1);
    assert.equal(submitted[1]?.[0]?.optionCode, "iop-check");
    assert.equal([...persisted.values()].some((answer) => answer.sectionId === "presents-for" && answer.optionCode === "iop-check"), true);
    assert.match(renderer!.toJSON() ? JSON.stringify(renderer!.toJSON()) : "", /Follow-up for iop check/);
    assert.ok(renderer!.root.findByProps({ "aria-label": "Charted" }));
  } finally { renderer?.unmount(); globalThis.fetch = originalFetch; }
});
