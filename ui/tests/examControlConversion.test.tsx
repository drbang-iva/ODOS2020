import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { AutoRefractionSection } from "../src/components/charting/AutoRefractionSection";
import { CupDiscSection } from "../src/components/charting/CupDiscSection";
import { IopSection } from "../src/components/charting/IopSection";
import { OrthoKSection } from "../src/components/charting/OrthoKSection";
import { PowerDropdown } from "../src/components/charting/PowerDropdown";
import { SoftContactLensSection, softLensProductParameterOptions } from "../src/components/charting/SoftContactLensSection";
import { SpecialtyContactLensSection } from "../src/components/charting/SpecialtyContactLensSection";
import { VaSection } from "../src/components/charting/VaSection";
import { VaValueSelect } from "../src/components/charting/VaValueSelect";
import { OdosSelect } from "../src/components/inputs/OdosSelect";
import { OdosWheel } from "../src/components/inputs/OdosWheel";
import {
  buildSoftContactLensFindingDefinitionStub,
  buildSpecialtyContactLensFindingDefinitionStub,
} from "../../mcp/src/clinical-graph/contact-lens-definition.js";

const PROPS = {
  patientReference: "Patient/p1",
  encounterReference: "Encounter/e1",
  onSaved: () => undefined,
};

test("Auto-Refraction uses centered PD and K spinners plus plano-centered axis wheels", () => {
  const html = renderToStaticMarkup(<AutoRefractionSection {...PROPS} />);

  for (const label of [
    "Binocular PD distance",
    "Binocular PD near",
    "OD flat K",
    "OD steep K",
    "OS flat K",
    "OS steep K",
  ]) {
    assert.match(html, new RegExp(`role="combobox"[^>]*aria-label="${label}"`));
  }
  assert.equal((html.match(/data-default="true"[^>]*>63 mm/g) ?? []).length, 2);
  assert.equal((html.match(/data-default="true"[^>]*>43\.50/g) ?? []).length, 4);
  for (const label of ["OD flat axis", "OD steep axis", "OS flat axis", "OS steep axis"]) {
    assert.match(html, new RegExp(`role="combobox"[^>]*aria-label="${label}"`));
  }
});

test("standalone Visual Acuity uses the curated VA selector for both eyes", () => {
  const html = renderToStaticMarkup(<VaSection {...PROPS} />);
  assert.match(html, />Value<\/div><div>Chart<\/div>/);
  for (const eye of ["OD", "OS"]) {
    assert.match(html, new RegExp(`role="combobox"[^>]*aria-label="${eye} visual acuity"`));
    assert.match(html, new RegExp(`role="combobox"[^>]*aria-label="${eye} visual acuity modifier"`));
  }
  assert.doesNotMatch(source("VaSection.tsx"), /placeholder="20\/20"/);
});

test("standalone Visual Acuity keeps non-Snellen chart entry available", () => {
  let renderer: ReactTestRenderer | undefined;
  try {
    act(() => {
      renderer = create(<VaSection {...PROPS} />);
    });
    const odChart = renderer!.root.findByProps({ "aria-label": "OD visual acuity chart" });
    act(() => odChart.props.onChange({ target: { value: "LOGMAR" } }));

    assert.equal(renderer!.root.findAllByType(VaValueSelect).length, 1);
    const odValue = renderer!.root.findByProps({ "aria-label": "OD visual acuity" });
    assert.equal(odValue.type, "input");
    assert.equal(odValue.props.value, "");
  } finally {
    if (renderer) act(() => renderer!.unmount());
  }
});

