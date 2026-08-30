import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import test from "node:test";
import type { Basic, Bundle, Resource, Task } from "@medplum/fhirtypes";
import express from "express";
import { createWatcherRegistry } from "../src/watchers/watcher-registry.js";
import { buildWatcherHealthResource } from "../src/watchers/watcher-health.js";
import {
  projectFrontDeskAlerts,
  projectTodayDigest,
} from "../src/watchers/watcher-projections.js";
import { applyWatcherTaskAction, registerWatcherRoutes } from "../src/watchers/watcher-routes.js";
import { buildWatcherTask } from "../src/watchers/watcher-task.js";
import type { WatcherDefinition, WatcherMatch, WatcherPracticeConfig } from "../src/watchers/watcher-types.js";

const definition: WatcherDefinition = {
  id: "W1",
  question: "Which patients on today's schedule have an open balance?",
  firingRule: async () => [],
  owner: "front-desk",
  nextAction: { label: "View balance & collect", href: (match) => `/frontdesk?appointmentId=${match.appointmentReference.split("/")[1]}` },
  consequence: "Collecting at check-in works better than another statement.",
  register: "front-desk",
  dismissalReasons: [
    { code: "already-collected", display: "Already collected" },
    { code: "payment-plan", display: "Payment plan" },
    { code: "waived", display: "Waived" },
  ],
  activation: "immediate",
  seedSettings: { enabled: true, severity: "today", minimumBalanceCents: 1 },
};
const registry = createWatcherRegistry([definition]);
const config: WatcherPracticeConfig = {
  version: 1,
  goLiveAt: "2026-08-01T00:00:00.000Z",
  needsHumanCap: 5,
  staleAfterMinutes: 15,
  watchers: { W1: { enabled: true, severity: "today", minimumBalanceCents: 1 } },
};
const healthy = {
  lastAttemptAt: "2026-08-30T12:00:00.000Z",
  lastSuccessfulAt: "2026-08-30T12:00:00.000Z",
  outcome: "healthy" as const,
};

test("Today ranks eligible Tasks, caps at persisted five, groups overflow, and compares count beside dollars", () => {
  const today = Array.from({ length: 8 }, (_, index) => watcherTask(index + 1, "2026-08-30", (index + 1) * 1000, index + 1));
  const yesterday = [watcherTask(20, "2026-08-29", 2500, 20), watcherTask(21, "2026-08-29", 3500, 21)];

  const result = projectTodayDigest({
    tasks: [...today, ...yesterday, { resourceType: "Task", id: "unrelated", status: "requested", intent: "order" }], config, registry, health: healthy,
    date: "2026-08-30", previousDate: "2026-08-29", now: "2026-08-30T12:01:00.000Z",
  });

  assert.equal(result.status, "healthy");
  if (result.status !== "healthy") return;
  assert.equal(result.items.length, 5);
  assert.deepEqual(result.items.map((item) => item.balanceCents), [8000, 7000, 6000, 5000, 4000]);
  assert.deepEqual(result.overflow, { total: 3, groups: [{ watcherId: "W1", count: 3 }] });
  assert.deepEqual(result.sinceYesterday, {
    today: { patientCount: 8, dollarsCents: 36000 },
    yesterday: { patientCount: 2, dollarsCents: 6000 },
    delta: { patientCount: 6, dollarsCents: 30000 },
  });
});

test("failed and stale health suppress otherwise valid Tasks on both projections", () => {
  const tasks = [watcherTask(1, "2026-08-30", 13200, 173)];
  const states = [
    { ...healthy, outcome: "failed" as const, failureDetail: "worker stopped" },
    { ...healthy, lastSuccessfulAt: "2026-08-30T11:30:00.000Z" },
  ];

  for (const health of states) {
    const frontdesk = projectFrontDeskAlerts({ tasks, config, registry, health, now: "2026-08-30T12:01:00.000Z" });
    const today = projectTodayDigest({ tasks, config, registry, health, date: "2026-08-30", previousDate: "2026-08-29", now: "2026-08-30T12:01:00.000Z" });
    assert.equal(frontdesk.status, "degraded");
    assert.equal(today.status, "degraded");
    assert.equal("alerts" in frontdesk, false);
    assert.equal("items" in today, false);
    assert.equal(frontdesk.lastSuccessfulAt, health.lastSuccessfulAt);
  }
});

