import assert from "node:assert/strict";
import { test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ImagingSection, formatBytes, imagingContentType } from "../src/components/charting/ImagingSection";
import { SpineNav } from "../src/components/charting/SpineNav";

test("manual imaging section renders the static scan-in controls and interpretation boundary", () => {
  const html = renderToStaticMarkup(
    <ImagingSection
      patientReference="Patient/p1"
      encounterReference="Encounter/e1"
      onSaved={() => undefined}
    />,
  );

  assert.match(html, /Manual imaging scan-in/);
  assert.match(html, /Drop a scan or image here/);
  assert.match(html, /type="file"/);
  assert.match(html, /\.pdf,\.bmp,\.heic,\.heif,\.jpg,\.jpeg,\.png,\.tif,\.tiff,\.webp/);
  assert.match(html, /Visual field printout/);
  assert.match(html, /Fundus photo/);
  assert.match(html, /Anterior slit-lamp photo/);
  assert.match(html, /Referral scan/);
  assert.match(html, /Outside record/);
  assert.match(html, /Interpretation \(optional\)/);
  assert.match(html, /Creates a preliminary DiagnosticReport linked to the uploaded Media/);
  assert.match(html, /Upload to chart/);
  assert.match(html, /disabled=""/);
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