test("soft-lens BC and DIA options change with the selected catalog product", () => {
  const precision1 = {
    baseCurveOptions: [{ code: "8.3", display: "8.3", active: true }],
    diameterOptions: [{ code: "14.2", display: "14.2", active: true }],
  };
  const oasys = {
    baseCurveOptions: [
      { code: "8.4", display: "8.4", active: true },
      { code: "8.8", display: "8.8", active: true },
    ],
    diameterOptions: [{ code: "14.0", display: "14.0", active: true }],
  };

  assert.deepEqual(softLensProductParameterOptions(precision1, "baseCurveOptions").map((option) => option.code), ["8.3"]);
  assert.deepEqual(softLensProductParameterOptions(oasys, "baseCurveOptions").map((option) => option.code), ["8.4", "8.8"]);
  assert.deepEqual(softLensProductParameterOptions(precision1, "diameterOptions").map((option) => option.code), ["14.2"]);
  assert.deepEqual(softLensProductParameterOptions(oasys, "diameterOptions").map((option) => option.code), ["14.0"]);

  const soft = source("SoftContactLensSection.tsx");
  assert.doesNotMatch(soft, /binocularPd|Binocular PD/);
  assert.match(soft, /<SphereWheelField[\s\S]*value=\{state\.sphere\}[\s\S]*field=\{fields\.sphere\}/);
  assert.match(soft, /centerOn=\{0\}[\s\S]*states=\{\[\{ value: "", label: "Not recorded" \}\]\}/);
  assert.match(soft, /CatalogWheelField label="Base Curve \(mm\)"[\s\S]*options=\{baseCurveOptions\}/);
  assert.match(soft, /CatalogWheelField label="Diameter \(mm\)"[\s\S]*options=\{diameterOptions\}/);
  assert.match(soft, /product: "", baseCurve: "", diameter: ""/);
});

test("soft contact lens details neither render nor save spectacle PD", async () => {
  const originalFetch = globalThis.fetch;
  let savedBody: Record<string, unknown> | undefined;
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith("/clinical-graph/contact-lens/soft/definition")) {
      return Response.json({ definition: { fields: {} } });
    }
    if (url.endsWith("/clinical-graph/contact-lens/soft") && init?.method === "POST") {
      savedBody = JSON.parse(String(init.body)) as Record<string, unknown>;
      return Response.json({ eyes: { OD: {} } });
    }
    throw new Error(`Unexpected request: ${url}`);
  };
  let renderer!: ReactTestRenderer;
  try {
    await act(async () => {
      renderer = create(<SoftContactLensSection {...PROPS} />);
      await Promise.resolve();
      await Promise.resolve();
    });
    assert.doesNotMatch(JSON.stringify(renderer.toJSON()), /Binocular PD/);

    const manualEntry = renderer.root.findAllByType("input").find((input) => input.props.type === "checkbox");
    assert.ok(manualEntry);
    act(() => manualEntry.props.onChange({ target: { checked: true } }));
    const save = renderer.root.findAllByType("button").find((button) => button.children.join("") === "Save Soft Contact Lenses");
    assert.ok(save);
    await act(async () => {
      await save.props.onClick();
      await Promise.resolve();
    });
    assert.ok(savedBody);
    assert.equal("binocularPdDistance" in savedBody, false);
    assert.equal("binocularPdNear" in savedBody, false);
  } finally {
    renderer?.unmount();
    globalThis.fetch = originalFetch;
  }
});

