import assert from "node:assert/strict";
import { test } from "node:test";
import type { EligibilityFinding, EligibilitySweepStore } from "../src/jobs/eligibilitySweep.js";
import { createPreventWatcherDefinitions } from "../src/watchers/prevent-watchers.js";
import { createWatcherRegistry, WatcherRegistrationError } from "../src/watchers/watcher-registry.js";
import { projectBeforeVisitWork } from "../src/watchers/watcher-projections.js";
import { buildWatcherTask } from "../src/watchers/watcher-task.js";

const NOW = "2026-08-30T12:00:00.000Z";

function finding(watcherId: "W21" | "W22" | "W23", extra: Partial<EligibilityFinding> = {}): EligibilityFinding {
  return {
    key: `2026-08-31:appointment-1:coverage-1:${watcherId}`,
    watcherId,
    appointmentReference: "Appointment/appointment-1",
    appointmentAt: "2026-08-31T14:15:00.000Z",
    patientReference: "Patient/patient-1",
    patientDisplay: "Marcus T.",
    coverageReference: "Coverage/coverage-1",
    payerReference: "Organization/payer-1",
    payerDisplay: "Example Health",
    intendedPayerId: "PAYER1",
    sourceOccurredAt: NOW,
    ...extra,
  };
}

function store(findings: EligibilityFinding[], status: "healthy" | "failed" = "healthy"): EligibilitySweepStore {
  return {
    loadState: async (date) => ({
      date,
      status,
      lastAttemptAt: NOW,
      ...(status === "healthy" ? { lastSuccessfulAt: NOW } : {}),
      batchIds: ["batch-1"],
      expectedChecks: 1,
    }),
    saveState: async () => undefined,
    loadCandidates: async () => [],
    loadFindings: async () => findings,
    replaceFindings: async () => undefined,
  };
}

test("W21-W23 satisfy the existing grammar and preserve approved owner, severity, and register", () => {
  const definitions = createPreventWatcherDefinitions(store([]), "America/New_York");
  const registry = createWatcherRegistry(definitions);
  assert.deepEqual(registry.list().map((definition) => ({
    id: definition.id,
    owner: definition.owner,
    register: definition.register,
    severity: definition.seedSettings.severity,
    activation: definition.activation,
  })), [
    { id: "W21", owner: "front-desk", register: "front-desk", severity: "today", activation: "fixed-threshold" },
    { id: "W22", owner: "biller", register: "biller", severity: "this-week", activation: "fixed-threshold" },
    { id: "W23", owner: "front-desk", register: "front-desk", severity: "this-week", activation: "fixed-threshold" },
  ]);
});

test("a watcher from the Prevent slice missing a grammar element is refused by the unchanged 2A gate", () => {
  const [w21] = createPreventWatcherDefinitions(store([]), "America/New_York");
  assert.throws(
    () => createWatcherRegistry([{ ...w21!, consequence: "" }]),
    (error: unknown) => error instanceof WatcherRegistrationError
      && error.message === "W21 registration failed: plain-language consequence is required.",
  );
});

test("prevent findings become watcher matches and unavailable sweep evidence never becomes an all-clear", async () => {
  const values = [
    finding("W21", { eligibilityCheckResult: "INACTIVE" }),
    finding("W22", { cob: { status: "could-not-check", reason: "unknown" } }),
    finding("W23", { aaaCodes: ["72"], memberIdProposal: { current: "CHART-1", proposed: "PAYER-2", source: "insurance-discovery" } }),
  ];
  const definitions = createPreventWatcherDefinitions(store(values), "America/New_York");
  const settings = { enabled: true, severity: "today" as const };
  const matches = (await Promise.all(definitions.map((definition) => definition.firingRule({
    now: NOW,
    date: "2026-08-30",
    settings,
  })))).flat();
  assert.deepEqual(matches.map((match) => match.watcherId), ["W21", "W22", "W23"]);
  assert.match(matches[0]!.frontDeskMessage, /insurance shows as inactive/i);
  assert.match(matches[1]!.ownerMessage, /could not check payer order/i);
  assert.match(matches[2]!.frontDeskMessage, /proposed correction/i);
  assert.equal(matches[2]!.memberIdProposal?.proposed, "PAYER-2");

  const unavailable = createPreventWatcherDefinitions(store(values, "failed"), "America/New_York");
  assert.deepEqual(await unavailable[0]!.firingRule({ now: NOW, date: "2026-08-30", settings }), []);
});

test("an undeterminable W21 never reads as failed and explicitly refuses an all-clear", async () => {
  const [definition] = createPreventWatcherDefinitions(store([finding("W21")]), "America/New_York");
  const [match] = await definition!.firingRule({
    now: NOW,
    date: "2026-08-30",
    settings: { enabled: true, severity: "today" },
  });

  assert.equal(match?.reasonCode, "eligibility-undeterminable");
  assert.match(match?.frontDeskMessage ?? "", /could not reach the payer/i);
  assert.match(match?.ownerMessage ?? "", /not an all-clear/i);
  assert.doesNotMatch(`${match?.frontDeskMessage} ${match?.ownerMessage} ${match?.reasonCode}`, /fail/i);
});

test("Before the visit groups healthy Tasks by reason while unrun sweep state exposes no reassuring groups", async () => {
  const values = [
    finding("W21", { eligibilityCheckResult: "INACTIVE" }),
    finding("W23", { aaaCodes: ["72"] }),
  ];
  const definitions = createPreventWatcherDefinitions(store(values), "America/New_York");
  const registry = createWatcherRegistry(definitions);
  const settings = { enabled: true, severity: "today" as const };
  const tasks = (await Promise.all(definitions.map(async (definition) => {
    const matches = await definition.firingRule({ now: NOW, date: "2026-08-30", settings });
    return matches.map((match) => buildWatcherTask(definition, match, definition.seedSettings.severity, NOW));
  }))).flat().map((task, index) => ({ ...task, id: `task-${index + 1}` }));
  const config = {
    version: 1 as const,
    goLiveAt: "2026-08-01T00:00:00.000Z",
    needsHumanCap: 10,
    staleAfterMinutes: 15,
    watchers: Object.fromEntries(definitions.map((definition) => [definition.id, definition.seedSettings])),
  };
  const health = { lastAttemptAt: NOW, lastSuccessfulAt: NOW, outcome: "healthy" as const };

  const degraded = projectBeforeVisitWork({ tasks, config, registry, health, sweepState: undefined, date: "2026-08-31", now: NOW });
  assert.deepEqual(degraded, { status: "degraded", reason: "never-run" });
  assert.equal("groups" in degraded, false);

  const healthy = projectBeforeVisitWork({
    tasks,
    config,
    registry,
    health,
    sweepState: { date: "2026-08-31", status: "healthy", lastAttemptAt: NOW, lastSuccessfulAt: NOW, batchIds: ["batch-1"], expectedChecks: 1 },
    date: "2026-08-31",
    now: NOW,
  });
  assert.equal(healthy.status, "healthy");
  if (healthy.status !== "healthy") return;
  assert.equal(healthy.count, 2);
  assert.deepEqual(healthy.groups.map((group) => group.watcherId), ["W21", "W23"]);
  assert.deepEqual(healthy.groups.map((group) => group.count), [1, 1]);
});
