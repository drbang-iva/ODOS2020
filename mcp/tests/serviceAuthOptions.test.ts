import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveServiceAuthOptions } from "../src/service-auth-options.js";

test("MCP service auth options preserve configured client credentials", () => {
  assert.deepEqual(
    resolveServiceAuthOptions({
      MEDPLUM_CLIENT_ID: "service-client",
      MEDPLUM_CLIENT_SECRET: "not-a-real-secret",
      MEDPLUM_ADMIN_EMAIL: "break-glass@example.test",
      MEDPLUM_ADMIN_PASSWORD: "not-a-real-password",
    }, "practice-configured"),
    {
      projectId: "practice-configured",
      clientId: "service-client",
      clientSecret: "not-a-real-secret",
      email: "break-glass@example.test",
      password: "not-a-real-password",
    },
  );
});
