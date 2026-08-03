import assert from "node:assert/strict";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import type { Bundle, Communication, Patient, Resource } from "@medplum/fhirtypes";
import express from "express";
import twilio from "twilio";
import {
  ODOS_COMMS_STAFF_SEND_IDENTIFIER_SYSTEM,
  ODOS_TWILIO_CALL_IDENTIFIER_SYSTEM,
  ODOS_TWILIO_MESSAGE_IDENTIFIER_SYSTEM,
  persistStaffSentSms,
  persistTwilioWebhookEvent,
  reserveStaffSmsSend,
} from "../src/comms/comms-persistence.js";
import { createTwilioAdapter, withTwilioConversationStore } from "../src/comms/adapters/twilio-adapter.js";
import { registerTwilioWebhookRoutes } from "../src/comms/twilio-routes.js";

const ACCOUNT_SID = `AC${"1".repeat(32)}`;
const MESSAGE_SID = `SM${"2".repeat(32)}`;
const CALL_SID = `CA${"3".repeat(32)}`;
const RECORDING_SID = `RE${"4".repeat(32)}`;
const TRANSCRIPTION_SID = `GT${"5".repeat(32)}`;
const PATIENT_NUMBER = "+18645550199";
const PRACTICE_NUMBER = "+18645550100";
const NOW = "2026-08-02T15:00:00.000Z";

test("duplicate inbound SMS delivery creates one patient-linked Communication", async () => {
  const fhir = new InMemoryCommsFhir();
  fhir.seed({
    resourceType: "Patient",
    id: "synthetic-1",
    telecom: [{ system: "phone", use: "mobile", value: PATIENT_NUMBER }],
  } satisfies Patient);
  const event = {
    accountSid: ACCOUNT_SID,
    messageSid: MESSAGE_SID,
    from: PATIENT_NUMBER,
    to: PRACTICE_NUMBER,
    body: "Synthetic scheduling question",
  };

  await persistTwilioWebhookEvent(fhir, "sms-inbound", event, { now: () => NOW });
  await persistTwilioWebhookEvent(fhir, "sms-inbound", event, { now: () => "2026-08-02T16:00:00.000Z" });

  const communications = fhir.ofType<Communication>("Communication");
  assert.equal(communications.length, 1);
  assert.deepEqual(communications[0].identifier, [{ system: ODOS_TWILIO_MESSAGE_IDENTIFIER_SYSTEM, value: MESSAGE_SID }]);
  assert.equal(communications[0].subject?.reference, "Patient/synthetic-1");
  assert.equal(communications[0].sender?.reference, "Patient/synthetic-1");
  assert.equal(communications[0].recipient?.[0].identifier?.value, PRACTICE_NUMBER);
  assert.equal(communications[0].received, NOW);
  assert.equal(communications[0].payload?.[0].contentString, "Synthetic scheduling question");
  assert.equal(fhir.createAttempts, 1);
});

test("staff-sent SMS and its status callback converge into one patient-linked conversation entry", async () => {
  const fhir = new InMemoryCommsFhir();
  const reservation = await reserveStaffSmsSend(fhir, {
    idempotencyKey: "synthetic-send-0001",
    claimId: "synthetic-claim-0001",
    patientReference: "Patient/synthetic-1",
    senderReference: "Practitioner/synthetic-staff",
    body: "Synthetic staff message",
  });
  assert.equal(reservation.state, "owner");
  await persistStaffSentSms(fhir, {
    communication: reservation.communication,
    idempotencyKey: "synthetic-send-0001",
    providerMessageId: MESSAGE_SID,
  }, { now: () => NOW });
  await persistTwilioWebhookEvent(fhir, "sms-status", {
    accountSid: ACCOUNT_SID,
    messageSid: MESSAGE_SID,
    messageStatus: "delivered",
    recipientOptedOut: false,
  }, { now: () => "2026-08-02T15:01:00.000Z" });

  const communications = fhir.ofType<Communication>("Communication");
  assert.equal(communications.length, 1);
  assert.equal(communications[0].status, "completed");
  assert.equal(communications[0].statusReason?.text, "Twilio message status: delivered");
  assert.equal(communications[0].subject?.reference, "Patient/synthetic-1");
  assert.equal(communications[0].sender?.reference, "Practitioner/synthetic-staff");
  assert.equal(communications[0].recipient?.[0].reference, "Patient/synthetic-1");
  assert.equal(communications[0].sent, NOW);
  assert.equal(communications[0].payload?.[0].contentString, "Synthetic staff message");
  assert.match(JSON.stringify(communications[0].category), /patient-sms-outbound/);
});

