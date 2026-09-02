import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import React from "react";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import {
  ClearEncounterButton,
  ClearSectionButton,
  RemoveValueButton,
} from "../src/components/charting/ClearControls";
import { EncounterEditContext } from "../src/components/charting/encounter-edit-context";
import { ExamEntrySheet } from "../src/components/charting/ExamEntrySheet";
import { RefractionSection } from "../src/components/charting/RefractionSection";
import {
  SIGNED_ENCOUNTER_TOOLTIP,
  clearEncounterConfirmMessage,
  clearSectionConfirmMessage,
  isClosedEncounterStatus,
  previewEncounterVoid,
  voidEncounterEntries,
  type EncounterVoidResult,
} from "../src/lib/encounter-void";

const ENCOUNTER = "Encounter/e1";

// ---------------------------------------------------------------------------
// The void client
// ---------------------------------------------------------------------------

test("voidEncounterEntries posts the scope to the encounter void endpoint and returns the server's summary", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    calls.push({ url: String(input), init });
    return Response.json({ voided: ["Observation/o1"], count: 1, sections: [{ sectionKey: "entrance:pupils", label: "Pupils", count: 1 }], preview: false });
  };
  const result = await voidEncounterEntries(ENCOUNTER, { scope: "section", sectionKey: "entrance:pupils" }, { fetchImpl });
  assert.equal(result.count, 1);
  assert.equal(calls.length, 1);
  assert.match(calls[0]!.url, /\/clinical-graph\/encounters\/e1\/void$/);
  assert.equal(calls[0]!.init?.method, "POST");
  assert.deepEqual(JSON.parse(String(calls[0]!.init?.body)), { scope: "section", sectionKey: "entrance:pupils" });
});

test("previewEncounterVoid sends preview: true and surfaces the server error on failure", async () => {
  const bodies: unknown[] = [];
  const fetchImpl: typeof fetch = async (_input, init) => {
    bodies.push(JSON.parse(String(init?.body)));
    return Response.json({ error: "Signed or closed encounters cannot be edited.", code: "encounter-closed" }, { status: 409 });
  };
  await assert.rejects(
    () => previewEncounterVoid(ENCOUNTER, { scope: "encounter" }, fetchImpl),
    /Signed or closed encounters cannot be edited/,
  );
  assert.deepEqual(bodies, [{ scope: "encounter", preview: true }]);
});

test("isClosedEncounterStatus mirrors the server's sign gate", () => {
  assert.equal(isClosedEncounterStatus("finished"), true);
  assert.equal(isClosedEncounterStatus("cancelled"), true);
  assert.equal(isClosedEncounterStatus("entered-in-error"), true);
  assert.equal(isClosedEncounterStatus("in-progress"), false);
  assert.equal(isClosedEncounterStatus(undefined), false);
});

test("confirm copy names the count and, for the visit, every section", () => {
  assert.equal(
    clearSectionConfirmMessage("Pupils", 6),
    "Clear Pupils — voids 6 recorded values from this visit. They remain in the record as entered-in-error. Continue?",
  );
  assert.equal(
    clearSectionConfirmMessage("Pupils", 1),
    "Clear Pupils — voids 1 recorded value from this visit. They remain in the record as entered-in-error. Continue?",
  );
  assert.equal(
    clearEncounterConfirmMessage([
      { sectionKey: "entrance:pupils", label: "Pupils", count: 6 },
      { sectionKey: "refraction", label: "Refraction", count: 4 },
      { sectionKey: "complaints", label: "Complaints", count: 2 },
    ], 12),
    "Clear everything charted for this visit — Pupils (6), Refraction (4), Complaints (2): 12 recorded values. They remain in the record as entered-in-error. Continue?",
  );
});

// ---------------------------------------------------------------------------
// Tier 2 — Clear section
// ---------------------------------------------------------------------------

test("Clear section stays hidden while the section has nothing recorded", async () => {
  const harness = await renderInEncounter(
    <ClearSectionButton encounterReference={ENCOUNTER} sectionKey="entrance:pupils" label="Pupils" hasRecorded={false} onCleared={() => undefined} />,
    { previewCount: 0 },
  );
  try {
    assert.equal(findClearButton(harness.renderer.root, "Clear Pupils"), undefined);
    assert.deepEqual(harness.requests, [], "an unrecorded section never talks to the server");
  } finally {
    harness.restore();
  }
});

