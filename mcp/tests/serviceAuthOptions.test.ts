import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { resolveServiceAuthOptions } from "../src/service-auth-options.js";

const indexSource = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");

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

test("MCP startup passes the resolved service auth options to the production authenticator", () => {
  assert.equal(
    indexSource.includes(
      "const mode = await authenticateMedplumService(fhir, SERVICE_AUTH_OPTIONS);",
    ),
    true,
    "production authentication must pass SERVICE_AUTH_OPTIONS without credential overrides",
  );
});

test("MCP audit runtime receives the resolved service credentials", () => {
  assert.equal(
    /medplumProjectId: INSTALLATION_PROJECT\.projectId,\s+medplumClientId: SERVICE_AUTH_OPTIONS\.clientId,\s+medplumClientSecret: SERVICE_AUTH_OPTIONS\.clientSecret,\s+medplumEmail: process\.env\.ODOS_AUDIT_MEDPLUM_EMAIL \?\? SERVICE_AUTH_OPTIONS\.email,\s+medplumPassword: process\.env\.ODOS_AUDIT_MEDPLUM_PASSWORD \?\? SERVICE_AUTH_OPTIONS\.password,/.test(indexSource),
    true,
    "audit runtime must receive scoped service credentials and break-glass fallback options",
  );
});
