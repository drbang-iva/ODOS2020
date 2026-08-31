import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import test from "node:test";
import type { Basic, Bundle, Resource, Task } from "@medplum/fhirtypes";
import express from "express";
import { assertBusinessActionAllowed, type PracticeRoleId } from "../src/authz/roles.js";
import type { EligibilitySweepStore } from "../src/jobs/eligibilitySweep.js";
import { createWatcherDefinitions, createWatcherRegistry } from "../src/watchers/watcher-registry.js";
import { buildWatcherHealthResource } from "../src/watchers/watcher-health.js";
import {
  projectFrontDeskAlerts,
  projectTodayDigest,
} from "../src/watchers/watcher-projections.js";
import { applyWatcherTaskAction, registerWatcherRoutes } from "../src/watchers/watcher-routes.js";
import { buildWatcherTask, WATCHER_CODE_SYSTEM } from "../src/watchers/watcher-task.js";
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

test("healthy projections ignore a code-system lookalike without a watcher condition identifier", () => {
  const lookalike: Task = {
    resourceType: "Task",
    id: "not-managed",
    status: "requested",
    intent: "order",
    code: { coding: [{ system: WATCHER_CODE_SYSTEM, code: "W999" }] },
  };

  const frontdesk = projectFrontDeskAlerts({
    tasks: [lookalike], config, registry, health: healthy, now: "2026-08-30T12:01:00.000Z",
  });
  const today = projectTodayDigest({
    tasks: [lookalike], config, registry, health: healthy,
    date: "2026-08-30", previousDate: "2026-08-29", now: "2026-08-30T12:01:00.000Z",
  });

  assert.equal(frontdesk.status, "healthy");
  assert.equal(today.status, "healthy");
  if (frontdesk.status === "healthy") assert.deepEqual(frontdesk.alerts, []);
  if (today.status === "healthy") assert.deepEqual(today.items, []);
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
  assert.deepEqual(fhir.updateHeaders.map((headers) => headers["If-Match"]), [
    'W/"1"', 'W/"1"', 'W/"1"', 'W/"1"',
  ]);
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

test("stale actions cannot resurrect cancelled or completed watcher Tasks", async () => {
  const cancelled = { ...watcherTask(1, "2026-08-30", 1000, 1), status: "cancelled" as const };
  const completed = { ...watcherTask(2, "2026-08-30", 1000, 1), status: "completed" as const };
  const fhir = new RouteFhir([cancelled, completed]);

  await assert.rejects(
    () => applyWatcherTaskAction(
      fhir,
      registry,
      "task-1",
      { action: "snooze", until: "2026-08-30T14:00:00.000Z" },
      "2026-08-30T12:00:00.000Z",
      config,
    ),
    /terminal and cannot accept another action/,
  );
  await assert.rejects(
    () => applyWatcherTaskAction(
      fhir,
      registry,
      "task-2",
      { action: "reassign", practitioner: "Practitioner/owner-1" },
      "2026-08-30T12:00:00.000Z",
      config,
    ),
    /terminal and cannot accept another action/,
  );
  assert.deepEqual(fhir.tasks.map((task) => task.status), ["cancelled", "completed"]);
});

test("snooze rejects parseable values that are not valid FHIR dateTimes with an explicit zone", async () => {
  for (const until of ["2026-08-31", "08/31/2026", "2026-08-31T09:00:00", "2026-02-31T09:00:00Z"]) {
    const fhir = new RouteFhir([watcherTask(1, "2026-08-30", 1000, 1)]);
    await assert.rejects(
      () => applyWatcherTaskAction(
        fhir,
        registry,
        "task-1",
        { action: "snooze", until },
        "2026-08-30T12:00:00.000Z",
        config,
      ),
      /must be an ISO dateTime/,
    );
    assert.equal(fhir.tasks[0]?.status, "requested");
  }
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

test("the production W1 definition carries its FHIR client into resolve re-evaluation", async () => {
  const evaluationFhir = new RouteFhir();
  const productionRegistry = createWatcherRegistry(
    createWatcherDefinitions(evaluationFhir, "America/New_York"),
  );
  const actionFhir = new RouteFhir([watcherTask(1, "2026-08-30", 1000, 1)]);

  const resolved = await applyWatcherTaskAction(
    actionFhir,
    productionRegistry,
    "task-1",
    { action: "resolve", patientReference: "Patient/patient-1" },
    "2026-08-30T12:00:00.000Z",
    config,
    "America/New_York",
  );

  assert.equal(resolved.status, "completed");
  assert.deepEqual(evaluationFhir.searches, ["Appointment"]);
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

test("front-desk keeps today's W1 available while tomorrow waits for sweep reconciliation", async () => {
  const task = watcherTask(1, "2026-08-30", 1000, 1);
  const fhir = new RouteFhir([task], buildWatcherHealthResource({
    lastAttemptAt: "2026-08-30T12:00:00.000Z",
    lastSuccessfulAt: "2026-08-30T12:00:00.000Z",
    outcome: "healthy",
  }));
  const eligibilitySweepStore: EligibilitySweepStore = {
    loadState: async (date) => ({
      date,
      status: "healthy",
      lastAttemptAt: "2026-08-30T12:05:00.000Z",
      lastSuccessfulAt: "2026-08-30T12:05:00.000Z",
      batchIds: ["batch-1"],
      expectedChecks: 1,
    }),
    saveState: async () => undefined,
    loadCandidates: async () => [],
    loadFindings: async () => [],
    replaceFindings: async () => undefined,
  };
  const server = await startServer(fhir, { eligibilitySweepStore });
  try {
    const today = await fetch(`${server.base}/watchers/frontdesk?date=2026-08-30`, {
      headers: { authorization: "Bearer staff" },
    });
    assert.equal(today.status, 200);
    assert.equal((await today.json() as { alerts?: unknown[] }).alerts?.length, 1);

    const tomorrow = await fetch(`${server.base}/watchers/frontdesk?date=2026-08-31`, {
      headers: { authorization: "Bearer staff" },
    });
    assert.equal(tomorrow.status, 503);
    assert.deepEqual(await tomorrow.json(), {
      status: "degraded",
      reason: "running",
      lastSuccessfulAt: "2026-08-30T12:05:00.000Z",
    });
  } finally {
    await server.close();
  }
});

test("watcher routes reject a caller without billing-context.read before service FHIR access", async () => {
  const fhir = new RouteFhir();
  const server = await startServer(fhir, { roles: [] });
  try {
    const response = await fetch(`${server.base}/watchers/today`, {
      headers: { authorization: "Bearer no-role" },
    });
    assert.equal(response.status, 403);
    assert.deepEqual(await response.json(), { error: "billing-context.read role required" });
    assert.deepEqual(fhir.searches, []);
    assert.equal(server.serviceAuthCalls(), 0);
  } finally {
    await server.close();
  }
});

test("watcher projections restrict paginated Task reads to the ODOS watcher code system", async () => {
  const fhir = new RouteFhir([], buildWatcherHealthResource({
    lastAttemptAt: "2026-08-30T12:00:00.000Z",
    lastSuccessfulAt: "2026-08-30T12:00:00.000Z",
    outcome: "healthy",
  }));
  const server = await startServer(fhir);
  try {
    const response = await fetch(`${server.base}/watchers/today`, {
      headers: { authorization: "Bearer staff" },
    });
    assert.equal(response.status, 200);
    assert.deepEqual(
      fhir.searchParams.find((entry) => entry.resourceType === "Task")?.params,
      { code: `${WATCHER_CODE_SYSTEM}|`, _count: "1000" },
    );
  } finally {
    await server.close();
  }
});

test("watcher actions require the dedicated write capability and leave the Task unchanged when denied", async () => {
  const fhir = new RouteFhir([watcherTask(1, "2026-08-30", 1000, 1)]);
  const server = await startServer(fhir, { roles: ["provider"] });
  try {
    const response = await fetch(`${server.base}/watchers/tasks/task-1/action`, {
      method: "POST",
      headers: { authorization: "Bearer billing-reader", "content-type": "application/json" },
      body: JSON.stringify({ action: "dismiss", reason: "payment-plan" }),
    });
    assert.equal(response.status, 403);
    assert.deepEqual(await response.json(), { error: "watchers.manage role required" });
    assert.equal(fhir.tasks[0]?.status, "requested");
  } finally {
    await server.close();
  }

  assert.doesNotThrow(() => assertBusinessActionAllowed("staff", "watchers.manage"));
  assert.doesNotThrow(() => assertBusinessActionAllowed("admin", "watchers.manage"));
  assert.throws(() => assertBusinessActionAllowed("provider", "watchers.manage"), /lacks business action/);
});

test("a concurrent Task change returns conflict instead of allowing a stale action to win", async () => {
  const fhir = new RouteFhir([watcherTask(1, "2026-08-30", 1000, 1)]);
  fhir.failNextUpdateStatus = 412;
  const server = await startServer(fhir);
  try {
    const response = await fetch(`${server.base}/watchers/tasks/task-1/action`, {
      method: "POST",
      headers: { authorization: "Bearer staff", "content-type": "application/json" },
      body: JSON.stringify({ action: "dismiss", reason: "payment-plan" }),
    });
    assert.equal(response.status, 409);
    assert.deepEqual(await response.json(), {
      error: "Watcher Task changed; refresh before trying again.",
    });
    assert.equal(fhir.tasks[0]?.status, "requested");
    assert.equal(fhir.updateHeaders[0]?.["If-Match"], 'W/"1"');
  } finally {
    await server.close();
  }
});

test("watcher actions reject an unrelated Task that borrows a watcher code value", async () => {
  const unrelated = watcherTask(1, "2026-08-30", 1000, 1);
  unrelated.code = { coding: [{ system: "https://example.test/not-watchers", code: "W1" }] };
  const fhir = new RouteFhir([unrelated]);

  await assert.rejects(
    () => applyWatcherTaskAction(
      fhir,
      registry,
      "task-1",
      { action: "dismiss", reason: "payment-plan" },
      "2026-08-30T12:00:00.000Z",
      config,
    ),
    /not an ODOS watcher Task/,
  );
  assert.equal(fhir.tasks[0]?.status, "requested");
});

test("watcher routes reject impossible calendar dates instead of normalizing them", async () => {
  const fhir = new RouteFhir();
  const server = await startServer(fhir);
  try {
    for (const path of ["/watchers/frontdesk?date=2026-02-31", "/watchers/today?date=2026-02-31"]) {
      const response = await fetch(`${server.base}${path}`, {
        headers: { authorization: "Bearer staff" },
      });
      assert.equal(response.status, 400);
      assert.deepEqual(await response.json(), { error: "Watcher date must be YYYY-MM-DD." });
    }
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
  return {
    ...buildWatcherTask(definition, match, "today", `${date}T08:00:00-04:00`),
    id: `task-${index}`,
    meta: { versionId: "1" },
  };
}

class RouteFhir {
  tasks: Task[];
  readonly searches: Resource["resourceType"][] = [];
  readonly searchParams: Array<{ resourceType: Resource["resourceType"]; params: unknown }> = [];
  readonly updateHeaders: Record<string, string>[] = [];
  failNextUpdateStatus?: number;
  constructor(tasks: Task[] = [], readonly health?: Basic) { this.tasks = structuredClone(tasks); }
  async search<T extends Resource>(resourceType: T["resourceType"], params?: unknown): Promise<Bundle<T>> {
    this.searches.push(resourceType);
    this.searchParams.push({ resourceType, params: structuredClone(params) });
    const rows = resourceType === "Task" ? this.tasks : this.health ? [this.health] : [];
    return { resourceType: "Bundle", type: "searchset", entry: rows.map((resource) => ({ resource: structuredClone(resource) as T })) };
  }
  async read<T extends Resource>(_resourceType: T["resourceType"], id: string): Promise<T> {
    const task = this.tasks.find((candidate) => candidate.id === id);
    if (!task) throw new Error("Task not found");
    return structuredClone(task) as T;
  }
  async update<T extends Resource>(
    _resourceType: T["resourceType"],
    id: string,
    resource: T,
    headers: Record<string, string> = {},
  ): Promise<T> {
    this.updateHeaders.push(structuredClone(headers));
    if (this.failNextUpdateStatus) {
      const status = this.failNextUpdateStatus;
      this.failNextUpdateStatus = undefined;
      throw Object.assign(new Error(`FHIR ${status}`), { status });
    }
    const index = this.tasks.findIndex((candidate) => candidate.id === id);
    const current = this.tasks[index];
    const expected = current?.meta?.versionId ? `W/"${current.meta.versionId}"` : undefined;
    if (!expected || headers["If-Match"] !== expected) {
      throw Object.assign(new Error("FHIR 412"), { status: 412 });
    }
    const stored = {
      ...structuredClone(resource as Task),
      meta: { ...resource.meta, versionId: String(Number(current.meta?.versionId) + 1) },
    } as T;
    this.tasks[index] = structuredClone(stored as Task);
    return structuredClone(stored);
  }
}

async function startServer(
  fhir: RouteFhir,
  options: {
    now?: string;
    timeZone?: string;
    roles?: PracticeRoleId[];
    eligibilitySweepStore?: EligibilitySweepStore;
  } = {},
) {
  const app = express();
  let serviceAuthCalls = 0;
  app.use(express.json());
  registerWatcherRoutes(app, {
    authenticateService: async () => { serviceAuthCalls += 1; },
    authenticate: async (header) => header ? {
      staffReference: "Practitioner/staff",
      roles: options.roles ?? ["staff"],
      fhir,
    } : null,
    serviceFhir: fhir,
    registry,
    loadConfig: async () => config,
    now: () => options.now ?? "2026-08-30T12:01:00.000Z",
    timeZone: options.timeZone,
    eligibilitySweepStore: options.eligibilitySweepStore,
  });
  const listener = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => listener.once("listening", resolve));
  const port = (listener.address() as AddressInfo).port;
  return {
    base: `http://127.0.0.1:${port}`,
    serviceAuthCalls: () => serviceAuthCalls,
    close: () => new Promise<void>((resolve, reject) => listener.close((error) => error ? reject(error) : resolve())),
  };
}
