import type { Basic, Bundle, CarePlan, Condition, Encounter, Observation, Resource, ServiceRequest } from "@medplum/fhirtypes";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { assertBusinessActionAllowed, type PracticeRoleId } from "../authz/roles.js";
import type { MedplumClient } from "../fhir-client.js";
import {
  FhirSeriesProtocolDefinitionStore,
  type SeriesProtocolDefinition,
} from "../series-tracker/protocol-definition-store.js";
import { buildSeriesCarePlan } from "../series-tracker/series-care-plan.js";
import {
  BUILTIN_CHARGE_RULES,
  BUILTIN_PROTOCOLS,
  DRY_EYE_AT_HOME_REGIMEN_INIT_PROTOCOL,
  DRY_EYE_CHARGE_RULES,
  DRY_EYE_EVALUATION_PROTOCOL,
} from "./protocol-fixtures.js";
import {
  AcceptedChargeUnapplyError,
  matchesCode,
  ProtocolPublishValidationError,
  ProtocolService,
  rankProtocolOffers,
  validateProtocolDefinition,
  type ProtocolCatalogs,
} from "./protocol-service.js";
import type { ProtocolFhirClient } from "./protocol-store.js";
import { protocolFindingToGonioObservation } from "./gonioscopy.js";
import type {
  ChargeProposal,
  PlanActionInstance,
  ProtocolDefinitionDraft,
  ProtocolFindingInstance,
} from "./protocol-types.js";
import {
  isVisitProcedureConceptKey,
  listActiveVisitProcedureFees,
  materializeAcceptedChargeProposals,
  type ProcedureChargeFhir,
  type ProcedureFeeScheduleFhir,
} from "./procedure-fee-schedule.js";

const FINDING_SOURCE_URL = "https://odos2020.com/fhir/StructureDefinition/finding-source";
const SERIES_CARE_PLAN_SOURCE_IDENTIFIER_SYSTEM =
  "https://odos2020.com/fhir/NamingSystem/series-care-plan-source";
export const MANUAL_VISIT_CHARGE_ID_PREFIX = "manual-visit-code:";
export const MANUAL_VISIT_PLAN_ACTION_REF = "manual-visit-code";

interface LiveFhir extends ProtocolFhirClient {
  read<T extends Resource>(resourceType: T["resourceType"], id: string): Promise<T>;
  search<T extends Resource>(resourceType: T["resourceType"], params?: Record<string, string>): Promise<Bundle<T>>;
  searchUrl?<T extends Resource>(url: string, resourceType: T["resourceType"]): Promise<Bundle<T>>;
  create<T extends Basic | Observation | ServiceRequest | CarePlan>(resource: T, headers?: Record<string, string>): Promise<T>;
}
type CaptureFhir = Pick<LiveFhir, "read" | "search" | "searchUrl">;
interface Staff { staffReference: string; actorRole: PracticeRoleId; fhir: LiveFhir }
export interface ProtocolEndpointDeps {
  authenticate(authHeader: string | undefined): Promise<Staff | null>;
  feeScheduleFhir?: ProcedureFeeScheduleFhir;
  serviceFhir?: MedplumClient;
  now?: () => string;
  catalogs?: () => ProtocolCatalogs;
}

const diagnosisVisitStatusSchema = z.enum([
  "new",
  "stable",
  "improved",
  "worsening",
  "resolved-this-visit",
]);
const diagnosesSchema = z.array(z.object({
  reference: z.string(),
  code: z.string(),
  confirmed: z.boolean(),
  visitStatus: diagnosisVisitStatusSchema.optional(),
}).strict());
const lateralityModeSchema = z.union([
  z.enum(["inherit-dx", "OU-always"]),
  z.object({ fixed: z.enum(["OD", "OS", "OU"]) }).strict(),
]);
const protocolItemSchema = z.object({
  itemKey: z.string(),
  itemType: z.enum([
    "finding-seed", "order", "medication", "counseling", "education",
    "instruction", "follow-up", "charge-seed",
  ]),
  defaultSelected: z.boolean(),
  lateralityMode: lateralityModeSchema,
  mergeKey: z.string().optional(),
  linkedDxScope: z.array(z.string()).optional(),
  payload: z.record(z.unknown()),
  capture: z.object({
    source: z.enum(["device-measured", "observed-estimate", "structured"]),
    seedValueKept: z.boolean().optional(),
  }).strict().optional(),
}).strict();
const protocolTriggerSchema = z.union([
  z.object({
    kind: z.literal("diagnosis"),
    dxKeys: z.array(z.string()),
    statusScope: z.array(diagnosisVisitStatusSchema).optional(),
  }).strict(),
  z.object({ kind: z.literal("visit-type"), visitTypes: z.array(z.string()) }).strict(),
]);
const protocolDraftSchema = z.object({
  title: z.string(),
  trigger: protocolTriggerSchema,
  applicability: z.record(z.unknown()).optional(),
  ownership: z.object({ ownerId: z.string(), sharing: z.string() }).strict(),
  categories: z.array(z.string()),
  items: z.array(protocolItemSchema),
  mergePolicy: z.record(z.unknown()).optional(),
  provenanceNote: z.string().optional(),
}).strict();
const applySchema = z.object({
  protocolId: z.string(),
  encounterId: z.string(),
  patientId: z.string(),
  diagnosis: z.object({ reference: z.string().regex(/^Condition\/[^/]+$/), code: z.string(), confirmed: z.literal(true) }).strict(),
  selections: z.array(z.object({
    itemKey: z.string(),
    selected: z.boolean(),
    payload: z.record(z.unknown()).optional(),
  }).strict()).optional(),
  acceptCharges: z.boolean().optional(),
}).strict();

