import { verify, type KeyLike } from "node:crypto";
import { parsePhoneNumberFromString } from "libphonenumber-js";
import type {
  CommsProvider,
  ContactRecord,
  ContactSearch,
  ConversationListRequest,
  ConversationMessage,
  ConversationSummary,
  SendResult,
  SendSmsRequest,
} from "../comms-provider.js";
import { ODOS_GHL_MESSAGE_IDENTIFIER_SYSTEM } from "../comms-persistence.js";

/**
 * Verified 2026-08-03 against HighLevel's current primary API documentation:
 * - Sub-account OAuth/PIT bearer auth, `Version: v3`, and SMS sends:
 *   https://marketplace.gohighlevel.com/docs/ghl/conversations/send-a-new-message/
 * - Live conversation search and per-conversation message reads:
 *   https://marketplace.gohighlevel.com/docs/ghl/conversations/search-conversation/
 *   https://marketplace.gohighlevel.com/docs/ghl/conversations/get-messages/
 * - Advanced contact search and location-scoped upsert:
 *   https://marketplace.gohighlevel.com/docs/ghl/contacts/search-contacts-advanced/
 *   https://marketplace.gohighlevel.com/docs/ghl/contacts/upsert-contact/
 * - InboundMessage payload and Ed25519 X-GHL-Signature verification:
 *   https://marketplace.gohighlevel.com/docs/2021-04-15/webhook/InboundMessage/
 *   https://marketplace.gohighlevel.com/docs/2021-07-28/webhook/WebhookIntegrationGuide/
 */

