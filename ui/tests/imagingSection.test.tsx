import assert from "node:assert/strict";
import { test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import {
  ImagingSection,
  formatBytes,
  groupImagingRows,
  imagingContentType,
  type ImagingSummary,
} from "../src/components/charting/ImagingSection";
import { SpineNav } from "../src/components/charting/SpineNav";

test("imaging section renders chart/visit scope, native capture, and all supported categories", () => {
  const html = renderToStaticMarkup(
    <ImagingSection
      patientReference="Patient/p1"
      encounterReference="Encounter/e1"
      onSaved={() => undefined}
    />,
  );

  assert.match(html, /All chart imaging/);
  assert.match(html, /This visit/);
  assert.match(html, /Capture or import imaging/);
  assert.match(html, /Drop a scan or image here/);
  assert.match(html, /15 MB max/);
  assert.match(html, /type="file"/);
  assert.match(html, /\.pdf,\.bmp,\.heic,\.heif,\.jpg,\.jpeg,\.png,\.tif,\.tiff,\.webp/);
  assert.match(html, /Visual field printout/);
  assert.match(html, /Fundus photo/);
  assert.match(html, /Anterior slit-lamp photo/);
  assert.match(html, /OCT/);
  assert.match(html, /Biometry/);
  assert.match(html, /Referral scan/);
  assert.match(html, /Outside record/);
  assert.match(html, /Interpretation \(optional\)/);
  assert.match(html, /Creates a preliminary DiagnosticReport linked to the uploaded Media/);
  assert.match(html, /Upload to chart/);
  assert.match(html, /disabled=""/);
});

test("OCT rows group by structure then occurrence date and keep unclassified scans visible", () => {
  const rows: ImagingSummary[] = [
    image("macula-new", "2026-07-15T15:00:00Z", "Macula"),
    image("unclassified", "2026-07-14T15:00:00Z"),
    image("macula-old", "2026-06-10T15:00:00Z", "Macula"),
  ];

  const oct = groupImagingRows(rows)[0];

  assert.equal(oct?.category, "oct");
  assert.deepEqual(oct?.structures.map((group) => group.label), ["Macula", "Unclassified OCT"]);
  assert.deepEqual(oct?.structures[0]?.dates.map((group) => group.date), [
    "2026-07-15",
    "2026-06-10",
  ]);
  assert.deepEqual(oct?.structures[1]?.dates[0]?.images.map((row) => row.id), ["unclassified"]);
});

test("an expired image URL is refreshed once, then becomes a broken state with metadata preserved", async () => {
  const originalFetch = globalThis.fetch;
  const urls = [
    "https://storage.test/oct-1/1?Expires=1&Signature=expired",
    "https://storage.test/oct-1/1?Expires=60&Signature=refreshed",
  ];
  let calls = 0;
  globalThis.fetch = async () => {
    const contentUrl = urls[Math.min(calls, urls.length - 1)]!;
    calls += 1;
    return new Response(JSON.stringify({
      images: [image("oct-1", "2026-07-15T15:00:00Z", "Macula", contentUrl)],
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
  let renderer!: ReactTestRenderer;
  try {
    await act(async () => {
      renderer = create(
        <ImagingSection
          patientReference="Patient/p1"
          encounterReference="Encounter/e1"
          onSaved={() => undefined}
        />,
      );
      await Promise.resolve();
    });
    let tileImage = renderer.root.findByType("img");
    assert.match(tileImage.props.src, /Signature=expired/);

    await act(async () => {
      await tileImage.props.onError();
      await Promise.resolve();
    });
    tileImage = renderer.root.findByType("img");
    assert.match(tileImage.props.src, /Signature=refreshed/);

    await act(async () => tileImage.props.onError());
    assert.equal(renderer.root.findAllByType("img").length, 0);
    assert.match(JSON.stringify(renderer.toJSON()), /Image unavailable\. Metadata remains in the chart/);
    assert.match(JSON.stringify(renderer.toJSON()), /oct-1\.png/);
    assert.equal(calls, 2);
  } finally {
    renderer?.unmount();
    globalThis.fetch = originalFetch;
  }
});

test("Imaging is its own top-level spine group after Ocular Health and before Assessment and Plan", () => {
  const html = renderToStaticMarkup(<SpineNav active="imaging" statuses={{}} onSelect={() => undefined} />);
  const ocularHealthIndex = html.indexOf("OCULAR HEALTH");
  const imagingIndex = html.indexOf("IMAGING");
  const assessmentIndex = html.indexOf("ASSESSMENT &amp; PLAN");

  assert.ok(ocularHealthIndex >= 0);
  assert.ok(imagingIndex >= 0);
  assert.ok(assessmentIndex >= 0);
  assert.ok(ocularHealthIndex < imagingIndex);
  assert.ok(imagingIndex < assessmentIndex);
  assert.match(html, /Manual imaging/);
});

test("manual imaging accepts only the server-supported file types", () => {
  assert.equal(imagingContentType({ name: "field.pdf", type: "" }), "application/pdf");
  assert.equal(imagingContentType({ name: "fundus.jpeg", type: "" }), "image/jpeg");
  assert.equal(imagingContentType({ name: "outside-record.exe", type: "" }), undefined);
  assert.equal(imagingContentType({ name: "renamed.jpg", type: "application/octet-stream" }), undefined);
});

test("manual imaging file sizes are shown in chart-friendly units", () => {
  assert.equal(formatBytes(800), "800 B");
  assert.equal(formatBytes(1536), "1.5 KB");
  assert.equal(formatBytes(2 * 1024 * 1024), "2.0 MB");
});

function image(id: string, date: string, structure?: string, contentUrl = `https://storage.test/${id}`): ImagingSummary {
  return {
    id,
    mediaReference: `Media/${id}`,
    category: "oct",
    ...(structure ? { structure } : {}),
    date,
    title: `${id}.png`,
    contentType: "image/png",
    contentUrl,
    contentState: "available",
  };
}
