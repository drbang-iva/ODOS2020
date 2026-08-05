import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { COVER_MAGNITUDES, CoverTestSection } from "../src/components/charting/CoverTestSection";
import { CvfSection } from "../src/components/charting/CvfSection";
import { DiagnosisPicker } from "../src/components/charting/DiagnosisPicker";
import { DilationSection } from "../src/components/charting/DilationSection";
import { diplopiaSelectionsComplete, EomSection } from "../src/components/charting/EomSection";
import { EntranceMeasurementSection } from "../src/components/charting/EntranceMeasurementSection";
import { colorPlateTotal, EntranceStateSection } from "../src/components/charting/EntranceStateSection";
import { SpineNav } from "../src/components/charting/SpineNav";
import type { CustomFindingDefinition } from "../src/components/charting/CustomFindingSection";

test("screenshot refinement preserves PRETEST order with a rail-safe Visual Field label", () => {
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
    "Visual Field",
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
  assert.doesNotMatch(html, /Confrontation Visual Fields/);
});

test("stereopsis renders once as binocular and flags its unseeded arcsec setup", () => {
  const html = renderToStaticMarkup(<EntranceStateSection
    definition={{
      stableKey: "entrance:stereo",
      sectionKey: "entrance:stereo",
      display: "Stereopsis",
      active: true,
      perEye: false,
      normalTemplate: "Stereo present",
      allowDeferred: true,
      sourceStatus: "unseeded-needs-operator-input",
      setupMessage: "Seconds-of-arc choices need practice setup; no clinical values were guessed.",
      customFields: [
        { localCode: "CUSTOM_STEREO_TEST", display: "Test", valueType: "select", options: [{ code: "stereo-fly", display: "Stereo Fly", active: true }], order: 0, active: true },
        { localCode: "CUSTOM_STEREO_ARC_SECONDS", display: "Seconds of arc", valueType: "select", options: [], order: 1, active: true },
        { localCode: "CUSTOM_STEREO_UNABLE", display: "Unable to test", valueType: "select", options: [{ code: "yes", display: "yes", active: true }], order: 2, active: true },
      ],
    }}
    patientReference="Patient/p1"
    encounterReference="Encounter/e1"
    onSaved={() => undefined}
  />);
  assert.match(html, />Binocular</);
  assert.doesNotMatch(html, />OD</);
  assert.doesNotMatch(html, />OS</);
  assert.match(html, /Record this binocular test once/);
  assert.match(html, /Needs practice setup/);
});

test("color vision derives only the operator-confirmed Ishihara total", () => {
  assert.equal(colorPlateTotal("ishihara"), "7");
  assert.equal(colorPlateTotal("hrr"), undefined);
  assert.equal(colorPlateTotal(undefined), undefined);
  const source = readFileSync(new URL("../src/components/charting/EntranceStateSection.tsx", import.meta.url), "utf8");
  assert.match(source, /field\.localCode\.endsWith\("_UNABLE"\)/);
  assert.match(source, /type="checkbox"/);
  assert.match(source, /PowerDropdown/);
  assert.match(source, /Needs practice setup/);
});

