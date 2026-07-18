import assert from "node:assert/strict";
import { test } from "node:test";
import type { Basic } from "@medplum/fhirtypes";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createSingletonConfigDraft } from "../src/lib/catalog-adapter";
import {
  buildInsuranceConfigResource,
  loadInsuranceConfigSingleton,
  parseInsuranceConfig,
  type PersistedInsuranceConfig,
  type PlanTemplateBenefit,
} from "../src/lib/insurance-config";
import {
  PLAN_TEMPLATE_FIELDS,
  createPlanTemplateAdapter,
  planTemplateFieldKey,
  planTemplateRows,
  validatePlanTemplateRow,
} from "../src/lib/plan-template-settings";
import { BENEFIT_KINDS } from "../src/lib/patient-insurance";
import { CatalogFieldValidationError } from "../src/lib/catalog-field-kernel";
import { CatalogSection } from "../src/scenes/settings/CatalogEditor";
import {
  VisionPlanTemplatesSettingsReady,
  createPlanTemplateDescriptor,
} from "../src/scenes/settings/VisionPlanTemplatesSettings";

function benefits(overrides: Partial<PlanTemplateBenefit> = {}) {
  return Object.fromEntries(
    BENEFIT_KINDS.map((kind) => [kind, { excluded: false, ...overrides }]),
  ) as Record<(typeof BENEFIT_KINDS)[number], PlanTemplateBenefit>;
}

const CONFIG: PersistedInsuranceConfig = {
  planTemplates: [
    {
      id: "template-1",
      label: "Example vision plan",
      payerDisplay: "Example payer",
      benefits: benefits({ allowanceDollars: 150, copayDollars: 10, frequencyMonths: 12 }),
    },
  ],
};

function fixture() {
  const writes: Array<{ resource: Basic; sourceTag: string }> = [];
  const resource = {
    ...buildInsuranceConfigResource(CONFIG),
    id: "insurance-config-1",
    meta: { versionId: "2" },
  };
  const client = {
    async create<T extends Basic>(next: T, sourceTag: string) {
      writes.push({ resource: next, sourceTag });
      return { ...next, id: "created" };
    },
    async update<T extends Basic>(next: T, sourceTag: string) {
      writes.push({ resource: next, sourceTag });
      return next;
    },
  };
  const draft = createSingletonConfigDraft({
    configKey: "odos-insurance-config",
    config: CONFIG,
    resource,
    buildResource: buildInsuranceConfigResource,
    sourceTag: "insurance-config",
    fhirClient: client,
  });
  return { draft, writes, resource, client };
}

test("vision plan-template scene renders through the shared catalog shell in read-only mode", () => {
  const { resource, client } = fixture();
  const html = renderToStaticMarkup(
    <VisionPlanTemplatesSettingsReady
      resource={resource}
      config={CONFIG}
      canWrite={false}
      client={client}
    />,
  );
  assert.match(html, /Vision plan templates/);
  assert.doesNotMatch(html, /\+ Add plan template|Deactivate/);
});

test("flat descriptor exposes each benefit kind without a nested field type", () => {
  const types = new Set(PLAN_TEMPLATE_FIELDS.map((field) => field.type));
  assert.ok(!types.has("nested" as never));
  for (const kind of BENEFIT_KINDS) {
    for (const field of ["excluded", "allowanceDollars", "copayDollars", "frequencyMonths"] as const) {
      assert.ok(PLAN_TEMPLATE_FIELDS.some((candidate) => candidate.key === planTemplateFieldKey(kind, field)));
    }
  }

  const { draft } = fixture();
  const adapter = createPlanTemplateAdapter(draft);
  const descriptor = createPlanTemplateDescriptor(draft, adapter);
  const html = renderToStaticMarkup(
    <CatalogSection
      descriptor={descriptor}
      canWrite
      initialState={{ items: planTemplateRows(CONFIG), selectedId: "template-1" }}
    />,
  );
  assert.match(html, /Medical · Allowance dollars/);
  assert.match(html, /Contact Exam · Frequency months/);
  assert.match(html, /Example vision plan/);
  assert.match(html, /Example payer/);
  assert.match(html, /Active/);
  assert.match(html, /Deactivate/);
  assert.doesNotMatch(html, /Delete/);
});

test("projected adapter deactivates and commits once with insurance-config source tagging", async () => {
  const { draft, writes } = fixture();
  const adapter = createPlanTemplateAdapter(draft);
  const row = (await adapter.list())[0]!;
  await adapter.save({ ...row, payerDisplay: "Updated payer" });
  await adapter.deactivate((await adapter.list())[0]!);
  assert.equal(draft.dirty, true);
  await draft.commit();
  assert.equal(writes.length, 1);
  assert.equal(writes[0]!.sourceTag, "insurance-config");
  const persisted = parseInsuranceConfig(writes[0]!.resource);
  assert.equal(persisted.planTemplates[0]?.payerDisplay, "Updated payer");
  assert.equal(persisted.planTemplates[0]?.active, false);
  assert.equal("delete" in adapter, false);
});

test("kernel validation is mapped to the matching flat form field verbatim", () => {
  const row = planTemplateRows(CONFIG)[0]!;
  assert.throws(
    () =>
      validatePlanTemplateRow(CONFIG, [row], {
        ...row,
        [planTemplateFieldKey("exam", "allowanceDollars")]: -1,
      }),
    (error) =>
      error instanceof CatalogFieldValidationError &&
      error.fieldKey === planTemplateFieldKey("exam", "allowanceDollars") &&
      error.message === "Exam allowance must be a nonnegative dollar amount.",
  );
  assert.throws(
    () =>
      validatePlanTemplateRow(CONFIG, [row], {
        ...row,
        [planTemplateFieldKey("frame", "frequencyMonths")]: 1.5,
      }),
    (error) =>
      error instanceof CatalogFieldValidationError &&
      error.fieldKey === planTemplateFieldKey("frame", "frequencyMonths") &&
      error.message === "Frame frequency must be a positive whole number of months.",
  );
});

test("singleton loader uses the coded Basic criteria and defaults to an empty template list", async () => {
  const searches: URLSearchParams[] = [];
  const loaded = await loadInsuranceConfigSingleton({
    async search(_resourceType, params) {
      searches.push(params);
      return { resourceType: "Bundle", type: "searchset" };
    },
  });
  assert.deepEqual(loaded.config, { planTemplates: [] });
  assert.equal(
    searches[0]?.get("code"),
    "https://odos2020.com/fhir/CodeSystem/insurance-config|odos-insurance-config",
  );
});
