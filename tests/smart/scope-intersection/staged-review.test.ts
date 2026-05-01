import assert from "node:assert/strict";
import { test } from "node:test";
import { createSmartTestServer, publicClient, verifierPair } from "../helpers.ts";

test("v0.55a SMART scope intersection stages high-risk reductions and issues approved-effective token", async () => {
  const server = await createSmartTestServer();
  try {
    server.state.clients.set("public-client", {
      ...publicClient(server.origin),
      scopesAllowed: ["patient/Observation.rs", "patient/MedicationRequest.c"],
    });
    const pkce = verifierPair();
    const staged = await server.authorize(
      {
        response_type: "code",
        client_id: "public-client",
        redirect_uri: `${server.origin}/callback`,
        scope: "patient/Observation.rs patient/MedicationRequest.c",
        code_challenge: pkce.challenge,
        code_challenge_method: "S256",
        patient: "Patient/patient-1",
      },
      { "X-OSOD-Role": "clinician", "X-OSOD-Actor-Id": "practitioner-1" },
    );
    assert.equal(staged.status, 202);
    const stagedJson = await staged.json() as { decision_id: string };
    assert.equal(server.state.decisions.get(stagedJson.decision_id)?.outcomeClass, "staged-review");

    const approved = await fetch(`${server.origin}/admin/smart/scope-decisions/${stagedJson.decision_id}/approve`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-OSOD-Role": "practice-admin",
        "X-OSOD-Actor-Id": "admin-1",
      },
      body: JSON.stringify({ approved_scopes: ["patient/Observation.rs"] }),
    });
    assert.equal(approved.status, 200);
    const approvedJson = await approved.json() as { code: string; effectiveScopes: string[] };
    assert.ok(approvedJson.code);
    assert.deepEqual(approvedJson.effectiveScopes, ["patient/Observation.rs"]);

    const token = await server.token({
      grant_type: "authorization_code",
      client_id: "public-client",
      code: approvedJson.code,
      redirect_uri: `${server.origin}/callback`,
      code_verifier: pkce.verifier,
    });
    assert.equal(token.status, 200);
    const tokenJson = await token.json() as { scope: string };
    assert.equal(tokenJson.scope, "patient/Observation.rs");
  } finally {
    await server.close();
  }
});
