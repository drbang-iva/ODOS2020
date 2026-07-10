import type { CatalogFieldDescriptor } from "../components/settings/CatalogFields";
import {
  CatalogFieldValidationError,
} from "./catalog-field-kernel";
import {
  projectedListAdapter,
  type CatalogAdapter,
  type SingletonConfigDraft,
} from "./catalog-adapter";
import {
  buildInsuranceConfigResource,
  type PersistedInsuranceConfig,
  type PlanTemplate,
  type PlanTemplateBenefit,
} from "./insurance-config";
import { BENEFIT_KINDS, type BenefitKind } from "./patient-insurance";

type PlanTemplateBenefitField = keyof PlanTemplateBenefit;

export type PlanTemplateRow = {
  id: string;
  label: string;
  payerDisplay: string;
  active: boolean;
} & Record<string, unknown>;

export function planTemplateBenefitLabel(kind: BenefitKind): string {
  return kind === "contact-exam"
    ? "Contact Exam"
    : `${kind[0].toUpperCase()}${kind.slice(1)}`;
}

export function planTemplateFieldKey(
  kind: BenefitKind,
  field: PlanTemplateBenefitField,
): string {
  return `${kind}:${field}`;
}

export const PLAN_TEMPLATE_FIELDS: readonly CatalogFieldDescriptor[] = [
  {
    type: "text",
    key: "label",
    label: "Plan template label",
    required: true,
    unique: true,
  },
  { type: "text", key: "payerDisplay", label: "Payer display" },
  ...BENEFIT_KINDS.flatMap((kind) => {
    const label = planTemplateBenefitLabel(kind);
    return [
      {
        type: "toggle" as const,
        key: planTemplateFieldKey(kind, "excluded"),
        label: `${label} · Does not exist`,
      },
      {
        type: "number" as const,
        key: planTemplateFieldKey(kind, "allowanceDollars"),
        label: `${label} · Allowance dollars`,
      },
      {
        type: "number" as const,
        key: planTemplateFieldKey(kind, "copayDollars"),
        label: `${label} · Copay dollars`,
      },
      {
        type: "number" as const,
        key: planTemplateFieldKey(kind, "frequencyMonths"),
        label: `${label} · Frequency months`,
      },
    ];
  }),
];

export function emptyPlanTemplateRow(id: string): PlanTemplateRow {
  const row: PlanTemplateRow = {
    id,
    label: "",
    payerDisplay: "",
    active: true,
  };
  for (const kind of BENEFIT_KINDS) {
    row[planTemplateFieldKey(kind, "excluded")] = false;
  }
  return row;
}

export function planTemplateRows(config: PersistedInsuranceConfig): PlanTemplateRow[] {
  return config.planTemplates.map((template) => {
    const row: PlanTemplateRow = {
      id: template.id,
      label: template.label,
      payerDisplay: template.payerDisplay ?? "",
      active: template.active !== false,
    };
    for (const kind of BENEFIT_KINDS) {
      const benefit = template.benefits[kind];
      row[planTemplateFieldKey(kind, "excluded")] = benefit.excluded;
      row[planTemplateFieldKey(kind, "allowanceDollars")] = benefit.allowanceDollars;
      row[planTemplateFieldKey(kind, "copayDollars")] = benefit.copayDollars;
      row[planTemplateFieldKey(kind, "frequencyMonths")] = benefit.frequencyMonths;
    }
    return row;
  });
}

export function configFromPlanTemplateRows(
  config: PersistedInsuranceConfig,
  rows: PlanTemplateRow[],
): PersistedInsuranceConfig {
  const planTemplates: PlanTemplate[] = rows.map((row) => {
    const payerDisplay = row.payerDisplay.trim();
    return {
      id: row.id,
      label: row.label.trim(),
      ...(payerDisplay ? { payerDisplay } : {}),
      ...(row.active ? {} : { active: false }),
      benefits: Object.fromEntries(
        BENEFIT_KINDS.map((kind) => [kind, benefitFromRow(row, kind)]),
      ) as Record<BenefitKind, PlanTemplateBenefit>,
    };
  });
  const next = { ...config, planTemplates };
  buildInsuranceConfigResource(next);
  return next;
}

export function validatePlanTemplateRow(
  config: PersistedInsuranceConfig,
  items: PlanTemplateRow[],
  item: PlanTemplateRow,
): void {
  const index = items.findIndex((candidate) => candidate.id === item.id);
  const nextRows = index === -1
    ? [...items, item]
    : items.map((candidate) => (candidate.id === item.id ? item : candidate));
  try {
    configFromPlanTemplateRows(config, nextRows);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new CatalogFieldValidationError(fieldKeyForValidationMessage(message), message);
  }
}

export function createPlanTemplateAdapter(
  draft: SingletonConfigDraft<PersistedInsuranceConfig>,
): CatalogAdapter<PlanTemplateRow> {
  return projectedListAdapter(draft, {
    capabilities: { reorder: false, deactivate: true, presetSeed: false },
    toRows: planTemplateRows,
    fromRows: configFromPlanTemplateRows,
  });
}

function benefitFromRow(
  row: PlanTemplateRow,
  kind: BenefitKind,
): PlanTemplateBenefit {
  return {
    excluded: row[planTemplateFieldKey(kind, "excluded")] === true,
    ...optionalNumber(row, planTemplateFieldKey(kind, "allowanceDollars"), "allowanceDollars"),
    ...optionalNumber(row, planTemplateFieldKey(kind, "copayDollars"), "copayDollars"),
    ...optionalNumber(row, planTemplateFieldKey(kind, "frequencyMonths"), "frequencyMonths"),
  };
}

function optionalNumber<Field extends "allowanceDollars" | "copayDollars" | "frequencyMonths">(
  row: PlanTemplateRow,
  key: string,
  field: Field,
): Partial<Record<Field, number>> {
  const value = row[key];
  return typeof value === "number" ? { [field]: value } as Partial<Record<Field, number>> : {};
}

function fieldKeyForValidationMessage(message: string): string {
  if (message.startsWith("Plan template label")) return "label";
  for (const kind of BENEFIT_KINDS) {
    const label = planTemplateBenefitLabel(kind);
    if (message.startsWith(`${label} allowance`)) {
      return planTemplateFieldKey(kind, "allowanceDollars");
    }
    if (message.startsWith(`${label} copay`)) {
      return planTemplateFieldKey(kind, "copayDollars");
    }
    if (message.startsWith(`${label} frequency`)) {
      return planTemplateFieldKey(kind, "frequencyMonths");
    }
  }
  return "label";
}