test("CVF exposes an accessible five-zone click surface over flat coded fields", () => {
  const props = {
    definition: { stableKey: "entrance:cvf", sectionKey: "entrance:cvf", display: "Confrontation visual fields", active: true, perEye: true, normalTemplate: "Full to finger counting OU", customFields: [] },
    fieldDefectDefinition: visualFieldDefinition(),
    patientReference: "Patient/p1",
    encounterReference: "Encounter/e1",
    onSaved: () => undefined,
  };
  const html = renderToStaticMarkup(<CvfSection {...props} />);
  assert.match(html, />Visual Field</);
  assert.match(html, />Field Defect</);
  assert.match(html, /Mark defects directly on the five-zone field/);
  const source = readFileSync(new URL("../src/components/charting/CvfSection.tsx", import.meta.url), "utf8");
  for (const code of ["CUSTOM_CVF_UPPER_LEFT", "CUSTOM_CVF_UPPER_RIGHT", "CUSTOM_CVF_CENTER", "CUSTOM_CVF_LOWER_LEFT", "CUSTOM_CVF_LOWER_RIGHT"]) assert.match(source, new RegExp(code));
  assert.match(source, /aria-label=\{`\$\{eye\} \$\{zone\} field/);
  assert.match(source, /aria-pressed=\{marked\}/);
  assert.match(source, /marked \? "Defect" : "Clear"/);
});

test("Visual Field renders exactly the approved lesion-site descriptor vocabulary", () => {
  const props = {
    definition: { stableKey: "entrance:cvf", sectionKey: "entrance:cvf", display: "Confrontation visual fields", active: true, perEye: true, normalTemplate: "Full to finger counting OU", customFields: [] },
    fieldDefectDefinition: visualFieldDefinition(),
    patientReference: "Patient/p1",
    encounterReference: "Encounter/e1",
    onSaved: () => undefined,
  };
  const html = renderToStaticMarkup(<CvfSection {...props} />);
  for (const label of [
    "No defect",
    "Field loss OD",
    "Field loss OS",
    "Bitemporal hemianopsia",
    "Right homonymous hemianopsia",
    "Left homonymous hemianopsia",
    "Superior right homonymous quadrantanopia",
    "Inferior right homonymous quadrantanopia",
    "Superior left homonymous quadrantanopia",
    "Inferior left homonymous quadrantanopia",
  ]) assert.match(html, new RegExp(label));
  for (const lesionSite of ["Pre-chiasmal", "Chiasmal", "Post-chiasmal"]) {
    assert.match(html, new RegExp(lesionSite));
  }
  assert.doesNotMatch(html, /binasal|nasal step|arcuate|altitudinal|paracentral|temporal wedge/i);
});

test("suppressed visual-field diagnosis stays visible and the override reveals clinician actions", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.includes("diagnosis-candidates")) {
      return Response.json({
        findings: [{
          findingInstanceId: "vf-observation",
          findingDefinitionKey: "entrance:visual-field-defect",
          observationReference: "Observation/vf-observation",
          candidates: [],
          suppressedCandidates: [{
            diagnosisKey: "vf_other_localized",
            display: "Other localized visual field defect",
            icd10: { code: "H53.451" },
            codingStatus: "verified",
            priority: true,
            source: "mapping",
          }],
          suppression: {
            message: "H53.4x not proposed — the glaucoma stage already carries the field defect.",
            overridable: true,
          },
        }],
      });
    }
    if (url.includes("diagnosis-catalog")) return Response.json({ diagnoses: [] });
    throw new Error(`Unexpected request: ${url}`);
  };
  let renderer!: ReactTestRenderer;
  try {
    await act(async () => {
      renderer = create(<DiagnosisPicker
        encounterReference="Encounter/e1"
        observationReferences={["Observation/vf-observation"]}
        findingDefinitionKey="entrance:visual-field-defect"
      />);
      await Promise.resolve();
      await Promise.resolve();
    });
    const serialized = () => JSON.stringify(renderer.toJSON());
    assert.match(serialized(), /H53\.4x not proposed/);
    assert.doesNotMatch(serialized(), /Confirm/);
    const override = renderer.root.findAllByType("button").find((button) => button.children.join("") === "Override");
    assert.ok(override);
    act(() => override.props.onClick());
    assert.match(serialized(), /Other localized visual field defect/);
    assert.match(serialized(), /Possible/);
    assert.match(serialized(), /Confirm/);
  } finally {
    renderer?.unmount();
    globalThis.fetch = originalFetch;
  }
});

test("cover magnitude uses the shared spinner and is bounded from 0 through 60 delta", () => {
  assert.equal(COVER_MAGNITUDES.length, 61);
  assert.deepEqual([COVER_MAGNITUDES[0], COVER_MAGNITUDES.at(-1)], ["0", "60"]);
  const source = readFileSync(new URL("../src/components/charting/CoverTestSection.tsx", import.meta.url), "utf8");
  assert.match(source, /<PowerDropdown/);
  assert.doesNotMatch(source, /type="number"/);
  const html = renderToStaticMarkup(<CoverTestSection patientReference="Patient/p1" encounterReference="Encounter/e1" onSaved={() => undefined} />);
  for (const label of ["Distance cc", "Distance sc", "Near cc", "Near sc"]) assert.match(html, new RegExp(label));
});

test("diplopia choices are blank-safe and cannot be complete without all five selections", () => {
  assert.equal(diplopiaSelectionsComplete("", "", "", "", ""), false);
  assert.equal(diplopiaSelectionsComplete("binocular", "horizontal", "incomitant", "right", "intermittent"), true);
  const source = readFileSync(new URL("../src/components/charting/EomSection.tsx", import.meta.url), "utf8");
  assert.match(source, /useState<"" \| "monocular" \| "binocular">\(""\)/);
  assert.match(source, /\{ value: "", label: "Select" \}/);
  const html = renderToStaticMarkup(<EomSection definition={{ stableKey: "entrance:eom", display: "EOM / diplopia", active: true, perEye: true, customFields: [] }} patientReference="Patient/p1" encounterReference="Encounter/e1" onSaved={() => undefined} />);
  assert.match(html, /Full OU — SAFE/);
});

test("pupil state sections retain explicit per-eye states and centered spinner controls", () => {
  const html = renderToStaticMarkup(<EntranceStateSection
    definition={{
      stableKey: "entrance:pupils",
      sectionKey: "entrance:pupils",
      display: "Pupils",
      active: true,
      perEye: true,
      normalTemplate: "PERRLA; no APD or RAPD OU",
      allowDeferred: true,
      customFields: [
        { localCode: "CUSTOM_PUPIL_SIZE_BRIGHT", display: "Size — bright", valueType: "number", min: 1, max: 9, step: 0.5, unit: "mm", order: 0, active: true },
        { localCode: "CUSTOM_PUPIL_SIZE_NEAR", display: "Size — near", valueType: "number", min: 1, max: 9, step: 0.5, unit: "mm", order: 1, active: true },
      ],
    }}
    patientReference="Patient/p1"
    encounterReference="Encounter/e1"
    onSaved={() => undefined}
  />);
  assert.match(html, /Normal OU/);
  assert.match(html, /PERRLA; no APD or RAPD OU/);
  assert.equal((html.match(/>normal</g) ?? []).length, 2);
  assert.equal((html.match(/>abnormal</g) ?? []).length, 2);
  assert.equal((html.match(/>deferred</g) ?? []).length, 2);
  assert.match(html, /History/);
});

test("manual keratometry uses a shrinkable five-column grid that fits the content pane", () => {
  const html = renderToStaticMarkup(<EntranceMeasurementSection definition={measurementDefinition()} patientReference="Patient/p1" encounterReference="Encounter/e1" onSaved={() => undefined} />);
  assert.match(html, /Manual keratometry/);
  assert.match(html, /grid-cols-\[42px_repeat\(5,minmax\(0,1fr\)\)\]/);
  assert.doesNotMatch(html, /overflow-x-auto/);
  assert.match(html, /Steep axis/);
  assert.match(html, /Mires quality/);
});

test("missing entrance definitions render an explicit practice-setup state", () => {
  const source = readFileSync(new URL("../src/scenes/EncounterCharting.tsx", import.meta.url), "utf8");
  assert.match(source, /MissingDefinitionState section="Pupils"/);
  assert.match(source, /MissingDefinitionState section="Visual Field"/);
  assert.match(source, /Its finding definition is missing or inactive/);
});

test("dilation retains agent capture, DFE flag, declined counseling, and chart-note history", () => {
  const definition: CustomFindingDefinition = {
    stableKey: "entrance:dilation",
    sectionKey: "entrance:dilation",
    display: "Dilation",
    active: true,
    perEye: false,
    customFields: [],
    fields: { agent: { options: [{ code: "tropicamide-1", display: "Tropicamide 1%", active: true }] } },
  };
  const html = renderToStaticMarkup(<DilationSection definition={definition} patientReference="Patient/p1" encounterReference="Encounter/e1" onSaved={() => undefined} />);
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

function visualFieldDefinition(): CustomFindingDefinition {
  return {
    stableKey: "entrance:visual-field-defect",
    sectionKey: "entrance:visual-field-defect",
    display: "Visual Field",
    active: true,
    perEye: false,
    customFields: [{
      localCode: "CUSTOM_FIELD_DEFECT",
      display: "Field Defect",
      valueType: "select",
      options: [
        ["no-defect", "No defect"],
        ["field-loss-od", "Field loss OD"],
        ["field-loss-os", "Field loss OS"],
        ["bitemporal-hemianopsia", "Bitemporal hemianopsia"],
        ["right-homonymous-hemianopsia", "Right homonymous hemianopsia"],
        ["left-homonymous-hemianopsia", "Left homonymous hemianopsia"],
        ["superior-right-homonymous-quadrantanopia", "Superior right homonymous quadrantanopia"],
        ["inferior-right-homonymous-quadrantanopia", "Inferior right homonymous quadrantanopia"],
        ["superior-left-homonymous-quadrantanopia", "Superior left homonymous quadrantanopia"],
        ["inferior-left-homonymous-quadrantanopia", "Inferior left homonymous quadrantanopia"],
      ].map(([code, display]) => ({ code, display, active: true })),
      order: 0,
      active: true,
    }],
  };
}
