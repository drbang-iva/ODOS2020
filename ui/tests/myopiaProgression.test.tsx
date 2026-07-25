import assert from "node:assert/strict";
import { test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  AxialGrowthChart,
  type AxialGrowthReading,
} from "../src/components/charting/AxialGrowthChart";

const readings: AxialGrowthReading[] = [
  {
    eye: "OD",
    axialLengthMm: 24.1,
    cornealRadiusMm: null,
    ageInYears: 9.2,
    measuredAt: "2025-03-01T12:00:00Z",
    biometryMethod: "OPTICAL_BIOMETRY",
    instrument: "IOLMaster 700",
    observationReference: "Observation/od-1",
  },
  {
    eye: "OS",
    axialLengthMm: 24.4,
    cornealRadiusMm: null,
    ageInYears: 9.2,
    measuredAt: "2025-03-01T12:00:00Z",
    biometryMethod: "ULTRASOUND_A_SCAN",
    instrument: null,
    observationReference: "Observation/os-1",
  },
];

test("NOT_REPRESENTED renders both patient-eye series and zero reference bands", () => {
  const html = renderToStaticMarkup(
    <AxialGrowthChart
      readings={readings}
      referenceDataset={null}
      noReferenceMessage="No validated reference data exists for this population. Patient measurements are shown without reference bands."
    />,
  );
  assert.match(html, /data-reference-band-count="0"/);
  assert.match(html, /data-patient-series="OD"/);
  assert.match(html, /data-patient-series="OS"/);
  assert.equal((html.match(/data-patient-point=/g) ?? []).length, 2);
  assert.match(html, /No validated reference data exists for this population/);
  assert.doesNotMatch(html, /typical for this cohort/);
});

test("rendered reference bands always carry citation and population safety note", () => {
  const populationNote =
    "Urban Chinese cohort (n=14,127). Myopia prevalence in this population is among the highest in the world — the 50th percentile here is typical for this cohort, not a marker of normal or healthy eye growth.";
  const html = renderToStaticMarkup(
    <AxialGrowthChart
      readings={readings}
      referenceDataset={{
        datasetId: "he-2023-chinese-axial-length",
        version: "1.0.0",
        citation: "He X et al. Ophthalmology. 2023.",
        populationNote,
        percentiles: [3, 5, 10, 25, 50, 75, 90, 95],
        rows: [
          { age: 4, values: [21, 21.2, 21.4, 21.8, 22.2, 22.6, 23, 23.2] },
          { age: 18, values: [22.8, 23, 23.2, 24, 25.4, 26.2, 27, 27.4] },
        ],
      }}
      noReferenceMessage={null}
    />,
  );
  assert.match(html, /data-reference-band-count="8"/);
  assert.equal((html.match(/data-percentile=/g) ?? []).length, 8);
  assert.match(html, /He X et al/);
  assert.match(html, /typical for this cohort, not a marker of normal or healthy eye growth/);
});
