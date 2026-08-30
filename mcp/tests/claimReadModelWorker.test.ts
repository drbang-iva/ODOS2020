import assert from "node:assert/strict";
import { test } from "node:test";
import type { Bundle, Resource } from "@medplum/fhirtypes";
import { startClaimReadModelWorker } from "../src/claims/claim-read-model-worker.js";
import type { ClaimReadModelStore } from "../src/claims/claim-read-model-store.js";
import {
  ClaimReadModelProjectionHealth,
  claimProjectionStaleAfterMsFromEnv,
} from "../src/claims/claim-read-model-health.js";

const AT = "2026-08-30T12:00:00.000Z";

test("projection health distinguishes uninitialized, failed, stale, and recovered states", () => {
  const health = new ClaimReadModelProjectionHealth(180_000);
  assert.equal(health.status(AT).state, "uninitialized");

  health.begin("2026-08-30T11:55:00.000Z");
  health.fail("2026-08-30T11:55:00.000Z");
  assert.equal(health.status(AT).state, "failed");

  health.begin("2026-08-30T11:58:00.000Z");
  health.succeed("2026-08-30T11:58:00.000Z");
  assert.equal(health.status(AT).state, "healthy");
  assert.equal(health.status("2026-08-30T12:01:00.001Z").state, "stale");
  assert.equal(health.status("2026-08-30T12:01:00.001Z").lastFailureAt, null);

  assert.equal(claimProjectionStaleAfterMsFromEnv(undefined), 180_000);
  assert.equal(claimProjectionStaleAfterMsFromEnv("240000"), 240_000);
  assert.throws(() => claimProjectionStaleAfterMsFromEnv("0"), /positive whole number/);
});

test("projection worker records a failed attempt when FHIR paging cannot complete", async () => {
  const events: string[] = [];
  let releaseError!: () => void;
  const errorSeen = new Promise<void>((resolve) => { releaseError = resolve; });
  const stop = startClaimReadModelWorker({
    authenticateService: async () => undefined,
    fhir: {
      baseUrl: "http://localhost:8103/",
      search: async () => { throw new Error("FHIR paging failed"); },
      searchUrl: async () => { throw new Error("not reached"); },
    },
    store: {} as ClaimReadModelStore,
    projectionHealth: {
      begin: () => { events.push("begin"); },
      succeed: () => { events.push("succeed"); },
      fail: () => { events.push("fail"); },
      status: () => { throw new Error("not read"); },
    },
    now: () => AT,
    intervalMs: 60_000,
    onError: () => releaseError(),
  });
  try {
    await errorSeen;
    assert.deepEqual(events, ["begin", "fail"]);
  } finally {
    stop();
  }
});

test("projection worker marks success only after the complete rebuild commits", async () => {
  const events: string[] = [];
  let releaseRebuild!: () => void;
  const rebuilt = new Promise<void>((resolve) => { releaseRebuild = resolve; });
  const stop = startClaimReadModelWorker({
    authenticateService: async () => undefined,
    fhir: {
      baseUrl: "http://localhost:8103/",
      search: async <T extends Resource>(): Promise<Bundle<T>> => ({ resourceType: "Bundle", type: "searchset" }),
      searchUrl: async <T extends Resource>(): Promise<Bundle<T>> => ({ resourceType: "Bundle", type: "searchset" }),
    },
    store: {
      rebuild: async () => releaseRebuild(),
    } as unknown as ClaimReadModelStore,
    projectionHealth: {
      begin: () => { events.push("begin"); },
      succeed: () => { events.push("succeed"); },
      fail: () => { events.push("fail"); },
      status: () => { throw new Error("not read"); },
    },
    now: () => AT,
    intervalMs: 60_000,
  });
  try {
    await rebuilt;
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(events, ["begin", "succeed"]);
  } finally {
    stop();
  }
});
