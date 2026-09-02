import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import React from "react";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { handleEncounterVoidRequest } from "../../mcp/src/clinical-graph/encounter-void-endpoint";
import {
  AUTH,
  administration,
  cvf,
  fixture as voidFixture,
  observation,
  type VoidBody,
} from "../../mcp/tests/encounterVoidFixture";
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

test("HPI, IOP, and CVF sheets expose a working Back to exam overview action", () => {
  for (const sectionId of ["hpi", "iop", "cvf"] as const) {
    let backCount = 0;
    const renderer = create(
      <ExamEntrySheet sectionId={sectionId} onCancel={() => { backCount += 1; }}>
        <div>sheet body</div>
      </ExamEntrySheet>,
    );
    try {
      const back = renderer.root.findAll((node) =>
        node.type === "button" && textOf(node) === "Back to exam overview")[0];
      assert.ok(back, `${sectionId} needs an explicit way back to the overview`);
      back.props.onClick();
      assert.equal(backCount, 1, `${sectionId} back action must leave the sheet`);
    } finally {
      renderer.unmount();
    }
  }
});

test("the entry sheet chrome carries Clear everything charted this visit left of Back to exam overview, from any section", async () => {
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
    assert.deepEqual(labels, ["Clear everything charted this visit…", "Back to exam overview"], "tier 3 sits left of Back to exam overview in the chrome");
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

test("count honesty: Dilation section preview, confirm, void result, section subtotal, and stored statuses all agree", async () => {
  const { deps, fhir } = voidFixture();
  fhir.add(administration("ma1"));
  fhir.add(administration("ma2"));
  fhir.add(observation("dfe", "entrance:dilation", "UNKNOWN", {
    partOf: [{ reference: "MedicationAdministration/ma1" }, { reference: "MedicationAdministration/ma2" }],
  }));
  fhir.add(cvf("outside", "OD"));
  const responses: VoidBody[] = [];
  const confirmations: string[] = [];
  const cleared: VoidBody[] = [];
  const restore = installRealVoidBridge(deps, responses, confirmations);
  let renderer!: ReactTestRenderer;
  try {
    await act(async () => {
      renderer = create(
        <ClearSectionButton
          encounterReference={ENCOUNTER}
          sectionKey="entrance:dilation"
          label="Dilation"
          hasRecorded
          onCleared={(result) => cleared.push(result as VoidBody)}
        />,
      );
    });
    const clear = renderer.root.findByType("button");
    await act(async () => { await clear.props.onClick(); await flush(); });

    assert.equal(responses.length, 2, "one preview and one void response");
    const [preview, result] = responses;
    assert.equal(preview?.preview, true);
    assert.equal(preview?.count, 3);
    assert.deepEqual(confirmations, [
      "Clear Dilation — voids 3 recorded values from this visit. They remain in the record as entered-in-error. Continue?",
    ]);
    assert.equal(result?.preview, false);
    assert.equal(result?.count, 3);
    assert.equal(result?.voided.length, 3);
    assert.deepEqual([...result!.voided].sort(), ["MedicationAdministration/ma1", "MedicationAdministration/ma2", "Observation/dfe"]);
    assert.equal(result?.sections.reduce((sum, section) => sum + section.count, 0), result?.count);
    assert.equal(result?.sections.find((section) => section.sectionKey === "entrance:dilation")?.count, 3);
    assert.deepEqual(cleared, [result]);
    assert.equal(fhir.get<ReturnType<typeof administration>>("MedicationAdministration", "ma1").status, "entered-in-error");
    assert.equal(fhir.get<ReturnType<typeof administration>>("MedicationAdministration", "ma2").status, "entered-in-error");
    assert.equal(fhir.get<ReturnType<typeof observation>>("Observation", "dfe").status, "entered-in-error");
    assert.equal(fhir.get<ReturnType<typeof cvf>>("Observation", "outside").status, "final", "the adjacent section is untouched");
  } finally {
    renderer?.unmount();
    restore();
  }
});

test("count honesty: whole-visit preview, confirm, void result, section subtotals, and stored statuses all agree", async () => {
  const { deps, fhir } = voidFixture();
  fhir.add(administration("ma1"));
  fhir.add(administration("ma2"));
  fhir.add(observation("dfe", "entrance:dilation", "UNKNOWN", {
    partOf: [{ reference: "MedicationAdministration/ma1" }, { reference: "MedicationAdministration/ma2" }],
  }));
  fhir.add(cvf("today", "OD"));
  fhir.add(cvf("prior", "OS", { encounter: { reference: "Encounter/e0" } }));
  const responses: VoidBody[] = [];
  const confirmations: string[] = [];
  const cleared: VoidBody[] = [];
  const restore = installRealVoidBridge(deps, responses, confirmations);
  let renderer!: ReactTestRenderer;
  try {
    await act(async () => {
      renderer = create(
        <ClearEncounterButton
          encounterReference={ENCOUNTER}
          encounterStatus="in-progress"
          onCleared={(result) => cleared.push(result as VoidBody)}
        />,
      );
    });
    const clear = renderer.root.findByType("button");
    await act(async () => { await clear.props.onClick(); await flush(); });

    assert.equal(responses.length, 2, "one preview and one void response");
    const [preview, result] = responses;
    assert.equal(preview?.preview, true);
    assert.equal(preview?.count, 4);
    assert.equal(preview?.sections.reduce((sum, section) => sum + section.count, 0), preview?.count);
    assert.deepEqual(confirmations, [
      "Clear everything charted for this visit — Dilation (3), Confrontation visual fields (1): 4 recorded values. They remain in the record as entered-in-error. Continue?",
    ]);
    assert.equal(result?.preview, false);
    assert.equal(result?.count, 4);
    assert.equal(result?.voided.length, 4);
    assert.deepEqual([...result!.voided].sort(), ["MedicationAdministration/ma1", "MedicationAdministration/ma2", "Observation/dfe", "Observation/today"]);
    assert.equal(result?.sections.reduce((sum, section) => sum + section.count, 0), result?.count);
    assert.equal(result?.sections.find((section) => section.sectionKey === "entrance:dilation")?.count, 3);
    assert.deepEqual(cleared, [result]);
    assert.equal(fhir.get<ReturnType<typeof administration>>("MedicationAdministration", "ma1").status, "entered-in-error");
    assert.equal(fhir.get<ReturnType<typeof administration>>("MedicationAdministration", "ma2").status, "entered-in-error");
    assert.equal(fhir.get<ReturnType<typeof observation>>("Observation", "dfe").status, "entered-in-error");
    assert.equal(fhir.get<ReturnType<typeof cvf>>("Observation", "today").status, "entered-in-error");
    assert.equal(fhir.get<ReturnType<typeof cvf>>("Observation", "prior").status, "final", "the prior visit is untouched");
  } finally {
    renderer?.unmount();
    restore();
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
    "VaSection", "IopSection", "DilationSection", "AutoRefractionSection", "RefractionSection", "WearingSection",
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

test("Wearing Rx offers the standard persisted section clear and resets its editor to blank", async () => {
  const { WearingSection } = await import("../src/components/charting/WearingSection");
  const originalFetch = globalThis.fetch;
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const confirmations: string[] = [];
  const voidBodies: unknown[] = [];
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { confirm(message: string) { confirmations.push(message); return true; } },
  });
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith("/clinical-graph/wearing/definition")) {
      return Response.json({ definition: { fields: {
        eyeglassType: { options: [{ code: "progressives", display: "Progressives", active: true }] },
        sourceType: { options: [
          { code: "device", display: "Device", active: true },
          { code: "manual", display: "Manual", active: true },
        ] },
        prismBase: { options: [{ code: "down", display: "Down", active: true }] },
      } } });
    }
    if (url.endsWith("/void") && init?.method === "POST") {
      const body = JSON.parse(String(init.body)) as { preview?: boolean };
      voidBodies.push(body);
      return Response.json({
        voided: ["Observation/wearing-1"],
        count: 1,
        sections: [{ sectionKey: "wearing", label: "Wearing Rx", count: 1 }],
        preview: body.preview === true,
        entries: [{ reference: "Observation/wearing-1", sectionKey: "wearing", findingKey: "wearing_rx", laterality: "OU" }],
      });
    }
    throw new Error(`Unexpected request: ${url}`);
  };

  let renderer!: ReactTestRenderer;
  try {
    await act(async () => {
      renderer = create(
        <EncounterEditContext.Provider value={{ encounterStatus: "in-progress" }}>
          <WearingSection patientReference="Patient/p1" encounterReference={ENCOUNTER} onSaved={() => undefined} />
        </EncounterEditContext.Provider>,
      );
      await flush();
    });
    const sphere = () => renderer.root.findAll((node) => node.props.ariaLabel === "OD sphere")[0]!;
    const source = () => renderer.root.findAll((node) => node.props.ariaLabel === "Source")[0]!;
    await act(async () => {
      sphere().props.onChange("-1.25");
      source().props.onChange("device");
    });
    assert.equal(sphere().props.value, "-1.25");
    assert.equal(source().props.value, "device");
    const clear = renderer.root.findAllByType(ClearSectionButton)[0]?.findByType("button");
    assert.ok(clear, "a persisted Wearing Rx must expose Clear Wearing Rx on reopen");
    await act(async () => { await clear.props.onClick(); await flush(); });
    assert.deepEqual(voidBodies, [
      { scope: "section", sectionKey: "wearing", preview: true },
      { scope: "section", sectionKey: "wearing", preview: true },
      { scope: "section", sectionKey: "wearing" },
    ]);
    assert.deepEqual(confirmations, [
      "Clear Wearing Rx — voids 1 recorded value from this visit. They remain in the record as entered-in-error. Continue?",
    ]);
    assert.equal(sphere().props.value, "");
    assert.equal(source().props.value, "manual", "clear resets Source to the section default");
    assert.equal(renderer.root.findAll((node) => node.type === "input" && node.props.type === "checkbox")[0]?.props.checked, false);
  } finally {
    renderer?.unmount();
    globalThis.fetch = originalFetch;
    if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
    else Reflect.deleteProperty(globalThis, "window");
  }
});

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

function installRealVoidBridge(
  deps: Parameters<typeof handleEncounterVoidRequest>[0],
  responses: VoidBody[],
  confirmations: string[],
): () => void {
  const originalFetch = globalThis.fetch;
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { confirm(message: string) { confirmations.push(message); return true; } },
  });
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input), "http://localhost");
    const match = url.pathname.match(/^\/clinical-graph\/encounters\/([^/]+)\/void$/);
    if (!match || init?.method !== "POST") throw new Error(`Unexpected request: ${url}`);
    const result = await handleEncounterVoidRequest(deps, {
      authHeader: AUTH,
      params: { encounterId: decodeURIComponent(match[1]!) },
      body: JSON.parse(String(init.body)),
    });
    responses.push(result.body as VoidBody);
    return Response.json(result.body, { status: result.status });
  };
  return () => {
    globalThis.fetch = originalFetch;
    if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
    else Reflect.deleteProperty(globalThis, "window");
  };
}

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