export async function handleProtocolLibraryRequest(
  deps: ProtocolEndpointDeps,
  input: { authHeader: string | undefined },
) {
  const staff = await deps.authenticate(input.authHeader);
  if (!staff) return { status: 401, body: { error: "Authentication required to read protocols." } };
  if (!may(staff.actorRole, "protocols.author")) return { status: 403, body: { error: "protocols.author role required" } };
  const catalogs = protocolCatalogs(deps);
  return {
    status: 200,
    body: {
      protocols: await liveService(staff, deps.now).definitions.list(),
      catalogs: {
        findingKeys: [...catalogs.findingKeys].sort(),
        procedureKeys: [...catalogs.procedureKeys].sort(),
      },
    },
  };
}

export async function handleProtocolCreateRequest(
  deps: ProtocolEndpointDeps,
  input: { authHeader: string | undefined; body: unknown },
) {
  const staff = await deps.authenticate(input.authHeader);
  if (!staff) return { status: 401, body: { error: "Authentication required to author protocols." } };
  if (!may(staff.actorRole, "protocols.author")) return { status: 403, body: { error: "protocols.author role required" } };
  const parsed = protocolDraftSchema.partial().safeParse(input.body);
  if (!parsed.success) return { status: 400, body: { error: parsed.error.issues[0]?.message ?? "Invalid protocol draft." } };
  const protocol = await liveService(staff, deps.now).createDraft(
    parsed.data as Partial<ProtocolDefinitionDraft>,
    staff.staffReference,
  );
  return {
    status: 201,
    body: { protocol, validation: validateProtocolDefinition(protocol.draft!, protocolCatalogs(deps)) },
  };
}

export async function handleProtocolDraftRequest(
  deps: ProtocolEndpointDeps,
  input: { authHeader: string | undefined; params: unknown; body: unknown },
) {
  const staff = await deps.authenticate(input.authHeader);
  if (!staff) return { status: 401, body: { error: "Authentication required to author protocols." } };
  if (!may(staff.actorRole, "protocols.author")) return { status: 403, body: { error: "protocols.author role required" } };
  const params = z.object({ id: z.string().min(1) }).strict().safeParse(input.params);
  const body = protocolDraftSchema.safeParse(input.body);
  if (!params.success || !body.success) {
    return { status: 400, body: { error: body.success ? "Protocol id is required." : body.error.issues[0]?.message } };
  }
  const protocol = await liveService(staff, deps.now).saveDraft(params.data.id, body.data);
  return {
    status: 200,
    body: { protocol, validation: validateProtocolDefinition(protocol.draft!, protocolCatalogs(deps)) },
  };
}

export async function handleProtocolPublishRequest(
  deps: ProtocolEndpointDeps,
  input: { authHeader: string | undefined; params: unknown; body: unknown },
) {
  const staff = await deps.authenticate(input.authHeader);
  if (!staff) return { status: 401, body: { error: "Authentication required to publish protocols." } };
  if (!may(staff.actorRole, "protocols.author")) return { status: 403, body: { error: "protocols.author role required" } };
  const params = z.object({ id: z.string().min(1) }).strict().safeParse(input.params);
  const body = z.object({}).strict().safeParse(input.body ?? {});
  if (!params.success || !body.success) return { status: 400, body: { error: "Valid protocol id and empty publish body are required." } };
  try {
    const protocol = await liveService(staff, deps.now).publish(
      params.data.id,
      staff.staffReference,
      protocolCatalogs(deps),
    );
    return { status: 200, body: { protocol } };
  } catch (error) {
    if (error instanceof ProtocolPublishValidationError) {
      return {
        status: 400,
        body: { error: error.message, reason: error.issues[0]?.reason, issues: error.issues },
      };
    }
    throw error;
  }
}

