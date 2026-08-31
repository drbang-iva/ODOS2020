import assert from "node:assert/strict";
import { test } from "node:test";
import type { AuditEvent } from "@medplum/fhirtypes";
import { createAuditProjectionClient } from "../src/authz/liveAudit.js";
import { verifyMcpProjectBootBoundary } from "../src/authz/boot-role-verification.js";
import { authenticateMedplumService, createMedplumClient } from "../src/fhir-client.js";
import { TEST_FHIR_AUDIT_CONTEXT, TEST_FHIR_AUDIT_RECORDER } from "./fhirAuditTestStub.js";

const CONFIGURED_PROJECT = "practice-configured";

test("Mandate 17: client-credential service refuses to serve a different authenticated project", async () => {
  const originalFetch = globalThis.fetch;
  const events: string[] = [];
  globalThis.fetch = serviceFetch("practice-authenticated");
  try {
    const client = createMedplumClient({
      baseUrl: "http://medplum.test",
      audit: TEST_FHIR_AUDIT_RECORDER,
      auditContext: TEST_FHIR_AUDIT_CONTEXT,
    });
    const authenticate = () => authenticateMedplumService(client, serviceOptions());

    await assert.rejects(
      verifyMcpProjectBootBoundary({
        configuredProjectId: CONFIGURED_PROJECT,
        configuredSource: "environment",
        authenticate,
        getActiveProjectId: () => client.getActiveProjectId(),
        verifyPolicies: async () => { events.push("policies"); },
        serve: async () => { events.push("serve"); },
        log: (message) => events.push(message),
      }),
      /authenticated MCP service project.*practice-authenticated.*configured.*practice-configured/i,
    );

    assert.deepEqual(events, [
      "Target: Project/practice-configured (source: environment)",
      "Observed authenticated MCP service project: Project/practice-authenticated",
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Mandate 17: client-credential service verifies policies and serves its configured project", async () => {
  const originalFetch = globalThis.fetch;
  const events: string[] = [];
  globalThis.fetch = serviceFetch(CONFIGURED_PROJECT);
  try {
    const client = createMedplumClient({
      baseUrl: "http://medplum.test",
      audit: TEST_FHIR_AUDIT_RECORDER,
      auditContext: TEST_FHIR_AUDIT_CONTEXT,
    });

    await verifyMcpProjectBootBoundary({
      configuredProjectId: CONFIGURED_PROJECT,
      configuredSource: "environment",
      authenticate: () => authenticateMedplumService(client, serviceOptions()),
      getActiveProjectId: () => client.getActiveProjectId(),
      verifyPolicies: async () => { events.push("policies"); },
      serve: async () => { events.push("serve"); },
      log: (message) => events.push(message),
    });

    assert.deepEqual(events, [
      "Target: Project/practice-configured (source: environment)",
      "Observed authenticated MCP service project: Project/practice-configured",
      "policies",
      "serve",
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("audit projection authenticates with the same scoped client credentials", async () => {
  const originalFetch = globalThis.fetch;
  const requests: Array<{ path: string; grant?: string; authorization?: string }> = [];
  let tokenExchanges = 0;
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    requests.push({
      path: url.pathname,
      grant: init?.body instanceof URLSearchParams ? init.body.get("grant_type") ?? undefined : undefined,
      authorization: new Headers(init?.headers).get("authorization") ?? undefined,
    });
    if (url.pathname === "/oauth2/token") {
      tokenExchanges += 1;
      const lifetimeSeconds = tokenExchanges === 1 ? 299 : 3_600;
      return Response.json({
        access_token: jwt({
          exp: Math.floor(Date.now() / 1_000) + lifetimeSeconds,
          jti: `audit-service-${tokenExchanges}`,
        }),
      });
    }
    if (url.pathname === "/fhir/R4/AuditEvent") {
      return Response.json({ resourceType: "AuditEvent", id: "audit-1" }, { status: 201 });
    }
    throw new Error(`Unexpected request: ${url.pathname}`);
  };
  try {
    const client = await createAuditProjectionClient({
      medplumBaseUrl: "http://medplum.test",
      medplumAccessToken: "legacy-unscoped-token",
      medplumProjectId: CONFIGURED_PROJECT,
      medplumClientId: "service-client",
      medplumClientSecret: "not-a-real-secret",
      medplumEmail: "break-glass@example.test",
      medplumPassword: "not-a-real-password",
      disabled: false,
    });

    await client.create<AuditEvent>({
      resourceType: "AuditEvent",
      type: { system: "http://terminology.hl7.org/CodeSystem/audit-event-type", code: "rest" },
      agent: [{ requestor: true, who: { reference: "Device/odos-mcp" } }],
      source: { observer: { reference: "Device/odos-mcp" } },
      recorded: "2026-08-30T12:00:00Z",
      outcome: "0",
    });

    assert.deepEqual(
      requests.map((request) => request.path),
      ["/oauth2/token", "/oauth2/token", "/fhir/R4/AuditEvent"],
    );
    assert.equal(requests[0]?.grant, "client_credentials");
    assert.equal(requests[1]?.grant, "client_credentials");
    assert.match(requests[2]?.authorization ?? "", /^Bearer /);
    assert.notEqual(requests[2]?.authorization, "Bearer legacy-unscoped-token");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("audit projection logs a fatal scoped refresh failure after the second exchange", async () => {
  const originalFetch = globalThis.fetch;
  const originalConsoleError = console.error;
  const errors: string[] = [];
  let tokenExchanges = 0;
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname !== "/oauth2/token") {
      throw new Error(`Unexpected request: ${url.pathname}`);
    }
    tokenExchanges += 1;
    if (tokenExchanges === 1) {
      return Response.json({
        access_token: jwt({
          exp: Math.floor(Date.now() / 1_000) + 299,
          jti: "audit-service-expiring",
        }),
      });
    }
    return new Response("invalid_client", { status: 401, statusText: "Unauthorized" });
  };
  console.error = (...args: unknown[]) => { errors.push(args.map(String).join(" ")); };
  try {
    const client = await createAuditProjectionClient({
      medplumBaseUrl: "http://medplum.test",
      medplumProjectId: CONFIGURED_PROJECT,
      medplumClientId: "service-client",
      medplumClientSecret: "not-a-real-secret",
      medplumEmail: "break-glass@example.test",
      medplumPassword: "not-a-real-password",
      disabled: false,
    });

    await assert.rejects(
      client.create<AuditEvent>({
        resourceType: "AuditEvent",
        type: { system: "http://terminology.hl7.org/CodeSystem/audit-event-type", code: "rest" },
        agent: [{ requestor: true, who: { reference: "Device/odos-mcp" } }],
        source: { observer: { reference: "Device/odos-mcp" } },
        recorded: "2026-08-30T12:00:00Z",
        outcome: "0",
      }),
      /client-credentials exchange failed.*401 Unauthorized/i,
    );

    assert.equal(tokenExchanges, 2);
    assert.equal(errors.length, 1);
    assert.match(
      errors[0]!,
      /^odos-audit: ODOS MCP CLIENT-CREDENTIALS AUTHENTICATION FAILED:/,
    );
  } finally {
    console.error = originalConsoleError;
    globalThis.fetch = originalFetch;
  }
});

function serviceOptions() {
  return {
    projectId: CONFIGURED_PROJECT,
    clientId: "service-client",
    clientSecret: "not-a-real-secret",
    email: "break-glass@example.test",
    password: "not-a-real-password",
    logError: () => undefined,
  };
}

function serviceFetch(activeProjectId: string): typeof fetch {
  return async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname === "/oauth2/token") {
      assert.equal(new URLSearchParams(String(init?.body)).get("grant_type"), "client_credentials");
      return Response.json({ access_token: jwt({ exp: 4_102_444_800, jti: activeProjectId }) });
    }
    if (url.pathname === "/auth/me") {
      assert.match(new Headers(init?.headers).get("authorization") ?? "", /^Bearer /);
      return Response.json({ project: { id: activeProjectId } });
    }
    throw new Error(`Unexpected request: ${url.pathname}`);
  };
}

function jwt(payload: Record<string, unknown>): string {
  return `header.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.signature`;
}
