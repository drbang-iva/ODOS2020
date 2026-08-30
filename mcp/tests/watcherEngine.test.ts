import assert from "node:assert/strict";
import test from "node:test";
import type { Basic, Bundle, Resource, Task } from "@medplum/fhirtypes";
import { createWatcherRegistry } from "../src/watchers/watcher-registry.js";
import {
  buildWatcherHealthResource,
  parseWatcherHealthResource,
  projectWatcherHealth,
} from "../src/watchers/watcher-health.js";
import { runWatcherSweep } from "../src/watchers/watcher-engine.js";
import {
  reconcileWatcherTasks,
  WATCHER_CONDITION_SYSTEM,
} from "../src/watchers/watcher-task.js";
import type {
  WatcherDefinition,
  WatcherMatch,
  WatcherPracticeConfig,
} from "../src/watchers/watcher-types.js";

const match: WatcherMatch = {
  watcherId: "W1",
  conditionKey: "W1:Appointment/appt-1",
  patientReference: "Patient/sarah",
  patientDisplay: "Sarah M.",
  appointmentReference: "Appointment/appt-1",
  appointmentAt: "2026-08-30T09:40:00-04:00",
  frontDeskMessage: "Sarah M. has a balance from March.",
  ownerMessage: "Sarah M. is on today's schedule with a $132 balance.",
  balanceCents: 13200,
  ageDays: 173,
  sourceOccurredAt: "2026-03-10T14:00:00.000Z",
  sourceInvoiceCount: 1,
};

const w1 = definition("W1", "immediate", async () => [match]);

test("conditional creation and the next sweep update one stable Task", async () => {
  const fhir = new MemoryWatcherFhir();

  await reconcileWatcherTasks(fhir, w1, [match], "today", "2026-08-30T12:00:00.000Z");
  await reconcileWatcherTasks(
    fhir,
    w1,
    [{ ...match, ownerMessage: "The balance is now $140.", balanceCents: 14000 }],
    "today",
    "2026-08-30T12:05:00.000Z",
  );

  assert.equal(fhir.tasks.length, 1);
  assert.equal(fhir.tasks[0]?.description, "The balance is now $140.");
  assert.equal(fhir.createHeaders[0]?.["If-None-Exist"],
    `identifier=${WATCHER_CONDITION_SYSTEM}|W1:Appointment/appt-1`);
  assert.equal(fhir.taskUpdateCount, 1);
});

test("a disappeared active condition completes while a typed dismissal remains cancelled", async () => {
  const active = task("active", "W1:Appointment/active", "requested");
  const dismissed = task("dismissed", "W1:Appointment/dismissed", "cancelled");
  dismissed.statusReason = { coding: [{ code: "payment-plan", display: "Payment plan" }] };
  const fhir = new MemoryWatcherFhir([active, dismissed]);

  await reconcileWatcherTasks(fhir, w1, [], "today", "2026-08-30T12:00:00.000Z");

  assert.equal(fhir.tasks.find((candidate) => candidate.id === "active")?.status, "completed");
  assert.equal(fhir.tasks.find((candidate) => candidate.id === "dismissed")?.status, "cancelled");
  assert.equal(fhir.tasks.find((candidate) => candidate.id === "dismissed")?.statusReason?.coding?.[0]?.code, "payment-plan");
});

test("pre-go-live suppression applies to fixed thresholds but immediate W1 still fires", async () => {
  const olderMatch = { ...match, watcherId: "W9", conditionKey: "W9:old" };
  const threshold = definition("W9", "fixed-threshold", async () => [olderMatch]);
  const fhir = new MemoryWatcherFhir();
  const config = watcherConfig();
  config.watchers.W9 = { enabled: true, severity: "today" };

  await runWatcherSweep({
    fhir,
    registry: createWatcherRegistry([w1, threshold]),
    loadConfig: async () => config,
    now: () => "2026-08-30T12:00:00.000Z",
    date: () => "2026-08-30",
  });

  assert.deepEqual(fhir.tasks.map((candidate) => candidate.identifier?.[0]?.value), [match.conditionKey]);
});

test("the production sweep derives its day from the practice timezone", async () => {
  let evaluatedDate = "";
  const definitionWithDate = definition("W1", "immediate", async (context) => {
    evaluatedDate = context.date;
    return [];
  });

  await runWatcherSweep({
    fhir: new MemoryWatcherFhir(),
    registry: createWatcherRegistry([definitionWithDate]),
    loadConfig: async () => watcherConfig(),
    now: () => "2026-08-31T01:30:00.000Z",
    timeZone: "America/New_York",
  });

  assert.equal(evaluatedDate, "2026-08-30");
});

