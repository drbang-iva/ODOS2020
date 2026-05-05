import assert from "node:assert/strict";
import { test } from "node:test";
import {
  authorizationCode,
  authorizationHeader,
  createSmartTestServer,
  publicClient,
  symmetricClient,
} from "../helpers.ts";

test("v0.55e patient-directed grant revocation invalidates refresh and access tokens", async () => {
  const server = await createSmartTestServer();
  try {
    server.state.clients.set("public-client", publicClient(server.origin));
    server.state.clients.set("symmetric-client", symmetricClient(server.origin));
    const { code, verifier } = await authorizationCode(server, "patient/Patient.rs patient/Observation.rs");
    const token = await server.token({
      grant_type: "authorization_code",
      client_id: "public-client",
      code,
      redirect_uri: `${server.origin}/callback`,
      code_verifier: verifier,
    });
    assert.equal(token.status, 200);
    const tokenJson = await token.json() as {
      access_token: string;
      refresh_token: string;
      grant_id: string;
    };

    const grants = await fetch(`${server.origin}/grants`, {
      headers: { Authorization: `Bearer ${tokenJson.access_token}` },
    });
    assert.equal(grants.status, 200);
    assert.equal(((await grants.json()) as { grants: unknown[] }).grants.length, 1);

    const revoke = await fetch(`${server.origin}/grants/${tokenJson.grant_id}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${tokenJson.access_token}` },
    });
    assert.equal(revoke.status, 204);

    const refreshIntrospection = await server.introspect(
      { token: tokenJson.refresh_token },
      { Authorization: authorizationHeader() },
    );
    assert.equal(((await refreshIntrospection.json()) as { active: boolean }).active, false);

    const refresh = await server.token({
      grant_type: "refresh_token",
      client_id: "public-client",
      refresh_token: tokenJson.refresh_token,
    });
    assert.equal(refresh.status, 400);
    assert.equal(((await refresh.json()) as { error: string }).error, "invalid_grant");

    const accessIntrospection = await server.introspect(
      { token: tokenJson.access_token },
      { Authorization: authorizationHeader() },
    );
    assert.equal(((await accessIntrospection.json()) as { active: boolean }).active, false);

    const deniedExport = await fetch(`${server.origin}/Group/osod-exportable-group/$export?_type=Patient`, {
      headers: {
        Accept: "application/fhir+json",
        Prefer: "respond-async",
        Authorization: `Bearer ${tokenJson.access_token}`,
      },
    });
    assert.equal(deniedExport.status, 403);
  } finally {
    await server.close();
  }
});
