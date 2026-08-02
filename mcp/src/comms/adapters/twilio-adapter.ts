import twilio from "twilio";
import type {
  CallDetail,
  CallListRequest,
  CallRecording,
  CallRequest,
  CallTranscription,
  CommsProvider,
  SendResult,
  SendSmsRequest,
} from "../comms-provider.js";

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
 * - Calls are created/read through the Calls resource; progress callbacks use the documented
 *   event set, and inbound calls receive TwiML:
 *   https://www.twilio.com/docs/voice/api/call-resource
 *   https://www.twilio.com/docs/voice/tutorials/how-to-respond-to-incoming-phone-calls
 * - Recording media uses the authenticated .mp3 Recording resource; current transcript fetches
 *   use the v3 Batch Transcription resource. Batch Transcription is Public Beta and explicitly
 *   not HIPAA eligible, so this adapter does not create transcription jobs automatically:
 *   https://www.twilio.com/docs/voice/api/recording
 *   https://www.twilio.com/docs/voice/api/batch-transcription-resource
 */

export const TWILIO_OPT_OUT_LANGUAGE = "Reply STOP to unsubscribe.";
export const TWILIO_REQUEST_TIMEOUT_MS = 30_000;

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
}

export type TwilioClientFactory = (
  username: string,
  password: string,
  options: Pick<TwilioClientOptions, "accountSid" | "timeout">,
) => TwilioSdkClient;

export interface TwilioAdapterDeps {
  clientFactory?: TwilioClientFactory;
  fetchImpl?: typeof fetch;
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

export function createTwilioAdapter(
  config: TwilioAdapterConfig,
  deps: TwilioAdapterDeps = {},
): CommsProvider {
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

  return {
    name: "twilio",
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
        const created = await messagingClient.messages.create({
          to: e164(request.toNumber, "Twilio SMS recipient"),
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

function voiceMethods(
  client: TwilioSdkClient,
  config: ReturnType<typeof validateTwilioConfig>,
  voice: NonNullable<ReturnType<typeof validateTwilioConfig>["voice"]>,
  fetchImpl: typeof fetch,
): Pick<
  CommsProvider,
  "initiateCall" | "getCall" | "listCalls" | "fetchRecording" | "fetchTranscription"
> {
  const calls = client.calls;
  const recordings = client.recordings;
  if (!calls || !recordings) {
    throw new Error("Twilio SDK client does not expose the Voice Calls and Recordings resources.");
  }
  const credentials = `${voice.apiKeySid}:${voice.apiKeySecret}`;
  const authorization = `Basic ${Buffer.from(credentials).toString("base64")}`;
  return {
    async initiateCall(request: CallRequest): Promise<{ callId: string }> {
      const patientNumber = e164(request.toNumber, "Twilio Voice recipient");
      const statusCallback = `${voice.webhookBaseUrl}/comms/twilio/voice/status`;
      const response = new twilio.twiml.VoiceResponse();
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
    async fetchRecording(recordingId: string): Promise<CallRecording> {
      const id = twilioSid(recordingId, "RE", "Twilio Recording SID");
      const metadata = await recordings.get(id).fetch();
      if (metadata.status !== "completed") {
        throw new Error(`Twilio Recording ${id} is not available; status is "${metadata.status}".`);
      }
      const media = await fetchImpl(
        `https://api.twilio.com/2010-04-01/Accounts/${config.accountSid}/Recordings/${id}.mp3`,
        { headers: { Authorization: authorization } },
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
    async fetchTranscription(transcriptionId: string): Promise<CallTranscription> {
      const id = batchTranscriptionId(transcriptionId);
      const response = await fetchImpl(`https://voice.twilio.com/v3/Transcriptions/${id}`, {
        headers: { Authorization: authorization },
      });
      if (!response.ok) {
        throw new Error(`Twilio Batch Transcription fetch failed with HTTP ${response.status}.`);
      }
      return batchTranscription(await response.json(), id);
    },
  };
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
      throw new Error("Twilio webhook X-Twilio-Signature validation failed.");
    }
    return request.params;
  }

  if (contentType === "application/json") {
    if (request.rawBody === undefined) {
      throw new Error("Twilio JSON webhook raw body is required.");
    }
    if (!twilio.validateRequestWithBody(auth.authToken, signature, url, request.rawBody)) {
      throw new Error("Twilio webhook X-Twilio-Signature validation failed.");
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
    ? e164(config.fromNumber, "Twilio from-number")
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
        fromNumber: e164(config.voiceFromNumber, "Twilio Voice from-number"),
        forwardToNumber: e164(config.voiceForwardToNumber, "Twilio Voice forward-to number"),
        webhookBaseUrl,
        apiKeySid: sid(config.voiceApiKeySid, "SK", "Twilio Voice API Key SID"),
        apiKeySecret: required(config.voiceApiKeySecret, "Twilio Voice API Key secret"),
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

function batchTranscription(value: unknown, expectedId: string): CallTranscription {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Twilio Batch Transcription response must be an object.");
  }
  const body = value as Record<string, unknown>;
  const operationId = requiredJsonString(body.operationId, "operationId");
  if (operationId !== expectedId) {
    throw new Error("Twilio Batch Transcription operationId does not match the requested id.");
  }
  const status = requiredJsonString(body.status, "status").toLowerCase();
  const transcription = body.transcription;
  if (transcription === null || transcription === undefined) return { id: expectedId, status };
  if (typeof transcription !== "object" || Array.isArray(transcription)) {
    throw new Error("Twilio Batch Transcription transcription must be an object.");
  }
  const detail = transcription as Record<string, unknown>;
  if (requiredJsonString(detail.id, "transcription.id") !== expectedId) {
    throw new Error("Twilio Batch Transcription id does not match the requested id.");
  }
  const sourceId = detail.sourceId === null || detail.sourceId === undefined
    ? undefined
    : twilioSid(
        requiredJsonString(detail.sourceId, "transcription.sourceId"),
        "RE",
        "Twilio Recording SID",
      );
  if (!Array.isArray(detail.sentences)) {
    throw new Error("Twilio Batch Transcription sentences must be an array.");
  }
  const text = detail.sentences.map((sentence, index) => {
    if (!sentence || typeof sentence !== "object" || Array.isArray(sentence)) {
      throw new Error(`Twilio Batch Transcription sentence ${index + 1} must be an object.`);
    }
    return requiredJsonString(
      (sentence as Record<string, unknown>).text,
      `sentence ${index + 1} text`,
    );
  }).join("\n");
  return {
    id: expectedId,
    ...(sourceId ? { recordingId: sourceId } : {}),
    status,
    ...(text ? { text } : {}),
  };
}

function requiredJsonString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Twilio Batch Transcription ${label} is required.`);
  }
  return value.trim();
}

function batchTranscriptionId(value: string): string {
  const normalized = required(value, "Twilio Batch Transcription id");
  if (!/^voice_transcription_[a-z0-9]+$/.test(normalized)) {
    throw new Error("Twilio Batch Transcription id is invalid.");
  }
  return normalized;
}

function twilioSid(value: string, prefix: "CA" | "RE", label: string): string {
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
