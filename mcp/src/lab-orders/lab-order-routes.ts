import type { Application, Request, Response } from "express";
import {
  handleAdvanceLabOrderRequest,
  handleCancelLabOrderRequest,
  handleFlagLabOrderProblemRequest,
  handleLabOrderSheetRequest,
  handleLabOrderStateRequest,
  handleLabOrderWorklistRequest,
  handleResolveLabOrderProblemRequest,
  handleSetLabOrderStatusRequest,
  handleSubmitLabOrderRequest,
  type LabOrderHandlerDeps,
  type LabOrderHandlerResult,
} from "./lab-order-handlers.js";

export interface LabOrderRouteDeps {
  authenticateService(): Promise<void>;
  handlers: LabOrderHandlerDeps;
}

export function registerLabOrderRoutes(
  app: Pick<Application, "get" | "post">,
  deps: LabOrderRouteDeps,
): void {
  post(app, "/lab-orders/submit", deps, (req) => handleSubmitLabOrderRequest(deps.handlers, {
    authHeader: req.header("authorization"),
    body: req.body,
  }));
  post(app, "/lab-orders/:ref/advance", deps, (req) => handleAdvanceLabOrderRequest(deps.handlers, {
    authHeader: req.header("authorization"),
    labOrderReference: routeParam(req.params.ref),
    body: req.body,
  }));
  post(app, "/lab-orders/:ref/cancel", deps, (req) => handleCancelLabOrderRequest(deps.handlers, {
    authHeader: req.header("authorization"),
    labOrderReference: routeParam(req.params.ref),
    body: req.body,
  }));
  post(app, "/lab-orders/:ref/status", deps, (req) => handleSetLabOrderStatusRequest(deps.handlers, {
    authHeader: req.header("authorization"),
    labOrderReference: routeParam(req.params.ref),
    body: req.body,
  }));
  post(app, "/lab-orders/:ref/flags", deps, (req) => handleFlagLabOrderProblemRequest(deps.handlers, {
    authHeader: req.header("authorization"),
    labOrderReference: routeParam(req.params.ref),
    body: req.body,
  }));
  post(app, "/lab-orders/:ref/flags/:flagId/resolve", deps, (req) => handleResolveLabOrderProblemRequest(deps.handlers, {
    authHeader: req.header("authorization"),
    labOrderReference: routeParam(req.params.ref),
    flagId: routeParam(req.params.flagId),
  }));
  get(app, "/lab-orders/:ref/state", deps, (req) => handleLabOrderStateRequest(deps.handlers, {
    authHeader: req.header("authorization"),
    labOrderReference: routeParam(req.params.ref),
    vendor: stringQuery(req.query.vendor),
  }));
  get(app, "/lab-orders/:ref/sheet", deps, (req) => handleLabOrderSheetRequest(deps.handlers, {
    authHeader: req.header("authorization"),
    labOrderReference: routeParam(req.params.ref),
  }));
  get(app, "/lab-orders", deps, (req) => handleLabOrderWorklistRequest(deps.handlers, {
    authHeader: req.header("authorization"),
    state: stringQuery(req.query.state),
  }));
}

function post(
  app: Pick<Application, "post">,
  path: string,
  deps: LabOrderRouteDeps,
  dispatch: (req: Request) => Promise<LabOrderHandlerResult>,
): void {
  app.post(path, async (req, res) => route(path, deps, req, res, dispatch));
}

function get(
  app: Pick<Application, "get">,
  path: string,
  deps: LabOrderRouteDeps,
  dispatch: (req: Request) => Promise<LabOrderHandlerResult>,
): void {
  app.get(path, async (req, res) => route(path, deps, req, res, dispatch));
}

async function route(
  path: string,
  deps: LabOrderRouteDeps,
  req: Request,
  res: Response,
  dispatch: (req: Request) => Promise<LabOrderHandlerResult>,
): Promise<void> {
  try {
    await deps.authenticateService();
    const result = await dispatch(req);
    res.status(result.status).json(result.body);
  } catch (error) {
    console.error(`osod-mcp: ${path} failed:`, error);
    if (!res.headersSent) res.status(500).json({ error: "lab-order route failed" });
  }
}

function stringQuery(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function routeParam(value: string | string[]): string {
  return Array.isArray(value) ? value[0] ?? "" : value;
}
