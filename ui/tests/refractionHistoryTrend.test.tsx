import assert from "node:assert/strict";
import { test } from "node:test";
import React from "react";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { RefractionHistorySection } from "../src/components/charting/RefractionHistorySection";

(globalThis as typeof globalThis & { React: typeof React }).React = React;

test("manifest distance acuity trend excludes other refraction types and preserves same-date readings", async () => {
  const harness = await renderHistory([
    glassesRow("MANIFEST", "OD", "2024-08-01T14:00:00.000Z", "20/20"),
    glassesRow("MANIFEST", "OD", "2024-08-01T14:00:00.000Z", "20/40-2"),
    glassesRow("MANIFEST", "OS", "2025-08-01T14:00:00.000Z", "20/200"),
    glassesRow("FINAL_RX", "OD", "2025-08-01T14:00:00.000Z", "20/400"),
    glassesRow("AUTOREFRACTION", "OS", "2025-08-01T14:00:00.000Z", "20/800"),
  ]);
  try {
    const trend = harness.renderer.root.findByProps({ "aria-label": "Manifest distance acuity trend" });
    const titles = trend.findAllByType("title").map(textContent);
    assert.equal(trend.findAllByType("circle").length, 3);
    assert.ok(titles.some((title) => title.includes("OD") && title.includes("20/20")));
    assert.ok(titles.some((title) => title.includes("OD") && title.includes("20/40-2")));
    assert.ok(titles.some((title) => title.includes("OS") && title.includes("20/200")));
    assert.ok(titles.every((title) => !title.includes("20/400") && !title.includes("20/800")));
    const yLabels = trend.findAllByType("text")
      .filter((node) => node.props.x === 4)
      .map(textContent);
    assert.deepEqual(yLabels, ["20/20", "20/200"]);
  } finally {
    harness.restore();
  }
});

test("an unparseable manifest distance acuity remains visible", async () => {
  const harness = await renderHistory([
    glassesRow("MANIFEST", "OD", "2025-08-02T14:00:00.000Z", "CF"),
  ]);
  try {
    const trend = harness.renderer.root.findByProps({ "aria-label": "Manifest distance acuity trend" });
    assert.match(textContent(trend), /No chartable manifest distance acuity/);
    assert.match(textContent(harness.renderer.root), /1 reading not chartable/);
    assert.match(textContent(harness.renderer.root), /OD/);
    assert.match(textContent(harness.renderer.root), /CF/);
  } finally {
    harness.restore();
  }
});

test("manifest distance acuity trend states the empty condition when no manifest history exists", async () => {
  const harness = await renderHistory([]);
  try {
    const trend = harness.renderer.root.findByProps({ "aria-label": "Manifest distance acuity trend" });
    assert.match(textContent(trend), /No manifest distance acuity recorded/);
  } finally {
    harness.restore();
  }
});

test("a constant manifest acuity labels the axis with the recorded Snellen equivalent", async () => {
  const harness = await renderHistory([
    glassesRow("MANIFEST", "OD", "2025-08-03T14:00:00.000Z", "20/20"),
  ]);
  try {
    const trend = harness.renderer.root.findByProps({ "aria-label": "Manifest distance acuity trend" });
    const yLabels = trend.findAllByType("text")
      .filter((node) => node.props.x === 4)
      .map(textContent);
    assert.deepEqual(yLabels, ["20/20", "20/20"]);
  } finally {
    harness.restore();
  }
});

test("coincident manifest readings remain independently visible", async () => {
  const harness = await renderHistory([
    glassesRow("MANIFEST", "OD", "2025-08-04T14:00:00.000Z", "20/20"),
    glassesRow("MANIFEST", "OS", "2025-08-04T14:00:00.000Z", "20/20"),
  ]);
  try {
    const trend = harness.renderer.root.findByProps({ "aria-label": "Manifest distance acuity trend" });
    const circles = trend.findAllByType("circle");
    assert.equal(circles.length, 2);
    assert.notEqual(circles[0]?.props.cx, circles[1]?.props.cx);
  } finally {
    harness.restore();
  }
});

function glassesRow(typeCode: string, eye: "OD" | "OS", date: string, distVA: string) {
  return {
    type: typeCode,
    typeCode,
    date,
    eye,
    distVA,
  };
}

async function renderHistory(glasses: ReturnType<typeof glassesRow>[]): Promise<{
  renderer: ReactTestRenderer;
  restore(): void;
}> {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => Response.json({ glasses, softCl: [], specialtyCl: [] });
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(<RefractionHistorySection patientReference="Patient/p1" />);
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
