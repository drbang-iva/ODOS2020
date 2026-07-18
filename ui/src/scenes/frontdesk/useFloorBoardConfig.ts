import type { Basic, Bundle } from "@medplum/fhirtypes";
import { useEffect, useSyncExternalStore } from "react";
import { fhir } from "../../lib/fhir";
import {
  DEFAULT_FLOOR_BOARD_CONFIG,
  ODOS_FLOOR_CONFIG_CODE,
  ODOS_FLOOR_CONFIG_SYSTEM,
  parseFloorConfigResource,
  type FloorBoardConfig,
} from "../../lib/floor-board";

type FloorConfigReader = {
  search<T extends Basic>(
    resourceType: T["resourceType"],
    params: URLSearchParams,
  ): Promise<Bundle<T>>;
};

export type FloorConfigSingleton = {
  resource?: Basic;
  config: FloorBoardConfig;
};

let snapshot: FloorBoardConfig = DEFAULT_FLOOR_BOARD_CONFIG;
let singleton: FloorConfigSingleton | undefined;
let loadPromise: Promise<FloorConfigSingleton> | undefined;
const listeners = new Set<() => void>();

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getSnapshot() {
  return snapshot;
}

export function publishFloorBoardConfig(config: FloorBoardConfig, resource?: Basic): void {
  snapshot = structuredClone(config);
  singleton = { resource: resource ?? singleton?.resource, config: snapshot };
  for (const listener of listeners) listener();
}

export async function loadFloorConfigSingleton(
  client: FloorConfigReader = fhir,
  force = false,
): Promise<FloorConfigSingleton> {
  if (!force && singleton) return singleton;
  if (!force && loadPromise) return loadPromise;
  loadPromise = (async () => {
    const bundle = await client.search<Basic>(
      "Basic",
      new URLSearchParams([
        ["code", `${ODOS_FLOOR_CONFIG_SYSTEM}|${ODOS_FLOOR_CONFIG_CODE}`],
        ["_count", "10"],
      ]),
    );
    const resources = (bundle.entry ?? [])
      .map((entry) => entry.resource)
      .filter((resource): resource is Basic => Boolean(resource));
    const resource = [...resources].sort(
      (a, b) =>
        (Date.parse(b.meta?.lastUpdated ?? "") || 0) -
        (Date.parse(a.meta?.lastUpdated ?? "") || 0),
    )[0];
    const config = resource
      ? parseFloorConfigResource(resource) ?? DEFAULT_FLOOR_BOARD_CONFIG
      : DEFAULT_FLOOR_BOARD_CONFIG;
    singleton = { resource, config };
    publishFloorBoardConfig(config);
    return singleton;
  })();
  try {
    return await loadPromise;
  } finally {
    loadPromise = undefined;
  }
}

export function useFloorBoardConfig(): FloorBoardConfig {
  const config = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  useEffect(() => {
    void loadFloorConfigSingleton().catch(() => undefined);
  }, []);

  return config;
}
