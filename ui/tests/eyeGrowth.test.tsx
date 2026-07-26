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
    axialLengthMm: 24.5,
    cornealRadiusMm: null,
    ageInYears: 10.4,
    measuredAt: "2026-05-12T12:00:00Z",
    biometryMethod: "OPTICAL_BIOMETRY",
    instrument: "IOLMaster 700",
    observationReference: "Observation/od-2",
  },
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
    axialLengthMm: 24.8,
    cornealRadiusMm: null,
    ageInYears: 10.4,
    measuredAt: "2026-05-12T12:00:00Z",
    biometryMethod: "ULTRASOUND_A_SCAN",
    instrument: null,
    observationReference: "Observation/os-2",
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

test("Eye Growth renders NOT_REPRESENTED measurements with zero reference bands", () => {
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
  assert.match(html, /data-patient-trend="OD"/);
  assert.match(html, /data-patient-trend="OS"/);
  assert.equal((html.match(/data-patient-point=/g) ?? []).length, 4);
  assert.ok(html.indexOf("OD · age 9.20") < html.indexOf("OD · age 10.40"));
  assert.ok(html.indexOf("OS · age 9.20") < html.indexOf("OS · age 10.40"));
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
        ageRangeMin: 4,
        ageRangeMax: 18,
        percentiles: [3, 5, 10, 25, 50, 75, 90, 95],
        zoneThresholds: { neutralUpper: 25, typicalUpper: 50, borderlineUpper: 75 },
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
  assert.match(html, /Eye length vs age-matched peers/i);
  assert.match(html, /SHORTER THAN TYPICAL/);
  assert.match(html, /TYPICAL LENGTH/);
  assert.match(html, /BORDERLINE LENGTH/);
  assert.match(html, /EXCESSIVE LENGTH/);
  assert.doesNotMatch(html, /NORMAL RANGE|OUTSIDE NORMAL/);
  assert.match(html, /fill="#22c55e"/);
  assert.match(html, /fill="#eab308"/);
  assert.match(html, /fill="#ef4444"/);
});

test("mixed percentile sets render labels and centile zones from the active dataset", () => {
  const html = renderToStaticMarkup(
    <AxialGrowthChart
      readings={readings}
      referenceDataset={{
        datasetId: "truckenbrod-2021-german-axial-length",
        version: "1.0.0",
        citation: "Truckenbrod C et al. Ophthalmic Physiol Opt. 2021.",
        populationNote: "German cohort. Percentiles published at ages 6, 9, 12 and 15 only.",
        ageRangeMin: 6,
        ageRangeMax: 15,
        percentiles: [2, 25, 50, 75, 98],
        zoneThresholds: { neutralUpper: 25, typicalUpper: 50, borderlineUpper: 75 },
        rows: [
          { age: 6, values: [21.08, 22.13, 22.61, 23.08, 24.00] },
          { age: 9, values: [21.53, 22.59, 23.10, 23.61, 24.65] },
          { age: 12, values: [21.83, 22.90, 23.44, 24.00, 25.17] },
          { age: 15, values: [21.99, 23.06, 23.63, 24.23, 25.57] },
        ],
      }}
      noReferenceMessage={null}
    />,
  );
  assert.match(html, /data-reference-band-count="5"/);
  assert.equal((html.match(/data-percentile=/g) ?? []).length, 5);
  assert.match(html, /data-percentile-labels="2,25,50,75,98"/);
  assert.match(html, /Reference percentiles P2 · P25 · P50 · P75 · P98/);
  assert.doesNotMatch(html, /P3 · P5 · P10/);
  assert.equal((html.match(/data-centile-zone=/g) ?? []).length, 4);
});