test("contact lens status pickers hide deprecated dispensing states while legacy labels remain resolvable", async () => {
  const originalFetch = globalThis.fetch;
  const provenance = { source: "manual" as const, recordedAt: "2026-08-23T12:00:00.000Z" };
  const definitions = {
    soft: buildSoftContactLensFindingDefinitionStub(provenance),
    specialty: buildSpecialtyContactLensFindingDefinitionStub(provenance),
  };
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.endsWith("/clinical-graph/contact-lens/soft/definition")) {
      return Response.json({ definition: { fields: definitions.soft.valueSchema.fields } });
    }
    if (url.endsWith("/clinical-graph/contact-lens/specialty/definition")) {
      return Response.json({ definition: { fields: definitions.specialty.valueSchema.fields } });
    }
    if (url.includes("/clinical-graph/refraction/history?")) {
      return Response.json({ glasses: [], softCl: [], specialtyCl: [] });
    }
    if (url.includes("/clinical-graph/contact-lens/keratometry?")) {
      return Response.json({ eyes: { OD: null, OS: null } });
    }
    throw new Error(`Unexpected request: ${url}`);
  };

  const deprecatedCodes = [
    "dispensed",
    "dispensed_patient_confirm",
    "dispensed_successful",
    "dispensed_unsuccessful",
  ];
  const renderers: ReactTestRenderer[] = [];
  try {
    for (const Component of [SoftContactLensSection, SpecialtyContactLensSection]) {
      let renderer!: ReactTestRenderer;
      await act(async () => {
        renderer = create(<Component {...PROPS} />);
        await Promise.resolve();
        await Promise.resolve();
      });
      renderers.push(renderer);
      const status = renderer.root.findAllByType(OdosSelect).find((select) => select.props.ariaLabel === "Status");
      assert.ok(status);
      const activeCodes = status.props.options.map((option: { value: string }) => option.value);
      assert.ok(activeCodes.includes("final_rx"));
      for (const code of deprecatedCodes) assert.equal(activeCodes.includes(code), false, code);
    }

    for (const definition of Object.values(definitions)) {
      const statusOptions = definition.valueSchema.fields.status?.options ?? [];
      const legacyRecord = { status: "dispensed_successful" };
      assert.equal(
        statusOptions.find((option) => option.code === legacyRecord.status)?.display,
        "Dispensed Successful",
      );
    }
  } finally {
    for (const renderer of renderers) act(() => renderer.unmount());
    globalThis.fetch = originalFetch;
  }
});

