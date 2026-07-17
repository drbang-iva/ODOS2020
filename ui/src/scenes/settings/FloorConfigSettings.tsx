import type { Appointment, Basic, Bundle, Resource } from "@medplum/fhirtypes";
import { useEffect, useMemo, useState } from "react";
import { CatalogFieldValidationError } from "../../lib/catalog-field-kernel";
import { createSingletonConfigDraft } from "../../lib/catalog-adapter";
import { fhir } from "../../lib/fhir";
import {
  buildFloorConfigResource,
  parseFloorConfig,
  type PersistedFloorConfig,
} from "../../lib/floor-config";
import {
  configFromFloorStationRows,
  createFloorConfigAdapters,
  floorStationRows,
  type FloorStationRow,
  type HousePlanLabelRow,
  type PayerMapRow,
} from "../../lib/floor-config-settings";
import { DEFAULT_FLOOR_BOARD_CONFIG } from "../../lib/floor-board";
import { parseFloorState } from "../../lib/floor-state";
import { useRole } from "../../lib/role-context";
import {
  loadFloorConfigSingleton,
  publishFloorBoardConfig,
} from "../frontdesk/useFloorBoardConfig";
import {
  CatalogScene,
  CatalogSection,
  type CatalogDescriptor,
} from "./CatalogEditor";

type FloorSettingsClient = {
  create<T extends Basic>(resource: T, sourceTag: string): Promise<T>;
  update<T extends Basic>(resource: T, sourceTag: string): Promise<T>;
};

type AppointmentReader = {
  search<T extends Resource>(
    resourceType: T["resourceType"],
    params?: URLSearchParams,
  ): Promise<Bundle<T>>;
  searchUrl<T extends Resource>(url: string): Promise<Bundle<T>>;
};

type LoadedFloorSettings = {
  resource?: Basic;
  config: PersistedFloorConfig;
  onBoardStationIds: ReadonlySet<string>;
};

export function FloorConfigSettings() {
  const { role } = useRole();
  const [loaded, setLoaded] = useState<LoadedFloorSettings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const canWrite = role === "practice-admin" || role === "front-desk";

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const [floorConfig, onBoardStationIds] = await Promise.all([
          loadFloorConfigSingleton(),
          loadOnBoardStationIds(fhir),
        ]);
        if (cancelled) return;
        setLoaded({ ...floorConfig, onBoardStationIds });
        setError(null);
      } catch (loadError) {
        if (!cancelled) setError(loadError instanceof Error ? loadError.message : String(loadError));
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, []);

  if (error) {
    return (
      <main className="min-h-screen bg-[#060610] p-6 text-white">
        <div role="alert" className="mx-auto max-w-5xl border border-red-400/40 bg-red-950/50 px-4 py-3 text-sm text-red-100">
          Floor config could not be loaded: {error}
        </div>
      </main>
    );
  }

  if (!loaded) {
    return (
      <main className="min-h-screen bg-[#060610] p-6 text-white">
        <div className="mx-auto max-w-5xl">
          <div className="text-xs uppercase tracking-wide text-white/45">Practice Settings</div>
          <h1 className="text-2xl font-semibold">Floor config</h1>
          <div className="mt-5 text-sm text-white/55">Loading floor config…</div>
        </div>
      </main>
    );
  }

  return (
    <FloorConfigSettingsReady
      {...loaded}
      canWrite={canWrite}
      client={fhir}
    />
  );
}

export async function loadOnBoardStationIds(client: AppointmentReader): Promise<ReadonlySet<string>> {
  let bundle = await client.search<Appointment>(
    "Appointment",
    new URLSearchParams([
      ["status", "arrived,checked-in"],
      ["_count", "200"],
    ]),
  );
  const stationIds = new Set<string>();
  for (;;) {
    for (const entry of bundle.entry ?? []) {
      const station = entry.resource && parseFloorState(entry.resource)?.station;
      if (station) stationIds.add(station);
    }
    const next = bundle.link?.find((link) => link.relation === "next")?.url;
    if (!next) return stationIds;
    bundle = await client.searchUrl<Appointment>(next);
  }
}