test("Clear section previews the count, confirms with it, voids, and reports the result", async () => {
  const cleared: EncounterVoidResult[] = [];
  const harness = await renderInEncounter(
    <ClearSectionButton encounterReference={ENCOUNTER} sectionKey="entrance:pupils" label="Pupils" hasRecorded onCleared={(result) => cleared.push(result)} />,
    { previewCount: 6 },
  );
  try {
    const button = findClearButton(harness.renderer.root, "Clear Pupils");
    assert.ok(button, "the control appears once the section has recorded values");
    assert.equal(button.props.disabled, undefined);
    assert.deepEqual(harness.requests, [], "nothing is fetched until the clinician acts");
    harness.confirmAnswer = true;
    await act(async () => { await button.props.onClick(); });
    assert.deepEqual(harness.confirmations, [clearSectionConfirmMessage("Pupils", 6)]);
    assert.deepEqual(harness.requests.map((request) => request.body), [
      { scope: "section", sectionKey: "entrance:pupils", preview: true },
      { scope: "section", sectionKey: "entrance:pupils" },
    ]);
    assert.equal(cleared.length, 1);
    assert.equal(cleared[0]?.count, 6);
  } finally {
    harness.restore();
  }
});

test("Clear section does nothing when the clinician declines the confirm", async () => {
  let clearedCount = 0;
  const harness = await renderInEncounter(
    <ClearSectionButton encounterReference={ENCOUNTER} sectionKey="entrance:pupils" label="Pupils" hasRecorded onCleared={() => { clearedCount += 1; }} />,
    { previewCount: 2 },
  );
  try {
    harness.confirmAnswer = false;
    await act(async () => { await findClearButton(harness.renderer.root, "Clear Pupils")!.props.onClick(); });
    assert.equal(harness.confirmations.length, 1);
    assert.equal(harness.requests.filter((request) => !(request.body as { preview?: boolean }).preview).length, 0);
    assert.equal(clearedCount, 0);
  } finally {
    harness.restore();
  }
});

test("Clear section renders present-but-disabled with the amendment tooltip once the encounter is signed", async () => {
  const harness = await renderInEncounter(
    <ClearSectionButton encounterReference={ENCOUNTER} sectionKey="entrance:pupils" label="Pupils" hasRecorded={false} onCleared={() => undefined} />,
    { previewCount: 6, encounterStatus: "finished" },
  );
  try {
    const button = findClearButton(harness.renderer.root, "Clear Pupils");
    assert.ok(button);
    assert.equal(button.props.disabled, true);
    assert.equal(button.props.title, SIGNED_ENCOUNTER_TOOLTIP);
    assert.equal(harness.requests.length, 0, "a signed encounter is not previewed");
    await act(async () => { await button.props.onClick(); });
    assert.equal(harness.requests.length, 0, "a disabled control never reaches the server");
  } finally {
    harness.restore();
  }
});

// ---------------------------------------------------------------------------
// Tier 1 — × on a recorded value
// ---------------------------------------------------------------------------

test("Remove × confirms only when typed detail would be lost", async () => {
  const removed: string[] = [];
  const harness = await renderInEncounter(
    <>
      <RemoveValueButton label="Reactivity OD" onRemove={() => { removed.push("plain"); }} />
      <RemoveValueButton label="Reactivity OS" confirmMessage="Removing Reactivity OS discards its note. Continue?" onRemove={() => { removed.push("detailed"); }} />
    </>,
    { previewCount: 0 },
  );
  try {
    const plain = harness.renderer.root.findAll((node) => node.type === "button" && node.props["aria-label"] === "Remove Reactivity OD")[0]!;
    const detailed = harness.renderer.root.findAll((node) => node.type === "button" && node.props["aria-label"] === "Remove Reactivity OS")[0]!;
    await act(async () => { await plain.props.onClick(); });
    assert.deepEqual(harness.confirmations, []);
    harness.confirmAnswer = false;
    await act(async () => { await detailed.props.onClick(); });
    assert.deepEqual(harness.confirmations, ["Removing Reactivity OS discards its note. Continue?"]);
    assert.deepEqual(removed, ["plain"]);
    harness.confirmAnswer = true;
    await act(async () => { await detailed.props.onClick(); });
    assert.deepEqual(removed, ["plain", "detailed"]);
  } finally {
    harness.restore();
  }
});