for (const fixture of [
  {
    label: "soft contact lens",
    kind: "soft" as const,
    Component: SoftContactLensSection,
    definitionPath: "/clinical-graph/contact-lens/soft/definition",
    savePath: "/clinical-graph/contact-lens/soft",
    saveLabel: "Save Soft Contact Lenses",
  },
  {
    label: "specialty contact lens",
    kind: "specialty" as const,
    Component: SpecialtyContactLensSection,
    definitionPath: "/clinical-graph/contact-lens/specialty/definition",
    savePath: "/clinical-graph/contact-lens/specialty",
    saveLabel: "Save Specialty Contact Lens",
  },
]) {
  test(`${fixture.label} saves a complete eye with an untouched or incomplete optional over-refraction`, async () => {
    const originalFetch = globalThis.fetch;
    const savedBodies: Array<Record<string, unknown>> = [];
    globalThis.fetch = contactLensFetch(fixture.kind, fixture.definitionPath, fixture.savePath, savedBodies);
    let renderer: ReactTestRenderer | undefined;
    try {
      await act(async () => {
        renderer = create(<fixture.Component {...PROPS} />);
        await Promise.resolve();
        await Promise.resolve();
      });
      populateCompleteContactLensEye(renderer!, fixture.kind, "OD");

      await clickSave(renderer!, fixture.saveLabel);
      assert.equal(savedBodies.length, 1);
      const untouchedEye = savedEye(savedBodies[0]!, "OD");
      assert.equal(untouchedEye.manufacturer, "Alcon");
      assert.equal(untouchedEye.product, "Precision7");
      assert.equal(untouchedEye.sphere, -0.5);
      assert.equal("overRefraction" in untouchedEye, false);

      act(() => {
        contactLensWheel(renderer!, "OD over-refraction sphere").props.onChange(-0.25);
        contactLensWheel(renderer!, "OD over-refraction axis").props.onChange(0);
      });
      await clickSave(renderer!, fixture.saveLabel);

      assert.equal(savedBodies.length, 2);
      const incompleteEye = savedEye(savedBodies[1]!, "OD");
      assert.equal(incompleteEye.manufacturer, "Alcon");
      assert.equal(incompleteEye.product, "Precision7");
      assert.equal(incompleteEye.sphere, -0.5);
      assert.equal("overRefraction" in incompleteEye, false);
      assert.deepEqual(incompleteEye, untouchedEye);
      assert.ok(alertTexts(renderer!).includes(
        "OD over-refraction: clear the axis or enter a cylinder.",
      ));
      assert.ok(findButton(renderer!, "Clear OD over-refraction axis"));
    } finally {
      if (renderer) act(() => renderer!.unmount());
      globalThis.fetch = originalFetch;
    }
  });

  test(`${fixture.label} blocks only an eye with an incomplete main pair and exposes both remedies`, async () => {
    const originalFetch = globalThis.fetch;
    const savedBodies: Array<Record<string, unknown>> = [];
    globalThis.fetch = contactLensFetch(fixture.kind, fixture.definitionPath, fixture.savePath, savedBodies);
    let renderer: ReactTestRenderer | undefined;
    try {
      await act(async () => {
        renderer = create(<fixture.Component {...PROPS} />);
        await Promise.resolve();
        await Promise.resolve();
      });
      populateCompleteContactLensEye(renderer!, fixture.kind, "OD");
      populateCompleteContactLensEye(renderer!, fixture.kind, "OS");

      act(() => contactLensWheel(renderer!, "OD axis").props.onChange(0));
      await clickSave(renderer!, fixture.saveLabel);
      assert.equal(savedBodies.length, 1);
      assert.deepEqual(Object.keys(savedEyes(savedBodies[0]!)), ["OS"]);
      assert.ok(alertTexts(renderer!).includes(
        "OD cylinder and axis: clear the axis or enter a cylinder.",
      ));
      const clearAxis = findButton(renderer!, "Clear OD axis");
      assert.ok(clearAxis);
      act(() => clearAxis.props.onClick());

      act(() => contactLensWheel(renderer!, "OD cylinder").props.onChange(-0.75));
      await clickSave(renderer!, fixture.saveLabel);
      assert.equal(savedBodies.length, 2);
      assert.deepEqual(Object.keys(savedEyes(savedBodies[1]!)), ["OS"]);
      assert.ok(alertTexts(renderer!).includes(
        "OD cylinder and axis: clear the cylinder or enter an axis.",
      ));
      const clearCylinder = findButton(renderer!, "Clear OD cylinder");
      assert.ok(clearCylinder);
      act(() => clearCylinder.props.onClick());
      assert.equal(alertTexts(renderer!).length, 0);
    } finally {
      if (renderer) act(() => renderer!.unmount());
      globalThis.fetch = originalFetch;
    }
  });
}

