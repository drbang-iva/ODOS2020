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
  fhir: Pick<MedplumClient, "read" | "search" | "create" | "createWithOutcome" | "executeTransaction">;
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
  const scopedCarePlans = (
    await Promise.all(patientCarePlans.map(async (carePlan) =>
      await carePlanMatchesSeriesScope(
        staff.fhir,
        carePlan,
        encounter,
        patientReference,
        protocol.planDefinitionCanonical,
        recordSession ? ["active"] : ["active", "completed"],
      )
        ? [carePlan]
        : []
    ))
  ).flat();
  const activeCarePlans = scopedCarePlans.filter((carePlan) => carePlan.status === "active");
  const matchingCarePlans = activeCarePlans.length > 0
    ? activeCarePlans
    : scopedCarePlans.filter((carePlan) => carePlan.status === "completed");
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
      && !(matchingCarePlans.length > 0 && procedure.status === "completed")
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
  const legacyChildren = legacyParent?.id
    ? (
        await Promise.all(legacyProcedures.map(async (procedure) =>
          isLegacySeriesProcedure(procedure, protocolId)
          && procedure.partOf?.some((reference) => reference.reference === `Procedure/${legacyParent.id}`)
          && await resourceIsInEncounterScope(staff.fhir, procedure, encounter)
            ? [procedure]
            : []
        ))
      ).flat()
    : [];
  const legacyAdoptable = legacyChildren.filter(isActiveProcedure);
  if (recordSession && legacyParent
    && ((matchingCarePlans.length === 0 && legacyAdoptable.length !== 1) || legacyAdoptable.length > 1)) {
    return {
      status: 409,
      body: {
        error: legacyAdoptable.length === 0
          ? `Legacy ${protocol.name} series has no active session that can be adopted.`
          : `${legacyAdoptable.length} legacy ${protocol.name} sessions cannot be adopted unambiguously.`,
      },
    };
  }
  if (recordSession && legacyAdoptable[0]
    && legacyAdoptable[0].encounter?.reference !== `Encounter/${encounterId}`) {
    return {
      status: 409,
      body: { error: `${protocol.name} already has an active session in another encounter.` },
    };
  }
  const legacyAdoption = legacyAdoptable[0]
    ? legacyAdoptionPlan(legacyAdoptable[0], legacyChildren, protocol.sessionCount)
    : undefined;
  if (recordSession && legacyAdoptable[0] && !legacyAdoption) {
    return {
      status: 409,
      body: { error: `Legacy ${protocol.name} session position cannot be adopted unambiguously.` },
    };
  }
  let carePlan = matchingCarePlans[0];
  let createdCarePlan = false;
  let procedureDefinition: ClinicalProcedureDefinition | undefined;
  let boundProcedures = carePlan?.id
    ? await loadBoundProcedures(staff.fhir, patientReference, `CarePlan/${carePlan.id}`)
    : [];
  if (!boundProcedures) {
    return {
      status: 409,
      body: { error: `Could not verify all ${protocol.name} session Procedures. No session was created.` },
    };
  }
  if (!carePlan && recordSession) {
    if (legacyAdoptable.length === 0) {
      procedureDefinition = await resolveProcedureDefinition(deps, protocol.eligibleProcedureTypeCodes);
      if (!procedureDefinition) {
        return { status: 409, body: { error: `Active procedure definition for ${protocol.name} is unavailable.` } };
      }
    }
    const outcome = await staff.fhir.createWithOutcome<CarePlan>({
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
    carePlan = outcome.resource;
    createdCarePlan = outcome.created;
    if (!createdCarePlan && !await carePlanMatchesSeriesScope(
      staff.fhir,
      carePlan,
      encounter,
      patientReference,
      protocol.planDefinitionCanonical,
    )) {
      return {
        status: 409,
        body: { error: `Conditional create returned a CarePlan that is not an active ${protocol.name} series in this program.` },
      };
    }
    if (!createdCarePlan && carePlan.id) {
      boundProcedures = await loadBoundProcedures(staff.fhir, patientReference, `CarePlan/${carePlan.id}`);
      if (!boundProcedures) {
        return {
          status: 409,
          body: { error: `Could not verify all ${protocol.name} session Procedures. No session was created.` },
        };
      }
    }
  }
  if (!carePlan?.id) {
    return {
      status: 200,
      body: { series: null, currentSession: null, remainingSessions: protocol.sessionCount },
    };
  }

  const carePlanReference = `CarePlan/${carePlan.id}`;
  const activeBoundProcedures = boundProcedures.filter((procedure) =>
    procedureMatchesBoundSession(procedure, carePlan, patientReference, carePlanReference)
  );
  if (activeBoundProcedures.length > 1) {
    return {
      status: 409,
      body: { error: `${activeBoundProcedures.length} active ${protocol.name} sessions conflict in this series.` },
    };
  }
  let currentSession = activeBoundProcedures.find((procedure) =>
    procedure.encounter?.reference === `Encounter/${encounterId}`
  );
  const activeBoundProcedure = activeBoundProcedures[0];
  if (!currentSession && activeBoundProcedure && recordSession) {
    return {
      status: 409,
      body: { error: `${protocol.name} already has an active session in another encounter.` },
    };
  }
  let series = buildSeriesTrackerView(carePlan, boundProcedures);
  const completedCount = series.sessions.filter((session) => session.status === "completed").length;
  const sessionNumber = legacyAdoption?.activePosition.number
    ?? Math.min(completedCount + 1, protocol.sessionCount);
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
      const migration = migrateLegacySessions(carePlan, legacyAdoption!, carePlanReference);
      if (!migration) {
        return {
          status: 409,
          body: { error: `Legacy ${protocol.name} history conflicts with the canonical series.` },
        };
      }
      carePlan = migration.carePlan;
      currentSession = migration.activeProcedure;
      await staff.fhir.executeTransaction({
        resourceType: "Bundle",
        type: "transaction",
        entry: [
          ...migration.completedProcedures,
          currentSession,
          carePlan,
        ].map((resource) => ({
          resource,
          request: { method: "PUT", url: `${resource.resourceType}/${resource.id}` },
        })),
      }, { "X-ODOS-Source": "series-tracker-dry-eye" });
      boundProcedures = uniqueProcedures([
        ...boundProcedures,
        ...migration.completedProcedures,
        currentSession,
      ]);
      series = buildSeriesTrackerView(carePlan, boundProcedures);
      createdSession = true;
    } else {
      const outcome = await staff.fhir.createWithOutcome<Procedure>({
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
      currentSession = outcome.resource;
      createdSession = outcome.created;
      if (!createdSession && currentSession.encounter?.reference !== `Encounter/${encounterId}`) {
        return {
          status: 409,
          body: { error: `${protocol.name} already has an active session in another encounter.` },
        };
      }
      if (!createdSession && !procedureMatchesConditionalSession(
        currentSession,
        carePlan,
        patientReference,
        `Encounter/${encounterId}`,
        carePlanReference,
        sessionIdentifier,
      )) {
        return {
          status: 409,
          body: { error: `Conditional create returned an invalid conditional ${protocol.name} session.` },
        };
      }
    }
    if (createdSession && currentSession.id) {
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

function loadBoundProcedures(
  fhir: Pick<MedplumClient, "search">,
  patientReference: string,
  carePlanReference: string,
): Promise<Procedure[] | undefined> {
  return searchCompleteResources<Procedure>(fhir, "Procedure", {
    subject: patientReference,
    "based-on": carePlanReference,
    _count: "100",
  });
}

async function carePlanMatchesSeriesScope(
  fhir: Pick<MedplumClient, "read">,
  carePlan: CarePlan,
  encounter: Encounter,
  patientReference: string,
  planDefinitionCanonical: string,
  allowedStatuses: readonly CarePlan["status"][] = ["active"],
): Promise<boolean> {
  return allowedStatuses.includes(carePlan.status)
    && carePlan.subject?.reference === patientReference
    && carePlan.instantiatesCanonical?.includes(planDefinitionCanonical) === true
    && await resourceIsInEncounterScope(fhir, carePlan, encounter);
}

function procedureMatchesConditionalSession(
  procedure: Procedure,
  carePlan: CarePlan,
  patientReference: string,
  encounterReference: string,
  carePlanReference: string,
  sessionIdentifier: string,
): boolean {
  return procedureMatchesBoundSession(procedure, carePlan, patientReference, carePlanReference)
    && procedure.encounter?.reference === encounterReference
    && procedure.identifier?.some((identifier) =>
      identifier.system === DRY_EYE_TREATMENT_SESSION_IDENTIFIER_SYSTEM
      && identifier.value === sessionIdentifier
    ) === true;
}

function procedureMatchesBoundSession(
  procedure: Procedure,
  carePlan: CarePlan,
  patientReference: string,
  carePlanReference: string,
): boolean {
  const position = sessionPosition(procedure);
  const sessionIdentifier = procedure.identifier?.find((identifier) =>
    identifier.system === DRY_EYE_TREATMENT_SESSION_IDENTIFIER_SYSTEM
    && identifier.value?.startsWith(`${carePlanReference}:`)
  )?.value;
  const totalSessions = carePlan.activity?.length ?? 0;
  return isActiveProcedure(procedure)
    && procedure.subject.reference === patientReference
    && procedure.basedOn?.some((reference) => reference.reference === carePlanReference) === true
    && sessionIdentifier?.startsWith(`${carePlanReference}:`) === true
    && position !== undefined
    && position.number >= 1
    && position.number <= totalSessions
    && position.total === totalSessions
    && procedureMatchesCarePlan(procedure, carePlan);
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

interface LegacyAdoptionPlan {
  activeProcedure: Procedure;
  activePosition: { number: number; total: number };
  completed: Array<{ procedure: Procedure; position: { number: number; total: number } }>;
}

function legacyAdoptionPlan(
  activeProcedure: Procedure,
  legacyChildren: readonly Procedure[],
  totalSessions: number,
): LegacyAdoptionPlan | undefined {
  const activePosition = legacySessionPosition(activeProcedure, totalSessions);
  if (!activeProcedure.id || !activePosition) return undefined;
  const completed = legacyChildren
    .filter((procedure) => procedure.status === "completed")
    .map((procedure) => ({ procedure, position: legacySessionPosition(procedure, totalSessions) }));
  if (completed.some(({ procedure, position }) => !procedure.id || !position)) return undefined;
  const positioned = completed as Array<{
    procedure: Procedure;
    position: { number: number; total: number };
  }>;
  const completedByNumber = new Map<number, typeof positioned[number]>();
  for (const candidate of positioned) {
    if (candidate.position.number >= activePosition.number || completedByNumber.has(candidate.position.number)) {
      return undefined;
    }
    completedByNumber.set(candidate.position.number, candidate);
  }
  for (let number = 1; number < activePosition.number; number += 1) {
    if (!completedByNumber.has(number)) return undefined;
  }
  return {
    activeProcedure,
    activePosition,
    completed: [...completedByNumber.values()].sort((left, right) => left.position.number - right.position.number),
  };
}

function legacySessionPosition(
  procedure: Procedure,
  totalSessions: number,
): { number: number; total: number } | undefined {
  const values = procedure.identifier
    ?.filter((identifier) =>
      identifier.system === DRY_EYE_TREATMENT_SESSION_IDENTIFIER_SYSTEM
      && /^\d+-of-\d+$/.test(identifier.value ?? "")
    )
    .flatMap((identifier) => identifier.value ? [identifier.value] : []) ?? [];
  if (values.length !== 1) return undefined;
  const match = values[0]!.match(/^(\d+)-of-(\d+)$/);
  const number = Number(match?.[1]);
  const total = Number(match?.[2]);
  return Number.isSafeInteger(number) && number > 0 && total === totalSessions && number <= total
    ? { number, total }
    : undefined;
}

function migrateLegacySessions(
  carePlan: CarePlan,
  migration: LegacyAdoptionPlan,
  carePlanReference: string,
): { carePlan: CarePlan; activeProcedure: Procedure; completedProcedures: Procedure[] } | undefined {
  const activities = structuredClone(carePlan.activity ?? []);
  if (activities.length !== migration.activePosition.total) return undefined;
  const completedProcedures: Procedure[] = [];
  for (const completed of migration.completed) {
    const activity = activities[completed.position.number - 1];
    if (!activity?.detail) return undefined;
    const procedureReference = `Procedure/${completed.procedure.id}`;
    const existingOutcomes = activity.outcomeReference?.flatMap((reference) =>
      reference.reference ? [reference.reference] : []
    ) ?? [];
    if (activity.detail.status === "completed"
      && existingOutcomes.length > 0
      && !existingOutcomes.includes(procedureReference)) {
      return undefined;
    }
    if (activity.detail.status !== "completed" && existingOutcomes.length > 0) return undefined;
    activity.detail.status = "completed";
    activity.outcomeReference = [{ reference: procedureReference }];
    completedProcedures.push(bindLegacyProcedure(
      completed.procedure,
      carePlan,
      carePlanReference,
      completed.position,
    ));
  }
  if (activities[migration.activePosition.number - 1]?.detail?.status === "completed") return undefined;
  return {
    carePlan: { ...carePlan, activity: activities },
    activeProcedure: bindLegacyProcedure(
      migration.activeProcedure,
      carePlan,
      carePlanReference,
      migration.activePosition,
    ),
    completedProcedures,
  };
}

function bindLegacyProcedure(
  procedure: Procedure,
  carePlan: CarePlan,
  carePlanReference: string,
  position: { number: number; total: number },
): Procedure {
  const eligibleCodings = carePlan.activity?.[position.number - 1]?.detail?.code?.coding ?? [];
  const codings = [...(procedure.code?.coding ?? []), ...eligibleCodings];
  return {
    ...procedure,
    code: {
      ...procedure.code,
      coding: [...new Map(codings.map((coding) => [`${coding.system ?? ""}|${coding.code ?? ""}`, coding])).values()],
    },
    basedOn: uniqueProcedureReferences([...(procedure.basedOn ?? []), { reference: carePlanReference }]),
    identifier: [...new Map([
      ...(procedure.identifier ?? []),
      {
        system: DRY_EYE_TREATMENT_SESSION_IDENTIFIER_SYSTEM,
        value: `${carePlanReference}:${position.number}-of-${position.total}`,
      },
    ].map((identifier) => [`${identifier.system ?? ""}|${identifier.value ?? ""}`, identifier])).values()],
  };
}

function uniqueProcedures(procedures: readonly Procedure[]): Procedure[] {
  return [...new Map(procedures.map((procedure) => [`Procedure/${procedure.id}`, procedure])).values()];
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
  fhir: Pick<MedplumClient, "read">,
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
  return procedure.status !== "entered-in-error"
    && isLegacySeriesProcedure(procedure, protocolId)
    && procedure.note?.some((note) => /^\d+-session dry-eye treatment series$/.test(note.text ?? "")) === true;
}

function isLegacySeriesProcedure(procedure: Procedure, protocolId: string): boolean {
  return protocolId === "dry-eye-ipl"
    && procedure.code?.coding?.some((coding) => coding.code === "IPL") === true;
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