test("watcher read routes return structured 503 degradation and never serialize stale alerts", async () => {
  const task = watcherTask(1, "2026-08-30", 13200, 173);
  const fhir = new RouteFhir([task], buildWatcherHealthResource({
    lastAttemptAt: "2026-08-30T12:00:00.000Z",
    lastSuccessfulAt: "2026-08-30T11:55:00.000Z",
    outcome: "failed",
    failureDetail: "Invoice pagination failed",
  }));
  const server = await startServer(fhir);
  try {
    for (const path of ["/watchers/frontdesk?date=2026-08-30", "/watchers/today?date=2026-08-30"]) {
      const response = await fetch(`${server.base}${path}`, { headers: { authorization: "Bearer staff" } });
      const body = await response.json() as Record<string, unknown>;
      assert.equal(response.status, 503);
      assert.equal(body.status, "degraded");
      assert.equal(body.lastSuccessfulAt, "2026-08-30T11:55:00.000Z");
      assert.equal("alerts" in body, false);
      assert.equal("items" in body, false);
    }
  } finally {
    await server.close();
  }
});

test("dismiss, snooze, reassign, and resolve update the same Task with validated fields", async () => {
  const fhir = new RouteFhir([
    watcherTask(1, "2026-08-30", 1000, 1),
    watcherTask(2, "2026-08-30", 2000, 2),
    watcherTask(3, "2026-08-30", 3000, 3),
    watcherTask(4, "2026-08-30", 4000, 4),
  ]);

  const dismissed = await applyWatcherTaskAction(fhir, registry, "task-1", { action: "dismiss", reason: "payment-plan" }, "2026-08-30T12:00:00.000Z", config);
  const snoozed = await applyWatcherTaskAction(fhir, registry, "task-2", { action: "snooze", until: "2026-08-30T14:00:00.000Z" }, "2026-08-30T12:00:00.000Z", config);
  const reassigned = await applyWatcherTaskAction(fhir, registry, "task-3", { action: "reassign", practitioner: "Practitioner/owner-1" }, "2026-08-30T12:00:00.000Z", config);
  const resolved = await applyWatcherTaskAction(fhir, registry, "task-4", {
    action: "resolve",
    patientReference: "Patient/patient-4",
  }, "2026-08-30T12:00:00.000Z", config);

  assert.equal(dismissed.status, "cancelled");
  assert.equal(dismissed.statusReason?.coding?.[0]?.code, "payment-plan");
  assert.equal(snoozed.status, "on-hold");
  assert.equal(snoozed.restriction?.period?.end, "2026-08-30T14:00:00.000Z");
  assert.equal(reassigned.owner?.reference, "Practitioner/owner-1");
  assert.equal(resolved.status, "completed");
  assert.deepEqual(fhir.tasks.map((task) => task.id), ["task-1", "task-2", "task-3", "task-4"]);
});

test("resolve refuses a collected Patient that does not own the watcher Task", async () => {
  const fhir = new RouteFhir([watcherTask(1, "2026-08-30", 1000, 1)]);

  await assert.rejects(
    () => applyWatcherTaskAction(fhir, registry, "task-1", {
      action: "resolve",
      patientReference: "Patient/another-patient",
    }, "2026-08-30T12:00:00.000Z", config),
    /Collected Patient does not match watcher Task\/task-1/,
  );
  assert.equal(fhir.tasks[0]?.status, "requested");
});

test("resolve keeps the Task open while its watcher condition still matches", async () => {
  const task = watcherTask(1, "2026-08-30", 1000, 1);
  const activeDefinition = {
    ...definition,
    firingRule: async () => [{
      watcherId: "W1",
      conditionKey: "W1:Appointment/appt-1",
      patientReference: "Patient/patient-1",
      patientDisplay: "Patient 1",
      appointmentReference: "Appointment/appt-1",
      appointmentAt: "2026-08-30T09:40:00-04:00",
      frontDeskMessage: "Patient 1 has a balance.",
      ownerMessage: "Patient 1 carries a balance.",
      balanceCents: 500,
      ageDays: 1,
      sourceOccurredAt: "2026-03-10T14:00:00.000Z",
      sourceInvoiceCount: 1,
    }],
  } satisfies WatcherDefinition;
  const fhir = new RouteFhir([task]);

  await assert.rejects(
    () => applyWatcherTaskAction(
      fhir,
      createWatcherRegistry([activeDefinition]),
      "task-1",
      { action: "resolve", patientReference: "Patient/patient-1" },
      "2026-08-30T12:00:00.000Z",
      config,
      "America/New_York",
    ),
    /still has an active condition/,
  );
  assert.equal(fhir.tasks[0]?.status, "requested");
});

