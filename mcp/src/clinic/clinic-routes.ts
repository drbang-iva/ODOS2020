import type { Project, Reference } from "@medplum/fhirtypes";
import type { Application, Request, Response } from "express";
import type { PracticeRoleId } from "../authz/roles.js";
import type { AuthenticatedStaff } from "../payments/payment-charge-handler.js";
import { loadClinicSummary } from "./clinic-summary.js";
import {
  parsePatientRegistrationInput,
  registerPatientFromDemographics,
  type PatientRegistrationEndpointDeps,
} from "./patient-registration-endpoint.js";
import {
  loadPatientOverview,
  loadPatientOverviewVisitDetail,
  loadPatientStickyNoteHistory,
  PatientOverviewVisitNotFoundError,
  savePatientStickyNote,
  StickyNoteValidationError,
  type OverviewFhir,
  type VisitLedgerFilter,
} from "./patient-overview.js";

type ClinicStaff = Omit<AuthenticatedStaff, "fhir" | "actorRole"> & {
  fhir: OverviewFhir;
  actorRole: PracticeRoleId;
  roles?: readonly PracticeRoleId[];
  project?: Reference<Project>;
};

export interface ClinicRouteDeps {
  authenticateService(): Promise<void>;
  authenticate(authHeader: string | undefined): Promise<ClinicStaff | null>;
  authenticateRegistration?: ClinicRouteDeps["authenticate"];
  timeZone?: string;
  now?: () => string;
  serviceFhir?: PatientRegistrationEndpointDeps["serviceFhir"];
  logRegistrationGrantFailure?: PatientRegistrationEndpointDeps["logGrantFailure"];
}

export function registerClinicRoutes(app: Pick<Application, "get" | "post">, deps: ClinicRouteDeps): void {
  app.get("/clinic/summary", async (req, res) => handleClinicSummary(req, res, deps));
  app.post("/clinic/patients", async (req, res) => handlePatientRegistration(req, res, deps));
  app.get("/clinic/patients/:patientId/overview", async (req, res) => handlePatientOverview(req, res, deps));
  app.get("/clinic/patients/:patientId/overview/visits/:encounterId", async (req, res) => handlePatientOverviewVisit(req, res, deps));
  app.get("/clinic/patients/:patientId/sticky-note/history", async (req, res) => handleStickyNoteHistory(req, res, deps));
  app.post("/clinic/patients/:patientId/sticky-note", async (req, res) => handleStickyNoteSave(req, res, deps));
}

async function handlePatientRegistration(req: Request, res: Response, deps: ClinicRouteDeps): Promise<void> {
  await deps.authenticateService();
  const staff = await (deps.authenticateRegistration ?? deps.authenticate)(req.header("authorization"));
  if (!staff) {
    res.status(401).json({ error: "Authentication required to register a patient." });
    return;
  }
  const parsed = parsePatientRegistrationInput(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: "Unsupported or invalid patient registration fields.",
      issues: parsed.error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })),
    });
    return;
  }
  if (!deps.serviceFhir || !staff.project) {
    res.status(503).json({ error: "Patient registration service is unavailable." });
    return;
  }
  try {
    const result = await registerPatientFromDemographics(
      parsed.data,
      {
        staffReference: staff.staffReference,
        actorRole: staff.actorRole,
        roles: staff.roles ?? [staff.actorRole],
        project: staff.project,
      },
      {
        serviceFhir: deps.serviceFhir,
        now: deps.now,
        logGrantFailure: deps.logRegistrationGrantFailure,
      },
    );
    res.status(result.status).json(result.body);
  } catch (error) {
    const status = typeof error === "object" && error !== null && "status" in error &&
        typeof error.status === "number"
      ? error.status
      : 500;
    if (status >= 500) console.error("odos-mcp: patient registration failed:", error);
    res.status(status).json({
      error: status === 403
        ? "You do not have permission to register patients. Ask a practice administrator to review your role."
        : status === 400
        ? error instanceof Error ? error.message : "Patient registration fields are invalid."
        : "Patient registration could not be confirmed. Check patient search before trying again, or ask a practice administrator for help.",
    });
  }
}

async function handlePatientOverviewVisit(req: Request, res: Response, deps: ClinicRouteDeps): Promise<void> {
  try {
    await deps.authenticateService();
    const staff = await deps.authenticate(req.header("authorization"));
    if (!staff) {
      res.status(401).json({ error: "Authentication required to view visit details." });
      return;
    }
    const patientId = routeParam(req.params.patientId);
    const encounterId = routeParam(req.params.encounterId);
    if (!isFhirId(patientId) || !isFhirId(encounterId)) {
      res.status(400).json({ error: "Patient or encounter id is invalid." });
      return;
    }
    res.json(await loadPatientOverviewVisitDetail(staff.fhir, patientId, encounterId));
  } catch (error) {
    console.error("odos-mcp: patient overview visit detail failed:", error);
    if (!res.headersSent) {
      res.status(error instanceof PatientOverviewVisitNotFoundError ? 404 : 500).json({
        error: error instanceof PatientOverviewVisitNotFoundError
          ? error.message
          : "Patient overview visit detail failed.",
      });
    }
  }
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
    console.error("odos-mcp: /clinic/summary failed:", error);
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
      now: deps.now?.(),
      timeZone: deps.timeZone,
    }));
  } catch (error) {
    console.error("odos-mcp: patient overview failed:", error);
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
    console.error("odos-mcp: sticky note save failed:", error);
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
    console.error("odos-mcp: sticky note history failed:", error);
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
