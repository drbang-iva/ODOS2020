import { createHmac, timingSafeEqual } from "node:crypto";
import type {
  CommsProvider,
  SendResult,
  SendSmsRequest,
} from "../comms-provider.js";

/**
 * Twilio Programmable Messaging send-only adapter.
 *
 * Verified 2026-08-01 against Twilio's current primary documentation:
 * - Create an outbound Message with form-encoded POST
 *   /2010-04-01/Accounts/{AccountSid}/Messages.json. To, a sender (From or
 *   MessagingServiceSid), and content are required:
 *   https://www.twilio.com/docs/messaging/api/message-resource
 * - Twilio uses HTTP Basic authentication and recommends API keys for production. Account
 *   SID + Auth Token remains supported, while the Auth Token is also required to validate
 *   webhook signatures:
 *   https://www.twilio.com/docs/messaging/api
 *   https://www.twilio.com/docs/usage/requests-to-twilio
 * - Twilio blocks future sends after STOP and reports an attempted send as error 21610;
 *   START removes the block:
 *   https://www.twilio.com/docs/messaging/tutorials/advanced-opt-out
 *   https://www.twilio.com/docs/api/errors/21610
 * - Inbound and status webhooks are form-encoded and must be validated from the exact URL
 *   plus every received parameter before any payload field is trusted:
 *   https://www.twilio.com/docs/usage/security
 *   https://www.twilio.com/docs/usage/webhooks/webhooks-security
 */

export const TWILIO_API_BASE_URL = "https://api.twilio.com";
export const TWILIO_OPT_OUT_LANGUAGE = "Reply STOP to unsubscribe.";
export const TWILIO_REQUEST_TIMEOUT_MS = 30_000;

export interface TwilioAdapterConfig {
  accountSid: string;
  authToken: string;
  apiKeySid?: string;
  apiKeySecret?: string;
  messagingServiceSid?: string;
  fromNumber?: string;
  baseUrl?: string;
}

export interface TwilioAdapterDeps {
  fetchImpl?: typeof fetch;
}

interface TwilioMessageResponse {
  sid?: unknown;
  code?: unknown;
  message?: unknown;
}

export interface TwilioWebhookRequest {
  url: string;
  params: Record<string, string>;
  signature: string | undefined;
}

export interface TwilioWebhookAuth {
  accountSid: string;
  authToken: string;
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
  const fetchImpl = deps.fetchImpl ?? fetch;
  const username = normalized.apiKeySid ?? normalized.accountSid;
  const password = normalized.apiKeySecret ?? normalized.authToken;

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
      const toNumber = e164(request.toNumber, "Twilio SMS recipient");
      const body = smsBody(request.body);
      const form = new URLSearchParams({
        To: toNumber,
        Body: body,
        ...(normalized.messagingServiceSid
          ? { MessagingServiceSid: normalized.messagingServiceSid }
          : { From: normalized.fromNumber! }),
      });
      const controller = new AbortController();
      let timedOut = false;
      const timeout = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, TWILIO_REQUEST_TIMEOUT_MS);
      try {
        const response = await fetchImpl(
          `${normalized.baseUrl}/2010-04-01/Accounts/${normalized.accountSid}/Messages.json`,
          {
            method: "POST",
            headers: {
              Authorization: `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`,
              "Content-Type": "application/x-www-form-urlencoded",
            },
            body: form.toString(),
            signal: controller.signal,
          },
        );
        const parsed = await twilioJson(response);
        if (twilioErrorCode(parsed.code) === 21610) {
          return { outcome: "suppressed", reason: "patient-opt-out" };
        }
        if (!response.ok || typeof parsed.sid !== "string") {
          const detail = typeof parsed.message === "string"
            ? parsed.message
            : "provider response did not include a usable error";
          throw new Error(`Twilio SMS send failed (HTTP ${response.status}): ${detail}`);
        }
        return { outcome: "sent", providerMessageId: parsed.sid };
      } catch (error) {
        if (timedOut && error instanceof Error && error.name === "AbortError") {
          throw new Error("Twilio request timed out after 30 seconds.");
        }
        throw error;
      } finally {
        clearTimeout(timeout);
      }
    },
  };
}

export function handleTwilioInboundWebhook(
  request: TwilioWebhookRequest,
  auth: TwilioWebhookAuth,
): TwilioInboundWebhookEvent {
  validateWebhook(request, auth);
  const accountSid = requiredParam(request.params, "AccountSid");
  if (accountSid !== auth.accountSid) {
    throw new Error("Twilio webhook AccountSid does not match this practice configuration.");
  }
  const candidateOptOutType = request.params.OptOutType;
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
    messageSid: requiredParam(request.params, "MessageSid"),
    from: e164(requiredParam(request.params, "From"), "Twilio inbound sender"),
    to: e164(requiredParam(request.params, "To"), "Twilio inbound recipient"),
    body: requiredParam(request.params, "Body"),
    ...(optOutType ? { optOutType } : {}),
  };
}

export function handleTwilioStatusWebhook(
  request: TwilioWebhookRequest,
  auth: TwilioWebhookAuth,
): TwilioStatusWebhookEvent {
  validateWebhook(request, auth);
  const accountSid = requiredParam(request.params, "AccountSid");
  if (accountSid !== auth.accountSid) {
    throw new Error("Twilio webhook AccountSid does not match this practice configuration.");
  }
  const errorCode = request.params.ErrorCode?.trim() || undefined;
  return {
    accountSid,
    messageSid: requiredParam(request.params, "MessageSid"),
    messageStatus: requiredParam(request.params, "MessageStatus"),
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
    baseUrl: secureBaseUrl(config.baseUrl ?? TWILIO_API_BASE_URL),
  };
}

function smsBody(value: string): string {
  const body = required(value, "Twilio SMS body");
  return /\breply\s+stop\s+to\s+unsubscribe\b/i.test(body)
    ? body
    : `${body} ${TWILIO_OPT_OUT_LANGUAGE}`;
}

function validateWebhook(request: TwilioWebhookRequest, auth: TwilioWebhookAuth): void {
  const expected = twilioSignature(request.url, request.params, auth.authToken);
  const actual = request.signature ?? "";
  const expectedBytes = Buffer.from(expected);
  const actualBytes = Buffer.from(actual);
  if (
    expectedBytes.length !== actualBytes.length
    || !timingSafeEqual(expectedBytes, actualBytes)
  ) {
    throw new Error("Twilio webhook X-Twilio-Signature validation failed.");
  }
}

function twilioSignature(
  url: string,
  params: Record<string, string>,
  authToken: string,
): string {
  const signed = Object.keys(params)
    .sort()
    .reduce((value, key) => `${value}${key}${params[key]}`, url);
  return createHmac("sha1", authToken).update(signed).digest("base64");
}

function requiredParam(params: Record<string, string>, name: string): string {
  return required(params[name], `Twilio webhook ${name}`);
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

function secureBaseUrl(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("Twilio baseUrl must be a valid HTTPS URL.");
  }
  if (parsed.protocol !== "https:") {
    throw new Error("Twilio baseUrl must be a valid HTTPS URL.");
  }
  return value.replace(/\/$/, "");
}

async function twilioJson(response: Response): Promise<TwilioMessageResponse> {
  const text = await response.text();
  try {
    return JSON.parse(text) as TwilioMessageResponse;
  } catch {
    throw new Error(`Twilio returned HTTP ${response.status} with a non-JSON response.`);
  }
}

function twilioErrorCode(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isInteger(value)) return value;
  if (typeof value === "string" && /^\d+$/.test(value)) return Number(value);
  return undefined;
}
