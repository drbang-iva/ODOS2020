import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AutoRefractionSection } from "../src/components/charting/AutoRefractionSection";
import { CupDiscSection } from "../src/components/charting/CupDiscSection";
import { IopSection } from "../src/components/charting/IopSection";
import { OrthoKSection } from "../src/components/charting/OrthoKSection";
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
  assert.doesNotMatch(specialty, /<TextField label="Base Curve \(mm\)"/);
  assert.doesNotMatch(specialty, /<TextField label="Diameter \(mm\)"/);
});

test("IOP and corneal hysteresis use their definition ranges with centered spinners", () => {
  const html = renderToStaticMarkup(<IopSection {...PROPS} />);
  for (const eye of ["OD", "OS"]) {
    assert.match(html, new RegExp(`role="combobox"[^>]*aria-label="${eye} IOP value"`));
    assert.match(html, new RegExp(`role="combobox"[^>]*aria-label="${eye} corneal hysteresis"`));
  }
  assert.equal((html.match(/data-default="true"[^>]*>15/g) ?? []).length, 2);
  assert.equal((html.match(/data-default="true"[^>]*>9\.00/g) ?? []).length, 2);
  assert.doesNotMatch(source("IopSection.tsx"), /type="number"/);
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
