import assert from "node:assert/strict";
import { test } from "node:test";
import {
  OSOD_INSURANCE_CONFIG_CODE as MCP_OSOD_INSURANCE_CONFIG_CODE,
  OSOD_INSURANCE_CONFIG_EXTENSION_URL as MCP_OSOD_INSURANCE_CONFIG_EXTENSION_URL,
  OSOD_INSURANCE_CONFIG_SYSTEM as MCP_OSOD_INSURANCE_CONFIG_SYSTEM,
  buildInsuranceConfigResource as mcpBuildInsuranceConfigResource,
  parseInsuranceConfig as mcpParseInsuranceConfig,
  type PersistedInsuranceConfig,
} from "../src/insurance/insurance-config.js";
import { BENEFIT_KINDS } from "../../ui/src/lib/patient-insurance.js";
import {
  OSOD_INSURANCE_CONFIG_CODE as UI_OSOD_INSURANCE_CONFIG_CODE,
  OSOD_INSURANCE_CONFIG_EXTENSION_URL as UI_OSOD_INSURANCE_CONFIG_EXTENSION_URL,
  OSOD_INSURANCE_CONFIG_SYSTEM as UI_OSOD_INSURANCE_CONFIG_SYSTEM,
  buildInsuranceConfigResource as uiBuildInsuranceConfigResource,
  parseInsuranceConfig as uiParseInsuranceConfig,
} from "../../ui/src/lib/insurance-config.js";

const CONFIG: PersistedInsuranceConfig = {
  planTemplates: [
    {
      id: "template-1",
      label: "Example plan",
      payerDisplay: "Example payer",
      benefits: Object.fromEntries(
        BENEFIT_KINDS.map((kind) => [
          kind,
          {
            excluded: kind === "medical",
            allowanceDollars: 150,
            copayDollars: 10,
            frequencyMonths: 12,
          },
        ]),
      ),
    },
  ],
};

test("UI insurance-config mirror constants and singleton wire shape match the kernel", () => {
  assert.equal(UI_OSOD_INSURANCE_CONFIG_SYSTEM, MCP_OSOD_INSURANCE_CONFIG_SYSTEM);
  assert.equal(UI_OSOD_INSURANCE_CONFIG_CODE, MCP_OSOD_INSURANCE_CONFIG_CODE);
  assert.equal(UI_OSOD_INSURANCE_CONFIG_EXTENSION_URL, MCP_OSOD_INSURANCE_CONFIG_EXTENSION_URL);
  assert.deepEqual(uiBuildInsuranceConfigResource(CONFIG as never), mcpBuildInsuranceConfigResource(CONFIG));
  assert.deepEqual(
    uiParseInsuranceConfig(uiBuildInsuranceConfigResource(CONFIG as never)),
    mcpParseInsuranceConfig(mcpBuildInsuranceConfigResource(CONFIG)),
  );
});

test("UI insurance-config validator messages match the kernel verbatim", () => {
  for (const invalid of [
    { planTemplates: [{ ...CONFIG.planTemplates[0]!, label: "" }] },
    {
      planTemplates: [
        {
          ...CONFIG.planTemplates[0]!,
          benefits: Object.fromEntries(
            BENEFIT_KINDS.map((kind) => [
              kind,
              { excluded: false, allowanceDollars: -1 },
            ]),
          ),
        },
      ],
    },
    {
      planTemplates: [
        {
          ...CONFIG.planTemplates[0]!,
          benefits: Object.fromEntries(
            BENEFIT_KINDS.map((kind) => [
              kind,
              { excluded: false, frequencyMonths: 0 },
            ]),
          ),
        },
      ],
    },
  ]) {
    assert.throws(
      () => uiBuildInsuranceConfigResource(invalid as never),
      (error) => {
        assert.ok(error instanceof Error);
        assert.throws(() => mcpBuildInsuranceConfigResource(invalid), { message: error.message });
        return true;
      },
    );
  }
});
