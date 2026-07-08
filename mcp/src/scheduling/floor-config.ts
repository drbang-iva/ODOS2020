import type { Basic } from "@medplum/fhirtypes";

/**
 * Persisted floor-board settings (cockpit Phase 3a) — a sibling singleton to the
 * scheduling-config `Basic` (practice-config.ts), same design call: practice-owned
 * config, not clinical data, readable/writable through the plain-fetch FHIR client
 * under AccessPolicy. Kept as a separate resource (not merged into scheduling
 * config) because it is owned by a different concern (floor operations vs booking
 * rules) and grows independently (station catalog, thresholds, payer map).
 */

export const OSOD_FLOOR_CONFIG_SYSTEM = "https://osod.dev/fhir/CodeSystem/floor-config";

export const OSOD_FLOOR_CONFIG_CODE = "osod-floor-config";

export const OSOD_FLOOR_CONFIG_EXTENSION_URL =
  "https://osod.dev/fhir/StructureDefinition/osod-floor-practice-config";

export interface FloorStation {
  id: string;
  label: string;
  order: number;
}

export interface LaneThreshold {
  amberMinutes: number;
  redMinutes: number;
}

export type PayerCueKind = "vision" | "house";

export interface PersistedFloorConfig {
  stations: FloorStation[];
  laneThresholds: Record<string, LaneThreshold>;
  defaultThreshold: LaneThreshold;
  payerMap: Record<string, PayerCueKind>;
  housePlanLabel?: string;
}

export const DEFAULT_FLOOR_STATIONS: FloorStation[] = [
  { id: "front-desk", label: "Front desk", order: 0 },
  { id: "waiting", label: "Waiting", order: 1 },
  { id: "pretest", label: "Pretest", order: 2 },
  { id: "chair-1", label: "Chair 1", order: 3 },
  { id: "chair-2", label: "Chair 2", order: 4 },
  { id: "optical", label: "Optical", order: 5 },
  { id: "checkout", label: "Checkout", order: 6 },
];

export const DEFAULT_LANE_THRESHOLDS: LaneThreshold = { amberMinutes: 20, redMinutes: 30 };

const KNOWN_PAYER_CUE_KINDS = new Set<string>(["vision", "house"] satisfies PayerCueKind[]);

function assertThreshold(threshold: LaneThreshold, context: string): void {
  if (!Number.isFinite(threshold.amberMinutes) || threshold.amberMinutes <= 0) {
    throw new Error(`${context} amberMinutes must be a positive number.`);
  }
  if (!Number.isFinite(threshold.redMinutes) || threshold.redMinutes <= threshold.amberMinutes) {
    throw new Error(`${context} redMinutes must be greater than amberMinutes.`);
  }
}

function assertConfig(config: PersistedFloorConfig): void {
  if (config.stations.length === 0) {
    throw new Error("Floor config must declare at least one station.");
  }
  const stationIds = new Set(config.stations.map((station) => station.id));
  if (stationIds.size !== config.stations.length) {
    throw new Error("Floor config station ids must be unique.");
  }
  assertThreshold(config.defaultThreshold, "Default threshold");
  for (const [stationId, threshold] of Object.entries(config.laneThresholds)) {
    if (!stationIds.has(stationId)) {
      throw new Error(`Lane threshold references unknown station "${stationId}".`);
    }
    assertThreshold(threshold, `Threshold for station "${stationId}"`);
  }
  for (const [payer, cueKind] of Object.entries(config.payerMap)) {
    if (!KNOWN_PAYER_CUE_KINDS.has(cueKind)) {
      throw new Error(`Unknown payer cue kind "${cueKind}" for payer "${payer}" — must be vision or house.`);
    }
  }
}

/**
 * Build the singleton Basic carrying the floor board config. Pass the existing
 * resource to preserve id + meta (update-in-place; the config is a singleton, never a second copy).
 */
export function buildFloorConfigResource(
  config: PersistedFloorConfig,
  existing?: Basic,
): Basic {
  assertConfig(config);
  return {
    resourceType: "Basic",
    ...(existing?.id ? { id: existing.id } : {}),
    ...(existing?.meta ? { meta: existing.meta } : {}),
    code: {
      coding: [
        {
          system: OSOD_FLOOR_CONFIG_SYSTEM,
          code: OSOD_FLOOR_CONFIG_CODE,
          display: "OSOD Floor Board Config",
        },
      ],
      text: "OSOD Floor Board Config",
    },
    extension: [{ url: OSOD_FLOOR_CONFIG_EXTENSION_URL, valueString: JSON.stringify(config) }],
  };
}

/**
 * Parse the stored config back out of the singleton Basic. Forward-compatible: only the known
 * top-level keys are read, so future config knobs written by a newer OSOD never break an older
 * reader. The parsed config is re-validated before it is returned.
 */
export function parseFloorConfig(basic: Basic): PersistedFloorConfig {
  const coding = basic.code?.coding?.find(
    (candidate) =>
      candidate.system === OSOD_FLOOR_CONFIG_SYSTEM && candidate.code === OSOD_FLOOR_CONFIG_CODE,
  );
  if (!coding) {
    throw new Error("Basic resource is not the osod floor-config singleton.");
  }
  const raw = basic.extension?.find((extension) => extension.url === OSOD_FLOOR_CONFIG_EXTENSION_URL)
    ?.valueString;
  if (!raw) {
    throw new Error("Floor-config singleton is missing its config extension.");
  }
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    throw new Error("Floor-config JSON is malformed and cannot be parsed.");
  }
  const config: PersistedFloorConfig = {
    stations: (parsed.stations ?? []) as FloorStation[],
    laneThresholds: (parsed.laneThresholds ?? {}) as Record<string, LaneThreshold>,
    defaultThreshold: (parsed.defaultThreshold ?? DEFAULT_LANE_THRESHOLDS) as LaneThreshold,
    payerMap: (parsed.payerMap ?? {}) as Record<string, PayerCueKind>,
    ...(typeof parsed.housePlanLabel === "string" ? { housePlanLabel: parsed.housePlanLabel } : {}),
  };
  assertConfig(config);
  return config;
}
