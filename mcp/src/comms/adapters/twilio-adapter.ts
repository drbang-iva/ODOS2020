import twilio from "twilio";
import { parsePhoneNumberFromString } from "libphonenumber-js";
import type { Communication, Reference } from "@medplum/fhirtypes";
import { searchBounded, type FhirSearchClient } from "../../fhir-search.js";
import type {
  CallDetail,
  CallListRequest,
  CallRecording,
  CallRequest,
  CommsProvider,
  ConversationListRequest,
  ConversationMessage,
  ConversationSummary,
  SendResult,
  SendSmsRequest,
} from "../comms-provider.js";
import {
  ODOS_COMMS_CATEGORY_SYSTEM,
  ODOS_COMMS_PHONE_IDENTIFIER_SYSTEM,
  ODOS_PATIENT_SMS_INBOUND_CATEGORY,
  ODOS_PATIENT_SMS_OUTBOUND_CATEGORY,
  ODOS_PATIENT_SMS_CATEGORY,
  ODOS_TWILIO_MESSAGE_IDENTIFIER_SYSTEM,
} from "../comms-persistence.js";

/**
 * Twilio Programmable Messaging + Programmable Voice adapter.
 *
 * Verified 2026-08-01 against Twilio's official Node SDK and primary documentation:
 * - The SDK Message resource sends with client.messages.create and accepts either a
 *   MessagingServiceSid or From sender:
 *   https://www.twilio.com/docs/libraries/reference/twilio-node/
 *   https://www.twilio.com/docs/messaging/api/message-resource
 * - The SDK supports API key credentials with accountSid and owns the HTTP timeout:
 *   https://github.com/twilio/twilio-node/blob/6.0.2/src/base/BaseTwilio.ts
 *   https://www.twilio.com/docs/libraries/reference/twilio-node/
 * - Twilio blocks future sends after STOP and reports an attempted send as error 21610;
 *   START removes the block:
 *   https://www.twilio.com/docs/messaging/tutorials/advanced-opt-out
 *   https://www.twilio.com/docs/api/errors/21610
 * - The SDK provides distinct validators for form and JSON webhooks. Validation must use
 *   the exact externally configured URL before any payload field is trusted:
 *   https://github.com/twilio/twilio-node/blob/6.0.2/src/webhooks/webhooks.ts
 *   https://www.twilio.com/docs/usage/webhooks/webhooks-security
 * - A Messaging Service's PhoneNumbers subresource exposes each sender's ISO country code;
 *   the pinned SDK list() follows all pages when no limit is supplied:
 *   https://www.twilio.com/docs/messaging/api/phonenumber-resource
 *   https://github.com/twilio/twilio-node/blob/6.0.2/src/rest/messaging/v1/service/phoneNumber.ts
 * - Calls are created/read through the Calls resource; progress callbacks use the documented
 *   event set, and inbound calls receive TwiML:
 *   https://www.twilio.com/docs/voice/api/call-resource
 *   https://www.twilio.com/docs/voice/tutorials/how-to-respond-to-incoming-phone-calls
 * - Recording media uses the authenticated .mp3 Recording resource. Real-Time Transcription
 *   uses signed status webhooks; Batch Transcription v3 is not exposed because it is not HIPAA
 *   eligible:
 *   https://www.twilio.com/docs/voice/api/recording
 *   https://www.twilio.com/docs/voice/twiml/transcription
 *   https://www.twilio.com/content/dam/twilio-com/global/en/other/hipaa/pdf/HIPAA-Eligible-Services.pdf
 */

export const TWILIO_OPT_OUT_LANGUAGE = "Reply STOP to unsubscribe.";
export const TWILIO_REQUEST_TIMEOUT_MS = 30_000;
export const TWILIO_HIPAA_POOL_VERIFICATION_TTL_MS = 5 * 60 * 1_000;

export interface TwilioAdapterConfig {
  accountSid: string;
  authToken: string;
  apiKeySid?: string;
  apiKeySecret?: string;
  messagingServiceSid?: string;
  fromNumber?: string;
  voiceApiKeySid?: string;
  voiceApiKeySecret?: string;
  voiceFromNumber?: string;
  voiceForwardToNumber?: string;
  webhookBaseUrl?: string;
  hipaaMode?: boolean;
  realTimeTranscriptionEnabled?: boolean;
  mediaUrlAuthAcknowledged?: boolean;
}

type TwilioClientOptions = NonNullable<Parameters<typeof twilio>[2]>;
type TwilioMessageCreateInput = Parameters<ReturnType<typeof twilio>["messages"]["create"]>[0];
type TwilioCallCreateInput = Parameters<ReturnType<typeof twilio>["calls"]["create"]>[0];

interface TwilioCallRecord {
  sid: string;
  from: string;
  to: string;
  status: string;
  direction: string;
  startTime?: Date | null;
  endTime?: Date | null;
  duration?: string | null;
}