test("Today and front-desk routes default and project on the practice calendar day", async () => {
  const task = watcherTask(1, "2026-08-30", 1000, 1);
  task.restriction = { period: { start: "2026-08-31T01:30:00.000Z" } };
  const fhir = new RouteFhir([task], buildWatcherHealthResource({
    lastAttemptAt: "2026-08-31T01:29:00.000Z",
    lastSuccessfulAt: "2026-08-31T01:29:00.000Z",
    outcome: "healthy",
  }));
  const server = await startServer(fhir, {
    now: "2026-08-31T01:30:00.000Z",
    timeZone: "America/New_York",
  });
  try {
    const response = await fetch(`${server.base}/watchers/today`, {
      headers: { authorization: "Bearer staff" },
    });
    const body = await response.json() as { status: string; items?: unknown[] };
    assert.equal(response.status, 200);
    assert.equal(body.status, "healthy");
    assert.equal(body.items?.length, 1);

    const frontdeskResponse = await fetch(`${server.base}/watchers/frontdesk?date=2026-08-30`, {
      headers: { authorization: "Bearer staff" },
    });
    const frontdesk = await frontdeskResponse.json() as { status: string; alerts?: unknown[] };
    assert.equal(frontdeskResponse.status, 200);
    assert.equal(frontdesk.status, "healthy");
    assert.equal(frontdesk.alerts?.length, 1);
  } finally {
    await server.close();
  }
});

function watcherTask(index: number, date: string, balanceCents: number, ageDays: number): Task {
  const match: WatcherMatch = {
    watcherId: "W1",
    conditionKey: `W1:Appointment/appt-${index}`,
    patientReference: `Patient/patient-${index}`,
    patientDisplay: `Patient ${index}`,
    appointmentReference: `Appointment/appt-${index}`,
    appointmentAt: `${date}T09:40:00-04:00`,
    frontDeskMessage: `Patient ${index} has a balance.`,
    ownerMessage: `Patient ${index} carries a balance.`,
    balanceCents,
    ageDays,
    sourceOccurredAt: "2026-03-10T14:00:00.000Z",
    sourceInvoiceCount: 1,
  };
  return { ...buildWatcherTask(definition, match, "today", `${date}T08:00:00-04:00`), id: `task-${index}` };
}

class RouteFhir {
  tasks: Task[];
  constructor(tasks: Task[] = [], readonly health?: Basic) { this.tasks = structuredClone(tasks); }
  async search<T extends Resource>(resourceType: T["resourceType"]): Promise<Bundle<T>> {
    const rows = resourceType === "Task" ? this.tasks : this.health ? [this.health] : [];
    return { resourceType: "Bundle", type: "searchset", entry: rows.map((resource) => ({ resource: structuredClone(resource) as T })) };
  }
  async read<T extends Resource>(_resourceType: T["resourceType"], id: string): Promise<T> {
    const task = this.tasks.find((candidate) => candidate.id === id);
    if (!task) throw new Error("Task not found");
    return structuredClone(task) as T;
  }
  async update<T extends Resource>(_resourceType: T["resourceType"], id: string, resource: T): Promise<T> {
    const index = this.tasks.findIndex((candidate) => candidate.id === id);
    this.tasks[index] = structuredClone(resource as Task);
    return structuredClone(resource);
  }
}

async function startServer(
  fhir: RouteFhir,
  options: { now?: string; timeZone?: string } = {},
) {
  const app = express();
  app.use(express.json());
  registerWatcherRoutes(app, {
    authenticateService: async () => undefined,
    authenticate: async (header) => header ? { staffReference: "Practitioner/staff", fhir } : null,
    serviceFhir: fhir,
    registry,
    loadConfig: async () => config,
    now: () => options.now ?? "2026-08-30T12:01:00.000Z",
    timeZone: options.timeZone,
  });
  const listener = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => listener.once("listening", resolve));
  const port = (listener.address() as AddressInfo).port;
  return { base: `http://127.0.0.1:${port}`, close: () => new Promise<void>((resolve, reject) => listener.close((error) => error ? reject(error) : resolve())) };
}