test("an idempotency key cannot be replayed through a different communications provider", async () => {
  const fhir = new InMemoryCommsFhir();
  const input = {
    idempotencyKey: "synthetic-provider-bound-send",
    patientReference: "Patient/synthetic-1",
    senderReference: "Practitioner/synthetic-staff",
    body: "Synthetic provider-bound message",
  };
  const twilio = await reserveStaffSmsSend(fhir, {
    ...input,
    claimId: "synthetic-provider-claim-1",
    provider: "twilio",
    providerMessageIdentifierSystem: ODOS_TWILIO_MESSAGE_IDENTIFIER_SYSTEM,
  });
  assert.equal(twilio.state, "owner");
  const ghl = await reserveStaffSmsSend(fhir, {
    ...input,
    claimId: "synthetic-provider-claim-2",
    provider: "ghl",
    providerMessageIdentifierSystem: "https://odos2020.com/fhir/NamingSystem/ghl-message-id",
  });
  assert.equal(ghl.state, "conflict");
});

test("a legacy reservation without a provider identifier remains bound to Twilio", async () => {
  const fhir = new InMemoryCommsFhir();
  fhir.seed({
    resourceType: "Communication",
    id: "legacy-provider-reservation",
    status: "preparation",
    identifier: [
      { system: ODOS_COMMS_STAFF_SEND_IDENTIFIER_SYSTEM, value: "synthetic-legacy-provider-send" },
    ],
    subject: { reference: "Patient/synthetic-1" },
    sender: { reference: "Practitioner/synthetic-staff" },
    recipient: [{ reference: "Patient/synthetic-1" }],
    payload: [{ contentString: "Synthetic legacy provider message" }],
  } satisfies Communication);

  const reservation = await reserveStaffSmsSend(fhir, {
    idempotencyKey: "synthetic-legacy-provider-send",
    claimId: "synthetic-legacy-provider-claim",
    patientReference: "Patient/synthetic-1",
    senderReference: "Practitioner/synthetic-staff",
    body: "Synthetic legacy provider message",
    provider: "ghl",
    providerMessageIdentifierSystem: "https://odos2020.com/fhir/NamingSystem/ghl-message-id",
  });

  assert.equal(reservation.state, "conflict");
});

test("a status callback racing send completion is reconciled into one canonical history entry", async () => {
  const fhir = new InMemoryCommsFhir();
  const reservation = await reserveStaffSmsSend(fhir, {
    idempotencyKey: "synthetic-send-race",
    claimId: "synthetic-claim-race",
    patientReference: "Patient/synthetic-1",
    senderReference: "Practitioner/synthetic-staff",
    body: "Synthetic raced message",
  });
  assert.equal(reservation.state, "owner");
  await persistTwilioWebhookEvent(fhir, "sms-status", {
    accountSid: ACCOUNT_SID,
    messageSid: MESSAGE_SID,
    messageStatus: "delivered",
    recipientOptedOut: false,
  }, { now: () => NOW });
  await persistStaffSentSms(fhir, {
    communication: reservation.communication,
    idempotencyKey: "synthetic-send-race",
    providerMessageId: MESSAGE_SID,
  }, { now: () => NOW });

  const communications = fhir.ofType<Communication>("Communication");
  const canonical = communications.filter((communication) =>
    communication.identifier?.some((identifier) =>
      identifier.system === ODOS_TWILIO_MESSAGE_IDENTIFIER_SYSTEM && identifier.value === MESSAGE_SID));
  assert.equal(canonical.length, 1);
  assert.equal(canonical[0].status, "completed");
  assert.equal(canonical[0].subject?.reference, "Patient/synthetic-1");
  assert.equal(canonical[0].payload?.[0].contentString, "Synthetic raced message");
  assert.equal(communications.filter((communication) =>
    (JSON.stringify(communication.category) ?? "").includes("patient-sms")).length, 1);
});

