import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import React from "react";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { EncounterEditContext } from "../src/components/charting/encounter-edit-context";
import { ExamChartBar } from "../src/components/charting/EncounterHeader";
import { ExamEntrySheet } from "../src/components/charting/ExamEntrySheet";
import { UndoStrip } from "../src/components/charting/UndoStrip";
import { SIGNED_ENCOUNTER_TOOLTIP } from "../src/lib/encounter-void";
import {
  emptyUndoLedger,
  readEncounterUndoLedger,
  undoEncounterVoid,
  undoSlotForSection,
  undoStripCopy,
  type EncounterUndoLedger,
  type UndoLedgerSlot,
} from "../src/lib/encounter-undo";

const ENCOUNTER = "Encounter/e1";

function slot(overrides: Partial<UndoLedgerSlot> = {}): UndoLedgerSlot {
  return {
    voided: [{ ref: "Observation/o1", priorStatus: "final" }],
    label: "Pupils",
    count: 6,
    at: "2026-09-01T15:00:00.000Z",
    sectionKeys: ["entrance:pupils"],
    scope: "section",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// The ledger client
// ---------------------------------------------------------------------------

test("readEncounterUndoLedger fetches the ledger, and answers the empty ledger for a non-ledger body or a failed request", async () => {
  const urls: string[] = [];
  const good: typeof fetch = async (input) => {
    urls.push(String(input));
    return Response.json({ ledger: { encounterId: "e1", encounter: null, sections: { "entrance:pupils": slot() } } });
  };
  const ledger = await readEncounterUndoLedger(ENCOUNTER, good);
  assert.match(urls[0]!, /\/clinical-graph\/encounters\/e1\/void\/ledger$/);
  assert.equal(ledger.sections["entrance:pupils"]?.count, 6);

  // The overview harness answers unknown routes with a search Bundle; that is not a ledger.
  const bundle: typeof fetch = async () => Response.json({ resourceType: "Bundle", type: "searchset", entry: [] });
  assert.deepEqual(await readEncounterUndoLedger(ENCOUNTER, bundle), emptyUndoLedger("e1"));
  const failing: typeof fetch = async () => { throw new Error("offline"); };
  assert.deepEqual(await readEncounterUndoLedger(ENCOUNTER, failing), emptyUndoLedger("e1"));
  const denied: typeof fetch = async () => Response.json({ error: "chart.read role required" }, { status: 403 });
  assert.deepEqual(await readEncounterUndoLedger(ENCOUNTER, denied), emptyUndoLedger("e1"));
});

test("undoEncounterVoid posts the scope to the undo endpoint, returns the restore, and surfaces the server's error", async () => {
  const calls: Array<{ url: string; body: unknown }> = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    calls.push({ url: String(input), body: JSON.parse(String(init?.body)) });
    return Response.json({ restored: ["Observation/o1"], count: 1, skipped: [], scope: "section", sectionKey: "entrance:pupils", ledger: emptyUndoLedger("e1") });
  };
  const result = await undoEncounterVoid(ENCOUNTER, { scope: "section", sectionKey: "entrance:pupils" }, fetchImpl);
  assert.equal(result.count, 1);
  assert.deepEqual(result.restored, ["Observation/o1"]);
  assert.deepEqual(result.ledger, emptyUndoLedger("e1"));
  assert.match(calls[0]!.url, /\/clinical-graph\/encounters\/e1\/void\/undo$/);
  assert.deepEqual(calls[0]!.body, { scope: "section", sectionKey: "entrance:pupils" });

  const closed: typeof fetch = async () => Response.json({ error: "Signed or closed encounters cannot be edited.", code: "encounter-closed" }, { status: 409 });
  await assert.rejects(() => undoEncounterVoid(ENCOUNTER, { scope: "encounter" }, closed), /Signed or closed encounters cannot be edited/);
});

test("undoSlotForSection finds the sheet's slot by any of its keys, exact or by prefix, and prefers the most recent", () => {
  const ledger: EncounterUndoLedger = {
    encounterId: "e1",
    encounter: null,
    sections: {
      "entrance:pupils": slot({ at: "2026-09-01T14:00:00.000Z" }),
      "entrance:cvf": slot({ label: "Confrontation fields", sectionKeys: ["entrance:cvf", "entrance:visual-field-defect"], at: "2026-09-01T15:00:00.000Z" }),
      "ocular-health:anterior:cornea": slot({ label: "Cornea", sectionKeys: ["ocular-health:anterior:cornea"], at: "2026-09-01T13:00:00.000Z" }),
      "ocular-health:anterior:lens": slot({ label: "Lens", sectionKeys: ["ocular-health:anterior:lens"], at: "2026-09-01T16:00:00.000Z" }),
    },
  };
  assert.equal(undoSlotForSection(ledger, ["entrance:pupils"])?.sectionKey, "entrance:pupils");
  assert.equal(undoSlotForSection(ledger, ["entrance:visual-field-defect", "entrance:cvf"])?.sectionKey, "entrance:cvf", "a sheet that names two keys finds the slot filed under the other");
  assert.equal(undoSlotForSection(ledger, ["ocular-health"])?.sectionKey, "ocular-health:anterior:lens", "a prefix key sees every slot beneath it and takes the most recent");
  assert.equal(undoSlotForSection(ledger, ["ocular-health:anterior:cornea", "ocular-health:anterior:lens"])?.sectionKey, "ocular-health:anterior:lens");
  assert.equal(undoSlotForSection(ledger, ["tonometry"]), undefined);
  assert.equal(undoSlotForSection(ledger, []), undefined);
  assert.equal(undoSlotForSection(emptyUndoLedger("e1"), ["entrance:pupils"]), undefined);
});

test("strip copy says Removed for a tier-1 remove and Cleared for a section or the visit, scaled by count", () => {
  assert.equal(undoStripCopy(slot({ scope: "observation", label: "Reactivity · OD", count: 1 })), "Removed Reactivity · OD");
  assert.equal(undoStripCopy(slot({ scope: "observation", label: "Pupils · OD", count: 7 })), "Removed Pupils · OD · 7 values");
  assert.equal(undoStripCopy(slot({ scope: "section", label: "Pupils", count: 6 })), "Cleared Pupils · 6 values");
  assert.equal(undoStripCopy(slot({ scope: "section", label: "IOP", count: 1 })), "Cleared IOP · 1 value");
  assert.equal(undoStripCopy(slot({ scope: "encounter", label: "everything charted", count: 31 })), "Cleared everything charted · 31 values");
});

// ---------------------------------------------------------------------------
// The strip itself
// ---------------------------------------------------------------------------

test("UndoStrip is a polite status row with one Undo verb; Undo calls back and reports a failure inline", async () => {
  let calls = 0;
  let fail = false;
  const harness = render(
    <UndoStrip slot={slot()} closed={false} onUndo={async () => { calls += 1; if (fail) throw new Error("This record was changed by someone else since you opened it."); }} />,
  );
  try {
    const strip = harness.root.findByProps({ role: "status" });
    assert.equal(strip.props["aria-live"], "polite");
    assert.equal(textOf(strip).startsWith("Cleared Pupils · 6 values"), true, textOf(strip));
    const buttons = strip.findAllByType("button");
    assert.equal(buttons.length, 1, "a row of text with one verb at the end");
    assert.equal(textOf(buttons[0]!), "Undo");
    assert.equal(buttons[0]!.props.disabled, undefined);
    await act(async () => { await buttons[0]!.props.onClick(); });
    assert.equal(calls, 1);
    fail = true;
    await act(async () => { await buttons[0]!.props.onClick(); });
    assert.equal(calls, 2);
    assert.match(textOf(harness.root.findByProps({ role: "status" })), /changed by someone else/);
  } finally {
    harness.unmount();
  }
});

test("UndoStrip renders present-but-disabled with the amendment tooltip once the encounter is signed", async () => {
  let calls = 0;
  const harness = render(<UndoStrip slot={slot()} closed onUndo={async () => { calls += 1; }} />);
  try {
    const strip = harness.root.findByProps({ role: "status" });
    assert.match(textOf(strip), /Cleared Pupils · 6 values/, "the clinician still sees that the path existed");
    const button = strip.findByType("button");
    assert.equal(button.props.disabled, true);
    assert.equal(button.props.title, SIGNED_ENCOUNTER_TOOLTIP);
    await act(async () => { await button.props.onClick(); });
    assert.equal(calls, 0, "a disabled Undo never reaches the server");
  } finally {
    harness.unmount();
  }
});

// ---------------------------------------------------------------------------
// §4b.1 placement — tiers 1–2 beneath the sheet heading, tier 3 in the chart bar
// ---------------------------------------------------------------------------

test("the entry sheet renders the section's Undo strip directly beneath its heading row, scoped to that section", async () => {
  let undone = 0;
  const harness = render(
    <EncounterEditContext.Provider value={{ encounterStatus: "in-progress" }}>
      <ExamEntrySheet
        sectionId="pupils"
        onCancel={() => undefined}
        encounterReference={ENCOUNTER}
        encounterStatus="in-progress"
        onEncounterCleared={() => undefined}
        undo={{ slot: slot(), onUndo: async () => { undone += 1; } }}
      >
        <div>sheet body</div>
      </ExamEntrySheet>
    </EncounterEditContext.Provider>,
  );
  try {
    const aside = harness.root.findByProps({ "data-testid": "exam-entry-sheet" });
    const children = aside.children.filter((child): child is ReactTestInstance => typeof child !== "string");
    const headingIndex = children.findIndex((child) => child.type === "header");
    const next = children[headingIndex + 1]!;
    assert.equal(next.type, UndoStrip, "the strip is the very next row after the heading");
    const strip = next.findByProps({ role: "status" });
    assert.equal(strip.props["aria-live"], "polite");
    assert.equal(strip.props["data-undo-scope"], "section");
    assert.match(textOf(strip), /Cleared Pupils · 6 values/);
    const undo = strip.findAllByType("button").find((button) => textOf(button) === "Undo")!;
    assert.ok(undo);
    assert.equal(undo.props["data-entry-sheet-pristine-action"], true, "Undo must not mark the sheet dirty");
    await act(async () => { await undo.props.onClick(); });
    assert.equal(undone, 1);
  } finally {
    harness.unmount();
  }
});

test("the entry sheet shows no strip when the section has nothing to undo, and a disabled one after sign", () => {
  const none = render(
    <ExamEntrySheet sectionId="pupils" onCancel={() => undefined} encounterReference={ENCOUNTER} encounterStatus="in-progress" onEncounterCleared={() => undefined}>
      <div>body</div>
    </ExamEntrySheet>,
  );
  try {
    assert.equal(none.root.findAllByProps({ "data-undo-scope": "section" }).length, 0);
  } finally {
    none.unmount();
  }
  const signed = render(
    <ExamEntrySheet sectionId="pupils" onCancel={() => undefined} encounterReference={ENCOUNTER} encounterStatus="finished" onEncounterCleared={() => undefined} undo={{ slot: slot(), onUndo: async () => undefined }}>
      <div>body</div>
    </ExamEntrySheet>,
  );
  try {
    const strip = signed.root.findByProps({ "data-undo-scope": "section" });
    const undo = strip.findAllByType("button").find((button) => textOf(button) === "Undo")!;
    assert.equal(undo.props.disabled, true);
    assert.equal(undo.props.title, SIGNED_ENCOUNTER_TOOLTIP);
  } finally {
    signed.unmount();
  }
});

test("the chart bar carries the visit Undo in its own slot immediately after exam-sections, only while a visit clear is pending", async () => {
  let undone = 0;
  const bar = (undoSlot: UndoLedgerSlot | undefined, undoDisabled = false) => (
    <ExamChartBar
      patientName="Pat"
      patientDetail=""
      visitControlsOpen={false}
      onToggleVisitControls={() => undefined}
      onBlackout={() => undefined}
      requestFinishEncounter={() => undefined}
      signDisabled={false}
      signLabel="Sign & finish"
      undoSlot={undoSlot}
      undoDisabled={undoDisabled}
      onUndo={async () => { undone += 1; }}
    />
  );
  const without = render(bar(undefined));
  try {
    const slots = without.root.findAll((node) => typeof node.props["data-chart-bar-slot"] === "string").map((node) => node.props["data-chart-bar-slot"]);
    assert.deepEqual(slots, ["patient", "cc-hpi-reserved", "exam-sections", "drafts", "unassigned", "visit", "blackout", "sign"], "no pending visit clear, no undo slot — the existing order is untouched");
  } finally {
    without.unmount();
  }
  const visit = slot({ scope: "encounter", label: "everything charted", count: 31, sectionKeys: [] });
  const withSlot = render(bar(visit));
  try {
    const slots = withSlot.root.findAll((node) => typeof node.props["data-chart-bar-slot"] === "string").map((node) => node.props["data-chart-bar-slot"]);
    assert.deepEqual(slots, ["patient", "cc-hpi-reserved", "exam-sections", "undo", "drafts", "unassigned", "visit", "blackout", "sign"], "undo sits beside exam-sections; drafts stays reserved for slice 4");
    const undoSlotNode = withSlot.root.findByProps({ "data-chart-bar-slot": "undo" });
    const strip = undoSlotNode.findByProps({ role: "status" });
    assert.equal(strip.props["data-undo-scope"], "encounter");
    assert.match(textOf(strip), /Cleared everything charted · 31 values/);
    const undo = strip.findByType("button");
    await act(async () => { await undo.props.onClick(); });
    assert.equal(undone, 1);
  } finally {
    withSlot.unmount();
  }
  const signed = render(bar(visit, true));
  try {
    const undo = signed.root.findByProps({ "data-chart-bar-slot": "undo" }).findByType("button");
    assert.equal(undo.props.disabled, true);
    assert.equal(undo.props.title, SIGNED_ENCOUNTER_TOOLTIP);
  } finally {
    signed.unmount();
  }
});

// ---------------------------------------------------------------------------
// The two-definition sheet keeps one slot: CVF's tier-1 remove names both keys
// ---------------------------------------------------------------------------

test("CvfSection's tier-1 remove names both of the sheet's section keys so the server files one Undo slot for the sheet", () => {
  const source = readFileSync(new URL("../src/components/charting/CvfSection.tsx", import.meta.url), "utf8");
  const call = source.match(/voidEncounterEntries\(encounterReference, \{\s*scope: "observation",[\s\S]*?\}\)/)?.[0] ?? "";
  assert.match(call, /sectionKey: \[definition\.stableKey, fieldDefectDefinition\.stableKey\]/, call || "no observation-scope void found in CvfSection");
});

// ---------------------------------------------------------------------------

function render(element: React.ReactElement): ReactTestRenderer {
  let renderer!: ReactTestRenderer;
  act(() => { renderer = create(element); });
  return renderer;
}

function textOf(node: ReactTestInstance): string {
  return node.children.map((child) => typeof child === "string" ? child : textOf(child)).join("");
}
