import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { CustomFieldEditor, type CustomFieldEditorValue } from "../src/components/charting/CustomFieldEditor";
import { CustomFindingSection } from "../src/components/charting/CustomFindingSection";
import { CustomSectionEditor } from "../src/components/charting/CustomSectionEditor";
import {
  OcularHealthSection,
  applyAnteriorAllNormal,
  changedDefinitions,
  copyEyeCapture,
  pendingStateEyes,
} from "../src/components/charting/OcularHealthSection";
import { SpineNav } from "../src/components/charting/SpineNav";
import { sectionStatus } from "../src/components/charting/types";

test("SpineNav is unchanged for an empty custom registry and safely appends missing-status custom sections", () => {
  const before = renderToStaticMarkup(<SpineNav active="va" statuses={{}} onSelect={() => undefined} />);
  const emptyRegistry = renderToStaticMarkup(<SpineNav active="va" statuses={{}} onSelect={() => undefined} customSections={[]} />);
  assert.equal(emptyRegistry, before);
  assert.equal((before.match(/<button/g) ?? []).length, 14);
  assert.match(before, /ASSESSMENT &amp; PLAN/);
  assert.ok(before.indexOf("Assessment") < before.indexOf("Plan · Prescriptions"));

  const custom = renderToStaticMarkup(
    <SpineNav
      active="custom:skin-carotenoid-score-scs00000"
      statuses={{}}
      onSelect={() => undefined}
      customSections={[{ id: "custom:skin-carotenoid-score-scs00000", label: "Skin Carotenoid Score" }]}
      onAddSection={() => undefined}
    />,
  );
  assert.match(custom, /Skin Carotenoid Score/);
  assert.match(custom, /\+ Add section/);
  assert.equal((custom.match(/<button/g) ?? []).length, 16);
  assert.deepEqual(sectionStatus({}, "custom:missing"), { completed: false });
});

test("SpineNav groups the traditional spine and appends custom sections after every built-in group", () => {
  const html = renderToStaticMarkup(
    <SpineNav
      active="va"
      statuses={{}}
      onSelect={() => undefined}
      customSections={[{ id: "custom:tear-pattern-eye00000", label: "Tear Pattern" }]}
    />,
  );
  const labels = [
    "PRETEST",
    "Wearing (WRx)",
    "Auto-Refraction / Auto-K",
    "Visual Acuity",
    "IOP",
    "REFRACTION",
    "Refraction History",
    "CONTACT LENSES",
    "Soft Contact Lenses",
    "Specialty Contact Lens",
    "Ortho-K",
    "Myopia Management",
    "OCULAR HEALTH",
    "Cup/Disc",
    "Dry Eye",
    "ASSESSMENT &amp; PLAN",
    "Assessment",
    "Plan · Prescriptions",
    "Tear Pattern",
  ];
  let previousIndex = -1;
  for (const label of labels) {
    const index = html.indexOf(label);
    assert.ok(index > previousIndex, `${label} should follow the prior spine entry`);
    previousIndex = index;
  }
});

test("ongoing Dry Eye and Myopia summaries stay visible without a completed dot", () => {
  const html = renderToStaticMarkup(
    <SpineNav
      active="dry-eye"
      statuses={{
        "dry-eye": { completed: false, summary: "OSDI 34" },
        "myopia-management": { completed: false, summary: "OD axial length 24.12 mm" },
      }}
      onSelect={() => undefined}
    />,
  );
  assert.match(html, /OSDI 34/);
  assert.match(html, /OD axial length 24\.12 mm/);
  assert.doesNotMatch(html, /bg-emerald-400/);

  for (const file of ["DryEyeSection.tsx", "MyopiaManagementSection.tsx"]) {
    const source = readFileSync(new URL(`../src/components/charting/${file}`, import.meta.url), "utf8");
    const markSaved = source.slice(source.indexOf("function markSaved"));
    assert.match(markSaved, /completed: false/);
  }
});

