import type { Application, Request, Response } from "express";
import express from "express";
import {
  handleFaxCallbackRequest,
  handleReferralFaxRequest,
  handleReferralFaxStatusRequest,
  type FaxEndpointDeps,
  type FaxEndpointResult,
} from "./fax-endpoint.js";
import {
  handleInboundFaxActionRequest,
  handleInboundFaxDocumentRequest,
} from "./inbound-fax-endpoint.js";

export interface FaxRouteDeps extends FaxEndpointDeps {
  authenticateService(): Promise<void>;
}

export function registerFaxRoutes(
  app: Pick<Application, "get" | "post">,
  deps: FaxRouteDeps,
): void {
  app.post(
    "/fax/referrals/:patientId/:referralId",
    express.raw({ type: "application/pdf", limit: "25mb" }),
    async (req, res) => route("/fax/referrals/:patientId/:referralId", deps, res, () =>
      handleReferralFaxRequest(deps, {
        authHeader: req.header("authorization"),
        patientId: routeParam(req.params.patientId),
        referralId: routeParam(req.params.referralId),
        destinationNumber: req.header("x-odos-fax-destination"),
        billingCode: req.header("x-odos-billing-code"),
        filename: req.header("x-odos-filename"),
        document: req.body,
      })),
  );
  app.get("/fax/referrals/:patientId/:referralId/status", async (req, res) =>
    route("/fax/referrals/:patientId/:referralId/status", deps, res, () =>
      handleReferralFaxStatusRequest(deps, {
        authHeader: req.header("authorization"),
        patientId: routeParam(req.params.patientId),
        referralId: routeParam(req.params.referralId),
      })));
  app.post("/fax/callback/:recordId", async (req, res) =>
    route("/fax/callback/:recordId", deps, res, () =>
      handleFaxCallbackRequest(deps, {
        recordId: routeParam(req.params.recordId),
        callbackToken: queryParam(req.query.token),
        body: req.body,
      })));
  for (const action of ["attach", "promote", "inbox"] as const) {
    app.post(`/fax/inbound/:faxId/${action}`, async (req, res) =>
      route(`/fax/inbound/:faxId/${action}`, deps, res, () =>
        handleInboundFaxActionRequest(deps, {
          authHeader: req.header("authorization"),
          faxId: routeParam(req.params.faxId),
          action,
          body: req.body,
        })));
  }
  app.get("/fax/inbound/:faxId/document", async (req, res) => {
    try {
      await deps.authenticateService();
      const result = await handleInboundFaxDocumentRequest(deps, {
        authHeader: req.header("authorization"),
        faxId: routeParam(req.params.faxId),
      });
      if (result.status !== 200 || !result.dataBase64 || !result.contentType) {
        res.status(result.status).json(result.body);
        return;
      }
      res.status(200);
      res.header("Content-Type", result.contentType);
      res.header("X-Content-Type-Options", "nosniff");
      res.header("Content-Security-Policy", "default-src 'none'; object-src 'none'; sandbox");
      res.header(
        "Content-Disposition",
        `inline; filename="${safeFilename(result.filename ?? "inbound-fax.pdf")}"`,
      );
      res.send(Buffer.from(result.dataBase64, "base64"));
    } catch (error) {
      console.error("odos-mcp: /fax/inbound/:faxId/document failed:", error);
      if (!res.headersSent) res.status(500).json({ error: "inbound fax document route failed" });
    }
  });
}

async function route(
  path: string,
  deps: FaxRouteDeps,
  res: Response,
  dispatch: () => Promise<FaxEndpointResult>,
): Promise<void> {
  try {
    await deps.authenticateService();
    const result = await dispatch();
    res.status(result.status).json(result.body);
  } catch (error) {
    console.error(`odos-mcp: ${path} failed:`, error);
    if (!res.headersSent) res.status(500).json({ error: "fax route failed" });
  }
}

function routeParam(value: string | string[]): string {
  return Array.isArray(value) ? value[0] ?? "" : value;
}

function queryParam(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function safeFilename(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 180) || "inbound-fax.pdf";
}
