import assert from "node:assert/strict";
import { test } from "node:test";
import { publicClient, symmetricClient, createSmartTestServer, authorizationHeader, verifierPair } from "../helpers.ts";

test("v0.55a SMART discovery is dynamic and reflects local state mutations", async () => {
  const server = await createSmartTestServer();
  try {
    server.state.clients.set("public-client", publicClient(server.origin));
    const first = await fetch(`${server.origin}/.well-known/smart-configuration`);
    assert.equal(first.status, 200);
    assert.equal(first.headers.get("content-type")?.includes("application/json"), true);
    const firstJson = await first.json() as {
      capabilities: string[];
      code_challenge_methods_supported: string[];
      registration_endpoint: string;
      osod_extensions: {
        agentops_endpoint: string;
        agentops_capabilities: string[];
      };
    };
    assert.equal(firstJson.capabilities.includes("client-public"), true);
    assert.equal(firstJson.capabilities.includes("client-confidential-asymmetric"), true);
    assert.equal(firstJson.capabilities.includes("context-ehr-patient"), true);
    assert.deepEqual(firstJson.code_challenge_methods_supported, ["S256"]);
    assert.equal(firstJson.registration_endpoint, `${server.origin}/oauth2/register`);
    assert.deepEqual(firstJson.osod_extensions, {
      agentops_endpoint: `${server.origin}/agentops`,
      agentops_capabilities: [
        "agent_registration",
        "threshold_matrix_query",
        "safety_valve_inspection",
        "audit_record_query",
      ],
    });
    const firstEtag = first.headers.get("etag");

    server.state.clients.set("symmetric-client", symmetricClient(server.origin));
    server.state.touch(new Date("2026-05-01T12:00:00.000Z"));
    const second = await fetch(`${server.origin}/.well-known/smart-configuration`);
    assert.notEqual(second.headers.get("etag"), firstEtag);
    const secondJson = await second.json() as { scopes_supported: string[] };
    assert.equal(secondJson.scopes_supported.includes("system/Observation.rs"), true);
  } finally {
    await server.close();
  }
});

test("v0.55a SMART public authorization-code flow enforces PKCE S256 and returns launch context", async () => {
  const server = await createSmartTestServer();
  try {
    server.state.clients.set("public-client", publicClient(server.origin));
    const pkce = verifierPair();
    const authorize = await server.authorize(
      {
        response_type: "code",
        client_id: "public-client",
        redirect_uri: `${server.origin}/callback`,
        scope: "launch/patient patient/Observation.rs",
        state: "state-a",
        code_challenge: pkce.challenge,
        code_challenge_method: "S256",
        patient: "Patient/patient-1",
        encounter: "Encounter/encounter-1",
        intent: "launch",
        need_patient_banner: "true",
      },
      { "X-OSOD-Role": "clinician", "X-OSOD-Actor-Id": "practitioner-1" },
    );
    assert.equal(authorize.status, 302);
    const location = authorize.headers.get("location");
    assert.ok(location);
    const code = new URL(location).searchParams.get("code");
    assert.ok(code);

    const token = await server.token({
      grant_type: "authorization_code",
      client_id: "public-client",
      code,
      redirect_uri: `${server.origin}/callback`,
      code_verifier: pkce.verifier,
    });
    assert.equal(token.status, 200);
    const json = await token.json() as { access_token: string; scope: string; patient: string; encounter: string };
    assert.ok(json.access_token);
    assert.equal(json.scope.includes("patient/Observation.rs"), true);
    assert.equal(json.patient, "Patient/patient-1");
    assert.equal(json.encounter, "Encounter/encounter-1");
  } finally {
    await server.close();
  }
});

test("v0.55a SMART introspection is confidential-client protected", async () => {
  const server = await createSmartTestServer();
  try {
    server.state.clients.set("public-client", publicClient(server.origin));
    server.state.clients.set("symmetric-client", symmetricClient(server.origin));
    const pkce = verifierPair();
    const authorize = await server.authorize(
      {
        response_type: "code",
        client_id: "public-client",
        redirect_uri: `${server.origin}/callback`,
        scope: "patient/Observation.rs",
        code_challenge: pkce.challenge,
        code_challenge_method: "S256",
        patient: "Patient/patient-1",
      },
      { "X-OSOD-Role": "clinician", "X-OSOD-Actor-Id": "practitioner-1" },
    );
    const code = new URL(authorize.headers.get("location")!).searchParams.get("code")!;
    const token = await server.token({
      grant_type: "authorization_code",
      client_id: "public-client",
      code,
      redirect_uri: `${server.origin}/callback`,
      code_verifier: pkce.verifier,
    });
    const tokenJson = await token.json() as { access_token: string };

    const publicCall = await server.introspect({ client_id: "public-client", token: tokenJson.access_token });
    assert.equal(publicCall.status, 401);

    const protectedCall = await server.introspect(
      { token: tokenJson.access_token },
      { Authorization: authorizationHeader() },
    );
    assert.equal(protectedCall.status, 200);
    const active = await protectedCall.json() as { active: boolean; client_id: string };
    assert.equal(active.active, true);
    assert.equal(active.client_id, "public-client");
  } finally {
    await server.close();
  }
});
