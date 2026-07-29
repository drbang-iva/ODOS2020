import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
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

test("a late longitudinal response cannot render the previous patient's photos", async () => {
  const originalFetch = globalThis.fetch;
  let resolveFirst!: (response: Response) => void;
  const first = new Promise<Response>((resolve) => { resolveFirst = resolve; });
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.includes("procedure-definitions")) return definitionsResponse();
    if (url.includes("Patient%2Fp1")) return first;
    return photosResponse([image("patient-two", "CarePlan/series-2", "Lid margin")]);
  };
  let renderer!: ReactTestRenderer;
  try {
    act(() => {
      renderer = create(<LongitudinalImagingCard patientReference="Patient/p1" />);
    });
    await act(async () => {
      renderer.update(<LongitudinalImagingCard patientReference="Patient/p2" />);
      await Promise.resolve();
    });
    assert.match(JSON.stringify(renderer.toJSON()), /patient-two\.jpg/);

    await act(async () => {
      resolveFirst(photosResponse([image("patient-one-stale", "CarePlan/series-1", "Lid margin")]));
      await Promise.resolve();
    });
    const rendered = JSON.stringify(renderer.toJSON());
    assert.match(rendered, /patient-two\.jpg/);
    assert.doesNotMatch(rendered, /patient-one-stale/);
  } finally {
    renderer?.unmount();
    globalThis.fetch = originalFetch;
  }
});

test("a refreshed longitudinal URL clears the retry marker so a later expiry can refresh again", async () => {
  const originalFetch = globalThis.fetch;
  const urls = [
    "https://storage.test/photo/1?Signature=expired",
    "https://storage.test/photo/2?Signature=refreshed",
    "https://storage.test/photo/3?Signature=refreshed-again",
  ];
  let photoCalls = 0;
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.includes("procedure-definitions")) return definitionsResponse();
    const photo = image("retry", "CarePlan/series-1", "Lid margin");
    photo.contentUrl = urls[Math.min(photoCalls, urls.length - 1)];
    photoCalls += 1;
    return photosResponse([photo]);
  };
  let renderer!: ReactTestRenderer;
  try {
    await act(async () => {
      renderer = create(<LongitudinalImagingCard patientReference="Patient/p1" />);
      await Promise.resolve();
    });
    let renderedImage = renderer.root.findByType("img");
    assert.match(renderedImage.props.src, /expired/);

    await act(async () => {
      await renderedImage.props.onError();
      await Promise.resolve();
    });
    renderedImage = renderer.root.findByType("img");
    assert.match(renderedImage.props.src, /refreshed/);

    await act(async () => {
      await renderedImage.props.onError();
      await Promise.resolve();
    });
    renderedImage = renderer.root.findByType("img");
    assert.match(renderedImage.props.src, /refreshed-again/);
    assert.equal(photoCalls, 3);
  } finally {
    renderer?.unmount();
    globalThis.fetch = originalFetch;
  }
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

function definitionsResponse(): Response {
  return new Response(JSON.stringify({
    definitions: [{ stableKey: "procedure-one", display: "Procedure one", photo_posture: "timeline" }],
  }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function photosResponse(images: LongitudinalImageSummary[]): Response {
  return new Response(JSON.stringify({ images }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}
