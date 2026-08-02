import type { Application, Request, Response } from "express";
import twilio from "twilio";
import {
  handleTwilioInboundWebhook,
  handleTwilioRecordingWebhook,
  handleTwilioStatusWebhook,
  handleTwilioVoiceWebhook,
  type TwilioInboundWebhookEvent,
  type TwilioRecordingWebhookEvent,
  type TwilioStatusWebhookEvent,
  type TwilioVoiceWebhookEvent,
  type TwilioWebhookAuth,
} from "./adapters/twilio-adapter.js";

type TwilioWebhookKind =
  | "sms-inbound"
  | "sms-status"
  | "voice-inbound"
  | "voice-status"
  | "voice-recording";

type TwilioWebhookEvent =
  | TwilioInboundWebhookEvent
  | TwilioStatusWebhookEvent
  | TwilioVoiceWebhookEvent
  | TwilioRecordingWebhookEvent;

export interface TwilioWebhookRouteDeps {
  auth: TwilioWebhookAuth;
  voiceFromNumber?: string;
  voiceForwardToNumber?: string;
  onEvent?(kind: TwilioWebhookKind, event: TwilioWebhookEvent): void | Promise<void>;
}

export function registerTwilioWebhookRoutes(
  app: Pick<Application, "post">,
  deps: TwilioWebhookRouteDeps,
): void {
  app.post("/comms/twilio/inbound", async (req, res) => {
    await webhookRoute(req, res, deps, "sms-inbound", () =>
      handleTwilioInboundWebhook(webhookRequest(req), deps.auth));
  });
  app.post("/comms/twilio/status", async (req, res) => {
    await webhookRoute(req, res, deps, "sms-status", () =>
      handleTwilioStatusWebhook(webhookRequest(req), deps.auth));
  });
  app.post("/comms/twilio/voice/inbound", async (req, res) => {
    await webhookRoute(req, res, deps, "voice-inbound", () => {
      const event = handleTwilioVoiceWebhook(webhookRequest(req), deps.auth);
      const forwardTo = deps.voiceForwardToNumber;
      if (!forwardTo || !deps.voiceFromNumber) {
        throw new TwilioRouteConfigurationError();
      }
      const response = new twilio.twiml.VoiceResponse();
      const dial = response.dial({ answerOnBridge: true });
      dial.number({
        statusCallback: `${deps.auth.externalBaseUrl}/comms/twilio/voice/status`,
        statusCallbackMethod: "POST",
        statusCallbackEvent: ["initiated", "ringing", "answered", "completed"],
      }, forwardTo);
      res.type("text/xml").status(200).send(response.toString());
      return event;
    });
  });
  app.post("/comms/twilio/voice/status", async (req, res) => {
    await webhookRoute(req, res, deps, "voice-status", () =>
      handleTwilioVoiceWebhook(webhookRequest(req), deps.auth));
  });
  app.post("/comms/twilio/voice/recording", async (req, res) => {
    await webhookRoute(req, res, deps, "voice-recording", () =>
      handleTwilioRecordingWebhook(webhookRequest(req), deps.auth));
  });
}

async function webhookRoute(
  req: Request,
  res: Response,
  deps: TwilioWebhookRouteDeps,
  kind: TwilioWebhookKind,
  handle: () => TwilioWebhookEvent,
): Promise<void> {
  try {
    const event = handle();
    await deps.onEvent?.(kind, event);
    if (!res.headersSent) res.sendStatus(204);
  } catch (error) {
    if (res.headersSent) return;
    if (error instanceof TwilioRouteConfigurationError) {
      res.status(503).json({ error: "Twilio Voice routing is not configured." });
      return;
    }
    const message = error instanceof Error ? error.message : "";
    if (message.includes("X-Twilio-Signature")) {
      res.status(403).json({ error: "Twilio webhook signature validation failed." });
      return;
    }
    res.status(400).json({ error: "Twilio webhook payload is invalid." });
  }
}

function webhookRequest(req: Request) {
  return {
    requestTarget: req.originalUrl,
    contentType: req.header("content-type"),
    params: formParams(req.body),
    signature: req.header("x-twilio-signature"),
  };
}

function formParams(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Twilio form webhook body must be an object.");
  }
  const params: Record<string, string> = {};
  for (const [name, field] of Object.entries(value)) {
    if (typeof field !== "string") {
      throw new Error(`Twilio form webhook ${name} must be a string.`);
    }
    params[name] = field;
  }
  return params;
}

class TwilioRouteConfigurationError extends Error {}
