import type { Application, Request, Response } from "express";
import { resolveBusinessActionRole, type PracticeRoleId } from "../authz/roles.js";
import type { AuthenticatedStaff } from "../payments/payment-charge-handler.js";
import { loadDayLedger, practiceDate } from "./day-ledger.js";
import { loadDeskSummary } from "./desk-summary.js";

export interface DeskRouteDeps {
  authenticateService(): Promise<void>;
  authenticate(authHeader: string | undefined): Promise<AuthenticatedStaff | null>;
  resolveRoles(authHeader: string | undefined): Promise<{
    email: string;
    roles: PracticeRoleId[];
  } | null>;
  terminalMode: string;
  timeZone?: string;
  now?: () => string;
}

export function registerDeskRoutes(app: Pick<Application, "get">, deps: DeskRouteDeps): void {
  app.get("/desk/whoami", async (req, res) => handleDeskWhoAmI(req, res, deps));
  app.get("/desk/summary", async (req, res) => handleDeskSummary(req, res, deps));
  app.get("/desk/ledger", async (req, res) => handleDayLedger(req, res, deps));
}

async function handleDayLedger(req: Request, res: Response, deps: DeskRouteDeps): Promise<void> {
  try {
    await deps.authenticateService();
    const staff = await deps.authenticate(req.header("authorization"));
    if (!staff) {
      res.status(401).json({ error: "Authentication required to view the Day Ledger." });
      return;
    }
    if (!resolveBusinessActionRole(staff.roles ?? [], "payment.charge")) {
      res.status(403).json({ error: "payment.charge role required" });
      return;
    }
    const requestedDate = req.query.date;
    if (requestedDate !== undefined && typeof requestedDate !== "string") {
      res.status(400).json({ error: "Ledger date must use YYYY-MM-DD." });
      return;
    }
    const date = requestedDate ?? practiceDate(deps.now?.() ?? new Date().toISOString(), deps.timeZone);
    try {
      res.json(await loadDayLedger(staff.fhir, { date, timeZone: deps.timeZone }));
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("Ledger date must")) {
        res.status(400).json({ error: error.message });
        return;
      }
      throw error;
    }
  } catch (error) {
    console.error("osod-mcp: /desk/ledger failed:", error);
    if (!res.headersSent) res.status(500).json({ error: "Day Ledger route failed." });
  }
}

async function handleDeskWhoAmI(req: Request, res: Response, deps: DeskRouteDeps): Promise<void> {
  try {
    await deps.authenticateService();
    const resolved = await deps.resolveRoles(req.header("authorization"));
    if (!resolved) {
      res.status(401).json({ error: "Authentication required." });
      return;
    }
    if (resolved.roles.length === 0) {
      res.status(403).json({
        error: "no-practice-role",
        detail: `Account ${resolved.email} has no practice role. An administrator must grant one.`,
      });
      return;
    }
    res.json({ roles: resolved.roles });
  } catch (error) {
    console.error("osod-mcp: /desk/whoami failed:", error);
    if (!res.headersSent) res.status(503).json({ error: "Practice role service unavailable." });
  }
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
