import assert from "node:assert/strict";
import { test } from "node:test";
import { assertBusinessActionAllowed } from "../src/authz/roles.js";
import {
  paymentAdapterRegistrationsFromEnv,
  verifyMedplumStaffToken,
} from "../src/payments/payment-endpoint.js";

// --- RBAC: who may take a payment (business action gate, same pattern as audit.read) ---

test("front-desk and practice-admin hold the payment.charge business action", () => {
  assertBusinessActionAllowed("front-desk", "payment.charge");
  assertBusinessActionAllowed("practice-admin", "payment.charge");
});

test("clinician, auditor, and aesthetics-provider do NOT hold payment.charge", () => {
  for (const role of ["clinician", "auditor", "aesthetics-provider"] as const) {
    assert.throws(() => assertBusinessActionAllowed(role, "payment.charge"), /lacks business action/);
  }
});

// --- Adapter registrations from env (service-start configuration) ---

test("manual-cash is always registered; clover registers when its four env vars are present", () => {
  const registrations = paymentAdapterRegistrationsFromEnv({
    CLOVER_BASE_URL: "https://apisandbox.dev.clover.com",
    CLOVER_ACCESS_TOKEN: "tok",
    CLOVER_DEVICE_ID: "DEV1",
    CLOVER_POS_ID: "OSOD-Dispensary",
  });
  assert.deepEqual(
    registrations.map((r) => r.method).sort(),
    ["clover", "manual-cash"],
  );
  const clover = registrations.find((r) => r.method === "clover");
  assert.deepEqual(clover, {
    method: "clover",
    config: {
      baseUrl: "https://apisandbox.dev.clover.com",
      accessToken: "tok",
      deviceId: "DEV1",
      posId: "OSOD-Dispensary",
    },
  });
});

test("with no clover env, only manual-cash registers", () => {
  const registrations = paymentAdapterRegistrationsFromEnv({});
  assert.deepEqual(registrations.map((r) => r.method), ["manual-cash"]);
});

test("a partially configured clover fails fast at service start, naming the missing vars", () => {
  assert.throws(
    () => paymentAdapterRegistrationsFromEnv({ CLOVER_BASE_URL: "https://apisandbox.dev.clover.com" }),
    /CLOVER_ACCESS_TOKEN/,
  );
});

// --- Medplum token verification (authn: the forwarded UI token → staff identity) ---

function meTransport(status: number, body: unknown) {
  const calls: Array<{ url: string; auth: string | undefined }> = [];
  const fetchImpl = (async (url: unknown, init?: { headers?: Record<string, string> }) => {
    calls.push({ url: String(url), auth: init?.headers?.["Authorization"] });
    return { ok: status >= 200 && status < 300, status, json: async () => body, text: async () => "" };
  }) as typeof fetch;
  return { calls, fetchImpl };
}

test("a valid Bearer token resolves to the Practitioner staff reference via GET /auth/me", async () => {
  const { calls, fetchImpl } = meTransport(200, {
    profile: { resourceType: "Practitioner", id: "staff1" },
  });
  const staff = await verifyMedplumStaffToken({
    baseUrl: "http://localhost:8103",
    authHeader: "Bearer ui-token",
    fetchImpl,
  });
  assert.deepEqual(staff, { staffReference: "Practitioner/staff1" });
  assert.equal(calls[0].url, "http://localhost:8103/auth/me");
  assert.equal(calls[0].auth, "Bearer ui-token");
});

test("a missing or non-Bearer Authorization header resolves null without calling Medplum", async () => {
  const { calls, fetchImpl } = meTransport(200, {});
  assert.equal(
    await verifyMedplumStaffToken({ baseUrl: "http://x", authHeader: undefined, fetchImpl }),
    null,
  );
  assert.equal(
    await verifyMedplumStaffToken({ baseUrl: "http://x", authHeader: "Basic abc", fetchImpl }),
    null,
  );
  assert.equal(calls.length, 0);
});

test("a rejected token (non-2xx) resolves null", async () => {
  const { fetchImpl } = meTransport(401, { issue: [] });
  assert.equal(
    await verifyMedplumStaffToken({ baseUrl: "http://x", authHeader: "Bearer bad", fetchImpl }),
    null,
  );
});

test("a token whose profile is not a Practitioner/PractitionerRole resolves null (patients cannot take payments)", async () => {
  const { fetchImpl } = meTransport(200, { profile: { resourceType: "Patient", id: "p1" } });
  assert.equal(
    await verifyMedplumStaffToken({ baseUrl: "http://x", authHeader: "Bearer t", fetchImpl }),
    null,
  );
});
