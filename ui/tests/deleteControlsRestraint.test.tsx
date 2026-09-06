import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { test } from "node:test";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import React from "react";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { ClearSectionButton, QUIET_ACTION_CLASS } from "../src/components/charting/ClearControls";
import { ConfirmDestructiveProvider, useConfirmDestructive } from "../src/components/charting/ConfirmDestructive";
import { EncounterEditContext } from "../src/components/charting/encounter-edit-context";
import { EntranceStateSection } from "../src/components/charting/EntranceStateSection";
import { ExamEntrySheet } from "../src/components/charting/ExamEntrySheet";
import { IopSection } from "../src/components/charting/IopSection";
import { EditEntriesToggle, RemoveValueButton, SectionEditingProvider } from "../src/components/charting/section-editing";
import {
  SIGNED_ENCOUNTER_TOOLTIP,
  clearEncounterConfirmSpec,
  clearSectionConfirmSpec,
  removeValueConfirmSpec,
} from "../src/lib/encounter-void";

/**
 * Restraint pass (2026-09-02 design, §8): the delete leaves the resting state, red goes to the
 * confirm. Each guard names the break that must turn it red; the bundle records that break run.
 *
 * What these guards can and cannot see: react-test-renderer has no layout and no computed style,
 * so "red" is asserted on the rendered class strings AND on the stylesheet's rules for the
 * feature's selectors — the two inputs a browser combines into the computed colour. The §6
 * before/after browser count is the computed-style check and lives in the bundle, not here.
 */

const ENCOUNTER = "Encounter/e1";
const UI_SRC = fileURLToPath(new URL("../src/", import.meta.url));
const CHARTING_CSS = readFileSync(join(UI_SRC, "styles/charting.css"), "utf8");

const PUPILS = {
  stableKey: "entrance:pupils",
  sectionKey: "entrance:pupils",
  display: "Pupils",
  active: true,
  perEye: true,
  normalTemplate: "PERRLA; no RAPD OU",
  allowDeferred: true,
  customFields: [
    { localCode: "CUSTOM_PUPIL_SIZE_BRIGHT", display: "Size — bright", valueType: "number" as const, min: 1, max: 9, step: 0.5, unit: "mm", order: 0, active: true },
  ],
};

const PUPILS_ROWS = [
  { recordedAt: "2026-09-02T09:00:00.000Z", eye: "OD", state: "abnormal", values: [{ label: "Size — bright", value: 4, unit: "mm" }], other: "sluggish", observationReference: "Observation/p-od" },
  { recordedAt: "2026-09-02T09:00:00.000Z", eye: "OS", state: "normal", values: [], normalTemplate: "PERRLA; no RAPD OU", observationReference: "Observation/p-os" },
];

const IOP_ENTRIES = [
  { reference: "Observation/iop-od", sectionKey: "tonometry", findingKey: "intraocular_pressure", laterality: "OD" },
  { reference: "Observation/iop-os", sectionKey: "tonometry", findingKey: "intraocular_pressure", laterality: "OS" },
];

// ---------------------------------------------------------------------------
// Guard 1 — nothing red at rest
// ---------------------------------------------------------------------------