// ---------------------------------------------------------------------------
// Fixback after evaluation of 91411903
// ---------------------------------------------------------------------------

test("fixback 5: refraction block Remove is disabled with the amendment tooltip once the encounter is signed", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.endsWith("/clinical-graph/refraction/definition")) return Response.json(refractionDefinition());
    if (url.includes("/clinical-graph/refraction/history?")) return Response.json({ glasses: [], softCl: [], specialtyCl: [] });
    throw new Error(`Unexpected request: ${url}`);
  };
  let renderer!: ReactTestRenderer;
  try {
    await act(async () => {
      renderer = create(
        <EncounterEditContext.Provider value={{ encounterStatus: "finished" }}>
          <RefractionSection patientReference="Patient/synthetic" encounterReference="Encounter/current" onSaved={() => undefined} />
        </EncounterEditContext.Provider>,
      );
      await flush();
    });
    const removes = renderer.root.findAllByType("button").filter((button) => textOf(button) === "Remove");
    assert.equal(removes.length, 2);
    for (const button of removes) {
      assert.equal(button.props.disabled, true);
      assert.equal(button.props.title, SIGNED_ENCOUNTER_TOOLTIP);
    }
  } finally {
    renderer?.unmount();
    globalThis.fetch = originalFetch;
  }
});