export async function handleProtocolRetireRequest(
  deps: ProtocolEndpointDeps,
  input: { authHeader: string | undefined; params: unknown; body: unknown },
) {
  const staff = await deps.authenticate(input.authHeader);
  if (!staff) return { status: 401, body: { error: "Authentication required to retire protocols." } };
  if (!may(staff.actorRole, "protocols.author")) return { status: 403, body: { error: "protocols.author role required" } };
  const params = z.object({ id: z.string().min(1) }).strict().safeParse(input.params);
  const body = z.object({}).strict().safeParse(input.body ?? {});
  if (!params.success || !body.success) return { status: 400, body: { error: "Valid protocol id and empty retire body are required." } };
  return { status: 200, body: { protocol: await liveService(staff, deps.now).retire(params.data.id) } };
}

export async function handleProtocolForkRequest(
  deps: ProtocolEndpointDeps,
  input: { authHeader: string | undefined; params: unknown; body: unknown },
) {
  const staff = await deps.authenticate(input.authHeader);
  if (!staff) return { status: 401, body: { error: "Authentication required to copy protocols." } };
  if (!may(staff.actorRole, "protocols.author")) return { status: 403, body: { error: "protocols.author role required" } };
  const params = z.object({ id: z.string().min(1) }).strict().safeParse(input.params);
  const body = z.object({ title: z.string().min(1).optional() }).strict().safeParse(input.body ?? {});
  if (!params.success || !body.success) return { status: 400, body: { error: "Valid protocol id and fork body are required." } };
  return {
    status: 201,
    body: { protocol: await liveService(staff, deps.now).fork(params.data.id, staff.staffReference, body.data.title) },
  };
}

export async function handleProtocolCaptureRequest(
  deps: ProtocolEndpointDeps,
  input: { authHeader: string | undefined; params: unknown; body: unknown },
) {
  const staff = await deps.authenticate(input.authHeader);
  if (!staff) return { status: 401, body: { error: "Authentication required to capture protocols." } };
  if (!may(staff.actorRole, "protocols.author")) return { status: 403, body: { error: "protocols.author role required" } };
  const params = z.object({ encounterId: z.string().min(1) }).strict().safeParse(input.params);
  const body = z.object({ name: z.string().trim().min(1) }).strict().safeParse(input.body);
  if (!params.success || !body.success) return { status: 400, body: { error: "Encounter id and protocol name are required." } };
  const captureFhir = staff.fhir;
  const encounter = await captureFhir.read<Encounter>("Encounter", params.data.encounterId);
  const [conditions, observations] = await Promise.all([
    searchAll<Condition>(captureFhir, "Condition", {
      encounter: `Encounter/${params.data.encounterId}`,
      _count: "200",
    }),
    searchAll<Observation>(captureFhir, "Observation", {
      encounter: `Encounter/${params.data.encounterId}`,
      _count: "500",
    }),
  ]);
  const patientReference = encounter.subject?.reference;
  const confirmedDiagnoses = (patientReference ? conditions : [])
    .filter((condition) =>
      Boolean(condition.subject.reference) &&
      condition.subject.reference === patientReference &&
      condition.verificationStatus?.coding?.some((coding) => coding.code === "confirmed")
    )
    .flatMap((condition) => condition.code?.coding?.flatMap((coding) => coding.code ? [{ code: coding.code }] : []) ?? []);
  const protocol = await liveService(staff, deps.now).captureDraft({
    encounterId: params.data.encounterId,
    name: body.data.name,
    actor: staff.staffReference,
    confirmedDiagnoses,
    observations,
    findingKeys: protocolCatalogs(deps).findingKeys,
  });
  return {
    status: 201,
    body: { protocol, validation: validateProtocolDefinition(protocol.draft!, protocolCatalogs(deps)) },
  };
}

export async function handleProtocolOffersRequest(
  deps: ProtocolEndpointDeps,
  input: { authHeader: string | undefined; body: unknown },
) {
  const staff = await deps.authenticate(input.authHeader);
  if (!staff) return { status: 401, body: { error: "Authentication required to read protocols." } };
  if (!may(staff.actorRole, "chart.read")) return { status: 403, body: { error: "chart.read role required" } };
  const parsed = z.object({ diagnoses: diagnosesSchema }).strict().safeParse(input.body);
  if (!parsed.success) return { status: 400, body: { error: "Valid diagnoses are required." } };
  const service = liveService(staff, deps.now);
  const stored = await service.offers(parsed.data.diagnoses);
  const storedIds = new Set(stored.map((protocol) => protocol.id));
  const confirmedCodes = parsed.data.diagnoses
    .filter((diagnosis) => diagnosis.confirmed)
    .map((diagnosis) => diagnosis.code);
  const builtIns = BUILTIN_PROTOCOLS.filter((protocol) =>
    !storedIds.has(protocol.id) &&
    protocol.status === "active" &&
    protocol.trigger.kind === "diagnosis" &&
    protocol.trigger.dxKeys.some((pattern) => confirmedCodes.some((code) => matchesCode(code, pattern)))
  );
  const protocols = rankProtocolOffers([...stored, ...builtIns], parsed.data.diagnoses).map((protocol) => {
    const builtIn = BUILTIN_PROTOCOLS.find((candidate) => candidate.id === protocol.id);
    return {
      ...protocol,
      acceptCharges: protocol.acceptCharges ?? builtIn?.acceptCharges ?? false,
      statusScope: protocol.trigger.kind === "diagnosis" ? protocol.trigger.statusScope ?? [] : [],
    };
  });
  return { status: 200, body: { protocols } };
}