test("guard 1: a charted Pupils sheet and IOP sheet render nothing alert-coloured at rest, with Edit engaged, or in class or stylesheet outside the confirm button", async () => {
  for (const surface of ["pupils", "iop"] as const) {
    const harness = await renderChartedSheet(surface);
    try {
      assert.deepEqual(alertClassNames(harness.renderer), [], `${surface} at rest carries no alert class`);
      await pressEdit(harness.renderer);
      assert.ok(removeButtons(harness.renderer).length > 0, `${surface}: Edit reveals Removes, so the edit state is what is being checked`);
      assert.deepEqual(alertClassNames(harness.renderer), [], `${surface} with Edit engaged carries no alert class`);
    } finally {
      harness.restore();
    }
  }
  // The stylesheet side: the feature's selectors carry no alert colour; only the confirm button does.
  const rules = cssRules(CHARTING_CSS);
  const featureSelectors = [".odos-exam-entry-sheet-heading", ".odos-exam-entry-sheet-clear-all", ".odos-undo-strip", ".odos-chart-bar-undo", ".odos-confirm-keep", ".odos-confirm-dialog", ".odos-confirm-backdrop"];
  const alertRules = rules.filter((rule) => rule.body.includes("--odos-alert") && featureSelectors.some((selector) => rule.selector.includes(selector)));
  assert.deepEqual(alertRules.map((rule) => rule.selector), [], "no feature selector paints alert colour");
  const destroy = rules.find((rule) => rule.selector === ".odos-confirm-destroy");
  assert.ok(destroy && destroy.body.includes("background: var(--odos-alert)"), "the confirm button is the one red thing");
  for (const file of ["components/charting/ClearControls.tsx", "components/charting/section-editing.tsx", "components/charting/UndoStrip.tsx"]) {
    assert.doesNotMatch(readFileSync(join(UI_SRC, file), "utf8"), /odos-alert/, `${file} references no alert colour`);
  }
});

// ---------------------------------------------------------------------------
// Guard 2 — Removes are absent until Edit
// ---------------------------------------------------------------------------

test("guard 2: zero Remove controls at rest; one per recorded value after Edit; none again after Done", async () => {
  for (const [surface, expected] of [["pupils", ["Remove Pupils OD", "Remove Pupils OS"]], ["iop", ["Remove IOP OD", "Remove IOP OS"]]] as const) {
    const harness = await renderChartedSheet(surface);
    try {
      assert.deepEqual(removeLabels(harness.renderer), [], `${surface}: Removes are not in the DOM at rest`);
      const edit = editToggle(harness.renderer);
      assert.ok(edit, `${surface}: Edit is on screen at rest`);
      assert.equal(textOf(edit), "Edit");
      assert.equal(edit.props["aria-pressed"], false);
      await act(async () => { edit.props.onClick(); });
      assert.deepEqual(removeLabels(harness.renderer), [...expected], `${surface}: one Remove per recorded value`);
      for (const remove of removeButtons(harness.renderer)) assert.equal(textOf(remove), "Remove");
      const done = editToggle(harness.renderer)!;
      assert.equal(textOf(done), "Done");
      assert.equal(done.props["aria-pressed"], true);
      await act(async () => { done.props.onClick(); });
      assert.deepEqual(removeLabels(harness.renderer), [], `${surface}: Done folds the Removes away`);
    } finally {
      harness.restore();
    }
  }
});

// ---------------------------------------------------------------------------
// Guard 3 — edit state ends when the section empties
// ---------------------------------------------------------------------------

test("guard 3: removing the section's last recorded value leaves edit state — a value recorded next, in the same mount, opens at rest with Edit, not Done", async () => {
  // The OS row carries no note, so its Remove voids on tap — this guard is about edit state, not the dialog.
  const rows = [PUPILS_ROWS[1]!];
  const harness = await renderChartedSheet("pupils", { pupilsRows: () => rows });
  try {
    await pressEdit(harness.renderer);
    assert.deepEqual(removeLabels(harness.renderer), ["Remove Pupils OS"]);
    rows.length = 0; // once voided, the history re-read finds nothing
    await act(async () => { await removeButtons(harness.renderer)[0]!.props.onClick(); await flush(); });
    assert.ok(harness.voids.some((body) => body.scope === "observation"), "the Remove voided on the server");
    assert.deepEqual(removeLabels(harness.renderer), [], "no Removes remain");
    assert.equal(editToggle(harness.renderer), undefined, "an open encounter with nothing recorded shows no Edit");
    // Record again WITHOUT unmounting: Normal OU → Save Pupils → the history re-read returns a row.
    rows.push(PUPILS_ROWS[0]!);
    await act(async () => { buttonWithText(harness.renderer, "Normal OU")!.props.onClick(); });
    await act(async () => { await buttonWithText(harness.renderer, "Save Pupils")!.props.onClick(); await flush(); });
    assert.ok(harness.saves.length === 1, "the save posted");
    const again = editToggle(harness.renderer);
    assert.ok(again, "Edit returns with the recorded value");
    assert.equal(textOf(again), "Edit", "the section is at rest — edit state ended when it emptied");
    assert.equal(again.props["aria-pressed"], false);
    assert.deepEqual(removeLabels(harness.renderer), [], "no Remove appears beside the fresh value until Edit is pressed again");
  } finally {
    harness.restore();
  }
});

