import type { Application, Request, Response } from "express";
import type { Bundle, CarePlan, Encounter, Procedure, Resource } from "@medplum/fhirtypes";
import { resolveBusinessActionRole, type BusinessAction, type PracticeRoleId } from "../authz/roles.js";
import type { MedplumClient } from "../fhir-client.js";
import { isRelativeFhirReference } from "../fhir/reference.js";
import {
  FhirSeriesProtocolDefinitionStore,
  SeriesProtocolConflictError,
  SeriesProtocolInputError,
  type SeriesProtocolDefinitionDraft,
} from "./protocol-definition-store.js";
import {
  buildSeriesCarePlan,
  buildSeriesTrackerView,
  completeNextSeriesSession,
  procedureMatchesCarePlan,
  type SeriesRebookingPrompt,
} from "./series-care-plan.js";

export interface SeriesTrackerRouteDeps {
  authenticateService(): Promise<void>;
  authenticate(authHeader: string | undefined): Promise<SeriesTrackerStaff | null>;
  serviceFhir: MedplumClient;
  now?: () => string;
}

export interface SeriesTrackerStaff {
  staffReference: string;
  actorRole: PracticeRoleId;
  roles?: PracticeRoleId[];
  fhir: Pick<MedplumClient, "read" | "search" | "create" | "executeTransaction">;
}

type RouteResult = { status: number; body: unknown };

export function registerSeriesTrackerRoutes(
  app: Pick<Application, "get" | "post">,
  deps: SeriesTrackerRouteDeps,
): void {
  get(app, "/series-tracker/protocols", deps, (req) => listProtocols(deps, req));
  post(app, "/series-tracker/protocols", deps, (req) => saveProtocol(deps, req));
  post(app, "/series-tracker/protocols/:id/archive", deps, (req) => archiveProtocol(deps, req));
  get(app, "/series-tracker/patients/:patientId", deps, (req) => patientSeries(deps, req));
  post(app, "/series-tracker/patients/:patientId/care-plans", deps, (req) => prescribeProtocol(deps, req));
  post(app, "/series-tracker/encounters/:encounterId/sign-off", deps, (req) => signOffSeriesProcedures(deps, req));
}

async function listProtocols(deps: SeriesTrackerRouteDeps, req: Request): Promise<RouteResult> {
  const staff = await permittedStaff(deps, req, "chart.read");
  if ("status" in staff) return staff;
  const store = new FhirSeriesProtocolDefinitionStore(deps.serviceFhir, now(deps));
  return {
    status: 200,
    body: { protocols: await store.list({ includeArchived: req.query.includeArchived === "true" }) },
  };
}

async function saveProtocol(deps: SeriesTrackerRouteDeps, req: Request): Promise<RouteResult> {
  const staff = await authenticated(deps, req);
  if (!staff) return unauthorized();
  if (!staff.roles?.includes("admin")) return forbidden("Practice-admin role required.");
  const draft = protocolDraft(req.body);
  const store = new FhirSeriesProtocolDefinitionStore(deps.serviceFhir, now(deps));
  return { status: 200, body: { protocol: await store.save(draft) } };
}

async function archiveProtocol(deps: SeriesTrackerRouteDeps, req: Request): Promise<RouteResult> {
  const staff = await authenticated(deps, req);
  if (!staff) return unauthorized();
  if (!staff.roles?.includes("admin")) return forbidden("Practice-admin role required.");
  const id = identifierParam(req.params.id, "Protocol id");
  const store = new FhirSeriesProtocolDefinitionStore(deps.serviceFhir, now(deps));
  const protocol = await store.archive(id);
  return protocol
    ? { status: 200, body: { protocol } }
    : { status: 404, body: { error: "Protocol definition not found." } };
}

async function prescribeProtocol(deps: SeriesTrackerRouteDeps, req: Request): Promise<RouteResult> {
  const staff = await permittedStaff(deps, req, "chart.write");
  if ("status" in staff) return staff;
  const patientId = identifierParam(req.params.patientId, "Patient id");
  const body = record(req.body);
  const protocolId = requiredString(body.protocolId, "protocolId");
  const store = new FhirSeriesProtocolDefinitionStore(deps.serviceFhir, now(deps));
  const protocol = (await store.list()).find((candidate) => candidate.id === protocolId);
  if (!protocol) return { status: 404, body: { error: "Active protocol definition not found." } };
  const carePlan = await staff.fhir.create<CarePlan>(
    buildSeriesCarePlan({
      protocol,
      patientReference: `Patient/${patientId}`,
      authorReference: staff.staffReference,
      created: now(deps)(),
    }),
    { "X-ODOS-Source": "series-tracker-prescribe" },
  );
  return { status: 201, body: { carePlan, series: buildSeriesTrackerView(carePlan, []) } };
}

