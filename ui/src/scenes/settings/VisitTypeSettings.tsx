import type { Basic, HealthcareService } from "@medplum/fhirtypes";
import { useEffect, useMemo, useState } from "react";
import {
  createSingletonConfigDraft,
  type CatalogAdapter,
  type CatalogDraftTransaction,
} from "../../lib/catalog-adapter";
import { CatalogFieldValidationError } from "../../lib/catalog-field-kernel";
import { CATALOG_COLOR_PALETTE } from "../../components/settings/CatalogFields";
import { fhir } from "../../lib/fhir";
import { searchAll } from "../../lib/fhir-search";
import {
  MAX_VISIT_DURATION_MINUTES,
  SCHEDULER_PALETTE,
  SCHEDULING_DISCIPLINES,
  VISIT_DURATION_PRESETS,
  defaultVisitTypeCatalog,
} from "../../lib/scheduling";
import {
  createVisitTypeCategoryAdapter,
  createVisitTypeResourceAdapter,
  createStagedVisitTypeAdapter,
  buildVisitTypeCatalogResource,
  visitTypeCatalogItem,
  visitTypeCategoryRows,
  type VisitTypeCatalogItem,
  type VisitTypeCategoryRow,
  type VisitTypeDraftOperation,
} from "../../lib/visit-type-settings";
import {
  DEFAULT_VISIT_TYPE_CATEGORIES,
  ODOS_VISIT_TYPE_CONFIG_CODE,
  ODOS_VISIT_TYPE_CONFIG_SYSTEM,
  buildVisitTypeConfigResource,
  parseVisitTypeConfig,
  type PersistedVisitTypeConfig,
} from "../../lib/visit-type-config";
import {
  CatalogScene,
  CatalogSection,
  type CatalogDescriptor,
} from "./CatalogEditor";

type LoadedVisitTypeSettings = {
  config: PersistedVisitTypeConfig;
  configResource?: Basic;
};

export type VisitTypeSettingsClient = Pick<
  typeof fhir,
  "search" | "searchUrl" | "create" | "update"
>;