interface TwilioRecordingRecord {
  sid: string;
  callSid: string;
  status: string;
  duration?: string | null;
}

interface TwilioMessagingServicePhoneNumber {
  phoneNumber: string;
  countryCode: string;
}

export interface TwilioSdkClient {
  messages: {
    create(input: TwilioMessageCreateInput): Promise<{ sid: string }>;
  };
  calls?: {
    create(input: TwilioCallCreateInput): Promise<{ sid: string }>;
    list(input: { limit: number }): Promise<TwilioCallRecord[]>;
    get(sid: string): { fetch(): Promise<TwilioCallRecord> };
  };
  recordings?: {
    get(sid: string): { fetch(): Promise<TwilioRecordingRecord> };
  };
  messaging?: {
    v1: {
      services(sid: string): {
        phoneNumbers: {
          list(): Promise<TwilioMessagingServicePhoneNumber[]>;
        };
      };
    };
  };
}

export type TwilioClientFactory = (
  username: string,
  password: string,
  options: Pick<TwilioClientOptions, "accountSid" | "timeout">,
) => TwilioSdkClient;

export interface TwilioAdapterDeps {
  clientFactory?: TwilioClientFactory;
  fetchImpl?: typeof fetch;
  now?: () => Date;
}

export interface TwilioAdapter extends CommsProvider {
  initialize(): Promise<void>;
}

export interface TwilioWebhookRequest {
  requestTarget: string;
  contentType: string | undefined;
  params?: Record<string, string>;
  rawBody?: string;
  signature: string | undefined;
}

export interface TwilioWebhookAuth {
  accountSid: string;
  authToken: string;
  externalBaseUrl: string;
}

export class TwilioSignatureError extends Error {
  constructor() {
    super("Twilio webhook X-Twilio-Signature validation failed.");
  }
}

export interface TwilioInboundWebhookEvent {
  accountSid: string;
  messageSid: string;
  from: string;
  to: string;
  body: string;
  optOutType?: "STOP" | "START" | "HELP";
}

export interface TwilioStatusWebhookEvent {
  accountSid: string;
  messageSid: string;
  messageStatus: string;
  errorCode?: string;
  recipientOptedOut: boolean;
}

export interface TwilioVoiceWebhookEvent {
  accountSid: string;
  callId: string;
  from: string;
  to: string;
  direction: "inbound" | "outbound-api" | "outbound-dial";
  status: "queued" | "initiated" | "ringing" | "in-progress" | "completed" | "busy" | "failed" | "no-answer" | "canceled";
  callerName?: string;
  sequenceNumber?: number;
  durationSeconds?: number;
  recordingId?: string;
}

export interface TwilioRecordingWebhookEvent {
  accountSid: string;
  callId: string;
  recordingId: string;
  status: "in-progress" | "completed" | "absent";
  durationSeconds?: number;
  channels?: number;
}

export interface TwilioTranscriptionWebhookEvent {
  accountSid: string;
  callId: string;
  transcriptionId: string;
  event: "transcription-started" | "transcription-content" | "transcription-stopped" | "transcription-error";
  timestamp: string;
  sequenceId: number;
  languageCode?: string;
  track?: "inbound_track" | "outbound_track";
  text?: string;
  confidence?: number;
  final?: boolean;
}

export function createTwilioAdapter(
  config: TwilioAdapterConfig,
  deps: TwilioAdapterDeps = {},
): TwilioAdapter {
  const normalized = validateTwilioConfig(config);
  const clientFactory = deps.clientFactory ?? ((username, password, options) => (
    twilio(username, password, options)
  ));
  const messagingClient = clientFactory(
    normalized.apiKeySid ?? normalized.accountSid,
    normalized.apiKeySecret ?? normalized.authToken,
    { accountSid: normalized.accountSid, timeout: TWILIO_REQUEST_TIMEOUT_MS },
  );
  const voiceClient = normalized.voice
    ? clientFactory(normalized.voice.apiKeySid, normalized.voice.apiKeySecret, {
        accountSid: normalized.accountSid,
        timeout: TWILIO_REQUEST_TIMEOUT_MS,
      })
    : undefined;
  const now = deps.now ?? (() => new Date());
  let poolVerification: { checkedAt: number; promise: Promise<void> } | undefined;
  const verifyPool = (): Promise<void> => {
    const checkedAt = now().getTime();
    if (
      !poolVerification
      || checkedAt - poolVerification.checkedAt >= TWILIO_HIPAA_POOL_VERIFICATION_TTL_MS
    ) {
      poolVerification = {
        checkedAt,
        promise: verifyHipaaMessagingServicePool(messagingClient, normalized),
      };
    }
    return poolVerification.promise;
  };
  let initialization: Promise<void> | undefined;
  const initialize = (): Promise<void> => {
    initialization ??= verifyPool();
    return initialization;
  };

  return {
    name: "twilio",
    initialize,
    capabilities: {
      sms: true,
      calls: normalized.voice !== undefined,
      email: false,
      contacts: false,
      conversations: false,
      reviews: false,
    },
    async sendSms(request: SendSmsRequest): Promise<SendResult> {
      try {
        await initialize();
        await verifyPool();
        const recipient = e164(request.toNumber, "Twilio SMS recipient");
        const created = await messagingClient.messages.create({
          to: normalized.hipaaMode
            ? usE164(recipient, "Twilio SMS recipient")
            : recipient,
          body: smsBody(request.body),
          ...(normalized.messagingServiceSid
            ? { messagingServiceSid: normalized.messagingServiceSid }
            : { from: normalized.fromNumber! }),
        });
        return { outcome: "sent", providerMessageId: created.sid };
      } catch (error) {
        if (error instanceof twilio.RestException && error.code === 21610) {
          return { outcome: "suppressed", reason: "patient-opt-out" };
        }
        throw error;
      }
    },
    ...(normalized.voice
      ? voiceMethods(voiceClient!, normalized, normalized.voice, deps.fetchImpl ?? fetch)
      : {}),
  };
}

