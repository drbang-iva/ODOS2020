import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import express from "express";
import {
  createGhlAdapter,
  handleGhlInboundWebhook,
  type GhlInboundWebhookEvent,
} from "../src/comms/adapters/ghl-adapter.js";
import { registerGhlWebhookRoutes } from "../src/comms/ghl-routes.js";

const LOCATION_ID = "location-synthetic-1";
const ACCESS_TOKEN = "synthetic-location-token";
const CONTACT_ID = "contact-synthetic-1";
const CONVERSATION_ID = "conversation-synthetic-1";
const MESSAGE_ID = "message-synthetic-1";

test("GHL sends SMS through a location contact with current bearer and version headers", async () => {
  const requests: Array<{ url: string; init: RequestInit }> = [];
  const adapter = createGhlAdapter({ locationId: LOCATION_ID, accessToken: ACCESS_TOKEN }, {
    fetchImpl: (async (input, init = {}) => {
      const url = String(input);
      requests.push({ url, init });
      if (url.endsWith("/contacts/search")) {
        return Response.json({ contacts: [{ id: CONTACT_ID, phone: "+18645550199" }], total: 1 });
      }
      return Response.json({
        conversationId: CONVERSATION_ID,
        messageId: MESSAGE_ID,
        msg: "Message queued successfully.",
      });
    }) as typeof fetch,
  });

  const result = await adapter.sendSms!({
    patientReference: "Patient/synthetic-1",
    toNumber: "+18645550199",
    body: "Synthetic appointment reminder.",
    campaignType: "staff-initiated",
    suppression: {},
  });

  assert.deepEqual(result, {
    outcome: "sent",
    providerMessageId: MESSAGE_ID,
    providerThreadId: CONVERSATION_ID,
  });
  assert.equal(requests.length, 2);
  assert.equal(requests[0].url, "https://services.leadconnectorhq.com/contacts/search");
  assert.equal(requests[1].url, "https://services.leadconnectorhq.com/conversations/messages");
  for (const request of requests) {
    const headers = new Headers(request.init.headers);
    assert.equal(headers.get("authorization"), `Bearer ${ACCESS_TOKEN}`);
    assert.equal(headers.get("version"), "v3");
  }
  assert.deepEqual(JSON.parse(String(requests[0].init.body)), {
    locationId: LOCATION_ID,
    page: 1,
    pageLimit: 100,
    query: "+18645550199",
  });
  assert.deepEqual(JSON.parse(String(requests[1].init.body)), {
    type: "SMS",
    contactId: CONTACT_ID,
    message: "Synthetic appointment reminder.",
    status: "pending",
    toNumber: "+18645550199",
  });
});

test("GHL honors the platform SMS DND state without calling the send endpoint", async () => {
  const urls: string[] = [];
  const adapter = createGhlAdapter({ locationId: LOCATION_ID, accessToken: ACCESS_TOKEN }, {
    fetchImpl: (async (input) => {
      urls.push(String(input));
      return Response.json({
        contacts: [{
          id: CONTACT_ID,
          phone: "+18645550199",
          dndSettings: { SMS: { status: "active", code: "OPTED_OUT" } },
        }],
        total: 1,
      });
    }) as typeof fetch,
  });

  const result = await adapter.sendSms!({
    patientReference: "Patient/synthetic-1",
    toNumber: "+18645550199",
    body: "Synthetic appointment reminder.",
    campaignType: "staff-initiated",
    suppression: {},
  });

  assert.deepEqual(result, { outcome: "suppressed", reason: "patient-opt-out" });
  assert.deepEqual(urls, ["https://services.leadconnectorhq.com/contacts/search"]);
});

test("GHL lists live conversation messages and maps patient-filtered history", async () => {
  const urls: string[] = [];
  const adapter = createGhlAdapter({ locationId: LOCATION_ID, accessToken: ACCESS_TOKEN }, {
    resolvePatientPhone: async (reference) => {
      assert.equal(reference, "Patient/synthetic-1");
      return "+18645550199";
    },
    fetchImpl: (async (input) => {
      const url = String(input);
      urls.push(url);
      if (url.endsWith("/contacts/search")) {
        return Response.json({ contacts: [{ id: CONTACT_ID, phone: "+18645550199" }], total: 1 });
      }
      if (url.includes("/conversations/search?")) {
        return Response.json({
          conversations: [{
            id: CONVERSATION_ID,
            contactId: CONTACT_ID,
            locationId: LOCATION_ID,
            lastMessageDate: "2026-08-03T13:00:00.000Z",
            lastMessageBody: "Synthetic reply",
            lastMessageType: "SMS",
            unreadCount: 1,
            phone: "+18645550199",
          }],
          total: 1,
        });
      }
      return Response.json({
        lastMessageId: MESSAGE_ID,
        nextPage: false,
        messages: [{
          id: MESSAGE_ID,
          messageType: "SMS",
          locationId: LOCATION_ID,
          contactId: CONTACT_ID,
          conversationId: CONVERSATION_ID,
          dateAdded: "2026-08-03T13:00:00.000Z",
          body: "Synthetic reply",
          direction: "inbound",
          status: "delivered",
          contentType: "text/plain",
          from: "+18645550199",
          to: ["+18645550100"],
        }],
      });
    }) as typeof fetch,
  });

  const result = await adapter.listConversations!({
    patientReference: "Patient/synthetic-1",
    limit: 20,
    includeContent: true,
  });

  assert.deepEqual(result, [{
    id: CONVERSATION_ID,
    patientReference: "Patient/synthetic-1",
    updatedAt: "2026-08-03T13:00:00.000Z",
    messageCount: 1,
    messages: [{
      id: MESSAGE_ID,
      direction: "inbound",
      status: "delivered",
      occurredAt: "2026-08-03T13:00:00.000Z",
      from: "+18645550199",
      to: "+18645550100",
      body: "Synthetic reply",
    }],
  }]);
  assert.match(urls[1], /locationId=location-synthetic-1/);
  assert.match(urls[1], /contactId=contact-synthetic-1/);
  assert.match(urls[1], /limit=20/);
  assert.match(urls[2], /\/conversations\/conversation-synthetic-1\/messages\?limit=100&type=TYPE_SMS/);
});

