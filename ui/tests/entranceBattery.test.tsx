import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { customFieldEntries } from "../../mcp/src/clinical-graph/custom-fields";
import { buildFindingDefinitionSeeds } from "../../mcp/src/clinical-graph/finding-definition-store";
import { COVER_MAGNITUDES, CoverTestSection } from "../src/components/charting/CoverTestSection";
import { ClearSectionButton } from "../src/components/charting/ClearControls";
import { ConfirmDestructiveProvider } from "../src/components/charting/ConfirmDestructive";
import { CvfSection } from "../src/components/charting/CvfSection";
import { DiagnosisPicker } from "../src/components/charting/DiagnosisPicker";
import { DilationSection } from "../src/components/charting/DilationSection";
import { diplopiaSelectionsComplete, EomSection } from "../src/components/charting/EomSection";
import { EntranceMeasurementSection } from "../src/components/charting/EntranceMeasurementSection";
import { colorPlateTotal, EntranceStateSection } from "../src/components/charting/EntranceStateSection";
import { SpineNav } from "../src/components/charting/SpineNav";
import type { CustomFindingDefinition } from "../src/components/charting/CustomFindingSection";
import { OdosSearchPicker } from "../src/components/inputs/OdosSearchPicker";

test("screenshot refinement preserves PRETEST order with the backend confrontation label", () => {
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
    "Confrontation visual fields",
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

test("practice-setup warnings keep their clinical refusal and link to chart-field settings", () => {
  const html = renderToStaticMarkup(<EntranceStateSection
    definition={{
      stableKey: "entrance:pupils",
      sectionKey: "entrance:pupils",
      display: "Pupils",
      active: true,
      perEye: true,
      sourceStatus: "unseeded-needs-operator-input",
      setupMessage: "The additional pupil descriptor fields need practice setup before they can be added.",
      customFields: [],
    }}
    patientReference="Patient/p1"
    encounterReference="Encounter/e1"
    onSaved={() => undefined}
  />);
  assert.match(html, /The additional pupil descriptor fields need practice setup before they can be added\./);
  assert.match(html, /href="\/admin\/practice\/settings\/chart-fields"/);
  assert.match(html, />Open chart field settings</);
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

test("CVF renders four accessible quadrant wedges and preserves per-eye controls", async () => {
  const originalFetch = globalThis.fetch;
  let savedPayload: unknown;
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url.includes("history")) return Response.json({ rows: [] });
    if (init?.method === "POST") {
      savedPayload = JSON.parse(String(init.body));
      return Response.json({});
    }
    throw new Error(`Unexpected request: ${url}`);
  };
  const props = {
    definition: { stableKey: "entrance:cvf", sectionKey: "entrance:cvf", display: "Confrontation visual fields", active: true, perEye: true, normalTemplate: "Full to finger counting OU", customFields: [] },
    fieldDefectDefinition: visualFieldDefinition(),
    patientReference: "Patient/p1",
    encounterReference: "Encounter/e1",
    onSaved: () => undefined,
  };
  let renderer!: ReactTestRenderer;
  try {
    await act(async () => {
      renderer = create(<CvfSection {...props} />);
      await Promise.resolve();
      await Promise.resolve();
    });
    const odAbnormal = renderer.root.findAllByType("button")
      .filter((button) => button.children.join("") === "abnormal")[0];
    assert.ok(odAbnormal);
    act(() => odAbnormal.props.onClick());

    const odQuadrants = () => renderer.root.findAllByType("button").filter((button) =>
      typeof button.props["aria-label"] === "string" && button.props["aria-label"].startsWith("OD ") && button.props["aria-label"].includes(" field,"),
    );
    assert.deepEqual(odQuadrants().map((button) => button.props["aria-label"]), [
      "OD upper-left field, clear",
      "OD upper-right field, clear",
      "OD lower-left field, clear",
      "OD lower-right field, clear",
    ]);
    assert.deepEqual(odQuadrants().map((button) => button.props.style), [
      { left: "0", top: "0" },
      { right: "0", top: "0" },
      { bottom: "0", left: "0" },
      { bottom: "0", right: "0" },
    ]);
    assert.equal(odQuadrants().every((button) => button.props.type === "button" && button.props["aria-pressed"] === false), true);

    act(() => odQuadrants()[0]?.props.onClick());
    assert.equal(odQuadrants()[0]?.props["aria-pressed"], true);
    act(() => odQuadrants()[0]?.props.onClick());
    assert.equal(odQuadrants()[0]?.props["aria-pressed"], false);
    let preventedKeyboardDefaults = 0;
    act(() => odQuadrants()[0]?.props.onKeyDown({ key: "Enter", preventDefault: () => { preventedKeyboardDefaults += 1; } }));
    act(() => odQuadrants()[3]?.props.onKeyDown({ key: " ", preventDefault: () => { preventedKeyboardDefaults += 1; } }));
    assert.equal(preventedKeyboardDefaults, 2);
    assert.deepEqual(odQuadrants().map((button) => [button.props["aria-label"], button.props["aria-pressed"]]), [
      ["OD upper-left field, defect", true],
      ["OD upper-right field, clear", false],
      ["OD lower-left field, clear", false],
      ["OD lower-right field, defect", true],
    ]);

    const odNote = renderer.root.findAllByType("textarea")[0];
    assert.equal(odNote?.props.disabled, false);
    act(() => odNote?.props.onChange({ target: { value: "Peripheral field note" } }));
    assert.equal(renderer.root.findAllByType("textarea")[0]?.props.value, "Peripheral field note");
    const unable = renderer.root.findAllByType("input").find((input) => input.props.type === "checkbox");
    assert.ok(unable);
    act(() => unable.props.onChange({ target: { checked: true } }));
    assert.equal(odQuadrants().every((button) => button.props.disabled === true), true);
    const save = renderer.root.findAllByType("button").find((button) => button.children.join("") === "Save CVF");
    assert.ok(save);
    await act(async () => {
      save.props.onClick();
      await Promise.resolve();
      await Promise.resolve();
    });
    assert.deepEqual(savedPayload, {
      patientReference: "Patient/p1",
      encounterReference: "Encounter/e1",
      eyes: {
        OD: {
          state: "abnormal",
          customFields: [
            { code: "CUSTOM_CVF_UPPER_LEFT", value: "restricted" },
            { code: "CUSTOM_CVF_UPPER_RIGHT", value: "full" },
            { code: "CUSTOM_CVF_LOWER_LEFT", value: "full" },
            { code: "CUSTOM_CVF_LOWER_RIGHT", value: "restricted" },
            { code: "CUSTOM_CVF_UNABLE", value: "yes" },
          ],
          other: "Peripheral field note",
        },
      },
    });
  } finally {
    renderer?.unmount();
    globalThis.fetch = originalFetch;
  }
});

test("CVF entry leads with the quadrant diagrams before the Field Defect panel", () => {
  const html = renderToStaticMarkup(<CvfSection
    definition={{ stableKey: "entrance:cvf", sectionKey: "entrance:cvf", display: "Confrontation visual fields", active: true, perEye: true, normalTemplate: "Full to finger counting OU", customFields: [] }}
    fieldDefectDefinition={visualFieldDefinition()}
    patientReference="Patient/p1"
    encounterReference="Encounter/e1"
    onSaved={() => undefined}
  />);
  const diagrams = html.indexOf("Confrontation Fields");
  const fieldDefect = html.indexOf("Field Defect");
  assert.ok(diagrams >= 0 && fieldDefect > diagrams, "quadrant diagrams must render before Field Defect");
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

test("changing a reloaded Field Defect hides the stale diagnosis until the descriptor is saved", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.includes("visual-field-defect") && url.includes("history")) {
      return Response.json({ rows: [{
        observationReference: "Observation/vf-observation",
        values: [{ code: "CUSTOM_FIELD_DEFECT", value: "Field loss OD" }],
      }] });
    }
    if (url.includes("entrance%3Acvf") && url.includes("history")) return Response.json({ rows: [] });
    if (url.includes("diagnosis-candidates")) {
      return Response.json({ findings: [{
        findingInstanceId: "vf-observation",
        findingDefinitionKey: "entrance:visual-field-defect",
        observationReference: "Observation/vf-observation",
        candidates: [{
          diagnosisKey: "vf_other_localized",
          display: "Other localized visual field defect",
          icd10: { code: "H53.451" },
          codingStatus: "verified",
          priority: true,
          source: "mapping",
        }],
      }] });
    }
    if (url.includes("diagnosis-catalog")) return Response.json({ diagnoses: [] });
    throw new Error(`Unexpected request: ${url}`);
  };
  let renderer!: ReactTestRenderer;
  try {
    await act(async () => {
      renderer = create(<CvfSection
        definition={{ stableKey: "entrance:cvf", sectionKey: "entrance:cvf", display: "Confrontation visual fields", active: true, perEye: true, normalTemplate: "Full to finger counting OU", customFields: [] }}
        fieldDefectDefinition={visualFieldDefinition()}
        patientReference="Patient/p1"
        encounterReference="Encounter/e1"
        onSaved={() => undefined}
      />);
      await new Promise((resolve) => setTimeout(resolve, 0));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    assert.ok(renderer.root.findAllByType("button").some((button) => button.children.join("") === "dx ▾ 1"));
    const fieldLossOs = renderer.root.findAllByType("button").find((button) => button.children.join("") === "Field loss OS");
    assert.ok(fieldLossOs);
    act(() => fieldLossOs.props.onClick());
    assert.equal(renderer.root.findAllByType("button").some((button) => button.children.join("") === "dx ▾ 1"), false);
  } finally {
    renderer?.unmount();
    globalThis.fetch = originalFetch;
  }
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

test("structure diagnosis rail keeps full search when the persisted finding has no seeded suggestions", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.includes("diagnosis-candidates")) {
      return Response.json({
        findings: [{
          findingInstanceId: "iris-observation",
          findingDefinitionKey: "ocular-health:anterior:iris",
          observationReference: "Observation/iris-observation",
          candidates: [],
        }],
      });
    }
    if (url.includes("diagnosis-catalog")) {
      return Response.json({
        diagnoses: [{
          stableKey: "iritis",
          display: "Iritis",
          active: true,
          codingStatus: "verified",
        }],
      });
    }
    if (url.includes("/fhir/R4/Condition")) {
      return Response.json({ resourceType: "Bundle", type: "searchset", entry: [] });
    }
    throw new Error(`Unexpected request: ${url}`);
  };
  let renderer!: ReactTestRenderer;
  try {
    await act(async () => {
      renderer = create(<DiagnosisPicker
        encounterReference="Encounter/e1"
        observationReferences={["Observation/iris-observation"]}
        findingDefinitionKey="ocular-health:anterior:iris"
        mode="proposal"
      />);
      await new Promise((resolve) => setTimeout(resolve, 0));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    const rail = renderer.root.findByProps({ "data-testid": "structure-diagnosis-rail" });
    assert.match(JSON.stringify(renderer.toJSON()), /Full diagnosis catalog/);
    assert.equal(rail.findAllByProps({ "data-testid": "suggested-diagnoses" }).length, 0);
  } finally {
    renderer?.unmount();
    globalThis.fetch = originalFetch;
  }
});

test("bilateral structure catalog picks stay scoped to the eye where the search selection was made", async () => {
  const originalFetch = globalThis.fetch;
  const writes: Array<Record<string, unknown>> = [];
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url.includes("diagnosis-candidates")) {
      return Response.json({
        findings: ["lens-od", "lens-os"].map((findingInstanceId) => ({
          findingInstanceId,
          findingDefinitionKey: "ocular-health:anterior:lens",
          observationReference: `Observation/${findingInstanceId}`,
          candidates: [],
        })),
      });
    }
    if (url.includes("diagnosis-catalog")) {
      return Response.json({
        diagnoses: [{
          stableKey: "cataract_nuclear_sclerosis",
          display: "Age-related nuclear cataract",
          active: true,
          codingStatus: "verified",
        }],
      });
    }
    if (url.includes("/fhir/R4/Condition")) {
      return Response.json({ resourceType: "Bundle", type: "searchset", entry: [] });
    }
    if (url.includes("/diagnosis-picks") && init?.method === "POST") {
      writes.push(JSON.parse(String(init.body)) as Record<string, unknown>);
      return Response.json({ condition: { resourceType: "Condition", id: "condition-1" } });
    }
    throw new Error(`Unexpected request: ${url}`);
  };
  let renderer!: ReactTestRenderer;
  try {
    await act(async () => {
      renderer = create(<DiagnosisPicker
        encounterReference="Encounter/e1"
        observationReferences={["Observation/lens-od", "Observation/lens-os"]}
        findingDefinitionKey="ocular-health:anterior:lens"
        mode="proposal"
      />);
      await new Promise((resolve) => setTimeout(resolve, 0));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    const searches = renderer.root.findAllByType(OdosSearchPicker);
    assert.equal(searches.length, 2);
    act(() => searches[0]!.props.onSelect({
      value: "cataract_nuclear_sclerosis",
      label: "Age-related nuclear cataract",
      item: {
        stableKey: "cataract_nuclear_sclerosis",
        display: "Age-related nuclear cataract",
        active: true,
        codingStatus: "verified",
      },
    }));
    const proposalButtons = renderer.root.findAllByProps({ "aria-label": "Propose Age-related nuclear cataract" });
    assert.equal(proposalButtons.length, 1);
    await act(async () => proposalButtons[0]!.props.onClick());
    assert.equal(writes[0]?.findingInstanceId, "lens-od");
  } finally {
    renderer?.unmount();
    globalThis.fetch = originalFetch;
  }
});

test("structure proposal toggles find provisional Conditions beyond the first FHIR search page", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.includes("diagnosis-candidates")) {
      return Response.json({
        findings: [{
          findingInstanceId: "lens-od",
          findingDefinitionKey: "ocular-health:anterior:lens",
          observationReference: "Observation/lens-od",
          candidates: [{
            diagnosisKey: "cataract_nuclear_sclerosis",
            display: "Age-related nuclear cataract",
            codingStatus: "verified",
            priority: true,
            source: "mapping",
          }],
        }],
      });
    }
    if (url.includes("diagnosis-catalog")) {
      return Response.json({ diagnoses: [] });
    }
    if (url.includes("page=2")) {
      return Response.json({
        resourceType: "Bundle",
        type: "searchset",
        entry: [{
          resource: {
            resourceType: "Condition",
            id: "condition-cataract",
            subject: { reference: "Patient/p1" },
            encounter: { reference: "Encounter/e1" },
            verificationStatus: { coding: [{ code: "provisional" }] },
            identifier: [{
              system: "https://odos2020.com/fhir/NamingSystem/diagnosis-catalog-stable-key",
              value: "e1::cataract_nuclear_sclerosis::right",
            }],
            evidence: [{ detail: [{ reference: "Observation/lens-od" }] }],
          },
        }],
      });
    }
    if (url.includes("/fhir/R4/Condition")) {
      return Response.json({
        resourceType: "Bundle",
        type: "searchset",
        entry: [],
        link: [{ relation: "next", url: "/fhir/R4/Condition?page=2" }],
      });
    }
    throw new Error(`Unexpected request: ${url}`);
  };
  let renderer!: ReactTestRenderer;
  try {
    await act(async () => {
      renderer = create(<DiagnosisPicker
        encounterReference="Encounter/e1"
        observationReferences={["Observation/lens-od"]}
        findingDefinitionKey="ocular-health:anterior:lens"
        mode="proposal"
      />);
      await new Promise((resolve) => setTimeout(resolve, 0));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    assert.equal(renderer.root.findAllByProps({ "aria-label": "Retract proposed Age-related nuclear cataract" }).length, 1);
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
      normalTemplate: "PERRLA; no RAPD OU",
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
  assert.match(html, /PERRLA; no RAPD OU/);
  assert.equal((html.match(/>normal</g) ?? []).length, 2);
  assert.equal((html.match(/>abnormal</g) ?? []).length, 2);
  assert.equal((html.match(/>deferred</g) ?? []).length, 2);
  assert.match(html, /History/);
});

test("selecting Pupils Normal OU fills only the definition-supplied 3 mm and 5 mm normal values", async () => {
  const originalFetch = globalThis.fetch;
  let savedPayload: unknown;
  globalThis.fetch = async (_input, init) => {
    if (init?.method === "POST") {
      savedPayload = JSON.parse(String(init.body));
      return Response.json({});
    }
    return Response.json({ rows: [] });
  };
  let renderer!: ReactTestRenderer;
  try {
    await act(async () => {
      renderer = create(<EntranceStateSection
        definition={pupilDefinition()}
        patientReference="Patient/p1"
        encounterReference="Encounter/e1"
        onSaved={() => undefined}
      />);
      await Promise.resolve();
      await Promise.resolve();
    });
    const normalOu = renderer.root.findAllByType("button").find((button) => button.children.join("") === "Normal OU");
    assert.ok(normalOu);
    act(() => normalOu.props.onClick());

    assert.deepEqual(renderer.root.findAllByProps({ "aria-label": "Size — bright" }).map((input) => input.props.value), ["3", "3"]);
    assert.deepEqual(renderer.root.findAllByProps({ "aria-label": "Size — dim" }).map((input) => input.props.value), ["5", "5"]);
    assert.deepEqual(renderer.root.findAllByProps({ "aria-label": "Size — near" }).map((input) => input.props.value), ["", ""]);
    assert.deepEqual(renderer.root.findAllByProps({ "aria-label": "Shape" }).map((select) => select.children.join("")), ["round", "round"]);
    assert.deepEqual(renderer.root.findAllByProps({ "aria-label": "Reactivity" }).map((select) => select.children.join("")), ["brisk", "brisk"]);
    assert.deepEqual(renderer.root.findAllByProps({ "aria-label": "RAPD" }).map((select) => select.children.join("")), ["Select", "Select"]);
    assert.deepEqual(renderer.root.findAllByProps({ "aria-label": "Neutral density (log units)" }).map((select) => select.children.join("")), ["Select", "Select"]);

    const save = renderer.root.findAllByType("button").find((button) => button.children.join("") === "Save Pupils");
    assert.ok(save);
    await act(async () => {
      save.props.onClick();
      await Promise.resolve();
      await Promise.resolve();
    });
    assert.deepEqual(savedPayload, {
      patientReference: "Patient/p1",
      encounterReference: "Encounter/e1",
      eyes: {
        OD: {
          state: "normal",
          customFields: [
            { code: "CUSTOM_PUPIL_SIZE_BRIGHT", value: 3 },
            { code: "CUSTOM_PUPIL_SIZE_DIM", value: 5 },
            { code: "CUSTOM_PUPIL_SHAPE", value: "round" },
            { code: "CUSTOM_PUPIL_REACTIVITY", value: "brisk" },
          ],
        },
        OS: {
          state: "normal",
          customFields: [
            { code: "CUSTOM_PUPIL_SIZE_BRIGHT", value: 3 },
            { code: "CUSTOM_PUPIL_SIZE_DIM", value: 5 },
            { code: "CUSTOM_PUPIL_SHAPE", value: "round" },
            { code: "CUSTOM_PUPIL_REACTIVITY", value: "brisk" },
          ],
        },
      },
    });
  } finally {
    renderer?.unmount();
    globalThis.fetch = originalFetch;
  }
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
  assert.match(source, /MissingDefinitionState section="Confrontation visual fields"/);
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

test("clearing Dilation leaves the editor unrecorded instead of pre-filling an administration row", async () => {
  const definition: CustomFindingDefinition = {
    stableKey: "entrance:dilation",
    sectionKey: "entrance:dilation",
    display: "Dilation",
    active: true,
    perEye: false,
    customFields: [],
    fields: { agent: { options: [{ code: "tropicamide-1", display: "Tropicamide 1%", active: true }] } },
  };
  const originalFetch = globalThis.fetch;
  let cleared = false;
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url.includes("/clinical-graph/dilation/history")) {
      return Response.json(cleared
        ? { notes: [], administrations: [] }
        : {
            notes: [{ observationReference: "Observation/dilation-note", recordedAt: "2026-09-02T14:00:00Z", text: "Dilation recorded" }],
            administrations: [{ recordedAt: "2026-09-02T14:00:00Z", agent: "Tropicamide 1%", drops: 1, eyes: "OU", administeredBy: "Practitioner/doc1" }],
          });
    }
    if (url.endsWith("/void") && init?.method === "POST") {
      const body = JSON.parse(String(init.body)) as { preview?: boolean };
      if (!body.preview) cleared = true;
      return Response.json({ voided: ["Observation/dilation-note"], count: 1, sections: [], preview: body.preview === true });
    }
    throw new Error(`Unexpected request: ${url}`);
  };

  let renderer!: ReactTestRenderer;
  try {
    await act(async () => {
      renderer = create(<ConfirmDestructiveProvider><DilationSection definition={definition} patientReference="Patient/p1" encounterReference="Encounter/e1" onSaved={() => undefined} /></ConfirmDestructiveProvider>);
      await flushEffects();
    });
    assert.equal(renderer.root.findAll((node) => node.props.ariaLabel === "Dilation agent 1").length, 1);
    const clear = renderer.root.findAllByType(ClearSectionButton)[0]?.findByType("button");
    assert.ok(clear);
    let pending = Promise.resolve();
    await act(async () => {
      pending = Promise.resolve(clear.props.onClick());
      await flushEffects();
    });
    const dialog = renderer.root.findAll((node) => node.props.role === "alertdialog")[0];
    assert.ok(dialog);
    const confirm = dialog.findAllByType("button").find((button) => button.children.join("") !== "Keep");
    assert.ok(confirm);
    await act(async () => {
      confirm.props.onClick();
      await pending;
      await flushEffects();
    });
    assert.equal(renderer.root.findAll((node) => String(node.props.ariaLabel ?? "").startsWith("Dilation agent ")).length, 0);
    const clearedTree = JSON.stringify(renderer.toJSON());
    assert.match(clearedTree, /No dilation administration recorded/);
    assert.doesNotMatch(clearedTree, /Dilation recorded/, "voided chart-note history must disappear immediately");
    assert.doesNotMatch(clearedTree, /Clear Dilation/, "the cleared section must no longer present itself as recorded");
  } finally {
    renderer?.unmount();
    globalThis.fetch = originalFetch;
  }
});

async function flushEffects(): Promise<void> {
  for (let index = 0; index < 4; index += 1) {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
}

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

function pupilDefinition(): CustomFindingDefinition {
  const definition = buildFindingDefinitionSeeds().find((candidate) => candidate.stableKey === "entrance:pupils");
  assert.ok(definition);
  return {
    stableKey: definition.stableKey,
    sectionKey: definition.sectionKey,
    display: definition.display,
    active: definition.active,
    perEye: definition.valueSchema.perEye === true,
    normalTemplate: typeof definition.normalSemantics?.template === "string" ? definition.normalSemantics.template : undefined,
    allowDeferred: definition.normalSemantics?.allowDeferred === true,
    customFields: customFieldEntries(definition, true),
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