/** What the server holds for each surface on reopen: one value per eye, plus the binocular PD for Auto-refraction. */
const PERSISTED_REOPEN_ENTRIES: Record<string, Array<{ reference: string; sectionKey: string; findingKey: string; laterality: string }>> = {
  va: [
    { reference: "Observation/va-od", sectionKey: "va", findingKey: "VISUAL_ACUITY", laterality: "OD" },
    { reference: "Observation/va-os", sectionKey: "va", findingKey: "VISUAL_ACUITY", laterality: "OS" },
  ],
  tonometry: [
    { reference: "Observation/iop-od", sectionKey: "tonometry", findingKey: "intraocular_pressure", laterality: "OD" },
    { reference: "Observation/ch-od", sectionKey: "tonometry", findingKey: "corneal_hysteresis", laterality: "OD" },
    { reference: "Observation/iop-os", sectionKey: "tonometry", findingKey: "intraocular_pressure", laterality: "OS" },
  ],
  "auto-refraction": [
    { reference: "Observation/ar-od", sectionKey: "auto-refraction", findingKey: "auto_refraction", laterality: "OD" },
    { reference: "Observation/ak-od", sectionKey: "auto-refraction", findingKey: "auto_keratometry", laterality: "OD" },
    { reference: "Observation/pd", sectionKey: "auto-refraction", findingKey: "binocular_pd", laterality: "OU" },
  ],
};