// ---------------------------------------------------------------------------
// Guard 4 — closed encounter shape
// ---------------------------------------------------------------------------

test("guard 4: a signed encounter renders Edit, Clear, and Clear chart present-but-disabled with the amendment tooltip, no Remove, even with nothing recorded", async () => {
  for (const recorded of [true, false]) {
    const harness = await renderChartedSheet("pupils", { encounterStatus: "finished", pupilsRows: () => (recorded ? PUPILS_ROWS : []) });
    try {
      const edit = editToggle(harness.renderer);
      assert.ok(edit, `signed, recorded=${recorded}: Edit is present`);
      assert.equal(edit.props.disabled, true);
      assert.equal(edit.props.title, SIGNED_ENCOUNTER_TOOLTIP);
      assert.equal(edit.props["aria-pressed"], false);
      await act(async () => { edit.props.onClick(); });
      assert.equal(textOf(editToggle(harness.renderer)!), "Edit", "a disabled Edit cannot enter edit state");
      const clear = clearSectionButton(harness.renderer);
      assert.ok(clear, `signed, recorded=${recorded}: Clear is present`);
      assert.equal(clear.props.disabled, true);
      assert.equal(clear.props.title, SIGNED_ENCOUNTER_TOOLTIP);
      const clearChart = buttonWithText(harness.renderer, "Clear chart");
      assert.ok(clearChart, "Clear chart is present in the chrome");
      assert.equal(clearChart.props.disabled, true);
      assert.equal(clearChart.props.title, SIGNED_ENCOUNTER_TOOLTIP);
      assert.deepEqual(removeLabels(harness.renderer), [], "no Remove is rendered on a signed chart");
      assert.deepEqual(harness.voids, [], "nothing reached the server");
    } finally {
      harness.restore();
    }
  }
  // The transition: a section in edit state when the encounter signs underneath it.
  const live = await renderChartedSheet("pupils");
  try {
    await pressEdit(live.renderer);
    assert.deepEqual(removeLabels(live.renderer), ["Remove Pupils OD", "Remove Pupils OS"], "edit state is on");
    await act(async () => { live.rerender("finished"); await flush(); });
    assert.deepEqual(removeLabels(live.renderer), [], "signing removes every Remove without a remount");
    const edit = editToggle(live.renderer);
    assert.ok(edit, "Edit stays present");
    assert.equal(textOf(edit), "Edit", "…and reads Edit, not Done");
    assert.equal(edit.props["aria-pressed"], false);
    assert.equal(edit.props.disabled, true);
    assert.equal(edit.props.title, SIGNED_ENCOUNTER_TOOLTIP);
  } finally {
    live.restore();
  }
});

// ---------------------------------------------------------------------------
// Guard 5 — 44 px
// ---------------------------------------------------------------------------

test("guard 5: Edit, Done, Remove, and Clear carry the 44 px hit box; Clear chart, Keep, and the confirm button get it from the stylesheet", async () => {
  const harness = await renderChartedSheet("pupils");
  try {
    const quiet = () => [editToggle(harness.renderer)!, clearSectionButton(harness.renderer)!, ...removeButtons(harness.renderer)];
    for (const button of quiet()) assert.match(String(button.props.className), /\bmin-h-11\b/, `${textOf(button)} at rest`);
    await pressEdit(harness.renderer);
    assert.ok(removeButtons(harness.renderer).length > 0);
    for (const button of quiet()) assert.match(String(button.props.className), /\bmin-h-11\b/, `${textOf(button)} in edit state`);
  } finally {
    harness.restore();
  }
  const rules = cssRules(CHARTING_CSS);
  for (const selector of [".odos-exam-entry-sheet-heading button", ".odos-confirm-keep,\n.odos-confirm-destroy"]) {
    const rule = rules.find((candidate) => candidate.selector === selector);
    assert.ok(rule, `${selector} has a rule`);
    assert.match(rule.body, /min-height: 44px/, `${selector} is 44 px`);
  }
  assert.match(QUIET_ACTION_CLASS, /\bmin-h-11\b/);
});

