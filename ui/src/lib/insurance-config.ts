import type { Basic, Bundle } from "@medplum/fhirtypes";
import {
  BENEFIT_KINDS,
  type BenefitKind,
  type ManualBenefitsDraft,
} from "./patient-insurance";

export const ODOS_INSURANCE_CONFIG_SYSTEM = "https://odos2020.com/fhir/CodeSystem/insurance-config";
export const ODOS_INSURANCE_CONFIG_CODE = "odos-insurance-config";
export const ODOS_INSURANCE_CONFIG_EXTENSION_URL =
  "https://odos2020.com/fhir/StructureDefinition/odos-insurance-practice-config";

export interface PlanTemplateBenefit {
  excluded: boolean;
  allowanceDollars?: number;
  copayDollars?: number;
  frequencyMonths?: number;
}

export interface PlanTemplate {
  id: string;
  label: string;
  payerDisplay?: string;
  active?: boolean;
  benefits: Record<BenefitKind, PlanTemplateBenefit>;
}

export interface PersistedInsuranceConfig {
  planTemplates: PlanTemplate[];
}

export const EMPTY_INSURANCE_CONFIG: PersistedInsuranceConfig = { planTemplates: [] };

type InsuranceConfigReader = {
  search<T extends Basic>(
    resourceType: T["resourceType"],
    params: URLSearchParams,
  ): Promise<Bundle<T>>;
};

function benefitLabel(kind: BenefitKind): string {
  return kind === "contact-exam"
    ? "Contact Exam"
    : `${kind[0].toUpperCase()}${kind.slice(1)}`;
}

function assertBenefit(kind: BenefitKind, benefit: PlanTemplateBenefit): void {
  const label = benefitLabel(kind);
  for (const [field, value] of [
    ["allowance", benefit.allowanceDollars],
    ["copay", benefit.copayDollars],
  ] as const) {
    if (value !== undefined && !isDollarAmount(value)) {
      throw new Error(`${label} ${field} must be a nonnegative dollar amount.`);
    }
  }
  if (
    benefit.frequencyMonths !== undefined &&
    (!Number.isInteger(benefit.frequencyMonths) || benefit.frequencyMonths < 1)
  ) {
    throw new Error(`${label} frequency must be a positive whole number of months.`);
  }
}

function isDollarAmount(value: number): boolean {
  return Number.isFinite(value) && value >= 0 && /^\d+(?:\.\d{1,2})?$/.test(String(value));
}

function assertConfig(config: PersistedInsuranceConfig): void {
  const labels = new Set<string>();
  for (const template of config.planTemplates) {
    if (!template.label.trim()) {
      throw new Error("Plan template label is required.");
    }
    const normalized = template.label.trim().toLocaleLowerCase();
    if (labels.has(normalized)) {
      throw new Error("Plan template label must be unique within this catalog.");
    }
    labels.add(normalized);
    for (const kind of BENEFIT_KINDS) {
      assertBenefit(kind, template.benefits[kind]);
    }
  }
}

export function buildInsuranceConfigResource(
  config: PersistedInsuranceConfig,
  existing?: Basic,
): Basic {
  assertConfig(config);
  const persistedConfig: PersistedInsuranceConfig = {
    ...config,
    planTemplates: config.planTemplates.map(({ active, ...template }) =>
      active === false ? { ...template, active: false } : template,
    ),
  };
  return {
    resourceType: "Basic",
    ...(existing?.id ? { id: existing.id } : {}),
    ...(existing?.meta ? { meta: existing.meta } : {}),
    code: {
      coding: [
        {
          system: ODOS_INSURANCE_CONFIG_SYSTEM,
          code: ODOS_INSURANCE_CONFIG_CODE,
          display: "ODOS Insurance Config",
        },
      ],
      text: "ODOS Insurance Config",
    },
    extension: [
      {
        url: ODOS_INSURANCE_CONFIG_EXTENSION_URL,
        valueString: JSON.stringify(persistedConfig),
      },
    ],
  };
}

export function parseInsuranceConfig(basic: Basic): PersistedInsuranceConfig {
  const coding = basic.code?.coding?.find(
    (candidate) =>
      candidate.system === ODOS_INSURANCE_CONFIG_SYSTEM &&
      candidate.code === ODOS_INSURANCE_CONFIG_CODE,
  );
  if (!coding) {
    throw new Error("Basic resource is not the odos insurance-config singleton.");
  }
  const raw = basic.extension?.find(
    (extension) => extension.url === ODOS_INSURANCE_CONFIG_EXTENSION_URL,
  )?.valueString;
  if (!raw) {
    throw new Error("Insurance-config singleton is missing its config extension.");
  }
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    throw new Error("Insurance-config JSON is malformed and cannot be parsed.");
  }
  const config: PersistedInsuranceConfig = {
    planTemplates: (parsed.planTemplates ?? []) as PlanTemplate[],
  };
  assertConfig(config);
  return config;
}

export async function loadInsuranceConfigSingleton(
  client: InsuranceConfigReader,
): Promise<{ resource?: Basic; config: PersistedInsuranceConfig }> {
  const bundle = await client.search<Basic>(
    "Basic",
    new URLSearchParams([
      ["code", `${ODOS_INSURANCE_CONFIG_SYSTEM}|${ODOS_INSURANCE_CONFIG_CODE}`],
      ["_count", "10"],
    ]),
  );
  const resource = (bundle.entry ?? [])
    .map((entry) => entry.resource)
    .filter((candidate): candidate is Basic => Boolean(candidate))
    .sort(
      (a, b) =>
        (Date.parse(b.meta?.lastUpdated ?? "") || 0) -
        (Date.parse(a.meta?.lastUpdated ?? "") || 0),
    )[0];
  return {
    resource,
    config: resource ? parseInsuranceConfig(resource) : structuredClone(EMPTY_INSURANCE_CONFIG),
  };
}

export function applyPlanTemplate(
  draft: ManualBenefitsDraft,
  template: PlanTemplate,
): ManualBenefitsDraft {
  return {
    ...draft,
    benefits: draft.benefits.map((benefit) => {
      const plan = template.benefits[benefit.kind];
      if (!plan) return benefit;
      return {
        ...benefit,
        excluded: plan.excluded,
        allowanceDollars: displayNumber(plan.allowanceDollars),
        copayDollars: displayNumber(plan.copayDollars),
        frequencyMonths: displayNumber(plan.frequencyMonths),
      };
    }),
  };
}

function displayNumber(value: number | undefined): string {
  return value === undefined ? "" : String(value);
}