test("Auto-refraction reopens with the current encounter's stored AR, Auto-K, PD, and remarks in the editor", async () => {
  const { AutoRefractionSection } = await import("../src/components/charting/AutoRefractionSection");
  const originalFetch = globalThis.fetch;
  const historyRequests: string[] = [];
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith("/clinical-graph/auto-refraction/definition")) {
      return Response.json({ definitions: { autoRefraction: { fields: { sourceType: { options: [{ code: "manual", display: "Manual", active: true }] } } }, autoKeratometry: { fields: {} } } });
    }
    if (url.includes("/clinical-graph/auto-refraction/history")) {
      historyRequests.push(url);
      return Response.json({
        eyes: {
          OD: { sphere: -1.25, cylinder: -0.5, axis: 90, flatK: 42.5, flatAxis: 180, steepK: 43.25, steepAxis: 90, observationReferences: ["Observation/ar-od", "Observation/ak-od"] },
          OS: { sphere: -1, cylinder: -0.25, axis: 85, flatK: 42.75, flatAxis: 5, steepK: 43.5, steepAxis: 95, observationReferences: ["Observation/ar-os", "Observation/ak-os"] },
        },
        binocularPdDistance: 63.5,
        binocularPdNear: 60.25,
        binocularPdObservationReferences: ["Observation/pd-ou"],
        remarks: "Reliable fixation.",
      });
    }
    if (url.endsWith("/void") && init?.method === "POST") {
      return Response.json({ voided: [], count: 0, sections: [], preview: true, entries: [] });
    }
    throw new Error(`Unexpected request: ${url}`);
  };

  let renderer!: ReactTestRenderer;
  try {
    await act(async () => {
      renderer = create(
        <EncounterEditContext.Provider value={{ encounterStatus: "in-progress" }}>
          <AutoRefractionSection patientReference="Patient/p1" encounterReference={ENCOUNTER} onSaved={() => undefined} />
        </EncounterEditContext.Provider>,
      );
      await flush();
    });
    assert.equal(historyRequests.length, 1);
    assert.match(historyRequests[0]!, /patientReference=Patient%2Fp1/);
    assert.match(historyRequests[0]!, /encounterReference=Encounter%2Fe1/);
    const value = (ariaLabel: string) => renderer.root.findAll((node) => node.props.ariaLabel === ariaLabel)[0]?.props.value;
    assert.equal(value("OD auto-refraction sphere"), "-1.25");
    assert.equal(value("OD auto-refraction cylinder"), "-0.5");
    assert.equal(value("OD auto-refraction axis"), "90");
    assert.equal(value("OD flat K"), "42.5");
    assert.equal(value("OD flat axis"), "180");
    assert.equal(value("OD steep K"), "43.25");
    assert.equal(value("OD steep axis"), "90");
    assert.equal(value("Binocular PD distance"), "63.5");
    assert.equal(value("Binocular PD near"), "60.25");
    assert.equal(renderer.root.findByType("textarea").props.value, "Reliable fixation.");
  } finally {
    renderer?.unmount();
    globalThis.fetch = originalFetch;
  }
});

