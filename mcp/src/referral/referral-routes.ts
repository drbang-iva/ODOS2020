import type { Application, Request, Response } from "express";
import {
  handleConsultArtifactRequest,
  handleCreateInboundReferralRequest,
  handleCreateReferralRequest,
  handleApplyReferralTemplateRequest,
  handleListCorrespondenceTemplatesRequest,
  handleListInboundReferralsRequest,
  handleProviderSignatureRequest,
  handleReferralArtifactRequest,
  handleRecentReferralConsultantsRequest,
  handleRegenerateReferralLetterRequest,
  handleReadReferralDefaultsRequest,
  handleSearchReferralConsultantsRequest,
  handleSaveReferralDefaultsRequest,
  handleUpdateReferralDraftRequest,
  type ReferralEndpointDeps,
  type ReferralEndpointResult,
} from "./referral-endpoint.js";

export interface ReferralRouteDeps extends ReferralEndpointDeps {
  authenticateService(): Promise<void>;
}

export function registerReferralRoutes(
  app: Pick<Application, "get" | "patch" | "post" | "put">,
  deps: ReferralRouteDeps,
): void {
  app.get("/referrals/consultants/recent", async (req, res) => route(
    "/referrals/consultants/recent",
    deps,
    req,
    res,
    () => handleRecentReferralConsultantsRequest(deps, {
      authHeader: req.header("authorization"),
    }),
  ));
  app.get("/correspondence/templates", async (req, res) => route(
    "/correspondence/templates",
    deps,
    req,
    res,
    () => handleListCorrespondenceTemplatesRequest(deps, {
      authHeader: req.header("authorization"),
      letterType: req.query.letterType,
    }),
  ));
  app.get("/referrals/consultants", async (req, res) => route(
    "/referrals/consultants",
    deps,
    req,
    res,
    () => handleSearchReferralConsultantsRequest(deps, {
      authHeader: req.header("authorization"),
      query: req.query.q,
    }),
  ));
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
  post(app, "/correspondence/inbound-referrals/patients/:patientId", deps, (req) =>
    handleCreateInboundReferralRequest(deps, {
      authHeader: req.header("authorization"),
      patientId: routeParam(req.params.patientId),
      body: req.body,
    }));
  app.get("/correspondence/inbound-referrals/patients/:patientId", async (req, res) => route(
    "/correspondence/inbound-referrals/patients/:patientId",
    deps,
    req,
    res,
    () => handleListInboundReferralsRequest(deps, {
      authHeader: req.header("authorization"),
      patientId: routeParam(req.params.patientId),
    }),
  ));
  app.get("/correspondence/providers/:providerId/signature", async (req, res) => route(
    "/correspondence/providers/:providerId/signature",
    deps,
    req,
    res,
    () => handleProviderSignatureRequest(deps, {
      authHeader: req.header("authorization"),
      providerId: routeParam(req.params.providerId),
      action: "read",
    }),
  ));
  app.put("/correspondence/providers/:providerId/signature", async (req, res) => route(
    "/correspondence/providers/:providerId/signature",
    deps,
    req,
    res,
    () => handleProviderSignatureRequest(deps, {
      authHeader: req.header("authorization"),
      providerId: routeParam(req.params.providerId),
      action: "set",
      body: req.body,
    }),
  ));
  post(app, "/correspondence/providers/:providerId/signature/clear", deps, (req) =>
    handleProviderSignatureRequest(deps, {
      authHeader: req.header("authorization"),
      providerId: routeParam(req.params.providerId),
      action: "clear",
    }));
  app.patch("/referrals/patients/:patientId/:referralId", async (req, res) => route(
    "/referrals/patients/:patientId/:referralId",
    deps,
    req,
    res,
    () => handleUpdateReferralDraftRequest(deps, {
      authHeader: req.header("authorization"),
      patientId: routeParam(req.params.patientId),
      referralId: routeParam(req.params.referralId),
      body: req.body,
    }),
  ));
  post(app, "/referrals/patients/:patientId/:referralId/regenerate", deps, (req) =>
    handleRegenerateReferralLetterRequest(deps, {
      authHeader: req.header("authorization"),
      patientId: routeParam(req.params.patientId),
      referralId: routeParam(req.params.referralId),
    }));
  post(app, "/referrals/patients/:patientId/:referralId/apply-template", deps, (req) =>
    handleApplyReferralTemplateRequest(deps, {
      authHeader: req.header("authorization"),
      patientId: routeParam(req.params.patientId),
      referralId: routeParam(req.params.referralId),
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
  for (const action of ["preview", "sign", "send"] as const) {
    post(
      app,
      `/correspondence/inbound-referrals/patients/:patientId/:referralId/${action}`,
      deps,
      (req) => handleConsultArtifactRequest(deps, {
        authHeader: req.header("authorization"),
        patientId: routeParam(req.params.patientId),
        referralId: routeParam(req.params.referralId),
        action,
        body: req.body,
      }),
    );
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
