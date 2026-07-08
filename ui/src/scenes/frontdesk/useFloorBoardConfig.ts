// ui/src/scenes/frontdesk/useFloorBoardConfig.ts
import { useEffect, useState } from "react";
import type { Basic } from "@medplum/fhirtypes";
import { fhir } from "../../lib/fhir";
import {
  DEFAULT_FLOOR_BOARD_CONFIG,
  OSOD_FLOOR_CONFIG_CODE,
  OSOD_FLOOR_CONFIG_SYSTEM,
  parseFloorConfigResource,
  type FloorBoardConfig,
} from "../../lib/floor-board";

/**
 * Reads the persisted osod-floor-config singleton (an isolated, component-local
 * fetch — mirrors how PatientQuickCard reads its own data directly, not through
 * the scheduling store). Falls back to DEFAULT_FLOOR_BOARD_CONFIG while loading,
 * on read failure, or when no singleton has been configured yet.
 */
export function useFloorBoardConfig(): FloorBoardConfig {
  const [config, setConfig] = useState<FloorBoardConfig>(DEFAULT_FLOOR_BOARD_CONFIG);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const bundle = await fhir.search<Basic>(
          "Basic",
          new URLSearchParams([["code", `${OSOD_FLOOR_CONFIG_SYSTEM}|${OSOD_FLOOR_CONFIG_CODE}`], ["_count", "10"]]),
        );
        if (cancelled) return;
        const resources = (bundle.entry ?? [])
          .map((entry) => entry.resource)
          .filter((resource): resource is Basic => Boolean(resource));
        const newest = [...resources].sort(
          (a, b) => (Date.parse(b.meta?.lastUpdated ?? "") || 0) - (Date.parse(a.meta?.lastUpdated ?? "") || 0),
        )[0];
        const parsed = newest ? parseFloorConfigResource(newest) : undefined;
        if (parsed) {
          setConfig(parsed);
        }
      } catch {
        // Read failure: stay on DEFAULT_FLOOR_BOARD_CONFIG (already the initial state).
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, []);

  return config;
}
