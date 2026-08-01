import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { test } from "node:test";
import {
  TWILIO_REQUEST_TIMEOUT_MS,
  createTwilioAdapter,
  handleTwilioInboundWebhook,
  handleTwilioStatusWebhook,
} from "../src/comms/adapters/twilio-adapter.js";

const ACCOUNT_SID = `AC${"1".repeat(32)}`;
const MESSAGING_SERVICE_SID = `MG${"2".repeat(32)}`;
const MESSAGE_SID = `SM${"3".repeat(32)}`;
const AUTH_TOKEN = "synthetic-auth-token";

function signature(url: string, params: Record<string, string>): string {
  const signed = Object.keys(params)
    .sort()
    .reduce((value, key) => `${value}${key}${params[key]}`, url);
  return createHmac("sha1", AUTH_TOKEN).update(signed).digest("base64");
}

test("Twilio adapter sends form-encoded SMS through a Messaging Service with mandatory opt-out language", async () => {
  const calls: Array<{ input: string; init?: RequestInit }> = [];
  const adapter = createTwilioAdapter({
    accountSid: ACCOUNT_SID,
    authToken: AUTH_TOKEN,
    messagingServiceSid: MESSAGING_SERVICE_SID,
  }, {
    fetchImpl: (async (input, init) => {
      calls.push({ input: String(input), init });
      return Response.json({ sid: MESSAGE_SID, status: "accepted" });
    }) as typeof fetch,
  });

  const result = await adapter.sendSms!({
    patientReference: "Patient/synthetic-1",
    toNumber: "+18645550199",
    body: "Reminder: appointment with Dr. Example on Aug 3 at 2 PM.",
    campaignType: "appointment-reminder",
    suppression: {},
  });

  assert.deepEqual(result, { outcome: "sent", providerMessageId: MESSAGE_SID });
  assert.equal(calls.length, 1);
  assert.equal(
    calls[0].input,
    `https://api.twilio.com/2010-04-01/Accounts/${ACCOUNT_SID}/Messages.json`,
  );
  assert.equal(calls[0].init?.method, "POST");
  assert.equal(
    new Headers(calls[0].init?.headers).get("authorization"),
    `Basic ${Buffer.from(`${ACCOUNT_SID}:${AUTH_TOKEN}`).toString("base64")}`,
  );
  const form = new URLSearchParams(String(calls[0].init?.body));
  assert.equal(form.get("To"), "+18645550199");
  assert.equal(form.get("MessagingServiceSid"), MESSAGING_SERVICE_SID);
  assert.match(form.get("Body") ?? "", /Reply STOP to unsubscribe\.$/);
});

test("Twilio Error 21610 is a non-retryable recipient opt-out suppression", async () => {
  let calls = 0;
  const adapter = createTwilioAdapter({
    accountSid: ACCOUNT_SID,
    authToken: AUTH_TOKEN,
    fromNumber: "+18645550100",
  }, {
    fetchImpl: (async () => {
      calls += 1;
      return Response.json({ code: 21610, message: "Attempt to send to unsubscribed recipient" }, {
        status: 400,
      });
    }) as typeof fetch,
  });

  const result = await adapter.sendSms!({
    patientReference: "Patient/synthetic-1",
    toNumber: "+18645550199",
    body: "Reminder: appointment tomorrow. Reply STOP to unsubscribe.",
    campaignType: "appointment-reminder",
    suppression: {},
  });

  assert.deepEqual(result, { outcome: "suppressed", reason: "patient-opt-out" });
  assert.equal(calls, 1);
});

test("Twilio adapter aborts a stalled request after the bounded timeout", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let requestSignal: AbortSignal | null | undefined;
  const adapter = createTwilioAdapter({
    accountSid: ACCOUNT_SID,
    authToken: AUTH_TOKEN,
    messagingServiceSid: MESSAGING_SERVICE_SID,
  }, {
    fetchImpl: (async (_input, init) => {
      requestSignal = init?.signal;
      return new Promise<Response>((_resolve, reject) => {
        requestSignal?.addEventListener(
          "abort",
          () => reject(new DOMException("This operation was aborted", "AbortError")),
          { once: true },
        );
      });
    }) as typeof fetch,
  });

  const request = adapter.sendSms!({
    patientReference: "Patient/synthetic-1",
    toNumber: "+18645550199",
    body: "Reminder: appointment tomorrow. Reply STOP to unsubscribe.",
    campaignType: "appointment-reminder",
    suppression: {},
  });
  assert.equal(requestSignal?.aborted, false);

  t.mock.timers.tick(TWILIO_REQUEST_TIMEOUT_MS);

  await assert.rejects(request, /Twilio request timed out after 30 seconds/);
  assert.equal(requestSignal?.aborted, true);
});

test("Twilio inbound opt-out webhook is trusted only after X-Twilio-Signature validation", () => {
  const url = "https://practice.example/comms/twilio/inbound";
  const params = {
    AccountSid: ACCOUNT_SID,
    MessageSid: MESSAGE_SID,
    From: "+18645550199",
    To: "+18645550100",
    Body: "STOP",
    OptOutType: "STOP",
  };
  const event = handleTwilioInboundWebhook({
    url,
    params,
    signature: signature(url, params),
  }, { accountSid: ACCOUNT_SID, authToken: AUTH_TOKEN });

  assert.deepEqual(event, {
    accountSid: ACCOUNT_SID,
    messageSid: MESSAGE_SID,
    from: "+18645550199",
    to: "+18645550100",
    body: "STOP",
    optOutType: "STOP",
  });
  assert.throws(
    () => handleTwilioInboundWebhook({ url, params, signature: "invalid" }, {
      accountSid: ACCOUNT_SID,
      authToken: AUTH_TOKEN,
    }),
    /signature/i,
  );
});

test("Twilio status webhook validates X-Twilio-Signature and recognizes asynchronous 21610", () => {
  const url = "https://practice.example/comms/twilio/status";
  const params = {
    AccountSid: ACCOUNT_SID,
    MessageSid: MESSAGE_SID,
    MessageStatus: "failed",
    ErrorCode: "21610",
  };
  const event = handleTwilioStatusWebhook({
    url,
    params,
    signature: signature(url, params),
  }, { accountSid: ACCOUNT_SID, authToken: AUTH_TOKEN });

  assert.equal(event.recipientOptedOut, true);
  assert.throws(
    () => handleTwilioStatusWebhook({ url, params, signature: "invalid" }, {
      accountSid: ACCOUNT_SID,
      authToken: AUTH_TOKEN,
    }),
    /signature/i,
  );
});
