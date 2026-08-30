import type { Task } from "@medplum/fhirtypes";
import { projectWatcherHealth, type WatcherHealthState } from "./watcher-health.js";
import { WATCHER_CODE_SYSTEM, WATCHER_INPUT_SYSTEM, WATCHER_STATUS_SYSTEM } from "./watcher-task.js";
import type { WatcherPracticeConfig, WatcherRegistry, WatcherSeverity } from "./watcher-types.js";
import { practiceDate } from "../desk/day-ledger.js";

export interface WatcherAlertProjection {
  taskId: string;
  watcherId: string;
  severity: WatcherSeverity;
  patientReference: string;
  patientDisplay: string;
  appointmentReference: string;
  appointmentId: string;
  appointmentAt: string;
  message: string;
  frontDeskMessage: string;
  consequence: string;
  primaryAction: { label: string; href: string };
  dismissalReasons: Array<{ code: string; display: string }>;
  balanceCents: number;
  ageDays: number;
}

interface ProjectionInput {
  tasks: Task[];
  config: WatcherPracticeConfig;
  registry: WatcherRegistry;
  health: WatcherHealthState | undefined;
  now: string;
  timeZone?: string;
}

type DegradedProjection = {
  status: "degraded";
  reason: "failed" | "stale" | "never-succeeded";
  lastSuccessfulAt?: string;
};

export function projectFrontDeskAlerts(
  input: ProjectionInput & { date?: string },
): DegradedProjection | {
  status: "healthy";
  lastSuccessfulAt: string;
  alerts: WatcherAlertProjection[];
} {
  const health = projectWatcherHealth(input.health, input.config, input.now);
  if (health.status === "degraded") return health;
  const alerts = input.tasks
    .filter(isWatcherTask)
    .filter((task) => isVisible(task, input.now))
    .map((task) => taskProjection(task, input.registry))
    .filter((alert) => !input.date || practiceDate(alert.appointmentAt, input.timeZone) === input.date)
    .sort((left, right) => left.appointmentAt.localeCompare(right.appointmentAt));
  return { ...health, alerts };
}

export function projectTodayDigest(
  input: ProjectionInput & { date: string; previousDate: string },
): DegradedProjection | {
  status: "healthy";
  lastSuccessfulAt: string;
  goLiveAt: string;
  goLiveDate: string;
  items: WatcherAlertProjection[];
  overflow: { total: number; groups: Array<{ watcherId: string; count: number }> };
  sinceYesterday: {
    today: { patientCount: number; dollarsCents: number };
    yesterday: { patientCount: number; dollarsCents: number };
    delta: { patientCount: number; dollarsCents: number };
  };
} {
  const health = projectWatcherHealth(input.health, input.config, input.now);
  if (health.status === "degraded") return health;
  const watcherTasks = input.tasks.filter(isWatcherTask);
  const projections = watcherTasks.map((task) => taskProjection(task, input.registry));
  const eligible = projections
    .filter((alert) => alert.severity === "today" && practiceDate(alert.appointmentAt, input.timeZone) === input.date)
    .filter((alert) => isVisible(watcherTasks.find((task) => task.id === alert.taskId)!, input.now))
    .sort(rankAlerts);
  const previous = projections.filter(
    (alert) => practiceDate(alert.appointmentAt, input.timeZone) === input.previousDate,
  );
  const items = eligible.slice(0, input.config.needsHumanCap);
  const overflowItems = eligible.slice(input.config.needsHumanCap);
  const groups = new Map<string, number>();
  for (const item of overflowItems) groups.set(item.watcherId, (groups.get(item.watcherId) ?? 0) + 1);
  const todayStats = stats(eligible);
  const yesterdayStats = stats(previous);
  return {
    ...health,
    goLiveAt: input.config.goLiveAt,
    goLiveDate: practiceDate(input.config.goLiveAt, input.timeZone),
    items,
    overflow: {
      total: overflowItems.length,
      groups: [...groups].map(([watcherId, count]) => ({ watcherId, count })),
    },
    sinceYesterday: {
      today: todayStats,
      yesterday: yesterdayStats,
      delta: {
        patientCount: todayStats.patientCount - yesterdayStats.patientCount,
        dollarsCents: todayStats.dollarsCents - yesterdayStats.dollarsCents,
      },
    },
  };
}

function taskProjection(task: Task, registry: WatcherRegistry): WatcherAlertProjection {
  const watcherId = task.code?.coding?.find((coding) => coding.code)?.code;
  const severity = task.businessStatus?.coding?.find(
    (coding) => coding.system === WATCHER_STATUS_SYSTEM,
  )?.code as WatcherSeverity | undefined;
  const appointmentReference = task.focus?.reference;
  const appointmentAt = task.restriction?.period?.start;
  if (!task.id || !watcherId || !severity || !task.for?.reference || !appointmentReference || !appointmentAt) {
    throw new Error(`Watcher Task/${task.id ?? "unknown"} is missing required projection data.`);
  }
  const definition = registry.get(watcherId);
  return {
    taskId: task.id,
    watcherId,
    severity,
    patientReference: task.for.reference,
    patientDisplay: task.for.display ?? task.for.reference,
    appointmentReference,
    appointmentId: appointmentReference.replace(/^Appointment\//, ""),
    appointmentAt,
    message: task.description ?? "",
    frontDeskMessage: stringInput(task, "front-desk-message"),
    consequence: stringInput(task, "consequence"),
    primaryAction: {
      label: stringInput(task, "primary-action-label"),
      href: stringInput(task, "primary-action-href"),
    },
    dismissalReasons: definition.dismissalReasons.map((reason) => ({ ...reason })),
    balanceCents: integerInput(task, "balance-cents"),
    ageDays: integerInput(task, "balance-age-days"),
  };
}

function isVisible(task: Task, now: string): boolean {
  if (task.status === "cancelled" || task.status === "completed" || task.status === "entered-in-error") return false;
  if (task.status === "on-hold") {
    const until = task.restriction?.period?.end;
    return Boolean(until && Date.parse(until) <= Date.parse(now));
  }
  return task.status === "requested" || task.status === "in-progress" || task.status === "ready";
}

function isWatcherTask(task: Task): boolean {
  return Boolean(task.code?.coding?.some((coding) => coding.system === WATCHER_CODE_SYSTEM));
}

function rankAlerts(left: WatcherAlertProjection, right: WatcherAlertProjection): number {
  const severityRank: Record<WatcherSeverity, number> = { today: 0, "this-week": 1, watch: 2 };
  return severityRank[left.severity] - severityRank[right.severity]
    || right.balanceCents - left.balanceCents
    || right.ageDays - left.ageDays
    || left.taskId.localeCompare(right.taskId);
}

function stats(items: WatcherAlertProjection[]) {
  return {
    patientCount: new Set(items.map((item) => item.patientReference)).size,
    dollarsCents: items.reduce((sum, item) => sum + item.balanceCents, 0),
  };
}

function stringInput(task: Task, code: string): string {
  const value = findInput(task, code)?.valueString;
  if (typeof value !== "string" || !value.trim()) throw new Error(`Watcher Task/${task.id} is missing ${code}.`);
  return value;
}

function integerInput(task: Task, code: string): number {
  const value = findInput(task, code)?.valueInteger;
  if (!Number.isInteger(value)) throw new Error(`Watcher Task/${task.id} is missing ${code}.`);
  return Number(value);
}

function findInput(task: Task, code: string) {
  return task.input?.find((candidate) => candidate.type.coding?.some(
    (coding) => coding.system === WATCHER_INPUT_SYSTEM && coding.code === code,
  ));
}
