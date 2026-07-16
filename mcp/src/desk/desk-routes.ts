import type { Application, Request, Response } from "express";
import { resolveBusinessActionRole, type PracticeRoleId } from "../authz/roles.js";
import type { AuthenticatedStaff } from "../payments/payment-charge-handler.js";
import { loadDayLedger, practiceDate } from "./day-ledger.js";
import { loadDeskSummary } from "./desk-summary.js";
import { loadDayClose, loadDaySealArchive, sealDay } from "./day-close.js";
import { DayAlreadySealedError, loadDaySeal } from "./day-seal.js";

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

export function registerDeskRoutes(app: Pick<Application, "get" | "post">, deps: DeskRouteDeps): void {
  app.get("/desk/whoami", async (req, res) => handleDeskWhoAmI(req, res, deps));
  app.get("/desk/summary", async (req, res) => handleDeskSummary(req, res, deps));
  app.get("/desk/ledger", async (req, res) => handleDayLedger(req, res, deps));
  app.get("/desk/ledger/seal", async (req, res) => handleDaySeal(req, res, deps));
  app.get("/desk/ledger/close", async (req, res) => handleDayClose(req, res, deps));
  app.get("/desk/ledger/archive", async (req, res) => handleDaySealArchive(req, res, deps));
  app.post("/desk/ledger/seal", async (req, res) => handleSealDay(req, res, deps));
}

async function handleDaySeal(req: Request, res: Response, deps: DeskRouteDeps): Promise<void> {
  try {
    const staff = await authorizedLedgerStaff(req, res, deps, "payment.charge");
    if (!staff) return;
    const date = requestedLedgerDate(req, deps);
    res.json({ date, seal: await loadDaySeal(staff.fhir, date) ?? null });
  } catch (error) {
    routeFailure(res, error, "Day-seal lookup failed.");
  }
}

async function handleDayClose(req: Request, res: Response, deps: DeskRouteDeps): Promise<void> {
  try {
    const staff = await authorizedLedgerStaff(req, res, deps, "payment.charge");
    if (!staff) return;
    const date = requestedLedgerDate(req, deps);
    res.json(await loadDayClose(staff.fhir, { date, timeZone: deps.timeZone }));
  } catch (error) {
    routeFailure(res, error, "Day-close review failed.");
  }
}

async function handleDaySealArchive(req: Request, res: Response, deps: DeskRouteDeps): Promise<void> {
  try {
    const staff = await authorizedLedgerStaff(req, res, deps, "payment.charge");
    if (!staff) return;
    res.json({ seals: await loadDaySealArchive(staff.fhir, deps.timeZone) });
  } catch (error) {
    routeFailure(res, error, "Day-seal archive failed.");
  }
}

async function handleSealDay(req: Request, res: Response, deps: DeskRouteDeps): Promise<void> {
  try {
    const staff = await authorizedLedgerStaff(req, res, deps, "payment.seal-day");
    if (!staff) return;
    const raw = req.body as { date?: unknown } | undefined;
    if (typeof raw?.date !== "string") {
      res.status(400).json({ error: "Ledger date must use YYYY-MM-DD." });
      return;
    }
    res.status(201).json(await sealDay(staff.fhir, {
      date: raw.date,
      staffReference: staff.staffReference,
      sealedAt: deps.now?.() ?? new Date().toISOString(),
      timeZone: deps.timeZone,
    }));
  } catch (error) {
    routeFailure(res, error, "Day seal failed.");
  }
}

async function authorizedLedgerStaff(
  req: Request,
  res: Response,
  deps: DeskRouteDeps,
  action: "payment.charge" | "payment.seal-day",
): Promise<AuthenticatedStaff | undefined> {
  await deps.authenticateService();
  const staff = await deps.authenticate(req.header("authorization"));
  if (!staff) {
    res.status(401).json({ error: "Authentication required to view the Day Ledger." });
    return undefined;
  }
  if (!resolveBusinessActionRole(staff.roles ?? [], action)) {
    res.status(403).json({ error: `${action} role required` });
    return undefined;
  }
  return staff;
}

function requestedLedgerDate(req: Request, deps: DeskRouteDeps): string {
  const requestedDate = req.query.date;
  if (requestedDate !== undefined && typeof requestedDate !== "string") {
    throw new Error("Ledger date must use YYYY-MM-DD.");
  }
  return requestedDate ?? practiceDate(deps.now?.() ?? new Date().toISOString(), deps.timeZone);
}

function routeFailure(res: Response, error: unknown, fallback: string): void {
  if (res.headersSent) return;
  const message = error instanceof Error ? error.message : String(error);
  if (message.startsWith("Ledger date must")) {
    res.status(400).json({ error: message });
  } else if (error instanceof DayAlreadySealedError || message.includes("guarded read limit") || message.includes("totals are unavailable")) {
    res.status(409).json({ error: message });
  } else {
    console.error(`osod-mcp: ${fallback}`, error);
    res.status(500).json({ error: fallback });
  }
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
