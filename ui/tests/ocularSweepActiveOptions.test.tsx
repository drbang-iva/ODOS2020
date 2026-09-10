import assert from "node:assert/strict";
import test from "node:test";
import { applyAnteriorAllNormal, applyPosteriorAllNormal } from "../src/components/charting/OcularHealthSection";
import { buildFindingDefinitionSeeds } from "../../mcp/src/clinical-graph/finding-definition-store.js";
import { customFieldEntries } from "../../mcp/src/clinical-graph/custom-fields.js";
import { handleCustomSectionCaptureRequest, type CustomSectionEndpointDeps } from "../../mcp/src/clinical-graph/custom-section-endpoint.js";

for (const [segment, sweep] of [["anterior", applyAnteriorAllNormal], ["posterior", applyPosteriorAllNormal]] as const) {
  const seed = buildFindingDefinitionSeeds().find((definition) => definition.stableKey.startsWith(`ocular-health:${segment}:`))!;
  const field = customFieldEntries(seed, true).find((entry) => entry.valueType === "multi-select")!;
  const inactive = { ...field, options: field.options!.map((option) => ({ ...option, active: false })) };

  test(`${segment}: all-inactive definition creates no act or rejected save`, async () => {
    const result = sweep([{ stableKey: seed.stableKey, customFields: [inactive] }], {});
    const row = result.captures[seed.stableKey];
    if (row) {
      assert.deepEqual(row.OD.negativeAct?.optionCodes, []);
      const deps: CustomSectionEndpointDeps = {
        findingDefinitions: () => [seed],
        authenticate: async () => ({
          staffReference: "Practitioner/sweep-test", actorRole: "provider",
          fhir: {
            search: async () => ({ resourceType: "Bundle", type: "searchset", entry: [] }),
            create: async () => { throw new Error("invalid empty act must not persist"); },
          },
        }),
      };
      const response = await handleCustomSectionCaptureRequest(deps, {
        authHeader: undefined, params: { stableKey: seed.stableKey },
        body: { patientReference: "Patient/sweep-test", encounterReference: "Encounter/sweep-test", eyes: row },
      });
      assert.equal(response.status, 400);
      assert.match(JSON.stringify(response.body), /Array must contain at least 1 element/);
      assert.fail(`empty act caused rejected save: ${JSON.stringify(response.body)}`);
    }
    assert.equal(result.filled, 0);
    assert.deepEqual(result.captures, {});
    const existing = { OD: { selections: [], other: "" }, OS: { selections: [], other: "" } };
    assert.strictEqual(sweep([{ stableKey: seed.stableKey, customFields: [inactive] }], { [seed.stableKey]: existing }).captures[seed.stableKey], existing);
  });

  test(`${segment}: inactive field with active options creates no negative act or capture`, () => {
    assert.ok(field.options!.some((option) => option.active));
    const result = sweep([{ stableKey: seed.stableKey, customFields: [{ ...field, active: false }] }], {});
    assert.deepEqual(result.captures, {});
    assert.equal(result.filled, 0);
  });

  test(`${segment}: second multi-select supplies active codes when first is empty`, () => {
    const expected = field.options!.filter((option) => option.active).map((option) => option.code);
    assert.ok(expected.length > 0);
    const result = sweep([{ stableKey: seed.stableKey, customFields: [{ ...inactive, options: [] }, { ...field, localCode: "second-field" }] }], {});
    assert.equal(result.filled, 2);
    for (const eye of ["OD", "OS"] as const) {
      assert.deepEqual(result.captures[seed.stableKey][eye].negativeAct?.optionCodes, expected);
    }
  });
}
