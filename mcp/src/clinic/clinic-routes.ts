import type { Application, Request, Response } from "express";
import type { AuthenticatedStaff } from "../payments/payment-charge-handler.js";
import { loadClinicSummary } from "./clinic-summary.js";
import {
  loadPatientOverview,
  loadPatientStickyNoteHistory,
  savePatientStickyNote,
  StickyNoteValidationError,
  type OverviewFhir,
  type VisitLedgerFilter,
} from "./patient-overview.js";

type ClinicStaff = Omit<AuthenticatedStaff, "fhir"> & { fhir: OverviewFhir };

export interface ClinicRouteDeps {
  authenticateService(): Promise<void>;
  authenticate(authHeader: string | undefined): Promise<ClinicStaff | null>;
  timeZone?: string;
  now?: () => string;
}

export function registerClinicRoutes(app: Pick<Application, "get" | "post">, deps: ClinicRouteDeps): void {
  app.get("/clinic/summary", async (req, res) => handleClinicSummary(req, res, deps));
  app.get("/clinic/patients/:patientId/overview", async (req, res) => handlePatientOverview(req, res, deps));
  app.get("/clinic/patients/:patientId/sticky-note/history", async (req, res) => handleStickyNoteHistory(req, res, deps));
  app.post("/clinic/patients/:patientId/sticky-note", async (req, res) => handleStickyNoteSave(req, res, deps));
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

async function handlePatientOverview(req: Request, res: Response, deps: ClinicRouteDeps): Promise<void> {
  try {
    await deps.authenticateService();
    const staff = await deps.authenticate(req.header("authorization"));
    if (!staff) {
      res.status(401).json({ error: "Authentication required to view a patient overview." });
      return;
    }
    const patientId = routeParam(req.params.patientId);
    if (!isFhirId(patientId)) {
      res.status(400).json({ error: "Patient id is invalid." });
      return;
    }
    const requestedFilter = stringQuery(req.query.filter);
    if (requestedFilter === null) {
      res.status(400).json({ error: "Visit-ledger filter must be a single non-empty value." });
      return;
    }
    const filter = requestedFilter ?? "all";
    if (!isVisitLedgerFilter(filter)) {
      res.status(400).json({ error: "Unknown visit-ledger filter." });
      return;
    }
    const diagnosisSystem = stringQuery(req.query.diagnosisSystem);
    const diagnosisCode = stringQuery(req.query.diagnosisCode);
    if (diagnosisSystem === null || diagnosisCode === null) {
      res.status(400).json({ error: "Diagnosis system and code must be single non-empty values." });
      return;
    }
    if (Boolean(diagnosisSystem) !== Boolean(diagnosisCode)) {
      res.status(400).json({ error: "Diagnosis system and code must be supplied together." });
      return;
    }
    res.json(await loadPatientOverview(staff.fhir, patientId, {
      filter,
      ...(diagnosisSystem ? { diagnosisSystem } : {}),
      ...(diagnosisCode ? { diagnosisCode } : {}),
    }));
  } catch (error) {
    console.error("osod-mcp: patient overview failed:", error);
    if (!res.headersSent) res.status(500).json({ error: "Patient overview route failed." });
  }
}

async function handleStickyNoteSave(req: Request, res: Response, deps: ClinicRouteDeps): Promise<void> {
  try {
    await deps.authenticateService();
    const staff = await deps.authenticate(req.header("authorization"));
    if (!staff) {
      res.status(401).json({ error: "Authentication required to edit a patient sticky note." });
      return;
    }
    const patientId = routeParam(req.params.patientId);
    if (!isFhirId(patientId)) {
      res.status(400).json({ error: "Patient id is invalid." });
      return;
    }
    const text = typeof req.body?.text === "string" ? req.body.text : "";
    res.json(await savePatientStickyNote(staff.fhir, {
      patientId,
      text,
      authorReference: staff.staffReference,
      now: deps.now?.(),
    }));
  } catch (error) {
    console.error("osod-mcp: sticky note save failed:", error);
    if (!res.headersSent) {
      if (error instanceof StickyNoteValidationError) {
        res.status(400).json({ error: error.message });
      } else {
        res.status(500).json({ error: "Sticky note save failed." });
      }
    }
  }
}

async function handleStickyNoteHistory(req: Request, res: Response, deps: ClinicRouteDeps): Promise<void> {
  try {
    await deps.authenticateService();
    const staff = await deps.authenticate(req.header("authorization"));
    if (!staff) {
      res.status(401).json({ error: "Authentication required to view sticky-note history." });
      return;
    }
    const patientId = routeParam(req.params.patientId);
    if (!isFhirId(patientId)) {
      res.status(400).json({ error: "Patient id is invalid." });
      return;
    }
    res.json(await loadPatientStickyNoteHistory(staff.fhir, patientId));
  } catch (error) {
    console.error("osod-mcp: sticky note history failed:", error);
    if (!res.headersSent) res.status(500).json({ error: "Sticky note history route failed." });
  }
}

function stringQuery(value: unknown): string | null | undefined {
  if (value === undefined) return undefined;
  return typeof value === "string" && value.trim() ? value : null;
}

function routeParam(value: string | string[]): string {
  return Array.isArray(value) ? value[0] ?? "" : value;
}

function isVisitLedgerFilter(value: string): value is VisitLedgerFilter {
  return value === "all" || value === "eye-exams" || value === "office-visits";
}

function isFhirId(value: string): boolean {
  return /^[A-Za-z0-9.-]{1,64}$/.test(value);
}