test("Auto-refraction history cannot overwrite an edit made while hydration is in flight", async () => {
  const { AutoRefractionSection } = await import("../src/components/charting/AutoRefractionSection");
  const originalFetch = globalThis.fetch;
  let resolveHistory!: (response: Response) => void;
  const historyResponse = new Promise<Response>((resolve) => { resolveHistory = resolve; });
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith("/clinical-graph/auto-refraction/definition")) {
      return Response.json({ definitions: { autoRefraction: { fields: { sourceType: { options: [{ code: "manual", display: "Manual", active: true }] } } }, autoKeratometry: { fields: {} } } });
    }
    if (url.endsWith("/void") && init?.method === "POST") {
      return Response.json({ voided: [], count: 0, sections: [], preview: true, entries: [] });
    }
    if (url.includes("/clinical-graph/auto-refraction/history")) return historyResponse;
    throw new Error(`Unexpected request: ${url}`);
  };

  let renderer!: ReactTestRenderer;
  try {
    await act(async () => {
      renderer = create(
        <EncounterEditContext.Provider value={{ encounterStatus: "in-progress" }}>
          <AutoRefractionSection patientReference="Patient/p1" encounterReference={ENCOUNTER} onSaved={() => undefined} />
        </EncounterEditContext.Provider>,
      );
      await flush();
    });
    const sphere = () => renderer.root.findAll((node) => node.props.ariaLabel === "OD auto-refraction sphere")[0]!;
    await act(async () => { sphere().props.onChange("-2.00"); });
    assert.equal(sphere().props.value, "-2.00");

    await act(async () => {
      resolveHistory(Response.json({ eyes: { OD: { sphere: -1.25, observationReferences: ["Observation/old-od"] } } }));
      await flush();
    });
    assert.equal(sphere().props.value, "-2.00", "late stored history must not replace the clinician's edit");
  } finally {
    renderer?.unmount();
    globalThis.fetch = originalFetch;
  }
});

test("Auto-refraction encounter changes reset fields and replace saved references before new history resolves", async () => {
  const { AutoRefractionSection } = await import("../src/components/charting/AutoRefractionSection");
  const originalFetch = globalThis.fetch;
  let resolveSecondHistory!: (response: Response) => void;
  const secondHistory = new Promise<Response>((resolve) => { resolveSecondHistory = resolve; });
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input), "http://localhost");
    if (url.pathname.endsWith("/clinical-graph/auto-refraction/definition")) {
      return Response.json({ definitions: { autoRefraction: { fields: { sourceType: { options: [{ code: "manual", display: "Manual", active: true }] } } }, autoKeratometry: { fields: {} } } });
    }
    if (url.pathname.endsWith("/void") && init?.method === "POST") {
      return Response.json({ voided: [], count: 0, sections: [], preview: true, entries: [] });
    }
    if (url.pathname.endsWith("/clinical-graph/auto-refraction/history")) {
      return url.searchParams.get("encounterReference") === "Encounter/e1"
        ? Response.json({ eyes: { OD: { sphere: -1.25, observationReferences: ["Observation/e1-od"] } } })
        : secondHistory;
    }
    throw new Error(`Unexpected request: ${url}`);
  };

  const section = (encounterReference: string) => (
    <EncounterEditContext.Provider value={{ encounterStatus: "in-progress" }}>
      <AutoRefractionSection patientReference="Patient/p1" encounterReference={encounterReference} onSaved={() => undefined} />
    </EncounterEditContext.Provider>
  );
  const removeLabels = (renderer: ReactTestRenderer) => renderer.root
    .findAll((node) => node.type === "button" && String(node.props["aria-label"] ?? "").startsWith("Remove Auto-refraction"))
    .map((node) => node.props["aria-label"] as string);
  let renderer!: ReactTestRenderer;
  try {
    await act(async () => { renderer = create(section("Encounter/e1")); await flush(); });
    assert.deepEqual(removeLabels(renderer), ["Remove Auto-refraction OD"]);

    await act(async () => { renderer.update(section("Encounter/e2")); await flush(); });
    assert.equal(renderer.root.findAll((node) => node.props.ariaLabel === "OD auto-refraction sphere")[0]?.props.value, "");
    assert.deepEqual(removeLabels(renderer), [], "the prior encounter's reference must clear before the next history response");

    await act(async () => {
      resolveSecondHistory(Response.json({ eyes: { OS: { sphere: -0.75, observationReferences: ["Observation/e2-os"] } } }));
      await flush();
    });
    assert.deepEqual(removeLabels(renderer), ["Remove Auto-refraction OS"]);
  } finally {
    renderer?.unmount();
    globalThis.fetch = originalFetch;
  }
});