export function withTwilioConversationStore(
  adapter: TwilioAdapter,
  fhir: FhirSearchClient,
): TwilioAdapter {
  return {
    ...adapter,
    capabilities: { ...adapter.capabilities, conversations: true },
    listConversations: (request: ConversationListRequest = {}) =>
      listPersistedConversations(fhir, request),
  };
}

async function listPersistedConversations(
  fhir: FhirSearchClient,
  request: ConversationListRequest,
): Promise<ConversationSummary[]> {
  const limit = request.limit ?? 50;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new Error("Twilio conversation history limit must be an integer from 1 to 100.");
  }
  if (request.patientReference && !/^Patient\/[A-Za-z0-9.-]{1,64}$/.test(request.patientReference)) {
    throw new Error("Twilio conversation patientReference must be Patient/….");
  }
  const communications = await searchBounded<Communication>(fhir, "Communication", {
    category: `${ODOS_COMMS_CATEGORY_SYSTEM}|${ODOS_PATIENT_SMS_CATEGORY}`,
    ...(request.patientReference ? { subject: request.patientReference } : {}),
    _sort: "-_lastUpdated",
    _count: "100",
  }, { maxPages: 10, maxRows: 1_000 });
  const groups = new Map<string, ConversationMessage[]>();
  const patients = new Map<string, string | undefined>();
  for (const communication of communications.filter(isPersistedTwilioSms)) {
    const message = conversationMessage(communication, request.includeContent === true);
    if (!message) continue;
    const patientReference = communication.subject?.reference;
    const key = patientReference ?? counterpartyPhone(communication) ?? twilioMessageSid(communication);
    if (!key) continue;
    const messages = groups.get(key) ?? [];
    messages.push(message);
    groups.set(key, messages);
    patients.set(key, patientReference);
  }
  return [...groups.entries()]
    .map(([id, messages]): ConversationSummary => {
      messages.sort((left, right) => Date.parse(right.occurredAt!) - Date.parse(left.occurredAt!));
      const patientReference = patients.get(id);
      return {
        id,
        ...(patientReference ? { patientReference } : {}),
        updatedAt: messages[0].occurredAt,
        messageCount: messages.length,
        messages,
      };
    })
    .sort((left, right) => Date.parse(right.updatedAt!) - Date.parse(left.updatedAt!))
    .slice(0, limit);
}

function twilioMessageSid(communication: Communication): string | undefined {
  return communication.identifier?.find((identifier) =>
    identifier.system === ODOS_TWILIO_MESSAGE_IDENTIFIER_SYSTEM && Boolean(identifier.value))?.value;
}

function isPersistedTwilioSms(communication: Communication): boolean {
  return communication.identifier?.some((identifier) =>
    identifier.system === ODOS_TWILIO_MESSAGE_IDENTIFIER_SYSTEM && Boolean(identifier.value)) === true
    && communication.category?.some((category) => category.coding?.some((coding) =>
      coding.system === ODOS_COMMS_CATEGORY_SYSTEM && coding.code === ODOS_PATIENT_SMS_CATEGORY)) === true;
}

function conversationMessage(
  communication: Communication,
  includeContent: boolean,
): ConversationMessage | undefined {
  if (!communication.id) return undefined;
  const occurredAt = communication.received ?? communication.sent ?? communication.meta?.lastUpdated;
  if (!occurredAt) return undefined;
  const direction = communicationDirection(communication);
  return {
    id: communication.id,
    direction: direction === "inbound" || direction === "outbound" ? direction : "unknown",
    status: communication.status,
    occurredAt,
    ...(referencePhone(communication.sender) ? { from: referencePhone(communication.sender) } : {}),
    ...(referencePhone(communication.recipient?.[0]) ? { to: referencePhone(communication.recipient?.[0]) } : {}),
    ...(includeContent && communication.payload?.[0]?.contentString !== undefined
      ? { body: communication.payload[0].contentString }
      : {}),
  };
}