async function patientSeries(deps: SeriesTrackerRouteDeps, req: Request): Promise<RouteResult> {
  const staff = await permittedStaff(deps, req, "chart.read");
  if ("status" in staff) return staff;
  const patientId = identifierParam(req.params.patientId, "Patient id");
  const [carePlans, procedures] = await loadPatientSeries(staff.fhir, `Patient/${patientId}`);
  return {
    status: 200,
    body: {
      series: carePlans
        .filter((carePlan) => carePlan.id && carePlan.status !== "entered-in-error" && carePlan.status !== "revoked")
        .map((carePlan) => buildSeriesTrackerView(carePlan, procedures))
        .sort((left, right) => statusRank(left.status) - statusRank(right.status) || left.title.localeCompare(right.title)),
    },
  };
}

async function signOffSeriesProcedures(deps: SeriesTrackerRouteDeps, req: Request): Promise<RouteResult> {
  const staff = await permittedStaff(deps, req, "clinical.sign");
  if ("status" in staff) return staff;
  const encounterId = identifierParam(req.params.encounterId, "Encounter id");
  const encounter = await staff.fhir.read<Encounter>("Encounter", encounterId);
  if (encounter.status !== "finished") {
    return { status: 409, body: { error: "The encounter must be finished before series procedures are signed." } };
  }
  const patientReference = encounter.subject?.reference;
  if (!isRelativeFhirReference(patientReference, "Patient")) {
    return { status: 422, body: { error: "Encounter has no patient subject." } };
  }
  const [patientCarePlans, patientProcedures] = await loadPatientSeries(staff.fhir, patientReference);
  const activeCarePlans = patientCarePlans.filter((carePlan) => carePlan.status === "active" && carePlan.id);
  const encounterProcedures = patientProcedures.filter((procedure) =>
    procedure.encounter?.reference === `Encounter/${encounterId}` &&
    procedure.id &&
    procedure.status !== "completed" &&
    procedure.status !== "entered-in-error" &&
    procedure.status !== "not-done" &&
    procedure.status !== "stopped"
  );
  const carePlansByReference = new Map(activeCarePlans.map((carePlan) => [`CarePlan/${carePlan.id}`, carePlan]));
  const changedCarePlans = new Map<string, CarePlan>();
  const changedProcedures = new Map<string, Procedure>();
  const prompts: SeriesRebookingPrompt[] = [];

  for (const originalProcedure of encounterProcedures) {
    const explicit = originalProcedure.basedOn
      ?.flatMap((basedOn) => basedOn.reference ? [carePlansByReference.get(basedOn.reference)] : [])
      .find(Boolean);
    const matches = explicit
      ? [explicit]
      : activeCarePlans.filter((carePlan) => procedureMatchesCarePlan(originalProcedure, changedCarePlans.get(`CarePlan/${carePlan.id}`) ?? carePlan));
    if (matches.length > 1) {
      return {
        status: 409,
        body: { error: `Procedure/${originalProcedure.id} matches multiple active series; link it to one CarePlan before sign-off.` },
      };
    }
    const matched = matches[0];
    if (!matched?.id) continue;
    const carePlanReference = `CarePlan/${matched.id}`;
    const currentCarePlan = changedCarePlans.get(carePlanReference) ?? matched;
    const completed = completeNextSeriesSession({
      carePlan: currentCarePlan,
      procedure: originalProcedure,
      patientReference,
      completedAt: now(deps)(),
    });
    changedCarePlans.set(carePlanReference, completed.carePlan);
    changedProcedures.set(`Procedure/${originalProcedure.id}`, completed.procedure);
    if (completed.prompt) prompts.push(completed.prompt);
  }

  if (changedProcedures.size > 0) {
    await staff.fhir.executeTransaction(updateTransaction([
      ...changedProcedures.values(),
      ...changedCarePlans.values(),
    ]), { "X-ODOS-Source": "series-tracker-sign-off" });
  }
  return {
    status: 200,
    body: {
      updatedProcedureCount: changedProcedures.size,
      prompt: prompts[0],
    },
  };
}

async function loadPatientSeries(
  fhir: Pick<MedplumClient, "search">,
  patientReference: string,
): Promise<[CarePlan[], Procedure[]]> {
  const [carePlanBundle, procedureBundle] = await Promise.all([
    fhir.search<CarePlan>("CarePlan", { subject: patientReference, _count: "200" }),
    fhir.search<Procedure>("Procedure", { subject: patientReference, _count: "500" }),
  ]);
  const carePlans = resourcesOf(carePlanBundle).filter((carePlan) =>
    carePlan.instantiatesCanonical?.some((canonical) => canonical.includes("/PlanDefinition/series-protocol-"))
  );
  return [carePlans, resourcesOf(procedureBundle)];
}

