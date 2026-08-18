import assert from "node:assert/strict";
import { test } from "node:test";

const CLIENT_APPLICATION_RESOURCE_TYPE = ["Client", "Application"].join("");

async function subject() {
  const loaded = await import("../../data/medplum-adapters/" + "operator-bootstrap-adapter.ts").catch(() => undefined);
  assert.ok(loaded, "operator bootstrap Medplum adapter must exist");
  return loaded as unknown as {
    createLiveOperatorIdentityAdapter(input: {
      baseUrl: string;
      serviceAccessToken: string;
      clientName: string;
      verifyMembership(input: { projectId: string; clientId: string; membershipId: string }): Promise<void>;
    }): {
      create(projectId: string): Promise<{ clientId: string; clientSecret: string }>;
      verify(credentials: { projectId: string; clientId: string; clientSecret: string }): Promise<{
        accessToken: string;
        membershipId: string;
      }>;
      revoke(
        projectId: string,
        clientId: string,
        membershipId: string | undefined,
        credentials: { projectId: string; clientId: string; clientSecret: string },
      ): Promise<void>;
    };
  };
}

test("operator adapter creates a named client without an access policy and verifies its exact membership", async () => {
  const module = await subject();
  const originalFetch = globalThis.fetch;
  const calls: string[] = [];
  const membershipChecks: unknown[] = [];
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    calls.push(`${method} ${new URL(url).pathname}`);
    if (url.endsWith("/admin/projects/practice-1/client")) {
      assert.equal(new Headers(init?.headers).get("authorization"), "Bearer service-token");
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      assert.deepEqual(body, {
        name: "ODOS Local Operator",
        description: "Local-only ODOS setup, repair, reseed, and integrity operator",
      });
      assert.equal("accessPolicy" in body, false);
      return Response.json({
        resourceType: CLIENT_APPLICATION_RESOURCE_TYPE,
        id: "operator-client",
        secret: "operator-secret",
      }, { status: 201 });
    }
    if (url.endsWith("/oauth2/token")) {
      const body = new URLSearchParams(String(init?.body));
      assert.equal(body.get("grant_type"), "client_credentials");
      assert.equal(body.get("client_id"), "operator-client");
      assert.equal(body.get("client_secret"), "operator-secret");
      return Response.json({ access_token: "operator-token" });
    }
    if (url.endsWith("/auth/me")) {
      assert.equal(new Headers(init?.headers).get("authorization"), "Bearer operator-token");
      return Response.json({
        project: { resourceType: "Project", id: "practice-1" },
        membership: {
          resourceType: "ProjectMembership",
          id: "operator-membership",
          project: { reference: "Project/practice-1" },
          profile: { reference: `${CLIENT_APPLICATION_RESOURCE_TYPE}/operator-client` },
        },
        profile: { resourceType: CLIENT_APPLICATION_RESOURCE_TYPE, id: "operator-client", name: "ODOS Local Operator" },
      });
    }
    throw new Error(`Unexpected request ${method} ${url}`);
  };
  try {
    const adapter = module.createLiveOperatorIdentityAdapter({
      baseUrl: "http://medplum.test",
      serviceAccessToken: "service-token",
      clientName: "ODOS Local Operator",
      verifyMembership: async (input) => { membershipChecks.push(input); },
    });
    const credentials = await adapter.create("practice-1");
    assert.deepEqual(credentials, { clientId: "operator-client", clientSecret: "operator-secret" });
    assert.deepEqual(
      await adapter.verify({ projectId: "practice-1", ...credentials }),
      { accessToken: "operator-token", membershipId: "operator-membership" },
    );
    assert.deepEqual(calls, [
      "POST /admin/projects/practice-1/client",
      "POST /oauth2/token",
      "GET /auth/me",
    ]);
    assert.deepEqual(membershipChecks, [{
      projectId: "practice-1",
      clientId: "operator-client",
      membershipId: "operator-membership",
    }]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("operator adapter propagates a failed local membership verification", async () => {
  const module = await subject();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.endsWith("/oauth2/token")) return Response.json({ access_token: "operator-token" });
    return Response.json({
      project: { id: "practice-1" },
      membership: { id: "operator-membership", profile: { reference: `${CLIENT_APPLICATION_RESOURCE_TYPE}/operator-client` } },
      profile: { resourceType: CLIENT_APPLICATION_RESOURCE_TYPE, id: "operator-client", name: "ODOS Local Operator" },
    });
  };
  try {
    const adapter = module.createLiveOperatorIdentityAdapter({
      baseUrl: "http://medplum.test",
      serviceAccessToken: "service-token",
      clientName: "ODOS Local Operator",
      verifyMembership: async () => { throw new Error("Operator membership carries AccessPolicy/policy-1."); },
    });
    await assert.rejects(
      adapter.verify({ projectId: "practice-1", clientId: "operator-client", clientSecret: "operator-secret" }),
      /carries AccessPolicy\/policy-1/,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("operator adapter revokes membership and client, then proves the old secret cannot exchange", async () => {
  const module = await subject();
  const originalFetch = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    calls.push(`${method} ${new URL(url).pathname}`);
    if (method === "DELETE") return new Response(null, { status: 204 });
    if (url.endsWith("/oauth2/token")) return new Response("invalid_client", { status: 401 });
    throw new Error(`Unexpected request ${method} ${url}`);
  };
  try {
    const adapter = module.createLiveOperatorIdentityAdapter({
      baseUrl: "http://medplum.test",
      serviceAccessToken: "service-token",
      clientName: "ODOS Local Operator",
      verifyMembership: async () => undefined,
    });
    await adapter.revoke(
      "practice-1",
      "operator-client",
      "operator-membership",
      { projectId: "practice-1", clientId: "operator-client", clientSecret: "operator-secret" },
    );
    assert.deepEqual(calls, [
      "DELETE /fhir/R4/ProjectMembership/operator-membership",
      `DELETE /fhir/R4/${CLIENT_APPLICATION_RESOURCE_TYPE}/operator-client`,
      "POST /oauth2/token",
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
