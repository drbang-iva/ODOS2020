import assert from "node:assert/strict";
import { test } from "node:test";
import twilio from "twilio";
import {
  TWILIO_REQUEST_TIMEOUT_MS,
  createTwilioAdapter,
  handleTwilioInboundWebhook,
  handleTwilioRecordingWebhook,
  handleTwilioStatusWebhook,
  handleTwilioTranscriptionWebhook,
  handleTwilioVoiceWebhook,
  validateTwilioWebhook,
} from "../src/comms/adapters/twilio-adapter.js";

const ACCOUNT_SID = `AC${"1".repeat(32)}`;
const API_KEY_SID = `SK${"4".repeat(32)}`;
const VOICE_API_KEY_SID = `SK${"8".repeat(32)}`;
const MESSAGING_SERVICE_SID = `MG${"2".repeat(32)}`;
const MESSAGE_SID = `SM${"3".repeat(32)}`;
const CALL_SID = `CA${"5".repeat(32)}`;
const RECORDING_SID = `RE${"6".repeat(32)}`;
const TRANSCRIPTION_SID = `GT${"7".repeat(32)}`;
const AUTH_TOKEN = "synthetic-auth-token";
const API_KEY_SECRET = "synthetic-api-key-secret";
const VOICE_API_KEY_SECRET = "synthetic-voice-api-key-secret";
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

test("Twilio HIPAA mode accepts US destinations and rejects non-US or malformed SMS and Voice destinations", async () => {
  const messageCreates: Array<Record<string, unknown>> = [];
  const callCreates: Array<Record<string, unknown>> = [];
  const adapter = createTwilioAdapter({
    accountSid: ACCOUNT_SID,
    authToken: AUTH_TOKEN,
    messagingServiceSid: MESSAGING_SERVICE_SID,
    hipaaMode: true,
    voiceFromNumber: "+18645550100",
    voiceForwardToNumber: "+18645550101",
    webhookBaseUrl: EXTERNAL_BASE_URL,
    voiceApiKeySid: VOICE_API_KEY_SID,
    voiceApiKeySecret: VOICE_API_KEY_SECRET,
  }, {
    clientFactory: () => ({
      messages: {
        async create(input) {
          messageCreates.push(input);
          return { sid: MESSAGE_SID };
        },
      },
      calls: {
        async create(input) {
          callCreates.push(input);
          return { sid: CALL_SID };
        },
        list: async () => [],
        get: () => ({ fetch: async () => { throw new Error("unused"); } }),
      },
      recordings: {
        get: () => ({ fetch: async () => { throw new Error("unused"); } }),
      },
    }),
  });
  const smsRequest = {
    patientReference: "Patient/synthetic-1",
    body: "Reminder tomorrow.",
    campaignType: "appointment-reminder",
    suppression: {},
  };

  await adapter.sendSms!({ ...smsRequest, toNumber: "+18645550199" });
  await assert.rejects(adapter.sendSms!({ ...smsRequest, toNumber: "+442079460000" }), /US phone number.*HIPAA/i);
  await assert.rejects(adapter.sendSms!({ ...smsRequest, toNumber: "+14165550199" }), /US phone number.*HIPAA/i);
  await assert.rejects(adapter.sendSms!({ ...smsRequest, toNumber: "8645550199" }), /E\.164/i);
  await adapter.initiateCall!({ patientReference: "Patient/synthetic-1", toNumber: "+18645550199" });
  await assert.rejects(
    adapter.initiateCall!({ patientReference: "Patient/synthetic-1", toNumber: "+525555550199" }),
    /US phone number.*HIPAA/i,
  );

  assert.equal(messageCreates.length, 1);
  assert.equal(callCreates.length, 1);
});