export function VisitTypeSettings({ canWrite }: { canWrite: boolean }) {
  const [loaded, setLoaded] = useState<LoadedVisitTypeSettings | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    loadVisitTypeConfigSingleton(fhir)
      .then((result) => {
        if (!cancelled) setLoaded(result);
      })
      .catch((loadError: unknown) => {
        if (!cancelled) setError(errorMessage(loadError));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (error) {
    return <SettingsState message={`Visit types could not be loaded: ${error}`} alert />;
  }
  if (!loaded) {
    return <SettingsState message="Loading visit types…" />;
  }
  return (
    <VisitTypeSettingsReady
      {...loaded}
      canWrite={canWrite}
      client={fhir}
    />
  );
}

export async function loadVisitTypeConfigSingleton(
  client: Pick<typeof fhir, "search" | "searchUrl">,
): Promise<LoadedVisitTypeSettings> {
  const resources = await searchAll<Basic>(client, "Basic", {
    code: `${ODOS_VISIT_TYPE_CONFIG_SYSTEM}|${ODOS_VISIT_TYPE_CONFIG_CODE}`,
    _count: "10",
  });
  const resource = [...resources].sort((a, b) => lastUpdatedMs(b) - lastUpdatedMs(a))[0];
  return {
    config: resource ? parseVisitTypeConfig(resource) : { categories: [] },
    ...(resource ? { configResource: resource } : {}),
  };
}

export function VisitTypeSettingsReady({
  config,
  configResource,
  canWrite,
  client,
  initialVisitTypes,
  initialSelectedCategoryId,
  initialSelectedVisitTypeId,
}: LoadedVisitTypeSettings & {
  canWrite: boolean;
  client: VisitTypeSettingsClient;
  initialVisitTypes?: HealthcareService[];
  initialSelectedCategoryId?: string;
  initialSelectedVisitTypeId?: string;
}) {
  const [catalogRevision, setCatalogRevision] = useState(0);
  const draft = useMemo(
    () =>
      createSingletonConfigDraft({
        configKey: ODOS_VISIT_TYPE_CONFIG_CODE,
        config,
        resource: configResource,
        buildResource: buildVisitTypeConfigResource,
        sourceTag: "visit-type-config",
        fhirClient: client,
      }),
    [client, config, configResource],
  );
  const visitTypeResourceAdapter = useMemo(
    () => createVisitTypeResourceAdapter(client, () => visitTypeCategoryRows(draft.current())),
    [client, draft],
  );
  const stagedVisitTypeAdapter = useMemo(
    () => createStagedVisitTypeAdapter(
      visitTypeResourceAdapter,
      initialVisitTypes?.map(visitTypeCatalogItem),
    ),
    [initialVisitTypes, visitTypeResourceAdapter],
  );
  const visitTypeAdapter = useMemo(
    () => createVisitTypeEditorAdapter(stagedVisitTypeAdapter),
    [stagedVisitTypeAdapter],
  );
  const categoryAdapter = useMemo(
    () =>
      createVisitTypeCategoryAdapter(
        draft,
        async () => {
          const categories = visitTypeCategoryRows(draft.current());
          return (await stagedVisitTypeAdapter.list()).map((item) =>
            buildVisitTypeCatalogResource(item, categories)
          );
        },
      ),
    [draft, stagedVisitTypeAdapter],
  );
  const transaction = useMemo(
    () => createVisitTypeSettingsTransaction(
      draft,
      stagedVisitTypeAdapter,
      async () => {
        const [authoritativeConfig, authoritativeVisitTypes] = await Promise.all([
          loadVisitTypeConfigSingleton(client),
          visitTypeResourceAdapter.list(),
        ]);
        return { ...authoritativeConfig, visitTypes: authoritativeVisitTypes };
      },
    ),
    [client, draft, stagedVisitTypeAdapter, visitTypeResourceAdapter],
  );

  const categories = visitTypeCategoryRows(draft.current());
  const activeCategories = categories.filter((category) => category.active);
  const categoryById = new Map(categories.map((category) => [category.id, category]));
  const categoryOrder = new Map(categories.map((category) => [category.label, category.order]));

  async function seedCategories() {
    for (const category of DEFAULT_VISIT_TYPE_CATEGORIES) {
      await categoryAdapter.save({ ...category, active: category.active !== false });
    }
    setCatalogRevision((current) => current + 1);
  }

  async function seedVisitTypes() {
    for (const resource of defaultVisitTypeCatalog("both")) {
      await visitTypeAdapter.save(visitTypeCatalogItem(resource));
    }
    setCatalogRevision((current) => current + 1);
  }

  const categoryDescriptor = useMemo<CatalogDescriptor<VisitTypeCategoryRow>>(
    () => ({
      title: "Categories",
      singularLabel: "category",
      adapter: categoryAdapter,
      fields: [
        { type: "text", key: "label", label: "Label", required: true, unique: true },
        { type: "toggle", key: "active", label: "Active", required: true },
      ],
      createItem: () => ({
        id: "",
        label: "",
        order: Math.max(-1, ...visitTypeCategoryRows(draft.current()).map((item) => item.order)) + 1,
        active: true,
      }),
      label: (item) => item.label,
      facts: (item) => [item.id],
      presetSeedOffer: (
        <button className="scheduler-button" type="button" onClick={() => void seedCategories()}>
          Use starter categories
        </button>
      ),
    }),
    [categoryAdapter, catalogRevision, draft],
  );

  const visitTypeDescriptor = useMemo<CatalogDescriptor<VisitTypeCatalogItem>>(
    () => ({
      title: "Visit types",
      singularLabel: "visit type",
      adapter: visitTypeAdapter,
      fields: [
        { type: "text", key: "label", label: "Label", required: true, unique: true },
        {
          type: "color",
          key: "color",
          label: "Color",
          required: true,
          palette: CATALOG_COLOR_PALETTE,
        },
        {
          type: "duration",
          key: "durationMinutes",
          label: "Duration (minutes)",
          required: true,
          min: 1,
          max: MAX_VISIT_DURATION_MINUTES,
          presets: VISIT_DURATION_PRESETS,
        },
        {
          type: "select",
          key: "categoryCode",
          label: "Category",
          options: activeCategories.map((category) => ({
            value: category.id,
            label: category.label,
          })),
        },
        { type: "toggle", key: "active", label: "Active", required: true },
        {
          type: "select",
          key: "discipline",
          label: "Discipline",
          required: true,
          options: SCHEDULING_DISCIPLINES.map((discipline) => ({
            value: discipline.code,
            label: discipline.display,
          })),
        },
      ],
      createItem: () =>
        visitTypeCatalogItem({
          resourceType: "HealthcareService",
          active: true,
          name: "",
          category: [],
          extension: [
            { url: "https://odos2020.com/fhir/StructureDefinition/odos-visit-duration", valuePositiveInt: 30 },
            { url: "https://odos2020.com/fhir/StructureDefinition/odos-display-color", valueString: SCHEDULER_PALETTE.newExamBlue },
          ],
        }),
      label: (item) => item.label,
      color: (item) => item.color,
      facts: (item) => [
        `${item.durationMinutes} min`,
        categoryById.get(item.categoryCode)?.label ?? "Uncategorized",
      ],
      chips: (item) => [
        SCHEDULING_DISCIPLINES.find((discipline) => discipline.code === item.discipline)?.display ??
          item.discipline,
      ],
      readOnlyFacts: (item) => (item.code ? [{ label: "Code", value: item.code }] : []),
      groupBy: {
        label: "Category",
        value: (item) => categoryById.get(item.categoryCode)?.label ?? "Uncategorized",
        order: (group) =>
          group === "Uncategorized" ? Number.MAX_SAFE_INTEGER : categoryOrder.get(group) ?? Number.MAX_SAFE_INTEGER - 1,
      },
      presetSeedOffer: (
        <button className="scheduler-button" type="button" onClick={() => void seedVisitTypes()}>
          Use starter visit types
        </button>
      ),
    }),
    [activeCategories, catalogRevision, categoryById, categoryOrder, visitTypeAdapter],
  );

  return (
    <CatalogScene
      title="Visit types"
      canWrite={canWrite}
      transaction={transaction}
      onChanged={() => setCatalogRevision((current) => current + 1)}
    >
      <CatalogSection
        descriptor={categoryDescriptor}
        canWrite={canWrite}
        initialState={{ items: categories, selectedId: initialSelectedCategoryId }}
      />
      <CatalogSection
        descriptor={visitTypeDescriptor}
        canWrite={canWrite}
        initialState={
          initialVisitTypes
            ? {
                items: initialVisitTypes.map(visitTypeCatalogItem),
                selectedId: initialSelectedVisitTypeId,
              }
            : undefined
        }
      />
    </CatalogScene>
  );
}

export function createVisitTypeSettingsTransaction(
  categoryDraft: ReturnType<typeof createSingletonConfigDraft<PersistedVisitTypeConfig>>,
  visitTypeDraft: ReturnType<typeof createStagedVisitTypeAdapter>,
  reloadAuthoritative?: () => Promise<LoadedVisitTypeSettings & { visitTypes: VisitTypeCatalogItem[] }>,
): CatalogDraftTransaction {
  let authoritativeReloadRequired = false;

  return {
    get dirty() {
      return authoritativeReloadRequired || categoryDraft.dirty || visitTypeDraft.dirty;
    },
    async commit() {
      if (authoritativeReloadRequired) {
        if (!reloadAuthoritative) {
          throw new Error("Authoritative server reload is required before this save can be retried.");
        }
        let authoritative: Awaited<ReturnType<NonNullable<typeof reloadAuthoritative>>>;
        try {
          authoritative = await reloadAuthoritative();
        } catch (error) {
          throw new Error(
            `Settings retry was stopped before any writes because authoritative state could not be reloaded. ${errorMessage(error)}`,
          );
        }
        categoryDraft.reconcile(authoritative.config, authoritative.configResource);
        visitTypeDraft.reconcile(authoritative.visitTypes);
        authoritativeReloadRequired = false;
      }
      assertActiveVisitTypesUseActiveCategories(
        await visitTypeDraft.list(),
        visitTypeCategoryRows(categoryDraft.current()),
      );
      let savedCategory: Basic | undefined;
      const deactivatedCategoryIds = categoriesChangingToInactive(
        categoryDraft.baseline(),
        categoryDraft.current(),
      );
      const pendingVisitTypes = await visitTypeDraft.pendingOperations();
      const preCategoryVisitTypeCodes = new Set(
        pendingVisitTypes
          .filter((operation) => visitTypeMustCommitBeforeCategory(operation, deactivatedCategoryIds))
          .map((operation) => operation.code),
      );
      if (preCategoryVisitTypeCodes.size > 0) {
        try {
          await visitTypeDraft.commitMatching((operation) => preCategoryVisitTypeCodes.has(operation.code));
        } catch (error) {
          authoritativeReloadRequired = true;
          throw new Error(
            `Visit type changes required before category deactivation were not completed. ` +
            `Category settings were not saved. ${errorMessage(error)}`,
          );
        }
      }
      if (categoryDraft.dirty) {
        try {
          savedCategory = await categoryDraft.commit();
        } catch (error) {
          authoritativeReloadRequired = true;
          throw new Error(
            `${preCategoryVisitTypeCodes.size > 0
              ? "Required visit type changes were saved. Category settings were not saved. Remaining visit type changes were not attempted."
              : "Category settings were not saved. Visit type changes were not attempted."} ${errorMessage(error)}`,
          );
        }
      }
      try {
        await visitTypeDraft.commit();
      } catch (error) {
        authoritativeReloadRequired = true;
        throw new Error(
          `${savedCategory ? "Category settings saved. " : ""}${errorMessage(error)}`,
        );
      }
      authoritativeReloadRequired = false;
      return savedCategory;
    },
    async discard() {
      if (authoritativeReloadRequired) {
        if (!reloadAuthoritative) {
          throw new Error("Authoritative server reload is required before this draft can be discarded.");
        }
        const authoritative = await reloadAuthoritative();
        categoryDraft.reset(authoritative.config, authoritative.configResource);
        visitTypeDraft.reset(authoritative.visitTypes);
        authoritativeReloadRequired = false;
        return "Draft cleared and server state reloaded. Changes applied before the failure remain saved.";
      }
      categoryDraft.discard();
      visitTypeDraft.discard();
    },
  };
}

function assertActiveVisitTypesUseActiveCategories(
  visitTypes: readonly VisitTypeCatalogItem[],
  categories: readonly VisitTypeCategoryRow[],
): void {
  const categoryById = new Map(categories.map((category) => [category.id, category]));
  const invalid = visitTypes.find((visitType) =>
    visitType.active && categoryById.get(visitType.categoryCode)?.active === false
  );
  if (!invalid) return;
  const category = categoryById.get(invalid.categoryCode)!;
  throw new Error(
    `Visit type "${invalid.label}" cannot be active because category "${category.label}" is inactive. ` +
    `Save was stopped before any writes.`,
  );
}

function categoriesChangingToInactive(
  baseline: PersistedVisitTypeConfig,
  current: PersistedVisitTypeConfig,
): Set<string> {
  const currentById = new Map(current.categories.map((category) => [category.id, category]));
  return new Set(
    baseline.categories
      .filter((category) => category.active !== false)
      .filter((category) => currentById.get(category.id)?.active === false || !currentById.has(category.id))
      .map((category) => category.id),
  );
}

function visitTypeMustCommitBeforeCategory(
  operation: VisitTypeDraftOperation,
  deactivatedCategoryIds: ReadonlySet<string>,
): boolean {
  const previousCategory = operation.previous?.categoryCode;
  return operation.previous?.active !== false
    && Boolean(previousCategory && deactivatedCategoryIds.has(previousCategory))
    && (operation.item.active === false || operation.item.categoryCode !== previousCategory);
}

function createVisitTypeEditorAdapter(
  adapter: CatalogAdapter<VisitTypeCatalogItem>,
): CatalogAdapter<VisitTypeCatalogItem> {
  return {
    capabilities: adapter.capabilities,
    async list() {
      return adapter.list();
    },
    async save(item) {
      return adapter.save(persistedVisitTypeItem(item));
    },
    async deactivate(item) {
      return adapter.deactivate(persistedVisitTypeItem(item));
    },
    ...(adapter.reorder
      ? { reorder: (ids: string[]) => adapter.reorder!(ids) }
      : {}),
  };
}

function persistedVisitTypeItem(item: VisitTypeCatalogItem): VisitTypeCatalogItem {
  if (!Number.isInteger(item.durationMinutes) || item.durationMinutes < 1) {
    throw new CatalogFieldValidationError(
      "durationMinutes",
      "Duration (minutes) must be a positive whole number.",
    );
  }
  if (item.durationMinutes > MAX_VISIT_DURATION_MINUTES) {
    throw new CatalogFieldValidationError(
      "durationMinutes",
      `Duration (minutes) must be at most ${MAX_VISIT_DURATION_MINUTES}.`,
    );
  }
  return item;
}

function SettingsState({ message, alert = false }: { message: string; alert?: boolean }) {
  return (
    <main className="min-h-screen bg-[#060610] p-6 text-white">
      <div className="mx-auto max-w-5xl">
        <div className="text-xs uppercase tracking-wide text-white/45">Practice Settings</div>
        <h1 className="text-2xl font-semibold">Visit types</h1>
        <div
          {...(alert ? { role: "alert" } : {})}
          className={`mt-5 text-sm ${alert ? "text-red-200" : "text-white/55"}`}
        >
          {message}
        </div>
      </div>
    </main>
  );
}

function lastUpdatedMs(resource: Basic): number {
  return resource.meta?.lastUpdated ? Date.parse(resource.meta.lastUpdated) || 0 : 0;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
