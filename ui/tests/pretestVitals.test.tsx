import assert from "node:assert/strict";
import { test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { SerialTrendChart } from "../src/components/charting/SerialTrendChart";
import { PretestVitalsSection } from "../src/components/charting/PretestVitalsSection";
import { DiagnosisWorkspace } from "../src/components/charting/DiagnosisWorkspace";
import { CAROTENOID_LABEL_ANCHORS, carotenoidPresentation } from "../src/lib/carotenoid-score";

test("carotenoid label anchors and color bands remain independently derived from the canonical tables", () => {
  assert.equal(CAROTENOID_LABEL_ANCHORS[0].anchor, 18_000);
  assert.deepEqual(carotenoidPresentation(15_000), { score: 15_000, label: "Low", color: "Red" });
  assert.deepEqual(carotenoidPresentation(20_000), { score: 20_000, label: "Below average", color: "Orange" });
  assert.deepEqual(carotenoidPresentation(27_000), { score: 27_000, label: "Below average", color: "Orange" });
  assert.deepEqual(carotenoidPresentation(38_000), { score: 38_000, label: "Lower-middle", color: "Yellow" });
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

test("pretest section names the two honest empty states and the fixed S3 device", () => {
  const html = renderToStaticMarkup(<PretestVitalsSection patientReference="Patient/p1" encounterReference="Encounter/e1" onSaved={() => undefined} />);
  assert.match(html, /Blood pressure not recorded/);
  assert.match(html, /Skin carotenoid score not recorded/);
  assert.match(html, /Nu Skin Pharmanex S3/);
});

test("diagnosis axis exposes an explicit blood-pressure entry control without selecting a diagnosis", () => {
  const html = renderToStaticMarkup(<DiagnosisWorkspace patientReference="Patient/p1" encounterReference="Encounter/e1" onSelectDiagnosis={() => undefined} onOpenBloodPressure={() => undefined} />);
  assert.match(html, /Record blood pressure/);
});
