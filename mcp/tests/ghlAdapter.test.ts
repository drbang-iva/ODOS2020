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

test("GHL resolves the SMS recipient from the patient reference when the staff API omits toNumber", async () => {
  const requests: Array<{ url: string; init: RequestInit }> = [];
  const adapter = createGhlAdapter({ locationId: LOCATION_ID, accessToken: ACCESS_TOKEN }, {
    resolvePatientPhone: async (reference) => {
      assert.equal(reference, "Patient/synthetic-1");
      return "+18645550199";
    },
    fetchImpl: (async (input, init = {}) => {
      const url = String(input);
      requests.push({ url, init });
      if (url.endsWith("/contacts/search")) {
        return Response.json({ contacts: [{ id: CONTACT_ID, phone: "+18645550199" }], total: 1 });
      }
      return Response.json({ conversationId: CONVERSATION_ID, messageId: MESSAGE_ID });
    }) as typeof fetch,
  });

  const result = await adapter.sendSms!({
    patientReference: "Patient/synthetic-1",
    body: "Synthetic appointment reminder.",
    campaignType: "staff-initiated",
    suppression: {},
  });

  assert.equal(result.outcome, "sent");
  assert.equal(JSON.parse(String(requests[1].init.body)).toNumber, "+18645550199");
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

test("GHL contact-resolution errors never disclose the patient phone number", async () => {
  for (const contacts of [
    [],
    [
      { id: "contact-synthetic-1", phone: "+18645550199" },
      { id: "contact-synthetic-2", phone: "+18645550199" },
    ],
  ]) {
    const adapter = createGhlAdapter({ locationId: LOCATION_ID, accessToken: ACCESS_TOKEN }, {
      fetchImpl: (async () => Response.json({ contacts, total: contacts.length })) as typeof fetch,
    });
    await assert.rejects(
      () => adapter.sendSms!({
        patientReference: "Patient/synthetic-1",
        toNumber: "+18645550199",
        body: "Synthetic appointment reminder.",
        campaignType: "staff-initiated",
        suppression: {},
      }),
      (error: Error) => {
        assert.doesNotMatch(error.message, /18645550199/);
        return true;
      },
    );
  }
});

test("GHL maps a patient-filtered conversation row from the documented search response", async () => {
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
            lastMessageBody: "Synthetic reply",
            lastMessageType: "SMS",
            unreadCount: 1,
            fullName: "Alex Synthetic",
            contactName: "Synthetic Contact",
            email: "alex@example.test",
            phone: "+18645550199",
            type: "TYPE_PHONE",
          }],
          total: 1,
        });
      }
      throw new Error(`Unexpected GHL request: ${url}`);
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
    preview: "Synthetic reply",
    channel: "SMS",
    unreadCount: 1,
    displayName: "Alex Synthetic",
    phone: "+18645550199",
    email: "alex@example.test",
    messages: [],
  }]);
  assert.equal(result[0].updatedAt, undefined);
  assert.equal(result[0].messageCount, undefined);
  assert.equal(urls.length, 2);
  assert.match(urls[1], /locationId=location-synthetic-1/);
  assert.match(urls[1], /contactId=contact-synthetic-1/);
  assert.match(urls[1], /limit=20/);
  assert.match(urls[1], /sortBy=last_message_date/);
  assert.match(urls[1], /sort=desc/);
});

