import assert from "node:assert/strict";
import { test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { DilationSection } from "../src/components/charting/DilationSection";
import { EomSection } from "../src/components/charting/EomSection";
import { CoverTestSection } from "../src/components/charting/CoverTestSection";
import { EntranceMeasurementSection } from "../src/components/charting/EntranceMeasurementSection";
import { EntranceStateSection } from "../src/components/charting/EntranceStateSection";
import { SpineNav } from "../src/components/charting/SpineNav";
import type { CustomFindingDefinition } from "../src/components/charting/CustomFindingSection";

test("E2 adds nine independent static rows to the PRETEST spine in clinical order", () => {
  const html = renderToStaticMarkup(<SpineNav active="pupils" statuses={{}} onSelect={() => undefined} />);
  const labels = [
    "Auto-Refraction / Auto-K",
    "Manual Keratometry",
    "Pachymetry",
    "Visual Acuity",
    "Pupils",
    "Stereopsis",
    "Color Vision",
    "EOM / Diplopia",
    "Confrontation Visual Fields",
    "Cover Test",
    "IOP",
    "Dilation",
  ];
  let previous = -1;
  for (const label of labels) {
    const index = html.indexOf(label);
    assert.ok(index > previous, `${label} should follow the prior PRETEST row`);
    previous = index;
  }
  assert.equal((html.match(/data-spine-group="PRETEST"/g) ?? []).length, 1);
});

test("E2 renders CVF through the unchanged generic state section", () => {
  const html = renderToStaticMarkup(<EntranceStateSection
    definition={{ stableKey: "entrance:cvf", sectionKey: "entrance:cvf", display: "Confrontation visual fields", active: true, perEye: true, normalTemplate: "Full to finger counting OU", allowDeferred: true, customFields: [
      { localCode: "CUSTOM_CVF_SUPERIOR_NASAL", display: "Superior nasal", valueType: "select", options: [{ code: "restricted", display: "restricted", active: true }, { code: "full", display: "full", active: true }], order: 0, active: true },
    ] }}
    patientReference="Patient/p1" encounterReference="Encounter/e1" onSaved={() => undefined}
  />);
  assert.match(html, /Full to finger counting OU/);
});

test("E2 bespoke sections expose nine-position diplopia and four cover-test rows", () => {
  const eom = renderToStaticMarkup(<EomSection definition={{ stableKey: "entrance:eom", display: "EOM / diplopia", active: true, perEye: true, customFields: [] }} patientReference="Patient/p1" encounterReference="Encounter/e1" onSaved={() => undefined} />);
  assert.match(eom, /Full OU — SAFE/);
  assert.match(eom, /Nine-position motility, nystagmus, and structured diplopia findings/);
  const cover = renderToStaticMarkup(<CoverTestSection patientReference="Patient/p1" encounterReference="Encounter/e1" onSaved={() => undefined} />);
  for (const label of ["Distance cc", "Distance sc", "Near cc", "Near sc"]) assert.match(cover, new RegExp(label));
  assert.match(cover, /Free-text note/);
});

test("entrance state sections expose Normal OU, explicit per-eye states, fields, and History", () => {
  const html = renderToStaticMarkup(<EntranceStateSection
    definition={{
      stableKey: "entrance:pupils",
      sectionKey: "entrance:pupils",
      display: "Pupils",
      active: true,
      perEye: true,
      normalTemplate: "PERRLA; no APD OU",
      allowDeferred: true,
      customFields: [
        { localCode: "CUSTOM_PUPIL_SIZE_BRIGHT", display: "Size — bright", valueType: "number", min: 0, max: 15, step: 0.5, unit: "mm", order: 0, active: true },
        { localCode: "CUSTOM_PUPIL_SHAPE", display: "Shape", valueType: "select", options: [{ code: "round", display: "round", active: true }], order: 1, active: true },
      ],
    }}
    patientReference="Patient/p1"
    encounterReference="Encounter/e1"
    onSaved={() => undefined}
  />);
  assert.match(html, /Normal OU/);
  assert.match(html, /PERRLA; no APD OU/);
  assert.equal((html.match(/>normal</g) ?? []).length, 2);
  assert.equal((html.match(/>abnormal</g) ?? []).length, 2);
  assert.equal((html.match(/>deferred</g) ?? []).length, 2);
  assert.match(html, /History/);
});

test("measurement sections use centered spinner controls without state buttons", () => {
  const html = renderToStaticMarkup(<EntranceMeasurementSection
    definition={measurementDefinition()}
    patientReference="Patient/p1"
    encounterReference="Encounter/e1"
    onSaved={() => undefined}
  />);
  assert.match(html, /Manual keratometry/);
  assert.match(html, /Per-eye measurements; no normal state is inferred/);
  assert.match(html, /Flat K/);
  assert.match(html, /43\.50/);
  assert.doesNotMatch(html, />Normal</);
  assert.doesNotMatch(html, />Abnormal</);
});

test("dilation renders agent capture, DFE flag, declined counseling, and chart-note history", () => {
  const definition: CustomFindingDefinition = {
    stableKey: "entrance:dilation",
    sectionKey: "entrance:dilation",
    display: "Dilation",
    active: true,
    perEye: false,
    customFields: [],
    fields: {
      agent: { options: [{ code: "tropicamide-1", display: "Tropicamide 1%", active: true }] },
    },
  };
  const html = renderToStaticMarkup(<DilationSection
    definition={definition}
    patientReference="Patient/p1"
    encounterReference="Encounter/e1"
    onSaved={() => undefined}
  />);
  assert.match(html, /Tropicamide 1%/);
  assert.match(html, /Dilated fundus examination performed/);
  assert.match(html, /Patient declined dilation/);
  assert.match(html, /Chart note history/);
});

function measurementDefinition(): CustomFindingDefinition {
  return {
    stableKey: "manual_keratometry",
    sectionKey: "entrance:manual-keratometry",
    display: "Manual keratometry",
    active: true,
    perEye: true,
    customFields: [
      { localCode: "CUSTOM_FLAT_K", display: "Flat K", valueType: "number", min: 30, max: 60, step: 0.01, unit: "[diop]", order: 0, active: true },
      { localCode: "CUSTOM_FLAT_AXIS", display: "Flat axis", valueType: "number", min: 0, max: 180, step: 1, order: 1, active: true },
      { localCode: "CUSTOM_STEEP_K", display: "Steep K", valueType: "number", min: 30, max: 60, step: 0.01, unit: "[diop]", order: 2, active: true },
      { localCode: "CUSTOM_STEEP_AXIS", display: "Steep axis", valueType: "number", min: 0, max: 180, step: 1, order: 3, active: true },
      { localCode: "CUSTOM_MIRES_QUALITY", display: "Mires quality", valueType: "select", options: [{ code: "clear", display: "clear", active: true }], order: 4, active: true },
    ],
  };
}
