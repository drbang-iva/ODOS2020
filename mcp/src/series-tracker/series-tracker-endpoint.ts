import type { Application, Request, Response } from "express";
import type { Bundle, CarePlan, Encounter, EpisodeOfCare, Procedure, Provenance, Resource } from "@medplum/fhirtypes";
import { resolveBusinessActionRole, type BusinessAction, type PracticeRoleId } from "../authz/roles.js";
import type { MedplumClient } from "../fhir-client.js";
import { isRelativeFhirReference } from "../fhir/reference.js";
import { buildProvenance } from "../fhir/ophthalmology/provenance.js";
import { DRY_EYE_TREATMENT_SESSION_IDENTIFIER_SYSTEM } from "../fhir/dryEyeProcedure.js";
import {
  buildProcedureFromDefinition,
  type ClinicalProcedureDefinition,
} from "../clinical-graph/procedure-definition-store.js";
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
  SERIES_CARE_PLAN_SOURCE_IDENTIFIER_SYSTEM,
  type SeriesRebookingPrompt,
} from "./series-care-plan.js";

export interface SeriesTrackerRouteDeps {
  authenticateService(): Promise<void>;
  authenticate(authHeader: string | undefined): Promise<SeriesTrackerStaff | null>;
  serviceFhir: MedplumClient;
  procedureDefinitions?: () => Promise<ClinicalProcedureDefinition[]>;
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
  get(app, "/series-tracker/encounters/:encounterId/series/:protocolId", deps, (req) => encounterSeries(deps, req, false));
  post(app, "/series-tracker/encounters/:encounterId/series/:protocolId", deps, (req) => encounterSeries(deps, req, true));
  post(app, "/series-tracker/encounters/:encounterId/sign-off", deps, (req) => signOffSeriesProcedures(deps, req));
}