test("GHL returns every conversation when optional search fields are null or missing", async () => {
  const adapter = createGhlAdapter({ locationId: LOCATION_ID, accessToken: ACCESS_TOKEN }, {
    fetchImpl: (async (input) => {
      const url = String(input);
      if (!url.includes("/conversations/search?")) throw new Error(`Unexpected GHL request: ${url}`);
      return Response.json({
        conversations: [
          {
            id: "conversation-complete",
            contactId: "contact-complete",
            locationId: LOCATION_ID,
            lastMessageBody: "Complete preview",
            lastMessageType: "TYPE_SMS",
            type: "TYPE_PHONE",
            unreadCount: 2,
            fullName: "Complete Contact",
            contactName: "Complete",
            email: "complete@example.test",
            phone: "+18645550191",
          },
          {
            id: "conversation-null-email",
            contactId: "contact-null-email",
            locationId: LOCATION_ID,
            lastMessageBody: "No email preview",
            lastMessageType: "TYPE_SMS",
            type: "TYPE_PHONE",
            unreadCount: 1,
            fullName: "No Email",
            contactName: "Email Missing",
            email: null,
            phone: "+18645550192",
          },
          {
            id: "conversation-no-phone",
            contactId: "contact-no-phone",
            locationId: LOCATION_ID,
            lastMessageBody: "No phone preview",
            lastMessageType: "TYPE_SMS",
            type: "TYPE_PHONE",
            unreadCount: 0,
            fullName: "No Phone",
            contactName: "Phone Missing",
            email: "no-phone@example.test",
          },
          {
            id: "conversation-no-preview",
            contactId: "contact-no-preview",
            locationId: null,
            lastMessageType: null,
            type: null,
            unreadCount: "unknown",
            fullName: null,
            contactName: "Preview Missing",
            email: "no-preview@example.test",
            phone: "+18645550194",
          },
        ],
      });
    }) as typeof fetch,
  });

  const result = await adapter.listConversations!({ includeContent: true });

  assert.deepEqual(result, [
    {
      id: "conversation-complete",
      preview: "Complete preview",
      channel: "TYPE_SMS",
      unreadCount: 2,
      displayName: "Complete Contact",
      phone: "+18645550191",
      email: "complete@example.test",
      messages: [],
    },
    {
      id: "conversation-null-email",
      preview: "No email preview",
      channel: "TYPE_SMS",
      unreadCount: 1,
      displayName: "No Email",
      phone: "+18645550192",
      messages: [],
    },
    {
      id: "conversation-no-phone",
      preview: "No phone preview",
      channel: "TYPE_SMS",
      unreadCount: 0,
      displayName: "No Phone",
      email: "no-phone@example.test",
      messages: [],
    },
    {
      id: "conversation-no-preview",
      unreadCount: 0,
      displayName: "Preview Missing",
      phone: "+18645550194",
      email: "no-preview@example.test",
      messages: [],
    },
  ]);
});

test("GHL conversation listing makes one request regardless of conversation message volume", async () => {
  const urls: string[] = [];
  const conversations = Array.from({ length: 6 }, (_, index) => ({
    id: `conversation-synthetic-${index + 1}`,
    contactId: `contact-synthetic-${index + 1}`,
    locationId: LOCATION_ID,
    lastMessageBody: `Synthetic preview ${index + 1}`,
    lastMessageType: "SMS",
    unreadCount: index,
    fullName: `Synthetic Contact ${index + 1}`,
    contactName: `Synthetic ${index + 1}`,
    email: `synthetic-${index + 1}@example.test`,
    phone: `+18645550${String(100 + index)}`,
    type: "TYPE_PHONE",
  }));
  const adapter = createGhlAdapter({ locationId: LOCATION_ID, accessToken: ACCESS_TOKEN }, {
    fetchImpl: (async (input) => {
      const url = String(input);
      urls.push(url);
      if (url.includes("/conversations/search?")) {
        return Response.json({ conversations, total: conversations.length });
      }
      throw new Error(`Unexpected per-conversation request: ${url}`);
    }) as typeof fetch,
  });

  const result = await adapter.listConversations!({ limit: conversations.length, includeContent: false });

  assert.equal(result.length, conversations.length);
  assert.equal(urls.length, 1);
  assert.match(urls[0], /sortBy=last_message_date/);
  assert.match(urls[0], /sort=desc/);
  assert.equal(result.every((conversation) => conversation.preview === undefined), true);
  assert.equal(result.every((conversation) => conversation.messages.length === 0), true);
});

