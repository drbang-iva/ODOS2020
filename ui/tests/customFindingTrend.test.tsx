import assert from "node:assert/strict";
import { test } from "node:test";
import React from "react";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { CustomFindingSection, type CustomFindingDefinition } from "../src/components/charting/CustomFindingSection";

(globalThis as typeof globalThis & { React: typeof React }).React = React;

test("tear osmolarity history keeps OD and OS in separate series", async () => {
  const harness = await renderOsmolarityHistory([
    historyRow("OD", "2026-07-01T14:00:00.000Z", [osmolarityValue(300)]),
    historyRow("OS", "2026-08-01T14:00:00.000Z", [osmolarityValue(312)]),
  ]);
  try {
    const trend = harness.renderer.root.findByProps({ "aria-label": "Tear osmolarity trend" });
    const seriesGroups = trend.findAllByType("g");
    assert.deepEqual(seriesGroups.map((group) => group.findAllByType("circle").length), [1, 1]);
    const titles = trend.findAllByType("title").map(textContent);
    assert.ok(titles.some((title) => title.includes("OD") && title.includes("300 mOsm/L")));
    assert.ok(titles.some((title) => title.includes("OS") && title.includes("312 mOsm/L")));
  } finally {
    harness.restore();
  }
});

test("an absent tear osmolarity reading never becomes a zero point", async () => {
  const harness = await renderOsmolarityHistory([
    historyRow("OD", "2026-07-01T14:00:00.000Z", [
      { code: "CUSTOM_INSTRUMENT", label: "Instrument", value: "Synthetic analyzer" },
    ]),
    historyRow("OS", "2026-08-01T14:00:00.000Z", [osmolarityValue(309)]),
  ]);
  try {
    const trend = harness.renderer.root.findByProps({ "aria-label": "Tear osmolarity trend" });
    assert.equal(trend.findAllByType("circle").length, 1);
    const titles = trend.findAllByType("title").map(textContent);
    assert.equal(titles.length, 1);
    assert.match(titles[0] ?? "", /OS · 309 mOsm\/L/);
    assert.doesNotMatch(titles[0] ?? "", /OD|0 mOsm\/L/);
  } finally {
    harness.restore();
  }
});

test("coincident tear osmolarity readings remain independently visible", async () => {
  const harness = await renderOsmolarityHistory([
    historyRow("OD", "2026-08-01T14:00:00.000Z", [osmolarityValue(300)]),
    historyRow("OD", "2026-08-01T14:00:00.000Z", [osmolarityValue(300)]),
  ]);
  try {
    const trend = harness.renderer.root.findByProps({ "aria-label": "Tear osmolarity trend" });
    const circles = trend.findAllByType("circle");
    assert.equal(circles.length, 2);
    assert.notEqual(circles[0]?.props.cx, circles[1]?.props.cx);
  } finally {
    harness.restore();
  }
});

test("tear osmolarity trend states the empty condition when history has no osmolarity", async () => {
  const harness = await renderOsmolarityHistory([
    historyRow("OD", "2026-08-01T14:00:00.000Z", [
      { code: "CUSTOM_INSTRUMENT", label: "Instrument", value: "Synthetic analyzer" },
    ]),
  ]);
  try {
    const trend = harness.renderer.root.findByProps({ "aria-label": "Tear osmolarity trend" });
    assert.equal(trend.findAllByType("circle").length, 0);
    assert.match(textContent(trend), /No tear osmolarity recorded/);
  } finally {
    harness.restore();
  }
});

const OSMOLARITY_DEFINITION: CustomFindingDefinition = {
  stableKey: "dry-eye:markers",
  sectionKey: "dry-eye:markers",
  display: "Tear Film Markers",
  active: true,
  perEye: true,
  customFields: [{
    localCode: "CUSTOM_OSMOLARITY_MOSM_L",
    display: "Osmolarity (mOsm/L)",
    valueType: "number",
    unit: "mosm/L",
    min: 0,
    step: 1,
    order: 0,
    active: true,
  }],
};

function historyRow(
  eye: "OD" | "OS",
  recordedAt: string,
  values: Array<{ code: string; label: string; value: number | string; unit?: string }>,
) {
  return { eye, recordedAt, values };
}

function osmolarityValue(value: number) {
  return {
    code: "CUSTOM_OSMOLARITY_MOSM_L",
    label: "Osmolarity (mOsm/L)",
    value,
    unit: "mosm/L",
  };
}

async function renderOsmolarityHistory(rows: ReturnType<typeof historyRow>[]): Promise<{
  renderer: ReactTestRenderer;
  restore(): void;
}> {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => Response.json({ rows });
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(
      <CustomFindingSection
        definition={OSMOLARITY_DEFINITION}
        patientReference="Patient/p1"
        encounterReference="Encounter/e1"
        onSaved={() => undefined}
      />,
    );
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
  return {
    renderer,
    restore() {
      renderer.unmount();
      globalThis.fetch = originalFetch;
    },
  };
}

function textContent(node: ReactTestInstance): string {
  return node.children.map((child) => typeof child === "string" ? child : textContent(child)).join("");
}
