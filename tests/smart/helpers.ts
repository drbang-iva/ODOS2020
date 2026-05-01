import { createServer, type Server } from "node:http";
import { createHash } from "node:crypto";
import express from "../../mcp/node_modules/express/index.js";
import {
  SmartAuthorizationState,
  createEphemeralSmartSigningKey,
  createSmartAuthorizationRouter,
  type SmartClientRegistration,
} from "../../mcp/src/smart/authorization-server.js";
import { pkceS256Challenge } from "../../mcp/src/smart/pkce.js";

export interface SmartTestServer {
  readonly origin: string;
  readonly state: SmartAuthorizationState;
  readonly server: Server;
  readonly authorize: (params: Record<string, string>, headers?: Record<string, string>) => Promise<Response>;
  readonly token: (params: Record<string, string>, headers?: Record<string, string>) => Promise<Response>;
  readonly introspect: (params: Record<string, string>, headers?: Record<string, string>) => Promise<Response>;
  readonly revoke: (params: Record<string, string>, headers?: Record<string, string>) => Promise<Response>;
  readonly close: () => Promise<void>;
}

export async function createSmartTestServer(input: {
  readonly clients?: readonly SmartClientRegistration[];
  readonly now?: () => Date;
  readonly configureApp?: (app: express.Express, origin: string) => void;
} = {}): Promise<SmartTestServer> {
  const app = express();
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("test server did not bind a TCP port");
  }
  const origin = `http://127.0.0.1:${address.port}`;
  input.configureApp?.(app, origin);
  const state = new SmartAuthorizationState(input.clients ?? []);
  app.use(
    createSmartAuthorizationRouter({
      issuer: origin,
      fhirBaseUrl: `${origin}/fhir/R4`,
      signingKey: createEphemeralSmartSigningKey(),
      state,
      now: input.now,
    }),
  );
  return {
    origin,
    state,
    server,
    authorize: (params, headers) => fetchUrl(`${origin}/authorize`, params, headers, "GET"),
    token: (params, headers) => fetchUrl(`${origin}/token`, params, headers, "POST"),
    introspect: (params, headers) => fetchUrl(`${origin}/introspect`, params, headers, "POST"),
    revoke: (params, headers) => fetchUrl(`${origin}/revoke`, params, headers, "POST"),
    close: () => new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
  };
}

export function publicClient(origin: string): SmartClientRegistration {
  return {
    clientId: "public-client",
    name: "Public Client",
    redirectUris: [`${origin}/callback`],
    clientType: "public",
    tokenEndpointAuthMethod: "none",
    scopesAllowed: ["patient/Observation.rs", "launch/patient"],
    isSandbox: false,
  };
}

export function symmetricClient(origin: string, secret = "secret"): SmartClientRegistration {
  return {
    clientId: "symmetric-client",
    name: "Symmetric Client",
    redirectUris: [`${origin}/backend/callback`],
    clientType: "confidential",
    tokenEndpointAuthMethod: "client_secret_basic",
    clientSecretHash: secretHashForTest(secret),
    scopesAllowed: ["system/Observation.rs"],
    isSandbox: false,
  };
}

export function authorizationHeader(clientId = "symmetric-client", secret = "secret"): string {
  return `Basic ${Buffer.from(`${clientId}:${secret}`).toString("base64")}`;
}

export function verifierPair(verifier = "correct-horse-battery-staple"): {
  readonly verifier: string;
  readonly challenge: string;
} {
  return { verifier, challenge: pkceS256Challenge(verifier) };
}

export async function authorizationCode(server: SmartTestServer, scope = "patient/Observation.rs"): Promise<{
  readonly code: string;
  readonly verifier: string;
}> {
  const pkce = verifierPair();
  const response = await server.authorize(
    {
      response_type: "code",
      client_id: "public-client",
      redirect_uri: `${server.origin}/callback`,
      scope,
      state: "state-a",
      code_challenge: pkce.challenge,
      code_challenge_method: "S256",
      patient: "Patient/patient-1",
    },
    { "X-OSOD-Role": "clinician", "X-OSOD-Actor-Id": "practitioner-1" },
  );
  const location = response.headers.get("location");
  if (!location) {
    throw new Error(`authorization did not redirect: ${response.status} ${await response.text()}`);
  }
  return { code: new URL(location).searchParams.get("code")!, verifier: pkce.verifier };
}

function fetchUrl(
  url: string,
  params: Record<string, string>,
  headers: Record<string, string> = {},
  method: "GET" | "POST",
): Promise<Response> {
  if (method === "GET") {
    const requestUrl = new URL(url);
    for (const [key, value] of Object.entries(params)) {
      requestUrl.searchParams.set(key, value);
    }
    return fetch(requestUrl, { headers, redirect: "manual" });
  }
  return fetch(url, {
    method,
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      ...headers,
    },
    body: new URLSearchParams(params),
  });
}

function secretHashForTest(secret: string): string {
  return createHash("sha256").update(secret).digest("base64url");
}