// ---------------------------------------------------------------------------
// Guard 6 — the dialog is ours and the red is on the confirm
// ---------------------------------------------------------------------------

test("guard 6: Clear opens an in-app alertdialog — window.confirm is never called — and only the confirm button wears the alert class", async () => {
  const harness = await renderClearInProvider({ previewCount: 6 });
  try {
    assert.equal(findDialog(harness.renderer), undefined, "no dialog before the clinician acts");
    await act(async () => { void clearSectionButton(harness.renderer)!.props.onClick(); await flush(); });
    const dialog = findDialog(harness.renderer);
    assert.ok(dialog, "Clear opened the in-app dialog");
    assert.equal(harness.windowConfirmCalls, 0, "window.confirm was not used");
    assert.equal(textOf(dialog.findByType("h2")), "Clear Pupils?");
    assert.equal(textOf(dialog.findByType("p")), "6 values recorded this visit. You can undo until the chart is signed.");
    const destroy = dialog.findAll((node) => node.type === "button" && String(node.props.className).includes("odos-confirm-destroy"));
    assert.equal(destroy.length, 1, "exactly one confirm button wears the alert class");
    assert.equal(textOf(destroy[0]!), "Clear Pupils");
    const keep = dialog.findAll((node) => node.type === "button" && textOf(node) === "Keep")[0]!;
    assert.doesNotMatch(String(keep.props.className), /odos-confirm-destroy/, "Keep is not red");
    assert.deepEqual(harness.voids, [], "nothing is voided while the dialog is open");
    await act(async () => { destroy[0]!.props.onClick(); await flush(); });
    assert.equal(findDialog(harness.renderer), undefined, "the dialog closes on confirm");
    assert.deepEqual(harness.voids, [{ scope: "section", sectionKey: "entrance:pupils" }], "confirm runs the void");
    assert.equal(harness.cleared, 1);
  } finally {
    harness.restore();
  }
});

// ---------------------------------------------------------------------------
// Guard 7 — Keep is safe
// ---------------------------------------------------------------------------

test("guard 7: the dialog opens with focus on Keep; Escape, the backdrop, and Keep each resolve false and void nothing", async () => {
  const focused: string[] = [];
  const keydownHandlers: Array<(event: KeyboardEvent) => void> = [];
  const dom = installMinimalDocument(keydownHandlers);
  const harness = await renderClearInProvider({
    previewCount: 2,
    createNodeMock: (element) => ({
      focus() { focused.push(String(element.props.className ?? element.type)); },
      querySelectorAll() { return []; },
      parentElement: null,
    }),
  });
  try {
    const open = async () => { await act(async () => { void clearSectionButton(harness.renderer)!.props.onClick(); await flush(); }); assert.ok(findDialog(harness.renderer), "dialog is open"); };
    const closed = (why: string) => { assert.equal(findDialog(harness.renderer), undefined, `${why} closes the dialog`); assert.deepEqual(harness.voids, [], `${why} voids nothing`); assert.equal(harness.cleared, 0); };

    await open();
    assert.equal(focused.at(-1), "odos-confirm-keep", "focus lands on Keep, the safe choice");
    const escape = keydownHandlers.at(-1);
    assert.ok(escape, "the dialog listens for Escape");
    await act(async () => { escape({ key: "Escape", preventDefault() {}, stopPropagation() {} } as unknown as KeyboardEvent); await flush(); });
    closed("Escape");

    await open();
    const backdrop = harness.renderer.root.findAll((node) => node.props.className === "odos-confirm-backdrop")[0]!;
    const target = {};
    await act(async () => { backdrop.props.onClick({ target, currentTarget: target }); await flush(); });
    closed("backdrop click");

    await open();
    // A click that bubbles up from inside the dialog is not a backdrop click.
    const inside = harness.renderer.root.findAll((node) => node.props.className === "odos-confirm-backdrop")[0]!;
    await act(async () => { inside.props.onClick({ target: {}, currentTarget: target }); await flush(); });
    assert.ok(findDialog(harness.renderer), "a click inside the dialog does not dismiss it");
    const keep = findDialog(harness.renderer)!.findAll((node) => node.type === "button" && textOf(node) === "Keep")[0]!;
    await act(async () => { keep.props.onClick(); await flush(); });
    closed("Keep");
  } finally {
    harness.restore();
    dom.restore();
  }
});

