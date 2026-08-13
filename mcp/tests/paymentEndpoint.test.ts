import assert from "node:assert/strict";
import { test } from "node:test";
import type { AccessPolicy, Bundle, ProjectMembership } from "@medplum/fhirtypes";
import {
  assertBusinessActionAllowed,
  ODOS_PRACTICE_ROLE_SYSTEM,
  resolveBusinessActionRole,
} from "../src/authz/roles.js";
import {
  authenticateStaffRoute,
  paymentAdapterRegistrationsFromEnv,
  resolveStaffRoles,
  verifyMedplumStaffToken,
} from "../src/payments/payment-endpoint.js";

// --- RBAC: who may take a payment (business action gate, same pattern as audit.read) ---

test("front-desk and practice-admin hold the payment.charge business action", () => {
  assertBusinessActionAllowed("front-desk", "payment.charge");
  assertBusinessActionAllowed("practice-admin", "payment.charge");
});

test("only front-desk and practice-admin hold payment.seal-day", () => {
  assertBusinessActionAllowed("front-desk", "payment.seal-day");
  assertBusinessActionAllowed("practice-admin", "payment.seal-day");
  for (const role of ["clinician", "auditor", "aesthetics-provider"] as const) {
    assert.throws(() => assertBusinessActionAllowed(role, "payment.seal-day"), /lacks business action/);
  }
});

test("clinician, auditor, and aesthetics-provider do NOT hold payment.charge", () => {
  for (const role of ["clinician", "auditor", "aesthetics-provider"] as const) {
    assert.throws(() => assertBusinessActionAllowed(role, "payment.charge"), /lacks business action/);
  }
});

test("business-action acting roles are selected from the full set in registry order", () => {
  const roles = ["clinician", "front-desk", "practice-admin"] as const;
  assert.equal(resolveBusinessActionRole(roles, "chart.write"), "clinician");
  assert.equal(resolveBusinessActionRole(roles, "payment.charge"), "practice-admin");
  assert.equal(resolveBusinessActionRole(roles, "claims.manage"), "practice-admin");
  assert.equal(resolveBusinessActionRole(["clinician"], "claims.manage"), undefined);
});

// --- Adapter registrations from env (service-start configuration) ---