async function encounterSeries(
  deps: SeriesTrackerRouteDeps,
  req: Request,
  recordSession: boolean,
): Promise<RouteResult> {
  const staff = await permittedStaff(deps, req, recordSession ? "chart.write" : "chart.read");
  if ("status" in staff) return staff;
  const encounterId = identifierParam(req.params.encounterId, "Encounter id");
  const protocolId = identifierParam(req.params.protocolId, "Series protocol id");
  const encounter = await staff.fhir.read<Encounter>("Encounter", encounterId);
  const patientReference = encounter.subject?.reference;
  if (!isRelativeFhirReference(patientReference, "Patient")) {
    return { status: 422, body: { error: "Encounter has no patient subject." } };
  }
  const programReference = encounter.episodeOfCare?.[0]?.reference;
  if (recordSession && programReference) {
    if (!isRelativeFhirReference(programReference, "EpisodeOfCare")) {
      return { status: 409, body: { error: "Encounter is not linked to a valid active program." } };
    }
    const program = await staff.fhir.read<EpisodeOfCare>("EpisodeOfCare", programReference.slice("EpisodeOfCare/".length));
    if (program.status !== "active" || program.patient.reference !== patientReference) {
      return { status: 409, body: { error: "Encounter is not linked to this patient's active program." } };
    }
  }
  const protocol = (await new FhirSeriesProtocolDefinitionStore(deps.serviceFhir, now(deps)).list({ includeArchived: true }))
    .find((candidate) => candidate.id === protocolId);
  if (!protocol?.active) {
    return { status: 409, body: { error: `Active series protocol ${protocolId} is unavailable.` } };
  }
  const scopeIdentifier = `${programReference ?? `Encounter/${encounterId}`}:${protocolId}`;
  const patientCarePlans = await searchCompleteResources<CarePlan>(staff.fhir, "CarePlan", {
    subject: patientReference,
    "instantiates-canonical": protocol.planDefinitionCanonical,
    _count: "100",
  });
  if (!patientCarePlans) {
    return {
      status: 409,
      body: { error: `Could not verify all active ${protocol.name} CarePlans. No session was created.` },
    };
  }
  const matchingCarePlans = (
    await Promise.all(patientCarePlans.map(async (carePlan) =>
      carePlan.status === "active"
      && carePlan.instantiatesCanonical?.includes(protocol.planDefinitionCanonical)
      && await resourceIsInEncounterScope(staff.fhir, carePlan, encounter)
        ? [carePlan]
        : []
    ))
  ).flat();
  if (matchingCarePlans.length > 1) {
    return {
      status: 409,
      body: { error: `${matchingCarePlans.length} active ${protocol.name} series exist in this program.` },
    };
  }

  const legacyProcedures = protocolId === "dry-eye-ipl"
    ? await searchCompleteResources<Procedure>(staff.fhir, "Procedure", {
        subject: patientReference,
        code: "IPL",
        _count: "100",
      })
    : [];
  if (!legacyProcedures) {
    return {
      status: 409,
      body: { error: `Could not verify all legacy ${protocol.name} Procedures. No session was created.` },
    };
  }
  const legacyParents = (
    await Promise.all(legacyProcedures.map(async (procedure) =>
      isLegacySeriesParent(procedure, protocolId)
      && await resourceIsInEncounterScope(staff.fhir, procedure, encounter)
        ? [procedure]
        : []
    ))
  ).flat();
  if (legacyParents.length > 1) {
    return {
      status: 409,
      body: { error: `${legacyParents.length} legacy ${protocol.name} series conflict in this program.` },
    };
  }
  const legacyParent = legacyParents[0];
  const legacyAdoptable = legacyParent?.id
    ? legacyProcedures.filter((procedure) =>
        isActiveProcedure(procedure)
        && procedure.partOf?.some((reference) => reference.reference === `Procedure/${legacyParent.id}`)
      )
    : [];
  if (recordSession && legacyParent && legacyAdoptable.length !== 1) {
    return {
      status: 409,
      body: {
        error: legacyAdoptable.length === 0
          ? `Legacy ${protocol.name} series has no active session that can be adopted.`
          : `${legacyAdoptable.length} legacy ${protocol.name} sessions cannot be adopted unambiguously.`,
      },
    };
  }
  let carePlan = matchingCarePlans[0];
  let createdCarePlan = false;
  let procedureDefinition: ClinicalProcedureDefinition | undefined;
  if (!carePlan && recordSession) {
    if (legacyAdoptable.length === 0) {
      procedureDefinition = await resolveProcedureDefinition(deps, protocol.eligibleProcedureTypeCodes);
      if (!procedureDefinition) {
        return { status: 409, body: { error: `Active procedure definition for ${protocol.name} is unavailable.` } };
      }
    }
    carePlan = await staff.fhir.create<CarePlan>({
      ...buildSeriesCarePlan({
        protocol,
        patientReference,
        authorReference: staff.staffReference,
        created: now(deps)(),
      }),
      encounter: { reference: `Encounter/${encounterId}` },
      identifier: [{ system: SERIES_CARE_PLAN_SOURCE_IDENTIFIER_SYSTEM, value: scopeIdentifier }],
    }, {
      "X-ODOS-Source": "series-tracker-dry-eye",
      "If-None-Exist": `identifier=${SERIES_CARE_PLAN_SOURCE_IDENTIFIER_SYSTEM}|${scopeIdentifier}`,
    });
    createdCarePlan = true;
  }
  if (!carePlan?.id) {
    return {
      status: 200,
      body: { series: null, currentSession: null, remainingSessions: protocol.sessionCount },
    };
  }

  const carePlanReference = `CarePlan/${carePlan.id}`;
  const boundProcedures = await searchCompleteResources<Procedure>(staff.fhir, "Procedure", {
    subject: patientReference,
    "based-on": carePlanReference,
    _count: "100",
  });
  if (!boundProcedures) {
    return {
      status: 409,
      body: { error: `Could not verify all ${protocol.name} session Procedures. No session was created.` },
    };
  }
  let currentSession = boundProcedures.find((procedure) =>
    procedure.encounter?.reference === `Encounter/${encounterId}` && isActiveProcedure(procedure)
  );
  const activeBoundProcedure = boundProcedures.find(isActiveProcedure);
  if (!currentSession && activeBoundProcedure && recordSession) {
    return {
      status: 409,
      body: { error: `${protocol.name} already has an active session in another encounter.` },
    };
  }
  const series = buildSeriesTrackerView(carePlan, boundProcedures);
  const completedCount = series.sessions.filter((session) => session.status === "completed").length;
  const sessionNumber = Math.min(completedCount + 1, protocol.sessionCount);
  let createdSession = false;
  if (!currentSession && recordSession && completedCount < protocol.sessionCount) {
    if (legacyAdoptable.length === 0 && !procedureDefinition) {
      procedureDefinition = await resolveProcedureDefinition(deps, protocol.eligibleProcedureTypeCodes);
      if (!procedureDefinition) {
        return { status: 409, body: { error: `Active procedure definition for ${protocol.name} is unavailable.` } };
      }
    }
    const sessionIdentifier = `${carePlanReference}:${sessionNumber}-of-${protocol.sessionCount}`;
    const adopted = legacyAdoptable[0];
    if (adopted?.id) {
      currentSession = {
        ...adopted,
        basedOn: uniqueProcedureReferences([...(adopted.basedOn ?? []), { reference: carePlanReference }]),
        identifier: [
          ...(adopted.identifier ?? []),
          { system: DRY_EYE_TREATMENT_SESSION_IDENTIFIER_SYSTEM, value: sessionIdentifier },
        ],
      };
      await staff.fhir.executeTransaction({
        resourceType: "Bundle",
        type: "transaction",
        entry: [{
          resource: currentSession,
          request: { method: "PUT", url: `Procedure/${adopted.id}` },
        }],
      }, { "X-ODOS-Source": "series-tracker-dry-eye" });
    } else {
      currentSession = await staff.fhir.create<Procedure>({
        ...buildProcedureFromDefinition(procedureDefinition!, {
          patientReference,
          encounterReference: `Encounter/${encounterId}`,
          performedDateTime: now(deps)(),
          status: "in-progress",
        }),
        basedOn: [{ reference: carePlanReference }],
        identifier: [{ system: DRY_EYE_TREATMENT_SESSION_IDENTIFIER_SYSTEM, value: sessionIdentifier }],
      }, {
        "X-ODOS-Source": "series-tracker-dry-eye",
        "If-None-Exist": `identifier=${DRY_EYE_TREATMENT_SESSION_IDENTIFIER_SYSTEM}|${sessionIdentifier}`,
      });
    }
    createdSession = true;
    if (currentSession.id) {
      await staff.fhir.create<Provenance>(buildProvenance({
        targetReferences: [`Procedure/${currentSession.id}`, carePlanReference, patientReference],
        occurredDateTime: now(deps)(),
        activityCode: "CREATE",
        activityDisplay: "Create",
        agents: [{
          typeCode: "author",
          typeDisplay: "Author",
          whoReference: staff.staffReference,
        }],
      }), { "X-ODOS-Source": "series-tracker-dry-eye" });
    }
  }
  const resolvedNumber = currentSession ? sessionPosition(currentSession)?.number ?? sessionNumber : sessionNumber;
  const consumedSessionCount = currentSession
    ? resolvedNumber
    : activeBoundProcedure
      ? sessionPosition(activeBoundProcedure)?.number ?? sessionNumber
      : completedCount;
  return {
    status: createdCarePlan || createdSession ? 201 : 200,
    body: {
      series,
      currentSession: currentSession?.id ? {
        number: resolvedNumber,
        total: protocol.sessionCount,
        procedureReference: `Procedure/${currentSession.id}`,
      } : null,
      remainingSessions: Math.max(0, protocol.sessionCount - consumedSessionCount),
    },
  };
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

async function searchCompleteResources<T extends Resource>(
  fhir: Pick<MedplumClient, "search">,
  resourceType: T["resourceType"],
  params: Record<string, string>,
): Promise<T[] | undefined> {
  // search-contract: series-tracker.search-complete
  const bundle = await fhir.search<T>(resourceType, params);
  const resources = resourcesOf(bundle);
  const hasNext = bundle.link?.some((link) => link.relation === "next") ?? false;
  if (hasNext || (bundle.total !== undefined && bundle.total > resources.length)) return undefined;
  return resources;
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

function isActiveProcedure(procedure: Procedure): boolean {
  return !["completed", "entered-in-error", "not-done", "stopped"].includes(procedure.status);
}

function sessionPosition(procedure: Procedure): { number: number; total: number } | undefined {
  const value = procedure.identifier?.find((identifier) =>
    identifier.system === DRY_EYE_TREATMENT_SESSION_IDENTIFIER_SYSTEM
    && /:\d+-of-\d+$/.test(identifier.value ?? "")
  )?.value;
  const match = value?.match(/:(\d+)-of-(\d+)$/);
  if (!match) return undefined;
  const number = Number(match[1]);
  const total = Number(match[2]);
  return Number.isSafeInteger(number) && Number.isSafeInteger(total) && number > 0 && total >= number
    ? { number, total }
    : undefined;
}

async function resourceIsInEncounterScope(
  fhir: SeriesTrackerStaff["fhir"],
  resource: CarePlan | Procedure,
  encounter: Encounter,
): Promise<boolean> {
  const currentReference = `Encounter/${encounter.id}`;
  const resourceEncounter = resource.encounter?.reference
    ?? legacySourceEncounterReference(resource);
  if (!resourceEncounter || resourceEncounter === currentReference) return resourceEncounter === currentReference;
  if (!encounter.episodeOfCare?.[0]?.reference || !isRelativeFhirReference(resourceEncounter, "Encounter")) return false;
  const related = await fhir.read<Encounter>("Encounter", resourceEncounter.slice("Encounter/".length));
  return related.episodeOfCare?.some((reference) =>
    reference.reference === encounter.episodeOfCare?.[0]?.reference
  ) ?? false;
}

function legacySourceEncounterReference(resource: CarePlan | Procedure): string | undefined {
  const value = resource.identifier?.find((identifier) =>
    identifier.system === SERIES_CARE_PLAN_SOURCE_IDENTIFIER_SYSTEM
  )?.value;
  const encounterId = value?.split(":")[0];
  return encounterId && !encounterId.startsWith("EpisodeOfCare/") && !encounterId.startsWith("Encounter/")
    ? `Encounter/${encounterId}`
    : undefined;
}

function isLegacySeriesParent(procedure: Procedure, protocolId: string): boolean {
  return protocolId === "dry-eye-ipl"
    && procedure.status !== "entered-in-error"
    && procedure.code?.coding?.some((coding) => coding.code === "IPL") === true
    && procedure.note?.some((note) => /^\d+-session dry-eye treatment series$/.test(note.text ?? "")) === true;
}

function uniqueProcedureReferences(references: NonNullable<Procedure["basedOn"]>): NonNullable<Procedure["basedOn"]> {
  return [...new Map(references.map((reference) => [reference.reference, reference])).values()];
}

async function resolveProcedureDefinition(
  deps: SeriesTrackerRouteDeps,
  eligibleProcedureTypeCodes: readonly string[],
): Promise<ClinicalProcedureDefinition | undefined> {
  return (await deps.procedureDefinitions?.())?.find((candidate) =>
    candidate.active && eligibleProcedureTypeCodes.includes(candidate.stableKey)
  );
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
