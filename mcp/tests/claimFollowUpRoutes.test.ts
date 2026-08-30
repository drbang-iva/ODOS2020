import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { test } from "node:test";
import express from "express";
import type { Bundle, Claim } from "@medplum/fhirtypes";
import { claimAgingThresholdsFromEnv, registerClaimFollowUpRoutes, type ClaimFollowUpStaff } from "../src/claims/claim-follow-up-routes.js";
import type { ClaimReadModelStore } from "../src/claims/claim-read-model-store.js";
import type {
  ClaimProjectionStatus,
  ClaimReadModelProjectionHealthTracker,
} from "../src/claims/claim-read-model-health.js";
import { claimTouchState } from "../src/claims/claim-touch-ledger.js";

test("touch route derives the actor from the authenticated principal and ignores caller spoofing", async () => {
  let transaction: Bundle | undefined;
  const staff = fixtureStaff("staff", async (bundle) => { transaction = bundle; return bundle; });
  const response = await request(staff, {
    idempotencyKey: "touch-actor-20260830-001",
    action: "note", detail: "Called payer", actorReference: "Practitioner/spoofed", kind: "system",
  });

  assert.equal(response.status, 201);
  assert.equal((await response.json() as { readModelSynced: boolean }).readModelSynced, false);
  const provenance = transaction?.entry?.find((entry) => entry.resource?.resourceType === "Provenance")?.resource;
  assert.equal(provenance?.resourceType, "Provenance");
  assert.equal(provenance.agent[0].who.reference, "Practitioner/authenticated-staff");
});

test("retry after projection failure records one touch and one Provenance for one idempotency key", async () => {
  const staff = fixtureStaff("staff", async (bundle) => bundle);
  let failureMarks = 0;
  const projectionHealth = {
    ...healthyProjectionHealth(),
    fail: () => { failureMarks += 1; },
  };
  const body = {
    idempotencyKey: "touch-retry-20260830-001",
    action: "note",
    detail: "Called payer",
  };

  const first = await request(staff, body, projectionHealth);
  const retry = await request(staff, body, projectionHealth);

  assert.equal(claimTouchState(staff.currentClaim()).touchCount, 1);
  assert.equal(staff.provenanceWrites(), 1);
  assert.equal(first.status, 201);
  assert.equal(retry.status, 201);
  assert.equal((await first.json() as { readModelSynced: boolean }).readModelSynced, false);
  assert.equal((await retry.json() as { readModelSynced: boolean }).readModelSynced, false);
  assert.equal(failureMarks, 2);
});

test("reusing one idempotency key for different touch content is rejected without another write", async () => {
  const staff = fixtureStaff("staff", async (bundle) => bundle);
  const idempotencyKey = "touch-conflict-20260830-001";

  await request(staff, { idempotencyKey, action: "note", detail: "Called payer" });
  const conflict = await request(staff, { idempotencyKey, action: "note", detail: "Called patient" });

  assert.equal(conflict.status, 409);
  assert.equal(claimTouchState(staff.currentClaim()).touchCount, 1);
  assert.equal(staff.provenanceWrites(), 1);
});

test("touch endpoint requires an idempotency key before any FHIR write", async () => {
  const staff = fixtureStaff("staff", async (bundle) => bundle);
  const response = await request(staff, { action: "note", detail: "Called payer" });

  assert.equal(response.status, 400);
  assert.equal(staff.provenanceWrites(), 0);
});

test("a system or ERA principal cannot stamp a touch through the route", async () => {
  let writes = 0;
  const staff = fixtureStaff("system", async (bundle) => { writes += 1; return bundle; });
  const response = await request(staff, {
    idempotencyKey: "touch-system-20260830-001",
    action: "note",
    detail: "ERA worker",
  });

  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), { error: "claims.manage role required" });
  assert.equal(writes, 0);
});