test("Remove × is disabled with the amendment tooltip once the encounter is signed", async () => {
  const harness = await renderInEncounter(
    <RemoveValueButton label="Reactivity OD" onRemove={() => undefined} />,
    { previewCount: 0, encounterStatus: "finished" },
  );
  try {
    const button = harness.renderer.root.findAll((node) => node.type === "button" && node.props["aria-label"] === "Remove Reactivity OD")[0]!;
    assert.equal(button.props.disabled, true);
    assert.equal(button.props.title, SIGNED_ENCOUNTER_TOOLTIP);
  } finally {
    harness.restore();
  }
});

// ---------------------------------------------------------------------------
// Tier 3 — the entry-sheet chrome
// ---------------------------------------------------------------------------

test("the entry sheet chrome carries Clear everything charted this visit left of Cancel, from any section", async () => {
  const cleared: EncounterVoidResult[] = [];
  const harness = await renderInEncounter(
    <ExamEntrySheet
      sectionId="pupils"
      onCancel={() => undefined}
      encounterReference={ENCOUNTER}
      encounterStatus="in-progress"
      onEncounterCleared={(result) => cleared.push(result)}
    >
      <div>sheet body</div>
    </ExamEntrySheet>,
    {
      previewCount: 31,
      previewSections: [
        { sectionKey: "entrance:pupils", label: "Pupils", count: 6 },
        { sectionKey: "refraction", label: "Refraction", count: 4 },
        { sectionKey: "complaints", label: "Complaints", count: 2 },
      ],
    },
  );
  try {
    const heading = harness.renderer.root.findAll((node) => node.type === "header" && node.props.className === "odos-exam-entry-sheet-heading")[0]!;
    const buttons = heading.findAllByType("button");
    const labels = buttons.map((button) => textOf(button));
    assert.deepEqual(labels, ["Clear everything charted this visit…", "Cancel"], "tier 3 sits left of Cancel in the chrome");
    const clearAll = buttons[0]!;
    assert.equal(clearAll.props["data-entry-sheet-chrome"], true);
    assert.equal(clearAll.props.disabled, undefined);
    harness.confirmAnswer = true;
    await act(async () => { await clearAll.props.onClick(); });
    assert.deepEqual(harness.confirmations, [
      "Clear everything charted for this visit — Pupils (6), Refraction (4), Complaints (2): 31 recorded values. They remain in the record as entered-in-error. Continue?",
    ]);
    assert.deepEqual(harness.requests.map((request) => request.body), [
      { scope: "encounter", preview: true },
      { scope: "encounter" },
    ]);
    assert.equal(cleared.length, 1);
    assert.equal(cleared[0]?.count, 31);
  } finally {
    harness.restore();
  }
});

test("the visit-level control is disabled with the amendment tooltip after sign and absent from non-clinical sheets", async () => {
  const signed = await renderInEncounter(
    <ExamEntrySheet sectionId="cvf" onCancel={() => undefined} encounterReference={ENCOUNTER} encounterStatus="finished" onEncounterCleared={() => undefined}>
      <div>body</div>
    </ExamEntrySheet>,
    { previewCount: 3, encounterStatus: "finished" },
  );
  try {
    const button = signed.renderer.root.findAllByType(ClearEncounterButton)[0]?.findAllByType("button")[0];
    assert.ok(button);
    assert.equal(button.props.disabled, true);
    assert.equal(button.props.title, SIGNED_ENCOUNTER_TOOLTIP);
  } finally {
    signed.restore();
  }
  const charges = await renderInEncounter(
    <ExamEntrySheet sectionId="visit-charges" onCancel={() => undefined} encounterReference={ENCOUNTER} encounterStatus="in-progress" onEncounterCleared={() => undefined}>
      <div>body</div>
    </ExamEntrySheet>,
    { previewCount: 3 },
  );
  try {
    assert.equal(charges.renderer.root.findAllByType(ClearEncounterButton).length, 0, "the visit-charges sheet writes no chart entries");
  } finally {
    charges.restore();
  }
});

