import assert from "node:assert/strict";
import { test } from "node:test";
import type { Patient } from "@medplum/fhirtypes";
import { createMedplumClient, type MedplumClient } from "../src/fhir-client.js";

test("FHIR client forces one re-login and replays a 401 once for every service operation", async () => {
  const originalFetch = globalThis.fetch;
  const calls: Array<{ url: string; authorization?: string }> = [];
  const oldToken = jwt({ exp: 4_102_444_800, jti: "old" });
  const freshToken = jwt({ exp: 4_102_444_800, jti: "fresh" });
  let fhirAttempts = 0;
  let tokenExchanges = 0;
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    calls.push({ url, authorization: new Headers(init?.headers).get("authorization") ?? undefined });
    if (url.endsWith("/auth/login")) return Response.json({ code: "login-code" });
    if (url.endsWith("/oauth2/token")) {
      tokenExchanges += 1;
      return Response.json({ access_token: tokenExchanges === 1 ? oldToken : freshToken });
    }
    fhirAttempts += 1;
    if (fhirAttempts === 1) return new Response("Unauthorized", { status: 401, statusText: "Unauthorized" });
    return Response.json({ resourceType: "Patient", id: "p1" }, { headers: { "Content-Type": "application/fhir+json" } });
  };
  try {
    const client: MedplumClient = createMedplumClient({
      baseUrl: "http://medplum.test",
      now: () => Date.parse("2026-07-12T00:00:00Z"),
    });
    await client.login("service@example.test", "test-password");
    const patient = await client.read<Patient>("Patient", "p1");
    assert.equal(patient.id, "p1");
    assert.equal(tokenExchanges, 2);
    assert.equal(fhirAttempts, 2);
    assert.equal(calls.at(-1)?.authorization, `Bearer ${freshToken}`);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("FHIR client proactively re-authenticates within five minutes of token expiry", async () => {
  const originalFetch = globalThis.fetch;
  const now = Date.parse("2026-07-12T00:00:00Z");
  const freshToken = jwt({ exp: Math.floor(now / 1000) + 3600 });
  const expiringToken = jwt({ exp: Math.floor(now / 1000) + 299 });
  const authorizations: Array<string | undefined> = [];
  let tokenExchanges = 0;
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith("/auth/login")) return Response.json({ code: "login-code" });
    if (url.endsWith("/oauth2/token")) {
      tokenExchanges += 1;
      return Response.json({ access_token: tokenExchanges === 1 ? expiringToken : freshToken });
    }
    authorizations.push(new Headers(init?.headers).get("authorization") ?? undefined);
    return Response.json({ resourceType: "Patient", id: "p1" });
  };
  try {
    const client: MedplumClient = createMedplumClient({
      baseUrl: "http://medplum.test",
      now: () => now,
    });
    await client.login("service@example.test", "test-password");
    await client.read<Patient>("Patient", "p1");
    assert.equal(tokenExchanges, 2);
    assert.deepEqual(authorizations, [`Bearer ${freshToken}`]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

function jwt(payload: Record<string, unknown>): string {
  return `header.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.signature`;
}