test("a callback that conditionally creates after send reconciliation is folded into the staff intent", async () => {
  const fhir = new InMemoryCommsFhir();
  const reservation = await reserveStaffSmsSend(fhir, {
    idempotencyKey: "synthetic-send-late-race",
    claimId: "synthetic-claim-late-race",
    patientReference: "Patient/synthetic-1",
    senderReference: "Practitioner/synthetic-staff",
    body: "Synthetic late-raced message",
  });
  assert.equal(reservation.state, "owner");
  const createRace = fhir.pauseNextMessageConditionalCreate();
  const callback = persistTwilioWebhookEvent(fhir, "sms-status", {
    accountSid: ACCOUNT_SID,
    messageSid: MESSAGE_SID,
    messageStatus: "delivered",
    recipientOptedOut: false,
  }, { now: () => NOW });
  await createRace.lookupComplete;
  await persistStaffSentSms(fhir, {
    communication: reservation.communication,
    idempotencyKey: "synthetic-send-late-race",
    providerMessageId: MESSAGE_SID,
  }, { now: () => NOW });
  createRace.release();
  await callback;

  const communications = fhir.ofType<Communication>("Communication");
  const canonical = communications.filter((communication) =>
    communication.identifier?.some((identifier) =>
      identifier.system === ODOS_TWILIO_MESSAGE_IDENTIFIER_SYSTEM && identifier.value === MESSAGE_SID));
  assert.equal(canonical.length, 1);
  assert.equal(canonical[0].status, "completed");
  assert.equal(canonical[0].subject?.reference, "Patient/synthetic-1");
  assert.equal(canonical[0].payload?.[0].contentString, "Synthetic late-raced message");
  assert.equal(communications.filter((communication) =>
    (JSON.stringify(communication.category) ?? "").includes("patient-sms")).length, 1);
});

test("stale lifecycle callbacks cannot regress terminal message or call status", async () => {
  const fhir = new InMemoryCommsFhir();
  await persistTwilioWebhookEvent(fhir, "sms-inbound", {
    accountSid: ACCOUNT_SID,
    messageSid: MESSAGE_SID,
    from: PATIENT_NUMBER,
    to: PRACTICE_NUMBER,
    body: "Synthetic terminal message",
  }, { now: () => NOW });
  await persistTwilioWebhookEvent(fhir, "sms-status", {
    accountSid: ACCOUNT_SID,
    messageSid: MESSAGE_SID,
    messageStatus: "delivered",
    recipientOptedOut: false,
  }, { now: () => NOW });
  await persistTwilioWebhookEvent(fhir, "sms-status", {
    accountSid: ACCOUNT_SID,
    messageSid: MESSAGE_SID,
    messageStatus: "queued",
    recipientOptedOut: false,
  }, { now: () => NOW });

  await persistTwilioWebhookEvent(fhir, "voice-status", {
    accountSid: ACCOUNT_SID,
    callId: CALL_SID,
    from: PATIENT_NUMBER,
    to: PRACTICE_NUMBER,
    direction: "inbound",
    status: "completed",
    durationSeconds: 42,
  }, { now: () => NOW });
  await persistTwilioWebhookEvent(fhir, "voice-status", {
    accountSid: ACCOUNT_SID,
    callId: CALL_SID,
    from: PATIENT_NUMBER,
    to: PRACTICE_NUMBER,
    direction: "inbound",
    status: "ringing",
  }, { now: () => NOW });

  const [message, call] = fhir.ofType<Communication>("Communication");
  assert.equal(message.status, "completed");
  assert.equal(message.statusReason?.text, "Twilio message status: delivered");
  assert.equal(call.status, "completed");
  assert.equal(call.statusReason?.text, "Twilio call status: completed");
  assert.match(JSON.stringify(call.note), /status=completed/);
  assert.doesNotMatch(JSON.stringify(call.note), /status=ringing/);
});

