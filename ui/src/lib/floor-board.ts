// ui/src/lib/floor-board.ts
import type { Appointment, Basic, HealthcareService } from "@medplum/fhirtypes";
import { buildAppointmentBlockContent, visionCoverageOf, type AppointmentBlockContent } from "./scheduling";
import { parseFloorState } from "./floor-state";
import {
  DEFAULT_FLOOR_STATIONS,
  DEFAULT_LANE_THRESHOLDS,
  ODOS_FLOOR_CONFIG_CODE,
  ODOS_FLOOR_CONFIG_EXTENSION_URL,
  ODOS_FLOOR_CONFIG_SYSTEM,
  type LaneThreshold,
  type PayerCueKind,
  type PersistedFloorConfig,
} from "./floor-config";

export {
  ODOS_FLOOR_CONFIG_CODE,
  ODOS_FLOOR_CONFIG_EXTENSION_URL,
  ODOS_FLOOR_CONFIG_SYSTEM,
} from "./floor-config";
export type { LaneThreshold, PayerCueKind } from "./floor-config";

// The floor board's derivation (cockpit floor-board MVP doc §3): turns raw
// Appointments + config into sorted lanes. Pure logic only — no React.
//
// Config shape is structural, not imported from mcp/src/scheduling/floor-config.ts:
// ui/src/lib is browser code and mcp/src is the server-side package; importing
// across that boundary the other direction (ui -> mcp) would be new and unusual
// for this codebase. TypeScript's structural typing means the real
// PersistedFloorConfig from Task 1 satisfies FloorBoardConfig below with no
// import needed — callers just pass it straight through.

export type FloorBoardConfig = PersistedFloorConfig;

export interface TimerState {
  minutes: number;
  level: "ok" | "amber" | "red";
}

export interface PayerCue {
  kind: PayerCueKind;
  label: string;
}

export interface FloorCard {
  appointment: Appointment;
  content: AppointmentBlockContent;
  station: string;
  since: string;
  /** When the patient first checked in; preserved across moves (falls back to `since`). */
  checkedInAt: string;
  timer: TimerState;
  payerCue: PayerCue | undefined;
}

export type FloorBoard = Record<string, FloorCard[]>;

/**
 * Minutes between `since` and `now`, clamped to 0 (never negative on clock skew).
 * Floored (not rounded) so a 9m31s wait reads as 9 minutes, not 10 — thresholds are
 * inclusive lower bounds and must not trigger early on a rounded-up partial minute.
 */
function minutesSince(since: string, now: string): number {
  const deltaMs = Date.parse(now) - Date.parse(since);
  return Math.max(0, Math.floor(deltaMs / 60_000));
}

export function timerState(since: string, threshold: LaneThreshold, now: string): TimerState {
  const minutes = minutesSince(since, now);
  // Data-integrity safe default: an unparseable `since` yields NaN minutes. On a
  // wait board whose whole job is surfacing overdue patients, a corrupt timer must
  // read as attention-worthy — never a calm green "NaN min" card. Force red (and a
  // real 0, never NaN) so a human looks at the data problem.
  if (Number.isNaN(minutes)) {
    return { minutes: 0, level: "red" };
  }
  const level = minutes >= threshold.redMinutes ? "red" : minutes >= threshold.amberMinutes ? "amber" : "ok";
  return { minutes, level };
}

/**
 * planDisplay is the bare vision-coverage plan name (Appointment's vision
 * coverage `display`, e.g. "VSP") — NOT the composite insuranceLine string
 * ("Vision: VSP · Medical: none"), which is for a card's context line only.
 */
export function payerCue(planDisplay: string | undefined, config: FloorBoardConfig): PayerCue | undefined {
  if (!planDisplay) {
    return undefined;
  }
  const kind = config.payerMap[planDisplay];
  if (!kind) {
    return undefined;
  }
  // The house-plan chip shows the practice's own configured label (config, not
  // hardcoded — no universal default can know a practice's plan name), falling
  // back to the coverage's raw display if the practice hasn't set one yet.
  const label = kind === "house" ? (config.housePlanLabel ?? planDisplay) : planDisplay;
  return { kind, label };
}

function thresholdFor(stationId: string, config: FloorBoardConfig): LaneThreshold {
  return config.laneThresholds[stationId] ?? config.defaultThreshold;
}

// Checked-in and walk-in patients are "on the floor". Both are represented via
// content.status (already correctly derived by buildAppointmentBlockContent's
// call to odosAppointmentStatusOf — see the note above on why this isn't
// re-derived from raw appointment.status here).
const ON_FLOOR_STATUSES = new Set(["checked-in", "walk-in"]);

