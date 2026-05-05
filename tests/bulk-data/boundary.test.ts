import assert from "node:assert/strict";
import { generateKeyPairSync, sign, verify } from "node:crypto";
import { test } from "node:test";
import { AIAST_CODING } from "../../mcp/src/agentops/types.js";
import { assertBulkExportIdentifierIsOpaque, BULK_EXPORT_JOB_ID_PATTERN, generateBulkExportJobId } from "../../mcp/src/bulk-data/job-id-generator.js";
import { CPLYCUI_CODING, DICTAST_CODING, hasSecurityCode, serializeBulkDataNdjson } from "../../mcp/src/bulk-data/output/ndjson-serializer.js";
import { authorizationCode, createSmartTestServer, publicClient } from "../smart/helpers.ts";

test("Bulk Data export job IDs are opaque and contain no PHI-shaped substrings", () => {
  const seen = new Set<string>();
  for (let index = 0; index < 1000; index += 1) {
    const id = generateBulkExportJobId();
    assert.match(id, BULK_EXPORT_JOB_ID_PATTERN);
    assertBulkExportIdentifierIsOpaque(id);
    assert.equal(/\b(?:MRN|DOB|SSN|Patient|John|Smith)\b/i.test(id), false);
    assert.equal(seen.has(id), false);
    seen.add(id);
  }
});

test("Bulk Data export file URLs contain only high-entropy job paths", async () => {
  const server = await createSmartTestServer();
  try {
    server.state.clients.set("public-client", publicClient(server.origin));
    const token = await patientAccessToken(server, "patient/Patient.rs patient/Observation.rs");
    const kickoff = await fetch(`${server.origin}/Group/osod-exportable-group/$export?_type=Patient,Observation`, {
      headers: {
        Accept: "application/fhir+json",
        Prefer: "respond-async",
        Authorization: `Bearer ${token}`,
      },
    });
    assert.equal(kickoff.status, 202);
    const statusUrl = localServerUrl(server.origin, kickoff.headers.get("content-location")!);
    const status = await fetch(statusUrl, { headers: { Accept: "application/json" } });
    const manifest = await status.json() as { output: Array<{ url: string }> };
    assert.equal(manifest.output.length > 0, true);
    for (const output of manifest.output) {
      assert.equal(/\b(?:MRN|DOB|SSN|Patient\/|John|Smith|1970|1980|1990)\b/i.test(output.url), false);
      assert.match(new URL(output.url).pathname, /\/bulk-export\/file\/[A-Za-z0-9_-]{16,}\/[A-Za-z]+\.ndjson$/);
    }
  } finally {
    await server.close();
  }
});

test("Bulk Data NDJSON serialization preserves AIAST, DICTAST, and CPLYCUI meta.security codings", () => {
  const resource = {
    resourceType: "Observation",
    id: "ai-observation",
    meta: {
      security: [AIAST_CODING, DICTAST_CODING, CPLYCUI_CODING],
    },
    status: "final",
    code: { text: "AI-influenced fixture" },
  } as const;
  const [line] = serializeBulkDataNdjson([resource]).trim().split("\n");
  const parsed = JSON.parse(line!) as typeof resource;
  assert.equal(hasSecurityCode(parsed, "AIAST"), true);
  assert.equal(hasSecurityCode(parsed, "DICTAST"), true);
  assert.equal(hasSecurityCode(parsed, "CPLYCUI"), true);
});

test("Bulk Data file download rejects invalid and client-signed tokens before NDJSON streaming", async () => {
  const server = await createSmartTestServer();
  try {
    server.state.clients.set("public-client", publicClient(server.origin));
    const token = await patientAccessToken(server, "patient/Patient.rs patient/Observation.rs");
    const kickoff = await fetch(`${server.origin}/Group/osod-exportable-group/$export?_type=Patient,Observation`, {
      headers: {
        Accept: "application/fhir+json",
        Prefer: "respond-async",
        Authorization: `Bearer ${token}`,
      },
    });
    const statusUrl = localServerUrl(server.origin, kickoff.headers.get("content-location")!);
    const manifest = await (await fetch(statusUrl, { headers: { Accept: "application/json" } })).json() as {
      output: Array<{ url: string }>;
    };
    const fileUrl = localServerUrl(server.origin, manifest.output[0]!.url);
    const forged = clientSignedJwt();
    assert.equal(forged.clientJwksVerificationPasses, true);

    const rejected = await fetch(fileUrl, { headers: { Authorization: `Bearer ${forged.jwt}` } });
    assert.equal(rejected.status, 401);
    assert.equal((await rejected.text()).includes("Patient"), false);

    const accepted = await fetch(fileUrl, { headers: { Authorization: `Bearer ${token}` } });
    assert.equal(accepted.status, 200);
    assert.equal((await accepted.text()).includes("\"resourceType\""), true);
  } finally {
    await server.close();
  }
});

async function patientAccessToken(server: Awaited<ReturnType<typeof createSmartTestServer>>, scope: string): Promise<string> {
  const { code, verifier } = await authorizationCode(server, scope);
  const response = await server.token({
    grant_type: "authorization_code",
    client_id: "public-client",
    code,
    redirect_uri: `${server.origin}/callback`,
    code_verifier: verifier,
  });
  if (response.status !== 200) {
    assert.fail(await response.text());
  }
  return ((await response.json()) as { access_token: string }).access_token;
}

function localServerUrl(origin: string, advertised: string): string {
  const url = new URL(advertised);
  return `${origin}${url.pathname}${url.search}`;
}

function clientSignedJwt(): { readonly jwt: string; readonly clientJwksVerificationPasses: boolean } {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT", kid: "client-key" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({ iss: "public-client", sub: "public-client", exp: 2000000000 })).toString("base64url");
  const signingInput = `${header}.${payload}`;
  const signature = sign("RSA-SHA256", Buffer.from(signingInput), privateKey).toString("base64url");
  const jwt = `${signingInput}.${signature}`;
  return {
    jwt,
    clientJwksVerificationPasses: verify("RSA-SHA256", Buffer.from(signingInput), publicKey, Buffer.from(signature, "base64url")),
  };
}