test("specialty-lens numeric geometry uses centered spinner fields", () => {
  const specialty = source("SpecialtyContactLensSection.tsx");
  assert.match(specialty, /PowerDropdown value=\{state\.baseCurve\}[\s\S]*defaultValue="7\.80"/);
  assert.match(specialty, /PowerDropdown value=\{state\.diameter\}[\s\S]*defaultValue="15\.00"/);
  assert.match(specialty, /visibleAdditional\.map\(\(field\) => field\.valueType === "select"[\s\S]*<PowerDropdown/);
  assert.match(specialty, /field\.code === "hvid"[\s\S]*defaultValue: "11\.80"/);
  assert.match(specialty, /field\.code === "sag"[\s\S]*defaultValue: "4500"/);
  assert.match(specialty, /field\.code === "center_thickness" \|\| field\.code === "edge_thickness"/);
  assert.match(specialty, /manufacturer, product: "", baseCurve: "", diameter: ""/);
  assert.match(specialty, /product: productCode,[\s\S]*baseCurve: "",[\s\S]*diameter: ""/);
  assert.match(specialty, /lensType: product\?\.lensTypeCode \?\? ""/);
  assert.doesNotMatch(specialty, /<TextField label="Base Curve \(mm\)"/);
  assert.doesNotMatch(specialty, /<TextField label="Diameter \(mm\)"/);
});

test("Batch 4 contact-lens wheels consume corrected definition bounds with clinical fallbacks", () => {
  const soft = source("SoftContactLensSection.tsx");
  const specialty = source("SpecialtyContactLensSection.tsx");
  for (const component of [soft, specialty]) {
    assert.match(component, /numericOptions\(fields\.cylinder, -8, 0, 0\.25\)/);
    assert.match(component, /numericOptions\(fields\.overRefractionCylinder, -8, 0, 0\.25\)/);
    assert.doesNotMatch(component, /\{\s*\.\.\.fields\.(?:cylinder|overRefractionCylinder),\s*minimum:/);
  }
  assert.match(soft, /field\?\.minimum \?\? -20/);
  assert.match(soft, /field\?\.maximum \?\? 20/);
  assert.match(soft, /<PowerField label="Add"[\s\S]*format=\{formatSignedPower\}/);
  assert.match(soft, /function formatSignedPower\(value: number\)[\s\S]*value >= 0 \? "\+" : "-"/);
  assert.match(specialty, /numericOptions\(fields\.sphere, -20, 20, 0\.25\)/);
  const definition = readFileSync(
    new URL("../../mcp/src/clinical-graph/contact-lens-definition.ts", import.meta.url),
    "utf8",
  );
  assert.equal((definition.match(/sphere: powerField\("Sphere", -20, 20\)/g) ?? []).length, 2);
  assert.equal((definition.match(/cylinder: powerField\("Cylinder", -8, 0\)/g) ?? []).length, 2);
  assert.equal((definition.match(/overRefractionCylinder: powerField\("Over-Refraction Cylinder", -8, 0\)/g) ?? []).length, 2);
});

test("Batch 4 wheels retain plano power centers with six explicit non-power defaults", () => {
  const allowedNonPlanoCenters: Record<string, string[]> = {
    "CustomFindingSection.tsx": ["Number(field.defaultValue ?? 0)"],
    "DilationSection.tsx": ["Number(row.drops)"],
    "EntranceMeasurementSection.tsx": ["Number(field.defaultValue ?? 0)"],
    "IopTimeline.tsx": ["Number(targetDraft.percent)", "Number(targetDraft.directValue)"],
  };
  for (const file of [
    "AutoRefractionSection.tsx",
    "CustomFindingSection.tsx",
    "DilationSection.tsx",
    "DryEyeGlandStructureSection.tsx",
    "EntranceMeasurementSection.tsx",
    "EyeGrowthSection.tsx",
    "IopTimeline.tsx",
    "OcularHealthSection.tsx",
    "RefractionSection.tsx",
    "SoftContactLensSection.tsx",
    "SpecialtyContactLensSection.tsx",
    "WearingSection.tsx",
  ]) {
    const component = source(file);
    const nonPlanoCenters = [...component.matchAll(/centerOn=\{([^}]+)\}/g)]
      .map((match) => match[1]!)
      .filter((center) => center !== "0");
    assert.deepEqual(nonPlanoCenters, allowedNonPlanoCenters[file] ?? [], file);
  }
  const autoRefraction = source("AutoRefractionSection.tsx");
  const refraction = source("RefractionSection.tsx");
  const soft = source("SoftContactLensSection.tsx");
  const specialty = source("SpecialtyContactLensSection.tsx");
  const wearing = source("WearingSection.tsx");
  assert.match(autoRefraction, /function AxisWheel[\s\S]*?centerOn=\{0\}/);
  assert.match(refraction, /value=\{block\[eye\]\.axis[\s\S]*?centerOn=\{0\}/);
  assert.match(soft, /function PowerField[\s\S]*?centerOn=\{0\}/);
  assert.match(soft, /function SphereWheelField[\s\S]*?centerOn=\{0\}/);
  assert.match(soft, /function AxisField[\s\S]*?centerOn=\{0\}/);
  assert.match(specialty, /function PowerField[\s\S]*?centerOn=\{0\}/);
  assert.match(specialty, /function AxisField[\s\S]*?centerOn=\{0\}/);
  assert.match(wearing, /value=\{pair\[eye\]\.axis[\s\S]*?centerOn=\{0\}/);
  const referral = readFileSync(
    new URL("../src/components/referral/ReferralCompose.tsx", import.meta.url),
    "utf8",
  );
  assert.deepEqual(
    [...referral.matchAll(/centerOn=\{([^}]+)\}/g)].map((match) => match[1]!),
    ["includeList.history_count"],
  );
});

test("unknown Batch 4 bounds stay typed instead of acquiring guessed wheel ranges", () => {
  assert.match(source("DryEyeSection.tsx"), /aria-label="Total score"[\s\S]*inputMode="decimal"/);
  assert.match(source("HpiSection.tsx"), /aria-label=\{`\$\{section\.label\} duration value`\}[\s\S]*type="number"[\s\S]*min=\{1\}/);
  assert.match(source("VaSection.tsx"), /rows\[laterality\]\.chartType === "SNELLEN"[\s\S]*<input/);
  const optical = readFileSync(new URL("../src/scenes/OpticalOrder.tsx", import.meta.url), "utf8");
  const scheduler = readFileSync(new URL("../src/scenes/scheduler/AppointmentDetailsModal.tsx", import.meta.url), "utf8");
  assert.match(optical, /Field label="Dist PD" type="number"/);
  assert.match(scheduler, /aria-label="Custom duration minutes"[\s\S]*min=\{1\}[\s\S]*type="number"/);
});

test("IOP and corneal hysteresis use definition-derived ranges with centered spinners", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = input.toString();
    if (url.includes("/clinical-graph/iop/history")) {
      return jsonResponse({
        readings: [],
        cornealHysteresis: [],
        perEye: {
          OD: { average: null, tMax: null, count: 0, target: null },
          OS: { average: null, tMax: null, count: 0, target: null },
        },
        threshold: 22,
      });
    }
    return jsonResponse({
      definitions: {
        intraocularPressure: {
          fields: {
            value: { minimum: 11, maximum: 19, step: 2 },
            method: { options: [{ code: "GAT", display: "Goldmann", active: true }] },
          },
        },
        cornealHysteresis: {
          fields: { value: { minimum: 7, maximum: 11, step: 0.5 } },
        },
      },
    });
  };

  let renderer: ReactTestRenderer | undefined;
  try {
    await act(async () => {
      renderer = create(<IopSection {...PROPS} />);
      await Promise.resolve();
      await Promise.resolve();
    });
    const dropdowns = renderer!.root.findAllByType(PowerDropdown);
    for (const eye of ["OD", "OS"]) {
      const iop = dropdowns.find((item) => item.props.ariaLabel === `${eye} IOP value`);
      const hysteresis = dropdowns.find((item) => item.props.ariaLabel === `${eye} corneal hysteresis`);
      assert.deepEqual(iop?.props.options, ["11", "13", "15", "17", "19"]);
      assert.equal(iop?.props.defaultValue, "15");
      assert.deepEqual(hysteresis?.props.options, ["7.00", "7.50", "8.00", "8.50", "9.00", "9.50", "10.00", "10.50", "11.00"]);
      assert.equal(hysteresis?.props.defaultValue, "9.00");
    }
    assert.doesNotMatch(source("IopSection.tsx"), /type="number"/);
  } finally {
    if (renderer) act(() => renderer!.unmount());
    globalThis.fetch = originalFetch;
  }
});