export async function handleProtocolApplyRequest(
  deps: ProtocolEndpointDeps,
  input: { authHeader: string | undefined; body: unknown },
) {
  const staff = await deps.authenticate(input.authHeader);
  if (!staff) return { status: 401, body: { error: "Authentication required to apply protocols." } };
  if (!may(staff.actorRole, "chart.write")) return { status: 403, body: { error: "chart.write role required" } };
  const parsed = applySchema.safeParse(input.body);
  if (!parsed.success) return { status: 400, body: { error: parsed.error.issues[0]?.message ?? "Invalid protocol application." } };
  const service = liveService(staff, deps.now);
  await ensureBuiltInProtocol(service, parsed.data.protocolId);
  const conditionId = parsed.data.diagnosis.reference.slice("Condition/".length);
  let condition: Condition;
  try {
    condition = await staff.fhir.read<Condition>("Condition", conditionId);
  } catch {
    return { status: 400, body: { error: "Submitted Condition does not exist." } };
  }
  const submittedCoding = condition.code?.coding?.find((coding) => coding.code === parsed.data.diagnosis.code);
  const protocol = await service.definitions.get(parsed.data.protocolId);
  if (!condition.verificationStatus?.coding?.some((coding) => coding.code === "confirmed")) {
    return { status: 400, body: { error: "Condition must be confirmed before applying a protocol." } };
  }
  if (!submittedCoding) {
    return { status: 400, body: { error: "Submitted diagnosis code does not match the Condition." } };
  }
  if (condition.subject.reference !== `Patient/${parsed.data.patientId}`) {
    return { status: 400, body: { error: "Condition does not belong to the submitted patient." } };
  }
  if (condition.encounter?.reference && condition.encounter.reference !== `Encounter/${parsed.data.encounterId}`) {
    return { status: 400, body: { error: "Condition does not belong to the submitted encounter." } };
  }
  if (!protocol || protocol.trigger.kind !== "diagnosis" ||
    !protocol.trigger.dxKeys.some((pattern) => matchesCode(parsed.data.diagnosis.code, pattern))) {
    return { status: 400, body: { error: "Condition does not match the protocol trigger." } };
  }
  if ((await service.applications.list()).some((application) =>
    application.encounterId === parsed.data.encounterId &&
    application.protocolId === parsed.data.protocolId &&
    application.confirmed && application.undoState === "active"
  )) return { status: 409, body: { error: "Protocol is already applied to this encounter." } };
  const selectedPinnedItems = protocol.items.flatMap((item) => {
    if (item.itemType !== "series-prescription" && item.itemType !== "charge-seed") return [];
    const selection = parsed.data.selections?.find((candidate) => candidate.itemKey === item.itemKey);
    if (!(selection?.selected ?? item.defaultSelected)) return [];
    return [{ item, submittedPayload: selection?.payload }];
  });
  for (const { item, submittedPayload } of selectedPinnedItems) {
    if (submittedPayload && !isDeepStrictEqual(submittedPayload, item.payload)) {
      return {
        status: 400,
        body: { error: `Selected ${item.itemType} ${item.itemKey} must use the canonical protocol payload.` },
      };
    }
  }
  const selectedSeriesItems = selectedPinnedItems.filter(({ item }) =>
    item.itemType === "series-prescription"
  );
  const resolvedSeriesProtocols = new Map<string, SeriesProtocolDefinition>();
  if (selectedSeriesItems.length > 0) {
    if (!deps.serviceFhir) {
      return {
        status: 500,
        body: { error: "Protocol series prescriptions require the service FHIR client." },
      };
    }
    const definitions = await new FhirSeriesProtocolDefinitionStore(deps.serviceFhir, deps.now).list({
      includeArchived: true,
    });
    for (const { item } of selectedSeriesItems) {
      const seriesProtocolId = typeof item.payload.seriesProtocolId === "string"
        ? item.payload.seriesProtocolId.trim()
        : "";
      const definition = definitions.find((candidate) => candidate.id === seriesProtocolId);
      if (!seriesProtocolId || !definition?.active) {
        return {
          status: 400,
          body: { error: `Selected series prescription ${item.itemKey} has no active series protocol definition.` },
        };
      }
      resolvedSeriesProtocols.set(seriesProtocolId, definition);
    }
  }
  const canonicalSelections = parsed.data.selections?.map((selection) => {
    const item = protocol.items.find((candidate) =>
      candidate.itemKey === selection.itemKey &&
      (candidate.itemType === "series-prescription" || candidate.itemType === "charge-seed")
    );
    return item ? { ...selection, payload: item.payload } : selection;
  }) ?? [];
  const opened = await service.open(parsed.data.protocolId, {
    encounterId: parsed.data.encounterId,
    patientId: parsed.data.patientId,
    diagnosis: parsed.data.diagnosis,
    actor: staff.staffReference,
  });
  await liveService(staff, deps.now, resolvedSeriesProtocols).commit(
    opened.application.id,
    canonicalSelections,
    [parsed.data.diagnosis.reference],
  );
  if (parsed.data.acceptCharges) {
    for (const charge of (await service.charges.list()).filter((candidate) =>
      candidate.protocolApplicationId === opened.application.id &&
      candidate.state === "staged"
    )) await service.charges.save({ ...charge, state: "accepted" });
  }
  return {
    status: 200,
    body: {
      application: await service.applications.get(opened.application.id),
      findings: (await service.findings.list()).filter((row) => row.protocolApplicationId === opened.application.id),
      actions: (await service.actions.list()).filter((row) => row.protocolApplicationId === opened.application.id),
      charges: (await service.charges.list()).filter((row) => row.protocolApplicationId === opened.application.id),
    },
  };
}