// ---------------------------------------------------------------------------
// Guard 8 — copy
// ---------------------------------------------------------------------------

test("guard 8: Clear chart, Clear, Edit, Done, Remove, and Keep render verbatim; the retired strings appear nowhere under ui/src", async () => {
  const harness = await renderChartedSheet("pupils");
  try {
    assert.ok(buttonWithText(harness.renderer, "Clear chart"), "tier 3 reads Clear chart");
    assert.equal(textOf(clearSectionButton(harness.renderer)!), "Clear", "tier 2 reads Clear");
    assert.equal(textOf(editToggle(harness.renderer)!), "Edit");
    await pressEdit(harness.renderer);
    assert.equal(textOf(editToggle(harness.renderer)!), "Done");
    assert.equal(textOf(removeButtons(harness.renderer)[0]!), "Remove");
  } finally {
    harness.restore();
  }
  const keepHarness = await renderClearInProvider({ previewCount: 1 });
  try {
    await act(async () => { void clearSectionButton(keepHarness.renderer)!.props.onClick(); await flush(); });
    const dialog = findDialog(keepHarness.renderer)!;
    assert.ok(dialog.findAll((node) => node.type === "button" && textOf(node) === "Keep")[0], "the safe choice reads Keep");
    assert.equal(textOf(dialog.findByType("p")), "1 value recorded this visit. You can undo until the chart is signed.");
  } finally {
    keepHarness.restore();
  }
  const retired = ["Clear everything charted this visit…", "Clear Auto-refraction / Auto-K", "remain in the record as entered-in-error"];
  for (const file of sourceFiles(UI_SRC)) {
    const text = readFileSync(file, "utf8");
    for (const phrase of retired) assert.doesNotMatch(text, new RegExp(escapeRegExp(phrase)), `${file.slice(UI_SRC.length)} still says "${phrase}"`);
  }
});

test("§3.3 copy: every dialog spec is the final table's wording", () => {
  assert.deepEqual(removeValueConfirmSpec("Pupils OD", "note"), { title: "Remove Pupils · OD?", consequence: "Its note is discarded. You can undo until the chart is signed.", confirmLabel: "Remove" });
  assert.deepEqual(removeValueConfirmSpec("EOM", "abnormal findings"), { title: "Remove EOM?", consequence: "Its abnormal findings are discarded. You can undo until the chart is signed.", confirmLabel: "Remove" });
  assert.deepEqual(removeValueConfirmSpec("dilation note", "chart note"), { title: "Remove dilation note?", consequence: "Its chart note is discarded. You can undo until the chart is signed.", confirmLabel: "Remove" });
  assert.deepEqual(clearSectionConfirmSpec("Pupils", 6), { title: "Clear Pupils?", consequence: "6 values recorded this visit. You can undo until the chart is signed.", confirmLabel: "Clear Pupils" });
  assert.deepEqual(clearSectionConfirmSpec("IOP", 1), { title: "Clear IOP?", consequence: "1 value recorded this visit. You can undo until the chart is signed.", confirmLabel: "Clear IOP" });
  assert.deepEqual(
    clearEncounterConfirmSpec([
      { sectionKey: "entrance:pupils", label: "Pupils", count: 6 },
      { sectionKey: "entrance:cvf", label: "Confrontation fields", count: 4 },
      { sectionKey: "tonometry", label: "IOP", count: 2 },
      { sectionKey: "refraction", label: "Refraction", count: 12 },
      { sectionKey: "history", label: "History", count: 1 },
      { sectionKey: "complaints", label: "Complaints", count: 2 },
      { sectionKey: "diagnoses", label: "Diagnoses", count: 1 },
    ], 28),
    {
      title: "Clear this chart?",
      consequence: "Pupils 6 · Confrontation fields 4 · IOP 2 · Refraction 12 · History 1 · Complaints 2 · Diagnoses 1 — 28 values recorded this visit. You can undo until the chart is signed.",
      confirmLabel: "Clear chart",
    },
  );
});