/**
 * Fixback 56ff8d36 P2#A, widened per the Opus spot-check: on a SIGNED reopened chart, BOTH tiers
 * must render present-but-disabled with the amendment tooltip (§3, §4b.5) — the Clear section
 * control AND every per-item Remove — for all three surfaces that keep no history of their own.
 * Every shortfall is collected before asserting, so a regression that hides one tier in one
 * section is named as such rather than hidden behind the first failure.
 */
test("fixback 56ff8d36 P2#A: a signed reopened chart renders Clear section AND every Remove control for VA, IOP, and Auto-refraction, present-but-disabled with the amendment tooltip", async () => {
  const { VaSection } = await import("../src/components/charting/VaSection");
  const { IopSection } = await import("../src/components/charting/IopSection");
  const { AutoRefractionSection } = await import("../src/components/charting/AutoRefractionSection");
  const cases = [
    { name: "VA", clear: "Clear Visual acuity", removes: ["Remove Visual acuity OD", "Remove Visual acuity OS"], sectionKey: "va", element: <VaSection patientReference="Patient/p1" encounterReference={ENCOUNTER} onSaved={() => undefined} /> },
    { name: "IOP", clear: "Clear IOP", removes: ["Remove IOP OD", "Remove IOP OS"], sectionKey: "tonometry", element: <IopSection patientReference="Patient/p1" encounterReference={ENCOUNTER} onSaved={() => undefined} /> },
    { name: "Auto-refraction", clear: "Clear Auto-refraction / Auto-K", removes: ["Remove Auto-refraction OD", "Remove Binocular PD"], sectionKey: "auto-refraction", element: <AutoRefractionSection patientReference="Patient/p1" encounterReference={ENCOUNTER} onSaved={() => undefined} /> },
  ];
  const shortfalls: string[] = [];
  const mutations: unknown[] = [];
  for (const item of cases) {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      const url = String(input);
      if (url.endsWith("/void") && init?.method === "POST") {
        const body = JSON.parse(String(init.body)) as { preview?: boolean };
        if (!body.preview) { mutations.push(body); return Response.json({ error: "Signed or closed encounters cannot be edited.", code: "encounter-closed" }, { status: 409 }); }
        const entries = PERSISTED_REOPEN_ENTRIES[item.sectionKey]!;
        return Response.json({ voided: entries.map((entry) => entry.reference), count: entries.length, sections: [], preview: true, entries });
      }
      if (url.endsWith("/clinical-graph/iop/definition")) {
        return Response.json({ definitions: { intraocularPressure: { fields: { method: { options: [{ code: "GAT", display: "GAT", active: true }] } } }, cornealHysteresis: { fields: {} } } });
      }
      if (url.includes("/clinical-graph/iop/history")) return Response.json({ readings: [], cornealHysteresis: [], perEye: { OD: { average: null, tMax: null, count: 0, target: null }, OS: { average: null, tMax: null, count: 0, target: null } }, threshold: 21 });
      if (url.endsWith("/clinical-graph/auto-refraction/definition")) {
        return Response.json({ definitions: { autoRefraction: { fields: { sourceType: { options: [{ code: "manual", display: "Manual", active: true }] } } }, autoKeratometry: { fields: {} } } });
      }
      throw new Error(`Unexpected request: ${url}`);
    };
    let renderer!: ReactTestRenderer;
    try {
      await act(async () => {
        renderer = create(<EncounterEditContext.Provider value={{ encounterStatus: "finished" }}>{item.element}</EncounterEditContext.Provider>);
        await flush();
      });
      const disabledWithTooltip = (button: ReactTestInstance | undefined, what: string) => {
        if (!button) { shortfalls.push(`${item.name}: ${what} is ABSENT on a signed chart (must be present-but-disabled)`); return; }
        if (button.props.disabled !== true) shortfalls.push(`${item.name}: ${what} is enabled on a signed chart`);
        if (button.props.title !== SIGNED_ENCOUNTER_TOOLTIP) shortfalls.push(`${item.name}: ${what} lacks the amendment tooltip`);
      };
      // Tier 2 — Clear section
      disabledWithTooltip(findClearButton(renderer.root, item.clear), item.clear);
      // Tier 1 — every per-item Remove
      for (const label of item.removes) {
        disabledWithTooltip(renderer.root.findAll((node) => node.type === "button" && node.props["aria-label"] === label)[0], label);
      }
      // A disabled control never reaches the server, even if clicked.
      for (const button of renderer.root.findAll((node) => node.type === "button" && (textOf(node) === item.clear || String(node.props["aria-label"] ?? "").startsWith("Remove ")))) {
        await act(async () => { await button.props.onClick?.(); });
      }
    } finally {
      renderer?.unmount();
      globalThis.fetch = originalFetch;
    }
  }
  assert.deepEqual(shortfalls, [], `signed reopen shortfalls:\n${shortfalls.join("\n")}`);
  assert.deepEqual(mutations, [], "no disabled control may issue a void");
});

