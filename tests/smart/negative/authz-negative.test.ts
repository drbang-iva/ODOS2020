import assert from "node:assert/strict";
import { createPrivateKey, createPublicKey, generateKeyPairSync, sign, type JsonWebKey } from "node:crypto";
import { test } from "node:test";
import {
  authorizationCode,
  authorizationHeader,
  createSmartTestServer,
  publicClient,
  symmetricClient,
  verifierPair,
} from "../helpers.ts";
import type { SmartClientRegistration } from "../../../mcp/src/smart/authorization-server.ts";

test("v0.55a negative: state mismatch is rejected at token exchange", async () => {
  const server = await createSmartTestServer();
  try {
    server.state.clients.set("public-client", publicClient(server.origin));
    const issued = await authorizationCode(server);
    const response = await server.token({
      grant_type: "authorization_code",
      client_id: "public-client",
      code: issued.code,
      redirect_uri: `${server.origin}/callback`,
      code_verifier: issued.verifier,
      state: "state-b",
    });
    assert.equal(response.status, 400);
    assert.equal((await response.json() as { error: string }).error, "invalid_request");
  } finally {
    await server.close();
  }
});

test("v0.55a negative: redirect URI mismatch is rejected", async () => {
  const server = await createSmartTestServer();
  try {
    server.state.clients.set("public-client", publicClient(server.origin));
    const issued = await authorizationCode(server);
    const response = await server.token({
      grant_type: "authorization_code",
      client_id: "public-client",
      code: issued.code,
      redirect_uri: `${server.origin}/attacker`,
      code_verifier: issued.verifier,
    });
    assert.equal(response.status, 400);
    assert.equal((await response.json() as { error: string }).error, "invalid_grant");
  } finally {
    await server.close();
  }
});

test("v0.55a negative: missing PKCE verifier is rejected", async () => {
  const server = await createSmartTestServer();
  try {
    server.state.clients.set("public-client", publicClient(server.origin));
    const issued = await authorizationCode(server);
    const response = await server.token({
      grant_type: "authorization_code",
      client_id: "public-client",
      code: issued.code,
      redirect_uri: `${server.origin}/callback`,
    });
    assert.equal(response.status, 400);
    assert.equal((await response.json() as { error: string }).error, "invalid_request");
  } finally {
    await server.close();
  }
});

test("v0.55a negative: PKCE verifier mismatch is rejected", async () => {
  const server = await createSmartTestServer();
  try {
    server.state.clients.set("public-client", publicClient(server.origin));
    const issued = await authorizationCode(server);
    const response = await server.token({
      grant_type: "authorization_code",
      client_id: "public-client",
      code: issued.code,
      redirect_uri: `${server.origin}/callback`,
      code_verifier: "wrong-verifier",
    });
    assert.equal(response.status, 400);
    assert.equal((await response.json() as { error: string }).error, "invalid_grant");
  } finally {
    await server.close();
  }
});

test("v0.55a negative: expired authorization code is rejected", async () => {
  const server = await createSmartTestServer();
  try {
    server.state.clients.set("public-client", publicClient(server.origin));
    const issued = await authorizationCode(server);
    (server.state.authorizationCodes.get(issued.code)! as { expiresAt: number }).expiresAt = Date.now() - 1;
    const response = await server.token({
      grant_type: "authorization_code",
      client_id: "public-client",
      code: issued.code,
      redirect_uri: `${server.origin}/callback`,
      code_verifier: issued.verifier,
    });
    assert.equal(response.status, 400);
    assert.equal((await response.json() as { error: string }).error, "invalid_grant");
  } finally {
    await server.close();
  }
});

test("v0.55a negative: authorization code reuse revokes tokens from the first redemption", async () => {
  const server = await createSmartTestServer();
  try {
    server.state.clients.set("public-client", publicClient(server.origin));
    server.state.clients.set("symmetric-client", symmetricClient(server.origin));
    const issued = await authorizationCode(server);
    const first = await server.token({
      grant_type: "authorization_code",
      client_id: "public-client",
      code: issued.code,
      redirect_uri: `${server.origin}/callback`,
      code_verifier: issued.verifier,
    });
    assert.equal(first.status, 200);
    const firstJson = await first.json() as { access_token: string };
    const second = await server.token({
      grant_type: "authorization_code",
      client_id: "public-client",
      code: issued.code,
      redirect_uri: `${server.origin}/callback`,
      code_verifier: issued.verifier,
    });
    assert.equal(second.status, 400);
    const introspect = await server.introspect(
      { token: firstJson.access_token },
      { Authorization: authorizationHeader() },
    );
    assert.deepEqual(await introspect.json(), { active: false });
  } finally {
    await server.close();
  }
});