// ---------------------------------------------------------------------------
// Guard 9 — the fallback still refuses
// ---------------------------------------------------------------------------

test("guard 9: useConfirmDestructive outside a provider always refuses the destructive action", async () => {
  const answers: boolean[] = [];
  function Probe() {
    const confirm = useConfirmDestructive();
    return <button type="button" onClick={async () => { answers.push(await confirm({ title: "Clear Pupils?", consequence: "6 values recorded this visit.", confirmLabel: "Clear Pupils" })); }}>probe</button>;
  }
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  let renderer!: ReactTestRenderer;
  try {
    Reflect.deleteProperty(globalThis, "window");
    renderer = create(<Probe />);
    await act(async () => { await renderer.root.findByType("button").props.onClick(); });
    assert.deepEqual(answers, [false], "no surface at all → refused");

    Object.defineProperty(globalThis, "window", { configurable: true, value: { confirm: () => true } });
    await act(async () => { await renderer.root.findByType("button").props.onClick(); });
    assert.deepEqual(answers, [false, false], "a native confirm cannot approve a destructive action");
  } finally {
    renderer?.unmount();
    if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
    else Reflect.deleteProperty(globalThis, "window");
  }
});

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

type VoidBody = { scope: string; sectionKey?: string | string[]; observationReference?: string | string[]; preview?: boolean };

function chartedFetch(options: {
  pupilsRows: () => unknown[];
  iopEntries: () => typeof IOP_ENTRIES;
  voids: VoidBody[];
  saves: unknown[];
}): typeof fetch {
  return async (input, init) => {
    const url = String(input);
    if (url.includes("/clinical-graph/custom/entrance%3Apupils/history")) return Response.json({ rows: options.pupilsRows() });
    if (url.endsWith("/clinical-graph/custom/entrance%3Apupils") && init?.method === "POST") { options.saves.push(JSON.parse(String(init.body))); return Response.json({}); }
    if (url.endsWith("/clinical-graph/iop/definition")) {
      return Response.json({ definitions: { intraocularPressure: { fields: { method: { options: [{ code: "GAT", display: "GAT", active: true }] } } }, cornealHysteresis: { fields: {} } } });
    }
    if (url.includes("/clinical-graph/iop/history")) return Response.json({ readings: [], cornealHysteresis: [], perEye: { OD: { average: null, tMax: null, count: 0, target: null }, OS: { average: null, tMax: null, count: 0, target: null } }, threshold: 21 });
    if (url.endsWith("/void") && init?.method === "POST") {
      const body = JSON.parse(String(init.body)) as VoidBody;
      if (body.preview) {
        const entries = body.scope === "section" && body.sectionKey === "tonometry" ? options.iopEntries() : [];
        const count = body.scope === "encounter" ? options.pupilsRows().length + options.iopEntries().length : body.scope === "section" && body.sectionKey === "tonometry" ? entries.length : options.pupilsRows().length;
        return Response.json({ voided: [], count, sections: count ? [{ sectionKey: "entrance:pupils", label: "Pupils", count }] : [], preview: true, entries });
      }
      const { preview: _preview, ...rest } = body;
      options.voids.push(rest);
      const references = Array.isArray(body.observationReference) ? body.observationReference : body.observationReference ? [body.observationReference] : [];
      return Response.json({ voided: references, count: references.length || 1, sections: [], preview: false, entries: [] });
    }
    throw new Error(`Unexpected request: ${url}`);
  };
}

