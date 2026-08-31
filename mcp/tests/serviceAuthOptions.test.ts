import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createMcpAuditRuntime,
  createMcpServiceAuthentication,
  resolveServiceAuthOptions,
  type ServiceAuthenticationClient,
} from "../src/service-auth-options.js";

const ENV = {
  MEDPLUM_CLIENT_ID: "service-client",
  MEDPLUM_CLIENT_SECRET: "not-a-real-secret",
  MEDPLUM_ADMIN_EMAIL: "break-glass@example.test",
  MEDPLUM_ADMIN_PASSWORD: "not-a-real-password",
};

const CLIENT: ServiceAuthenticationClient = {
  async login() {},
  async loginWithClientCredentials() {},
};

test("MCP service auth options preserve configured client credentials", () => {
  assert.deepEqual(
    resolveServiceAuthOptions(ENV, "practice-configured"),
    {
      projectId: "practice-configured",
      clientId: "service-client",
      clientSecret: "not-a-real-secret",
      email: "break-glass@example.test",
      password: "not-a-real-password",
    },
  );
});

test("MCP startup composition passes scoped credentials to the authenticator", async () => {
  let receivedClientId: string | undefined;
  let receivedClientSecret: string | undefined;
  const serviceAuthentication = createMcpServiceAuthentication(
    ENV,
    "practice-configured",
    async (_client, options) => {
      receivedClientId = options.clientId;
      receivedClientSecret = options.clientSecret;
      return "client-credentials";
    },
  );

  assert.equal(await serviceAuthentication.authenticate(CLIENT), "client-credentials");
  assert.equal(receivedClientId, "service-client");
  assert.equal(receivedClientSecret, "not-a-real-secret");
});

test("MCP audit composition passes scoped credentials to the runtime factory", () => {
  const serviceAuthentication = createMcpServiceAuthentication(
    ENV,
    "practice-configured",
    async () => "client-credentials",
  );
  let receivedClientId: string | undefined;
  let receivedClientSecret: string | undefined;
  const expectedRuntime = { kind: "audit-runtime" } as const;
  const runtime = createMcpAuditRuntime(
    {
      env: ENV,
      baseUrl: "http://localhost:8103/",
      accessToken: "bootstrap-token",
      projectId: "practice-configured",
      serviceAuthOptions: serviceAuthentication.options,
    },
    (options) => {
      receivedClientId = options.medplumClientId;
      receivedClientSecret = options.medplumClientSecret;
      return expectedRuntime;
    },
  );

  assert.equal(runtime, expectedRuntime);
  assert.equal(receivedClientId, "service-client");
  assert.equal(receivedClientSecret, "not-a-real-secret");
});
