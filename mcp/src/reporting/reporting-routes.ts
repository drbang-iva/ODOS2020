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

export interface ReportingRouteDeps extends ReportingHandlerDeps {
  authenticateService(): Promise<void>;
}

export function registerReportingRoutes(
  app: Pick<Application, "get">,
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
}

function get(
  app: Pick<Application, "get">,
  path: string,
  deps: ReportingRouteDeps,
  dispatch: (req: Request) => Promise<ReportingResult>,
): void {
  app.get(path, async (req, res) => route(path, deps, req, res, dispatch));
}

async function route(
  path: string,
  deps: ReportingRouteDeps,
  req: Request,
  res: Response,
  dispatch: (req: Request) => Promise<ReportingResult>,
): Promise<void> {
  try {
    await deps.authenticateService();
    const result = await dispatch(req);
    if (result.csvFilename && typeof result.body === "string") {
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
