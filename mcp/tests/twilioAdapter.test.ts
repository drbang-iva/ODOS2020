import assert from "node:assert/strict";
import { test } from "node:test";
import twilio from "twilio";
import {
  TWILIO_REQUEST_TIMEOUT_MS,
  createTwilioAdapter,
  handleTwilioInboundWebhook,
  handleTwilioStatusWebhook,
  validateTwilioWebhook,
} from "../src/comms/adapters/twilio-adapter.js";

const ACCOUNT_SID = `AC${"1".repeat(32)}`;
const API_KEY_SID = `SK${"4".repeat(32)}`;
const MESSAGING_SERVICE_SID = `MG${"2".repeat(32)}`;
const MESSAGE_SID = `SM${"3".repeat(32)}`;
const AUTH_TOKEN = "synthetic-auth-token";
const API_KEY_SECRET = "synthetic-api-key-secret";
const EXTERNAL_BASE_URL = "https://practice.example";

test("Twilio SDK sends through a Messaging Service and owns the 30-second timeout", async () => {
  const factoryCalls: unknown[][] = [];
  const createCalls: Array<Record<string, unknown>> = [];
  const adapter = createTwilioAdapter({
    accountSid: ACCOUNT_SID,
    authToken: AUTH_TOKEN,
    messagingServiceSid: MESSAGING_SERVICE_SID,
  }, {
    clientFactory(username, password, options) {
      factoryCalls.push([username, password, options]);
      return {
        messages: {
          async create(input) {
            createCalls.push(input);
            return { sid: MESSAGE_SID };
          },
        },
      };
    },
  });

  const result = await adapter.sendSms!({
    patientReference: "Patient/synthetic-1",
    toNumber: "+18645550199",
    body: "Reminder: appointment with Dr. Example on Aug 3 at 2 PM.",
    campaignType: "appointment-reminder",
    suppression: {},
  });

  assert.deepEqual(result, { outcome: "sent", providerMessageId: MESSAGE_SID });
  assert.deepEqual(factoryCalls, [[
    ACCOUNT_SID,
    AUTH_TOKEN,
    { accountSid: ACCOUNT_SID, timeout: TWILIO_REQUEST_TIMEOUT_MS },
  ]]);
  assert.deepEqual(createCalls, [{
    to: "+18645550199",
    body: "Reminder: appointment with Dr. Example on Aug 3 at 2 PM. Reply STOP to unsubscribe.",
    messagingServiceSid: MESSAGING_SERVICE_SID,
  }]);
});

test("Twilio SDK preserves API-key authentication and explicit from-number mode", async () => {
  const factoryCalls: unknown[][] = [];
  const createCalls: Array<Record<string, unknown>> = [];
  const adapter = createTwilioAdapter({
    accountSid: ACCOUNT_SID,
    authToken: AUTH_TOKEN,
    apiKeySid: API_KEY_SID,
    apiKeySecret: API_KEY_SECRET,
    fromNumber: "+18645550100",
  }, {
    clientFactory(username, password, options) {
      factoryCalls.push([username, password, options]);
      return {
        messages: {
          async create(input) {
            createCalls.push(input);
            return { sid: MESSAGE_SID };
          },
        },
      };
    },
  });

  await adapter.sendSms!({
    patientReference: "Patient/synthetic-1",
    toNumber: "+18645550199",
    body: "Reminder tomorrow. Reply STOP to unsubscribe.",
    campaignType: "appointment-reminder",
    suppression: {},
  });

  assert.deepEqual(factoryCalls, [[
    API_KEY_SID,
    API_KEY_SECRET,
    { accountSid: ACCOUNT_SID, timeout: TWILIO_REQUEST_TIMEOUT_MS },
  ]]);
  assert.deepEqual(createCalls, [{
    to: "+18645550199",
    body: "Reminder tomorrow. Reply STOP to unsubscribe.",
    from: "+18645550100",
  }]);
});

test("Twilio RestException 21610 is a non-retryable recipient opt-out suppression", async () => {
  const optedOut = new twilio.RestException({
    statusCode: 400,
    body: { code: 21610, message: "Attempt to send to unsubscribed recipient" },
  });
  const adapter = createTwilioAdapter({
    accountSid: ACCOUNT_SID,
    authToken: AUTH_TOKEN,
    fromNumber: "+18645550100",
  }, {
    clientFactory: () => ({
      messages: { create: async () => Promise.reject(optedOut) },
    }),
  });

  const result = await adapter.sendSms!({
    patientReference: "Patient/synthetic-1",
    toNumber: "+18645550199",
    body: "Reminder tomorrow. Reply STOP to unsubscribe.",
    campaignType: "appointment-reminder",
    suppression: {},
  });

  assert.deepEqual(result, { outcome: "suppressed", reason: "patient-opt-out" });
});

