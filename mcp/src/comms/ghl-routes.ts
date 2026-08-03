import express, { type Application, type Request, type Response } from "express";
import {
  GhlSignatureError,
  handleGhlInboundWebhook,
  type GhlInboundWebhookEvent,
  type GhlWebhookAuth,
} from "./adapters/ghl-adapter.js";

export interface GhlWebhookRouteDeps {
  auth: GhlWebhookAuth;
  onEvent?(event: GhlInboundWebhookEvent): void | Promise<void>;
}

export function registerGhlWebhookRoutes(
  app: Pick<Application, "post">,
  deps: GhlWebhookRouteDeps,
): void {
  app.post(
    "/comms/ghl/inbound",
    express.raw({ type: "application/json", limit: "1mb" }),
    async (req, res) => webhookRoute(req, res, deps),
  );
}

async function webhookRoute(
  req: Request,
  res: Response,
  deps: GhlWebhookRouteDeps,
): Promise<void> {
  let event: GhlInboundWebhookEvent;
  try {
    if (!Buffer.isBuffer(req.body)) throw new Error("GHL webhook body must be raw JSON bytes.");
    event = handleGhlInboundWebhook(
      req.body.toString("utf8"),
      req.header("x-ghl-signature"),
      deps.auth,
    );
  } catch (error) {
    if (error instanceof GhlSignatureError) {
      console.error("odos-mcp: GHL inbound webhook signature rejected.");
      res.status(403).json({ error: "GHL webhook signature validation failed." });
      return;
    }
    console.error("odos-mcp: GHL inbound webhook rejected.");
    res.status(400).json({ error: "GHL webhook payload is invalid." });
    return;
  }
  try {
    await deps.onEvent?.(event);
  } catch {
    console.error("odos-mcp: GHL inbound webhook handler failed.");
    res.status(500).json({ error: "GHL webhook handling failed." });
    return;
  }
  res.sendStatus(204);
}
