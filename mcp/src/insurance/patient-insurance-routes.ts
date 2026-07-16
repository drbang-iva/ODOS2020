import type { Application, Request, Response } from "express";
import {
  handlePatientInsuranceRead,
  handlePatientInsuranceWrite,
  handleVisionBenefitsRead,
  handleVisionBenefitsWrite,
  type PatientInsuranceHandlerDeps,
  type PatientInsuranceHandlerResult,
} from "./patient-insurance-handlers.js";

export function registerPatientInsuranceRoutes(
  app: Pick<Application, "get" | "post">,
  authenticateService: () => Promise<void>,
  handlers: PatientInsuranceHandlerDeps,
): void {
  get(app, "/insurance/coverages", authenticateService, (req) => handlePatientInsuranceRead(handlers, {
    authHeader: req.header("authorization"),
    patientReference: stringQuery(req.query.patientReference),
  }));
  post(app, "/insurance/coverages", authenticateService, (req) => handlePatientInsuranceWrite(handlers, {
    authHeader: req.header("authorization"),
    body: req.body,
  }));
  get(app, "/insurance/vision-benefits", authenticateService, (req) => handleVisionBenefitsRead(handlers, {
    authHeader: req.header("authorization"),
    patientReference: stringQuery(req.query.patientReference),
  }));
  post(app, "/insurance/vision-benefits", authenticateService, (req) => handleVisionBenefitsWrite(handlers, {
    authHeader: req.header("authorization"),
    body: req.body,
  }));
}

function get(
  app: Pick<Application, "get">,
  path: string,
  authenticateService: () => Promise<void>,
  dispatch: (request: Request) => Promise<PatientInsuranceHandlerResult>,
): void {
  app.get(path, async (req, res) => route(path, authenticateService, req, res, dispatch));
}

function post(
  app: Pick<Application, "post">,
  path: string,
  authenticateService: () => Promise<void>,
  dispatch: (request: Request) => Promise<PatientInsuranceHandlerResult>,
): void {
  app.post(path, async (req, res) => route(path, authenticateService, req, res, dispatch));
}

async function route(
  path: string,
  authenticateService: () => Promise<void>,
  req: Request,
  res: Response,
  dispatch: (request: Request) => Promise<PatientInsuranceHandlerResult>,
): Promise<void> {
  try {
    await authenticateService();
    const result = await dispatch(req);
    res.status(result.status).json(result.body);
  } catch (error) {
    console.error(`odos-mcp: ${path} failed:`, error);
    if (!res.headersSent) res.status(500).json({ error: "patient insurance route failed" });
  }
}

function stringQuery(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}