test("a sent SMS remains in progress so a later delivery failure is retained", async () => {
  const fhir = new InMemoryCommsFhir();
  const messageSid = `SM${"6".repeat(32)}`;
  await persistTwilioWebhookEvent(fhir, "sms-status", {
    accountSid: ACCOUNT_SID,
    messageSid,
    messageStatus: "sent",
    recipientOptedOut: false,
  }, { now: () => NOW });
  await persistTwilioWebhookEvent(fhir, "sms-status", {
    accountSid: ACCOUNT_SID,
    messageSid,
    messageStatus: "undelivered",
    recipientOptedOut: false,
  }, { now: () => NOW });

  const communication = fhir.ofType<Communication>("Communication")[0];
  assert.equal(communication.status, "not-done");
  assert.equal(communication.statusReason?.text, "Twilio message status: undelivered");
});

test("two signed deliveries of the same Twilio webhook remain one Communication", async () => {
  const fhir = new InMemoryCommsFhir();
  const externalBaseUrl = "https://practice.example";
  const authToken = "synthetic-auth-token";
  const requestTarget = "/comms/twilio/inbound";
  const params = {
    AccountSid: ACCOUNT_SID,
    MessageSid: MESSAGE_SID,
    From: PATIENT_NUMBER,
    To: PRACTICE_NUMBER,
    Body: "Synthetic retry-safe message",
  };
  const app = express();
  app.use(express.urlencoded({ extended: false }));
  registerTwilioWebhookRoutes(app, {
    auth: { accountSid: ACCOUNT_SID, authToken, externalBaseUrl },
    onEvent: (kind, event) => persistTwilioWebhookEvent(fhir, kind, event, { now: () => NOW }),
  });
  const server = app.listen(0);
  await once(server, "listening");
  try {
    const address = server.address() as AddressInfo;
    const signature = twilio.getExpectedTwilioSignature(authToken, `${externalBaseUrl}${requestTarget}`, params);
    for (let delivery = 0; delivery < 2; delivery += 1) {
      const response = await fetch(`http://127.0.0.1:${address.port}${requestTarget}`, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          "x-twilio-signature": signature,
        },
        body: new URLSearchParams(params),
      });
      assert.equal(response.status, 204);
    }
    assert.equal(fhir.ofType<Communication>("Communication").length, 1);
    assert.equal(fhir.createAttempts, 1);
  } finally {
    server.close();
    await once(server, "close");
  }
});

test("unmatched inbound SMS is persisted with the raw sender number and no Patient reference", async () => {
  const fhir = new InMemoryCommsFhir();

  await persistTwilioWebhookEvent(fhir, "sms-inbound", {
    accountSid: ACCOUNT_SID,
    messageSid: MESSAGE_SID,
    from: PATIENT_NUMBER,
    to: PRACTICE_NUMBER,
    body: "Synthetic unmatched message",
  }, { now: () => NOW });

  const communication = fhir.ofType<Communication>("Communication")[0];
  assert.equal(communication.subject, undefined);
  assert.equal(communication.sender?.reference, undefined);
  assert.equal(communication.sender?.identifier?.value, PATIENT_NUMBER);
  assert.equal(communication.payload?.[0].contentString, "Synthetic unmatched message");
});

