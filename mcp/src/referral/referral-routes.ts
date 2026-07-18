import type { Application, Request, Response } from "express";
import {
  handleCreateReferralRequest,
  handleReferralArtifactRequest,
  handleReadReferralDefaultsRequest,
  handleSaveReferralDefaultsRequest,
  type ReferralEndpointDeps,
  type ReferralEndpointResult,
} from "./referral-endpoint.js";

export interface ReferralRouteDeps extends ReferralEndpointDeps {
  authenticateService(): Promise<void>;
}

export function registerReferralRoutes(
  app: Pick<Application, "get" | "post" | "put">,
  deps: ReferralRouteDeps,
): void {
  app.get("/referrals/defaults", async (req, res) => route(
    "/referrals/defaults",
    deps,
    req,
    res,
    () => handleReadReferralDefaultsRequest(deps, {
      authHeader: req.header("authorization"),
    }),
  ));
  app.put("/referrals/defaults", async (req, res) => route(
    "/referrals/defaults",
    deps,
    req,
    res,
    () => handleSaveReferralDefaultsRequest(deps, {
      authHeader: req.header("authorization"),
      body: req.body,
    }),
  ));
  post(app, "/referrals/patients/:patientId", deps, (req) =>
    handleCreateReferralRequest(deps, {
      authHeader: req.header("authorization"),
      patientId: routeParam(req.params.patientId),
      body: req.body,
    }));
  for (const action of ["preview", "send"] as const) {
    post(app, `/referrals/patients/:patientId/:referralId/${action}`, deps, (req) =>
      handleReferralArtifactRequest(deps, {
        authHeader: req.header("authorization"),
        patientId: routeParam(req.params.patientId),
        referralId: routeParam(req.params.referralId),
        action,
        body: req.body,
      }));
  }
}

function post(
  app: Pick<Application, "post">,
  path: string,
  deps: ReferralRouteDeps,
  dispatch: (req: Request) => Promise<ReferralEndpointResult>,
): void {
  app.post(path, async (req, res) => route(path, deps, req, res, dispatch));
}

async function route(
  path: string,
  deps: ReferralRouteDeps,
  req: Request,
  res: Response,
  dispatch: (req: Request) => Promise<ReferralEndpointResult>,
): Promise<void> {
  try {
    await deps.authenticateService();
    const result = await dispatch(req);
    res.status(result.status).json(result.body);
  } catch (error) {
    console.error(`odos-mcp: ${path} failed:`, error);
    if (!res.headersSent) res.status(500).json({ error: "referral route failed" });
  }
}

function routeParam(value: string | string[]): string {
  return Array.isArray(value) ? value[0] ?? "" : value;
}