function referencePhone(reference: Reference | undefined): string | undefined {
  return reference?.identifier?.system === ODOS_COMMS_PHONE_IDENTIFIER_SYSTEM
    ? reference.identifier.value
    : undefined;
}

function counterpartyPhone(communication: Communication): string | undefined {
  const direction = communicationDirection(communication);
  return direction === "outbound"
    ? referencePhone(communication.recipient?.[0])
    : referencePhone(communication.sender);
}

function communicationDirection(communication: Communication): "inbound" | "outbound" | undefined {
  const codes = communication.category?.flatMap((category) => category.coding ?? []).filter((coding) =>
    coding.system === ODOS_COMMS_CATEGORY_SYSTEM).map((coding) => coding.code) ?? [];
  if (codes.includes(ODOS_PATIENT_SMS_INBOUND_CATEGORY)) return "inbound";
  if (codes.includes(ODOS_PATIENT_SMS_OUTBOUND_CATEGORY)) return "outbound";
  if (communication.sender?.reference?.startsWith("Patient/")) return "inbound";
  if (communication.recipient?.some((recipient) => recipient.reference?.startsWith("Patient/"))) return "outbound";
  return undefined;
}

async function verifyHipaaMessagingServicePool(
  client: TwilioSdkClient,
  config: ReturnType<typeof validateTwilioConfig>,
): Promise<void> {
  if (!config.hipaaMode || !config.messagingServiceSid) {
    return;
  }
  const phoneNumbers = client.messaging?.v1.services(config.messagingServiceSid).phoneNumbers;
  if (!phoneNumbers) {
    throw new Error(
      "Twilio cannot verify the Messaging Service sender pool in HIPAA mode because the SDK resource is unavailable; refusing to initialize.",
    );
  }
  let members: TwilioMessagingServicePhoneNumber[];
  try {
    members = await phoneNumbers.list();
  } catch (error) {
    throw new Error(
      `Twilio cannot verify Messaging Service ${config.messagingServiceSid} sender geography in HIPAA mode; refusing to initialize Twilio SMS.`,
      { cause: error },
    );
  }
  if (members.length === 0) {
    throw new Error(
      `Twilio Messaging Service ${config.messagingServiceSid} has no phone-number senders to verify while ODOS_HIPAA_MODE is true.`,
    );
  }
  const nonUsMembers = members.filter(({ countryCode }) => countryCode !== "US");
  if (nonUsMembers.length > 0) {
    const offenders = nonUsMembers
      .map(({ phoneNumber, countryCode }) => `${phoneNumber} (${countryCode || "country code missing"})`)
      .join(", ");
    throw new Error(
      `Twilio Messaging Service ${config.messagingServiceSid} contains non-US sender(s) while ODOS_HIPAA_MODE is true: ${offenders}.`,
    );
  }
}

function voiceMethods(
  client: TwilioSdkClient,
  config: ReturnType<typeof validateTwilioConfig>,
  voice: NonNullable<ReturnType<typeof validateTwilioConfig>["voice"]>,
  fetchImpl: typeof fetch,
): Pick<
  CommsProvider,
  "initiateCall" | "getCall" | "listCalls" | "fetchRecording"