export function FloorConfigSettingsReady({
  resource,
  config,
  onBoardStationIds,
  canWrite,
  client,
}: LoadedFloorSettings & {
  canWrite: boolean;
  client: FloorSettingsClient;
}) {
  const draft = useMemo(
    () =>
      createSingletonConfigDraft({
        configKey: "odos-floor-config",
        config,
        resource,
        buildResource: buildFloorConfigResource,
        sourceTag: "floor-config",
        fhirClient: client,
      }),
    [client, config, resource],
  );
  const adapters = useMemo(
    () => createFloorConfigAdapters(draft, onBoardStationIds),
    [draft, onBoardStationIds],
  );

  const stationDescriptor = useMemo<CatalogDescriptor<FloorStationRow>>(
    () => ({
      title: "Stations",
      singularLabel: "station",
      adapter: adapters.stations,
      fields: [
        { type: "text", key: "label", label: "Station label", required: true, unique: true },
        { type: "number", key: "amberMinutes", label: "Amber minutes", required: true },
        { type: "number", key: "redMinutes", label: "Red minutes", required: true },
        { type: "toggle", key: "active", label: "Active" },
      ],
      createItem: () => ({
        id: newRowId("station"),
        label: "",
        order: floorStationRows(draft.current()).length,
        active: true,
        amberMinutes: draft.current().defaultThreshold.amberMinutes,
        redMinutes: draft.current().defaultThreshold.redMinutes,
      }),
      validateItem(item, items) {
        const nextRows = replaceRow(items, item);
        try {
          configFromFloorStationRows(draft.current(), nextRows, onBoardStationIds);
        } catch (validationError) {
          const message = validationError instanceof Error ? validationError.message : String(validationError);
          const fieldKey = message.includes("cannot be deactivated")
            ? "active"
            : message.includes("amberMinutes")
              ? "amberMinutes"
              : "redMinutes";
          throw new CatalogFieldValidationError(fieldKey, message);
        }
      },
      label: (item) => item.label,
      facts: (item) => [`${item.amberMinutes}/${item.redMinutes} min`],
    }),
    [adapters.stations, draft, onBoardStationIds],
  );

  const payerDescriptor = useMemo<CatalogDescriptor<PayerMapRow>>(
    () => ({
      title: "Payer map",
      singularLabel: "payer mapping",
      adapter: adapters.payerMap,
      fields: [
        {
          type: "reference-picker",
          key: "payer",
          label: "Payer name",
          required: true,
          valueKind: "text",
          search: async (query) => payerSuggestions(query, draft.current()),
        },
        {
          type: "select",
          key: "cue",
          label: "Cue class",
          required: true,
          options: [
            { value: "house", label: "House" },
            { value: "vision", label: "Vision" },
            { value: "none", label: "None" },
          ],
        },
      ],
      createItem: () => ({ id: newRowId("payer"), payer: "", cue: "none", active: true }),
      validateItem(item, items) {
        const normalized = item.payer.trim().toLocaleLowerCase();
        if (
          items.some(
            (candidate) =>
              candidate.id !== item.id &&
              candidate.payer.trim().toLocaleLowerCase() === normalized,
          )
        ) {
          throw new CatalogFieldValidationError(
            "payer",
            "Payer name must be unique within this catalog.",
          );
        }
      },
      label: (item) => item.payer || "New payer mapping",
      facts: (item) => [item.cue === "none" ? "Removed on save" : item.cue],
    }),
    [adapters.payerMap, draft],
  );

  const housePlanDescriptor = useMemo<CatalogDescriptor<HousePlanLabelRow>>(
    () => ({
      title: "House-plan label",
      singularLabel: "house-plan label",
      adapter: adapters.housePlanLabel,
      fields: [{ type: "text", key: "label", label: "House-plan label" }],
      createItem: () => ({ id: "house-plan-label", label: "", active: true }),
      canCreate: false,
      label: (item) => item.label || "House plan label",
      facts: () => ["Displayed on house-plan payer cues"],
    }),
    [adapters.housePlanLabel],
  );

  return (
    <CatalogScene
      title="Floor config"
      canWrite={canWrite}
      transaction={draft}
      onCommitted={(saved) => publishFloorBoardConfig(parseFloorConfig(saved), saved)}
    >
      <CatalogSection descriptor={stationDescriptor} canWrite={canWrite} />
      <CatalogSection descriptor={payerDescriptor} canWrite={canWrite} />
      <CatalogSection descriptor={housePlanDescriptor} canWrite={canWrite} />
    </CatalogScene>
  );
}

function replaceRow<Item extends { id: string }>(items: Item[], item: Item): Item[] {
  const index = items.findIndex((candidate) => candidate.id === item.id);
  return index === -1
    ? [...items, item]
    : items.map((candidate) => (candidate.id === item.id ? item : candidate));
}

function payerSuggestions(query: string, config: PersistedFloorConfig) {
  const value = query.trim();
  const known = new Set([...Object.keys(DEFAULT_FLOOR_BOARD_CONFIG.payerMap), ...Object.keys(config.payerMap)]);
  const matches = [...known]
    .filter((payer) => payer.toLocaleLowerCase().includes(value.toLocaleLowerCase()))
    .map((payer) => ({ reference: payer, display: payer }));
  if (value && !known.has(value)) matches.push({ reference: value, display: `Use “${value}”` });
  return matches;
}

function newRowId(prefix: string): string {
  return `${prefix}-${globalThis.crypto?.randomUUID?.() ?? Date.now().toString(36)}`;
}