test("an empty visit tells the clinician there is nothing to clear instead of confirming", async () => {
  const harness = await renderInEncounter(
    <ExamEntrySheet sectionId="pupils" onCancel={() => undefined} encounterReference={ENCOUNTER} encounterStatus="in-progress" onEncounterCleared={() => undefined}>
      <div>body</div>
    </ExamEntrySheet>,
    { previewCount: 0, previewSections: [] },
  );
  try {
    const clearAll = harness.renderer.root.findAllByType(ClearEncounterButton)[0]!.findAllByType("button")[0]!;
    await act(async () => { await clearAll.props.onClick(); });
    assert.deepEqual(harness.confirmations, []);
    assert.deepEqual(harness.requests.map((request) => request.body), [{ scope: "encounter", preview: true }]);
    assert.match(textOf(harness.renderer.root.findAllByType(ClearEncounterButton)[0]!), /Nothing charted this visit yet/);
  } finally {
    harness.restore();
  }
});

// ---------------------------------------------------------------------------
// Mandate 17 guard 4 — Refraction's Remove is no longer cosmetic
// ---------------------------------------------------------------------------

test("guard 4: removing the only refraction block voids its saved Observations on the server", async () => {
  const statuses: Record<string, string> = {};
  const voidBodies: unknown[] = [];
  const originalFetch = globalThis.fetch;
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", { configurable: true, value: { confirm: () => true } });
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith("/clinical-graph/refraction/definition")) return Response.json(refractionDefinition());
    if (url.includes("/clinical-graph/refraction/history?")) return Response.json({ glasses: [], softCl: [], specialtyCl: [] });
    if (url.endsWith("/clinical-graph/refraction") && init?.method === "POST") {
      statuses["Observation/r-od"] = "preliminary";
      statuses["Observation/r-os"] = "preliminary";
      return Response.json({ blocks: [{ eyes: { OD: { observationReference: "Observation/r-od" }, OS: { observationReference: "Observation/r-os" } } }] });
    }
    if (url.endsWith("/clinical-graph/encounters/current/void") && init?.method === "POST") {
      const body = JSON.parse(String(init.body)) as { scope: string; observationReference?: string | string[]; preview?: boolean };
      // The header's Clear-section control previews on mount; only real voids count here.
      if (body.preview) {
        const live = Object.entries(statuses).filter(([, status]) => status !== "entered-in-error").map(([reference]) => reference);
        return Response.json({ voided: live, count: live.length, sections: [], preview: true });
      }
      voidBodies.push(body);
      const references = Array.isArray(body.observationReference) ? body.observationReference : body.observationReference ? [body.observationReference] : [];
      for (const reference of references) statuses[reference] = "entered-in-error";
      return Response.json({ voided: references, count: references.length, sections: [], preview: false });
    }
    throw new Error(`Unexpected request: ${url}`);
  };
  let renderer!: ReactTestRenderer;
  try {
    await act(async () => {
      renderer = create(
        <EncounterEditContext.Provider value={{ encounterStatus: "in-progress" }}>
          <RefractionSection patientReference="Patient/synthetic" encounterReference="Encounter/current" onSaved={() => undefined} />
        </EncounterEditContext.Provider>,
      );
      await flush();
    });
    // Two empty blocks by default: drop the second (never saved → nothing to void).
    const removeButtons = () => renderer.root.findAllByType("button").filter((button) => textOf(button) === "Remove");
    assert.equal(removeButtons().length, 2, "every block carries a Remove control");
    await act(async () => { await removeButtons()[1]!.props.onClick(); });
    assert.equal(voidBodies.length, 0, "an unsaved block needs no server void");
    assert.equal(removeButtons().length, 1, "the only remaining block still carries Remove");

    // Record a value and save the remaining block.
    const sphere = renderer.root.findAll((node) => node.props?.ariaLabel === "OD sphere")[0]!;
    await act(async () => { sphere.props.onChange("-1.00"); });
    const save = renderer.root.findAllByType("button").find((button) => textOf(button) === "Save Refraction")!;
    await act(async () => { await save.props.onClick(); await flush(); });
    assert.equal(statuses["Observation/r-od"], "preliminary");

    // Remove the only block: the server must see the void.
    await act(async () => { await removeButtons()[0]!.props.onClick(); await flush(); });
    assert.deepEqual(voidBodies, [{ scope: "observation", observationReference: ["Observation/r-od", "Observation/r-os"] }]);
    assert.equal(statuses["Observation/r-od"], "entered-in-error");
    assert.equal(statuses["Observation/r-os"], "entered-in-error");
    assert.equal(removeButtons().length, 0);
    assert.ok(renderer.root.findAllByType("button").some((button) => textOf(button).includes("Add refraction")), "the empty state still offers Add");
  } finally {
    renderer?.unmount();
    globalThis.fetch = originalFetch;
    if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
    else Reflect.deleteProperty(globalThis, "window");
  }
});