test("all six Twilio event kinds update deterministic Communications without retaining transcript or recording content", async () => {
  const fhir = new InMemoryCommsFhir();
  const now = { now: () => NOW };
  await persistTwilioWebhookEvent(fhir, "sms-inbound", {
    accountSid: ACCOUNT_SID,
    messageSid: MESSAGE_SID,
    from: PATIENT_NUMBER,
    to: PRACTICE_NUMBER,
    body: "Synthetic inbound message",
  }, now);
  await persistTwilioWebhookEvent(fhir, "sms-status", {
    accountSid: ACCOUNT_SID,
    messageSid: MESSAGE_SID,
    messageStatus: "delivered",
    recipientOptedOut: false,
  }, now);
  await persistTwilioWebhookEvent(fhir, "voice-inbound", {
    accountSid: ACCOUNT_SID,
    callId: CALL_SID,
    from: PATIENT_NUMBER,
    to: PRACTICE_NUMBER,
    direction: "inbound",
    status: "ringing",
  }, now);
  await persistTwilioWebhookEvent(fhir, "voice-status", {
    accountSid: ACCOUNT_SID,
    callId: CALL_SID,
    from: PATIENT_NUMBER,
    to: PRACTICE_NUMBER,
    direction: "inbound",
    status: "completed",
    durationSeconds: 42,
  }, now);
  await persistTwilioWebhookEvent(fhir, "voice-recording", {
    accountSid: ACCOUNT_SID,
    callId: CALL_SID,
    recordingId: RECORDING_SID,
    status: "completed",
    durationSeconds: 42,
    channels: 2,
  }, now);
  await persistTwilioWebhookEvent(fhir, "voice-transcription", {
    accountSid: ACCOUNT_SID,
    callId: CALL_SID,
    transcriptionId: TRANSCRIPTION_SID,
    event: "transcription-content",
    timestamp: NOW,
    sequenceId: 7,
    languageCode: "en-US",
    text: "Synthetic transcript content that must not persist",
    confidence: 0.98,
    final: true,
  }, now);

  const communications = fhir.ofType<Communication>("Communication");
  assert.equal(communications.length, 2);
  const hasIdentifierSystem = (resource: Communication, system: string): boolean =>
    resource.identifier?.some((identifier) => identifier.system === system) === true;
  const message = communications.find((resource) => hasIdentifierSystem(resource, ODOS_TWILIO_MESSAGE_IDENTIFIER_SYSTEM))!;
  const call = communications.find((resource) => hasIdentifierSystem(resource, ODOS_TWILIO_CALL_IDENTIFIER_SYSTEM))!;
  assert.equal(message.status, "completed");
  assert.equal(call.status, "completed");
  assert.equal(call.payload, undefined);
  const serialized = JSON.stringify(call);
  assert.doesNotMatch(serialized, /Synthetic transcript content/);
  assert.doesNotMatch(serialized, /audio|\.mp3|RecordingUrl/i);
  assert.match(serialized, new RegExp(RECORDING_SID));
  assert.match(serialized, new RegExp(TRANSCRIPTION_SID));
  assert.equal(fhir.createAttempts, 2);
});

test("multiple recordings on one call retain every recording identifier", async () => {
  const fhir = new InMemoryCommsFhir();
  const secondRecordingSid = `RE${"7".repeat(32)}`;
  for (const recordingId of [RECORDING_SID, secondRecordingSid]) {
    await persistTwilioWebhookEvent(fhir, "voice-recording", {
      accountSid: ACCOUNT_SID,
      callId: CALL_SID,
      recordingId,
      status: "completed",
      durationSeconds: 42,
      channels: 2,
    }, { now: () => NOW });
  }

  const recordingIds = fhir.ofType<Communication>("Communication")[0].identifier
    ?.filter((identifier) => identifier.system === "https://odos2020.com/fhir/NamingSystem/twilio-recording-sid")
    .map((identifier) => identifier.value)
    .sort();
  assert.deepEqual(recordingIds, [RECORDING_SID, secondRecordingSid].sort());
});

test("concurrent call status and recording callbacks converge without losing either event", async () => {
  const fhir = new InMemoryCommsFhir();
  await Promise.all([
    persistTwilioWebhookEvent(fhir, "voice-status", {
      accountSid: ACCOUNT_SID,
      callId: CALL_SID,
      from: PATIENT_NUMBER,
      to: PRACTICE_NUMBER,
      direction: "inbound",
      status: "completed",
      durationSeconds: 42,
    }, { now: () => NOW }),
    persistTwilioWebhookEvent(fhir, "voice-recording", {
      accountSid: ACCOUNT_SID,
      callId: CALL_SID,
      recordingId: RECORDING_SID,
      status: "completed",
      durationSeconds: 42,
      channels: 2,
    }, { now: () => NOW }),
  ]);

  const communications = fhir.ofType<Communication>("Communication");
  assert.equal(communications.length, 1);
  assert.equal(communications[0].status, "completed");
  assert.match(JSON.stringify(communications[0]), new RegExp(RECORDING_SID));
});