test("PowerDropdown closes and disables its open options when the field becomes disabled", () => {
  const originalRequestAnimationFrame = globalThis.requestAnimationFrame;
  const originalCancelAnimationFrame = globalThis.cancelAnimationFrame;
  const originalDocument = globalThis.document;
  globalThis.requestAnimationFrame = (callback) => { callback(0); return 1; };
  globalThis.cancelAnimationFrame = () => undefined;
  Object.defineProperty(globalThis, "document", {
    value: { addEventListener: () => undefined, removeEventListener: () => undefined },
    configurable: true,
  });

  let renderer: ReactTestRenderer | undefined;
  try {
    act(() => {
      renderer = create(<PowerDropdown value="" options={["14", "15", "16"]} defaultValue="15" onChange={() => undefined} ariaLabel="IOP value" />);
    });
    const trigger = renderer!.root.findAllByProps({ "aria-label": "Show IOP value options" })
      .find((item) => item.type === "button");
    act(() => trigger!.props.onClick());
    assert.equal(renderer!.root.findByProps({ role: "listbox" }).props.hidden, false);

    act(() => {
      renderer!.update(<PowerDropdown value="" options={["14", "15", "16"]} defaultValue="15" onChange={() => undefined} ariaLabel="IOP value" disabled />);
    });
    assert.equal(renderer!.root.findByProps({ role: "listbox" }).props.hidden, true);
    for (const option of renderer!.root.findAllByProps({ role: "option" })) assert.equal(option.props.disabled, true);
  } finally {
    if (renderer) act(() => renderer!.unmount());
    globalThis.requestAnimationFrame = originalRequestAnimationFrame;
    globalThis.cancelAnimationFrame = originalCancelAnimationFrame;
    Object.defineProperty(globalThis, "document", { value: originalDocument, configurable: true });
  }
});

