import assert from "node:assert/strict";
import { test } from "node:test";
import type { AccessPolicy, Bundle, ProjectMembership } from "@medplum/fhirtypes";
import { assertBusinessActionAllowed, OSOD_PRACTICE_ROLE_SYSTEM } from "../src/authz/roles.js";
import {
  paymentAdapterRegistrationsFromEnv,
  resolveStaffRole,
  resolveStaffRoles,
  StaffRoleServiceUnavailableError,
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

test("stripe registers from a test secret, defaulting its API base URL", () => {
  const registrations = paymentAdapterRegistrationsFromEnv({
    STRIPE_SECRET_KEY: "sk_test_env_fixture",
  });
  assert.deepEqual(registrations.find((r) => r.method === "stripe"), {
    method: "stripe",
    config: {
      baseUrl: "https://api.stripe.com",
      secretKey: "sk_test_env_fixture",
    },
  });
});

test("a Stripe base URL without its secret fails fast at service start", () => {
  assert.throws(
    () => paymentAdapterRegistrationsFromEnv({ STRIPE_BASE_URL: "https://api.stripe.com" }),
    /STRIPE_SECRET_KEY/,
  );
});

test("Stripe env registration rejects live keys and non-HTTPS secret destinations", () => {
  assert.throws(
    () => paymentAdapterRegistrationsFromEnv({ STRIPE_SECRET_KEY: "sk_live_forbidden" }),
    /test-mode/,
  );
  assert.throws(
    () =>
      paymentAdapterRegistrationsFromEnv({
        STRIPE_SECRET_KEY: "sk_test_env_fixture",
        STRIPE_BASE_URL: "http://stripe-proxy.test",
      }),
    /HTTPS/,
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

// --- resolveStaffRole: identity-derived role from the bound AccessPolicy (decision 2026-07-05 §3) ---

function frontDeskPolicy(): AccessPolicy {
  return {
    resourceType: "AccessPolicy",
    id: "ap-front-desk",
    name: "OSOD Front Desk",
    meta: { tag: [{ system: OSOD_PRACTICE_ROLE_SYSTEM, code: "front-desk" }] },
  };
}

function serviceClient(opts: { membership?: ProjectMembership | null; policy?: AccessPolicy | null }) {
  const calls = { search: [] as unknown[], read: [] as unknown[] };
  return {
    calls,
    search: async <T,>(rt: string, params?: Record<string, string>): Promise<Bundle<T>> => {
      calls.search.push({ rt, params });
      const entry = opts.membership ? [{ resource: opts.membership as unknown as T }] : [];
      return { resourceType: "Bundle", type: "searchset", entry } as Bundle<T>;
    },
    read: async <T,>(rt: string, id: string): Promise<T> => {
      calls.read.push({ rt, id });
      if (!opts.policy) throw new Error(`AccessPolicy/${id} not found`);
      return opts.policy as unknown as T;
    },
  };
}

const MEMBERSHIP_FRONT_DESK: ProjectMembership = {
  resourceType: "ProjectMembership",
  user: { reference: "User/u1" },
  profile: { reference: "Practitioner/staff1" },
  project: { reference: "Project/p1" },
  access: [{ policy: { reference: "AccessPolicy/ap-front-desk" } }],
};

test("resolveStaffRole derives the role from the caller's bound AccessPolicy identifier (service-client lookup)", async () => {
  const { fetchImpl } = meTransport(200, { profile: { resourceType: "Practitioner", id: "staff1" } });
  const svc = serviceClient({ membership: MEMBERSHIP_FRONT_DESK, policy: frontDeskPolicy() });
  const staff = await resolveStaffRole({
    baseUrl: "http://localhost:8103",
    authHeader: "Bearer good",
    serviceClient: svc,
    fetchImpl,
  });
  assert.deepEqual(staff, { staffReference: "Practitioner/staff1", role: "front-desk" });
  assert.deepEqual(svc.calls.search[0], {
    rt: "ProjectMembership",
    params: { profile: "Practitioner/staff1" },
  });
  assert.deepEqual(svc.calls.read[0], { rt: "AccessPolicy", id: "ap-front-desk" });
});

test("resolveStaffRole refreshes an expired service client once and retries the shared role lookup", async () => {
  const { fetchImpl } = meTransport(200, { profile: { resourceType: "Practitioner", id: "staff1" } });
  let expired = true;
  let refreshes = 0;
  const serviceClient = {
    search: async <T,>(): Promise<Bundle<T>> => {
      if (expired) throw Object.assign(new Error("FHIR 401 Unauthorized: Unauthorized"), { status: 401 });
      return { resourceType: "Bundle", type: "searchset", entry: [{ resource: MEMBERSHIP_FRONT_DESK as unknown as T }] };
    },
    read: async <T,>(): Promise<T> => frontDeskPolicy() as unknown as T,
  };

  const staff = await resolveStaffRole({
    baseUrl: "http://x",
    authHeader: "Bearer good",
    serviceClient,
    fetchImpl,
    refreshServiceClient: async () => {
      refreshes += 1;
      expired = false;
    },
  });

  assert.deepEqual(staff, { staffReference: "Practitioner/staff1", role: "front-desk" });
  assert.equal(refreshes, 1);
});

test("resolveStaffRole reports a service outage when refresh cannot recover an expired token", async () => {
  const { fetchImpl } = meTransport(200, { profile: { resourceType: "Practitioner", id: "staff1" } });
  const unauthorized = Object.assign(new Error("FHIR 401 Unauthorized: Unauthorized"), { status: 401 });
  const serviceClient = {
    search: async <T,>(): Promise<Bundle<T>> => { throw unauthorized; },
    read: async <T,>(): Promise<T> => { throw unauthorized; },
  };

  await assert.rejects(
    resolveStaffRole({
      baseUrl: "http://x",
      authHeader: "Bearer good",
      serviceClient,
      fetchImpl,
      refreshServiceClient: async () => undefined,
    }),
    StaffRoleServiceUnavailableError,
  );
});

test("resolveStaffRole returns null for an invalid token and never reaches the service client", async () => {
  const { fetchImpl } = meTransport(401, {});
  const svc = serviceClient({ membership: MEMBERSHIP_FRONT_DESK, policy: frontDeskPolicy() });
  assert.equal(
    await resolveStaffRole({ baseUrl: "http://x", authHeader: "Bearer bad", serviceClient: svc, fetchImpl }),
    null,
  );
  assert.equal(svc.calls.search.length, 0);
});

test("resolveStaffRole returns null when the caller has no ProjectMembership", async () => {
  const { fetchImpl } = meTransport(200, { profile: { resourceType: "Practitioner", id: "staff1" } });
  const svc = serviceClient({ membership: null });
  assert.equal(
    await resolveStaffRole({ baseUrl: "http://x", authHeader: "Bearer good", serviceClient: svc, fetchImpl }),
    null,
  );
});

test("resolveStaffRole returns null when the AccessPolicy carries no practice-role identifier (cannot determine role -> deny)", async () => {
  const { fetchImpl } = meTransport(200, { profile: { resourceType: "Practitioner", id: "staff1" } });
  const svc = serviceClient({
    membership: MEMBERSHIP_FRONT_DESK,
    policy: { resourceType: "AccessPolicy", id: "ap-front-desk", name: "OSOD Front Desk" },
  });
  assert.equal(
    await resolveStaffRole({ baseUrl: "http://x", authHeader: "Bearer good", serviceClient: svc, fetchImpl }),
    null,
  );
});

test("resolveStaffRole also reads the legacy single accessPolicy binding", async () => {
  const { fetchImpl } = meTransport(200, { profile: { resourceType: "Practitioner", id: "staff1" } });
  const legacyMembership: ProjectMembership = {
    resourceType: "ProjectMembership",
    user: { reference: "User/u1" },
    profile: { reference: "Practitioner/staff1" },
    project: { reference: "Project/p1" },
    accessPolicy: { reference: "AccessPolicy/ap-front-desk" },
  };
  const svc = serviceClient({ membership: legacyMembership, policy: frontDeskPolicy() });
  const staff = await resolveStaffRole({ baseUrl: "http://x", authHeader: "Bearer good", serviceClient: svc, fetchImpl });
  assert.equal(staff?.role, "front-desk");
});

test("resolveStaffRoles returns every recognized practice-role tag across the caller's policy bindings", async () => {
  const { fetchImpl } = meTransport(200, {
    profile: { resourceType: "Practitioner", id: "staff1" },
    user: { resourceType: "User", id: "u1", email: "staff@example.test" },
  });
  const membership: ProjectMembership = {
    ...MEMBERSHIP_FRONT_DESK,
    access: [
      { policy: { reference: "AccessPolicy/ap-clinical" } },
      { policy: { reference: "AccessPolicy/ap-desk" } },
    ],
  };
  const policies: Record<string, AccessPolicy> = {
    "ap-clinical": {
      resourceType: "AccessPolicy",
      meta: { tag: [
        { system: OSOD_PRACTICE_ROLE_SYSTEM, code: "clinician" },
        { system: OSOD_PRACTICE_ROLE_SYSTEM, code: "aesthetics-provider" },
      ] },
    },
    "ap-desk": {
      resourceType: "AccessPolicy",
      meta: { tag: [
        { system: "https://example.test/unrelated", code: "front-desk" },
        { system: OSOD_PRACTICE_ROLE_SYSTEM, code: "front-desk" },
      ] },
    },
  };
  const serviceClient = {
    search: async <T,>(): Promise<Bundle<T>> => ({ resourceType: "Bundle", type: "searchset", entry: [{ resource: membership as unknown as T }] }),
    read: async <T,>(_resourceType: string, id: string): Promise<T> => policies[id] as unknown as T,
  };

  const staff = await resolveStaffRoles({
    baseUrl: "http://x",
    authHeader: "Bearer good",
    serviceClient,
    fetchImpl,
  });
  assert.deepEqual(staff, {
    staffReference: "Practitioner/staff1",
    email: "staff@example.test",
    roles: ["clinician", "front-desk", "aesthetics-provider"],
  });
});

test("resolveStaffRoles preserves authenticated identity when no role-bearing policy exists", async () => {
  const { fetchImpl } = meTransport(200, {
    profile: { resourceType: "Practitioner", id: "staff1" },
    user: { resourceType: "User", id: "u1", email: "roleless@example.test" },
  });
  const svc = serviceClient({ membership: null });
  const staff = await resolveStaffRoles({
    baseUrl: "http://x",
    authHeader: "Bearer good",
    serviceClient: svc,
    fetchImpl,
  });
  assert.deepEqual(staff, {
    staffReference: "Practitioner/staff1",
    email: "roleless@example.test",
    roles: [],
  });
});
