import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createMedplumSmartAppRegistryAdapter } from "../../data/medplum-adapters/smart-app-registry-adapter.ts";

const app = {
  metadata: {
    clientName: "Synthetic app",
    redirectUris: ["http://localhost/callback"],
    allowedOrigin: ["http://localhost"],
    defaultScope: "launch/patient openid",
    tokenEndpointAuthMethod: "client_secret_basic",
  },
  canonicalRecord: { resourceType: "Basic", id: "smart-1" },
} as never;

test("SMART registration refuses a session project mismatch before POSTing a client", async () => {
  const originalFetch = globalThis.fetch;
  const requests: Array<{ url: string; method: string }> = [];
  globalThis.fetch = async (input, init) => {
    requests.push({ url: String(input), method: init?.method ?? "GET" });
    return new Response(JSON.stringify({ project: { id: "practice-session" } }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
  try {
    const adapter = createMedplumSmartAppRegistryAdapter({
      baseUrl: "http://medplum.test",
      projectId: "practice-target",
      accessToken: "synthetic-token",
    });
    await assert.rejects(
      () => adapter.registerSmartApp(app),
      /authenticated SMART registry project.*practice-session.*configured.*practice-target/i,
    );
    assert.deepEqual(requests, [{ url: "http://medplum.test/auth/me", method: "GET" }]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("SMART registration checks auth/me before creating a client in the configured project", async () => {
  const originalFetch = globalThis.fetch;
  const requests: Array<{ url: string; method: string }> = [];
  globalThis.fetch = async (input, init) => {
    const request = { url: String(input), method: init?.method ?? "GET" };
    requests.push(request);
    if (request.url.endsWith("/auth/me")) {
      return new Response(JSON.stringify({ project: { id: "practice-target" } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response(JSON.stringify({ id: "client-1", secret: "synthetic-secret" }), {
      status: 201,
      headers: { "Content-Type": "application/json" },
    });
  };
  try {
    const adapter = createMedplumSmartAppRegistryAdapter({
      baseUrl: "http://medplum.test/",
      projectId: "practice-target",
      accessToken: "synthetic-token",
    });
    assert.equal((await adapter.registerSmartApp(app)).client_id, "client-1");
    assert.deepEqual(requests, [
      { url: "http://medplum.test/auth/me", method: "GET" },
      { url: "http://medplum.test/admin/projects/practice-target/client", method: "POST" },
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("SMART registration resolves its default project from the installation manifest", async () => {
  const directory = mkdtempSync(join(tmpdir(), "odos-smart-installation-"));
  const statePath = join(directory, ".odos-setup-state.json");
  writeFileSync(statePath, JSON.stringify({ version: "v0.5d", projectId: "practice-manifest" }));
  const originalFetch = globalThis.fetch;
  const requests: string[] = [];
  globalThis.fetch = async (input) => {
    const url = String(input);
    requests.push(url);
    return url.endsWith("/auth/me")
      ? Response.json({ project: { id: "practice-manifest" } })
      : Response.json({ id: "client-manifest" }, { status: 201 });
  };
  try {
    const adapter = createMedplumSmartAppRegistryAdapter({
      baseUrl: "http://medplum.test",
      accessToken: "synthetic-token",
      env: { ODOS_SETUP_STATE_PATH: statePath },
      workingDirectory: directory,
    });
    assert.equal((await adapter.registerSmartApp(app)).client_id, "client-manifest");
    assert.deepEqual(requests, [
      "http://medplum.test/auth/me",
      "http://medplum.test/admin/projects/practice-manifest/client",
    ]);
  } finally {
    globalThis.fetch = originalFetch;
    rmSync(directory, { recursive: true, force: true });
  }
});
