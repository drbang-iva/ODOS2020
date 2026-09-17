import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { requestOcucoGatekeeperPinCredentials } from "../src/integrations/ocuco-gatekeeper/pinBootstrap.js";
import { bootstrapOcucoGatekeeperPin } from "../../scripts/ocuco-gatekeeper-pin.js";

const BASE_URL = "https://gatekeeper-staging.opticalonline.com";
const PIN = "once-only PIN +/";
const LAB_ID = 1231;

function vendorResponse(): Response {
  return new Response(JSON.stringify({
    message: {
      lab: {
        environment: "staging",
        access_key_id: "aws-key-must-not-persist",
        secret_access_key: "aws-secret-must-not-persist",
        jwt_key: "jwt-key-from-vendor",
        jwt_secret: "jwt-secret-from-vendor",
        webrx_lab_id: "1231",
        requestApiV1: "request-api-v1",
        contractSending: [{
          hash_routing: "route",
          webrx_lab_id_origin: "1231",
          webrx_retailer_name_origin: "Origin",
          origin_type: "Retailer",
          webrx_lab_id_receiver: "456",
          webrx_retailer_name_receiver: "Receiver",
          receiver_type: "Lab",
        }],
        contractReceiving: [],
      },
    },
  }), { status: 200, headers: { "Content-Type": "application/json" } });
}

test("PIN exchange uses the exact pre-auth GET and returns only JWT credentials", async () => {
  let request: { url: string; init?: RequestInit } | undefined;
  const credentials = await requestOcucoGatekeeperPinCredentials({
    baseUrl: `${BASE_URL}/`, webrxLabId: LAB_ID, pinCode: PIN,
    fetchImpl: async (input, init) => {
      request = { url: String(input), init };
      return vendorResponse();
    },
  });

  assert.equal(request?.url, `${BASE_URL}/api/v1/legacy_orders/lab_access_with_pin?webrx_lab_id=1231&pin_code=once-only+PIN+%2B%2F`);
  assert.equal(request?.init?.method, "GET");
  assert.equal(request?.init?.redirect, "error");
  assert.equal(request?.init?.headers, undefined);
  assert.deepEqual(credentials, { jwtKey: "jwt-key-from-vendor", jwtSecret: "jwt-secret-from-vendor" });
});

test("PIN exchange refuses insecure URLs and invalid lab IDs before any request", async () => {
  let calls = 0;
  const fetchImpl: typeof fetch = async () => { calls += 1; return vendorResponse(); };
  await assert.rejects(requestOcucoGatekeeperPinCredentials({
    baseUrl: "http://gatekeeper-staging.opticalonline.com", webrxLabId: LAB_ID,
    pinCode: PIN, fetchImpl,
  }), /HTTPS/);
  await assert.rejects(requestOcucoGatekeeperPinCredentials({
    baseUrl: BASE_URL, webrxLabId: 1.5, pinCode: PIN, fetchImpl,
  }), /webrx_lab_id/);
  assert.equal(calls, 0);
});

test("PIN exchange refuses a malformed success and never includes the PIN in errors", async () => {
  for (const response of [
    new Response(JSON.stringify({ message: { lab: { jwt_key: "key" } } }), { status: 200 }),
    new Response("not authorized", { status: 403 }),
  ]) {
    await assert.rejects(requestOcucoGatekeeperPinCredentials({
      baseUrl: BASE_URL, webrxLabId: LAB_ID, pinCode: PIN,
      fetchImpl: async () => response,
    }), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(error.message.includes(PIN), false);
      return true;
    });
  }
  await assert.rejects(requestOcucoGatekeeperPinCredentials({
    baseUrl: BASE_URL, webrxLabId: LAB_ID, pinCode: PIN,
    fetchImpl: async () => { throw new Error(`request ${PIN} failed`); },
  }), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal(error.message.includes(PIN), false);
    return true;
  });
});

for (const field of ["jwt_key", "jwt_secret"] as const) {
  for (const [label, value] of [["empty", ""], ["whitespace-only", " \t\r\n"]]) {
    test(`PIN exchange rejects ${label} ${field} with the other credential valid`, async () => {
      const body = await vendorResponse().json();
      body.message.lab[field] = value;
      await assert.rejects(requestOcucoGatekeeperPinCredentials({
        baseUrl: BASE_URL, webrxLabId: LAB_ID, pinCode: PIN,
        fetchImpl: async () => new Response(JSON.stringify(body), { status: 200 }),
      }), /response is missing jwt_key or jwt_secret/);
    });
  }
}