async function renderChartedSheet(surface: "pupils" | "iop", options: {
  encounterStatus?: "in-progress" | "finished";
  pupilsRows?: () => unknown[];
  iopEntries?: () => typeof IOP_ENTRIES;
} = {}) {
  const originalFetch = globalThis.fetch;
  const voids: VoidBody[] = [];
  const saves: unknown[] = [];
  globalThis.fetch = chartedFetch({ pupilsRows: options.pupilsRows ?? (() => PUPILS_ROWS), iopEntries: options.iopEntries ?? (() => IOP_ENTRIES), voids, saves });
  const build = (status: "in-progress" | "finished") => (
    <EncounterEditContext.Provider value={{ encounterStatus: status }}>
      <ConfirmDestructiveProvider>
        <ExamEntrySheet sectionId={surface} onCancel={() => undefined} encounterReference={ENCOUNTER} encounterStatus={status} onEncounterCleared={() => undefined}>
          {surface === "pupils"
            ? <EntranceStateSection definition={PUPILS} patientReference="Patient/p1" encounterReference={ENCOUNTER} onSaved={() => undefined} />
            : <IopSection patientReference="Patient/p1" encounterReference={ENCOUNTER} onSaved={() => undefined} />}
        </ExamEntrySheet>
      </ConfirmDestructiveProvider>
    </EncounterEditContext.Provider>
  );
  let renderer!: ReactTestRenderer;
  await act(async () => { renderer = create(build(options.encounterStatus ?? "in-progress")); await flush(); });
  return {
    renderer,
    voids,
    saves,
    /** Same tree, new encounter status — reconciled in place, never remounted. */
    rerender(status: "in-progress" | "finished") { renderer.update(build(status)); },
    restore() { renderer.unmount(); globalThis.fetch = originalFetch; },
  };
}

async function renderClearInProvider(options: { previewCount: number; createNodeMock?: (element: React.ReactElement) => unknown }) {
  const originalFetch = globalThis.fetch;
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const voids: VoidBody[] = [];
  const state = { windowConfirmCalls: 0, cleared: 0 };
  Object.defineProperty(globalThis, "window", { configurable: true, value: { confirm() { state.windowConfirmCalls += 1; return true; } } });
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (!url.endsWith("/void") || init?.method !== "POST") throw new Error(`Unexpected request: ${url}`);
    const body = JSON.parse(String(init.body)) as VoidBody;
    if (body.preview) return Response.json({ voided: [], count: options.previewCount, sections: [{ sectionKey: "entrance:pupils", label: "Pupils", count: options.previewCount }], preview: true, entries: [] });
    const { preview: _preview, ...rest } = body;
    voids.push(rest);
    return Response.json({ voided: [], count: options.previewCount, sections: [], preview: false, entries: [] });
  };
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(
      <EncounterEditContext.Provider value={{ encounterStatus: "in-progress" }}>
        <ConfirmDestructiveProvider>
          <ClearSectionButton encounterReference={ENCOUNTER} sectionKey="entrance:pupils" label="Pupils" hasRecorded onCleared={() => { state.cleared += 1; }} />
        </ConfirmDestructiveProvider>
      </EncounterEditContext.Provider>,
      options.createNodeMock ? { createNodeMock: options.createNodeMock } : undefined,
    );
    await flush();
  });
  return {
    renderer,
    voids,
    get windowConfirmCalls() { return state.windowConfirmCalls; },
    get cleared() { return state.cleared; },
    restore() {
      renderer.unmount();
      globalThis.fetch = originalFetch;
      if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
      else Reflect.deleteProperty(globalThis, "window");
    },
  };
}

