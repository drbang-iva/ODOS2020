import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { currentFindingIdentifier, parseCurrentFindingEnvelope, resolveCatalogRow, classifyFindingObservation, eyeSet, findingQualifiers } from "../src/clinical-graph/current-finding-identity.js";
import { buildFindingReadAliases } from "../src/clinical-graph/finding-read-aliases.js";
import { observationNegativeAct } from "../src/clinical-graph/finding-section-helpers.js";
import { customFieldEntries } from "../src/clinical-graph/custom-fields.js";
import { odosConcept } from "../src/fhir/ophthalmology/extensions.js";
import { definitions, catalog, nuclear, lens, lensField, atomic, snapshot, comp, negative } from "./fixtures/r10/factories.js";
const key = { v: 1 as const, patientId: "p1", encounterId: "e1", stableKey: lens.stableKey, fieldCode: lensField, optionCode: nuclear.optionCode, eye: "OD" as const };
function canonical() { return { ...atomic(), identifier: [currentFindingIdentifier(key)], component: [comp("R10_CURRENT_META", JSON.stringify(key))] }; }
const aliases = buildFindingReadAliases(definitions, catalog);
const classify = (o: ReturnType<typeof atomic>) => classifyFindingObservation(o, definitions, catalog, aliases);

test("identity is SHA256 of the ordered v1 tuple, independent of object order and seed id", () => {
  assert.deepEqual(currentFindingIdentifier(key), { system: "urn:odos:current-finding:v1", value: createHash("sha256").update(JSON.stringify([1,"p1","e1",lens.stableKey,lensField,nuclear.optionCode,"OD"])).digest("hex") });
  assert.deepEqual(currentFindingIdentifier({ ...key, ...Object.fromEntries(Object.entries(key).reverse()) }), currentFindingIdentifier(key));
  assert.notDeepEqual(currentFindingIdentifier({ ...key, eye: "OS" }), currentFindingIdentifier(key));
  assert.equal(parseCurrentFindingEnvelope(canonical()).status, "valid");
});
for (const mismatch of ["hash", "patient", "encounter", "code", "eye", "schema", "duplicate-envelope", "duplicate-identifier"]) {
  test(`canonical envelope rejects ${mismatch} mismatch`, () => {
    const o = canonical();
    if (mismatch === "hash") o.identifier[0].value = "bad";
    if (mismatch === "patient") o.subject = { reference: "Patient/other" };
    if (mismatch === "encounter") o.encounter = { reference: "Encounter/other" };
    if (mismatch === "code") o.code = odosConcept("another");
    if (mismatch === "eye") o.extension = atomic("other", "OS").extension;
    if (mismatch === "schema") o.component[0].valueString = JSON.stringify({ ...key, eye: "OU" });
    if (mismatch === "duplicate-envelope") o.component.push(o.component[0]);
    if (mismatch === "duplicate-identifier") o.identifier.push(o.identifier[0]);
    assert.equal(parseCurrentFindingEnvelope(o).status, "invalid");
  });
}
test("exact catalog resolution retains the whole nested option", () => {
  const nested = catalog.find(r => r.optionCode === "demodex::collarettes")!;
  assert.ok(nested);
  assert.equal(resolveCatalogRow(catalog, nested.atomicFindingId), nested);
  assert.equal(resolveCatalogRow(catalog, `${nested.atomicFindingId}::unknown`), undefined);
});
test("retired atomic aliases use current retirement semantics and never reverse false subtypes", () => {
  const old = { ...atomic(), code: odosConcept(`${lens.stableKey}::${lensField}::brunescent`) };
  const found = classify(old);
  assert.equal(found.kind, "legacy-atomic");
  assert.equal(found.row?.optionCode, "nuclear-sclerosis");
  assert.deepEqual(found.qualifiers, { colour: "4+ (dark brown/black; brunescent)" });
  assert.equal(classify({ ...old, valueBoolean: false }).kind, "unresolved-legacy");
  assert.equal(classify({ ...old, code: odosConcept(`${lens.stableKey}::${lensField}::unknown`) }).kind, "unresolved-legacy");
});
test("role markers dominate definition matching, conflicting markers are invalid", () => {
  assert.equal(classify(canonical()).kind, "canonical-fact");
  assert.equal(classify(atomic()).kind, "legacy-atomic");
  assert.equal(classify(snapshot()).kind, "legacy-section-snapshot");
  assert.equal(classify(negative()).kind, "negative-act");
  assert.equal(classify({ ...snapshot(), identifier: [{ system: "urn:odos:finding-panel:v1", value: "panel" }] }).kind, "panel-context");
  assert.equal(classify({ ...canonical(), identifier: [...canonical().identifier, ...negative().identifier!] }).kind, "invalid");
  for (const code of ["refraction", "intraocular_pressure", "custom:numeric"]) assert.equal(classify({ ...atomic(), code: odosConcept(code), valueQuantity: { value: 1 } }).kind, "unrelated");
});
test("one typed qualifier reader preserves numeric, enum, extent, legacy GRADE and retired grade removal", () => {
  for (const definition of definitions) for (const field of customFieldEntries(definition)) for (const option of field.options ?? []) {
    const values = Object.fromEntries((option.qualifiers ?? []).map(q => [q.key, q.kind === "numeric" ? 2 : q.kind === "extent" ? { from: 2, to: 5, clockwise: true } : q.kind === "enum" ? q.options[0].code : q.options[0]]));
    const row = catalog.find(r => r.findingDefinitionKey === definition.stableKey && r.fieldCode === field.localCode && r.optionCode === option.code);
    if (!row || !Object.keys(values).length) continue;
    const observation = { ...atomic(), code: odosConcept(definition.stableKey), component: Object.entries(values).map(([k,v]) => comp(`OD_${field.localCode}::${option.code}::${k}`, v)) };
    assert.deepEqual(findingQualifiers(observation, definition, row, "OD_"), values);
  }
  assert.deepEqual(findingQualifiers({ ...atomic(), component: [comp("GRADE", "2+")] }, lens, nuclear, ""), { grade: "2+" });
  const spk = catalog.find(r => r.optionCode === "superficial-punctate-keratitis-spk")!;
  const definition = definitions.find(d => d.stableKey === spk.findingDefinitionKey)!;
  assert.deepEqual(findingQualifiers({ ...atomic(), component: [comp("GRADE", "Grade 0")] }, definition, spk, ""), {});
});
test("malformed stored negative still throws; eye sets never coerce UNKNOWN", () => {
  assert.throws(() => observationNegativeAct({ ...negative(), component: [comp("NEGATIVE_ACT", "corrupt")] }), /Invalid persisted negative act/);
  assert.deepEqual(eyeSet("OU"), ["OD", "OS"]);
  assert.deepEqual(eyeSet("UNKNOWN"), []);
});
test("compiled ocular structure field identities and atomic samples are pinned", () => {
  const actual = definitions.map(d => ({ stableKey: d.stableKey, fields: customFieldEntries(d, true).map(f => f.localCode),
    atomicIds: catalog.filter(r => r.findingDefinitionKey === d.stableKey).slice(0, 3).map(r => r.atomicFindingId) }));
  const pin = JSON.parse(readFileSync(new URL("./fixtures/r10/field-identities.json", import.meta.url), "utf8"));
  assert.deepEqual(actual, pin);
});
