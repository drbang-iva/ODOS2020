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
import { RefractionSection } from "../src/components/charting/RefractionSection";
import { softLensProductParameterOptions } from "../src/components/charting/SoftContactLensSection";
import { VaSection } from "../src/components/charting/VaSection";

const PROPS = {
  patientReference: "Patient/p1",
  encounterReference: "Encounter/e1",
  onSaved: () => undefined,
};

test("Auto-Refraction uses centered PD and K spinners plus the ARx axis select pattern", () => {
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
  assert.equal((html.match(/data-default="true"[^>]*>63\.00 mm/g) ?? []).length, 2);
  assert.equal((html.match(/data-default="true"[^>]*>43\.50/g) ?? []).length, 4);
  for (const label of ["OD flat axis", "OD steep axis", "OS flat axis", "OS steep axis"]) {
    assert.match(html, new RegExp(`<select[^>]*aria-label="${label}"`));
  }
});

test("Refraction Purpose is the exact seven-option dropdown", () => {
  const html = renderToStaticMarkup(<RefractionSection {...PROPS} />);
  assert.match(html, /<select[^>]*aria-label="Refraction 1 purpose"/);
  for (const purpose of ["Distance", "Reading", "Intermediate", "Progressive", "Bifocal", "Safety", "Sunglasses"]) {
    assert.equal((html.match(new RegExp(`<option value="${purpose}"`, "g")) ?? []).length, 2);
  }
  assert.doesNotMatch(source("RefractionSection.tsx"), /<input[\s\S]{0,160}value=\{block\.purpose\}/);
});

test("standalone Visual Acuity uses the curated VA selector for both eyes", () => {
  const html = renderToStaticMarkup(<VaSection {...PROPS} />);
  for (const eye of ["OD", "OS"]) {
    assert.match(html, new RegExp(`<select[^>]*aria-label="${eye} visual acuity"`));
    assert.match(html, new RegExp(`<select[^>]*aria-label="${eye} visual acuity modifier"`));
  }
  assert.doesNotMatch(source("VaSection.tsx"), /placeholder="20\/20"/);
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
  assert.match(soft, /PowerDropdown value=\{binocularPdDistance\}[\s\S]*defaultValue="63\.00"/);
  assert.match(soft, /SelectField label="Base Curve \(mm\)"[\s\S]*options=\{baseCurveOptions\}/);
  assert.match(soft, /SelectField label="Diameter \(mm\)"[\s\S]*options=\{diameterOptions\}/);
  assert.match(soft, /product: "", baseCurve: "", diameter: ""/);
});

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
  assert.doesNotMatch(specialty, /<TextField label="Base Curve \(mm\)"/);
  assert.doesNotMatch(specialty, /<TextField label="Diameter \(mm\)"/);
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
    const trigger = renderer!.root.findAllByProps({ "aria-label": "IOP value options" })
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

function source(file: string): string {
  return readFileSync(new URL(`../src/components/charting/${file}`, import.meta.url), "utf8");
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}