/** `useDockedPanel` touches `document` and `HTMLElement` when a ref is present; give it the least it needs. */
function installMinimalDocument(keydownHandlers: Array<(event: KeyboardEvent) => void>) {
  const originalDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
  const originalElement = Object.getOwnPropertyDescriptor(globalThis, "HTMLElement");
  Object.defineProperty(globalThis, "HTMLElement", { configurable: true, value: class {} });
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: {
      activeElement: null,
      addEventListener(type: string, handler: (event: KeyboardEvent) => void) { if (type === "keydown") keydownHandlers.push(handler); },
      removeEventListener(type: string, handler: (event: KeyboardEvent) => void) { const index = keydownHandlers.indexOf(handler); if (type === "keydown" && index >= 0) keydownHandlers.splice(index, 1); },
    },
  });
  return {
    restore() {
      if (originalDocument) Object.defineProperty(globalThis, "document", originalDocument); else Reflect.deleteProperty(globalThis, "document");
      if (originalElement) Object.defineProperty(globalThis, "HTMLElement", originalElement); else Reflect.deleteProperty(globalThis, "HTMLElement");
    },
  };
}

function editToggle(renderer: ReactTestRenderer): ReactTestInstance | undefined {
  return renderer.root.findAll((node) => node.type === "button" && typeof node.props["aria-pressed"] === "boolean" && ["Edit", "Done"].includes(textOf(node)))[0];
}

async function pressEdit(renderer: ReactTestRenderer): Promise<void> {
  const toggle = editToggle(renderer);
  assert.ok(toggle, "Edit is on screen");
  assert.equal(textOf(toggle), "Edit");
  await act(async () => { toggle.props.onClick(); });
}

/** Compare labels, never instances: a failing deepEqual on a ReactTestInstance serialises the whole fibre tree. */
function removeLabels(renderer: ReactTestRenderer): string[] {
  return removeButtons(renderer).map((node) => String(node.props["aria-label"]));
}

function removeButtons(renderer: ReactTestRenderer): ReactTestInstance[] {
  return renderer.root.findAll((node) => node.type === "button" && typeof node.props["aria-label"] === "string" && node.props["aria-label"].startsWith("Remove "));
}

function clearSectionButton(renderer: ReactTestRenderer): ReactTestInstance | undefined {
  return renderer.root.findAllByType(ClearSectionButton)[0]?.findAllByType("button")[0];
}

function buttonWithText(renderer: ReactTestRenderer, text: string): ReactTestInstance | undefined {
  return renderer.root.findAll((node) => node.type === "button" && textOf(node) === text)[0];
}

function findDialog(renderer: ReactTestRenderer): ReactTestInstance | undefined {
  return renderer.root.findAll((node) => node.props.role === "alertdialog")[0];
}

function alertClassNames(renderer: ReactTestRenderer): string[] {
  return renderer.root.findAll((node) => typeof node.type === "string" && String(node.props.className ?? "").includes("odos-alert"))
    .map((node) => `${node.type}.${node.props.className}`);
}

function cssRules(css: string): Array<{ selector: string; body: string }> {
  const rules: Array<{ selector: string; body: string }> = [];
  const stripped = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const pattern = /([^{}]+)\{([^{}]*)\}/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(stripped))) {
    const selector = match[1]!.trim().replace(/^@media[^\n]*\n\s*/, "");
    rules.push({ selector, body: match[2]!.trim() });
  }
  return rules;
}

function sourceFiles(root: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(root)) {
    const path = join(root, entry);
    if (statSync(path).isDirectory()) files.push(...sourceFiles(path));
    else if (/\.(tsx?|css)$/.test(entry)) files.push(path);
  }
  return files;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function textOf(node: ReactTestInstance): string {
  return node.children.map((child) => typeof child === "string" ? child : textOf(child)).join("");
}

async function flush(): Promise<void> {
  for (let index = 0; index < 4; index += 1) {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
}