test("the generic renderer shows ordered fields, OD and OS columns, automatic notes, and history", () => {
  const html = renderToStaticMarkup(
    <CustomFindingSection
      definition={{
        stableKey: "custom:tear-pattern-eye00000",
        sectionKey: "custom:tear-pattern-eye00000",
        display: "Tear Pattern",
        active: true,
        perEye: true,
        customFields: [{
          localCode: "CUSTOM_PATTERN_12345678",
          display: "Pattern",
          valueType: "select",
          options: [{ code: "stable", display: "Stable", active: true }],
          order: 0,
          active: true,
        }],
      }}
      patientReference="Patient/p1"
      encounterReference="Encounter/e1"
      onSaved={() => undefined}
    />,
  );
  assert.match(html, /Tear Pattern/);
  assert.match(html, />OD</);
  assert.match(html, />OS</);
  assert.match(html, /Pattern/);
  assert.match(html, /Stable/);
  assert.match(html, /Other \/ notes/);
  assert.match(html, /History/);
});

test("the generic renderer reaches and captures a nested child option under its parent", async () => {
  const originalFetch = globalThis.fetch;
  let postedBody: unknown;
  globalThis.fetch = (async (_input, init) => {
    if (init?.method === "POST") {
      postedBody = JSON.parse(String(init.body));
      return jsonResponse({});
    }
    return jsonResponse({ rows: [] });
  }) as typeof fetch;
  let renderer!: ReactTestRenderer;
  try {
    await act(async () => {
      renderer = create(<CustomFindingSection
        definition={{
          stableKey: "custom:nested-findings-nest0000",
          display: "Nested Findings",
          active: true,
          perEye: false,
          customFields: [{
            localCode: "CUSTOM_NESTED_12345678",
            display: "Findings",
            valueType: "multi-select",
            options: [
              { code: "severity", display: "Severity", active: true },
              { code: "severity::central", display: "Central", active: true, parentCode: "severity" },
            ],
            order: 0,
            active: true,
          }],
        }}
        patientReference="Patient/p1"
        encounterReference="Encounter/e1"
        apiBase=""
        onSaved={() => undefined}
      />);
      await Promise.resolve();
    });
    assert.equal(renderer.root.findAllByType("input").length, 1);
    act(() => renderer.root.findByType("input").props.onChange({ target: { checked: true } }));
    const checkboxes = renderer.root.findAllByType("input");
    assert.equal(checkboxes.length, 2);
    assert.equal(checkboxes[1]!.parent?.children.at(-1), "Central");
    act(() => checkboxes[1]!.props.onChange({ target: { checked: true } }));
    const saveButton = renderer.root.findAllByType("button").find((button) => button.children.join("") === "Save Nested Findings");
    assert.ok(saveButton);
    await act(async () => saveButton.props.onClick());
    assert.deepEqual(postedBody, {
      patientReference: "Patient/p1",
      encounterReference: "Encounter/e1",
      customFields: [{ code: "CUSTOM_NESTED_12345678", value: ["severity", "severity::central"] }],
    });
  } finally {
    renderer?.unmount();
    globalThis.fetch = originalFetch;
  }
});

test("the custom-field editor captures hierarchy and priority metadata for new options", async () => {
  let saved: CustomFieldEditorValue | undefined;
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(<CustomFieldEditor
      onCancel={() => undefined}
      onSave={(value) => { saved = value; }}
    />);
  });
  const selects = renderer.root.findAllByType("select");
  act(() => selects[0]!.props.onChange({ target: { value: "multi-select" } }));
  const inputs = renderer.root.findAllByType("input");
  act(() => inputs[0]!.props.onChange({ target: { value: "Findings" } }));
  act(() => renderer.root.findByType("textarea").props.onChange({
    target: { value: "severity | Severity | | priority\nseverity::central | Central | severity" },
  }));
  const saveButton = renderer.root.findAllByType("button").find((button) => button.children.join("") === "Save field");
  assert.ok(saveButton);
  await act(async () => saveButton.props.onClick());
  assert.deepEqual(saved?.options, [
    { code: "severity", display: "Severity", active: true, priority: true },
    { code: "severity::central", display: "Central", active: true, parentCode: "severity" },
  ]);
  renderer.unmount();
});

