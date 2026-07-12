import type { Application, Request, Response } from "express";
import type { AuthenticatedStaff } from "../payments/payment-charge-handler.js";
import { loadClinicSummary } from "./clinic-summary.js";

export interface ClinicRouteDeps {
  authenticateService(): Promise<void>;
  authenticate(authHeader: string | undefined): Promise<AuthenticatedStaff | null>;
  timeZone?: string;
  now?: () => string;
}

export function registerClinicRoutes(app: Pick<Application, "get">, deps: ClinicRouteDeps): void {
  app.get("/clinic/summary", async (req, res) => handleClinicSummary(req, res, deps));
}

async function handleClinicSummary(req: Request, res: Response, deps: ClinicRouteDeps): Promise<void> {
  try {
    await deps.authenticateService();
    const staff = await deps.authenticate(req.header("authorization"));
    if (!staff) {
      res.status(401).json({ error: "Authentication required to view the Clinic." });
      return;
    }
    res.json(await loadClinicSummary(staff.fhir, { now: deps.now?.(), timeZone: deps.timeZone }));
  } catch (error) {
    console.error("osod-mcp: /clinic/summary failed:", error);
    if (!res.headersSent) res.status(500).json({ error: "Clinic summary route failed." });
  }
}
