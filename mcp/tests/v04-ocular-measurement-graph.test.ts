import assert from "node:assert/strict";
import { test } from "node:test";
import type { Bundle, DiagnosticReport, EpisodeOfCare, Observation } from "@medplum/fhirtypes";
import {
  buildObservationSearchParams,
  compareTreatmentEpisodes,
  groupedDiagnosticReport,
  observationHistoryFromBundle,
  summarizeProgression,
} from "../src/fhir/ocularMeasurementGraph.js";

const CODE = "https://osod.dev/fhir/CodeSystem/contact-lens-clinical-observation|central-clearance-settled";

test("Observation history params use standard code, subject, date, and focus search keys", () => {
  const params = buildObservationSearchParams({
    patientReference: "Patient/p1",
    filters: {
      code: CODE,
      dateRange: { start: "2026-01-01", end: "2026-12-31" },
      focusReference: "Device/lens1",
    },
  });

  assert.equal(params.subject, "Patient/p1");
  assert.equal(params.code, CODE);
  assert.equal(params.date, "ge2026-01-01,le2026-12-31");
  assert.equal(params.focus, "Device/lens1");
});

test("Observation history filters by code, laterality text, date range, and focus", () => {
  const bundle: Bundle<Observation> = {
    resourceType: "Bundle",
    type: "searchset",
    entry: [
      { resource: observation("o2", "2026-03-01T00:00:00.000Z", 240, "OD", "Device/lens1") },
      { resource: observation("o1", "2026-02-01T00:00:00.000Z", 260, "OD", "Device/lens1") },
      { resource: observation("o3", "2026-04-01T00:00:00.000Z", 220, "OS", "Device/lens1") },
      { resource: observation("o4", "2025-12-01T00:00:00.000Z", 300, "OD", "Device/lens1") },
      { resource: observation("o5", "2026-02-01T00:00:00.000Z", 280, "OD", "Device/lens2") },
    ],
  };

  const history = observationHistoryFromBundle(bundle, {
    code: CODE,
    eye: "OD",
    dateRange: { start: "2026-01-01", end: "2026-12-31" },
    focusReference: "Device/lens1",
  });

  assert.deepEqual(history.map((item) => item.id), ["o1", "o2"]);
});

test("Progression summary returns pure-data slope, R squared, and largest changes", () => {
  const summary = summarizeProgression(
    [
      observation("o1", "2026-01-01T00:00:00.000Z", 300, "OD", "Device/lens1"),
      observation("o2", "2026-07-01T00:00:00.000Z", 240, "OD", "Device/lens1"),
      observation("o3", "2027-01-01T00:00:00.000Z", 180, "OD", "Device/lens1"),
    ],
    CODE,
    "OD",
  );

  assert.equal(summary.count, 3);
  assert.ok(summary.slopePerYear !== undefined && summary.slopePerYear < 0);
  assert.ok(summary.rSquared !== undefined && summary.rSquared > 0.99);
  assert.equal(summary.notableChangeEvents.length, 2);
});

test("Grouped DiagnosticReport resolver shape preserves report and linked Observations", () => {
  const report: DiagnosticReport = {
    resourceType: "DiagnosticReport",
    status: "final",
    code: { text: "Topography" },
    subject: { reference: "Patient/p1" },
    result: [{ reference: "Observation/o1" }],
    media: [{ link: { reference: "Media/m1" } }],
  };
  const grouped = groupedDiagnosticReport(report, [
    observation("o1", "2026-01-01T00:00:00.000Z", 42, "OD", "Device/topographer"),
  ]);

  assert.equal(grouped.diagnosticReport, report);
  assert.equal(grouped.observations.length, 1);
  assert.equal(grouped.linkedResources[0].reference, "Observation/o1");
});

test("Treatment episode comparison counts observations inside each episode period", () => {
  const episodes: EpisodeOfCare[] = [
    episode("e1", "2026-01-01", "2026-06-30"),
    episode("e2", "2026-07-01", "2026-12-31"),
  ];
  const observations = [
    observation("o1", "2026-03-01T00:00:00.000Z", 1, "OD", "Device/lens1"),
    observation("o2", "2026-08-01T00:00:00.000Z", 2, "OD", "Device/lens1"),
  ];

  const summary = compareTreatmentEpisodes(episodes, observations);

  assert.equal(summary[0].observationCount, 1);
  assert.equal(summary[1].observationCount, 1);
});

function observation(
  id: string,
  effectiveDateTime: string,
  value: number,
  eye: string,
  focusReference: string,
): Observation {
  const [system, code] = CODE.split("|");
  return {
    resourceType: "Observation",
    id,
    status: "final",
    code: { coding: [{ system, code }] },
    subject: { reference: "Patient/p1" },
    focus: [{ reference: focusReference }],
    effectiveDateTime,
    bodySite: { text: eye },
    valueQuantity: { value, system: "http://unitsofmeasure.org", code: "um" },
  };
}

function episode(id: string, start: string, end: string): EpisodeOfCare {
  return {
    resourceType: "EpisodeOfCare",
    id,
    status: "active",
    patient: { reference: "Patient/p1" },
    period: { start, end },
  };
}
