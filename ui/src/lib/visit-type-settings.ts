import type { HealthcareService, Resource } from "@medplum/fhirtypes";
import {
  projectedListAdapter,
  resourceCatalogAdapter,
  type CatalogAdapter,
  type SingletonConfigDraft,
} from "./catalog-adapter";
import type { FhirSearchClient } from "./fhir-search";
import {
  ODOS_DISPLAY_COLOR_EXTENSION_URL,
  ODOS_ELIGIBLE_RESOURCE_EXTENSION_URL,
  ODOS_INTAKE_FORM_EXTENSION_URL,
  ODOS_VISIT_DURATION_EXTENSION_URL,
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

export interface StagedVisitTypeAdapter extends CatalogAdapter<VisitTypeCatalogItem> {
  readonly dirty: boolean;
  commit(): Promise<void>;
  commitMatching(predicate: (operation: VisitTypeDraftOperation) => boolean): Promise<void>;
  pendingOperations(): Promise<VisitTypeDraftOperation[]>;
  discard(): void;
  reset(items: readonly VisitTypeCatalogItem[]): void;
}

export type VisitTypeDraftOperation = {
  code: string;
  item: VisitTypeCatalogItem;
  previous?: VisitTypeCatalogItem;
  deactivate: boolean;
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
    buildResource: (item) => buildVisitTypeCatalogResource(item, categories()),
    deactivateResource(item) {
      return { ...item.resource, active: false };
    },
  });
}

export function createStagedVisitTypeAdapter(
  adapter: CatalogAdapter<VisitTypeCatalogItem>,
  initialItems?: readonly VisitTypeCatalogItem[],
): StagedVisitTypeAdapter {
  let loaded = initialItems !== undefined;
  let persisted = cloneItems(initialItems ?? []);
  let draft = cloneItems(initialItems ?? []);
  let reconciliationRequired = false;

  async function ensureLoaded(): Promise<void> {
    if (loaded) return;
    persisted = cloneItems(await adapter.list());
    draft = cloneItems(persisted);
    loaded = true;
  }

  function pending(): VisitTypeDraftOperation[] {
    const persistedByCode = new Map(persisted.map((item) => [stableVisitTypeCode(item), item]));
    return draft.flatMap((item) => {
      const code = stableVisitTypeCode(item);
      const previous = persistedByCode.get(code);
      if (previous && sameVisitTypeSettings(previous, item)) return [];
      return [{
        code,
        item: cloneItem(item),
        ...(previous ? { previous: cloneItem(previous) } : {}),
        deactivate: item.active === false && previous?.active !== false,
      }];
    });
  }

  function replaceByCode(items: VisitTypeCatalogItem[], code: string, item: VisitTypeCatalogItem) {
    const index = items.findIndex((candidate) => stableVisitTypeCode(candidate) === code);
    if (index === -1) items.push(cloneItem(item));
    else items[index] = cloneItem(item);
  }

  async function reconcileAppliedWrites(): Promise<void> {
    const serverItems = await adapter.list();
    for (const desired of draft) {
      const code = stableVisitTypeCode(desired);
      const saved = serverItems.find((candidate) =>
        stableVisitTypeCode(candidate) === code && sameVisitTypeSettings(candidate, desired)
      );
      if (!saved) continue;
      replaceByCode(persisted, code, saved);
      replaceByCode(draft, code, saved);
    }
  }

  async function commitOperations(
    predicate: (operation: VisitTypeDraftOperation) => boolean,
  ): Promise<void> {
    await ensureLoaded();
    if (reconciliationRequired) {
      try {
        await reconcileAppliedWrites();
        reconciliationRequired = false;
      } catch (error) {
        throw new Error(
          `Visit type retry was stopped before any writes because the prior outcome still could not be verified. ${errorMessage(error)}`,
        );
      }
    }
    const operations = pending().filter(predicate);
    const operationCodes = new Set(operations.map((operation) => operation.code));
    const total = operations.length;
    for (const operation of operations) {
      try {
        const saved = await adapter.save(operation.item);
        replaceByCode(persisted, operation.code, saved);
        replaceByCode(draft, operation.code, saved);
      } catch (error) {
        try {
          await reconcileAppliedWrites();
        } catch {
          reconciliationRequired = true;
          const applied = total - pending().filter((candidate) => operationCodes.has(candidate.code)).length;
          throw new Error(
            `Visit type save failed after ${applied} of ${total} changes were confirmed. ` +
            `The state of "${operation.item.label}" could not be verified; reload before retrying. ${errorMessage(error)}`,
          );
        }
        const remainingOperations = pending().filter((candidate) => operationCodes.has(candidate.code));
        const remaining = remainingOperations.length;
        const applied = total - remaining;
        const failedStillPending = remainingOperations.some(
          (candidate) => candidate.code === operation.code,
        );
        const boundary = failedStillPending
          ? `"${operation.item.label}" failed; ${remaining - 1} ${remaining - 1 === 1 ? "change was" : "changes were"} not attempted.`
          : `Read-back confirmed "${operation.item.label}" was applied; ${remaining} ${remaining === 1 ? "change was" : "changes were"} not attempted.`;
        throw new Error(
          `Visit type save failed after ${applied} of ${total} changes were applied. ` +
          `${boundary} ` +
          `Re-run Save; already-applied visit types will not be written again. ${errorMessage(error)}`,
        );
      }
    }
  }

  return {
    capabilities: adapter.capabilities,
    get dirty() {
      return pending().length > 0;
    },
    async list() {
      await ensureLoaded();
      return cloneItems(draft);
    },
    async save(item) {
      await ensureLoaded();
      const code = stableVisitTypeCode(item);
      const staged = {
        ...cloneItem(item),
        id: item.id || `draft:${code}`,
        code,
      };
      replaceByCode(draft, code, staged);
      return cloneItem(staged);
    },
    async deactivate(item) {
      await ensureLoaded();
      const code = stableVisitTypeCode(item);
      const staged = { ...cloneItem(item), active: false };
      replaceByCode(draft, code, staged);
      return cloneItem(staged);
    },
    async commit() {
      await commitOperations(() => true);
    },
    async commitMatching(predicate) {
      await commitOperations(predicate);
    },
    async pendingOperations() {
      await ensureLoaded();
      return pending();
    },
    discard() {
      draft = cloneItems(persisted);
    },
    reset(items) {
      persisted = cloneItems(items);
      draft = cloneItems(items);
      reconciliationRequired = false;
      loaded = true;
    },
  };
}