export function deriveFloorBoard(
  appointments: Appointment[],
  visitTypes: HealthcareService[],
  config: FloorBoardConfig,
  now: string,
): FloorBoard {
  const activeStations = config.stations.filter((station) => station.active !== false);
  const stationIds = new Set(activeStations.map((station) => station.id));
  const board: FloorBoard = Object.fromEntries(activeStations.map((station) => [station.id, []]));

  for (const appointment of appointments) {
    const floorState = parseFloorState(appointment);
    if (!floorState || !stationIds.has(floorState.station)) {
      continue;
    }
    const content = buildAppointmentBlockContent(appointment, visitTypes);
    if (!content.status || !ON_FLOOR_STATUSES.has(content.status)) {
      continue;
    }
    const card: FloorCard = {
      appointment,
      content,
      station: floorState.station,
      since: floorState.since,
      checkedInAt: floorState.checkedInAt ?? floorState.since,
      timer: timerState(floorState.since, thresholdFor(floorState.station, config), now),
      payerCue: payerCue(visionCoverageOf(appointment)?.display, config),
    };
    board[floorState.station].push(card);
  }

  for (const lane of Object.values(board)) {
    lane.sort((a, b) => Date.parse(a.since) - Date.parse(b.since));
  }
  return board;
}

// The fallback board config, used when no odos-floor-config singleton has been
// configured yet (or a read fails) — see useFloorBoardConfig, which reads the real
// persisted singleton and falls back to this. Only `stations` and `defaultThreshold`
// mirror mcp/src/scheduling/floor-config.ts's DEFAULT_FLOOR_STATIONS /
// DEFAULT_LANE_THRESHOLDS (parity-tested in mcp/tests/floorConfigParity.test.ts).
//
// payerMap seeds only VSP/EyeMed (genuinely generic, cross-practice vision-plan
// names) as a visible out-of-the-box demo. It deliberately has NO house-plan entry
// and NO housePlanLabel default: this is shared open-source software every ODOS
// practice runs, and a house plan's name is inherently practice-specific — baking
// one practice's brand in here would be wrong for every other install. A practice
// configures its own house-plan name + label via the floor-config singleton; until
// then the house chip simply stays dormant, same as any other unconfigured plan.
export const DEFAULT_FLOOR_BOARD_CONFIG: FloorBoardConfig = {
  stations: DEFAULT_FLOOR_STATIONS,
  laneThresholds: { waiting: { amberMinutes: 10, redMinutes: 20 } },
  defaultThreshold: DEFAULT_LANE_THRESHOLDS,
  payerMap: { VSP: "vision", EyeMed: "vision" },
};

/**
 * Parse the floor-config singleton off a Basic resource. Read-path parser: never
 * throws — returns undefined on any absent/malformed data so a corrupt or missing
 * singleton falls back to DEFAULT_FLOOR_BOARD_CONFIG rather than crashing the board.
 * Validates the SHAPE of every field, not just top-level presence — an
 * Array.isArray(stations) check alone lets through garbage like [null] that later
 * crashes deriveFloorBoard on station.id; every station/threshold entry is checked.
 */
function isValidStation(value: unknown): value is FloorBoardConfig["stations"][number] {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { id?: unknown }).id === "string" &&
    typeof (value as { label?: unknown }).label === "string" &&
    typeof (value as { order?: unknown }).order === "number" &&
    ((value as { active?: unknown }).active === undefined ||
      typeof (value as { active?: unknown }).active === "boolean")
  );
}

function isValidThreshold(value: unknown): value is LaneThreshold {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { amberMinutes?: unknown }).amberMinutes === "number" &&
    typeof (value as { redMinutes?: unknown }).redMinutes === "number"
  );
}

function isValidPayerMap(value: unknown): value is Record<string, PayerCueKind> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.values(value as Record<string, unknown>).every((kind) => kind === "vision" || kind === "house")
  );
}

export function parseFloorConfigResource(basic: Basic): FloorBoardConfig | undefined {
  const coding = basic.code?.coding?.find(
    (c) => c.system === ODOS_FLOOR_CONFIG_SYSTEM && c.code === ODOS_FLOOR_CONFIG_CODE,
  );
  if (!coding) {
    return undefined;
  }
  const raw = basic.extension?.find((e) => e.url === ODOS_FLOOR_CONFIG_EXTENSION_URL)?.valueString;
  if (!raw) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<FloorBoardConfig>;
    if (!Array.isArray(parsed.stations) || parsed.stations.length === 0 || !parsed.stations.every(isValidStation)) {
      return undefined;
    }
    const laneThresholds = parsed.laneThresholds;
    if (laneThresholds !== undefined) {
      if (typeof laneThresholds !== "object" || laneThresholds === null || Array.isArray(laneThresholds)) {
        return undefined;
      }
      if (!Object.values(laneThresholds).every(isValidThreshold)) {
        return undefined;
      }
    }
    if (parsed.defaultThreshold !== undefined && !isValidThreshold(parsed.defaultThreshold)) {
      return undefined;
    }
    if (parsed.payerMap !== undefined && !isValidPayerMap(parsed.payerMap)) {
      return undefined;
    }
    return {
      stations: parsed.stations,
      laneThresholds: laneThresholds ?? {},
      defaultThreshold: parsed.defaultThreshold ?? DEFAULT_FLOOR_BOARD_CONFIG.defaultThreshold,
      payerMap: parsed.payerMap ?? {},
      ...(typeof parsed.housePlanLabel === "string" ? { housePlanLabel: parsed.housePlanLabel } : {}),
    };
  } catch {
    return undefined;
  }
}