async function ensureBuiltInProtocol(service: ProtocolService, protocolId: string): Promise<void> {
  const builtIn = BUILTIN_PROTOCOLS.find((protocol) => protocol.id === protocolId);
  if (!builtIn) return;
  if (!await service.definitions.get(builtIn.id)) await service.definitions.save(builtIn);
  const referencedRuleIds = new Set(builtIn.items.flatMap((item) =>
    item.itemType === "charge-seed" && Array.isArray(item.payload.chargeRuleRefs)
      ? item.payload.chargeRuleRefs.map(String)
      : []
  ));
  const rules = builtIn.id === DRY_EYE_EVALUATION_PROTOCOL.id
    ? DRY_EYE_CHARGE_RULES
    : BUILTIN_CHARGE_RULES.filter((rule) => referencedRuleIds.has(rule.id));
  for (const rule of rules) {
    if (!await service.chargeRules.get(rule.id)) await service.chargeRules.save(rule);
  }
}

export async function handleProtocolApplicationsRequest(
  deps: ProtocolEndpointDeps,
  input: { authHeader: string | undefined; query: unknown },
) {
  const staff = await deps.authenticate(input.authHeader);
  if (!staff) return { status: 401, body: { error: "Authentication required to read protocol applications." } };
  if (!may(staff.actorRole, "chart.read")) return { status: 403, body: { error: "chart.read role required" } };
  const parsed = z.object({ encounterId: z.string().min(1) }).strict().safeParse(input.query);
  if (!parsed.success) return { status: 400, body: { error: "encounterId is required." } };
  const applications = (await liveService(staff, deps.now).applications.list())
    .filter((application) => application.encounterId === parsed.data.encounterId)
    .map((application) => ({
      id: application.id,
      protocolId: application.protocolId,
      version: application.protocolVersion,
      confirmed: application.confirmed,
      undoState: application.undoState,
    }));
  return { status: 200, body: { applications } };
}

export async function handleVisitChargeRequest(
  deps: ProtocolEndpointDeps,
  input: { authHeader: string | undefined; params: unknown },
) {
  const staff = await deps.authenticate(input.authHeader);
  if (!staff) return { status: 401, body: { error: "Authentication required to read the visit charge." } };
  if (!may(staff.actorRole, "chart.read")) return { status: 403, body: { error: "chart.read role required" } };
  const parsed = z.object({ encounterId: z.string().min(1) }).strict().safeParse(input.params);
  if (!parsed.success) return { status: 400, body: { error: "encounterId is required." } };
  const service = liveService(staff, deps.now);
  const resolution = resolveManualVisitProposal(await service.charges.list(), parsed.data.encounterId);
  if (resolution.conflict) return { status: 409, body: { error: resolution.conflict } };
  const options = await listActiveVisitProcedureFees(staff.fhir);
  return {
    status: 200,
    body: {
      options,
      proposal: resolution.proposal,
      ...(resolution.proposal?.state === "accepted"
        ? { selectedProcedureConceptKey: resolution.proposal.procedureConceptKey }
        : {}),
    },
  };
}

