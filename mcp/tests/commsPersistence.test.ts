import assert from "node:assert/strict";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import type { Bundle, Communication, Patient, Resource } from "@medplum/fhirtypes";
import express from "express";
import twilio from "twilio";
import {
  ODOS_TWILIO_CALL_IDENTIFIER_SYSTEM,
  ODOS_TWILIO_MESSAGE_IDENTIFIER_SYSTEM,
  persistTwilioWebhookEvent,
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
  const message = communications.find((resource) => resource.identifier?.[0]?.system === ODOS_TWILIO_MESSAGE_IDENTIFIER_SYSTEM)!;
  const call = communications.find((resource) => resource.identifier?.[0]?.system === ODOS_TWILIO_CALL_IDENTIFIER_SYSTEM)!;
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
  private nextId = 1;
  createAttempts = 0;
  lastCommunicationSearch?: URLSearchParams;

  seed(...resources: Resource[]): void {
    this.resources.push(...structuredClone(resources));
  }

  raceConditionalCreateWith(communication: Communication): void {
    this.conditionalCreateRace = structuredClone(communication);
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
    }
    const created = { ...structuredClone(resource), id: `created-${this.nextId++}` } as T;
    this.resources.push(created);
    return structuredClone(created);
  }

  async update<T extends Resource>(_resourceType: T["resourceType"], id: string, resource: T): Promise<T> {
    const index = this.resources.findIndex((candidate) => candidate.resourceType === resource.resourceType && candidate.id === id);
    if (index < 0) throw new Error(`Missing ${resource.resourceType}/${id}`);
    this.resources[index] = structuredClone(resource);
    return structuredClone(resource);
  }
}