test("a conditional-create loser re-reads and merges its event into the winning Communication", async () => {
  const fhir = new InMemoryCommsFhir();
  fhir.raceConditionalCreateWith({
    resourceType: "Communication",
    id: "competing-call",
    status: "completed",
    identifier: [{ system: ODOS_TWILIO_CALL_IDENTIFIER_SYSTEM, value: CALL_SID }],
    category: [{ coding: [{ system: "https://odos2020.com/fhir/CodeSystem/communication-category", code: "patient-call" }] }],
    statusReason: { text: "Twilio call status: completed" },
  });

  await persistTwilioWebhookEvent(fhir, "voice-recording", {
    accountSid: ACCOUNT_SID,
    callId: CALL_SID,
    recordingId: RECORDING_SID,
    status: "completed",
    durationSeconds: 42,
    channels: 2,
  }, { now: () => NOW });

  const communications = fhir.ofType<Communication>("Communication");
  assert.equal(communications.length, 1);
  assert.equal(communications[0].status, "completed");
  assert.match(JSON.stringify(communications[0]), new RegExp(RECORDING_SID));
});

test("a version conflict re-reads and merges both cross-process call fragments", async () => {
  const fhir = new InMemoryCommsFhir();
  const base: Communication = {
    resourceType: "Communication",
    id: "concurrent-call",
    meta: { versionId: "1" },
    status: "in-progress",
    identifier: [{ system: ODOS_TWILIO_CALL_IDENTIFIER_SYSTEM, value: CALL_SID }],
  };
  fhir.seed(base);
  fhir.raceUpdateWith({
    ...base,
    meta: { versionId: "2" },
    identifier: [
      { system: ODOS_TWILIO_CALL_IDENTIFIER_SYSTEM, value: CALL_SID },
      { system: "https://odos2020.com/fhir/NamingSystem/twilio-recording-sid", value: RECORDING_SID },
    ],
  });

  await persistTwilioWebhookEvent(fhir, "voice-status", {
    accountSid: ACCOUNT_SID,
    callId: CALL_SID,
    from: PATIENT_NUMBER,
    to: PRACTICE_NUMBER,
    direction: "inbound",
    status: "completed",
    durationSeconds: 42,
  }, { now: () => NOW });

  const communication = fhir.ofType<Communication>("Communication")[0];
  assert.equal(communication.status, "completed");
  assert.match(JSON.stringify(communication.identifier), new RegExp(RECORDING_SID));
  assert.deepEqual(fhir.updateIfMatchHeaders, ['W/"1"', 'W/"2"']);
});

test("Twilio listConversations reads persisted Communication history, groups locally, and never requires a live message-list API", async () => {
  const fhir = new InMemoryCommsFhir();
  fhir.seed(
    communication("comm-1", "2026-08-02T14:00:00.000Z", "First synthetic message"),
    communication("comm-2", "2026-08-02T15:00:00.000Z", "Second synthetic message"),
    {
      resourceType: "Communication",
      id: "office-1",
      status: "completed",
      category: [{ coding: [{ system: "https://odos2020.com/fhir/CodeSystem/communication-category", code: "internal-office" }] }],
      sent: NOW,
      payload: [{ contentString: "Internal office message" }],
    } satisfies Communication,
  );
  const adapter = withTwilioConversationStore(createTwilioAdapter({
    accountSid: ACCOUNT_SID,
    authToken: "synthetic-auth-token",
    fromNumber: PRACTICE_NUMBER,
  }, {
    clientFactory: () => ({ messages: { create: async () => ({ sid: MESSAGE_SID }) } }),
  }), fhir);

  assert.equal(adapter.capabilities.conversations, true);
  assert.ok(adapter.listConversations);
  const withoutBodies = await adapter.listConversations({ limit: 20, includeContent: false });
  assert.equal(withoutBodies.length, 1);
  assert.equal(withoutBodies[0].messageCount, 2);
  assert.equal(withoutBodies[0].updatedAt, "2026-08-02T15:00:00.000Z");
  assert.equal(withoutBodies[0].messages[0].body, undefined);
  const withBodies = await adapter.listConversations({
    patientReference: "Patient/synthetic-1",
    limit: 20,
    includeContent: true,
  });
  assert.deepEqual(withBodies[0].messages.map((message) => message.body), [
    "Second synthetic message",
    "First synthetic message",
  ]);
  assert.equal(fhir.lastCommunicationSearch?.get("subject"), "Patient/synthetic-1");
});