> {
  const calls = client.calls;
  const recordings = client.recordings;
  if (!calls) {
    throw new Error("Twilio SDK client does not expose the Voice Calls resource.");
  }
  if (voice.mediaUrlAuthAcknowledged && !recordings) {
    throw new Error("Twilio SDK client does not expose the Voice Recordings resource.");
  }
  const credentials = `${voice.apiKeySid}:${voice.apiKeySecret}`;
  const authorization = `Basic ${Buffer.from(credentials).toString("base64")}`;
  return {
    async initiateCall(request: CallRequest): Promise<{ callId: string }> {
      const recipient = e164(request.toNumber, "Twilio Voice recipient");
      const patientNumber = config.hipaaMode
        ? usE164(recipient, "Twilio Voice recipient")
        : recipient;
      const statusCallback = `${voice.webhookBaseUrl}/comms/twilio/voice/status`;
      const response = new twilio.twiml.VoiceResponse();
      if (voice.realTimeTranscriptionEnabled) {
        addTwilioRealTimeTranscription(response, voice.webhookBaseUrl);
      }
      const dial = response.dial({
        answerOnBridge: true,
        callerId: voice.fromNumber,
      });
      dial.number({
        statusCallback,
        statusCallbackMethod: "POST",
        statusCallbackEvent: ["initiated", "ringing", "answered", "completed"],
      }, patientNumber);
      const created = await calls.create({
        to: voice.forwardToNumber,
        from: voice.fromNumber,
        twiml: response.toString(),
        statusCallback,
        statusCallbackMethod: "POST",
        statusCallbackEvent: ["initiated", "ringing", "answered", "completed"],
      });
      return { callId: created.sid };
    },
    async getCall(callId: string): Promise<CallDetail> {
      return normalizeCall(await calls.get(twilioSid(callId, "CA", "Twilio Call SID")).fetch());
    },
    async listCalls(request: CallListRequest = {}): Promise<CallDetail[]> {
      const limit = request.limit ?? 50;
      if (!Number.isInteger(limit) || limit < 1 || limit > 1000) {
        throw new Error("Twilio call history limit must be an integer from 1 to 1000.");
      }
      return (await calls.list({ limit })).map(normalizeCall);
    },
    ...(voice.mediaUrlAuthAcknowledged ? {
      async fetchRecording(recordingId: string): Promise<CallRecording> {
        const id = twilioSid(recordingId, "RE", "Twilio Recording SID");
        const metadata = await recordings!.get(id).fetch();
        if (metadata.status !== "completed") {
          throw new Error(`Twilio Recording ${id} is not available; status is "${metadata.status}".`);
        }
        const media = await fetchImpl(
          `https://api.twilio.com/2010-04-01/Accounts/${config.accountSid}/Recordings/${id}.mp3`,
          {
            headers: { Authorization: authorization },
            signal: AbortSignal.timeout(TWILIO_REQUEST_TIMEOUT_MS),
          },
        );
        if (!media.ok) {
          throw new Error(`Twilio Recording media fetch failed with HTTP ${media.status}.`);
        }
        const durationSeconds = optionalInteger(metadata.duration, "Twilio Recording duration");
        return {
          id: metadata.sid,
          callId: metadata.callSid,
          status: metadata.status,
          ...(durationSeconds !== undefined ? { durationSeconds } : {}),
          contentType: media.headers.get("content-type") ?? "application/octet-stream",
          audio: new Uint8Array(await media.arrayBuffer()),
        };
      },
    } : {}),
  };
}

export function addTwilioRealTimeTranscription(
  response: twilio.twiml.VoiceResponse,
  webhookBaseUrl: string,
): void {
  response.start().transcription({
    statusCallbackUrl: `${externalBaseUrl(webhookBaseUrl)}/comms/twilio/voice/transcription`,
    statusCallbackMethod: "POST",
    track: "both_tracks",
    partialResults: false,
  });
}

export function validateTwilioWebhook(
  request: TwilioWebhookRequest,
  auth: TwilioWebhookAuth,
): Record<string, unknown> {
  const signature = request.signature ?? "";
  const url = `${externalBaseUrl(auth.externalBaseUrl)}${requestTarget(request.requestTarget)}`;
  const contentType = request.contentType?.split(";", 1)[0]?.trim().toLowerCase();

  if (contentType === "application/x-www-form-urlencoded") {
    if (!request.params) {
      throw new Error("Twilio form webhook parameters are required.");
    }
    if (!twilio.validateRequest(auth.authToken, signature, url, request.params)) {
      throw new TwilioSignatureError();
    }
    return request.params;
  }

  if (contentType === "application/json") {
    if (request.rawBody === undefined) {
      throw new Error("Twilio JSON webhook raw body is required.");
    }
    if (!twilio.validateRequestWithBody(auth.authToken, signature, url, request.rawBody)) {
      throw new TwilioSignatureError();
    }
    return jsonObject(request.rawBody);
  }

  throw new Error(`Twilio webhook has unsupported content type "${contentType ?? ""}".`);
}

export function handleTwilioInboundWebhook(
  request: TwilioWebhookRequest,
  auth: TwilioWebhookAuth,
): TwilioInboundWebhookEvent {
  const params = validateTwilioWebhook(request, auth);
  const accountSid = requiredParam(params, "AccountSid");
  if (accountSid !== auth.accountSid) {
    throw new Error("Twilio webhook AccountSid does not match this practice configuration.");
  }
  const candidateOptOutType = optionalParam(params, "OptOutType");
  if (
    candidateOptOutType
    && candidateOptOutType !== "STOP"
    && candidateOptOutType !== "START"
    && candidateOptOutType !== "HELP"
  ) {
    throw new Error("Twilio inbound webhook OptOutType is invalid.");
  }
  const optOutType = candidateOptOutType as "STOP" | "START" | "HELP" | undefined;
  return {
    accountSid,
    messageSid: requiredParam(params, "MessageSid"),
    from: e164(requiredParam(params, "From"), "Twilio inbound sender"),
    to: e164(requiredParam(params, "To"), "Twilio inbound recipient"),
    body: requiredParam(params, "Body"),
    ...(optOutType ? { optOutType } : {}),
  };
}

