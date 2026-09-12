import assert from "node:assert/strict";
import { runVendorCanonicalShapePass } from "../../scripts/preflight-lint.js";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import type { CodeSystem, StructureDefinition, ValueSet } from "@medplum/fhirtypes";

const read = <T>(path: string): T => JSON.parse(readFileSync(new URL(`../../data/${path}`, import.meta.url), "utf8"));
const vocabularies = {
  purpose: "comms-purpose", channel: "comms-channel",
  surface: "comms-preference-surface", method: "comms-consent-capture-method",
} as const;
for (const [profile, slices] of Object.entries({
  "odos-comms-preference": ["purpose", "channel", "surface"],
  "odos-comms-consent-scope": ["purpose", "channel"],
  "odos-comms-consent-capture": ["surface", "method"],
})) {
  test(`${profile} code slices require the exact local vocabulary`, () => {
    const definition = read<StructureDefinition>(`canonical-extensions/${profile}.json`);
    const codedElements = definition.differential!.element.filter(element => element.type?.some(type => type.code === "code"));
    assert.deepEqual(codedElements.map(element => element.id!.split(":")[1].split(".")[0]), slices);
    for (const element of codedElements) {
      const slice = element.id!.split(":")[1].split(".")[0] as keyof typeof vocabularies;
      const valueSet = read<ValueSet>(`terminology/${vocabularies[slice]}-valueset.json`);
      assert.deepEqual(element.binding, { strength: "required", valueSet: `${valueSet.url}|${valueSet.version}` });
    }
  });
}
for (const name of Object.values(vocabularies)) {
  test(`${name} ValueSet contains only the existing versioned codes`, () => {
    const system = read<CodeSystem>(`terminology/${name}-codesystem.json`);
    const valueSet = read<ValueSet>(`terminology/${name}-valueset.json`);
    assert.equal(valueSet.url, `https://odos2020.com/fhir/ValueSet/${name}`);
    assert.equal(valueSet.version, system.version);
    assert.deepEqual(valueSet.compose, { include: [{ system: system.url, version: system.version, concept: system.concept }] });
  });
}

test("textable marker is Patient-only, singular, simple, and fixed true", () => {
  const definition = read<StructureDefinition>("canonical-extensions/odos-no-textable-number.json");
  assert.deepEqual(definition.context, [{ type: "element", expression: "Patient" }]);
  const elements = definition.differential!.element;
  assert.deepEqual(elements.find(element => element.path === "Extension"), { id: "Extension", path: "Extension", short: "No textable number reported", min: 0, max: "1" });
  assert.equal(elements.find(element => element.path === "Extension.extension")?.max, "0");
  assert.equal(elements.find(element => element.path === "Extension.url")?.fixedUri, definition.url);
  const value = elements.find(element => element.path === "Extension.value[x]")!;
  assert.equal(value.min, 1);
  assert.equal(value.max, "1");
  assert.deepEqual(value.type, [{ code: "boolean" }]);
  assert.equal(value.fixedBoolean, true);
});


test("H9: registered textable marker produces no canonical URL hard block", () => {
  const path = new URL("../src/comms/suppression-gate.ts", import.meta.url);
  const report = runVendorCanonicalShapePass({ files: [{ path: path.pathname, text: readFileSync(path, "utf8") }] });
  const findings = report.findings.filter(finding => finding.code === "odos-extension-url-shape");
  assert.deepEqual(findings, []);
});