test("bootstrap stores the JWT pair in a private env file without PIN or unrelated vendor secrets", async () => {
  const directory = mkdtempSync(join(tmpdir(), "odos-ocuco-pin-"));
  const envPath = join(directory, ".env");
  try {
    writeFileSync(envPath, "OTHER=value\nOCUCO_GATEKEEPER_JWT_KEY=\nOCUCO_GATEKEEPER_JWT_SECRET=\n");
    await bootstrapOcucoGatekeeperPin({
      baseUrl: BASE_URL, webrxLabId: LAB_ID, pinCode: PIN, envPath,
      fetchImpl: async () => vendorResponse(),
    });
    const saved = readFileSync(envPath, "utf8");
    assert.match(saved, /^OTHER=value$/m);
    assert.match(saved, /^OCUCO_GATEKEEPER_BASE_URL=https:\/\/gatekeeper-staging\.opticalonline\.com$/m);
    assert.match(saved, /^OCUCO_GATEKEEPER_JWT_KEY=jwt-key-from-vendor$/m);
    assert.match(saved, /^OCUCO_GATEKEEPER_JWT_SECRET=jwt-secret-from-vendor$/m);
    assert.equal(saved.includes(PIN), false);
    assert.equal(saved.includes("aws-secret-must-not-persist"), false);
    assert.equal(statSync(envPath).mode & 0o777, 0o600);
    const loaded = spawnSync(process.execPath, [
      `--env-file=${envPath}`,
      "-e",
      "process.stdout.write(`${process.env.OCUCO_GATEKEEPER_JWT_KEY}:${process.env.OCUCO_GATEKEEPER_JWT_SECRET}`)",
    ], { encoding: "utf8", env: { PATH: process.env.PATH } });
    assert.equal(loaded.status, 0);
    assert.equal(loaded.stdout, "jwt-key-from-vendor:jwt-secret-from-vendor");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("bootstrap refuses configured JWT values without consuming the one-time PIN", async () => {
  const directory = mkdtempSync(join(tmpdir(), "odos-ocuco-pin-"));
  const envPath = join(directory, ".env");
  try {
    const original = "OCUCO_GATEKEEPER_JWT_KEY=existing\nOCUCO_GATEKEEPER_JWT_SECRET=existing\n";
    writeFileSync(envPath, original);
    let calls = 0;
    await assert.rejects(bootstrapOcucoGatekeeperPin({
      baseUrl: BASE_URL, webrxLabId: LAB_ID, pinCode: PIN, envPath,
      fetchImpl: async () => { calls += 1; return vendorResponse(); },
    }), /already configured/);
    assert.equal(calls, 0);
    assert.equal(readFileSync(envPath, "utf8"), original);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("bootstrap refuses an env URL mismatch before consuming the one-time PIN", async () => {
  const directory = mkdtempSync(join(tmpdir(), "odos-ocuco-pin-"));
  const envPath = join(directory, ".env");
  try {
    writeFileSync(envPath, "OCUCO_GATEKEEPER_BASE_URL=https://gatekeeper.opticalonline.com\n");
    let calls = 0;
    await assert.rejects(bootstrapOcucoGatekeeperPin({
      baseUrl: BASE_URL, webrxLabId: LAB_ID, pinCode: PIN, envPath,
      fetchImpl: async () => { calls += 1; return vendorResponse(); },
    }), /base URL differs/);
    assert.equal(calls, 0);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("bootstrap appends credentials after a concurrent unrelated env edit without losing that edit", async () => {
  const directory = mkdtempSync(join(tmpdir(), "odos-ocuco-pin-"));
  const envPath = join(directory, ".env");
  try {
    writeFileSync(envPath, "OTHER=before\n");
    await bootstrapOcucoGatekeeperPin({
      baseUrl: BASE_URL, webrxLabId: LAB_ID, pinCode: PIN, envPath,
      fetchImpl: async () => {
        writeFileSync(envPath, "OTHER=changed\n");
        return vendorResponse();
      },
    });
    const saved = readFileSync(envPath, "utf8");
    assert.match(saved, /^OTHER=changed$/m);
    assert.match(saved, /^OCUCO_GATEKEEPER_JWT_SECRET=jwt-secret-from-vendor$/m);
    assert.equal(statSync(envPath).mode & 0o777, 0o600);
    assert.deepEqual(readdirSync(join(directory, ".odos")), []);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("bootstrap keeps exchanged credentials in private recovery if another JWT pair appears meanwhile", async () => {
  const directory = mkdtempSync(join(tmpdir(), "odos-ocuco-pin-"));
  const envPath = join(directory, ".env");
  try {
    writeFileSync(envPath, "OTHER=before\n");
    await assert.rejects(bootstrapOcucoGatekeeperPin({
      baseUrl: BASE_URL, webrxLabId: LAB_ID, pinCode: PIN, envPath,
      fetchImpl: async () => {
        writeFileSync(envPath, "OTHER=before\nOCUCO_GATEKEEPER_JWT_KEY=concurrent\n");
        return vendorResponse();
      },
    }), /private recovery file/);
    assert.match(readFileSync(envPath, "utf8"), /^OCUCO_GATEKEEPER_JWT_KEY=concurrent$/m);
    const [recoveryName] = readdirSync(join(directory, ".odos"));
    const recoveryPath = join(directory, ".odos", recoveryName);
    assert.match(readFileSync(recoveryPath, "utf8"), /^OCUCO_GATEKEEPER_JWT_SECRET=jwt-secret-from-vendor$/m);
    assert.equal(statSync(recoveryPath).mode & 0o777, 0o600);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("failed PIN exchange leaves the env file unchanged and removes its empty recovery file", async () => {
  const directory = mkdtempSync(join(tmpdir(), "odos-ocuco-pin-"));
  const envPath = join(directory, ".env");
  try {
    writeFileSync(envPath, "OTHER=before\n");
    await assert.rejects(bootstrapOcucoGatekeeperPin({
      baseUrl: BASE_URL, webrxLabId: LAB_ID, pinCode: PIN, envPath,
      fetchImpl: async () => new Response("denied", { status: 403 }),
    }), /HTTP 403/);
    assert.equal(readFileSync(envPath, "utf8"), "OTHER=before\n");
    assert.deepEqual(readdirSync(join(directory, ".odos")), []);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