test("Twilio conversation fallback selects the message SID instead of identifier position zero", async () => {
  const fhir = new InMemoryCommsFhir();
  fhir.seed({
    resourceType: "Communication",
    id: "unlinked-staff-sms",
    status: "in-progress",
    identifier: [
      { system: ODOS_COMMS_STAFF_SEND_IDENTIFIER_SYSTEM, value: "synthetic-send-fallback" },
      { system: ODOS_TWILIO_MESSAGE_IDENTIFIER_SYSTEM, value: MESSAGE_SID },
    ],
    category: [
      { coding: [{ system: "https://odos2020.com/fhir/CodeSystem/communication-category", code: "patient-sms" }] },
      { coding: [{ system: "https://odos2020.com/fhir/CodeSystem/communication-category", code: "patient-sms-outbound" }] },
    ],
    medium: [{ text: "SMS" }],
    sender: { reference: "Practitioner/synthetic-staff" },
    recipient: [{ reference: "RelatedPerson/synthetic-unlinked" }],
    sent: NOW,
  } satisfies Communication);
  const adapter = withTwilioConversationStore(createTwilioAdapter({
    accountSid: ACCOUNT_SID,
    authToken: "synthetic-auth-token",
    fromNumber: PRACTICE_NUMBER,
  }, {
    clientFactory: () => ({ messages: { create: async () => ({ sid: MESSAGE_SID }) } }),
  }), fhir);

  const conversations = await adapter.listConversations!({ limit: 20, includeContent: false });
  assert.equal(conversations.length, 1);
  assert.equal(conversations[0].id, MESSAGE_SID);
});

function communication(id: string, received: string, body: string): Communication {
  return {
    resourceType: "Communication",
    id,
    status: "completed",
    identifier: [{ system: ODOS_TWILIO_MESSAGE_IDENTIFIER_SYSTEM, value: `${MESSAGE_SID}-${id}` }],
    category: [{ coding: [{ system: "https://odos2020.com/fhir/CodeSystem/communication-category", code: "patient-sms" }] }],
    medium: [{ text: "SMS" }],
    subject: { reference: "Patient/synthetic-1" },
    sender: { reference: "Patient/synthetic-1" },
    recipient: [{ identifier: { system: "https://odos2020.com/fhir/NamingSystem/phone-number", value: PRACTICE_NUMBER } }],
    received,
    payload: [{ contentString: body }],
  };
}

class InMemoryCommsFhir {
  private resources: Resource[] = [];
  private conditionalCreateRace?: Communication;
  private messageConditionalCreatePause?: { lookupComplete: () => void; release: Promise<void> };
  private updateRace?: Communication;
  private nextId = 1;
  createAttempts = 0;
  lastCommunicationSearch?: URLSearchParams;
  updateIfMatchHeaders: Array<string | undefined> = [];

  seed(...resources: Resource[]): void {
    this.resources.push(...structuredClone(resources));
  }

  raceConditionalCreateWith(communication: Communication): void {
    this.conditionalCreateRace = withVersion(communication, 1);
  }

  raceUpdateWith(communication: Communication): void {
    this.updateRace = structuredClone(communication);
  }

  pauseNextMessageConditionalCreate(): { lookupComplete: Promise<void>; release: () => void } {
    let signalLookupComplete!: () => void;
    let release!: () => void;
    const lookupComplete = new Promise<void>((resolve) => {
      signalLookupComplete = resolve;
    });
    const waitForRelease = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.messageConditionalCreatePause = { lookupComplete: signalLookupComplete, release: waitForRelease };
    return { lookupComplete, release };
  }

