import type { Basic } from "@medplum/fhirtypes";

export const OSOD_INSURANCE_CONFIG_SYSTEM = "https://osod.dev/fhir/CodeSystem/insurance-config";
export const OSOD_INSURANCE_CONFIG_CODE = "osod-insurance-config";
export const OSOD_INSURANCE_CONFIG_EXTENSION_URL =
  "https://osod.dev/fhir/StructureDefinition/osod-insurance-practice-config";

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
  benefits: Record<string, PlanTemplateBenefit>;
}

export interface PersistedInsuranceConfig {
  planTemplates: PlanTemplate[];
}

function benefitLabel(kind: string): string {
  return kind === "contact-exam"
    ? "Contact Exam"
    : `${kind[0]?.toUpperCase() ?? ""}${kind.slice(1)}`;
}

function assertBenefit(kind: string, benefit: PlanTemplateBenefit): void {
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
    for (const [kind, benefit] of Object.entries(template.benefits)) {
      assertBenefit(kind, benefit);
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
          system: OSOD_INSURANCE_CONFIG_SYSTEM,
          code: OSOD_INSURANCE_CONFIG_CODE,
          display: "OSOD Insurance Config",
        },
      ],
      text: "OSOD Insurance Config",
    },
    extension: [
      {
        url: OSOD_INSURANCE_CONFIG_EXTENSION_URL,
        valueString: JSON.stringify(persistedConfig),
      },
    ],
  };
}

export function parseInsuranceConfig(basic: Basic): PersistedInsuranceConfig {
  const coding = basic.code?.coding?.find(
    (candidate) =>
      candidate.system === OSOD_INSURANCE_CONFIG_SYSTEM &&
      candidate.code === OSOD_INSURANCE_CONFIG_CODE,
  );
  if (!coding) {
    throw new Error("Basic resource is not the osod insurance-config singleton.");
  }
  const raw = basic.extension?.find(
    (extension) => extension.url === OSOD_INSURANCE_CONFIG_EXTENSION_URL,
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
