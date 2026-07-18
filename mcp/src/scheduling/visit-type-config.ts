import type { Basic } from "@medplum/fhirtypes";

export const ODOS_VISIT_TYPE_CONFIG_SYSTEM =
  "https://odos2020.com/fhir/CodeSystem/visit-type-config";
export const ODOS_VISIT_TYPE_CONFIG_CODE = "odos-visit-type-config";
export const ODOS_VISIT_TYPE_CONFIG_EXTENSION_URL =
  "https://odos2020.com/fhir/StructureDefinition/odos-visit-type-config";

export interface VisitTypeCategoryConfig {
  id: string;
  label: string;
  order: number;
  active?: boolean;
}

export interface PersistedVisitTypeConfig {
  categories: VisitTypeCategoryConfig[];
}

export const DEFAULT_VISIT_TYPE_CATEGORIES: VisitTypeCategoryConfig[] = [
  { id: "comprehensive", label: "Comprehensive", order: 0 },
  { id: "dry-eye", label: "Dry Eye", order: 1 },
  { id: "myopia-management", label: "Myopia Management", order: 2 },
  { id: "diagnostic-only", label: "Diagnostic-Only", order: 3 },
];

const KEBAB_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function validateVisitTypeConfig(config: PersistedVisitTypeConfig): void {
  if (!Array.isArray(config.categories)) {
    throw new Error("Visit-type config categories must be a list.");
  }
  const ids = new Set<string>();
  const labels = new Set<string>();
  for (const category of config.categories) {
    if (!KEBAB_ID.test(category.id)) {
      throw new Error(`Visit-type category id "${category.id}" must be immutable kebab-case.`);
    }
    if (ids.has(category.id)) {
      throw new Error(`Visit-type category id "${category.id}" must be unique.`);
    }
    ids.add(category.id);
    const label = category.label.trim();
    if (!label) {
      throw new Error("Visit-type category label is required.");
    }
    const normalizedLabel = label.toLocaleLowerCase();
    if (labels.has(normalizedLabel)) {
      throw new Error(`Visit-type category label "${label}" must be unique.`);
    }
    labels.add(normalizedLabel);
    if (!Number.isInteger(category.order) || category.order < 0) {
      throw new Error(`Visit-type category "${category.id}" order must be a non-negative integer.`);
    }
  }
}

export function buildVisitTypeConfigResource(
  config: PersistedVisitTypeConfig,
  existing?: Basic,
): Basic {
  validateVisitTypeConfig(config);
  const persisted: PersistedVisitTypeConfig = {
    categories: config.categories.map(({ active, ...category }) =>
      active === false ? { ...category, active: false } : category,
    ),
  };
  return {
    resourceType: "Basic",
    ...(existing?.id ? { id: existing.id } : {}),
    ...(existing?.meta ? { meta: existing.meta } : {}),
    code: {
      coding: [
        {
          system: ODOS_VISIT_TYPE_CONFIG_SYSTEM,
          code: ODOS_VISIT_TYPE_CONFIG_CODE,
          display: "ODOS Visit Type Config",
        },
      ],
      text: "ODOS Visit Type Config",
    },
    extension: [
      {
        url: ODOS_VISIT_TYPE_CONFIG_EXTENSION_URL,
        valueString: JSON.stringify(persisted),
      },
    ],
  };
}

export function parseVisitTypeConfig(basic: Basic): PersistedVisitTypeConfig {
  const coding = basic.code?.coding?.find(
    (candidate) =>
      candidate.system === ODOS_VISIT_TYPE_CONFIG_SYSTEM &&
      candidate.code === ODOS_VISIT_TYPE_CONFIG_CODE,
  );
  if (!coding) {
    throw new Error("Basic resource is not the odos visit-type-config singleton.");
  }
  const raw = basic.extension?.find(
    (extension) => extension.url === ODOS_VISIT_TYPE_CONFIG_EXTENSION_URL,
  )?.valueString;
  if (!raw) {
    throw new Error("Visit-type-config singleton is missing its config extension.");
  }
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    throw new Error("Visit-type-config JSON is malformed and cannot be parsed.");
  }
  const config: PersistedVisitTypeConfig = {
    categories: (parsed.categories ?? []) as VisitTypeCategoryConfig[],
  };
  validateVisitTypeConfig(config);
  return config;
}
