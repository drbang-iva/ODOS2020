import type { Application, Request, Response } from "express";
import type { Resource, Task } from "@medplum/fhirtypes";
import { collectAllPages, type PaginatedFhir } from "./fhir-pagination.js";
import { loadWatcherHealth } from "./watcher-health.js";
import { projectFrontDeskAlerts, projectTodayDigest } from "./watcher-projections.js";
import type { WatcherPracticeConfig, WatcherRegistry } from "./watcher-types.js";
import { practiceDate } from "../desk/day-ledger.js";
import { conditionKey, WATCHER_CODE_SYSTEM } from "./watcher-task.js";
import { resolveBusinessActionRole, type BusinessAction, type PracticeRoleId } from "../authz/roles.js";

const WATCHER_ACTION_SYSTEM = "https://odos2020.com/fhir/CodeSystem/watcher-action";
const FHIR_DATETIME_WITH_ZONE = /^(?!0000)\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-](?:(?:0\d|1[0-3]):[0-5]\d|14:00))$/;
const TERMINAL_TASK_STATUSES = new Set<Task["status"]>([
  "cancelled",
  "completed",
  "entered-in-error",
  "failed",
  "rejected",
]);

export interface WatcherRouteFhir extends PaginatedFhir {
  read<T extends Resource>(resourceType: T["resourceType"], id: string): Promise<T>;
  update<T extends Resource>(
    resourceType: T["resourceType"],
    id: string,
    resource: T,
    extraHeaders?: Record<string, string>,
  ): Promise<T>;
}

interface WatcherStaff {
  staffReference: string;
  roles?: readonly PracticeRoleId[];
  fhir: unknown;
}

export interface WatcherRouteDependencies {
  authenticateService(): Promise<void>;
  authenticate(header: string | undefined): Promise<WatcherStaff | null>;
  serviceFhir: WatcherRouteFhir;
  registry: WatcherRegistry;
  loadConfig(): Promise<WatcherPracticeConfig>;
  now?: () => string;
  timeZone?: string;
}

class WatcherValidationError extends Error {}
class WatcherConflictError extends Error {}

export function registerWatcherRoutes(
  app: Pick<Application, "get" | "post">,
  deps: WatcherRouteDependencies,
): void {
  app.get("/watchers/frontdesk", (req, res) => withStaff(req, res, deps, "billing-context.read", async () => {
    const date = requestedDate(req.query.date);
    const [config, health, tasks] = await Promise.all([
      deps.loadConfig(),
      loadWatcherHealth(deps.serviceFhir as never),
      watcherTasks(deps.serviceFhir),
    ]);
    const body = projectFrontDeskAlerts({
      tasks, config, registry: deps.registry, health: health.state,
      date, now: deps.now?.() ?? new Date().toISOString(), timeZone: deps.timeZone,
    });
    res.status(body.status === "degraded" ? 503 : 200).json(body);
  }));

  app.get("/watchers/today", (req, res) => withStaff(req, res, deps, "billing-context.read", async () => {
    const now = deps.now?.() ?? new Date().toISOString();
    const date = req.query.date === undefined
      ? practiceDate(now, deps.timeZone)
      : requestedDate(req.query.date);
    const [config, health, tasks] = await Promise.all([
      deps.loadConfig(),
      loadWatcherHealth(deps.serviceFhir as never),
      watcherTasks(deps.serviceFhir),
    ]);
    const body = projectTodayDigest({
      tasks, config, registry: deps.registry, health: health.state, date,
      previousDate: previousDate(date), now, timeZone: deps.timeZone,
    });
    res.status(body.status === "degraded" ? 503 : 200).json(body);
  }));

  app.post("/watchers/tasks/:taskId/action", (req, res) => withStaff(req, res, deps, "watchers.manage", async () => {
    const taskId = typeof req.params.taskId === "string" ? req.params.taskId : "";
    if (!taskId) throw new WatcherValidationError("Watcher Task id is required.");
    const task = await applyWatcherTaskAction(
      deps.serviceFhir,
      deps.registry,
      taskId,
      req.body,
      deps.now?.() ?? new Date().toISOString(),
      await deps.loadConfig(),
      deps.timeZone,
    );
    res.json({ taskId: task.id, status: task.status });
  }));
}