test("GHL reads one conversation thread through bounded cursor pagination", async () => {
  const urls: string[] = [];
  const adapter = createGhlAdapter({ locationId: LOCATION_ID, accessToken: ACCESS_TOKEN }, {
    fetchImpl: (async (input) => {
      const url = String(input);
      urls.push(url);
      const cursor = new URL(url).searchParams.get("lastMessageId");
      if (cursor === null) {
        return Response.json({
          lastMessageId: "message-thread-1",
          nextPage: true,
          messages: [{
            id: "message-thread-1",
            dateAdded: "2026-08-03T13:00:00.000Z",
            direction: "inbound",
            status: "delivered",
            body: "Synthetic thread message",
            from: "+18645550199",
            to: ["+18645550100"],
          }],
        });
      }
      assert.equal(cursor, "message-thread-1");
      return Response.json({
        lastMessageId: "message-thread-2",
        nextPage: false,
        messages: [{
          id: "message-thread-2",
          dateAdded: null,
          direction: null,
          status: null,
          body: null,
        }],
      });
    }) as typeof fetch,
  });

  const result = await adapter.getConversationMessages!(CONVERSATION_ID, { includeContent: true });

  assert.deepEqual(result, [
    {
      id: "message-thread-1",
      direction: "inbound",
      status: "delivered",
      occurredAt: "2026-08-03T13:00:00.000Z",
      from: "+18645550199",
      to: "+18645550100",
      body: "Synthetic thread message",
    },
    {
      id: "message-thread-2",
      direction: "unknown",
      status: "unknown",
    },
  ]);
  assert.equal(urls.length, 2);
  assert.match(urls[0], new RegExp(`/conversations/${CONVERSATION_ID}/messages\\?`));
  assert.match(urls[0], /limit=100/);
  assert.match(urls[0], /type=TYPE_SMS/);
  assert.equal(new URL(urls[1]).searchParams.get("lastMessageId"), "message-thread-1");
});

test("GHL stops thread pagination when the vendor repeats a cursor", async () => {
  let requests = 0;
  const adapter = createGhlAdapter({ locationId: LOCATION_ID, accessToken: ACCESS_TOKEN }, {
    fetchImpl: (async () => {
      requests += 1;
      return Response.json({ lastMessageId: "repeated-message", nextPage: true, messages: [] });
    }) as typeof fetch,
  });

  await assert.rejects(
    () => adapter.getConversationMessages!(CONVERSATION_ID, { includeContent: true }),
    /repeated a cursor/i,
  );
  assert.equal(requests, 2);
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

test("GHL contact resolution reads every advanced-search page before deciding an exact match", async () => {
  const pages: number[] = [];
  const adapter = createGhlAdapter({ locationId: LOCATION_ID, accessToken: ACCESS_TOKEN }, {
    fetchImpl: (async (input, init = {}) => {
      const url = String(input);
      if (url.endsWith("/contacts/search")) {
        const body = JSON.parse(String(init.body));
        pages.push(body.page);
        return Response.json(body.page === 1 ? {
          contacts: Array.from({ length: 100 }, (_, index) => ({
            id: `contact-page-1-${index}`,
            phone: `+1864554${String(index).padStart(4, "0")}`,
          })),
          total: 101,
        } : {
          contacts: [{ id: CONTACT_ID, phone: "+18645550199" }],
          total: 101,
        });
      }
      return Response.json({ conversationId: CONVERSATION_ID, messageId: MESSAGE_ID });
    }) as typeof fetch,
  });

  const result = await adapter.sendSms!({
    patientReference: "Patient/synthetic-1",
    toNumber: "+18645550199",
    body: "Synthetic appointment reminder.",
    campaignType: "staff-initiated",
    suppression: {},
  });

  assert.equal(result.outcome, "sent");
  assert.deepEqual(pages, [1, 2]);
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

test("GHL inbound route returns 500 when an authenticated event handler fails", async () => {
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
  const app = express();
  registerGhlWebhookRoutes(app, {
    auth: { locationId: LOCATION_ID, publicKey },
    onEvent: () => {
      throw new Error("synthetic transient handler failure");
    },
  });
  const server = app.listen(0);
  await once(server, "listening");
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const response = await fetch(`${base}/comms/ghl/inbound`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-ghl-signature": sign(null, Buffer.from(rawBody), privateKey).toString("base64"),
      },
      body: rawBody,
    });
    assert.equal(response.status, 500);
  } finally {
    server.close();
    await once(server, "close");
  }
});
