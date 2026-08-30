import assert from "node:assert/strict";
import { test } from "node:test";
import { probeMedplumClientAppEndpoint } from "../../scripts/probe-medplum-clientapplication.ts";

test("client-application probe refuses a session project mismatch before probing the endpoint", async () => {
  const requests: Array<{ url: string; method: string }> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    requests.push({ url: String(input), method: init?.method ?? "GET" });
    return Response.json({ project: { id: "practice-session" } });
  };
  try {
    await assert.rejects(
      () => probeMedplumClientAppEndpoint({
        baseUrl: "http://medplum.test",
        projectId: "practice-target",
        accessToken: "synthetic-token",
      }),
      /authenticated client-application probe project.*practice-session.*configured.*practice-target/i,
    );
    assert.deepEqual(requests, [{ url: "http://medplum.test/auth/me", method: "GET" }]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("client-application probe verifies auth\/me before probing the configured project", async () => {
  const requests: Array<{ url: string; method: string }> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const request = { url: String(input), method: init?.method ?? "GET" };
    requests.push(request);
    return request.url.endsWith("/auth/me")
      ? Response.json({ project: { id: "practice-target" } })
      : new Response(null, { status: 204 });
  };
  try {
    const result = await probeMedplumClientAppEndpoint({
      baseUrl: "http://medplum.test/",
      projectId: "practice-target",
      accessToken: "synthetic-token",
    });

    assert.deepEqual(result, {
      path: "/admin/projects/practice-target/client",
      reachable: true,
      status: 204,
    });
    assert.deepEqual(requests, [
      { url: "http://medplum.test/auth/me", method: "GET" },
      { url: "http://medplum.test/admin/projects/practice-target/client", method: "OPTIONS" },
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