export async function applyWatcherTaskAction(
  fhir: Pick<WatcherRouteFhir, "read" | "update">,
  registry: WatcherRegistry,
  taskId: string,
  raw: unknown,
  now: string,
  config: WatcherPracticeConfig,
  timeZone?: string,
): Promise<Task> {
  const body = record(raw);
  const action = body.action;
  const task = await fhir.read<Task>("Task", taskId);
  const versionId = task.meta?.versionId;
  if (!versionId) {
    throw new WatcherConflictError(`Watcher Task/${taskId} has no version for a safe update.`);
  }
  if (TERMINAL_TASK_STATUSES.has(task.status)) {
    throw new WatcherValidationError(`Watcher Task/${taskId} is terminal and cannot accept another action.`);
  }
  const watcherId = task.code?.coding?.find(
    (coding) => coding.system === WATCHER_CODE_SYSTEM && coding.code,
  )?.code;
  const key = conditionKey(task);
  if (!watcherId || !key) {
    throw new WatcherValidationError(`Task/${taskId} is not an ODOS watcher Task.`);
  }
  const definition = registry.get(watcherId);
  let updated: Task;

  if (action === "dismiss") {
    const reason = definition.dismissalReasons.find((candidate) => candidate.code === body.reason);
    if (!reason) throw new WatcherValidationError("Dismissal reason is not valid for this watcher.");
    updated = {
      ...task,
      status: "cancelled",
      statusReason: { coding: [{ system: WATCHER_ACTION_SYSTEM, ...reason }] },
      lastModified: now,
    };
  } else if (action === "snooze") {
    const until = instant(body.until, "Snooze-until time");
    if (Date.parse(until) <= Date.parse(now)) throw new WatcherValidationError("Snooze-until time must be in the future.");
    updated = {
      ...task,
      status: "on-hold",
      statusReason: { coding: [{ system: WATCHER_ACTION_SYSTEM, code: "snoozed", display: "Snoozed" }] },
      restriction: { ...task.restriction, period: { ...task.restriction?.period, end: until } },
      lastModified: now,
    };
  } else if (action === "reassign") {
    if (typeof body.practitioner !== "string" || !/^Practitioner\/[A-Za-z0-9.-]+$/.test(body.practitioner)) {
      throw new WatcherValidationError("Reassignment requires a Practitioner reference.");
    }
    updated = { ...task, owner: { reference: body.practitioner }, lastModified: now };
  } else if (action === "resolve") {
    if (
      typeof body.patientReference !== "string"
      || !/^Patient\/[A-Za-z0-9.-]+$/.test(body.patientReference)
      || body.patientReference !== task.for?.reference
    ) {
      throw new WatcherValidationError(`Collected Patient does not match watcher Task/${taskId}.`);
    }
    const settings = config.watchers[watcherId];
    const appointmentAt = task.restriction?.period?.start;
    if (!settings || !appointmentAt || !key) {
      throw new WatcherValidationError(`Watcher Task/${taskId} cannot verify its current condition.`);
    }
    const active = await definition.firingRule({
      now,
      date: practiceDate(appointmentAt, timeZone),
      settings,
    });
    if (active.some((match) => match.conditionKey === key)) {
      throw new WatcherValidationError(`Watcher Task/${taskId} still has an active condition.`);
    }
    updated = {
      ...task,
      status: "completed",
      statusReason: { coding: [{ system: WATCHER_ACTION_SYSTEM, code: "collected", display: "Collected" }] },
      lastModified: now,
    };
  } else {
    throw new WatcherValidationError("Watcher action must be dismiss, snooze, reassign, or resolve.");
  }
  return fhir.update("Task", taskId, updated, { "If-Match": `W/"${versionId}"` });
}

async function watcherTasks(fhir: WatcherRouteFhir): Promise<Task[]> {
  return collectAllPages<Task>(
    fhir,
    "Task",
    { code: `${WATCHER_CODE_SYSTEM}|`, _count: "1000" },
    "Watcher Tasks",
  );
}

async function withStaff(
  req: Request,
  res: Response,
  deps: WatcherRouteDependencies,
  requiredAction: BusinessAction,
  action: () => Promise<void>,
): Promise<void> {
  try {
    const staff = await deps.authenticate(req.header("authorization"));
    if (!staff) {
      res.status(401).json({ error: "Authentication required for watcher alerts." });
      return;
    }
    if (!resolveBusinessActionRole(staff.roles ?? [], requiredAction)) {
      res.status(403).json({ error: `${requiredAction} role required` });
      return;
    }
    await deps.authenticateService();
    await action();
  } catch (error) {
    if (res.headersSent) return;
    if (error instanceof WatcherValidationError) {
      res.status(400).json({ error: error.message });
    } else if (error instanceof WatcherConflictError || isFhirVersionConflict(error)) {
      res.status(409).json({ error: "Watcher Task changed; refresh before trying again." });
    } else {
      console.error("odos-mcp: watcher route failed:", error);
      res.status(500).json({ error: "Watcher route failed." });
    }
  }
}

function requestedDate(value: unknown): string {
  const parsed = typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)
    ? Date.parse(`${value}T00:00:00Z`)
    : NaN;
  if (typeof value !== "string" || Number.isNaN(parsed) || new Date(parsed).toISOString().slice(0, 10) !== value) {
    throw new WatcherValidationError("Watcher date must be YYYY-MM-DD.");
  }
  return value;
}

function previousDate(value: string): string {
  const date = new Date(`${value}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() - 1);
  return date.toISOString().slice(0, 10);
}

function instant(value: unknown, label: string): string {
  if (typeof value !== "string" || !FHIR_DATETIME_WITH_ZONE.test(value) || Number.isNaN(Date.parse(value))) {
    throw new WatcherValidationError(`${label} must be an ISO dateTime.`);
  }
  return value;
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function isFhirVersionConflict(error: unknown): boolean {
  const status = (error as { status?: unknown })?.status;
  return status === 409 || status === 412 || /FHIR (409|412)\b/.test(error instanceof Error ? error.message : String(error));
}
