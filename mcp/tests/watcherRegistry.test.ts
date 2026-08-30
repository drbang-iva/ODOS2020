import assert from "node:assert/strict";
import test from "node:test";
import type { Basic, Bundle } from "@medplum/fhirtypes";
import {
  createWatcherRegistry,
  WatcherRegistrationError,
} from "../src/watchers/watcher-registry.js";
import {
  buildWatcherConfigResource,
  loadOrSeedWatcherConfig,
  parseWatcherConfigResource,
} from "../src/watchers/watcher-config.js";
import type { WatcherDefinition } from "../src/watchers/watcher-types.js";

const validDefinition: WatcherDefinition = {
  id: "W1",
  question: "Which patients on today's schedule have an open balance?",
  firingRule: async () => [],
  owner: "front-desk",
  nextAction: {
    label: "View balance & collect",
    href: (match) => `/frontdesk?appointmentId=${match.appointmentReference.split("/")[1]}`,
  },
  consequence: "Collecting at check-in works far better than another statement.",
  register: "front-desk",
  dismissalReasons: [
    { code: "already-collected", display: "Already collected" },
    { code: "payment-plan", display: "Payment plan" },
    { code: "waived", display: "Waived" },
  ],
  activation: "immediate",
  seedSettings: {
    enabled: true,
    severity: "today",
    minimumBalanceCents: 1,
  },
};

test("watcher registration refuses a definition without an owner and names the failed rule", () => {
  const broken = { ...validDefinition, owner: "" } as WatcherDefinition;

  assert.throws(
    () => createWatcherRegistry([broken]),
    (error: unknown) => error instanceof WatcherRegistrationError
      && error.message === "W1 registration failed: owner is required.",
  );
});

test("watcher registration separately refuses a definition without its one next action", () => {
  const { nextAction: _missing, ...rest } = validDefinition;

  assert.throws(
    () => createWatcherRegistry([rest as WatcherDefinition]),
    (error: unknown) => error instanceof WatcherRegistrationError
      && error.message === "W1 registration failed: next action is required.",
  );
});

test("watcher registration rejects duplicate ids instead of making startup order decide the winner", () => {
  assert.throws(
    () => createWatcherRegistry([validDefinition, validDefinition]),
    /W1 registration failed: watcher id is already registered/,
  );
});

test("watcher practice config round-trips the persisted severity, cap, freshness, and W1 threshold", () => {
  const resource = buildWatcherConfigResource({
    version: 1,
    goLiveAt: "2026-03-04T13:00:00.000Z",
    needsHumanCap: 7,
    staleAfterMinutes: 12,
    watchers: {
      W1: {
        enabled: true,
        severity: "this-week",
        minimumBalanceCents: 2500,
      },
    },
  });

  assert.deepEqual(parseWatcherConfigResource(resource), {
    version: 1,
    goLiveAt: "2026-03-04T13:00:00.000Z",
    needsHumanCap: 7,
    staleAfterMinutes: 12,
    watchers: {
      W1: {
        enabled: true,
        severity: "this-week",
        minimumBalanceCents: 2500,
      },
    },
  });
});

test("first config load seeds one practice-owned Basic and later reads use its tuned data", async () => {
  const created: Basic[] = [];
  let persisted: Basic | undefined;
  const fhir = {
    async search(): Promise<Bundle<Basic>> {
      return {
        resourceType: "Bundle",
        type: "searchset",
        entry: persisted ? [{ resource: persisted }] : [],
      };
    },
    async create(resource: Basic): Promise<Basic> {
      created.push(resource);
      persisted = { ...resource, id: "watcher-config" };
      return persisted;
    },
  };
  const registry = createWatcherRegistry([validDefinition]);

  const seeded = await loadOrSeedWatcherConfig(fhir, registry, () => "2026-03-04T13:00:00.000Z");
  assert.equal(created.length, 1);
  assert.deepEqual(seeded.watchers.W1, {
    enabled: true,
    severity: "today",
    minimumBalanceCents: 1,
  });

  persisted = buildWatcherConfigResource({
    ...seeded,
    needsHumanCap: 3,
    watchers: { W1: { ...seeded.watchers.W1, severity: "watch", minimumBalanceCents: 9900 } },
  }, persisted);
  const tuned = await loadOrSeedWatcherConfig(fhir, registry, () => "2027-01-01T00:00:00.000Z");
  assert.equal(created.length, 1);
  assert.equal(tuned.needsHumanCap, 3);
  assert.equal(tuned.watchers.W1?.severity, "watch");
  assert.equal(tuned.watchers.W1?.minimumBalanceCents, 9900);
  assert.equal(tuned.goLiveAt, "2026-03-04T13:00:00.000Z");
});
