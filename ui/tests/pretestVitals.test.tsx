import assert from "node:assert/strict";
import { test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { SerialTrendChart } from "../src/components/charting/SerialTrendChart";
import { PretestVitalsSection } from "../src/components/charting/PretestVitalsSection";
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

test("diagnosis axis exposes an explicit blood-pressure entry control without selecting a diagnosis", () => {
  const html = renderToStaticMarkup(<DiagnosisWorkspace patientReference="Patient/p1" encounterReference="Encounter/e1" onSelectDiagnosis={() => undefined} onOpenBloodPressure={() => undefined} />);
  assert.match(html, /Record blood pressure/);
});
