import {
  projectedListAdapter,
  type CatalogAdapter,
  type SingletonConfigDraft,
} from "./catalog-adapter";
import {
  buildFloorConfigResource,
  type PersistedFloorConfig,
  type PayerCueKind,
} from "./floor-config";

export type FloorStationRow = {
  id: string;
  label: string;
  order: number;
  active: boolean;
  amberMinutes: number;
  redMinutes: number;
};

export type PayerMapRow = {
  id: string;
  payer: string;
  cue: PayerCueKind | "none";
  active: boolean;
};

export type HousePlanLabelRow = {
  id: "house-plan-label";
  label: string;
  active: true;
};

export function floorStationRows(config: PersistedFloorConfig): FloorStationRow[] {
  return config.stations.map((station) => {
    const threshold = config.laneThresholds[station.id] ?? config.defaultThreshold;
    return {
      ...station,
      active: station.active !== false,
      amberMinutes: threshold.amberMinutes,
      redMinutes: threshold.redMinutes,
    };
  });
}

export function configFromFloorStationRows(
  config: PersistedFloorConfig,
  rows: FloorStationRow[],
  onBoardStationIds: ReadonlySet<string> = new Set(),
): PersistedFloorConfig {
  const currentById = new Map(config.stations.map((station) => [station.id, station]));
  for (const row of rows) {
    const wasActive = currentById.get(row.id)?.active !== false;
    if (wasActive && !row.active) {
      if (onBoardStationIds.has(row.id)) {
        throw new Error(`Station "${row.label}" cannot be deactivated because it has patients currently on the board.`);
      }
      if (config.laneThresholds[row.id]) {
        throw new Error(`Station "${row.label}" cannot be deactivated because its lane threshold still references it.`);
      }
    }
  }

  const laneThresholds: PersistedFloorConfig["laneThresholds"] = {};
  for (const row of rows) {
    const threshold = { amberMinutes: row.amberMinutes, redMinutes: row.redMinutes };
    const usesDefault =
      threshold.amberMinutes === config.defaultThreshold.amberMinutes &&
      threshold.redMinutes === config.defaultThreshold.redMinutes;
    if (config.laneThresholds[row.id] || !usesDefault) {
      laneThresholds[row.id] = threshold;
    }
  }

  const next: PersistedFloorConfig = {
    ...config,
    stations: rows.map((row, order) => ({
      id: row.id,
      label: row.label,
      order,
      ...(row.active ? {} : { active: false }),
    })),
    laneThresholds,
  };
  buildFloorConfigResource(next);
  return next;
}

export function payerMapRows(config: PersistedFloorConfig): PayerMapRow[] {
  return Object.entries(config.payerMap).map(([payer, cue]) => ({
    id: payer,
    payer,
    cue,
    active: true,
  }));
}

export function configFromPayerMapRows(
  config: PersistedFloorConfig,
  rows: PayerMapRow[],
): PersistedFloorConfig {
  const payerMap: PersistedFloorConfig["payerMap"] = {};
  for (const row of rows) {
    const payer = row.payer.trim();
    if (payer && row.cue !== "none") payerMap[payer] = row.cue;
  }
  const next = { ...config, payerMap };
  buildFloorConfigResource(next);
  return next;
}

export function housePlanLabelRows(config: PersistedFloorConfig): HousePlanLabelRow[] {
  return [{ id: "house-plan-label", label: config.housePlanLabel ?? "", active: true }];
}

export function configFromHousePlanLabelRows(
  config: PersistedFloorConfig,
  rows: HousePlanLabelRow[],
): PersistedFloorConfig {
  const label = rows[0]?.label.trim() ?? "";
  const { housePlanLabel: _previous, ...withoutLabel } = config;
  const next: PersistedFloorConfig = label ? { ...withoutLabel, housePlanLabel: label } : withoutLabel;
  buildFloorConfigResource(next);
  return next;
}

export function createFloorConfigAdapters(
  draft: SingletonConfigDraft<PersistedFloorConfig>,
  onBoardStationIds: ReadonlySet<string>,
): {
  stations: CatalogAdapter<FloorStationRow>;
  payerMap: CatalogAdapter<PayerMapRow>;
  housePlanLabel: CatalogAdapter<HousePlanLabelRow>;
} {
  return {
    stations: projectedListAdapter(draft, {
      capabilities: { reorder: true, deactivate: true, presetSeed: false },
      toRows: floorStationRows,
      fromRows: (config, rows) => configFromFloorStationRows(config, rows, onBoardStationIds),
    }),
    payerMap: projectedListAdapter(draft, {
      capabilities: { reorder: false, deactivate: false, presetSeed: false },
      toRows: payerMapRows,
      fromRows: configFromPayerMapRows,
    }),
    housePlanLabel: projectedListAdapter(draft, {
      capabilities: { reorder: false, deactivate: false, presetSeed: false },
      toRows: housePlanLabelRows,
      fromRows: configFromHousePlanLabelRows,
    }),
  };
}
