import assert from "node:assert/strict";
import { once } from "node:events";
import { test } from "node:test";
import express from "express";
import twilio from "twilio";
import { registerTwilioWebhookRoutes } from "../src/comms/twilio-routes.js";

const ACCOUNT_SID = `AC${"1".repeat(32)}`;
const AUTH_TOKEN = "synthetic-auth-token";
const CALL_SID = `CA${"5".repeat(32)}`;
const EXTERNAL_BASE_URL = "https://practice.example";

test("live Twilio SMS and Voice routes validate signatures and return inbound TwiML", async () => {
  const app = express();
  app.use(express.urlencoded({ extended: false }));
  const events: string[] = [];
  registerTwilioWebhookRoutes(app, {
    auth: { accountSid: ACCOUNT_SID, authToken: AUTH_TOKEN, externalBaseUrl: EXTERNAL_BASE_URL },
    voiceFromNumber: "+18645550100",
    voiceForwardToNumber: "+18645550101",
    onEvent: (kind) => { events.push(kind); },
  });
  const server = app.listen(0);
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected TCP test server.");

  try {
    const smsParams = {
      AccountSid: ACCOUNT_SID,
      MessageSid: `SM${"3".repeat(32)}`,
      From: "+18645550199",
      To: "+18645550100",
      Body: "Synthetic inbound message",
    };
    const smsPath = "/comms/twilio/inbound";
    const sms = await fetch(`http://127.0.0.1:${address.port}${smsPath}`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "x-twilio-signature": twilio.getExpectedTwilioSignature(
          AUTH_TOKEN,
          `${EXTERNAL_BASE_URL}${smsPath}`,
          smsParams,
        ),
      },
      body: new URLSearchParams(smsParams),
    });
    assert.equal(sms.status, 204);

    const voiceParams = {
      AccountSid: ACCOUNT_SID,
      CallSid: CALL_SID,
      From: "+18645550199",
      To: "+18645550100",
      Direction: "inbound",
      CallStatus: "ringing",
    };
    const voicePath = "/comms/twilio/voice/inbound";
    const voice = await fetch(`http://127.0.0.1:${address.port}${voicePath}`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "x-twilio-signature": twilio.getExpectedTwilioSignature(
          AUTH_TOKEN,
          `${EXTERNAL_BASE_URL}${voicePath}`,
          voiceParams,
        ),
      },
      body: new URLSearchParams(voiceParams),
    });
    assert.equal(voice.status, 200);
    assert.match(voice.headers.get("content-type") ?? "", /text\/xml/);
    const twiml = await voice.text();
    assert.match(twiml, /<Dial[^>]+answerOnBridge="true"/);
    assert.match(twiml, /\+18645550101/);
    assert.doesNotMatch(twiml, /record=/);

    const signedPost = async (path: string, params: Record<string, string>) => fetch(
      `http://127.0.0.1:${address.port}${path}`,
      {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          "x-twilio-signature": twilio.getExpectedTwilioSignature(
            AUTH_TOKEN,
            `${EXTERNAL_BASE_URL}${path}`,
            params,
          ),
        },
        body: new URLSearchParams(params),
      },
    );
    assert.equal((await signedPost("/comms/twilio/status", {
      AccountSid: ACCOUNT_SID,
      MessageSid: `SM${"3".repeat(32)}`,
      MessageStatus: "delivered",
    })).status, 204);
    assert.equal((await signedPost("/comms/twilio/voice/status", {
      AccountSid: ACCOUNT_SID,
      CallSid: CALL_SID,
      From: "+18645550100",
      To: "+18645550199",
      Direction: "outbound-dial",
      CallStatus: "completed",
      CallDuration: "42",
    })).status, 204);
    assert.equal((await signedPost("/comms/twilio/voice/recording", {
      AccountSid: ACCOUNT_SID,
      CallSid: CALL_SID,
      RecordingSid: `RE${"6".repeat(32)}`,
      RecordingStatus: "completed",
      RecordingDuration: "42",
      RecordingChannels: "2",
    })).status, 204);
    assert.deepEqual(events, [
      "sms-inbound",
      "voice-inbound",
      "sms-status",
      "voice-status",
      "voice-recording",
    ]);

    const rejected = await fetch(`http://127.0.0.1:${address.port}${voicePath}`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "x-twilio-signature": "tampered",
      },
      body: new URLSearchParams(voiceParams),
    });
    assert.equal(rejected.status, 403);
  } finally {
    server.close();
    await once(server, "close");
  }
});