test("Twilio keeps international destinations available outside HIPAA mode", async () => {
  const destinations: string[] = [];
  const adapter = createTwilioAdapter({
    accountSid: ACCOUNT_SID,
    authToken: AUTH_TOKEN,
    messagingServiceSid: MESSAGING_SERVICE_SID,
  }, {
    clientFactory: () => ({
      messages: {
        async create(input) {
          destinations.push(input.to);
          return { sid: MESSAGE_SID };
        },
      },
    }),
  });

  await adapter.sendSms!({
    patientReference: "Patient/synthetic-1",
    toNumber: "+442079460000",
    body: "Synthetic international message.",
    campaignType: "manual",
    suppression: {},
  });
  assert.deepEqual(destinations, ["+442079460000"]);
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

test("Twilio webhook validation rejects untrusted URL shapes and missing JSON raw bodies", () => {
  const formRequest = {
    requestTarget: "/comms/twilio/inbound",
    contentType: "application/x-www-form-urlencoded",
    params: {},
    signature: "synthetic-signature",
  };
  const auth = {
    accountSid: ACCOUNT_SID,
    authToken: AUTH_TOKEN,
    externalBaseUrl: EXTERNAL_BASE_URL,
  };

  assert.throws(
    () => validateTwilioWebhook(formRequest, {
      ...auth,
      externalBaseUrl: "http://practice.example",
    }),
    /externalBaseUrl must be an HTTPS origin/i,
  );
  assert.throws(
    () => validateTwilioWebhook(formRequest, {
      ...auth,
      externalBaseUrl: "https://practice.example/proxy",
    }),
    /externalBaseUrl must be an HTTPS origin/i,
  );
  assert.throws(
    () => validateTwilioWebhook({ ...formRequest, requestTarget: "relative/path" }, auth),
    /requestTarget must be an absolute path/i,
  );
  assert.throws(
    () => validateTwilioWebhook({ ...formRequest, requestTarget: "//forged.example/path" }, auth),
    /requestTarget must be an absolute path/i,
  );
  assert.throws(
    () => validateTwilioWebhook({
      requestTarget: "/comms/twilio/inbound?bodySHA256=synthetic",
      contentType: "application/json",
      signature: "synthetic-signature",
    }, auth),
    /raw body is required/i,
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

test("Twilio Voice initiates click-to-call through the practice line with signed callback URLs", async () => {
  const factoryCalls: unknown[][] = [];
  const createCalls: Array<Record<string, unknown>> = [];
  const adapter = createTwilioAdapter({
    accountSid: ACCOUNT_SID,
    authToken: AUTH_TOKEN,
    apiKeySid: API_KEY_SID,
    apiKeySecret: API_KEY_SECRET,
    messagingServiceSid: MESSAGING_SERVICE_SID,
    voiceFromNumber: "+18645550100",
    voiceForwardToNumber: "+18645550101",
    webhookBaseUrl: EXTERNAL_BASE_URL,
    voiceApiKeySid: VOICE_API_KEY_SID,
    voiceApiKeySecret: VOICE_API_KEY_SECRET,
    realTimeTranscriptionEnabled: true,
  }, {
    clientFactory: (username, password, options) => {
      factoryCalls.push([username, password, options]);
      return {
      messages: { create: async () => ({ sid: MESSAGE_SID }) },
      calls: {
        async create(input) {
          createCalls.push(input);
          return { sid: CALL_SID };
        },
        list: async () => [],
        get: () => ({ fetch: async () => { throw new Error("unused"); } }),
      },
      recordings: {
        get: () => ({ fetch: async () => { throw new Error("unused"); } }),
      },
      };
    },
  });

  assert.equal(adapter.capabilities.calls, true);
  assert.deepEqual(factoryCalls, [
    [API_KEY_SID, API_KEY_SECRET, {
      accountSid: ACCOUNT_SID,
      timeout: TWILIO_REQUEST_TIMEOUT_MS,
    }],
    [VOICE_API_KEY_SID, VOICE_API_KEY_SECRET, {
      accountSid: ACCOUNT_SID,
      timeout: TWILIO_REQUEST_TIMEOUT_MS,
    }],
  ]);
  assert.deepEqual(await adapter.initiateCall!({
    patientReference: "Patient/synthetic-1",
    toNumber: "+18645550199",
  }), { callId: CALL_SID });
  assert.equal(createCalls.length, 1);
  assert.equal(createCalls[0]?.to, "+18645550101");
  assert.equal(createCalls[0]?.from, "+18645550100");
  assert.equal(createCalls[0]?.statusCallback, `${EXTERNAL_BASE_URL}/comms/twilio/voice/status`);
  assert.deepEqual(createCalls[0]?.statusCallbackEvent, ["initiated", "ringing", "answered", "completed"]);
  assert.equal(createCalls[0]?.record, undefined);
  assert.match(
    String(createCalls[0]?.twiml),
    new RegExp(`<Transcription[^>]+statusCallbackUrl="${EXTERNAL_BASE_URL}/comms/twilio/voice/transcription"`),
  );
  assert.match(String(createCalls[0]?.twiml), /<Transcription[^>]+partialResults="false"/);
  assert.match(String(createCalls[0]?.twiml), /<Transcription[^>]+track="both_tracks"/);
  assert.doesNotMatch(String(createCalls[0]?.twiml), /intelligenceService=/);
  assert.match(String(createCalls[0]?.twiml), /<Dial[^>]+callerId="\+18645550100"/);
  assert.match(String(createCalls[0]?.twiml), /\+18645550199/);
  assert.doesNotMatch(String(createCalls[0]?.twiml), /record=/);
});

test("Twilio Voice lists and fetches normalized call detail", async () => {
  const call = {
    sid: CALL_SID,
    from: "+18645550100",
    to: "+18645550199",
    status: "completed",
    direction: "outbound-api",
    startTime: new Date("2026-08-01T15:00:00.000Z"),
    endTime: new Date("2026-08-01T15:05:00.000Z"),
    duration: "300",
  };
  const adapter = createTwilioAdapter({
    accountSid: ACCOUNT_SID,
    authToken: AUTH_TOKEN,
    messagingServiceSid: MESSAGING_SERVICE_SID,
    voiceFromNumber: "+18645550100",
    voiceForwardToNumber: "+18645550101",
    webhookBaseUrl: EXTERNAL_BASE_URL,
    voiceApiKeySid: VOICE_API_KEY_SID,
    voiceApiKeySecret: VOICE_API_KEY_SECRET,
  }, {
    clientFactory: () => ({
      messages: { create: async () => ({ sid: MESSAGE_SID }) },
      calls: {
        create: async () => ({ sid: CALL_SID }),
        list: async ({ limit }) => {
          assert.equal(limit, 20);
          return [call];
        },
        get: (sid) => ({
          fetch: async () => {
            assert.equal(sid, CALL_SID);
            return call;
          },
        }),
      },
      recordings: {
        get: () => ({ fetch: async () => { throw new Error("unused"); } }),
      },
    }),
  });

  const expected = {
    id: CALL_SID,
    from: "+18645550100",
    to: "+18645550199",
    status: "completed",
    direction: "outbound-api",
    startedAt: "2026-08-01T15:00:00.000Z",
    endedAt: "2026-08-01T15:05:00.000Z",
    durationSeconds: 300,
  };
  assert.deepEqual(await adapter.getCall!(CALL_SID), expected);
  assert.deepEqual(await adapter.listCalls!({ limit: 20 }), [expected]);
});

test("Twilio Voice fetches authenticated recording media only after operator acknowledgement", async () => {
  const fetches: Array<{ url: string; authorization: string | null; signal: AbortSignal | null }> = [];
  const adapter = createTwilioAdapter({
    accountSid: ACCOUNT_SID,
    authToken: AUTH_TOKEN,
    apiKeySid: API_KEY_SID,
    apiKeySecret: API_KEY_SECRET,
    messagingServiceSid: MESSAGING_SERVICE_SID,
    voiceFromNumber: "+18645550100",
    voiceForwardToNumber: "+18645550101",
    webhookBaseUrl: EXTERNAL_BASE_URL,
    voiceApiKeySid: VOICE_API_KEY_SID,
    voiceApiKeySecret: VOICE_API_KEY_SECRET,
    mediaUrlAuthAcknowledged: true,
  }, {
    clientFactory: () => ({
      messages: { create: async () => ({ sid: MESSAGE_SID }) },
      calls: {
        create: async () => ({ sid: CALL_SID }),
        list: async () => [],
        get: () => ({ fetch: async () => { throw new Error("unused"); } }),
      },
      recordings: {
        get: (sid) => ({
          fetch: async () => ({
            sid,
            callSid: CALL_SID,
            status: "completed",
            duration: "42",
          }),
        }),
      },
    }),
    fetchImpl: (async (input, init) => {
      const url = String(input);
      const headers = new Headers(init?.headers);
      fetches.push({
        url,
        authorization: headers.get("authorization"),
        signal: init?.signal instanceof AbortSignal ? init.signal : null,
      });
      if (url.endsWith(".mp3")) {
        return new Response(Uint8Array.from([1, 2, 3]), {
          headers: { "content-type": "audio/mpeg" },
        });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    }) as typeof fetch,
  });

  const recording = await adapter.fetchRecording!(RECORDING_SID);
  assert.equal(recording.id, RECORDING_SID);
  assert.equal(recording.callId, CALL_SID);
  assert.equal(recording.contentType, "audio/mpeg");
  assert.deepEqual([...recording.audio], [1, 2, 3]);

  assert.equal(adapter.fetchTranscription, undefined);
  assert.deepEqual(fetches.map(({ url }) => url), [
    `https://api.twilio.com/2010-04-01/Accounts/${ACCOUNT_SID}/Recordings/${RECORDING_SID}.mp3`,
  ]);
  assert.deepEqual(new Set(fetches.map(({ authorization }) => authorization)), new Set([
    `Basic ${Buffer.from(`${VOICE_API_KEY_SID}:${VOICE_API_KEY_SECRET}`).toString("base64")}`,
  ]));
  assert.equal(fetches.every(({ signal }) => signal instanceof AbortSignal), true);
});

test("Twilio refuses to expose recording retrieval before media-URL auth is acknowledged", () => {
  const adapter = createTwilioAdapter({
    accountSid: ACCOUNT_SID,
    authToken: AUTH_TOKEN,
    messagingServiceSid: MESSAGING_SERVICE_SID,
    voiceFromNumber: "+18645550100",
    voiceForwardToNumber: "+18645550101",
    webhookBaseUrl: EXTERNAL_BASE_URL,
    voiceApiKeySid: VOICE_API_KEY_SID,
    voiceApiKeySecret: VOICE_API_KEY_SECRET,
  }, {
    clientFactory: () => ({
      messages: { create: async () => ({ sid: MESSAGE_SID }) },
      calls: {
        create: async () => ({ sid: CALL_SID }),
        list: async () => [],
        get: () => ({ fetch: async () => { throw new Error("unused"); } }),
      },
      recordings: {
        get: () => ({ fetch: async () => { throw new Error("unused"); } }),
      },
    }),
  });

  assert.equal(adapter.fetchRecording, undefined);
  assert.equal(adapter.fetchTranscription, undefined);
});

test("signed Voice events expose caller ID and fail closed on tampering, missing signatures, or malformed fields", () => {
  const requestTarget = "/comms/twilio/voice/status";
  const url = `${EXTERNAL_BASE_URL}${requestTarget}`;
  const params = {
    AccountSid: ACCOUNT_SID,
    CallSid: CALL_SID,
    From: "+18645550199",
    To: "+18645550100",
    Direction: "inbound",
    CallStatus: "ringing",
    CallerName: "SYNTHETIC CALLER",
    SequenceNumber: "0",
  };
  const request = {
    requestTarget,
    contentType: "application/x-www-form-urlencoded",
    params,
    signature: twilio.getExpectedTwilioSignature(AUTH_TOKEN, url, params),
  };
  const auth = { accountSid: ACCOUNT_SID, authToken: AUTH_TOKEN, externalBaseUrl: EXTERNAL_BASE_URL };

  assert.deepEqual(handleTwilioVoiceWebhook(request, auth), {
    accountSid: ACCOUNT_SID,
    callId: CALL_SID,
    from: "+18645550199",
    to: "+18645550100",
    direction: "inbound",
    status: "ringing",
    callerName: "SYNTHETIC CALLER",
    sequenceNumber: 0,
  });
  const anonymousParams = { ...params, From: "anonymous" };
  assert.equal(handleTwilioVoiceWebhook({
    ...request,
    params: anonymousParams,
    signature: twilio.getExpectedTwilioSignature(AUTH_TOKEN, url, anonymousParams),
  }, auth).from, "anonymous");
  assert.throws(
    () => handleTwilioVoiceWebhook({ ...request, params: { ...params, From: "+18645550198" } }, auth),
    /signature/i,
  );
  assert.throws(
    () => handleTwilioVoiceWebhook({ ...request, signature: undefined }, auth),
    /signature/i,
  );
  assert.throws(
    () => handleTwilioVoiceWebhook({
      ...request,
      params: { ...params, CallStatus: "invented" },
      signature: twilio.getExpectedTwilioSignature(
        AUTH_TOKEN,
        url,
        { ...params, CallStatus: "invented" },
      ),
    }, auth),
    /CallStatus is invalid/i,
  );
});

test("signed recording events normalize availability metadata", () => {
  const requestTarget = "/comms/twilio/voice/recording";
  const url = `${EXTERNAL_BASE_URL}${requestTarget}`;
  const params = {
    AccountSid: ACCOUNT_SID,
    CallSid: CALL_SID,
    RecordingSid: RECORDING_SID,
    RecordingStatus: "completed",
    RecordingDuration: "42",
    RecordingChannels: "2",
  };
  const event = handleTwilioRecordingWebhook({
    requestTarget,
    contentType: "application/x-www-form-urlencoded",
    params,
    signature: twilio.getExpectedTwilioSignature(AUTH_TOKEN, url, params),
  }, { accountSid: ACCOUNT_SID, authToken: AUTH_TOKEN, externalBaseUrl: EXTERNAL_BASE_URL });

  assert.deepEqual(event, {
    accountSid: ACCOUNT_SID,
    callId: CALL_SID,
    recordingId: RECORDING_SID,
    status: "completed",
    durationSeconds: 42,
    channels: 2,
  });
});

test("signed Real-Time Transcription events expose final webhook content and fail closed on tampering", () => {
  const requestTarget = "/comms/twilio/voice/transcription";
  const url = `${EXTERNAL_BASE_URL}${requestTarget}`;
  const params = {
    AccountSid: ACCOUNT_SID,
    CallSid: CALL_SID,
    TranscriptionSid: TRANSCRIPTION_SID,
    Timestamp: "2026-08-01T22:15:00.000Z",
    SequenceId: "2",
    TranscriptionEvent: "transcription-content",
    LanguageCode: "en-US",
    Track: "inbound_track",
    TranscriptionData: JSON.stringify({ transcript: "Synthetic transcript text.", confidence: 0.98 }),
    Final: "true",
  };
  const request = {
    requestTarget,
    contentType: "application/x-www-form-urlencoded",
    params,
    signature: twilio.getExpectedTwilioSignature(AUTH_TOKEN, url, params),
  };
  const auth = { accountSid: ACCOUNT_SID, authToken: AUTH_TOKEN, externalBaseUrl: EXTERNAL_BASE_URL };

  assert.deepEqual(handleTwilioTranscriptionWebhook(request, auth), {
    accountSid: ACCOUNT_SID,
    callId: CALL_SID,
    transcriptionId: TRANSCRIPTION_SID,
    event: "transcription-content",
    timestamp: "2026-08-01T22:15:00.000Z",
    sequenceId: 2,
    languageCode: "en-US",
    track: "inbound_track",
    text: "Synthetic transcript text.",
    confidence: 0.98,
    final: true,
  });
  assert.throws(
    () => handleTwilioTranscriptionWebhook({
      ...request,
      params: { ...params, TranscriptionData: JSON.stringify({ transcript: "Tampered." }) },
    }, auth),
    /signature/i,
  );
});