test("all six Ortho-K lens parameters use their stated centered spinners", () => {
  const html = renderToStaticMarkup(<OrthoKSection {...PROPS} />);
  for (const label of ["BC mm", "RCD um", "AC mm", "OZD mm", "Diameter mm", "Rx D"]) {
    assert.match(html, new RegExp(`role="combobox"[^>]*aria-label="Ortho-K ${label}"`));
  }
  for (const value of ["7.80", "550", "8.30", "6.20", "10.60"]) {
    assert.match(html, new RegExp(`data-default="true"[^>]*>${value.replace(".", "\\.")}`));
  }
  assert.match(html, /data-default="true"[^>]*>Plano/);
  assert.match(source("OrthoKSection.tsx"), /<input value=\{findingText\}/);
});

test("Cup/Disc renders one editable picker per ratio without duplicate number inputs", () => {
  const html = renderToStaticMarkup(<CupDiscSection {...PROPS} />);
  for (const eye of ["OD", "OS"]) {
    assert.equal((html.match(new RegExp(`aria-label="${eye} vertical cup disc ratio picker"`, "g")) ?? []).length, 1);
    assert.equal((html.match(new RegExp(`aria-label="${eye} horizontal cup disc ratio picker"`, "g")) ?? []).length, 1);
  }
  assert.doesNotMatch(source("CupDiscSection.tsx"), /cup disc ratio typed value/);
});

test("the two deferred clinical-vocabulary fields remain free text", () => {
  assert.match(source("SoftContactLensSection.tsx"), /TextAreaField label="Assessment and CL Regimen"/);
  assert.match(source("OrthoKSection.tsx"), /<input value=\{findingText\} onChange=/);
});

function contactLensFetch(
  kind: "soft" | "specialty",
  definitionPath: string,
  savePath: string,
  savedBodies: Array<Record<string, unknown>>,
) {
  const provenance = { source: "manual" as const, recordedAt: "2026-08-25T12:00:00.000Z" };
  const definition = kind === "soft"
    ? buildSoftContactLensFindingDefinitionStub(provenance)
    : buildSpecialtyContactLensFindingDefinitionStub(provenance);
  return async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    if (url.endsWith(definitionPath)) {
      return Response.json({ definition: { fields: definition.valueSchema.fields } });
    }
    if (url.includes("/clinical-graph/refraction/history?")) {
      return Response.json({ glasses: [], softCl: [], specialtyCl: [] });
    }
    if (url.includes("/clinical-graph/contact-lens/keratometry?")) {
      return Response.json({ eyes: { OD: null, OS: null } });
    }
    if (url.endsWith(savePath) && init?.method === "POST") {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      savedBodies.push(body);
      return Response.json({ eyes: body.eyes });
    }
    throw new Error(`Unexpected request: ${url}`);
  };
}

