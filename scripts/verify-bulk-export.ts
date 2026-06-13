#!/usr/bin/env tsx
import { createServer, type Server } from "node:http";
import {
  createPublicKey,
  generateKeyPairSync,
  randomUUID,
  sign,
  type JsonWebKey,
  type KeyObject,
} from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "../mcp/node_modules/express/index.js";
import type { Patient, Resource } from "@medplum/fhirtypes";
import { AIAST_CODING } from "../mcp/src/agentops/types.js";
import { defaultBulkDataBackendScopes } from "../mcp/src/bulk-data/auth/backend-services.js";
import { CPLYCUI_CODING, DICTAST_CODING, hasSecurityCode } from "../mcp/src/bulk-data/output/ndjson-serializer.js";
import {
  createEphemeralSmartSigningKey,
  createSmartAuthorizationRouter,
  SmartAuthorizationState,
  type SmartClientRegistration,
} from "../mcp/src/smart/authorization-server.js";

const clientId = "osod-tier1-bulk-export-verify";
const keyId = "osod-tier1-bulk-export-key";
const groupId = "tier1-bulk-group";
const patientId = "tier1-bulk-patient";
const outputRoot = mkdtempSync(join(tmpdir(), "osod-bulk-export-verify-"));
const scopes = defaultBulkDataBackendScopes();
const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });

const app = express();
const server = createServer(app);

try {
  await listen(server);
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Bulk export verifier server did not bind a TCP port.");
  }
  const origin = `http://127.0.0.1:${address.port}`;
  const publicJwk = publicJwkFor(privateKey);
  app.get("/tier1-bulk-client.jwks.json", (_req, res) => res.json({ keys: [publicJwk] }));

  const state = new SmartAuthorizationState([backendClient(origin)]);
  app.use(
    createSmartAuthorizationRouter({
      issuer: origin,
      fhirBaseUrl: `${origin}/fhir/R4`,
      signingKey: createEphemeralSmartSigningKey(),
      state,
      bulkData: {
        config: {
          outputRoot,
          practicePublicBaseUrl: origin,
        },
        fixture: {
          groups: new Map([[groupId, [patientId]]]),
          resources: exportFixture(),
        },
      },
    }),
  );

  const token = await backendServicesToken(origin);
  const kickoff = await fetch(`${origin}/Group/${groupId}/$export?_type=Group,Patient,Observation`, {
    headers: {
      Accept: "application/fhir+json",
      Prefer: "respond-async",
      Authorization: `Bearer ${token.accessToken}`,
      "X-OSOD-Actor-Id": clientId,
    },
  });
  if (kickoff.status !== 202) {
    throw new Error(`Bulk export kickoff failed: ${kickoff.status} ${await kickoff.text()}`);
  }

  const statusUrl = requireHeader(kickoff, "content-location");
  const manifest = await pollManifest(localUrl(origin, statusUrl), token.accessToken);
  if (!manifest.requiresAccessToken) {
    throw new Error("Bulk export manifest must require an access token.");
  }

  const downloads = await downloadOutputs(origin, manifest, token.accessToken);
  const security = {
    AIAST: downloads.resources.some((resource) => hasSecurityCode(resource, "AIAST")),
    DICTAST: downloads.resources.some((resource) => hasSecurityCode(resource, "DICTAST")),
    CPLYCUI: downloads.resources.some((resource) => hasSecurityCode(resource, "CPLYCUI")),
  };
  const missing = Object.entries(security).filter(([, present]) => !present).map(([code]) => code);
  if (missing.length) {
    throw new Error(`Bulk export NDJSON missing preserved meta.security labels: ${missing.join(", ")}.`);
  }

  console.log(JSON.stringify({
    status: "PASS",
    tokenEndpoint: "/oauth2/token",
    clientId,
    group: `Group/${groupId}`,
    request: manifest.request,
    requiresAccessToken: manifest.requiresAccessToken,
    outputTypes: manifest.output.map((entry) => entry.type),
    ndjsonFiles: downloads.files,
    resourceCount: downloads.resources.length,
    metaSecurityPreserved: security,
  }, null, 2));
} finally {
  await close(server);
  rmSync(outputRoot, { recursive: true, force: true });
}

interface BulkManifest {
  readonly request: string;
  readonly requiresAccessToken: boolean;
  readonly output: Array<{ readonly type: string; readonly url: string; readonly count?: number }>;
  readonly error?: unknown[];
}