test("a failed evaluation preserves last success and records failed health", async () => {
  const fhir = new MemoryWatcherFhir([], buildWatcherHealthResource({
    lastAttemptAt: "2026-08-30T11:55:00.000Z",
    lastSuccessfulAt: "2026-08-30T11:55:00.000Z",
    outcome: "healthy",
  }));
  const broken = definition("W1", "immediate", async () => {
    throw new Error("Invoice pagination failed");
  });

  await assert.rejects(() => runWatcherSweep({
    fhir,
    registry: createWatcherRegistry([broken]),
    loadConfig: async () => watcherConfig(),
    now: () => "2026-08-30T12:00:00.000Z",
    date: () => "2026-08-30",
  }), /Invoice pagination failed/);

  const health = parseWatcherHealthResource(fhir.health!);
  assert.equal(health.outcome, "failed");
  assert.equal(health.lastAttemptAt, "2026-08-30T12:00:00.000Z");
  assert.equal(health.lastSuccessfulAt, "2026-08-30T11:55:00.000Z");
  assert.equal(health.failureDetail, "Invoice pagination failed");
});

test("failed and stale health both degrade with the exact last success", () => {
  const config = watcherConfig();
  config.staleAfterMinutes = 15;
  const failed = projectWatcherHealth({
    lastAttemptAt: "2026-08-30T12:00:00.000Z",
    lastSuccessfulAt: "2026-08-30T11:55:00.000Z",
    outcome: "failed",
    failureDetail: "Invoice pagination failed",
  }, config, "2026-08-30T12:01:00.000Z");
  const stale = projectWatcherHealth({
    lastAttemptAt: "2026-08-30T11:30:00.000Z",
    lastSuccessfulAt: "2026-08-30T11:30:00.000Z",
    outcome: "healthy",
  }, config, "2026-08-30T12:01:00.000Z");

  assert.deepEqual(failed, {
    status: "degraded",
    reason: "failed",
    lastSuccessfulAt: "2026-08-30T11:55:00.000Z",
  });
  assert.deepEqual(stale, {
    status: "degraded",
    reason: "stale",
    lastSuccessfulAt: "2026-08-30T11:30:00.000Z",
  });
});

function definition(
  id: string,
  activation: WatcherDefinition["activation"],
  firingRule: WatcherDefinition["firingRule"],
): WatcherDefinition {
  return {
    id,
    question: "What needs a human?",
    firingRule,
    owner: "front-desk",
    nextAction: { label: "View balance & collect", href: () => "/frontdesk" },
    consequence: "Collecting at check-in works better than another statement.",
    register: "front-desk",
    dismissalReasons: [{ code: "payment-plan", display: "Payment plan" }],
    activation,
    seedSettings: { enabled: true, severity: "today" },
  };
}

function watcherConfig(): WatcherPracticeConfig {
  return {
    version: 1,
    goLiveAt: "2026-08-01T00:00:00.000Z",
    needsHumanCap: 5,
    staleAfterMinutes: 15,
    watchers: { W1: { enabled: true, severity: "today" } },
  };
}

function task(id: string, conditionKey: string, status: Task["status"]): Task {
  return {
    resourceType: "Task",
    id,
    status,
    intent: "order",
    identifier: [{ system: WATCHER_CONDITION_SYSTEM, value: conditionKey }],
    code: { coding: [{ code: "W1" }] },
  };
}

class MemoryWatcherFhir {
  readonly createHeaders: Array<Record<string, string> | undefined> = [];
  taskUpdateCount = 0;
  tasks: Task[];
  health?: Basic;

  constructor(tasks: Task[] = [], health?: Basic) {
    this.tasks = structuredClone(tasks);
    this.health = health ? { ...structuredClone(health), id: "watcher-health" } : undefined;
  }

  async search<T extends Resource>(resourceType: T["resourceType"]): Promise<Bundle<T>> {
    const rows = resourceType === "Task" ? this.tasks : this.health ? [this.health] : [];
    return {
      resourceType: "Bundle",
      type: "searchset",
      entry: rows.map((resource) => ({ resource: structuredClone(resource) as T })),
    };
  }

  async create<T extends Resource>(resource: T, headers?: Record<string, string>): Promise<T> {
    if (resource.resourceType === "Task") {
      this.createHeaders.push(headers);
      const conditionKey = (resource as Task).identifier?.[0]?.value;
      const existing = headers?.["If-None-Exist"]
        ? this.tasks.find((candidate) => candidate.identifier?.[0]?.value === conditionKey)
        : undefined;
      if (existing) return structuredClone(existing) as T;
      const created = { ...structuredClone(resource as Task), id: `task-${this.tasks.length + 1}` };
      this.tasks.push(created);
      return structuredClone(created) as T;
    }
    const created = { ...structuredClone(resource as Basic), id: "watcher-health" };
    this.health = created;
    return structuredClone(created) as T;
  }

  async update<T extends Resource>(_resourceType: T["resourceType"], id: string, resource: T): Promise<T> {
    if (resource.resourceType === "Task") {
      const index = this.tasks.findIndex((candidate) => candidate.id === id);
      this.tasks[index] = structuredClone(resource as Task);
      this.taskUpdateCount += 1;
      return structuredClone(resource);
    }
    this.health = structuredClone(resource as Basic);
    return structuredClone(resource);
  }
}