test("a staff principal without claims.manage cannot read the worklist, rebuild, or administer reasons", async () => {
  let worklistCalls = 0;
  let fhirSearchCalls = 0;
  let reasonUpdates = 0;
  const staff = fixtureStaff("provider", async (bundle) => bundle);
  const app = express();
  app.use(express.json());
  registerClaimFollowUpRoutes(app, {
    authenticateService: async () => undefined,
    authenticate: async () => staff,
    serviceFhir: {
      ...staff.fhir,
      search: async () => {
        fhirSearchCalls += 1;
        return { resourceType: "Bundle", type: "searchset" };
      },
      update: async (_resourceType, _id, resource) => {
        reasonUpdates += 1;
        return resource;
      },
    },
    projectionHealth: healthyProjectionHealth(),
    store: {
      worklist: async () => {
        worklistCalls += 1;
        return [];
      },
    } as unknown as ClaimReadModelStore,
    now: () => "2026-08-30T12:00:00.000Z",
  });

  const responses = await withServer(app, async (origin) => Promise.all([
    fetch(`${origin}/claims/follow-up-worklist`),
    fetch(`${origin}/claims/read-model/rebuild`, { method: "POST" }),
    fetch(`${origin}/claims/reasons`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: "denied-test", display: "Denied test", resolutionPath: "Do not write" }),
    }),
  ]));

  assert.deepEqual(responses.map((response) => response.status), [403, 403, 403]);
  for (const response of responses) {
    assert.deepEqual(await response.json(), { error: "claims.manage role required" });
  }
  assert.equal(worklistCalls, 0);
  assert.equal(fhirSearchCalls, 0);
  assert.equal(reasonUpdates, 0);
});

test("worklist and metrics refuse to serve a failed projection as healthy data", async () => {
  let readCalls = 0;
  const staff = fixtureStaff("staff", async (bundle) => bundle);
  const failedProjection = {
    state: "failed" as const,
    lastAttemptAt: "2026-08-30T11:59:00.000Z",
    lastSuccessfulAt: "2026-08-30T11:50:00.000Z",
    lastFailureAt: "2026-08-30T11:59:00.000Z",
    staleAfterMs: 180_000,
  };
  let currentProjection: ClaimProjectionStatus = failedProjection;
  const app = express();
  app.use(express.json());
  registerClaimFollowUpRoutes(app, {
    authenticateService: async () => undefined,
    authenticate: async () => staff,
    serviceFhir: staff.fhir,
    projectionHealth: {
      begin: () => undefined,
      succeed: () => undefined,
      fail: () => undefined,
      status: () => currentProjection,
    },
    store: {
      worklist: async () => {
        readCalls += 1;
        return [];
      },
      neverPaidUntouchedMetric: async () => {
        readCalls += 1;
        return [];
      },
    } as unknown as ClaimReadModelStore,
    now: () => "2026-08-30T12:00:00.000Z",
  });

  const responses = await withServer(app, async (origin) => Promise.all([
    fetch(`${origin}/claims/follow-up-worklist`),
    fetch(`${origin}/claims/metrics/never-paid-untouched`),
  ]));

  assert.deepEqual(responses.map((response) => response.status), [503, 503]);
  for (const response of responses) {
    assert.deepEqual(await response.json(), {
      error: "Claim read model projection is failed; FHIR remains authoritative.",
      projection: failedProjection,
    });
  }
  assert.equal(readCalls, 0);

  const staleProjection = {
    ...failedProjection,
    state: "stale" as const,
    lastAttemptAt: "2026-08-30T11:55:00.000Z",
    lastSuccessfulAt: "2026-08-30T11:55:00.000Z",
    lastFailureAt: null,
  };
  currentProjection = staleProjection;
  const staleResponses = await withServer(app, async (origin) => Promise.all([
    fetch(`${origin}/claims/follow-up-worklist`),
    fetch(`${origin}/claims/metrics/never-paid-untouched`),
  ]));
  assert.deepEqual(staleResponses.map((response) => response.status), [503, 503]);
  for (const response of staleResponses) {
    assert.deepEqual(await response.json(), {
      error: "Claim read model projection is stale; FHIR remains authoritative.",
      projection: staleProjection,
    });
  }
  assert.equal(readCalls, 0);

  const healthyProjection = {
    ...failedProjection,
    state: "healthy" as const,
    lastAttemptAt: "2026-08-30T12:00:00.000Z",
    lastSuccessfulAt: "2026-08-30T12:00:00.000Z",
    lastFailureAt: null,
  };
  currentProjection = healthyProjection;
  const recovered = await withServer(app, (origin) => fetch(`${origin}/claims/follow-up-worklist`));
  assert.equal(recovered.status, 200);
  assert.deepEqual(await recovered.json(), { groups: [], projection: healthyProjection });
  assert.equal(readCalls, 1);
});