function exportFixture(): Resource[] {
  const patient: Patient = {
    resourceType: "Patient",
    id: patientId,
    active: true,
    name: [{ use: "official", family: "Tier1Bulk", given: ["Synthetic"] }],
  };
  return [
    {
      resourceType: "Group",
      id: groupId,
      type: "person",
      actual: true,
      member: [{ entity: { reference: `Patient/${patientId}` } }],
    },
    patient,
    {
      resourceType: "Observation",
      id: "tier1-bulk-observation",
      meta: {
        security: [AIAST_CODING, DICTAST_CODING, CPLYCUI_CODING],
      },
      status: "final",
      code: { text: "Tier-1 Bulk Data verifier observation" },
      subject: { reference: `Patient/${patientId}` },
    },
  ];
}

function backendClient(origin: string): SmartClientRegistration {
  return {
    clientId,
    name: "OSOD Tier-1 Bulk Export Verifier",
    redirectUris: [`${origin}/bulk/callback`],
    clientType: "confidential",
    tokenEndpointAuthMethod: "private_key_jwt",
    jwksUri: `${origin}/tier1-bulk-client.jwks.json`,
    scopesAllowed: scopes.split(/\s+/),
    isSandbox: true,
  };
}

async function backendServicesToken(origin: string): Promise<{ readonly accessToken: string; readonly scope: string }> {
  const response = await fetch(`${origin}/oauth2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: clientId,
      scope: "system/Group.read system/Patient.read system/Observation.read",
      client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
      client_assertion: clientAssertion(origin),
    }),
  });
  if (!response.ok) {
    throw new Error(`SMART Backend Services token request failed: ${response.status} ${await response.text()}`);
  }
  const body = await response.json() as { access_token?: string; scope?: string };
  if (!body.access_token) {
    throw new Error("SMART Backend Services token response did not include access_token.");
  }
  return { accessToken: body.access_token, scope: body.scope ?? "" };
}

function clientAssertion(audience: string): string {
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT", kid: keyId })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({
    iss: clientId,
    sub: clientId,
    aud: audience,
    iat: now,
    exp: now + 300,
    jti: randomUUID(),
  })).toString("base64url");
  const signingInput = `${header}.${payload}`;
  const signature = sign("RSA-SHA256", Buffer.from(signingInput), privateKey).toString("base64url");
  return `${signingInput}.${signature}`;
}

function publicJwkFor(key: KeyObject): JsonWebKey {
  const jwk = createPublicKey(key).export({ format: "jwk" }) as JsonWebKey;
  jwk.kid = keyId;
  jwk.alg = "RS256";
  jwk.use = "sig";
  return jwk;
}

async function pollManifest(statusUrl: string, accessToken: string): Promise<BulkManifest> {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const response = await fetch(statusUrl, {
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
    });
    if (response.status === 202) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      continue;
    }
    if (!response.ok) {
      throw new Error(`Bulk export status poll failed: ${response.status} ${await response.text()}`);
    }
    return await response.json() as BulkManifest;
  }
  throw new Error("Bulk export status poll did not complete.");
}

async function downloadOutputs(
  origin: string,
  manifest: BulkManifest,
  accessToken: string,
): Promise<{ readonly files: Record<string, number>; readonly resources: Resource[] }> {
  const files: Record<string, number> = {};
  const resources: Resource[] = [];
  for (const output of manifest.output) {
    const response = await fetch(localUrl(origin, output.url), {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!response.ok) {
      throw new Error(`Bulk export NDJSON download failed for ${output.type}: ${response.status} ${await response.text()}`);
    }
    const text = await response.text();
    const lines = text.split(/\r?\n/).filter(Boolean);
    files[`${output.type}.ndjson`] = lines.length;
    for (const line of lines) {
      const parsed = JSON.parse(line) as Resource;
      if (!parsed.resourceType) {
        throw new Error(`Bulk export NDJSON line missing resourceType in ${output.type}.ndjson.`);
      }
      resources.push(parsed);
    }
  }
  return { files, resources };
}

function localUrl(origin: string, advertised: string): string {
  const url = new URL(advertised);
  return `${origin}${url.pathname}${url.search}`;
}

function requireHeader(response: Response, name: string): string {
  const value = response.headers.get(name);
  if (!value) {
    throw new Error(`Expected response header ${name}.`);
  }
  return value;
}

function listen(server: Server): Promise<void> {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
}

function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}
