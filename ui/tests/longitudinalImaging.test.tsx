import assert from "node:assert/strict";
import { test } from "node:test";
import React, { createRef } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  CameraPreview,
  PhotoCompare,
  PhotoTimeline,
  defaultLensForPhotoPosture,
  type LongitudinalPhoto,
} from "../src/components/patient/LongitudinalImaging";

const photos: LongitudinalPhoto[] = [
  photo("baseline", "2026-01-10T15:00:00Z", "CarePlan/series-1"),
  photo("middle", "2026-03-10T15:00:00Z", "CarePlan/series-1"),
  photo("latest", "2026-06-10T15:00:00Z", "CarePlan/series-1"),
];

test("timeline lens renders a date-ordered strip for one patient structure", () => {
  const html = renderToStaticMarkup(<PhotoTimeline photos={photos} />);
  assert.match(html, /Meibomian glands timeline/);
  assert.match(html, /data-testid="photo-timeline"/);
  assert.ok(html.indexOf("Jan 10, 2026") < html.indexOf("Mar 10, 2026"));
  assert.ok(html.indexOf("Mar 10, 2026") < html.indexOf("Jun 10, 2026"));
  assert.equal((html.match(/ · series/g) ?? []).length, 3);
});

test("compare lens renders any selected two images side by side", () => {
  const html = renderToStaticMarkup(<PhotoCompare first={photos[0]} second={photos[2]} />);
  assert.match(html, /data-testid="photo-compare"/);
  assert.match(html, /baseline\.png/);
  assert.match(html, /latest\.png/);
  assert.equal((html.match(/<img/g) ?? []).length, 2);
});

test("camera preview renders the prior same-structure image as a translucent ghost overlay", () => {
  const html = renderToStaticMarkup(
    <CameraPreview videoRef={createRef<HTMLVideoElement>()} priorPhoto={photos[2]} />,
  );
  assert.match(html, /data-testid="camera-preview"/);
  assert.match(html, /data-testid="ghost-overlay"/);
  assert.match(html, /opacity-35/);
  assert.match(html, /Ghost overlay from Jun 10, 2026/);
});

test("procedure photo_posture data maps to the initial viewing lens without a discipline rule", () => {
  assert.equal(defaultLensForPhotoPosture("monitoring"), "timeline");
  assert.equal(defaultLensForPhotoPosture("showcase"), "compare");
});

function photo(id: string, recordedAt: string, seriesReference?: string): LongitudinalPhoto {
  return {
    mediaReference: `Media/${id}`,
    recordedAt,
    title: `${id}.png`,
    contentType: "image/png",
    dataUrl: `data:image/png;base64,${Buffer.from(id).toString("base64")}`,
    structure: "Meibomian glands",
    encounterReference: "Encounter/e1",
    ...(seriesReference ? { seriesReference } : {}),
  };
}