test("GHL follows the documented lastMessageId cursor until conversation history is complete", async () => {
  const messageUrls: string[] = [];
  const adapter = createGhlAdapter({ locationId: LOCATION_ID, accessToken: ACCESS_TOKEN }, {
    fetchImpl: (async (input) => {
      const url = String(input);
      if (url.includes("/conversations/search?")) {
        return Response.json({
          conversations: [{ id: CONVERSATION_ID, contactId: CONTACT_ID }],
          total: 1,
        });
      }
      messageUrls.push(url);
      const cursor = new URL(url).searchParams.get("lastMessageId");
      const id = cursor ? "message-synthetic-2" : MESSAGE_ID;
      return Response.json({
        lastMessageId: id,
        nextPage: cursor === null,
        messages: [{
          id,
          dateAdded: cursor ? "2026-08-03T12:00:00.000Z" : "2026-08-03T13:00:00.000Z",
          direction: cursor ? "outbound" : "inbound",
          status: "delivered",
        }],
      });
    }) as typeof fetch,
  });

  const result = await adapter.listConversations!({ limit: 1 });

  assert.equal(result[0].messageCount, 2);
  assert.deepEqual(result[0].messages.map((message) => message.id), [
    MESSAGE_ID,
    "message-synthetic-2",
  ]);
  assert.equal(messageUrls.length, 2);
  assert.equal(new URL(messageUrls[1]).searchParams.get("lastMessageId"), MESSAGE_ID);
});

test("GHL bounds concurrent per-conversation history requests", async () => {
  let active = 0;
  let maximumActive = 0;
  const conversations = Array.from({ length: 6 }, (_, index) => ({
    id: `conversation-synthetic-${index + 1}`,
    contactId: `contact-synthetic-${index + 1}`,
  }));
  const adapter = createGhlAdapter({ locationId: LOCATION_ID, accessToken: ACCESS_TOKEN }, {
    fetchImpl: (async (input) => {
      const url = String(input);
      if (url.includes("/conversations/search?")) {
        return Response.json({ conversations, total: conversations.length });
      }
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await new Promise<void>((resolve) => setImmediate(resolve));
      active -= 1;
      const conversationId = /\/conversations\/([^/]+)\/messages/.exec(url)?.[1];
      return Response.json({
        lastMessageId: `message-${conversationId}`,
        nextPage: false,
        messages: [{
          id: `message-${conversationId}`,
          dateAdded: "2026-08-03T13:00:00.000Z",
          direction: "inbound",
          status: "delivered",
        }],
      });
    }) as typeof fetch,
  });

  const result = await adapter.listConversations!({ limit: conversations.length });

  assert.equal(result.length, conversations.length);
  assert.ok(maximumActive <= 5, `expected at most 5 concurrent message reads, saw ${maximumActive}`);
});

test("GHL contact search and upsert map only the vendor contact fields", async () => {
  const requests: Array<{ url: string; init: RequestInit }> = [];
  const adapter = createGhlAdapter({ locationId: LOCATION_ID, accessToken: ACCESS_TOKEN }, {
    fetchImpl: (async (input, init = {}) => {
      const url = String(input);
      requests.push({ url, init });
      if (url.endsWith("/contacts/search")) {
        return Response.json({ contacts: [{ id: CONTACT_ID, email: "alex@example.test", phone: "+18645550199" }] });
      }
      return Response.json({
        new: false,
        contact: { id: CONTACT_ID, email: "alex@example.test", phone: "+18645550199" },
      });
    }) as typeof fetch,
  });

  assert.deepEqual(await adapter.searchContacts!({ query: "alex" }), [{
    id: CONTACT_ID,
    email: "alex@example.test",
    phone: "+18645550199",
  }]);
  assert.deepEqual(await adapter.upsertContact!({
    patientReference: "Patient/synthetic-1",
    email: "alex@example.test",
    phone: "+18645550199",
  }), {
    id: CONTACT_ID,
    patientReference: "Patient/synthetic-1",
    email: "alex@example.test",
    phone: "+18645550199",
  });
  assert.deepEqual(JSON.parse(String(requests[1].init.body)), {
    locationId: LOCATION_ID,
    email: "alex@example.test",
    phone: "+18645550199",
    source: "ODOS",
    createNewIfDuplicateAllowed: false,
  });
});