test("the shared section editor composes fields through the shipped custom-field editor affordance", () => {
  const html = renderToStaticMarkup(<CustomSectionEditor onCancel={() => undefined} onSave={() => undefined} />);
  assert.match(html, /Create chart section/);
  assert.match(html, /Chart OD and OS independently/);
  assert.match(html, /\+ Add field/);
  assert.match(html, /Create section/);
});

test("the anterior renderer exposes explicit all-normal, bilateral copy, deferred, priority, nesting, and Other controls", async () => {
  const definition = {
    stableKey: "ocular-health:anterior:lids-lashes",
    sectionKey: "ocular-health:anterior:lids-lashes",
    display: "Lids & Lashes",
    active: true,
    perEye: true,
    normalTemplate: "Normal lids.",
    allowDeferred: true,
    customFields: [{
      localCode: "CUSTOM_ABNORMAL_FINDINGS_02",
      display: "Abnormal findings",
      valueType: "multi-select" as const,
      options: [
        { code: "demodex", display: "Demodex", active: true, priority: true },
        { code: "demodex::collarettes", display: "Collarettes", active: true, parentCode: "demodex", priority: true },
        { code: "ptosis", display: "Ptosis", active: true },
      ],
      order: 0,
      active: true,
    }],
  };
  const html = renderToStaticMarkup(
    <OcularHealthSection
      definitions={[definition]}
      patientReference="Patient/p1"
      encounterReference="Encounter/e1"
      onSaved={() => undefined}
    />,
  );
  assert.match(html, /Anterior All Normal/);
  assert.match(html, /Nothing defaults to normal/);
  assert.match(html, /Copy to OS/);
  assert.match(html, /Copy to OD/);
  assert.match(html, /Not performed \/ deferred/);
  assert.equal((html.match(/>Other</g) ?? []).length, 2);
  assert.equal((html.match(/Choose an exam state before entering Other\./g) ?? []).length, 2);

  const fetchImpl = (async () => jsonResponse({
    rows: [{ eye: "OD", state: "abnormal", values: [{ code: "CUSTOM_ABNORMAL_FINDINGS_02", value: ["demodex"] }] }],
  })) as typeof fetch;
  let renderer!: ReactTestRenderer;
  try {
    await act(async () => {
      renderer = create(<OcularHealthSection
        definitions={[definition]}
        patientReference="Patient/p1"
        encounterReference="Encounter/e1"
        onSaved={() => undefined}
        apiBase="http://test"
        fetchImpl={fetchImpl}
      />);
      await flushEffects();
    });
    const rendered = JSON.stringify(renderer.toJSON());
    assert.match(rendered, /Demodex/);
    assert.match(rendered, /Collarettes/);
    assert.equal(renderer.root.findByType("summary").children.join(""), "More findings (1)");
    assert.ok(rendered.indexOf("Demodex") < rendered.indexOf('"type":"summary"'));
  } finally {
    renderer?.unmount();
  }
});

