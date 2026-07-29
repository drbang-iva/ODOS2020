import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  LongitudinalImagingCard,
  defaultPhotoLens,
  suggestImagePair,
  type LongitudinalImageSummary,
} from "../src/components/LongitudinalImagingCard";
import { ProcedureDefinitionsSettings } from "../src/scenes/settings/ProcedureDefinitionsSettings";

const DATA = "cGhvdG8=";

test("chart-level longitudinal imaging renders timeline, compare, capture, and consent boundaries", () => {
  const html = renderToStaticMarkup(<LongitudinalImagingCard patientReference="Patient/p1" />);
  assert.match(html, /Longitudinal imaging/);
  assert.match(html, /Clinical photos across visits/);
  assert.match(html, /Timeline/);
  assert.match(html, /Compare/);
  assert.match(html, /Capture or import photo/);
  assert.match(html, /capture="environment"/);
  assert.match(html, /Documented cosmetic consent is checked before capture/);
});

test("procedure photo_posture controls the default viewing lens", () => {
  assert.equal(defaultPhotoLens({ photo_posture: "compare" }), "compare");
  assert.equal(defaultPhotoLens({ photo_posture: "timeline" }), "timeline");
  assert.equal(defaultPhotoLens(undefined), "timeline");
});

test("the longitudinal surface is mounted at chart level and photo posture is managed in Settings", () => {
  const chartSidebar = readFileSync(new URL("../src/components/ChartSidebar.tsx", import.meta.url), "utf8");
  const app = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
  const settings = renderToStaticMarkup(<ProcedureDefinitionsSettings canWrite={true} />);

  assert.match(chartSidebar, /<LongitudinalImagingCard patientReference=/);
  assert.match(app, /case "\/settings\/procedure-definitions"/);
  assert.match(settings, /Procedure definitions/);
  assert.match(settings, /longitudinal images open on the patient chart/);
});

test("compare pairing prefers images linked to the same series and structure", () => {
  const images: LongitudinalImageSummary[] = [
    image("current", "CarePlan/series-1", "Lid margin"),
    image("wrong", "CarePlan/series-1", "Full face"),
    image("baseline", "CarePlan/series-1", "Lid margin"),
  ];
  assert.deepEqual(suggestImagePair(images), ["Media/baseline", "Media/current"]);
});

function image(id: string, seriesReference: string, structure: string): LongitudinalImageSummary {
  return {
    mediaReference: `Media/${id}`,
    createdAt: "2026-07-18T15:00:00.000Z",
    title: `${id}.jpg`,
    contentType: "image/jpeg",
    contentUrl: `data:image/jpeg;base64,${DATA}`,
    contentState: "available",
    structure,
    seriesReference,
  };
}
