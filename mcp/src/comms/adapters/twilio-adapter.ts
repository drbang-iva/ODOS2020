import twilio from "twilio";
import type {
  CommsProvider,
  SendResult,
  SendSmsRequest,
} from "../comms-provider.js";

/**
 * Twilio Programmable Messaging send-only adapter.
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
}

type TwilioClientOptions = NonNullable<Parameters<typeof twilio>[2]>;
type TwilioMessageCreateInput = Parameters<ReturnType<typeof twilio>["messages"]["create"]>[0];

export interface TwilioSdkClient {
  messages: {
    create(input: TwilioMessageCreateInput): Promise<{ sid: string }>;
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

export function createTwilioAdapter(
  config: TwilioAdapterConfig,
  deps: TwilioAdapterDeps = {},
): CommsProvider {
  const normalized = validateTwilioConfig(config);
  const clientFactory = deps.clientFactory ?? ((username, password, options) => (
    twilio(username, password, options)
  ));
  const client = clientFactory(
    normalized.apiKeySid ?? normalized.accountSid,
    normalized.apiKeySecret ?? normalized.authToken,
    { accountSid: normalized.accountSid, timeout: TWILIO_REQUEST_TIMEOUT_MS },
  );

  return {
    name: "twilio",
    capabilities: {
      sms: true,
      calls: false,
      email: false,
      contacts: false,
      conversations: false,
      reviews: false,
    },
    async sendSms(request: SendSmsRequest): Promise<SendResult> {
      try {
        const created = await client.messages.create({
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
  return {
    accountSid,
    authToken,
    apiKeySid,
    apiKeySecret,
    messagingServiceSid,
    fromNumber,
  };
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