export async function handleVisitChargeMutationRequest(
  deps: ProtocolEndpointDeps,
  input: { authHeader: string | undefined; params: unknown; body: unknown },
) {
  const staff = await deps.authenticate(input.authHeader);
  if (!staff) return { status: 401, body: { error: "Authentication required to edit the visit charge." } };
  if (!may(staff.actorRole, "chart.write")) return { status: 403, body: { error: "chart.write role required" } };
  const params = z.object({ encounterId: z.string().min(1) }).strict().safeParse(input.params);
  const body = z.object({ procedureConceptKey: z.string().min(1).nullable() }).strict().safeParse(input.body);
  if (!params.success || !body.success) {
    return { status: 400, body: { error: "A valid encounter and visit procedure concept are required." } };
  }
  const service = liveService(staff, deps.now);
  const resolution = resolveManualVisitProposal(await service.charges.list(), params.data.encounterId);
  if (resolution.conflict) return { status: 409, body: { error: resolution.conflict } };
  if (resolution.proposal?.state === "finalized" || resolution.proposal?.chargeItemRef) {
    return { status: 409, body: { error: "A finalized visit charge cannot be changed." } };
  }
  const procedureConceptKey = body.data.procedureConceptKey;
  if (procedureConceptKey !== null) {
    const activeKeys = new Set((await listActiveVisitProcedureFees(staff.fhir))
      .map((item) => item.procedureConceptKey));
    if (!isVisitProcedureConceptKey(procedureConceptKey) || !activeKeys.has(procedureConceptKey)) {
      return { status: 400, body: { error: "An active visit procedure concept is required." } };
    }
  }
  if (!resolution.proposal && procedureConceptKey === null) {
    return { status: 200, body: { proposal: undefined } };
  }
  const at = deps.now?.() ?? new Date().toISOString();
  const proposal: ChargeProposal = resolution.proposal
    ? {
        ...resolution.proposal,
        ...(procedureConceptKey === null ? {} : { procedureConceptKey }),
        state: procedureConceptKey === null ? "removed" : "accepted",
        provenance: { source: "clinician-entered", actor: staff.staffReference, at },
      }
    : {
        id: `${MANUAL_VISIT_CHARGE_ID_PREFIX}${params.data.encounterId}`,
        encounterId: params.data.encounterId,
        planActionRef: MANUAL_VISIT_PLAN_ACTION_REF,
        procedureConceptKey: procedureConceptKey!,
        units: 1,
        laterality: "OU",
        dxPointers: await initialPrincipalDiagnosisPointers(staff.fhir, params.data.encounterId),
        evidenceRefs: [],
        coverageEvaluations: [],
        state: "accepted",
        provenance: { source: "clinician-entered", actor: staff.staffReference, at },
      };
  return { status: 200, body: { proposal: await service.charges.save(proposal) } };
}

function resolveManualVisitProposal(
  charges: ChargeProposal[],
  encounterId: string,
): { proposal?: ChargeProposal; conflict?: string } {
  const expectedId = `${MANUAL_VISIT_CHARGE_ID_PREFIX}${encounterId}`;
  const encounterCharges = charges.filter((proposal) => proposal.encounterId === encounterId);
  const stable = encounterCharges.find((proposal) => proposal.id === expectedId);
  const stableIsManualVisit = !stable || (
    (stable.protocolApplicationId === undefined || stable.protocolApplicationId === null) &&
    stable.planActionRef === MANUAL_VISIT_PLAN_ACTION_REF &&
    isVisitProcedureConceptKey(stable.procedureConceptKey)
  );
  const manualVisitCandidates = encounterCharges.filter((proposal) =>
    (proposal.planActionRef === MANUAL_VISIT_PLAN_ACTION_REF ||
      isVisitProcedureConceptKey(proposal.procedureConceptKey))
  );
  if (!stableIsManualVisit || manualVisitCandidates.some((proposal) => proposal.id !== expectedId) ||
    manualVisitCandidates.length > 1) {
    return { conflict: "Conflicting manual visit charge identity; no charge was changed." };
  }
  return { proposal: stable };
}

async function initialPrincipalDiagnosisPointers(
  fhir: Pick<LiveFhir, "read">,
  encounterId: string,
): Promise<string[]> {
  const encounter = await fhir.read<Encounter>("Encounter", encounterId);
  const principalReferences = (encounter.diagnosis ?? []).flatMap((diagnosis) => {
    const reference = diagnosis.rank === 1 ? diagnosis.condition.reference : undefined;
    return reference?.match(/^Condition\/[A-Za-z0-9.-]+$/) ? [reference] : [];
  });
  return principalReferences.length === 1 ? principalReferences : [];
}