export function handleTwilioStatusWebhook(
  request: TwilioWebhookRequest,
  auth: TwilioWebhookAuth,
): TwilioStatusWebhookEvent {
  const params = validateTwilioWebhook(request, auth);
  const accountSid = requiredParam(params, "AccountSid");
  if (accountSid !== auth.accountSid) {
    throw new Error("Twilio webhook AccountSid does not match this practice configuration.");
  }
  const errorCode = optionalParam(params, "ErrorCode");
  return {
    accountSid,
    messageSid: requiredParam(params, "MessageSid"),
    messageStatus: requiredParam(params, "MessageStatus"),
    ...(errorCode ? { errorCode } : {}),
    recipientOptedOut: errorCode === "21610",
  };
}

export function handleTwilioVoiceWebhook(
  request: TwilioWebhookRequest,
  auth: TwilioWebhookAuth,
): TwilioVoiceWebhookEvent {
  const params = validateTwilioWebhook(request, auth);
  const accountSid = matchingAccountSid(params, auth);
  const direction = requiredParam(params, "Direction");
  if (direction !== "inbound" && direction !== "outbound-api" && direction !== "outbound-dial") {
    throw new Error("Twilio Voice webhook Direction is invalid.");
  }
  const status = requiredParam(params, "CallStatus");
  if (!CALL_STATUSES.has(status)) {
    throw new Error("Twilio Voice webhook CallStatus is invalid.");
  }
  const callerName = optionalParam(params, "CallerName");
  const sequenceNumber = optionalInteger(
    optionalParam(params, "SequenceNumber"),
    "Twilio Voice SequenceNumber",
  );
  const durationSeconds = optionalInteger(
    optionalParam(params, "CallDuration"),
    "Twilio Voice CallDuration",
  );
  const recordingId = optionalParam(params, "RecordingSid");
  return {
    accountSid,
    callId: twilioSid(requiredParam(params, "CallSid"), "CA", "Twilio Voice CallSid"),
    from: voiceAddress(requiredParam(params, "From"), "Twilio Voice caller"),
    to: voiceAddress(requiredParam(params, "To"), "Twilio Voice recipient"),
    direction,
    status: status as TwilioVoiceWebhookEvent["status"],
    ...(callerName ? { callerName } : {}),
    ...(sequenceNumber !== undefined ? { sequenceNumber } : {}),
    ...(durationSeconds !== undefined ? { durationSeconds } : {}),
    ...(recordingId ? { recordingId: twilioSid(recordingId, "RE", "Twilio RecordingSid") } : {}),
  };
}

export function handleTwilioRecordingWebhook(
  request: TwilioWebhookRequest,
  auth: TwilioWebhookAuth,
): TwilioRecordingWebhookEvent {
  const params = validateTwilioWebhook(request, auth);
  const accountSid = matchingAccountSid(params, auth);
  const status = requiredParam(params, "RecordingStatus");
  if (status !== "in-progress" && status !== "completed" && status !== "absent") {
    throw new Error("Twilio recording webhook RecordingStatus is invalid.");
  }
  const durationSeconds = optionalInteger(
    optionalParam(params, "RecordingDuration"),
    "Twilio recording duration",
  );
  const channels = optionalInteger(
    optionalParam(params, "RecordingChannels"),
    "Twilio recording channels",
  );
  return {
    accountSid,
    callId: twilioSid(requiredParam(params, "CallSid"), "CA", "Twilio recording CallSid"),
    recordingId: twilioSid(requiredParam(params, "RecordingSid"), "RE", "Twilio RecordingSid"),
    status,
    ...(durationSeconds !== undefined ? { durationSeconds } : {}),
    ...(channels !== undefined ? { channels } : {}),
  };
}