test("v0.55a negative: revoked token introspects inactive", async () => {
  const server = await createSmartTestServer();
  try {
    server.state.clients.set("public-client", publicClient(server.origin));
    server.state.clients.set("symmetric-client", symmetricClient(server.origin));
    const issued = await authorizationCode(server);
    const token = await server.token({
      grant_type: "authorization_code",
      client_id: "public-client",
      code: issued.code,
      redirect_uri: `${server.origin}/callback`,
      code_verifier: issued.verifier,
    });
    const tokenJson = await token.json() as { access_token: string };
    assert.equal((await server.revoke({ client_id: "public-client", token: tokenJson.access_token })).status, 200);
    const introspect = await server.introspect(
      { token: tokenJson.access_token },
      { Authorization: authorizationHeader() },
    );
    const json = await introspect.json() as { active: boolean };
    assert.equal(json.active, false);
    assert.equal(json.active ? 200 : 401, 401);
  } finally {
    await server.close();
  }
});

test("v0.55a negative: unauthenticated introspection is rejected", async () => {
  const server = await createSmartTestServer();
  try {
    const response = await server.introspect({ token: "missing" });
    assert.equal(response.status, 401);
  } finally {
    await server.close();
  }
});

test("v0.55a negative: introspection of a non-existent token returns inactive when caller is authenticated", async () => {
  const server = await createSmartTestServer();
  try {
    server.state.clients.set("symmetric-client", symmetricClient(server.origin));
    const response = await server.introspect({ token: "never-issued" }, { Authorization: authorizationHeader() });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { active: false });
  } finally {
    await server.close();
  }
});

test("v0.55a negative: confidential symmetric client wrong secret is rejected", async () => {
  const server = await createSmartTestServer();
  try {
    server.state.clients.set("symmetric-client", symmetricClient(server.origin));
    const response = await server.token(
      { grant_type: "client_credentials", scope: "system/Observation.rs" },
      { Authorization: authorizationHeader("symmetric-client", "wrong") },
    );
    assert.equal(response.status, 401);
    assert.equal((await response.json() as { error: string }).error, "invalid_client");
  } finally {
    await server.close();
  }
});

test("v0.55a negative: confidential asymmetric expired client_assertion is rejected", async () => {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  let client: SmartClientRegistration | undefined;
  const server = await createSmartTestServer({
    configureApp: (app, origin) => {
      const publicJwk = createPublicKey(privateKey).export({ format: "jwk" }) as JsonWebKey;
      publicJwk.kid = "client-key";
      app.get("/client-jwks.json", (_req, res) => res.json({ keys: [publicJwk] }));
      client = {
        clientId: "asymmetric-client",
        name: "Asymmetric Client",
        redirectUris: [`${origin}/backend/callback`],
        clientType: "confidential",
        tokenEndpointAuthMethod: "private_key_jwt",
        jwksUri: `${origin}/client-jwks.json`,
        scopesAllowed: ["system/Observation.rs"],
        isSandbox: false,
      };
    },
  });
  try {
    server.state.clients.set("asymmetric-client", client!);
    const assertion = expiredClientAssertion("asymmetric-client", server.origin, privateKey.export({ format: "pem", type: "pkcs8" }).toString());
    const response = await server.token({
      grant_type: "client_credentials",
      scope: "system/Observation.rs",
      client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
      client_assertion: assertion,
    });
    assert.equal(response.status, 401);
    assert.equal((await response.json() as { error: string }).error, "invalid_client");
  } finally {
    await server.close();
  }
});

function expiredClientAssertion(clientId: string, audience: string, privateKeyPem: string): string {
  const header = { alg: "RS256", typ: "JWT", kid: "client-key" };
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    iss: clientId,
    sub: clientId,
    aud: audience,
    exp: now - 1,
    iat: now - 120,
    jti: "expired-jti",
  };
  const signingInput = `${base64urlJson(header)}.${base64urlJson(payload)}`;
  const signature = sign("RSA-SHA256", Buffer.from(signingInput), createPrivateKey(privateKeyPem)).toString("base64url");
  return `${signingInput}.${signature}`;
}

function base64urlJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}