test("manual-cash is always registered; clover registers when its four env vars are present", () => {
  const registrations = paymentAdapterRegistrationsFromEnv({
    CLOVER_BASE_URL: "https://apisandbox.dev.clover.com",
    CLOVER_ACCESS_TOKEN: "tok",
    CLOVER_DEVICE_ID: "DEV1",
    CLOVER_POS_ID: "ODOS-Dispensary",
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
      posId: "ODOS-Dispensary",
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

// --- resolveStaffRoles: identity-derived roles from every bound AccessPolicy ---

function serviceClient(opts: { membership?: ProjectMembership | null }) {
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
      throw new Error(`AccessPolicy/${id} not found`);
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
        { system: ODOS_PRACTICE_ROLE_SYSTEM, code: "clinician" },
        { system: ODOS_PRACTICE_ROLE_SYSTEM, code: "aesthetics-provider" },
      ] },
    },
    "ap-desk": {
      resourceType: "AccessPolicy",
      meta: { tag: [
        { system: "https://example.test/unrelated", code: "front-desk" },
        { system: ODOS_PRACTICE_ROLE_SYSTEM, code: "front-desk" },
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
    project: { reference: "Project/p1" },
  });

  const reversed = await resolveStaffRoles({
    baseUrl: "http://x",
    authHeader: "Bearer good",
    serviceClient: {
      ...serviceClient,
      search: async <T,>(): Promise<Bundle<T>> => ({
        resourceType: "Bundle",
        type: "searchset",
        entry: [{ resource: { ...membership, access: [...membership.access!].reverse() } as unknown as T }],
      }),
    },
    fetchImpl,
  });
  assert.deepEqual(reversed?.roles, staff?.roles);
});

test("resolveStaffRoles fails closed when one profile has two active project memberships", async () => {
  const { fetchImpl } = meTransport(200, {
    profile: { resourceType: "Practitioner", id: "staff1" },
    user: { resourceType: "User", id: "u1", email: "staff@example.test" },
  });
  const memberships: ProjectMembership[] = [
    {
      ...MEMBERSHIP_FRONT_DESK,
      active: true,
      project: { reference: "Project/practice-one" },
      access: [{ policy: { reference: "AccessPolicy/ap-clinical" } }],
    },
    {
      ...MEMBERSHIP_FRONT_DESK,
      active: true,
      project: { reference: "Project/practice-two" },
      access: [{ policy: { reference: "AccessPolicy/ap-desk" } }],
    },
  ];
  const policies: Record<string, AccessPolicy> = {
    "ap-clinical": {
      resourceType: "AccessPolicy",
      meta: { tag: [{ system: ODOS_PRACTICE_ROLE_SYSTEM, code: "clinician" }] },
    },
    "ap-desk": {
      resourceType: "AccessPolicy",
      meta: { tag: [{ system: ODOS_PRACTICE_ROLE_SYSTEM, code: "front-desk" }] },
    },
  };

  await assert.rejects(
    resolveStaffRoles({
      baseUrl: "http://x",
      authHeader: "Bearer good",
      serviceClient: {
        search: async <T,>(): Promise<Bundle<T>> => ({
          resourceType: "Bundle",
          type: "searchset",
          entry: memberships.map((membership) => ({ resource: membership as unknown as T })),
        }),
        read: async <T,>(_resourceType: string, id: string): Promise<T> => policies[id] as unknown as T,
      },
      fetchImpl,
    }),
    (error: Error) => {
      assert.equal(error.name, "AmbiguousStaffMembershipError");
      assert.match(error.message, /Staff provisioning fault.*2 active project memberships/);
      return true;
    },
  );
});

test("resolveStaffRoles returns null when the profile has no active project membership", async () => {
  const { fetchImpl } = meTransport(200, {
    profile: { resourceType: "Practitioner", id: "staff1" },
    user: { resourceType: "User", id: "u1", email: "staff@example.test" },
  });

  assert.equal(await resolveStaffRoles({
    baseUrl: "http://x",
    authHeader: "Bearer good",
    serviceClient: serviceClient({ membership: null }),
    fetchImpl,
  }), null);
});

test("resolveStaffRoles admits an unset-active membership without narrowing the server search", async () => {
  const { fetchImpl } = meTransport(200, {
    profile: { resourceType: "Practitioner", id: "staff1" },
    user: { resourceType: "User", id: "u1", email: "staff@example.test" },
  });
  assert.equal("active" in MEMBERSHIP_FRONT_DESK, false);
  const svc = serviceClient({ membership: MEMBERSHIP_FRONT_DESK });

  const staff = await resolveStaffRoles({
    baseUrl: "http://x",
    authHeader: "Bearer good",
    serviceClient: svc,
    fetchImpl,
  });

  assert.deepEqual(staff, {
    staffReference: "Practitioner/staff1",
    email: "staff@example.test",
    roles: [],
    project: { reference: "Project/p1" },
  });
  assert.deepEqual(svc.calls.search, [{
    rt: "ProjectMembership",
    params: { profile: "Practitioner/staff1" },
  }]);
});

test("resolveStaffRoles returns null when the selected membership has no resolvable project reference", async () => {
  const { fetchImpl } = meTransport(200, {
    profile: { resourceType: "Practitioner", id: "staff1" },
    user: { resourceType: "User", id: "u1", email: "staff@example.test" },
  });

  assert.equal(await resolveStaffRoles({
    baseUrl: "http://x",
    authHeader: "Bearer good",
    serviceClient: serviceClient({
      membership: {
        ...MEMBERSHIP_FRONT_DESK,
        project: { reference: "Organization/not-a-project" } as ProjectMembership["project"],
      },
    }),
    fetchImpl,
  }), null);
});

test("resolveStaffRoles preserves authenticated identity when no role-bearing policy exists", async () => {
  const { fetchImpl } = meTransport(200, {
    profile: { resourceType: "Practitioner", id: "staff1" },
    user: { resourceType: "User", id: "u1", email: "roleless@example.test" },
  });
  const svc = serviceClient({ membership: { ...MEMBERSHIP_FRONT_DESK, access: [] } });
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
    project: { reference: "Project/p1" },
  });
});

test("authenticateStaffRoute carries the selected project on the authenticated result", async () => {
  const { fetchImpl } = meTransport(200, {
    profile: { resourceType: "Practitioner", id: "staff1" },
    user: { resourceType: "User", id: "u1", email: "staff@example.test" },
  });
  const project = { reference: "Project/practice-one" };
  const result = await authenticateStaffRoute({
    baseUrl: "http://x",
    authHeader: "Bearer good",
    serviceClient: {
      search: async <T,>(): Promise<Bundle<T>> => ({
        resourceType: "Bundle",
        type: "searchset",
        entry: [{ resource: { ...MEMBERSHIP_FRONT_DESK, project } as unknown as T }],
      }),
      read: async <T,>(): Promise<T> => ({
        resourceType: "AccessPolicy",
        meta: { tag: [{ system: ODOS_PRACTICE_ROLE_SYSTEM, code: "front-desk" }] },
      }) as unknown as T,
    },
    fetchImpl,
    audit: {
      record: async <T,>(_row: unknown, operation: () => Promise<T> | T): Promise<T> => operation(),
      recordDenied: async () => undefined,
    },
  });

  assert.deepEqual(result?.project, project);
});