export function handleTwilioTranscriptionWebhook(
  request: TwilioWebhookRequest,
  auth: TwilioWebhookAuth,
): TwilioTranscriptionWebhookEvent {
  const params = validateTwilioWebhook(request, auth);
  const accountSid = matchingAccountSid(params, auth);
  const event = requiredParam(params, "TranscriptionEvent");
  if (!TRANSCRIPTION_EVENTS.has(event)) {
    throw new Error("Twilio Real-Time Transcription webhook event is invalid.");
  }
  const timestamp = requiredParam(params, "Timestamp");
  if (Number.isNaN(Date.parse(timestamp))) {
    throw new Error("Twilio Real-Time Transcription Timestamp is invalid.");
  }
  const sequenceId = optionalInteger(
    requiredParam(params, "SequenceId"),
    "Twilio Real-Time Transcription SequenceId",
  )!;
  const base = {
    accountSid,
    callId: twilioSid(requiredParam(params, "CallSid"), "CA", "Twilio transcription CallSid"),
    transcriptionId: twilioSid(
      requiredParam(params, "TranscriptionSid"),
      "GT",
      "Twilio TranscriptionSid",
    ),
    event: event as TwilioTranscriptionWebhookEvent["event"],
    timestamp,
    sequenceId,
  };
  if (event !== "transcription-content") return base;

  const track = requiredParam(params, "Track");
  if (track !== "inbound_track" && track !== "outbound_track") {
    throw new Error("Twilio Real-Time Transcription Track is invalid.");
  }
  const final = requiredParam(params, "Final");
  if (final !== "true" && final !== "false") {
    throw new Error("Twilio Real-Time Transcription Final is invalid.");
  }
  const data = jsonObject(requiredParam(params, "TranscriptionData"));
  const text = requiredJsonText(data.transcript, "transcript");
  const confidence = data.confidence;
  if (
    confidence !== undefined
    && (typeof confidence !== "number" || !Number.isFinite(confidence) || confidence < 0 || confidence > 1)
  ) {
    throw new Error("Twilio Real-Time Transcription confidence is invalid.");
  }
  return {
    ...base,
    languageCode: requiredParam(params, "LanguageCode"),
    track,
    text,
    ...(confidence !== undefined ? { confidence } : {}),
    final: final === "true",
  };
}

function validateTwilioConfig(config: TwilioAdapterConfig) {
  const accountSid = sid(config.accountSid, "AC", "Twilio Account SID");
  const authToken = required(config.authToken, "Twilio Auth Token");
  const apiKeySid = config.apiKeySid?.trim()
    ? sid(config.apiKeySid, "SK", "Twilio API Key SID")
    : undefined;
  const apiKeySecret = config.apiKeySecret?.trim() || undefined;
  if (Boolean(apiKeySid) !== Boolean(apiKeySecret)) {
    throw new Error("Twilio API Key SID and secret must be configured together.");
  }
  const messagingServiceSid = config.messagingServiceSid?.trim()
    ? sid(config.messagingServiceSid, "MG", "Twilio Messaging Service SID")
    : undefined;
  const fromNumber = config.fromNumber?.trim()
    ? config.hipaaMode
      ? usE164(e164(config.fromNumber, "Twilio from-number"), "Twilio from-number")
      : e164(config.fromNumber, "Twilio from-number")
    : undefined;
  if (!messagingServiceSid && !fromNumber) {
    throw new Error("Twilio requires TWILIO_MESSAGING_SERVICE_SID or TWILIO_FROM_NUMBER.");
  }
  const webhookBaseUrl = config.webhookBaseUrl?.trim()
    ? externalBaseUrl(config.webhookBaseUrl)
    : undefined;
  const voiceValues = [
    config.voiceFromNumber,
    config.voiceForwardToNumber,
    config.voiceApiKeySid,
    config.voiceApiKeySecret,
  ];
  const configuredVoiceValues = voiceValues.filter((value) => value?.trim()).length;
  if (
    configuredVoiceValues !== 0
    && (configuredVoiceValues !== voiceValues.length || !webhookBaseUrl)
  ) {
    throw new Error(
      "Twilio Voice configuration is partial; Voice from/forward numbers, webhook base URL, and dedicated API key are required together.",
    );
  }
  const voice = configuredVoiceValues === voiceValues.length && webhookBaseUrl
    ? {
        fromNumber: config.hipaaMode
          ? usE164(e164(config.voiceFromNumber, "Twilio Voice from-number"), "Twilio Voice from-number")
          : e164(config.voiceFromNumber, "Twilio Voice from-number"),
        forwardToNumber: config.hipaaMode
          ? usE164(
              e164(config.voiceForwardToNumber, "Twilio Voice forward-to number"),
              "Twilio Voice forward-to number",
            )
          : e164(config.voiceForwardToNumber, "Twilio Voice forward-to number"),
        webhookBaseUrl,
        apiKeySid: sid(config.voiceApiKeySid, "SK", "Twilio Voice API Key SID"),
        apiKeySecret: required(config.voiceApiKeySecret, "Twilio Voice API Key secret"),
        realTimeTranscriptionEnabled: config.realTimeTranscriptionEnabled === true,
        mediaUrlAuthAcknowledged: config.mediaUrlAuthAcknowledged === true,
      }
    : undefined;
  return {
    accountSid,
    authToken,
    apiKeySid,
    apiKeySecret,
    messagingServiceSid,
    fromNumber,
    webhookBaseUrl,
    hipaaMode: config.hipaaMode === true,
    voice,
  };
}

const CALL_STATUSES = new Set([
  "queued",
  "initiated",
  "ringing",
  "in-progress",
  "completed",
  "busy",
  "failed",
  "no-answer",
  "canceled",
]);

