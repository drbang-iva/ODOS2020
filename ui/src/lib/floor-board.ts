// ui/src/lib/floor-board.ts
import type { Appointment, HealthcareService } from "@medplum/fhirtypes";
import { buildAppointmentBlockContent, visionCoverageOf, type AppointmentBlockContent } from "./scheduling";
import { parseFloorState } from "./floor-state";

// The floor board's derivation (cockpit floor-board MVP doc §3): turns raw
// Appointments + config into sorted lanes. Pure logic only — no React.
//
// Config shape is structural, not imported from mcp/src/scheduling/floor-config.ts:
// ui/src/lib is browser code and mcp/src is the server-side package; importing
// across that boundary the other direction (ui -> mcp) would be new and unusual
// for this codebase. TypeScript's structural typing means the real
// PersistedFloorConfig from Task 1 satisfies FloorBoardConfig below with no
// import needed — callers just pass it straight through.

export interface LaneThreshold {
  amberMinutes: number;
  redMinutes: number;
}

export type PayerCueKind = "vision" | "house";

export interface FloorBoardConfig {
  stations: { id: string; label: string; order: number }[];
  laneThresholds: Record<string, LaneThreshold>;
  defaultThreshold: LaneThreshold;
  payerMap: Record<string, PayerCueKind>;
}

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
  timer: TimerState;
  payerCue: PayerCue | undefined;
}

export type FloorBoard = Record<string, FloorCard[]>;

/** Minutes between `since` and `now`, clamped to 0 (never negative on clock skew). */
function minutesSince(since: string, now: string): number {
  const deltaMs = Date.parse(now) - Date.parse(since);
  return Math.max(0, Math.round(deltaMs / 60_000));
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
  return kind ? { kind, label: planDisplay } : undefined;
}

function thresholdFor(stationId: string, config: FloorBoardConfig): LaneThreshold {
  return config.laneThresholds[stationId] ?? config.defaultThreshold;
}

// Checked-in and walk-in patients are "on the floor". Both are represented via
// content.status (already correctly derived by buildAppointmentBlockContent's
// call to osodAppointmentStatusOf — see the note above on why this isn't
// re-derived from raw appointment.status here).
const ON_FLOOR_STATUSES = new Set(["checked-in", "walk-in"]);

export function deriveFloorBoard(
  appointments: Appointment[],
  visitTypes: HealthcareService[],
  config: FloorBoardConfig,
  now: string,
): FloorBoard {
  const stationIds = new Set(config.stations.map((station) => station.id));
  const board: FloorBoard = Object.fromEntries(config.stations.map((station) => [station.id, []]));

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

// The MVP default board config (ui cannot import mcp runtime code). Only `stations`
// and `defaultThreshold` mirror mcp/src/scheduling/floor-config.ts's
// DEFAULT_FLOOR_STATIONS / DEFAULT_LANE_THRESHOLDS, and that mirroring is the sole
// thing guarded by mcp/tests/floorConfigParity.test.ts. The `laneThresholds`
// (waiting 10/20) and empty `payerMap` are ui-side MVP stand-ins with no mcp
// counterpart yet — they'll be replaced when the persisted floor-config singleton
// read lands (deferred fast-follow).
export const DEFAULT_FLOOR_BOARD_CONFIG: FloorBoardConfig = {
  stations: [
    { id: "front-desk", label: "Front desk", order: 0 },
    { id: "waiting", label: "Waiting", order: 1 },
    { id: "pretest", label: "Pretest", order: 2 },
    { id: "chair-1", label: "Chair 1", order: 3 },
    { id: "chair-2", label: "Chair 2", order: 4 },
    { id: "optical", label: "Optical", order: 5 },
    { id: "checkout", label: "Checkout", order: 6 },
  ],
  laneThresholds: { waiting: { amberMinutes: 10, redMinutes: 20 } },
  defaultThreshold: { amberMinutes: 20, redMinutes: 30 },
  payerMap: {},
};