  ofType<T extends Resource>(resourceType: T["resourceType"]): T[] {
    return this.resources.filter((resource) => resource.resourceType === resourceType) as T[];
  }

  async search<T extends Resource>(resourceType: T["resourceType"], params: Record<string, string> | URLSearchParams | Array<[string, string]> = {}): Promise<Bundle<T>> {
    const query = new URLSearchParams(params as ConstructorParameters<typeof URLSearchParams>[0]);
    let matches = this.ofType<T>(resourceType);
    if (resourceType === "Patient" && query.get("telecom")) {
      const phone = query.get("telecom");
      matches = matches.filter((resource) => (resource as Patient).telecom?.some((point) => point.value === phone));
    }
    if (resourceType === "Communication") {
      this.lastCommunicationSearch = query;
      const identifier = query.get("identifier");
      if (identifier) {
        const splitAt = identifier.lastIndexOf("|");
        const system = identifier.slice(0, splitAt);
        const value = identifier.slice(splitAt + 1);
        matches = matches.filter((resource) => (resource as Communication).identifier?.some((entry) => entry.system === system && entry.value === value));
      }
      const subject = query.get("subject");
      if (subject) matches = matches.filter((resource) => (resource as Communication).subject?.reference === subject);
    }
    return { resourceType: "Bundle", type: "searchset", entry: matches.map((resource) => ({ resource: structuredClone(resource) })) };
  }

  async create<T extends Resource>(resource: T, headers: Record<string, string> = {}): Promise<T> {
    this.createAttempts += 1;
    const conditionalIdentifier = headers["If-None-Exist"]?.replace(/^identifier=/, "");
    if (resource.resourceType === "Communication" && conditionalIdentifier) {
      if (this.conditionalCreateRace) {
        const winner = this.conditionalCreateRace;
        this.conditionalCreateRace = undefined;
        this.resources.push(structuredClone(winner));
        return structuredClone(winner) as T;
      }
      const splitAt = conditionalIdentifier.lastIndexOf("|");
      const system = conditionalIdentifier.slice(0, splitAt);
      const value = conditionalIdentifier.slice(splitAt + 1);
      const existing = this.ofType<Communication>("Communication").find((communication) =>
        communication.identifier?.some((identifier) => identifier.system === system && identifier.value === value));
      if (existing) return structuredClone(existing) as T;
      if (system === ODOS_TWILIO_MESSAGE_IDENTIFIER_SYSTEM && this.messageConditionalCreatePause) {
        const pause = this.messageConditionalCreatePause;
        this.messageConditionalCreatePause = undefined;
        pause.lookupComplete();
        await pause.release;
      }
    }
    const created = {
      ...structuredClone(resource),
      id: `created-${this.nextId++}`,
      ...(resource.resourceType === "Communication" ? { meta: { ...resource.meta, versionId: "1" } } : {}),
    } as T;
    this.resources.push(created);
    return structuredClone(created);
  }

  async update<T extends Resource>(_resourceType: T["resourceType"], id: string, resource: T, headers: Record<string, string> = {}): Promise<T> {
    const index = this.resources.findIndex((candidate) => candidate.resourceType === resource.resourceType && candidate.id === id);
    if (index < 0) throw new Error(`Missing ${resource.resourceType}/${id}`);
    this.updateIfMatchHeaders.push(headers["If-Match"]);
    if (resource.resourceType === "Communication" && this.updateRace) {
      this.resources[index] = structuredClone(this.updateRace);
      this.updateRace = undefined;
      throw Object.assign(new Error("FHIR 412 version conflict"), { status: 412 });
    }
    const versionId = String(Number(this.resources[index].meta?.versionId ?? "0") + 1);
    const updated = { ...structuredClone(resource), meta: { ...resource.meta, versionId } } as T;
    this.resources[index] = updated;
    return structuredClone(updated);
  }
}

function withVersion(communication: Communication, version: number): Communication {
  return { ...structuredClone(communication), meta: { ...communication.meta, versionId: String(version) } };
}