export function buildVisitTypeCatalogResource(
  item: VisitTypeCatalogItem,
  categories: readonly VisitTypeCategoryRow[],
): HealthcareService {
  const code = visitTypeCode(item.resource) ?? (item.code || kebabCase(item.label));
  const category = categories.find((candidate) => candidate.id === item.categoryCode);
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
  ODOS_VISIT_DURATION_EXTENSION_URL,
  ODOS_DISPLAY_COLOR_EXTENSION_URL,
  ODOS_ELIGIBLE_RESOURCE_EXTENSION_URL,
  ODOS_INTAKE_FORM_EXTENSION_URL,
]);

function intakeFormReference(resource: HealthcareService): string | undefined {
  return resource.extension?.find(
    (extension) => extension.url === ODOS_INTAKE_FORM_EXTENSION_URL,
  )?.valueReference?.reference;
}

function stableVisitTypeCode(item: VisitTypeCatalogItem): string {
  return visitTypeCode(item.resource) ?? (item.code || kebabCase(item.label));
}

function sameVisitTypeSettings(left: VisitTypeCatalogItem, right: VisitTypeCatalogItem): boolean {
  return left.code === right.code
    && left.label === right.label
    && left.color === right.color
    && left.durationMinutes === right.durationMinutes
    && left.categoryCode === right.categoryCode
    && left.discipline === right.discipline
    && left.active === right.active;
}

function cloneItems(items: readonly VisitTypeCatalogItem[]): VisitTypeCatalogItem[] {
  return items.map(cloneItem);
}

function cloneItem(item: VisitTypeCatalogItem): VisitTypeCatalogItem {
  return JSON.parse(JSON.stringify(item)) as VisitTypeCatalogItem;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