const TRANSCRIPTION_EVENTS = new Set([
  "transcription-started",
  "transcription-content",
  "transcription-stopped",
  "transcription-error",
]);

function matchingAccountSid(
  params: Record<string, unknown>,
  auth: TwilioWebhookAuth,
): string {
  const accountSid = requiredParam(params, "AccountSid");
  if (accountSid !== auth.accountSid) {
    throw new Error("Twilio webhook AccountSid does not match this practice configuration.");
  }
  return accountSid;
}

function normalizeCall(call: TwilioCallRecord): CallDetail {
  const durationSeconds = optionalInteger(call.duration, "Twilio Call duration");
  return {
    id: twilioSid(call.sid, "CA", "Twilio Call SID"),
    from: voiceAddress(call.from, "Twilio Call from"),
    to: voiceAddress(call.to, "Twilio Call to"),
    status: required(call.status, "Twilio Call status"),
    direction: required(call.direction, "Twilio Call direction"),
    ...(call.startTime ? { startedAt: call.startTime.toISOString() } : {}),
    ...(call.endTime ? { endedAt: call.endTime.toISOString() } : {}),
    ...(durationSeconds !== undefined ? { durationSeconds } : {}),
  };
}

function requiredJsonText(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Twilio Real-Time Transcription ${label} is required.`);
  }
  return value.trim();
}

function twilioSid(value: string, prefix: "CA" | "GT" | "RE", label: string): string {
  const normalized = required(value, label);
  if (!new RegExp(`^${prefix}[0-9a-fA-F]{32}$`).test(normalized)) {
    throw new Error(`${label} must begin with ${prefix} followed by 32 hexadecimal characters.`);
  }
  return normalized;
}

function optionalInteger(value: string | undefined | null, label: string): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (!/^\d+$/.test(value)) throw new Error(`${label} must be a non-negative integer.`);
  return Number(value);
}

function voiceAddress(value: string, label: string): string {
  const normalized = required(value, label);
  if (normalized.length > 256) throw new Error(`${label} must not exceed 256 characters.`);
  return normalized.startsWith("+") ? e164(normalized, label) : normalized;
}

function smsBody(value: string): string {
  const body = required(value, "Twilio SMS body");
  return /\breply\s+stop\s+to\s+unsubscribe\b/i.test(body)
    ? body
    : `${body} ${TWILIO_OPT_OUT_LANGUAGE}`;
}

function externalBaseUrl(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("Twilio externalBaseUrl must be an HTTPS origin.");
  }
  if (
    parsed.protocol !== "https:"
    || parsed.username
    || parsed.password
    || parsed.pathname !== "/"
    || parsed.search
    || parsed.hash
  ) {
    throw new Error("Twilio externalBaseUrl must be an HTTPS origin.");
  }
  return parsed.origin;
}

function requestTarget(value: string): string {
  if (!value.startsWith("/") || value.startsWith("//") || value.includes("#")) {
    throw new Error("Twilio requestTarget must be an absolute path and query string.");
  }
  return value;
}

function jsonObject(rawBody: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    throw new Error("Twilio JSON webhook body must contain valid JSON.");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Twilio JSON webhook body must be an object.");
  }
  return parsed as Record<string, unknown>;
}

function requiredParam(params: Record<string, unknown>, name: string): string {
  const value = params[name];
  if (typeof value !== "string") {
    throw new Error(`Twilio webhook ${name} is required.`);
  }
  return required(value, `Twilio webhook ${name}`);
}

function optionalParam(params: Record<string, unknown>, name: string): string | undefined {
  const value = params[name];
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") {
    throw new Error(`Twilio webhook ${name} must be a string.`);
  }
  return value.trim() || undefined;
}

function required(value: string | undefined, label: string): string {
  const normalized = value?.trim() ?? "";
  if (!normalized) throw new Error(`${label} is required.`);
  return normalized;
}

function sid(value: string | undefined, prefix: "AC" | "MG" | "SK", label: string): string {
  const normalized = required(value, label);
  if (!new RegExp(`^${prefix}[0-9a-fA-F]{32}$`).test(normalized)) {
    throw new Error(`${label} must begin with ${prefix} followed by 32 hexadecimal characters.`);
  }
  return normalized;
}

function e164(value: string | undefined, label: string): string {
  const normalized = value?.trim() ?? "";
  if (!/^\+[1-9]\d{7,14}$/.test(normalized)) {
    throw new Error(`${label} must be in E.164 format.`);
  }
  return normalized;
}

function usE164(value: string, label: string): string {
  if (parsePhoneNumberFromString(value)?.country !== "US") {
    throw new Error(
      `${label} must be a 50-state/DC US phone number when ODOS_HIPAA_MODE is true; US territories are excluded.`,
    );
  }
  return value;
}