test("aging thresholds default to 30/60/90 and accept one validated configuration value", () => {
  assert.deepEqual(claimAgingThresholdsFromEnv(undefined), [30, 60, 90]);
  assert.deepEqual(claimAgingThresholdsFromEnv("45,75,120"), [45, 75, 120]);
  assert.throws(() => claimAgingThresholdsFromEnv("90,60,30"), /three ascending/);
});

async function request(
  staff: ClaimFollowUpStaff,
  body: unknown,
  projectionHealth: ClaimReadModelProjectionHealthTracker = healthyProjectionHealth(),
): Promise<Response> {
  const app = express();
  app.use(express.json());
  registerClaimFollowUpRoutes(app, {
    authenticateService: async () => undefined,
    authenticate: async () => staff,
    serviceFhir: staff.fhir,
    store: {} as ClaimReadModelStore,
    projectionHealth,
    now: () => "2026-08-30T12:00:00.000Z",
  });
  return withServer(app, async (origin) => fetch(`${origin}/claims/claim-1/touches`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  }));
}

async function withServer<T>(app: express.Express, action: (origin: string) => Promise<T>): Promise<T> {
  const server = createServer(app);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    return await action(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

function healthyProjectionHealth() {
  return {
    begin: () => undefined,
    succeed: () => undefined,
    fail: () => undefined,
    status: () => ({
      state: "healthy" as const,
      lastAttemptAt: "2026-08-30T12:00:00.000Z",
      lastSuccessfulAt: "2026-08-30T12:00:00.000Z",
      lastFailureAt: null,
      staleAfterMs: 180_000,
    }),
  };
}

function fixtureStaff(
  actorRole: ClaimFollowUpStaff["actorRole"],
  executeTransaction: (bundle: Bundle) => Promise<Bundle>,
): ClaimFollowUpStaff & { currentClaim(): Claim; provenanceWrites(): number } {
  let claim: Claim = {
    resourceType: "Claim", id: "claim-1", meta: { versionId: "1" }, status: "active", use: "claim",
    patient: { reference: "Patient/patient-1" }, created: "2026-06-01T12:00:00.000Z",
    provider: { reference: "Practitioner/provider-1" }, priority: { text: "normal" },
    insurer: { reference: "Organization/payer-1" }, type: { text: "professional" },
  };
  let provenanceWrites = 0;
  return {
    staffReference: "Practitioner/authenticated-staff",
    actorRole,
    currentClaim: () => structuredClone(claim),
    provenanceWrites: () => provenanceWrites,
    fhir: {
      baseUrl: "http://127.0.0.1:8103",
      read: async () => structuredClone(claim),
      search: async () => { throw new Error("projection intentionally unavailable after FHIR commit"); },
      searchUrl: async () => { throw new Error("not used"); },
      create: async (resource) => resource,
      update: async (_type, _id, resource) => resource,
      executeTransaction: async (bundle) => {
        const result = await executeTransaction(bundle);
        const updatedClaim = bundle.entry?.find((entry) => entry.resource?.resourceType === "Claim")?.resource;
        if (updatedClaim?.resourceType === "Claim") {
          claim = {
            ...structuredClone(updatedClaim),
            meta: { ...updatedClaim.meta, versionId: String(Number(claim.meta?.versionId ?? "0") + 1) },
          };
        }
        provenanceWrites += bundle.entry?.filter((entry) => entry.resource?.resourceType === "Provenance").length ?? 0;
        return result;
      },
    },
  };
}