// ---------------------------------------------------------------------------
// Surface wiring — every §5 surface carries the shared controls; the dead stub is gone
// ---------------------------------------------------------------------------

test("every surface in the design table renders Clear section, and HpiSection no longer carries a dead onClear stub", () => {
  const read = (name: string) => readFileSync(new URL(`../src/components/charting/${name}.tsx`, import.meta.url), "utf8");
  for (const component of [
    "EntranceStateSection", "CvfSection", "EomSection", "CoverTestSection", "EntranceMeasurementSection",
    "VaSection", "IopSection", "DilationSection", "AutoRefractionSection", "RefractionSection",
    "HpiSection", "OcularHealthSection", "AssessmentSection",
  ]) {
    assert.match(read(component), /<ClearSectionButton/, `${component} must render the tier-2 control`);
  }
  for (const component of [
    "EntranceStateSection", "CvfSection", "EomSection", "CoverTestSection", "EntranceMeasurementSection",
    "VaSection", "IopSection", "DilationSection", "AutoRefractionSection",
  ]) {
    assert.match(read(component), /<RemoveValueButton/, `${component} must render the tier-1 control`);
  }
  assert.doesNotMatch(read("HpiSection"), /onClear=\{\(\) => undefined\}/);
  assert.doesNotMatch(read("RefractionSection"), /blocks\.length > 1 &&/);
});

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

async function renderInEncounter(element: React.ReactElement, options: {
  previewCount: number;
  previewSections?: Array<{ sectionKey: string; label: string; count: number }>;
  encounterStatus?: "in-progress" | "finished";
}) {
  const originalFetch = globalThis.fetch;
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const requests: Array<{ url: string; body: unknown }> = [];
  const confirmations: string[] = [];
  const state = { confirmAnswer: true };
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      confirm(message: string) {
        confirmations.push(message);
        return state.confirmAnswer;
      },
    },
  });
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    const body = init?.body ? JSON.parse(String(init.body)) as { preview?: boolean } : undefined;
    requests.push({ url, body });
    if (!url.endsWith("/void")) throw new Error(`Unexpected request: ${url}`);
    const sections = options.previewSections ?? (options.previewCount > 0 ? [{ sectionKey: "entrance:pupils", label: "Pupils", count: options.previewCount }] : []);
    return Response.json({
      voided: Array.from({ length: options.previewCount }, (_, index) => `Observation/o${index + 1}`),
      count: options.previewCount,
      sections,
      preview: Boolean(body?.preview),
    });
  };
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(
      <EncounterEditContext.Provider value={{ encounterStatus: options.encounterStatus ?? "in-progress" }}>
        {element}
      </EncounterEditContext.Provider>,
    );
    await flush();
  });
  return {
    renderer,
    requests,
    confirmations,
    get confirmAnswer() { return state.confirmAnswer; },
    set confirmAnswer(value: boolean) { state.confirmAnswer = value; },
    restore() {
      renderer.unmount();
      globalThis.fetch = originalFetch;
      if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
      else Reflect.deleteProperty(globalThis, "window");
    },
  };
}

function findClearButton(root: ReactTestInstance, label: string): ReactTestInstance | undefined {
  return root.findAll((node) => node.type === "button" && textOf(node) === label)[0];
}

function textOf(node: ReactTestInstance): string {
  return node.children.map((child) => typeof child === "string" ? child : textOf(child)).join("");
}

async function flush(): Promise<void> {
  for (let index = 0; index < 4; index += 1) {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
}

function refractionDefinition() {
  return {
    definition: {
      fields: {
        type: { options: [
          { code: "MANIFEST", display: "Manifest", active: true },
          { code: "FINAL_RX", display: "Final/Rx", active: true },
        ] },
        sourceType: { options: [{ code: "manual", display: "Manual", active: true }] },
        sphere: { minimum: -20, maximum: 20, step: 0.25 },
        axis: { minimum: 0, maximum: 180, step: 1 },
        prismAmount: { minimum: 0.25, maximum: 20, step: 0.25 },
        prismBase: { options: [{ code: "in", display: "In", active: true }] },
        purpose: { options: [{ code: "Full-time", display: "Full-time", active: true }] },
      },
    },
    diagnosisOptions: [],
    refractiveThreshold: 0.5,
  };
}
