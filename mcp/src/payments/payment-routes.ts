import type { Application, Request, Response } from "express";
import {
  handleApplyCreditRequest,
  handlePaymentReconciliationsRequest,
  handleTransferCreditRequest,
  handleUnappliedCreditsRequest,
  handleVoidCreditRequest,
  type PaymentCreditHandlerDeps,
} from "./payment-credit-handler.js";
import { handlePaymentMethodsRequest, type ChargeHandlerResult } from "./payment-charge-handler.js";

export interface PatientPaymentRouteDeps {
  authenticateService(): Promise<void>;
  handlers: PaymentCreditHandlerDeps;
}

export function registerPatientPaymentRoutes(
  app: Pick<Application, "get" | "post">,
  deps: PatientPaymentRouteDeps,
): void {
  get(app, "/payments/methods", deps, (req) => handlePaymentMethodsRequest(deps.handlers, {
    authHeader: req.header("authorization"),
  }));
  post(app, "/payments/credit/apply", deps, (req) => handleApplyCreditRequest(deps.handlers, {
    authHeader: req.header("authorization"),
    body: req.body,
  }));
  post(app, "/payments/credit/transfer", deps, (req) => handleTransferCreditRequest(deps.handlers, {
    authHeader: req.header("authorization"),
    body: req.body,
  }));
  post(app, "/payments/credit/void", deps, (req) => handleVoidCreditRequest(deps.handlers, {
    authHeader: req.header("authorization"),
    body: req.body,
  }));
  get(app, "/payments/credit/unapplied", deps, (req) => handleUnappliedCreditsRequest(deps.handlers, {
    authHeader: req.header("authorization"),
    patientReference: stringQuery(req.query.patientReference),
  }));
  get(app, "/payments/reconciliations", deps, (req) => handlePaymentReconciliationsRequest(deps.handlers, {
    authHeader: req.header("authorization"),
    query: req.query,
  }));
}

function post(
  app: Pick<Application, "post">,
  path: string,
  deps: PatientPaymentRouteDeps,
  dispatch: (req: Request) => Promise<ChargeHandlerResult>,
): void {
  app.post(path, async (req, res) => route(path, deps, req, res, dispatch));
}

function get(
  app: Pick<Application, "get">,
  path: string,
  deps: PatientPaymentRouteDeps,
  dispatch: (req: Request) => Promise<ChargeHandlerResult>,
): void {
  app.get(path, async (req, res) => route(path, deps, req, res, dispatch));
}

async function route(
  path: string,
  deps: PatientPaymentRouteDeps,
  req: Request,
  res: Response,
  dispatch: (req: Request) => Promise<ChargeHandlerResult>,
): Promise<void> {
  try {
    await deps.authenticateService();
    const result = await dispatch(req);
    res.status(result.status).json(result.body);
  } catch (error) {
    console.error(`osod-mcp: ${path} failed:`, error);
    if (!res.headersSent) res.status(500).json({ error: "patient payment route failed" });
  }
}

function stringQuery(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}