test("reopened history hydrates nine structures but posts only the one modified structure", async () => {
  const posts: string[] = [];
  const fetchImpl = (async (input, init) => {
    const url = String(input);
    if (init?.method === "POST") {
      posts.push(url);
      return jsonResponse({});
    }
    return jsonResponse({
      rows: [
        { eye: "OD", state: "normal", values: [], normalTemplate: "Saved OD normal." },
        { eye: "OS", state: "normal", values: [], normalTemplate: "Saved OS normal." },
      ],
    });
  }) as typeof fetch;
  let renderer!: ReactTestRenderer;
  try {
    await act(async () => {
      renderer = create(<OcularHealthSection
        definitions={ocularDefinitions()}
        patientReference="Patient/p1"
        encounterReference="Encounter/e1"
        onSaved={() => undefined}
        apiBase="http://test"
        fetchImpl={fetchImpl}
      />);
      await flushEffects();
    });
    const abnormalButtons = renderer.root.findAllByType("button").filter((button) => button.children.join("") === "Abnormal");
    assert.equal(abnormalButtons.length, 18);
    act(() => abnormalButtons[8]!.props.onClick());
    const saveButton = renderer.root.findAllByType("button").find((button) => button.children.join("") === "Save Anterior Segment");
    assert.ok(saveButton);
    await act(async () => saveButton.props.onClick());
    assert.equal(posts.length, 1);
    assert.match(posts[0]!, /ocular-health%3Aanterior%3Atear-film$/);
  } finally {
    renderer?.unmount();
  }
});

test("a saved normal keeps its captured template snapshot after the live template changes", async () => {
  const fetchImpl = (async () => jsonResponse({
    rows: [{ eye: "OD", state: "normal", values: [], normalTemplate: "Saved normal snapshot." }],
  })) as typeof fetch;
  let renderer!: ReactTestRenderer;
  try {
    const [definition] = ocularDefinitions();
    assert.ok(definition);
    await act(async () => {
      renderer = create(<OcularHealthSection
        definitions={[definition]}
        patientReference="Patient/p1"
        encounterReference="Encounter/e1"
        onSaved={() => undefined}
        apiBase="http://test"
        fetchImpl={fetchImpl}
      />);
      await flushEffects();
    });
    await act(async () => {
      renderer.update(<OcularHealthSection
        definitions={[{ ...definition, normalTemplate: "Later edited live template." }]}
        patientReference="Patient/p1"
        encounterReference="Encounter/e1"
        onSaved={() => undefined}
        apiBase="http://test"
        fetchImpl={fetchImpl}
      />);
    });
    const templates = renderer.root.findAllByProps({ className: "mt-3 text-sm text-white/45" }).map((node) => node.children.join(""));
    assert.equal(templates[0], "Saved normal snapshot.");
    assert.equal(templates[1], "Later edited live template.");
  } finally {
    renderer?.unmount();
  }
});

test("SpineNav nests definition-store anterior structures without moving Cup Disc or Dry Eye", () => {
  const html = renderToStaticMarkup(
    <SpineNav
      active="ocular-health:anterior:cornea"
      statuses={{}}
      onSelect={() => undefined}
      ocularHealthSections={[
        { id: "ocular-health:anterior:periocular-adnexa", label: "Periocular Adnexa" },
        { id: "ocular-health:anterior:cornea", label: "Cornea" },
      ]}
    />,
  );
  assert.ok(html.indexOf("ANTERIOR SEGMENT") < html.indexOf("Periocular Adnexa"));
  assert.ok(html.indexOf("Periocular Adnexa") < html.indexOf("Cornea"));
  assert.ok(html.indexOf("Cornea") < html.indexOf("Cup/Disc"));
  assert.ok(html.indexOf("Cup/Disc") < html.indexOf("Dry Eye"));
});

