import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { test } from "node:test";
import express from "express";
import type { Bundle, Claim } from "@medplum/fhirtypes";
import { claimAgingThresholdsFromEnv, registerClaimFollowUpRoutes, type ClaimFollowUpStaff } from "../src/claims/claim-follow-up-routes.js";
import type { ClaimReadModelStore } from "../src/claims/claim-read-model-store.js";
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
  const body = {
    idempotencyKey: "touch-retry-20260830-001",
    action: "note",
    detail: "Called payer",
  };

  const first = await request(staff, body);
  const retry = await request(staff, body);

  assert.equal(claimTouchState(staff.currentClaim()).touchCount, 1);
  assert.equal(staff.provenanceWrites(), 1);
  assert.equal(first.status, 201);
  assert.equal(retry.status, 201);
  assert.equal((await first.json() as { readModelSynced: boolean }).readModelSynced, false);
  assert.equal((await retry.json() as { readModelSynced: boolean }).readModelSynced, false);
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

  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: "Only an authenticated human practice principal may touch a claim." });
  assert.equal(writes, 0);
});

test("aging thresholds default to 30/60/90 and accept one validated configuration value", () => {
  assert.deepEqual(claimAgingThresholdsFromEnv(undefined), [30, 60, 90]);
  assert.deepEqual(claimAgingThresholdsFromEnv("45,75,120"), [45, 75, 120]);
  assert.throws(() => claimAgingThresholdsFromEnv("90,60,30"), /three ascending/);
});

async function request(staff: ClaimFollowUpStaff, body: unknown): Promise<Response> {
  const app = express();
  app.use(express.json());
  registerClaimFollowUpRoutes(app, {
    authenticateService: async () => undefined,
    authenticate: async () => staff,
    serviceFhir: staff.fhir,
    store: {} as ClaimReadModelStore,
    now: () => "2026-08-30T12:00:00.000Z",
  });
  const server = createServer(app);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    return await fetch(`http://127.0.0.1:${address.port}/claims/claim-1/touches`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    });
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
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