test("GHL configuration fails closed and advertises no call capability", () => {
  assert.throws(() => createGhlAdapter({ locationId: "", accessToken: ACCESS_TOKEN }), /location id/i);
  assert.throws(() => createGhlAdapter({ locationId: LOCATION_ID, accessToken: "" }), /access token/i);
  const adapter = createGhlAdapter({ locationId: LOCATION_ID, accessToken: ACCESS_TOKEN });
  assert.deepEqual(adapter.capabilities, {
    sms: true,
    calls: false,
    email: false,
    contacts: true,
    conversations: true,
    reviews: false,
  });
});

test("GHL inbound webhook rejects missing and invalid signatures before trusting payload fields", async () => {
  const { publicKey } = generateKeyPairSync("ed25519");
  const rawBody = JSON.stringify({
    type: "InboundMessage",
    locationId: LOCATION_ID,
    direction: "inbound",
    messageType: "SMS",
    body: "Synthetic inbound message",
    contactId: CONTACT_ID,
    conversationId: CONVERSATION_ID,
    messageId: MESSAGE_ID,
    dateAdded: "2026-08-03T13:00:00.000Z",
    status: "delivered",
    from: "+18645550199",
    to: "+18645550100",
  });
  assert.throws(
    () => handleGhlInboundWebhook(rawBody, undefined, { locationId: LOCATION_ID, publicKey }),
    /signature/i,
  );
  assert.throws(
    () => handleGhlInboundWebhook(rawBody, Buffer.from("invalid").toString("base64"), { locationId: LOCATION_ID, publicKey }),
    /signature/i,
  );
});

test("GHL accepts the documented SMS InboundMessage shape when messageId is omitted", () => {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const rawBody = JSON.stringify({
    type: "InboundMessage",
    locationId: LOCATION_ID,
    direction: "inbound",
    messageType: "SMS",
    body: "Synthetic inbound message",
    contactId: CONTACT_ID,
    conversationId: CONVERSATION_ID,
    dateAdded: "2026-08-03T13:00:00.000Z",
    status: "delivered",
    from: "+18645550199",
    to: "+18645550100",
  });
  const signature = sign(null, Buffer.from(rawBody), privateKey).toString("base64");
  const event = handleGhlInboundWebhook(rawBody, signature, { locationId: LOCATION_ID, publicKey });
  assert.equal(event.messageId, undefined);
});

test("GHL inbound route verifies Ed25519 over raw bytes and accepts only the configured location", async () => {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const events: GhlInboundWebhookEvent[] = [];
  const app = express();
  registerGhlWebhookRoutes(app, {
    auth: { locationId: LOCATION_ID, publicKey },
    onEvent: (event) => events.push(event),
  });
  app.use(express.json());
  const server = app.listen(0);
  await once(server, "listening");
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const payload = {
    type: "InboundMessage",
    locationId: LOCATION_ID,
    direction: "inbound",
    messageType: "SMS",
    body: "Synthetic inbound message",
    contactId: CONTACT_ID,
    conversationId: CONVERSATION_ID,
    messageId: MESSAGE_ID,
    dateAdded: "2026-08-03T13:00:00.000Z",
    status: "delivered",
    from: "+18645550199",
    to: "+18645550100",
  };
  try {
    const unsigned = await fetch(`${base}/comms/ghl/inbound`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    assert.equal(unsigned.status, 403);

    const rawBody = JSON.stringify(payload);
    const signature = sign(null, Buffer.from(rawBody), privateKey).toString("base64");
    const accepted = await fetch(`${base}/comms/ghl/inbound`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-ghl-signature": signature },
      body: rawBody,
    });
    assert.equal(accepted.status, 204);
    assert.equal(events.length, 1);
    assert.equal(events[0].messageId, MESSAGE_ID);

    const wrongLocationBody = JSON.stringify({ ...payload, locationId: "location-synthetic-2" });
    const wrongLocationSignature = sign(null, Buffer.from(wrongLocationBody), privateKey).toString("base64");
    const wrongLocation = await fetch(`${base}/comms/ghl/inbound`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-ghl-signature": wrongLocationSignature },
      body: wrongLocationBody,
    });
    assert.equal(wrongLocation.status, 400);
    assert.equal(events.length, 1);
  } finally {
    server.close();
    await once(server, "close");
  }
});