export async function handleProtocolUnapplyRequest(
  deps: ProtocolEndpointDeps,
  input: { authHeader: string | undefined; params: unknown },
) {
  const staff = await deps.authenticate(input.authHeader);
  if (!staff) return { status: 401, body: { error: "Authentication required to un-apply protocols." } };
  if (!may(staff.actorRole, "chart.write")) return { status: 403, body: { error: "chart.write role required" } };
  const parsed = z.object({ applicationId: z.string().min(1) }).safeParse(input.params);
  if (!parsed.success) return { status: 400, body: { error: "applicationId is required." } };
  try {
    return { status: 200, body: await liveService(staff, deps.now).unapply(parsed.data.applicationId) };
  } catch (error) {
    if (error instanceof AcceptedChargeUnapplyError) {
      return { status: 409, body: { error: error.message } };
    }
    throw error;
  }
}

export async function handleProtocolSignCleanupRequest(
  deps: ProtocolEndpointDeps & { feeScheduleFhir: ProcedureFeeScheduleFhir },
  input: { authHeader: string | undefined; params: unknown },
) {
  const staff = await deps.authenticate(input.authHeader);
  if (!staff) return { status: 401, body: { error: "Authentication required for protocol sign cleanup." } };
  if (!may(staff.actorRole, "clinical.sign")) return { status: 403, body: { error: "clinical.sign role required" } };
  const parsed = z.object({ encounterId: z.string().min(1) }).safeParse(input.params);
  if (!parsed.success) return { status: 400, body: { error: "encounterId is required." } };
  const service = liveService(staff, deps.now);
  const abandoned = await service.abandonOpenForSignedEncounter(parsed.data.encounterId);
  const charges = await materializeAcceptedChargeProposals({
    fhir: staff.fhir as unknown as ProcedureChargeFhir,
    feeScheduleFhir: deps.feeScheduleFhir,
    encounterId: parsed.data.encounterId,
    actorReference: staff.staffReference,
    charges: service.charges,
    applications: service.applications,
    now: deps.now,
  });
  return { status: 200, body: { abandoned, ...charges } };
}

function liveService(
  staff: Staff,
  now?: () => string,
  seriesProtocols: ReadonlyMap<string, SeriesProtocolDefinition> = new Map(),
): ProtocolService {
  return new ProtocolService(staff.fhir, {
    async commitFinding(finding) {
      if (finding.value === undefined) return undefined;
      const observation = finding.findingDefKey === "gonio_angle_structures"
        ? protocolFindingToGonioObservation(finding)
        : protocolFindingObservation(finding);
      const saved = await staff.fhir.create(observation, { "X-ODOS-Source": "protocol-module" });
      return saved.id ? `Observation/${saved.id}` : undefined;
    },
    async materializeAction(action) {
      if (action.actionType === "series-prescription") {
        const seriesProtocolId = String(action.payload.seriesProtocolId ?? "");
        const protocol = seriesProtocols.get(seriesProtocolId);
        if (!protocol) throw new Error(`Series protocol ${seriesProtocolId || "(missing)"} was not resolved before commit.`);
        const identifierValue = `${action.encounterId}:${action.provenance.protocolId}:${action.sourceItemKey}`;
        const saved = await staff.fhir.create({
          ...buildSeriesCarePlan({
            protocol,
            patientReference: `Patient/${action.patientId}`,
            authorReference: action.provenance.actor,
            created: action.provenance.at,
          }),
          identifier: [{
            system: SERIES_CARE_PLAN_SOURCE_IDENTIFIER_SYSTEM,
            value: identifierValue,
          }],
        }, {
          "X-ODOS-Source": "protocol-module",
          "If-None-Exist": `identifier=${SERIES_CARE_PLAN_SOURCE_IDENTIFIER_SYSTEM}|${identifierValue}`,
        });
        if (saved.status === "revoked" && saved.id) {
          await updateProjected(staff.fhir, "CarePlan", saved.id, { ...saved, status: "active" });
        }
        return saved.id ? `CarePlan/${saved.id}` : undefined;
      }
      if (
        action.provenance.protocolId === DRY_EYE_AT_HOME_REGIMEN_INIT_PROTOCOL.id &&
        ["counseling", "education", "instruction"].includes(action.actionType)
      ) {
        return undefined;
      }
      const resource = action.actionType === "order"
        ? serviceRequest(action)
        : carePlan(action);
      const saved = await staff.fhir.create(resource, { "X-ODOS-Source": "protocol-module" });
      return saved.id ? `${saved.resourceType}/${saved.id}` : undefined;
    },
    async removeMaterialized(reference) {
      const [resourceType, id] = reference.split("/");
      if (!id || !["Observation", "ServiceRequest", "CarePlan"].includes(resourceType ?? "")) return;
      if (resourceType === "Observation") {
        const resource = await staff.fhir.read<Observation>("Observation", id);
        await updateProjected(staff.fhir, "Observation", id, { ...resource, status: "entered-in-error" });
      } else if (resourceType === "ServiceRequest") {
        const resource = await staff.fhir.read<ServiceRequest>("ServiceRequest", id);
        await updateProjected(staff.fhir, "ServiceRequest", id, { ...resource, status: "revoked" });
      } else {
        const resource = await staff.fhir.read<CarePlan>("CarePlan", id);
        await updateProjected(staff.fhir, "CarePlan", id, { ...resource, status: "revoked" });
      }
    },
  }, now);
}

