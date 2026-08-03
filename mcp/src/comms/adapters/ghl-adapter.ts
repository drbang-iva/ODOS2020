import { verify, type KeyLike } from "node:crypto";
import { parsePhoneNumberFromString } from "libphonenumber-js";
import type {
  CommsProvider,
  ContactRecord,
  ContactSearch,
  ConversationListRequest,
  ConversationSummary,
  SendResult,
  SendSmsRequest,
} from "../comms-provider.js";
import { ODOS_GHL_MESSAGE_IDENTIFIER_SYSTEM } from "../comms-persistence.js";

/**
 * Verified 2026-08-03 against HighLevel's current primary API documentation:
 * - Sub-account OAuth/PIT bearer auth, `Version: v3`, and SMS sends:
 *   https://marketplace.gohighlevel.com/docs/ghl/conversations/send-a-new-message/
 * - Conversation search schema and documented recency ordering:
 *   https://raw.githubusercontent.com/GoHighLevel/highlevel-api-docs/main/apps/v3/conversations-v3.json
 *   https://marketplace.gohighlevel.com/docs/ghl/conversations/search-conversation/
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
  locationId: string;
  lastMessageBody: string;
  lastMessageType: string;
  type: string;
  unreadCount: number;
  fullName: string;
  contactName: string;
  email: string;
  phone: string;
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
      throw new Error("Multiple GHL contacts exactly match the patient phone; refusing an ambiguous patient send.");
    }
    return matches[0];
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
        throw new Error("No GHL contact exactly matches the patient phone; upsert the patient contact before sending.");
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
      const query = new URLSearchParams({
        locationId,
        limit: String(limit),
        sortBy: "last_message_date",
        sort: "desc",
      });
      if (contactId) query.set("contactId", contactId);
      const response = await request<{ conversations?: unknown }>(`/conversations/search?${query}`);
      const conversations = conversationArray(response.conversations);
      return conversations.map((conversation): ConversationSummary => ({
        id: conversation.id,
        ...(input.patientReference ? { patientReference: input.patientReference } : {}),
        ...(input.includeContent === true && conversation.lastMessageBody
          ? { preview: conversation.lastMessageBody }
          : {}),
        channel: conversation.lastMessageType,
        unreadCount: conversation.unreadCount,
        displayName: conversation.fullName || conversation.contactName,
        ...(conversation.phone ? { phone: conversation.phone } : {}),
        ...(conversation.email ? { email: conversation.email } : {}),
        messages: [],
      }));
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
  const smsSettings = record(contact.dndSettings).SMS;
  const sms = record(smsSettings);
  return {
    id: requiredResponseString(contact.id, "GHL contact id"),
    ...(typeof contact.email === "string" ? { email: contact.email } : {}),
    ...(typeof contact.phone === "string" ? { phone: contact.phone } : {}),
    ...(typeof contact.dnd === "boolean" ? { dnd: contact.dnd } : {}),
    ...(smsSettings ? {
      dndSettings: {
        SMS: {
          ...(typeof sms.status === "string" ? { status: sms.status } : {}),
          ...(typeof sms.code === "string" ? { code: sms.code } : {}),
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
      locationId: responseString(conversation.locationId, "GHL conversation location id"),
      lastMessageBody: responseString(conversation.lastMessageBody, "GHL conversation last message body"),
      lastMessageType: responseString(conversation.lastMessageType, "GHL conversation last message type"),
      type: responseString(conversation.type, "GHL conversation type"),
      unreadCount: nonNegativeInteger(conversation.unreadCount, "GHL conversation unread count"),
      fullName: responseString(conversation.fullName, "GHL conversation full name"),
      contactName: responseString(conversation.contactName, "GHL conversation contact name"),
      email: responseString(conversation.email, "GHL conversation email"),
      phone: responseString(conversation.phone, "GHL conversation phone"),
    };
  });
}

function responseString(value: unknown, label: string): string {
  if (typeof value !== "string") throw new Error(`${label} is missing or invalid.`);
  return value.trim();
}

function nonNegativeInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new Error(`${label} is missing or invalid.`);
  }
  return value;
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