const GHL_API_BASE_URL = "https://services.leadconnectorhq.com";
const GHL_API_VERSION = "v3";
const GHL_REQUEST_TIMEOUT_MS = 30_000;
const GHL_CONTACT_PAGE_LIMIT = 100;
const GHL_CONTACT_PAGE_CAP = 100;
const GHL_MESSAGE_PAGE_LIMIT = 100;
const GHL_MESSAGE_PAGE_CAP = 100;
const GHL_CONVERSATION_READ_CONCURRENCY = 5;
const GHL_WEBHOOK_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAi2HR1srL4o18O8BRa7gVJY7G7bupbN3H9AwJrHCDiOg=
-----END PUBLIC KEY-----`;

export interface GhlAdapterConfig {
  locationId: string;
  accessToken: string;
}

export interface GhlAdapterDeps {
  fetchImpl?: typeof fetch;
  resolvePatientPhone?(patientReference: string): Promise<string>;
}

interface GhlContact {
  id: string;
  email?: string;
  phone?: string;
  dnd?: boolean;
  dndSettings?: {
    SMS?: {
      status?: string;
      code?: string;
    };
  };
}

interface GhlConversation {
  id: string;
  contactId: string;
  lastMessageDate?: string;
}

interface GhlMessage {
  id: string;
  dateAdded: string;
  direction: string;
  status?: string;
  body?: string;
  from?: string;
  to?: string | string[];
}

export interface GhlInboundWebhookEvent {
  type: "InboundMessage";
  locationId: string;
  direction: "inbound";
  messageType: "SMS";
  body: string;
  contactId: string;
  conversationId: string;
  messageId?: string;
  dateAdded: string;
  status: string;
  from: string;
  to: string;
}

export interface GhlWebhookAuth {
  locationId: string;
  publicKey?: KeyLike;
}

export class GhlSignatureError extends Error {
  constructor() {
    super("GHL webhook X-GHL-Signature validation failed.");
  }
}

export function createGhlAdapter(
  config: GhlAdapterConfig,
  deps: GhlAdapterDeps = {},
): CommsProvider {
  const locationId = requiredConfig(config.locationId, "GHL location id");
  const accessToken = requiredConfig(config.accessToken, "GHL access token");
  const fetchImpl = deps.fetchImpl ?? fetch;
  const request = <T>(path: string, init: RequestInit = {}) =>
    ghlRequest<T>(fetchImpl, accessToken, path, init);
  const contactsForQuery = async (query: string): Promise<GhlContact[]> => {
    const contacts: GhlContact[] = [];
    for (let page = 1; page <= GHL_CONTACT_PAGE_CAP; page += 1) {
      const response = await request<{ contacts?: unknown; total?: unknown }>("/contacts/search", {
        method: "POST",
        body: JSON.stringify({ locationId, page, pageLimit: GHL_CONTACT_PAGE_LIMIT, query }),
      });
      const pageContacts = contactArray(response.contacts);
      contacts.push(...pageContacts);
      if (response.total !== undefined) {
        if (typeof response.total !== "number" || !Number.isInteger(response.total) || response.total < 0) {
          throw new Error("GHL contact search response has an invalid total.");
        }
        if (contacts.length >= response.total) return contacts;
      } else if (pageContacts.length < GHL_CONTACT_PAGE_LIMIT) {
        return contacts;
      }
      if (pageContacts.length === 0) {
        throw new Error("GHL contact search pagination ended before its reported total.");
      }
    }
    throw new Error("GHL contact search pagination exceeded 100 pages.");
  };
  const exactContactForPhone = async (phone: string): Promise<GhlContact | undefined> => {
    const normalized = e164(phone, "GHL contact phone");
    const matches = (await contactsForQuery(normalized)).filter((contact) =>
      contact.phone !== undefined && comparablePhone(contact.phone) === normalized);
    if (matches.length > 1) {
      throw new Error(`Multiple GHL contacts exactly match ${normalized}; refusing an ambiguous patient send.`);
    }
    return matches[0];
  };
  const messagesForConversation = async (
    conversationId: string,
    includeContent: boolean,
  ): Promise<ConversationMessage[]> => {
    const messages: ConversationMessage[] = [];
    const seenCursors = new Set<string>();
    let lastMessageId: string | undefined;
    for (let page = 0; page < GHL_MESSAGE_PAGE_CAP; page += 1) {
      const query = new URLSearchParams({
        limit: String(GHL_MESSAGE_PAGE_LIMIT),
        type: "TYPE_SMS",
      });
      if (lastMessageId) query.set("lastMessageId", lastMessageId);
      const response = await request<{
        lastMessageId?: unknown;
        nextPage?: unknown;
        messages?: unknown;
      }>(`/conversations/${encodeURIComponent(conversationId)}/messages?${query}`);
      messages.push(...messageArray(response.messages).map((message) =>
        conversationMessage(message, includeContent)));
      if (response.nextPage === false) return messages;
      if (response.nextPage !== true) {
        throw new Error("GHL conversation messages response has an invalid nextPage value.");
      }
      const cursor = requiredResponseString(response.lastMessageId, "GHL message page cursor");
      if (seenCursors.has(cursor)) {
        throw new Error("GHL conversation messages pagination repeated a cursor.");
      }
      seenCursors.add(cursor);
      lastMessageId = cursor;
    }
    throw new Error("GHL conversation messages pagination exceeded 100 pages.");
  };

  return {
    name: "ghl",
    messageIdentifierSystem: ODOS_GHL_MESSAGE_IDENTIFIER_SYSTEM,
    capabilities: {
      sms: true,
      calls: false,
      email: false,
      contacts: true,
      conversations: true,
      reviews: false,
    },
    async sendSms(input: SendSmsRequest): Promise<SendResult> {
      const resolvedPhone = input.toNumber ?? await deps.resolvePatientPhone?.(input.patientReference);
      const toNumber = e164(resolvedPhone, "GHL SMS recipient");
      const contact = await exactContactForPhone(toNumber);
      if (!contact) {
        throw new Error(`No GHL contact exactly matches ${toNumber}; upsert the patient contact before sending.`);
      }
      const smsDnd = contact.dndSettings?.SMS?.status?.toLowerCase();
      if (contact.dnd === true || (smsDnd !== undefined && smsDnd !== "inactive")) {
        return { outcome: "suppressed", reason: "patient-opt-out" };
      }
      const response = await request<Record<string, unknown>>("/conversations/messages", {
        method: "POST",
        body: JSON.stringify({
          type: "SMS",
          contactId: contact.id,
          message: requiredText(input.body, "GHL SMS body"),
          status: "pending",
          toNumber,
        }),
      });
      const messageId = requiredResponseString(response.messageId, "GHL message id");
      const conversationId = requiredResponseString(response.conversationId, "GHL conversation id");
      return {
        outcome: "sent",
        providerMessageId: messageId,
        providerThreadId: conversationId,
      };
    },
    async listConversations(input: ConversationListRequest = {}): Promise<ConversationSummary[]> {
      const limit = input.limit ?? 50;
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
        throw new Error("GHL conversation history limit must be an integer from 1 to 100.");
      }
      let contactId: string | undefined;
      if (input.patientReference) {
        if (!deps.resolvePatientPhone) {
          throw new Error("GHL patient-filtered conversation history requires a patient phone resolver.");
        }
        const contact = await exactContactForPhone(await deps.resolvePatientPhone(input.patientReference));
        if (!contact) return [];
        contactId = contact.id;
      }
      const query = new URLSearchParams({ locationId, limit: String(limit) });
      if (contactId) query.set("contactId", contactId);
      const response = await request<{ conversations?: unknown }>(`/conversations/search?${query}`);
      const conversations = conversationArray(response.conversations);
      const summaries: Array<ConversationSummary | undefined> = [];
      for (let offset = 0; offset < conversations.length; offset += GHL_CONVERSATION_READ_CONCURRENCY) {
        summaries.push(...await Promise.all(
          conversations
            .slice(offset, offset + GHL_CONVERSATION_READ_CONCURRENCY)
            .map(async (conversation): Promise<ConversationSummary | undefined> => {
              const messages = await messagesForConversation(
                conversation.id,
                input.includeContent === true,
              );
              if (messages.length === 0) return undefined;
              messages.sort((left, right) => Date.parse(right.occurredAt) - Date.parse(left.occurredAt));
              return {
                id: conversation.id,
                ...(input.patientReference ? { patientReference: input.patientReference } : {}),
                updatedAt: messages[0].occurredAt,
                messageCount: messages.length,
                messages,
              };
            }),
        ));
      }
      return summaries
        .filter((summary): summary is ConversationSummary => summary !== undefined)
        .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt));
    },
    async searchContacts(input: ContactSearch): Promise<ContactRecord[]> {
      const query = requiredText(input.query, "GHL contact search query");
      return (await contactsForQuery(query)).map(contactRecord);
    },
    async upsertContact(input: ContactRecord): Promise<ContactRecord> {
      const email = input.email?.trim();
      const phone = input.phone ? e164(input.phone, "GHL contact phone") : undefined;
      if (!email && !phone) throw new Error("GHL contact upsert requires an email or phone.");
      const response = await request<{ contact?: unknown }>("/contacts/upsert", {
        method: "POST",
        body: JSON.stringify({
          locationId,
          ...(email ? { email } : {}),
          ...(phone ? { phone } : {}),
          source: "ODOS",
          createNewIfDuplicateAllowed: false,
        }),
      });
      const contact = contactObject(response.contact);
      return {
        ...contactRecord(contact),
        ...(input.patientReference ? { patientReference: input.patientReference } : {}),
      };
    },
  };
}

export function handleGhlInboundWebhook(
  rawBody: string,
  signature: string | undefined,
  auth: GhlWebhookAuth,
): GhlInboundWebhookEvent {
  const locationId = requiredConfig(auth.locationId, "GHL location id");
  if (!signature) throw new GhlSignatureError();
  let valid = false;
  try {
    valid = verify(
      null,
      Buffer.from(rawBody, "utf8"),
      auth.publicKey ?? GHL_WEBHOOK_PUBLIC_KEY,
      Buffer.from(signature, "base64"),
    );
  } catch {
    throw new GhlSignatureError();
  }
  if (!valid) throw new GhlSignatureError();
  const payload = jsonObject(rawBody);
  if (
    payload.type !== "InboundMessage"
    || payload.locationId !== locationId
    || payload.direction !== "inbound"
    || payload.messageType !== "SMS"
  ) {
    throw new Error("GHL inbound webhook is not an SMS InboundMessage for the configured location.");
  }
  return {
    type: "InboundMessage",
    locationId,
    direction: "inbound",
    messageType: "SMS",
    body: requiredResponseString(payload.body, "GHL inbound body"),
    contactId: requiredResponseString(payload.contactId, "GHL inbound contact id"),
    conversationId: requiredResponseString(payload.conversationId, "GHL inbound conversation id"),
    ...(typeof payload.messageId === "string" && payload.messageId.trim()
      ? { messageId: payload.messageId.trim() }
      : {}),
    dateAdded: requiredDate(payload.dateAdded, "GHL inbound date"),
    status: requiredResponseString(payload.status, "GHL inbound status"),
    from: e164(payload.from, "GHL inbound sender"),
    to: e164(payload.to, "GHL inbound recipient"),
  };
}

async function ghlRequest<T>(
  fetchImpl: typeof fetch,
  accessToken: string,
  path: string,
  init: RequestInit,
): Promise<T> {
  const response = await fetchImpl(`${GHL_API_BASE_URL}${path}`, {
    ...init,
    headers: {
      accept: "application/json",
      authorization: `Bearer ${accessToken}`,
      version: GHL_API_VERSION,
      ...(init.body === undefined ? {} : { "content-type": "application/json" }),
      ...init.headers,
    },
    signal: init.signal ?? AbortSignal.timeout(GHL_REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`GHL API request failed with HTTP ${response.status}.`);
  }
  return await response.json() as T;
}

function contactArray(value: unknown): GhlContact[] {
  if (!Array.isArray(value)) throw new Error("GHL contact search response is invalid.");
  return value.map(contactObject);
}

function contactObject(value: unknown): GhlContact {
  const contact = record(value);
  return {
    id: requiredResponseString(contact.id, "GHL contact id"),
    ...(typeof contact.email === "string" ? { email: contact.email } : {}),
    ...(typeof contact.phone === "string" ? { phone: contact.phone } : {}),
    ...(typeof contact.dnd === "boolean" ? { dnd: contact.dnd } : {}),
    ...(record(contact.dndSettings).SMS ? {
      dndSettings: {
        SMS: {
          ...(typeof record(record(contact.dndSettings).SMS).status === "string"
            ? { status: String(record(record(contact.dndSettings).SMS).status) }
            : {}),
          ...(typeof record(record(contact.dndSettings).SMS).code === "string"
            ? { code: String(record(record(contact.dndSettings).SMS).code) }
            : {}),
        },
      },
    } : {}),
  };
}

function conversationArray(value: unknown): GhlConversation[] {
  if (!Array.isArray(value)) throw new Error("GHL conversation search response is invalid.");
  return value.map((entry) => {
    const conversation = record(entry);
    return {
      id: requiredResponseString(conversation.id, "GHL conversation id"),
      contactId: requiredResponseString(conversation.contactId, "GHL conversation contact id"),
      ...(typeof conversation.lastMessageDate === "string"
        ? { lastMessageDate: conversation.lastMessageDate }
        : {}),
    };
  });
}

function messageArray(value: unknown): GhlMessage[] {
  if (!Array.isArray(value)) throw new Error("GHL conversation messages response is invalid.");
  return value.map((entry) => {
    const message = record(entry);
    return {
      id: requiredResponseString(message.id, "GHL message id"),
      dateAdded: requiredDate(message.dateAdded, "GHL message date"),
      direction: requiredResponseString(message.direction, "GHL message direction"),
      ...(typeof message.status === "string" ? { status: message.status } : {}),
      ...(typeof message.body === "string" ? { body: message.body } : {}),
      ...(typeof message.from === "string" ? { from: message.from } : {}),
      ...(typeof message.to === "string" || Array.isArray(message.to) ? { to: message.to as string | string[] } : {}),
    };
  });
}

function conversationMessage(message: GhlMessage, includeContent: boolean): ConversationMessage {
  const direction = ["inbound", "outbound"].includes(message.direction)
    ? message.direction as "inbound" | "outbound"
    : "unknown";
  return {
    id: message.id,
    direction,
    status: message.status ?? "unknown",
    occurredAt: message.dateAdded,
    ...(message.from ? { from: message.from } : {}),
    ...(message.to ? { to: Array.isArray(message.to) ? message.to[0] : message.to } : {}),
    ...(includeContent && message.body !== undefined ? { body: message.body } : {}),
  };
}

function contactRecord(contact: GhlContact): ContactRecord {
  return {
    id: contact.id,
    ...(contact.email ? { email: contact.email } : {}),
    ...(contact.phone ? { phone: contact.phone } : {}),
  };
}

function requiredConfig(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${label} is required.`);
  return normalized;
}

function requiredText(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${label} is required.`);
  return normalized;
}

function requiredResponseString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} is missing or invalid.`);
  return value.trim();
}

function requiredDate(value: unknown, label: string): string {
  const date = requiredResponseString(value, label);
  if (!Number.isFinite(Date.parse(date))) throw new Error(`${label} is invalid.`);
  return date;
}

function e164(value: unknown, label: string): string {
  if (typeof value !== "string") throw new Error(`${label} must be an E.164 phone number.`);
  const parsed = parsePhoneNumberFromString(value);
  if (!parsed?.isValid() || parsed.number !== value.replace(/[\s()-]/g, "")) {
    throw new Error(`${label} must be an E.164 phone number.`);
  }
  return parsed.number;
}

function comparablePhone(value: string): string | undefined {
  const parsed = parsePhoneNumberFromString(value);
  return parsed?.isValid() ? parsed.number : undefined;
}

function jsonObject(rawBody: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(rawBody);
  } catch {
    throw new Error("GHL webhook body must be valid JSON.");
  }
  return record(value);
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}