function populateCompleteContactLensEye(
  renderer: ReactTestRenderer,
  kind: "soft" | "specialty",
  eye: "OD" | "OS",
) {
  const eyeIndex = eye === "OD" ? 0 : 1;
  const manualEntries = renderer.root.findAllByType("input").filter((input) => input.props.type === "checkbox");
  act(() => manualEntries[eyeIndex]!.props.onChange({ target: { checked: true } }));
  act(() => {
    labeledTextInput(renderer, "Manufacturer", eyeIndex).props.onChange({ target: { value: "Alcon" } });
    labeledTextInput(renderer, "Product", eyeIndex).props.onChange({ target: { value: "Precision7" } });
    contactLensWheel(renderer, `${eye} sphere`).props.onChange(-0.5);
    if (kind === "soft") {
      contactLensWheel(renderer, `${eye} manual base curve`).props.onChange(8.4);
      contactLensWheel(renderer, `${eye} manual diameter`).props.onChange(14.2);
      const dates = renderer.root.findAllByType("input").filter((input) => input.props.type === "date");
      dates[eyeIndex * 2]!.props.onChange({ target: { value: "2026-08-25" } });
      dates[eyeIndex * 2 + 1]!.props.onChange({ target: { value: "2027-08-25" } });
    } else {
      const baseCurves = renderer.root.findAllByType(PowerDropdown)
        .filter((field) => field.props.ariaLabel === "Base Curve (mm)");
      const diameters = renderer.root.findAllByType(PowerDropdown)
        .filter((field) => field.props.ariaLabel === "Diameter (mm)");
      baseCurves[eyeIndex]!.props.onChange("8.40");
      diameters[eyeIndex]!.props.onChange("14.20");
    }
  });
}

function labeledTextInput(renderer: ReactTestRenderer, label: string, index: number) {
  const labels = renderer.root.findAllByType("label").filter((candidate) =>
    candidate.findAllByType("span").some((span) => span.children.join("") === label)
    && candidate.findAllByType("input").some((input) => input.props.type === "text" && !input.props["aria-label"]));
  return labels[index]!.findAllByType("input")
    .find((input) => input.props.type === "text" && !input.props["aria-label"])!;
}

function contactLensWheel(renderer: ReactTestRenderer, ariaLabel: string) {
  const wheel = renderer.root.findAllByType(OdosWheel).find((candidate) => candidate.props.ariaLabel === ariaLabel);
  assert.ok(wheel, `Missing wheel: ${ariaLabel}`);
  return wheel;
}

async function clickSave(renderer: ReactTestRenderer, label: string) {
  const save = renderer.root.findAllByType("button").find((button) => button.children.join("") === label);
  assert.ok(save, `Missing save button: ${label}`);
  await act(async () => {
    await save.props.onClick();
    await Promise.resolve();
    await Promise.resolve();
  });
}

function findButton(renderer: ReactTestRenderer, ariaLabel: string) {
  return renderer.root.findAllByType("button").find((button) => button.props["aria-label"] === ariaLabel);
}

function alertTexts(renderer: ReactTestRenderer): string[] {
  return renderer.root.findAllByProps({ role: "alert" }).map((alert) => alert.children.join(""));
}

function savedEyes(body: Record<string, unknown>): Record<string, Record<string, unknown>> {
  return body.eyes as Record<string, Record<string, unknown>>;
}

function savedEye(body: Record<string, unknown>, eye: "OD" | "OS"): Record<string, unknown> {
  const value = savedEyes(body)[eye];
  assert.ok(value, `Missing saved eye: ${eye}`);
  return value;
}

function source(file: string): string {
  return readFileSync(new URL(`../src/components/charting/${file}`, import.meta.url), "utf8");
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}
