import type { HealthcareService, Resource } from "@medplum/fhirtypes";
import {
  projectedListAdapter,
  resourceCatalogAdapter,
  type CatalogAdapter,
  type SingletonConfigDraft,
} from "./catalog-adapter";
import type { FhirSearchClient } from "./fhir-search";
import {
  OSOD_DISPLAY_COLOR_EXTENSION_URL,
  OSOD_ELIGIBLE_RESOURCE_EXTENSION_URL,
  OSOD_INTAKE_FORM_EXTENSION_URL,
  OSOD_VISIT_DURATION_EXTENSION_URL,
  SCHEDULER_PALETTE,
  buildVisitType,
  visitTypeCategory,
  visitTypeCode,
  visitTypeColor,
  visitTypeDiscipline,
  visitTypeDurationMinutes,
  visitTypeEligibleResourceReferences,
  type SchedulingDiscipline,
} from "./scheduling";
import {
  validateVisitTypeConfig,
  type PersistedVisitTypeConfig,
  type VisitTypeCategoryConfig,
} from "./visit-type-config";

export type VisitTypeCategoryRow = {
  id: string;
  originalId?: string;
  label: string;
  order: number;
  active: boolean;
};

export type VisitTypeCatalogItem = {
  id: string;
  code: string;
  label: string;
  color: string;
  durationMinutes: number;
  categoryCode: string;
  discipline: SchedulingDiscipline;
  active: boolean;
  resource: HealthcareService;
};

type VisitTypeResourceClient = FhirSearchClient & {
  create<T extends Resource>(resource: T, sourceTag: string): Promise<T>;
  update<T extends Resource>(resource: T, sourceTag: string): Promise<T>;
};

const VISIT_TYPE_CAPABILITIES = {
  reorder: false,
  deactivate: true,
  presetSeed: true,
  groupBy: true,
} as const;

const CATEGORY_CAPABILITIES = {
  reorder: false,
  deactivate: true,
  presetSeed: true,
  groupBy: false,
} as const;

export function visitTypeCategoryRows(config: PersistedVisitTypeConfig): VisitTypeCategoryRow[] {
  return config.categories
    .map((category) => ({
      ...category,
      originalId: category.id,
      active: category.active !== false,
    }))
    .sort((a, b) => a.order - b.order);
}

export function createVisitTypeCategoryAdapter(
  draft: SingletonConfigDraft<PersistedVisitTypeConfig>,
  visitTypes: () => readonly HealthcareService[] | Promise<readonly HealthcareService[]>,
): CatalogAdapter<VisitTypeCategoryRow> {
  const base = projectedListAdapter(draft, {
    capabilities: CATEGORY_CAPABILITIES,
    toRows: visitTypeCategoryRows,
    fromRows(config, rows) {
      const categories: VisitTypeCategoryConfig[] = rows.map(
        ({ active, originalId: _originalId, ...category }) =>
          active === false ? { ...category, active: false } : category,
      );
      const next = { ...config, categories };
      validateVisitTypeConfig(next);
      return next;
    },
  });

  async function assertCanDeactivate(item: VisitTypeCategoryRow): Promise<void> {
    const assignedCount = (await visitTypes()).filter(
      (visitType) =>
        visitType.active !== false && visitTypeCategory(visitType)?.code === item.id,
    ).length;
    if (assignedCount > 0) {
      throw new Error(
        `Category "${item.label}" cannot be deactivated because ${assignedCount} active visit ${
          assignedCount === 1 ? "type is" : "types are"
        } assigned.`,
      );
    }
  }

  return {
    ...base,
    async save(item) {
      const id = item.originalId ?? (item.id || kebabCase(item.label));
      const next = { ...item, id, originalId: id };
      const existing = (await base.list()).find((candidate) => candidate.id === next.id);
      if (existing?.active && !next.active) {
        await assertCanDeactivate(next);
      }
      return base.save(next);
    },
    async deactivate(item) {
      await assertCanDeactivate(item);
      return base.deactivate(item);
    },
  };
}

export function createVisitTypeResourceAdapter(
  client: VisitTypeResourceClient,
  categories: () => readonly VisitTypeCategoryRow[],
): CatalogAdapter<VisitTypeCatalogItem> {
  return resourceCatalogAdapter<VisitTypeCatalogItem, HealthcareService>({
    resourceType: "HealthcareService",
    client,
    sourceTag: "visit-type-catalog",
    capabilities: VISIT_TYPE_CAPABILITIES,
    includeResource: (resource) => Boolean(visitTypeCode(resource)),
    toItem: visitTypeCatalogItem,
    buildResource(item) {
      const code = visitTypeCode(item.resource) ?? (item.code || kebabCase(item.label));
      const category = categories().find((candidate) => candidate.id === item.categoryCode);
      const original = item.resource;
      const built = buildVisitType({
        code,
        name: item.label,
        discipline: item.discipline,
        durationMinutes: item.durationMinutes,
        color: item.color,
        active: item.active,
        ...(category ? { categoryCode: category.id, categoryLabel: category.label } : {}),
        eligibleResourceReferences: visitTypeEligibleResourceReferences(original),
        ...(intakeFormReference(original)
          ? { intakeFormReference: intakeFormReference(original) }
          : {}),
      });
      return {
        ...original,
        ...built,
        ...(original.id ? { id: original.id } : {}),
        ...(original.meta ? { meta: original.meta } : {}),
        extension: [
          ...(built.extension ?? []),
          ...(original.extension ?? []).filter(
            (extension) => !MANAGED_EXTENSION_URLS.has(extension.url),
          ),
        ],
      };
    },
    deactivateResource(item) {
      return { ...item.resource, active: false };
    },
  });
}

export function visitTypeCatalogItem(resource: HealthcareService): VisitTypeCatalogItem {
  const discipline = visitTypeDiscipline(resource) ?? "eyecare";
  return {
    id: resource.id ?? "",
    code: visitTypeCode(resource) ?? "",
    label: resource.name ?? "",
    color:
      visitTypeColor(resource) ??
      (discipline === "aesthetics"
        ? SCHEDULER_PALETTE.aestheticsCyan
        : SCHEDULER_PALETTE.newExamBlue),
    durationMinutes: visitTypeDurationMinutes(resource) ?? 30,
    categoryCode: visitTypeCategory(resource)?.code ?? "",
    discipline,
    active: resource.active !== false,
    resource,
  };
}

export function kebabCase(label: string): string {
  const id = label
    .trim()
    .toLocaleLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  if (!id) {
    throw new Error("Catalog label must contain letters or numbers before an id can be generated.");
  }
  return id;
}

const MANAGED_EXTENSION_URLS = new Set([
  OSOD_VISIT_DURATION_EXTENSION_URL,
  OSOD_DISPLAY_COLOR_EXTENSION_URL,
  OSOD_ELIGIBLE_RESOURCE_EXTENSION_URL,
  OSOD_INTAKE_FORM_EXTENSION_URL,
]);

function intakeFormReference(resource: HealthcareService): string | undefined {
  return resource.extension?.find(
    (extension) => extension.url === OSOD_INTAKE_FORM_EXTENSION_URL,
  )?.valueReference?.reference;
}