test("non-21610 Twilio RestException is rethrown with its diagnostic code intact", async () => {
  const rejected = new twilio.RestException({
    statusCode: 400,
    body: { code: 21614, message: "Invalid mobile number" },
  });
  const adapter = createTwilioAdapter({
    accountSid: ACCOUNT_SID,
    authToken: AUTH_TOKEN,
    fromNumber: "+18645550100",
  }, {
    clientFactory: () => ({
      messages: { create: async () => Promise.reject(rejected) },
    }),
  });

  await assert.rejects(
    adapter.sendSms!({
      patientReference: "Patient/synthetic-1",
      toNumber: "+18645550199",
      body: "Reminder tomorrow. Reply STOP to unsubscribe.",
      campaignType: "appointment-reminder",
      suppression: {},
    }),
    (error: unknown) => error === rejected && rejected.code === 21614,
  );
});

test("published Twilio form signature vector validates and rejects tampering or the wrong token", () => {
  const params = {
    CallSid: "CA1234567890ABCDE",
    Caller: "+14158675309",
    Digits: "1234",
    From: "+14158675309",
    To: "+18005551212",
  };
  const request = {
    requestTarget: "/myapp.php?foo=1&bar=2",
    contentType: "application/x-www-form-urlencoded; charset=UTF-8",
    params,
    signature: "RSOYDt4T1cUTdK1PDd93/VVr8B8=",
  };
  const auth = {
    accountSid: ACCOUNT_SID,
    authToken: "12345",
    externalBaseUrl: "https://mycompany.com",
  };

  assert.deepEqual(validateTwilioWebhook(request, auth), params);
  assert.throws(
    () => validateTwilioWebhook({ ...request, params: { ...params, Digits: "9999" } }, auth),
    /signature/i,
  );
  assert.throws(
    () => validateTwilioWebhook(request, { ...auth, authToken: "wrong-token" }),
    /signature/i,
  );
  assert.throws(
    () => validateTwilioWebhook(request, {
      ...auth,
      externalBaseUrl: "https://internal-proxy.example",
    }),
    /signature/i,
  );
});

test("published Twilio JSON bodySHA256 vector validates raw body and rejects tampering", () => {
  const rawBody = '{"property": "value", "boolean": true}';
  const request = {
    requestTarget: "/myapp.php?foo=1&bar=2&bodySHA256="
      + "0a1ff7634d9ab3b95db5c9a2dfe9416e41502b283a80c7cf19632632f96e6620",
    contentType: "application/json",
    rawBody,
    signature: "a9nBmqA0ju/hNViExpshrM61xv4=",
  };
  const auth = {
    accountSid: ACCOUNT_SID,
    authToken: "12345",
    externalBaseUrl: "https://mycompany.com",
  };

  assert.deepEqual(validateTwilioWebhook(request, auth), {
    property: "value",
    boolean: true,
  });
  assert.throws(
    () => validateTwilioWebhook({ ...request, rawBody: `${rawBody} ` }, auth),
    /signature/i,
  );
});

test("Twilio webhook validation fails closed on an unrecognised content type", () => {
  assert.throws(
    () => validateTwilioWebhook({
      requestTarget: "/myapp.php?foo=1&bar=2",
      contentType: "text/plain",
      rawBody: "synthetic",
      signature: "synthetic-signature",
    }, {
      accountSid: ACCOUNT_SID,
      authToken: AUTH_TOKEN,
      externalBaseUrl: EXTERNAL_BASE_URL,
    }),
    /unsupported content type/i,
  );
});

test("Twilio inbound opt-out webhook uses the configured external URL before reading fields", () => {
  const requestTarget = "/comms/twilio/inbound";
  const url = `${EXTERNAL_BASE_URL}${requestTarget}`;
  const params = {
    AccountSid: ACCOUNT_SID,
    MessageSid: MESSAGE_SID,
    From: "+18645550199",
    To: "+18645550100",
    Body: "STOP",
    OptOutType: "STOP",
  };
  const event = handleTwilioInboundWebhook({
    requestTarget,
    contentType: "application/x-www-form-urlencoded",
    params,
    signature: twilio.getExpectedTwilioSignature(AUTH_TOKEN, url, params),
  }, { accountSid: ACCOUNT_SID, authToken: AUTH_TOKEN, externalBaseUrl: EXTERNAL_BASE_URL });

  assert.deepEqual(event, {
    accountSid: ACCOUNT_SID,
    messageSid: MESSAGE_SID,
    from: "+18645550199",
    to: "+18645550100",
    body: "STOP",
    optOutType: "STOP",
  });
});

test("Twilio status webhook recognizes asynchronous 21610 after SDK validation", () => {
  const requestTarget = "/comms/twilio/status";
  const url = `${EXTERNAL_BASE_URL}${requestTarget}`;
  const params = {
    AccountSid: ACCOUNT_SID,
    MessageSid: MESSAGE_SID,
    MessageStatus: "failed",
    ErrorCode: "21610",
  };
  const event = handleTwilioStatusWebhook({
    requestTarget,
    contentType: "application/x-www-form-urlencoded",
    params,
    signature: twilio.getExpectedTwilioSignature(AUTH_TOKEN, url, params),
  }, { accountSid: ACCOUNT_SID, authToken: AUTH_TOKEN, externalBaseUrl: EXTERNAL_BASE_URL });

  assert.equal(event.recipientOptedOut, true);
});