function updateTransaction(resources: Resource[]): Bundle {
  return {
    resourceType: "Bundle",
    type: "transaction",
    entry: resources.map((resource) => {
      if (!resource.id) throw new SeriesProtocolInputError(`${resource.resourceType} id is required for update.`);
      return {
        resource,
        request: { method: "PUT", url: `${resource.resourceType}/${resource.id}` },
      };
    }),
  };
}

function resourcesOf<T extends Resource>(bundle: Bundle<T>): T[] {
  return (bundle.entry ?? []).flatMap((entry) => entry.resource ? [entry.resource] : []);
}

async function permittedStaff(
  deps: SeriesTrackerRouteDeps,
  req: Request,
  action: BusinessAction,
): Promise<SeriesTrackerStaff | RouteResult> {
  const staff = await authenticated(deps, req);
  if (!staff) return unauthorized();
  if (!resolveBusinessActionRole(staff.roles ?? [], action)) return forbidden(`${action} role required.`);
  return staff;
}

async function authenticated(deps: SeriesTrackerRouteDeps, req: Request): Promise<SeriesTrackerStaff | null> {
  return deps.authenticate(req.header("authorization"));
}

function protocolDraft(value: unknown): SeriesProtocolDefinitionDraft {
  const body = record(value);
  return {
    ...(typeof body.id === "string" && body.id ? { id: body.id } : {}),
    name: requiredString(body.name, "name"),
    eligibleProcedureTypeCodes: stringList(body.eligibleProcedureTypeCodes),
    sessionCount: requiredNumber(body.sessionCount, "sessionCount"),
    intervalMinDays: requiredNumber(body.intervalMinDays, "intervalMinDays"),
    intervalMaxDays: requiredNumber(body.intervalMaxDays, "intervalMaxDays"),
    maintenanceAfter: body.maintenanceAfter === true,
  };
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new SeriesProtocolInputError("Request body must be a JSON object.");
  }
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new SeriesProtocolInputError(`${label} is required.`);
  return value.trim();
}

function requiredNumber(value: unknown, label: string): number {
  if (typeof value !== "number") throw new SeriesProtocolInputError(`${label} must be a number.`);
  return value;
}

function stringList(value: unknown): string[] {
  if (typeof value === "string") return value.split(",").map((item) => item.trim()).filter(Boolean);
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean)
    : [];
}

function identifierParam(value: string | string[] | undefined, label: string): string {
  const resolved = typeof value === "string" ? value : "";
  if (!/^[A-Za-z0-9.-]+$/.test(resolved)) throw new SeriesProtocolInputError(`${label} is invalid.`);
  return resolved;
}

function statusRank(status: CarePlan["status"]): number {
  return status === "active" ? 0 : status === "on-hold" ? 1 : status === "completed" ? 2 : 3;
}

function now(deps: SeriesTrackerRouteDeps): () => string {
  return deps.now ?? (() => new Date().toISOString());
}

function unauthorized(): RouteResult {
  return { status: 401, body: { error: "Authentication required." } };
}

function forbidden(error: string): RouteResult {
  return { status: 403, body: { error } };
}

function get(
  app: Pick<Application, "get">,
  path: string,
  deps: SeriesTrackerRouteDeps,
  dispatch: (req: Request) => Promise<RouteResult>,
): void {
  app.get(path, async (req, res) => route(path, deps, req, res, dispatch));
}

function post(
  app: Pick<Application, "post">,
  path: string,
  deps: SeriesTrackerRouteDeps,
  dispatch: (req: Request) => Promise<RouteResult>,
): void {
  app.post(path, async (req, res) => route(path, deps, req, res, dispatch));
}

async function route(
  path: string,
  deps: SeriesTrackerRouteDeps,
  req: Request,
  res: Response,
  dispatch: (req: Request) => Promise<RouteResult>,
): Promise<void> {
  try {
    await deps.authenticateService();
    const result = await dispatch(req);
    res.status(result.status).json(result.body);
  } catch (error) {
    if (error instanceof SeriesProtocolInputError) {
      res.status(400).json({ error: error.message });
      return;
    }
    if (error instanceof SeriesProtocolConflictError) {
      res.status(409).json({ error: error.message });
      return;
    }
    console.error(`odos-mcp: ${path} failed:`, error);
    if (!res.headersSent) res.status(500).json({ error: "series tracker route failed" });
  }
}