test("fixback 4: VA, IOP, and Auto-refraction offer Clear section on reopen when the server holds recorded values", async () => {
  const { VaSection } = await import("../src/components/charting/VaSection");
  const { IopSection } = await import("../src/components/charting/IopSection");
  const { AutoRefractionSection } = await import("../src/components/charting/AutoRefractionSection");
  const cases: Array<{ name: string; label: string; sectionKey: string; element: React.ReactElement }> = [
    { name: "VA", label: "Clear Visual acuity", sectionKey: "va", element: <VaSection patientReference="Patient/p1" encounterReference={ENCOUNTER} onSaved={() => undefined} /> },
    { name: "IOP", label: "Clear IOP", sectionKey: "tonometry", element: <IopSection patientReference="Patient/p1" encounterReference={ENCOUNTER} onSaved={() => undefined} /> },
    { name: "Auto-refraction", label: "Clear Auto-refraction / Auto-K", sectionKey: "auto-refraction", element: <AutoRefractionSection patientReference="Patient/p1" encounterReference={ENCOUNTER} onSaved={() => undefined} /> },
  ];
  const persisted = PERSISTED_REOPEN_ENTRIES;
  // Fixback 56ff8d36 P2#A: a signed chart still shows what was recorded — the controls render
  // present-but-disabled (§3, §4b.5), which means the sheet must still learn what it holds.
  for (const [recorded, status] of [[true, "in-progress"], [false, "in-progress"], [true, "finished"]] as const) {
    const signed = status === "finished";
    for (const item of cases) {
      const originalFetch = globalThis.fetch;
      const previews: unknown[] = [];
      const voids: unknown[] = [];
      globalThis.fetch = async (input, init) => {
        const url = String(input);
        if (url.endsWith("/void") && init?.method === "POST") {
          const body = JSON.parse(String(init.body)) as { preview?: boolean; sectionKey?: string };
          if (!body.preview) {
            voids.push(body);
            return Response.json({ voided: [], count: 1, sections: [], preview: false });
          }
          previews.push(body);
          const entries = recorded ? persisted[item.sectionKey]! : [];
          return Response.json({ voided: entries.map((entry) => entry.reference), count: entries.length, sections: [], preview: true, entries });
        }
        if (url.endsWith("/clinical-graph/iop/definition")) {
          return Response.json({ definitions: { intraocularPressure: { fields: { method: { options: [{ code: "GAT", display: "GAT", active: true }] } } }, cornealHysteresis: { fields: {} } } });
        }
        if (url.includes("/clinical-graph/iop/history")) return Response.json({ readings: [], cornealHysteresis: [], perEye: { OD: { average: null, tMax: null, count: 0, target: null }, OS: { average: null, tMax: null, count: 0, target: null } }, threshold: 21 });
        if (url.endsWith("/clinical-graph/auto-refraction/definition")) {
          return Response.json({ definitions: { autoRefraction: { fields: { sourceType: { options: [{ code: "manual", display: "Manual", active: true }] } } }, autoKeratometry: { fields: {} } } });
        }
        throw new Error(`Unexpected request: ${url}`);
      };
      let renderer!: ReactTestRenderer;
      try {
        await act(async () => {
          renderer = create(<EncounterEditContext.Provider value={{ encounterStatus: status }}>{item.element}</EncounterEditContext.Provider>);
          await flush();
        });
        assert.deepEqual(previews, [{ scope: "section", sectionKey: item.sectionKey, preview: true }], `${item.name} asks the server once on open`);
        const button = findClearButton(renderer.root, item.label);
        if (recorded) assert.ok(button, `${item.name}: Clear section must appear for persisted values`);
        else assert.equal(button, undefined, `${item.name}: nothing recorded, nothing to clear`);
        if (signed) {
          assert.equal(button?.props.disabled, true, `${item.name}: signed — Clear section present but disabled`);
          assert.equal(button?.props.title, SIGNED_ENCOUNTER_TOOLTIP);
        }

        // Fixback P2#2 (02c8155c eval): the per-item × must be offered on reopen too — §2 says "× on any
        // recorded value", and a value persisted before this session is still a recorded value.
        const removeLabels = renderer.root.findAll((node) => node.type === "button" && typeof node.props["aria-label"] === "string" && node.props["aria-label"].startsWith("Remove "))
          .map((node) => node.props["aria-label"] as string).sort();
        const expected = {
          VA: ["Remove Visual acuity OD", "Remove Visual acuity OS"],
          IOP: ["Remove IOP OD", "Remove IOP OS"],
          "Auto-refraction": ["Remove Auto-refraction OD", "Remove Binocular PD"],
        }[item.name]!;
        assert.deepEqual(removeLabels, recorded ? expected : [], `${item.name}: per-item controls on reopen (${status})`);
        if (signed) {
          for (const remove of renderer.root.findAll((node) => node.type === "button" && typeof node.props["aria-label"] === "string" && node.props["aria-label"].startsWith("Remove "))) {
            assert.equal(remove.props.disabled, true, `${item.name}: ${remove.props["aria-label"]} is present but disabled after sign`);
            assert.equal(remove.props.title, SIGNED_ENCOUNTER_TOOLTIP);
          }
        } else if (recorded) {
          // And the × voids the persisted references, not a stale in-session copy.
          const first = renderer.root.findAll((node) => node.type === "button" && node.props["aria-label"] === expected[0])[0]!;
          await act(async () => { await first.props.onClick(); await flush(); });
          const expectedVoid = {
            VA: { scope: "finding", findingKey: "VISUAL_ACUITY", laterality: "OD" },
            IOP: { scope: "observation", observationReference: ["Observation/iop-od", "Observation/ch-od"] },
            "Auto-refraction": { scope: "observation", observationReference: ["Observation/ar-od", "Observation/ak-od"] },
          }[item.name]!;
          assert.deepEqual(voids, [expectedVoid], `${item.name}: × voids exactly the persisted references for that eye`);
        }
      } finally {
        renderer?.unmount();
        globalThis.fetch = originalFetch;
      }
    }
  }
});
