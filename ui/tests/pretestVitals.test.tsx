import assert from "node:assert/strict";
import { test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { SerialTrendChart } from "../src/components/charting/SerialTrendChart";
import { PretestVitalsSection } from "../src/components/charting/PretestVitalsSection";
import { SpineNav } from "../src/components/charting/SpineNav";
import { DiagnosisWorkspace } from "../src/components/charting/DiagnosisWorkspace";
import { CAROTENOID_COLOR_BANDS, carotenoidPresentation } from "../src/lib/carotenoid-score";

test("carotenoid labels use label anchors while colors use independent color bands", () => {
  assert.deepEqual(carotenoidPresentation(15_000), { score: 15_000, label: "Low", color: "Red" });
  // The label/color divergence across 20,000–24,999 is intended and documented.
  assert.deepEqual(carotenoidPresentation(20_000), { score: 20_000, label: "Low", color: "Orange" });
  assert.deepEqual(carotenoidPresentation(24_999), { score: 24_999, label: "Low", color: "Orange" });
  assert.deepEqual(carotenoidPresentation(27_000), { score: 27_000, label: "Below average", color: "Orange" });
  assert.deepEqual(carotenoidPresentation(38_000), { score: 38_000, label: "Lower-middle", color: "Yellow" });
  assert.deepEqual(carotenoidPresentation(42_000), { score: 42_000, label: "Around average", color: "Green" });
  assert.deepEqual(carotenoidPresentation(51_000), { score: 51_000, label: "Above average", color: "Blue" });
  assert.deepEqual(carotenoidPresentation(70_000), { score: 70_000, label: "Very high", color: "Purple" });
  assert.deepEqual(carotenoidPresentation(80_000), { score: 80_000, label: "Extremely high end of the scale", color: "Purple" });
});

test("shared serial chart preserves same-time repeats and renders constant, band, and x-varying overlays", () => {
  const html = renderToStaticMarkup(<SerialTrendChart
    ariaLabel="Trend contract"
    series={[{ id: "reading", label: "Reading", color: "#fff", points: [
      { id: "a", x: 1, value: 10, title: "First" },
      { id: "b", x: 1, value: 12, title: "Repeat" },
    ] }]}
    xDomain={[0, 2]}
    yDomain={[0, 20]}
    xSamples={[0, 1, 2]}
    xFormat={(value) => String(value)}
    yFormat={(value) => String(value)}
    overlays={[
      { kind: "line", id: "constant", label: "Constant target", value: 8, color: "#f00" },
      { kind: "band", id: "fixed", label: "Fixed band", lower: 4, upper: 6, color: "#0f0" },
      { kind: "band", id: "curve", label: "Changing band", lower: (x) => x + 1, upper: (x) => x + 3, color: "#00f" },
    ]}
  />);
  assert.match(html, /First/);
  assert.match(html, /Repeat/);
  assert.match(html, /Constant target/);
  assert.match(html, /Fixed band/);
  assert.match(html, /Changing band/);
});

test("shared serial chart states the honest empty condition", () => {
  const html = renderToStaticMarkup(<SerialTrendChart
    ariaLabel="Empty trend"
    series={[]}
    xFormat={String}
    yFormat={String}
    emptyText="Blood pressure not recorded"
  />);
  assert.match(html, /Blood pressure not recorded/);
});

test("carotenoid color bands render the canonical scanner gauge ranges", () => {
  const html = renderToStaticMarkup(<SerialTrendChart
    ariaLabel="Skin carotenoid score trend"
    series={[{ id: "score", label: "Score", color: "var(--odos-text)", points: [{ id: "reading", x: 1, value: 15_000 }] }]}
    xFormat={String}
    yFormat={String}
    overlays={CAROTENOID_COLOR_BANDS.map((band) => ({
      kind: "band" as const,
      id: band.color,
      label: `${band.color} · ${band.min.toLocaleString()}–${band.max.toLocaleString()}`,
      lower: band.min,
      upper: band.max,
      color: band.hex,
    }))}
  />);
  assert.match(html, /Red · 10,000–19,999/);
});

test("pretest section names the two honest empty states and the fixed S3 device", () => {
  const html = renderToStaticMarkup(<PretestVitalsSection patientReference="Patient/p1" encounterReference="Encounter/e1" onSaved={() => undefined} />);
  assert.match(html, /Blood pressure not recorded/);
  assert.match(html, /Skin carotenoid score not recorded/);
  assert.match(html, /Nu Skin Pharmanex S3/);
  assert.match(html, /aria-label="Skin carotenoid score"[^>]*max="90000"/);
});

test("pretest section presents height and weight as one customary-unit card with one shared time", () => {
  const html = renderToStaticMarkup(<PretestVitalsSection patientReference="Patient/p1" encounterReference="Encounter/e1" onSaved={() => undefined} />);
  assert.match(html, />Height and weight</);
  assert.match(html, /aria-label="Height in inches"/);
  assert.match(html, /aria-label="Weight in pounds"/);
  assert.match(html, /aria-label="Height and weight time"/);
  assert.match(html, />Save height and weight</);
  assert.match(html, /Height not recorded/);
  assert.match(html, /Weight not recorded/);
  const nav = renderToStaticMarkup(<SpineNav active="pretest-vitals" statuses={{}} onSelect={() => undefined} />);
  assert.match(nav, /Vitals \/ BioPhotonic/);
});

test("height and weight save together to the body-measurements endpoint in inches and pounds", async () => {
  const originalFetch = globalThis.fetch;
  const writes: Array<{ url: string; body: unknown }> = [];
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (init?.method === "POST") {
      writes.push({ url, body: JSON.parse(String(init.body)) });
      return Response.json({});
    }
    if (url.includes("/clinical-graph/pretest-vitals/history")) {
      return Response.json({ bloodPressure: [], carotenoid: [], height: null, weight: null });
    }
    throw new Error(`Unexpected request: ${url}`);
  };
  let renderer!: ReactTestRenderer;
  try {
    await act(async () => {
      renderer = create(<PretestVitalsSection patientReference="Patient/p1" encounterReference="Encounter/e1" onSaved={() => undefined} />);
      await Promise.resolve();
      await Promise.resolve();
    });
    act(() => renderer.root.findByProps({ "aria-label": "Height in inches" }).props.onChange({ target: { value: "68.5" } }));
    act(() => renderer.root.findByProps({ "aria-label": "Weight in pounds" }).props.onChange({ target: { value: "154.25" } }));
    act(() => renderer.root.findByProps({ "aria-label": "Height and weight time" }).props.onChange({ target: { value: "2026-08-21T09:15" } }));
    const save = renderer.root.findAllByType("button").find((button) => button.children.join("") === "Save height and weight");
    assert.ok(save);
    await act(async () => {
      save.props.onClick();
      await Promise.resolve();
      await Promise.resolve();
    });
    assert.deepEqual(writes, [{
      url: "/clinical-graph/pretest-vitals/body-measurements",
      body: {
        patientReference: "Patient/p1",
        encounterReference: "Encounter/e1",
        height: { value: 68.5, unit: "in" },
        weight: { value: 154.25, unit: "lb" },
        recordedAt: new Date("2026-08-21T09:15").toISOString(),
      },
    }]);
  } finally {
    renderer?.unmount();
    globalThis.fetch = originalFetch;
  }
});

test("diagnosis workspace does not expose a blood-pressure entry control", () => {
  const html = renderToStaticMarkup(<DiagnosisWorkspace patientReference="Patient/p1" encounterReference="Encounter/e1" onSelectDiagnosis={() => undefined} />);
  assert.doesNotMatch(html, /Record blood pressure/);
});