test("all-normal skips touched structures and copy-to-eye produces an independently editable clone", () => {
  const captures = {
    "ocular-health:anterior:cornea": {
      OD: { state: "abnormal" as const, selections: ["staining"], other: "" },
      OS: { selections: [], other: "" },
    },
    "ocular-health:anterior:lens": {
      OD: { selections: [], other: "" },
      OS: { selections: [], other: "" },
    },
  };
  const result = applyAnteriorAllNormal([
    { stableKey: "ocular-health:anterior:cornea" },
    { stableKey: "ocular-health:anterior:lens" },
  ], captures);
  assert.equal(result.filled, 1);
  assert.equal(result.skipped, 1);
  assert.equal(result.captures["ocular-health:anterior:cornea"]?.OD.state, "abnormal");
  assert.equal(result.captures["ocular-health:anterior:lens"]?.OD.state, "normal");
  assert.equal(result.captures["ocular-health:anterior:lens"]?.OS.state, "normal");

  const source = { state: "abnormal" as const, selections: ["demodex", "demodex::collarettes"], other: "trace" };
  const copied = copyEyeCapture(source);
  copied.selections.push("ptosis");
  assert.deepEqual(source.selections, ["demodex", "demodex::collarettes"]);
  assert.equal(copied.state, "abnormal");
  assert.equal(copied.other, "trace");
});

test("pending-state eyes report touched notes without a state and ignore stated or untouched eyes", () => {
  const pending = pendingStateEyes([
    { stableKey: "ocular-health:anterior:cornea", display: "Cornea" },
    { stableKey: "ocular-health:anterior:lens", display: "Lens" },
  ], {
    "ocular-health:anterior:cornea": {
      OD: { state: "normal", selections: [], other: "clear" },
      OS: { selections: [], other: "trace scar" },
    },
    "ocular-health:anterior:lens": {
      OD: { selections: [], other: "" },
      OS: { state: "abnormal", selections: ["cataract"], other: "mild" },
    },
  });

  assert.deepEqual(pending, [{
    stableKey: "ocular-health:anterior:cornea",
    display: "Cornea",
    eye: "OS",
  }]);
});

test("hydrated state is pristine until a capture differs from its baseline", () => {
  const definitions = ocularDefinitions();
  const hydrated = Object.fromEntries(definitions.map((definition) => [definition.stableKey, {
    OD: { state: "normal" as const, selections: [], other: "", normalTemplate: definition.normalTemplate },
    OS: { state: "normal" as const, selections: [], other: "", normalTemplate: definition.normalTemplate },
  }]));
  assert.equal(changedDefinitions(definitions, hydrated, hydrated).length, 0);
  const edited = structuredClone(hydrated);
  edited[definitions[4]!.stableKey]!.OD.state = "abnormal";
  edited[definitions[4]!.stableKey]!.OD.normalTemplate = undefined;
  assert.deepEqual(changedDefinitions(definitions, edited, hydrated).map((definition) => definition.stableKey), [
    definitions[4]!.stableKey,
  ]);
});

test("EncounterCharting keeps exactly the 14 shipped built-in render branches plus one custom branch", () => {
  const source = readFileSync(new URL("../src/scenes/EncounterCharting.tsx", import.meta.url), "utf8");
  assert.equal((source.match(/activeSection === "/g) ?? []).length, 14);
  assert.equal((source.match(/activeSection\.startsWith\("custom:"\)/g) ?? []).length, 2);
  assert.match(source, /Custom section catalog unavailable; charting built-ins only\./);
});

function ocularDefinitions() {
  return ["periocular-adnexa", "lids-lashes", "palpebral-conjunctiva", "bulbar-conjunctiva", "tear-film", "cornea", "anterior-chamber", "iris-pupil", "lens"].map((name) => ({
    stableKey: `ocular-health:anterior:${name}`,
    sectionKey: `ocular-health:anterior:${name}`,
    display: name.split("-").map((part) => `${part[0]!.toUpperCase()}${part.slice(1)}`).join(" "),
    active: true,
    perEye: true,
    normalTemplate: `Live ${name} normal.`,
    allowDeferred: true,
    customFields: [{
      localCode: `CUSTOM_${name.toUpperCase()}_FINDINGS`,
      display: "Abnormal findings",
      valueType: "multi-select" as const,
      options: [{ code: "finding", display: "Finding", active: true, priority: true }],
      order: 0,
      active: true,
    }],
  }));
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
}

async function flushEffects(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}
