import type { Application, Request, Response } from "express";
import express from "express";
import {
  handleFaxCallbackRequest,
  handleReferralFaxRequest,
  handleReferralFaxStatusRequest,
  type FaxEndpointDeps,
  type FaxEndpointResult,
} from "./fax-endpoint.js";

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
