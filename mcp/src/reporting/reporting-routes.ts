import type { Application, Request, Response } from "express";
import {
  handleAccountsReceivableDashboardRequest,
  handleClaimSearchExportRequest,
  handlePatientPaymentsExportRequest,
  handleRemittanceExportRequest,
  handleWorklistExportRequest,
  type ReportingHandlerDeps,
  type ReportingResult,
} from "./reporting.js";
import {
  handleGeneratePatientStatementRequest,
  handleRunStatementsRequest,
  handleStatementListRequest,
  type StatementHandlerDeps,
  type StatementHandlerResult,
} from "../statements/statements.js";
import {
  handlePlanProfilesRequest,
  type PlanProfileEndpointDeps,
} from "./plan-profiles.js";

export interface ReportingRouteDeps extends ReportingHandlerDeps {
  authenticateService(): Promise<void>;
  statements: StatementHandlerDeps;
  planProfiles: PlanProfileEndpointDeps;
}

export function registerReportingRoutes(
  app: Pick<Application, "get" | "post">,
  deps: ReportingRouteDeps,
): void {
  get(app, "/reports/accounts-receivable", deps, (req) => handleAccountsReceivableDashboardRequest(deps, {
    authHeader: req.header("authorization"),
  }));
  get(app, "/claims/search/export", deps, (req) => handleClaimSearchExportRequest(deps, {
    authHeader: req.header("authorization"),
    query: req.query,
  }));
  get(app, "/claims/era/export", deps, (req) => handleRemittanceExportRequest(deps, {
    authHeader: req.header("authorization"),
    query: req.query,
  }));
  get(app, "/claims/worklist/export", deps, (req) => handleWorklistExportRequest(deps, {
    authHeader: req.header("authorization"),
    query: req.query,
  }));
  get(app, "/payments/reconciliations/export", deps, (req) => handlePatientPaymentsExportRequest(deps, {
    authHeader: req.header("authorization"),
    query: req.query,
  }));
  get(app, "/practice/plan-profiles", deps, (req) => handlePlanProfilesRequest(deps.planProfiles, {
    authHeader: req.header("authorization"),
  }));
  get(app, "/statements", deps, (req) => handleStatementListRequest(deps.statements, {
    authHeader: req.header("authorization"),
    patientReference: stringQuery(req.query.patientReference),
  }));
  post(app, "/statements/generate", deps, (req) => handleGeneratePatientStatementRequest(deps.statements, {
    authHeader: req.header("authorization"),
    body: req.body,
  }));
  post(app, "/statements/run", deps, (req) => handleRunStatementsRequest(deps.statements, {
    authHeader: req.header("authorization"),
  }));
}

function get(
  app: Pick<Application, "get">,
  path: string,
  deps: ReportingRouteDeps,
  dispatch: (req: Request) => Promise<ReportingResult>,
): void {
  app.get(path, async (req, res) => route(path, deps, req, res, dispatch));
}

function post(
  app: Pick<Application, "post">,
  path: string,
  deps: ReportingRouteDeps,
  dispatch: (req: Request) => Promise<StatementHandlerResult>,
): void {
  app.post(path, async (req, res) => route(path, deps, req, res, dispatch));
}

async function route(
  path: string,
  deps: ReportingRouteDeps,
  req: Request,
  res: Response,
  dispatch: (req: Request) => Promise<ReportingResult | StatementHandlerResult>,
): Promise<void> {
  try {
    await deps.authenticateService();
    const result = await dispatch(req);
    if ("csvFilename" in result && result.csvFilename && typeof result.body === "string") {
      res
        .status(result.status)
        .type("text/csv")
        .set("Content-Disposition", `attachment; filename="${result.csvFilename}"`)
        .send(result.body);
      return;
    }
    res.status(result.status).json(result.body);
  } catch (error) {
    console.error(`osod-mcp: ${path} failed:`, error);
    if (!res.headersSent) res.status(500).json({ error: "reporting route failed" });
  }
}

function stringQuery(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (Array.isArray(value) && typeof value[0] === "string") return value[0];
  return undefined;
}
