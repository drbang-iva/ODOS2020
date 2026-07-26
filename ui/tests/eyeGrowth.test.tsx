import assert from "node:assert/strict";
import { test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import {
  AxialGrowthChart,
  type AxialGrowthReading,
} from "../src/components/charting/AxialGrowthChart";
import { EyeGrowthSection } from "../src/components/charting/EyeGrowthSection";

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
        medianRepresentsHealthy: false,
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
  assert.match(html, /TYPICAL FOR COHORT/);
  assert.match(html, /BORDERLINE LENGTH/);
  assert.match(html, /EXCESSIVE LENGTH/);
  assert.doesNotMatch(html, /NORMAL RANGE|OUTSIDE NORMAL/);
  assert.doesNotMatch(html, /#22c55e/);
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
        medianRepresentsHealthy: true,
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
  assert.match(html, /TYPICAL LENGTH/);
  assert.match(html, /#22c55e/);
});

test("thresholds absent from the published percentile set render no centile zones", () => {
  const html = renderToStaticMarkup(
    <AxialGrowthChart
      readings={readings}
      referenceDataset={{
        datasetId: "mismatched-threshold-fixture",
        version: "1.0.0",
        citation: "Synthetic fixture.",
        populationNote: "Synthetic fixture.",
        medianRepresentsHealthy: true,
        ageRangeMin: 6,
        ageRangeMax: 15,
        percentiles: [2, 50, 98],
        zoneThresholds: { neutralUpper: 25, typicalUpper: 50, borderlineUpper: 75 },
        rows: [
          { age: 6, values: [21.08, 22.61, 24.00] },
          { age: 15, values: [21.99, 23.63, 25.57] },
        ],
      }}
      noReferenceMessage={null}
    />,
  );
  assert.equal((html.match(/data-centile-zone=/g) ?? []).length, 0);
  assert.match(html, /Eye length vs age-matched peers/i);
});

test("reference lines and centile polygons sort unsorted rows by age", () => {
  const html = renderToStaticMarkup(
    <AxialGrowthChart
      readings={[]}
      referenceDataset={{
        datasetId: "unsorted-row-fixture",
        version: "1.0.0",
        citation: "Synthetic fixture.",
        populationNote: "Synthetic fixture.",
        medianRepresentsHealthy: true,
        ageRangeMin: 6,
        ageRangeMax: 15,
        percentiles: [2, 25, 50, 75, 98],
        zoneThresholds: { neutralUpper: 25, typicalUpper: 50, borderlineUpper: 75 },
        rows: [
          { age: 15, values: [21.99, 23.06, 23.63, 24.23, 25.57] },
          { age: 6, values: [21.08, 22.13, 22.61, 23.08, 24.00] },
          { age: 12, values: [21.83, 22.90, 23.44, 24.00, 25.17] },
          { age: 9, values: [21.53, 22.59, 23.10, 23.61, 24.65] },
        ],
      }}
      noReferenceMessage={null}
    />,
  );
  const referenceLine = html.match(/<polyline[^>]*points="([^"]+)"[^>]*data-percentile="2"/)?.[1];
  const neutralZone = html.match(/<polygon[^>]*points="([^"]+)"[^>]*data-centile-zone="neutral"/)?.[1];
  assert.deepEqual(referenceLine?.split(" ").map((point) => Number(point.split(",")[0])), [58, 308, 558, 808]);
  assert.deepEqual(neutralZone?.split(" ").map((point) => Number(point.split(",")[0])), [58, 58, 308, 558, 808, 808]);
});

test("malformed optional corneal radii report field errors without discarding valid axial lengths", async () => {
  for (const eyes of [
    { OD: { axialLength: "24.12", cornealRadius: "7.7.4" } },
    {
      OD: { axialLength: "24.12", cornealRadius: "bad-od" },
      OS: { axialLength: "24.31", cornealRadius: "bad-os" },
    },
  ]) {
    const { posted, rendered } = await submitEyeGrowthFixture(eyes);
    assert.equal(posted?.eyes.OD.axialLengthMm, 24.12);
    assert.equal("cornealRadiusMm" in posted!.eyes.OD, false);
    assert.match(rendered, /Corneal radius for OD is not a number/);
    assert.doesNotMatch(rendered, /Enter axial length for OD, OS, or both eyes/);
    if ("OS" in eyes) {
      assert.equal(posted?.eyes.OS.axialLengthMm, 24.31);
      assert.equal("cornealRadiusMm" in posted!.eyes.OS, false);
      assert.match(rendered, /Corneal radius for OS is not a number/);
    }
  }
});

test("the generic axial-length prompt appears only when axial length is genuinely missing", async () => {
  const { posted, rendered } = await submitEyeGrowthFixture({
    OD: { axialLength: "", cornealRadius: "7.70" },
  });
  assert.equal(posted, null);
  assert.match(rendered, /Enter axial length for OD, OS, or both eyes/);
  assert.doesNotMatch(rendered, /Corneal radius for OD is not a number/);
});

async function submitEyeGrowthFixture(
  input: Partial<Record<"OD" | "OS", { axialLength: string; cornealRadius: string }>>,
): Promise<{ posted: { eyes: Record<string, Record<string, unknown>> } | null; rendered: string }> {
  const originalFetch = globalThis.fetch;
  let posted: { eyes: Record<string, Record<string, unknown>> } | null = null;
  let renderer!: ReactTestRenderer;
  globalThis.fetch = async (request, init) => {
    const url = String(request);
    if (url.includes("/clinical-graph/eye-growth/history")) {
      return Response.json({
        referencePopulation: "NOT_REPRESENTED",
        patientSex: "FEMALE",
        birthDate: "2016-07-26",
        readings: [],
        referenceDataset: null,
        noReferenceMessage: "Fixture has no reference dataset.",
      });
    }
    if (url.includes("/clinical-graph/eye-growth/axial-length") && init?.method === "POST") {
      posted = JSON.parse(String(init.body)) as typeof posted;
      return Response.json({ ok: true });
    }
    throw new Error(`Unexpected Eye Growth fixture request: ${url}`);
  };
  try {
    await act(async () => {
      renderer = create(
        <EyeGrowthSection
          patientReference="Patient/p1"
          encounterReference="Encounter/e1"
          onSaved={() => undefined}
        />,
      );
    });
    for (const [eye, values] of Object.entries(input) as Array<
      ["OD" | "OS", { axialLength: string; cornealRadius: string }]
    >) {
      act(() => {
        renderer.root.findByProps({ "aria-label": `${eye} axial length in millimeters` })
          .props.onChange({ target: { value: values.axialLength } });
        renderer.root.findByProps({ "aria-label": `${eye} corneal radius in millimeters` })
          .props.onChange({ target: { value: values.cornealRadius } });
      });
    }
    const recordButton = renderer.root.findAllByType("button")
      .find((button) => button.children.includes("Record measurement"));
    assert.ok(recordButton);
    await act(async () => {
      recordButton.props.onClick();
      await Promise.resolve();
      await Promise.resolve();
    });
    return { posted, rendered: JSON.stringify(renderer.toJSON()) };
  } finally {
    if (renderer) act(() => renderer.unmount());
    globalThis.fetch = originalFetch;
  }
}
