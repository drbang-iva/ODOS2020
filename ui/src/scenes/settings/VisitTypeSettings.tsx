import type { Basic, HealthcareService } from "@medplum/fhirtypes";
import { useEffect, useMemo, useState } from "react";
import {
  createSingletonConfigDraft,
  type CatalogAdapter,
} from "../../lib/catalog-adapter";
import { CatalogFieldValidationError } from "../../lib/catalog-field-kernel";
import { CATALOG_COLOR_PALETTE } from "../../components/settings/CatalogFields";
import { fhir } from "../../lib/fhir";
import { searchAll } from "../../lib/fhir-search";
import {
  SCHEDULER_PALETTE,
  SCHEDULING_DISCIPLINES,
  defaultVisitTypeCatalog,
} from "../../lib/scheduling";
import {
  createVisitTypeCategoryAdapter,
  createVisitTypeResourceAdapter,
  visitTypeCatalogItem,
  visitTypeCategoryRows,
  type VisitTypeCatalogItem,
  type VisitTypeCategoryRow,
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

type VisitTypeEditorItem = Omit<VisitTypeCatalogItem, "durationMinutes"> & {
  durationMinutes: string;
  legacyDurationMinutes?: number;
};

const VISIT_TYPE_DURATION_OPTIONS = [60, 45, 30, 20, 15, 10] as const;

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
  const visitTypeAdapter = useMemo(
    () => createVisitTypeEditorAdapter(visitTypeResourceAdapter),
    [visitTypeResourceAdapter],
  );
  const categoryAdapter = useMemo(
    () =>
      createVisitTypeCategoryAdapter(
        draft,
        async () => (await visitTypeAdapter.list()).map((item) => item.resource),
      ),
    [draft, visitTypeAdapter],
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
      await visitTypeAdapter.save(visitTypeEditorItem(visitTypeCatalogItem(resource)));
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
      transaction: draft,
    }),
    [categoryAdapter, catalogRevision, draft],
  );

  const visitTypeDescriptor = useMemo<CatalogDescriptor<VisitTypeEditorItem>>(
    () => ({
      title: "Visit types",
      singularLabel: "visit type",
      adapter: visitTypeAdapter,
      immediateCommit: true,
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
          type: "select",
          key: "durationMinutes",
          label: "Duration (minutes)",
          required: true,
          options: VISIT_TYPE_DURATION_OPTIONS.map((minutes) => ({
            value: String(minutes),
            label: String(minutes),
          })),
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
        visitTypeEditorItem(visitTypeCatalogItem({
          resourceType: "HealthcareService",
          active: true,
          name: "",
          category: [],
          extension: [
            { url: "https://odos2020.com/fhir/StructureDefinition/odos-visit-duration", valuePositiveInt: 30 },
            { url: "https://odos2020.com/fhir/StructureDefinition/odos-display-color", valueString: SCHEDULER_PALETTE.newExamBlue },
          ],
        })),
      label: (item) => item.label,
      color: (item) => item.color,
      facts: (item) => [
        `${item.durationMinutes || item.legacyDurationMinutes} min`,
        categoryById.get(item.categoryCode)?.label ?? "Uncategorized",
      ],
      chips: (item) => [
        SCHEDULING_DISCIPLINES.find((discipline) => discipline.code === item.discipline)?.display ??
          item.discipline,
      ],
      readOnlyFacts: (item) => [
        ...(item.code ? [{ label: "Code", value: item.code }] : []),
        ...(item.legacyDurationMinutes === undefined
          ? []
          : [{
              label: "Current custom duration",
              value: `${item.legacyDurationMinutes} min`,
            }]),
      ],
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
      transaction={draft}
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
                items: initialVisitTypes.map((resource) =>
                  visitTypeEditorItem(visitTypeCatalogItem(resource))
                ),
                selectedId: initialSelectedVisitTypeId,
              }
            : undefined
        }
      />
    </CatalogScene>
  );
}

function createVisitTypeEditorAdapter(
  adapter: CatalogAdapter<VisitTypeCatalogItem>,
): CatalogAdapter<VisitTypeEditorItem> {
  return {
    capabilities: adapter.capabilities,
    async list() {
      return (await adapter.list()).map(visitTypeEditorItem);
    },
    async save(item) {
      return visitTypeEditorItem(await adapter.save(persistedVisitTypeItem(item)));
    },
    async deactivate(item) {
      return visitTypeEditorItem(await adapter.deactivate(persistedVisitTypeItem(item)));
    },
    ...(adapter.reorder
      ? { reorder: (ids: string[]) => adapter.reorder!(ids) }
      : {}),
  };
}

function visitTypeEditorItem(item: VisitTypeCatalogItem): VisitTypeEditorItem {
  const listed = VISIT_TYPE_DURATION_OPTIONS.includes(
    item.durationMinutes as (typeof VISIT_TYPE_DURATION_OPTIONS)[number],
  );
  return {
    ...item,
    durationMinutes: listed ? String(item.durationMinutes) : "",
    ...(listed ? {} : { legacyDurationMinutes: item.durationMinutes }),
  };
}

function persistedVisitTypeItem(item: VisitTypeEditorItem): VisitTypeCatalogItem {
  const { durationMinutes, legacyDurationMinutes, ...rest } = item;
  const selectedDuration = Number(durationMinutes);
  const listed = VISIT_TYPE_DURATION_OPTIONS.includes(
    selectedDuration as (typeof VISIT_TYPE_DURATION_OPTIONS)[number],
  );
  if (!listed) {
    throw new CatalogFieldValidationError(
      "durationMinutes",
      legacyDurationMinutes === undefined
        ? "Duration (minutes) must be a listed option."
        : `Choose a listed duration before changing this ${legacyDurationMinutes}-minute visit type.`,
    );
  }
  return {
    ...rest,
    durationMinutes: selectedDuration,
  };
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