async function updateProjected<T extends Observation | ServiceRequest | CarePlan>(
  fhir: LiveFhir,
  resourceType: T["resourceType"],
  id: string,
  resource: T,
): Promise<void> {
  const update = fhir.update as unknown as (
    type: T["resourceType"],
    id: string,
    resource: T,
    headers?: Record<string, string>,
  ) => Promise<T>;
  await update(resourceType, id, resource, { "X-ODOS-Source": "protocol-module" });
}

export function protocolFindingObservation(finding: ProtocolFindingInstance): Observation {
  if (typeof finding.value === "number" && finding.findingDefKey !== "cup_disc_ratio") {
    throw new Error(`Numeric protocol finding ${finding.findingDefKey} requires an explicit unit mapping.`);
  }
  return {
    resourceType: "Observation",
    status: "final",
    code: { coding: [{ system: "https://odos2020.com/fhir/CodeSystem/odos", code: finding.findingDefKey }] },
    subject: { reference: `Patient/${finding.patientId}` },
    encounter: { reference: `Encounter/${finding.encounterId}` },
    effectiveDateTime: finding.provenance.at,
    performer: [{ reference: finding.provenance.actor }],
    ...(finding.laterality ? { bodySite: { coding: [{ system: "https://odos2020.com/fhir/CodeSystem/laterality", code: finding.laterality }] } } : {}),
    ...(typeof finding.value === "number"
      ? { valueQuantity: { value: finding.value, unit: "ratio", code: "1" } }
      : { valueString: String(finding.value) }),
    extension: [{
      url: FINDING_SOURCE_URL,
      valueCode: finding.provenance.source,
    }],
  };
}

function serviceRequest(action: PlanActionInstance): ServiceRequest {
  return {
    resourceType: "ServiceRequest", status: "active", intent: "plan",
    subject: { reference: `Patient/${action.patientId}` },
    encounter: { reference: `Encounter/${action.encounterId}` },
    code: { text: String(action.payload.orderableKey ?? action.sourceItemKey ?? action.actionType) },
    authoredOn: action.provenance.at,
  };
}
function carePlan(action: PlanActionInstance): CarePlan {
  return {
    resourceType: "CarePlan", status: "active", intent: "plan",
    subject: { reference: `Patient/${action.patientId}` },
    encounter: { reference: `Encounter/${action.encounterId}` },
    title: String(action.payload.topicKey ?? action.payload.assetRef ?? action.payload.reason ?? action.sourceItemKey ?? action.actionType),
    created: action.provenance.at,
  };
}
function may(role: PracticeRoleId, action: "chart.read" | "chart.write" | "clinical.sign" | "protocols.author"): boolean {
  try { assertBusinessActionAllowed(role, action); return true; } catch { return false; }
}

function protocolCatalogs(deps: ProtocolEndpointDeps): ProtocolCatalogs {
  return deps.catalogs?.() ?? { findingKeys: new Set(), procedureKeys: new Set() };
}

async function searchAll<T extends Resource>(
  fhir: CaptureFhir,
  resourceType: T["resourceType"],
  params: Record<string, string>,
): Promise<T[]> {
  const resources: T[] = [];
  const visited = new Set<string>();
  // search-contract: protocol-endpoint.search-resources
  let bundle = await fhir.search<T>(resourceType, params);
  while (true) {
    resources.push(...(bundle.entry ?? []).flatMap((entry) => entry.resource ? [entry.resource] : []));
    const next = bundle.link?.find((link) => link.relation === "next")?.url;
    if (!next) return resources;
    if (!fhir.searchUrl) throw new Error("Protocol capture search requires pagination support.");
    if (visited.has(next)) throw new Error("Protocol capture search returned a repeated next link.");
    visited.add(next);
    bundle = await fhir.searchUrl<T>(next, resourceType);
  }
}
