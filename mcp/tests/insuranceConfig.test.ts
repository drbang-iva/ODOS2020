import assert from "node:assert/strict";
import { test } from "node:test";
import { BENEFIT_KINDS } from "../../ui/src/lib/patient-insurance.js";
import {
  ODOS_INSURANCE_CONFIG_CODE,
  ODOS_INSURANCE_CONFIG_EXTENSION_URL,
  ODOS_INSURANCE_CONFIG_SYSTEM,
  buildInsuranceConfigResource,
  parseInsuranceConfig,
  type PersistedInsuranceConfig,
  type PlanTemplateBenefit,
} from "../src/insurance/insurance-config.js";

function benefits(overrides: Partial<PlanTemplateBenefit> = {}) {
  return Object.fromEntries(
    BENEFIT_KINDS.map((kind) => [
      kind,
      { excluded: false, ...overrides },
    ]),
  );
}

const CONFIG: PersistedInsuranceConfig = {
  planTemplates: [
    {
      id: "template-1",
      label: "Example vision plan",
      payerDisplay: "Example payer",
      benefits: benefits({ allowanceDollars: 150, copayDollars: 10, frequencyMonths: 12 }),
    },
    {
      id: "template-2",
      label: "Retired example",
      active: false,
      benefits: benefits(),
    },
  ],
};

test("buildInsuranceConfigResource round-trips the real singleton and preserves update identity", () => {
  const existing = buildInsuranceConfigResource(CONFIG);
  existing.id = "insurance-config-1";
  existing.meta = { versionId: "4" };
  const resource = buildInsuranceConfigResource(CONFIG, existing);
  assert.equal(resource.code?.coding?.[0]?.system, ODOS_INSURANCE_CONFIG_SYSTEM);
  assert.equal(resource.code?.coding?.[0]?.code, ODOS_INSURANCE_CONFIG_CODE);
  assert.equal(resource.id, "insurance-config-1");
  assert.equal(resource.meta?.versionId, "4");
  assert.deepEqual(parseInsuranceConfig(resource), CONFIG);
});

test("active templates omit active true while inactive templates persist false", () => {
  const resource = buildInsuranceConfigResource({
    planTemplates: CONFIG.planTemplates.map((template) => ({ ...template, active: true })),
  });
  const raw = JSON.parse(
    resource.extension?.find(
      (extension) => extension.url === ODOS_INSURANCE_CONFIG_EXTENSION_URL,
    )?.valueString ?? "{}",
  ) as PersistedInsuranceConfig;
  assert.ok(raw.planTemplates.every((template) => !("active" in template)));
  assert.ok(
    parseInsuranceConfig(buildInsuranceConfigResource(CONFIG)).planTemplates.find(
      (template) => template.id === "template-2",
    )?.active === false,
  );
});

test("insurance-config validators reject labels, money, and frequency with verbatim messages", () => {
  assert.throws(
    () => buildInsuranceConfigResource({ planTemplates: [{ ...CONFIG.planTemplates[0]!, label: "" }] }),
    { message: "Plan template label is required." },
  );
  assert.throws(
    () =>
      buildInsuranceConfigResource({
        planTemplates: [CONFIG.planTemplates[0]!, { ...CONFIG.planTemplates[1]!, label: "example VISION plan" }],
      }),
    { message: "Plan template label must be unique within this catalog." },
  );
  assert.throws(
    () =>
      buildInsuranceConfigResource({
        planTemplates: [{ ...CONFIG.planTemplates[0]!, benefits: benefits({ allowanceDollars: -1 }) }],
      }),
    { message: "Medical allowance must be a nonnegative dollar amount." },
  );
  assert.throws(
    () =>
      buildInsuranceConfigResource({
        planTemplates: [{ ...CONFIG.planTemplates[0]!, benefits: benefits({ copayDollars: 1.234 }) }],
      }),
    { message: "Medical copay must be a nonnegative dollar amount." },
  );
  assert.throws(
    () =>
      buildInsuranceConfigResource({
        planTemplates: [{ ...CONFIG.planTemplates[0]!, benefits: benefits({ frequencyMonths: 1.5 }) }],
      }),
    { message: "Medical frequency must be a positive whole number of months." },
  );
});

test("parseInsuranceConfig rejects the wrong singleton, missing payload, and malformed JSON", () => {
  assert.throws(
    () => parseInsuranceConfig({ resourceType: "Basic", code: { coding: [{ system: "other", code: "x" }] } }),
    /not the odos insurance-config singleton/,
  );
  assert.throws(
    () =>
      parseInsuranceConfig({
        resourceType: "Basic",
        code: { coding: [{ system: ODOS_INSURANCE_CONFIG_SYSTEM, code: ODOS_INSURANCE_CONFIG_CODE }] },
      }),
    /missing its config extension/,
  );
  const malformed = buildInsuranceConfigResource(CONFIG);
  malformed.extension![0]!.valueString = "{not json";
  assert.throws(() => parseInsuranceConfig(malformed), /Insurance-config JSON/);
});
