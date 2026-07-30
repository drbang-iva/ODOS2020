import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { test } from "node:test";
import {
  GMAIL_SEND_SCOPE,
  createGoogleWorkspaceAdapter,
} from "../src/comms/adapters/google-workspace-adapter.js";

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });

const CONFIG = {
  serviceAccountEmail: "odos-comms@synthetic-project.iam.gserviceaccount.com",
  privateKey: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  delegatedUserEmail: "info@synthetic-practice.example",
  workspaceDomain: "synthetic-practice.example",
  fromAddress: "info@synthetic-practice.example",
  workspacePlanConfirmed: true,
};

test("Google Workspace adapter exchanges a delegated service-account JWT and sends base64url MIME through users.messages.send", async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} });
    if (calls.length === 1) {
      return new Response(JSON.stringify({ access_token: "synthetic-access-token", expires_in: 3600 }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response(JSON.stringify({ id: "gmail-message-1", threadId: "thread-1" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;

  const adapter = createGoogleWorkspaceAdapter(CONFIG, {
    fetchImpl,
    now: () => new Date("2026-07-30T14:00:00.000Z"),
  });
  const result = await adapter.sendEmail({
    patientReference: "Patient/synthetic-1",
    toAddress: "patient@example.test",
    subject: "Appointment reminder",
    body: "Your appointment is July 31 at 10:00 AM with Dr. Example at Main Office.",
    campaignType: "appointment-reminder",
    suppression: {},
  });

  assert.deepEqual(result, {
    outcome: "sent",
    providerMessageId: "gmail-message-1",
    providerThreadId: "thread-1",
  });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, "https://oauth2.googleapis.com/token");
  const tokenBody = new URLSearchParams(String(calls[0].init.body));
  assert.equal(tokenBody.get("grant_type"), "urn:ietf:params:oauth:grant-type:jwt-bearer");
  const assertion = tokenBody.get("assertion")!;
  const claims = JSON.parse(Buffer.from(assertion.split(".")[1], "base64url").toString()) as {
    scope: string;
    sub: string;
    aud: string;
  };
  assert.equal(claims.scope, GMAIL_SEND_SCOPE);
  assert.equal(claims.sub, CONFIG.delegatedUserEmail);
  assert.equal(claims.aud, "https://oauth2.googleapis.com/token");

  assert.equal(
    calls[1].url,
    "https://gmail.googleapis.com/gmail/v1/users/info%40synthetic-practice.example/messages/send",
  );
  assert.equal(
    (calls[1].init.headers as Record<string, string>).Authorization,
    "Bearer synthetic-access-token",
  );
  const gmailBody = JSON.parse(String(calls[1].init.body)) as { raw: string };
  const mime = Buffer.from(gmailBody.raw, "base64url").toString();
  assert.match(mime, /^From: info@synthetic-practice\.example\r$/m);
  assert.match(mime, /^To: patient@example\.test\r$/m);
  assert.match(mime, /^Subject: Appointment reminder\r$/m);
  assert.match(mime, /Your appointment is July 31 at 10:00 AM/);
});

test("adapter capability metadata stays honest and warns without hard-blocking consumer Gmail or unconfirmed Workspace posture", () => {
  const warnings: string[] = [];
  const adapter = createGoogleWorkspaceAdapter({
    ...CONFIG,
    delegatedUserEmail: "synthetic.sender@gmail.com",
    workspaceDomain: "gmail.com",
    fromAddress: "synthetic.sender@gmail.com",
    workspacePlanConfirmed: undefined,
  }, { warn: (message) => warnings.push(message) });

  assert.equal(adapter.name, "google-workspace");
  assert.deepEqual(adapter.capabilities, {
    sms: false,
    calls: false,
    email: true,
    contacts: false,
    conversations: false,
    reviews: false,
  });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /paid Google Workspace|personal Gmail|BAA/i);
});

test("Google Workspace adapter rejects missing destinations and header injection before any vendor call", async () => {
  let calls = 0;
  const adapter = createGoogleWorkspaceAdapter(CONFIG, {
    fetchImpl: (async () => {
      calls += 1;
      return new Response();
    }) as typeof fetch,
  });

  await assert.rejects(() => adapter.sendEmail({
    patientReference: "Patient/synthetic-1",
    subject: "Appointment reminder",
    body: "Appointment logistics only.",
    campaignType: "appointment-reminder",
    suppression: {},
  }), /email address/i);
  await assert.rejects(() => adapter.sendEmail({
    patientReference: "Patient/synthetic-1",
    toAddress: "patient@example.test",
    subject: "Appointment reminder\r\nBcc: outsider@example.test",
    body: "Appointment logistics only.",
    campaignType: "appointment-reminder",
    suppression: {},
  }), /header/i);
  assert.equal(calls, 0);
});
