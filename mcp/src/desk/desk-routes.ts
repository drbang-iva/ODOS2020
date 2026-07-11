import type { Application, Request, Response } from "express";
import type { AuthenticatedStaff } from "../payments/payment-charge-handler.js";
import { loadDeskSummary } from "./desk-summary.js";

export interface DeskRouteDeps {
  authenticateService(): Promise<void>;
  authenticate(authHeader: string | undefined): Promise<AuthenticatedStaff | null>;
  terminalMode: string;
  timeZone?: string;
  now?: () => string;
}

export function registerDeskRoutes(app: Pick<Application, "get">, deps: DeskRouteDeps): void {
  app.get("/desk/summary", async (req, res) => handleDeskSummary(req, res, deps));
}

async function handleDeskSummary(req: Request, res: Response, deps: DeskRouteDeps): Promise<void> {
  try {
    await deps.authenticateService();
    const staff = await deps.authenticate(req.header("authorization"));
    if (!staff) {
      res.status(401).json({ error: "Authentication required to view the Desk." });
      return;
    }
    const summary = await loadDeskSummary(staff.fhir, {
      now: deps.now?.(),
      terminalMode: deps.terminalMode,
      timeZone: deps.timeZone,
    });
    res.json(summary);
  } catch (error) {
    console.error("osod-mcp: /desk/summary failed:", error);
    if (!res.headersSent) res.status(500).json({ error: "Desk summary route failed." });
  }
}
