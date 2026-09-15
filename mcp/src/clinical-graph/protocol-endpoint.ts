import { loadDefaultEducationCatalogReader, type EducationCatalogReader } from "../comms/education-catalog.js";
import { ensureBuiltInProtocols } from "./protocol-seeding.js";
import { isPlanItemOffered, unofferedSelectedItems } from "./plan-item-offered.js";
import { FhirProcedureDefinitionStore, type ClinicalProcedureDefinition } from "./procedure-definition-store.js";
import { normalizeApplicationScope } from "../../../src/protocol-application-scope.js";
import { DIAGNOSIS_VISIT_STATUSES } from "./diagnosis-visit-status-store.js";
import type { Basic, Bundle, CarePlan, Condition, Encounter, Observation, Resource, ServiceRequest } from "@medplum/fhirtypes";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { assertBusinessActionAllowed, staffHasBusinessAction, type PracticeRoleId } from "../authz/roles.js";
import type { MedplumClient } from "../fhir-client.js";
import { validateLocalFhirSearchNextPath } from "../fhir-search.js";
import {
  FhirSeriesProtocolDefinitionStore,
  type SeriesProtocolDefinition,
} from "../series-tracker/protocol-definition-store.js";
import {
  buildSeriesCarePlan,
  SERIES_CARE_PLAN_SOURCE_IDENTIFIER_SYSTEM,
} from "../series-tracker/series-care-plan.js";
import {
  BUILTIN_PROTOCOLS,
  BUILTIN_CHARGE_RULES,
  DRY_EYE_AT_HOME_REGIMEN_INIT_PROTOCOL,
} from "./protocol-fixtures.js";
import {
  AcceptedChargeUnapplyError,
  isTappableProtocolItem,
  matchesCode,
  ProtocolActionMaterializationRefusal,
  ProtocolItemAddConflictError,
  ProtocolFollowUpNotFoundError,
  ProtocolPublishValidationError,
  ProtocolService,
  protocolFollowUpDue,
  rankProtocolOffers,
  validateProtocolDefinition,
  type ProtocolCatalogs,
} from "./protocol-service.js";
import type { ProtocolFhirClient } from "./protocol-store.js";
import { protocolFindingToGonioObservation } from "./gonioscopy.js";
import type {
  ChargeProposal,
  PlanActionInstance,
  ProtocolDefinition,
  ProtocolDefinitionDraft,
  ProtocolFindingInstance,
  ProtocolItem,
} from "./protocol-types.js";
import {
  annualRecallMaterializationRefusal,
  materializeAnnualRecallOnSign,
} from "./annual-recall.js";
import {
  isVisitProcedureConceptKey,
  listActiveVisitProcedureFees,
  materializeAcceptedChargeProposals,
  visitProcedureFamily,
  type ProcedureChargeFhir,
  type ProcedureFeeScheduleFhir,
} from "./procedure-fee-schedule.js";

const FINDING_SOURCE_URL = "https://odos2020.com/fhir/StructureDefinition/finding-source";
export const PROTOCOL_FOLLOW_UP_IDENTIFIER_SYSTEM =
  "https://odos2020.com/fhir/NamingSystem/protocol-follow-up-source";
export const PROTOCOL_ACTION_CODE_SYSTEM =
  "https://odos2020.com/fhir/CodeSystem/odos-protocol-module";
export const MANUAL_VISIT_CHARGE_ID_PREFIX = "manual-visit-code:";
export const MANUAL_VISIT_PLAN_ACTION_REF = "manual-visit-code";

interface LiveFhir extends ProtocolFhirClient {
  readonly baseUrl: string;
  read<T extends Resource>(resourceType: T["resourceType"], id: string): Promise<T>;
  search<T extends Resource>(resourceType: T["resourceType"], params?: Record<string, string>): Promise<Bundle<T>>;
  searchUrl?<T extends Resource>(url: string, resourceType: T["resourceType"]): Promise<Bundle<T>>;
  create<T extends Basic | Observation | ServiceRequest | CarePlan>(resource: T, headers?: Record<string, string>): Promise<T>;
  update<T extends Basic | Observation | ServiceRequest | CarePlan>(
    resourceType: T["resourceType"],
    id: string,
    resource: T,
    headers?: Record<string, string>,
  ): Promise<T>;
}
type CaptureFhir = Pick<LiveFhir, "baseUrl" | "read" | "search" | "searchUrl">;
interface Staff { staffReference: string; actorRole: PracticeRoleId; fhir: LiveFhir }
export interface ProtocolEndpointDeps {
  authenticate(authHeader: string | undefined): Promise<Staff | null>;
  feeScheduleFhir?: ProcedureFeeScheduleFhir;
  serviceFhir?: MedplumClient;
  now?: () => string;
  catalogs?: () => ProtocolCatalogs;
  educationCatalog?: EducationCatalogReader;
  loadProcedureDefinitions?: () => Promise<ClinicalProcedureDefinition[]>;
}

const diagnosisVisitStatusSchema = z.enum(DIAGNOSIS_VISIT_STATUSES);
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
  title: z.string().optional(),
  procedureDefinitionKey: z.string().optional(),
  itemType: z.enum([
    "finding-seed", "order", "medication", "counseling", "education",
    "instruction", "follow-up", "series-prescription", "charge-seed",
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
const itemAddSchema = applySchema
  .omit({ selections: true, acceptCharges: true })
  .extend({ itemKey: z.string().min(1) })
  .strict();

export async function handleProtocolLibraryRequest(
  deps: ProtocolEndpointDeps,
  input: { authHeader: string | undefined },
) {
  const staff = await deps.authenticate(input.authHeader);
  if (!staff) return { status: 401, body: { error: "Authentication required to read protocols." } };
  if (!staffHasBusinessAction(staff, "protocols.author")) return { status: 403, body: { error: "protocols.author role required" } };
  const catalogs = protocolCatalogs(deps);
  return {
    status: 200,
    body: {
      protocols: await liveService(staff, deps.now, undefined, deps.educationCatalog).definitions.list(),
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
  if (!staffHasBusinessAction(staff, "protocols.author")) return { status: 403, body: { error: "protocols.author role required" } };
  const parsed = protocolDraftSchema.partial().safeParse(input.body);
  if (!parsed.success) return { status: 400, body: { error: parsed.error.issues[0]?.message ?? "Invalid protocol draft." } };
  const protocol = await liveService(staff, deps.now, undefined, deps.educationCatalog).createDraft(
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
  if (!staffHasBusinessAction(staff, "protocols.author")) return { status: 403, body: { error: "protocols.author role required" } };
  const params = z.object({ id: z.string().min(1) }).strict().safeParse(input.params);
  const body = protocolDraftSchema.safeParse(input.body);
  if (!params.success || !body.success) {
    return { status: 400, body: { error: body.success ? "Protocol id is required." : body.error.issues[0]?.message } };
  }
  const protocol = await liveService(staff, deps.now, undefined, deps.educationCatalog).saveDraft(params.data.id, body.data);
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
  if (!staffHasBusinessAction(staff, "protocols.author")) return { status: 403, body: { error: "protocols.author role required" } };
  const params = z.object({ id: z.string().min(1) }).strict().safeParse(input.params);
  const body = z.object({}).strict().safeParse(input.body ?? {});
  if (!params.success || !body.success) return { status: 400, body: { error: "Valid protocol id and empty publish body are required." } };
  try {
    const protocol = await liveService(staff, deps.now, undefined, deps.educationCatalog).publish(
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
  if (!staffHasBusinessAction(staff, "protocols.author")) return { status: 403, body: { error: "protocols.author role required" } };
  const params = z.object({ id: z.string().min(1) }).strict().safeParse(input.params);
  const body = z.object({}).strict().safeParse(input.body ?? {});
  if (!params.success || !body.success) return { status: 400, body: { error: "Valid protocol id and empty retire body are required." } };
  return { status: 200, body: { protocol: await liveService(staff, deps.now, undefined, deps.educationCatalog).retire(params.data.id) } };
}

export async function handleProtocolForkRequest(
  deps: ProtocolEndpointDeps,
  input: { authHeader: string | undefined; params: unknown; body: unknown },
) {
  const staff = await deps.authenticate(input.authHeader);
  if (!staff) return { status: 401, body: { error: "Authentication required to copy protocols." } };
  if (!staffHasBusinessAction(staff, "protocols.author")) return { status: 403, body: { error: "protocols.author role required" } };
  const params = z.object({ id: z.string().min(1) }).strict().safeParse(input.params);
  const body = z.object({ title: z.string().min(1).optional() }).strict().safeParse(input.body ?? {});
  if (!params.success || !body.success) return { status: 400, body: { error: "Valid protocol id and fork body are required." } };
  return {
    status: 201,
    body: { protocol: await liveService(staff, deps.now, undefined, deps.educationCatalog).fork(params.data.id, staff.staffReference, body.data.title) },
  };
}

export async function handleProtocolCaptureRequest(
  deps: ProtocolEndpointDeps,
  input: { authHeader: string | undefined; params: unknown; body: unknown },
) {
  const staff = await deps.authenticate(input.authHeader);
  if (!staff) return { status: 401, body: { error: "Authentication required to capture protocols." } };
  if (!staffHasBusinessAction(staff, "protocols.author")) return { status: 403, body: { error: "protocols.author role required" } };
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
  const protocol = await liveService(staff, deps.now, undefined, deps.educationCatalog).captureDraft({
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
  if (!staffHasBusinessAction(staff, "chart.read")) return { status: 403, body: { error: "chart.read role required" } };
  const parsed = z.object({ diagnoses: diagnosesSchema }).strict().safeParse(input.body);
  if (!parsed.success) return { status: 400, body: { error: "Valid diagnoses are required." } };
  const service = liveService(staff, deps.now, undefined, deps.educationCatalog);
  const stored = await service.offers(parsed.data.diagnoses);
  const storedIds = new Set((await service.definitions.list()).map((protocol) => protocol.id));
  const offeredDefinitions = await loadOfferedDefinitions(deps, staff);
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
    const blockedItems = unofferedSelectedItems(protocol.items, [], offeredDefinitions);
    return {
      ...protocol,
      items: protocol.items.map(item => ({ ...item, offered: isPlanItemOffered(item, offeredDefinitions) && !blockedItems.has(item.itemKey) })),
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
  if (!staffHasBusinessAction(staff, "chart.write")) return { status: 403, body: { error: "chart.write role required" } };
  const parsed = applySchema.safeParse(input.body);
  if (!parsed.success) return { status: 400, body: { error: parsed.error.issues[0]?.message ?? "Invalid protocol application." } };
  const service = liveService(staff, deps.now, undefined, deps.educationCatalog);
  await ensureBuiltInProtocol(service, parsed.data.protocolId);
  const validation = await validateProtocolDiagnosis(staff, service, parsed.data);
  if ("response" in validation) return validation.response;
  const { protocol } = validation;
  if ((await service.applications.list()).some((application) =>
    application.encounterId === parsed.data.encounterId &&
    application.protocolId === parsed.data.protocolId &&
    application.confirmed && application.undoState === "active" && normalizeApplicationScope(application) === "whole"
  )) return { status: 409, body: { error: "Protocol is already applied to this encounter." } };
  const blockedItems = unofferedSelectedItems(protocol.items, parsed.data.selections ?? [], await loadOfferedDefinitions(deps, staff));
  const selectedPinnedItems = protocol.items.filter(item => !blockedItems.has(item.itemKey)).flatMap((item) => {
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
  const seriesResolution = await resolveSeriesProtocols(
    deps,
    selectedPinnedItems.map(({ item }) => item),
  );
  if ("response" in seriesResolution) return seriesResolution.response;
  const canonicalSelections = parsed.data.selections?.map((selection) => {
    const item = protocol.items.find((candidate) =>
      candidate.itemKey === selection.itemKey &&
      (candidate.itemType === "series-prescription" || candidate.itemType === "charge-seed")
    );
    return item ? { ...selection, payload: item.payload } : selection;
  }) ?? [];
  const offeredSelections = canonicalSelections.filter(selection => !blockedItems.has(selection.itemKey));
  offeredSelections.push(...[...blockedItems].map(itemKey => ({ itemKey, selected: false, skipReason: "not-offered" as const })));
  const opened = await service.open(parsed.data.protocolId, {
    encounterId: parsed.data.encounterId,
    patientId: parsed.data.patientId,
    diagnosis: parsed.data.diagnosis,
    actor: staff.staffReference,
  });
  try {
    await liveService(staff, deps.now, seriesResolution.protocols, deps.educationCatalog).commit(
      opened.application.id,
      offeredSelections,
      [parsed.data.diagnosis.reference],
    );
  } catch (error) {
    if (error instanceof ProtocolItemAddConflictError) {
      return { status: 409, body: { error: error.message } };
    }
    throw error;
  }
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

export async function handleProtocolItemAddRequest(
  deps: ProtocolEndpointDeps,
  input: { authHeader: string | undefined; body: unknown },
) {
  const staff = await deps.authenticate(input.authHeader);
  if (!staff) return { status: 401, body: { error: "Authentication required to add protocol items." } };
  if (!staffHasBusinessAction(staff, "chart.write")) return { status: 403, body: { error: "chart.write role required" } };
  const parsed = itemAddSchema.safeParse(input.body);
  if (!parsed.success) return { status: 400, body: { error: parsed.error.issues[0]?.message ?? "Invalid protocol item add." } };
  const service = liveService(staff, deps.now, undefined, deps.educationCatalog);
  await ensureBuiltInProtocol(service, parsed.data.protocolId);
  const validation = await validateProtocolDiagnosis(staff, service, parsed.data);
  if ("response" in validation) return validation.response;
  const item = validation.protocol.items.find((candidate) => candidate.itemKey === parsed.data.itemKey);
  if (!item) return { status: 400, body: { error: "Protocol item not found." } };
  if (!isTappableProtocolItem(item)) {
    return { status: 400, body: { error: `Protocol item type ${item.itemType} is not tappable.` } };
  }
  if (!isPlanItemOffered(item, await loadOfferedDefinitions(deps, staff))) {
    return { status: 409, body: { error: "Protocol item is not offered by this practice." } };
  }
  const seriesResolution = await resolveSeriesProtocols(deps, [item]);
  if ("response" in seriesResolution) return seriesResolution.response;
  const itemService = liveService(staff, deps.now, seriesResolution.protocols, deps.educationCatalog);
  let added;
  try {
    added = await itemService.addItem(parsed.data.protocolId, parsed.data.itemKey, {
      encounterId: parsed.data.encounterId,
      patientId: parsed.data.patientId,
      diagnosis: parsed.data.diagnosis,
      actor: staff.staffReference,
    });
  } catch (error) {
    if (error instanceof ProtocolItemAddConflictError) {
      return { status: 409, body: { error: error.message } };
    }
    throw error;
  }
  return {
    status: 200,
    body: {
      application: added.application,
      alreadyApplied: added.alreadyApplied,
      findings: (await itemService.findings.list()).filter((row) => row.protocolApplicationId === added.application.id),
      actions: (await itemService.actions.list()).filter((row) => row.protocolApplicationId === added.application.id),
      charges: (await itemService.charges.list()).filter((row) => row.protocolApplicationId === added.application.id),
    },
  };
}

async function validateProtocolDiagnosis(
  staff: Staff,
  service: ProtocolService,
  input: {
    protocolId: string;
    encounterId: string;
    patientId: string;
    diagnosis: { reference: string; code: string; confirmed: true };
  },
): Promise<
  | { protocol: ProtocolDefinition }
  | { response: { status: number; body: { error: string } } }
> {
  const conditionId = input.diagnosis.reference.slice("Condition/".length);
  let condition: Condition;
  try {
    condition = await staff.fhir.read<Condition>("Condition", conditionId);
  } catch {
    return { response: { status: 400, body: { error: "Submitted Condition does not exist." } } };
  }
  const submittedCoding = condition.code?.coding?.find((coding) => coding.code === input.diagnosis.code);
  const protocol = await service.definitions.get(input.protocolId);
  if (!condition.verificationStatus?.coding?.some((coding) => coding.code === "confirmed")) {
    return { response: { status: 400, body: { error: "Condition must be confirmed before applying a protocol." } } };
  }
  if (!submittedCoding) {
    return { response: { status: 400, body: { error: "Submitted diagnosis code does not match the Condition." } } };
  }
  if (condition.subject.reference !== `Patient/${input.patientId}`) {
    return { response: { status: 400, body: { error: "Condition does not belong to the submitted patient." } } };
  }
  if (condition.encounter?.reference && condition.encounter.reference !== `Encounter/${input.encounterId}`) {
    return { response: { status: 400, body: { error: "Condition does not belong to the submitted encounter." } } };
  }
  if (!protocol || protocol.trigger.kind !== "diagnosis" ||
    !protocol.trigger.dxKeys.some((pattern) => matchesCode(input.diagnosis.code, pattern))) {
    return { response: { status: 400, body: { error: "Condition does not match the protocol trigger." } } };
  }
  return { protocol };
}

async function resolveSeriesProtocols(
  deps: ProtocolEndpointDeps,
  items: ProtocolItem[],
): Promise<
  | { protocols: ReadonlyMap<string, SeriesProtocolDefinition> }
  | { response: { status: number; body: { error: string } } }
> {
  const seriesItems = items.filter((item) => item.itemType === "series-prescription");
  const protocols = new Map<string, SeriesProtocolDefinition>();
  if (!seriesItems.length) return { protocols };
  if (!deps.serviceFhir) {
    return {
      response: {
        status: 500,
        body: { error: "Protocol series prescriptions require the service FHIR client." },
      },
    };
  }
  const definitions = await new FhirSeriesProtocolDefinitionStore(deps.serviceFhir, deps.now).list({
    includeArchived: true,
  });
  for (const item of seriesItems) {
    const seriesProtocolId = typeof item.payload.seriesProtocolId === "string"
      ? item.payload.seriesProtocolId.trim()
      : "";
    const definition = definitions.find((candidate) => candidate.id === seriesProtocolId);
    if (!seriesProtocolId || !definition?.active) {
      return {
        response: {
          status: 400,
          body: { error: `Selected series prescription ${item.itemKey} has no active series protocol definition.` },
        },
      };
    }
    protocols.set(seriesProtocolId, definition);
  }
  return { protocols };
}

async function loadOfferedDefinitions(deps: ProtocolEndpointDeps, staff: Staff): Promise<Map<string, ClinicalProcedureDefinition>> {
  const definitions = await (deps.loadProcedureDefinitions?.() ?? new FhirProcedureDefinitionStore(staff.fhir).list());
  return new Map(definitions.map(definition => [definition.stableKey, definition]));
}

async function ensureBuiltInProtocol(service: ProtocolService, protocolId: string): Promise<void> {
  const protocol = BUILTIN_PROTOCOLS.find(candidate => candidate.id === protocolId);
  if (!protocol) return;
  const ruleIds = new Set(protocol.items.filter(item => item.itemType === "charge-seed").flatMap(item =>
    Array.isArray(item.payload.chargeRuleRefs) ? item.payload.chargeRuleRefs : []
  ));
  await ensureBuiltInProtocols(service, { protocols: [protocol], rules: BUILTIN_CHARGE_RULES.filter(rule => ruleIds.has(rule.id)) });
}

export async function handleProtocolApplicationsRequest(
  deps: ProtocolEndpointDeps,
  input: { authHeader: string | undefined; query: unknown },
) {
  const staff = await deps.authenticate(input.authHeader);
  if (!staff) return { status: 401, body: { error: "Authentication required to read protocol applications." } };
  if (!staffHasBusinessAction(staff, "chart.read")) return { status: 403, body: { error: "chart.read role required" } };
  const parsed = z.object({ encounterId: z.string().min(1) }).strict().safeParse(input.query);
  if (!parsed.success) return { status: 400, body: { error: "encounterId is required." } };
  const service = liveService(staff, deps.now, undefined, deps.educationCatalog);
  const applications = (await service.applications.list())
    .filter((application) => application.encounterId === parsed.data.encounterId)
    .map((application) => ({
      id: application.id,
      protocolId: application.protocolId,
      version: application.protocolVersion,
      scope: normalizeApplicationScope(application),
      itemKeys: application.dispositions.filter((row) => row.outcome !== "opted-out").map((row) => row.itemKey),
      confirmed: application.confirmed,
      undoState: application.undoState,
    }));
  const actions = (await service.actions.list()).filter((row) => row.encounterId === parsed.data.encounterId && row.actionType === "follow-up" && !["removed", "cancelled"].includes(row.state));
  return { status: 200, body: { applications, actions } };
}

export async function handleVisitChargeRequest(
  deps: ProtocolEndpointDeps,
  input: { authHeader: string | undefined; params: unknown },
) {
  const staff = await deps.authenticate(input.authHeader);
  if (!staff) return { status: 401, body: { error: "Authentication required to read the visit charge." } };
  if (!staffHasBusinessAction(staff, "chart.read")) return { status: 403, body: { error: "chart.read role required" } };
  const parsed = z.object({ encounterId: z.string().min(1) }).strict().safeParse(input.params);
  if (!parsed.success) return { status: 400, body: { error: "encounterId is required." } };
  const service = liveService(staff, deps.now, undefined, deps.educationCatalog);
  const [charges, diagnoses, options] = await Promise.all([
    service.charges.list(),
    visitChargeDiagnoses(staff.fhir, parsed.data.encounterId),
    listActiveVisitProcedureFees(staff.fhir),
  ]);
  const resolution = resolveManualVisitProposal(charges, parsed.data.encounterId);
  if (resolution.conflict) return { status: 409, body: { error: resolution.conflict } };
  return {
    status: 200,
    body: {
      options,
      diagnoses,
      proposal: resolution.proposal,
      ...(resolution.proposal?.state === "accepted"
        ? {
            selectedProcedureConceptKey: resolution.proposal.procedureConceptKey,
            procedureFamily: visitProcedureFamily(resolution.proposal.procedureConceptKey),
          }
        : {}),
    },
  };
}

async function visitChargeDiagnoses(fhir: Pick<LiveFhir, "read">, encounterId: string) {
  let encounter: Encounter;
  try {
    encounter = await fhir.read<Encounter>("Encounter", encounterId);
  } catch (error) {
    const status = Number((error as { status?: unknown }).status);
    if (status === 404 || status === 410) return [];
    throw error;
  }
  return encounterDiagnoses(fhir, encounter);
}

export async function handleVisitChargeMutationRequest(
  deps: ProtocolEndpointDeps,
  input: { authHeader: string | undefined; params: unknown; body: unknown },
) {
  const staff = await deps.authenticate(input.authHeader);
  if (!staff) return { status: 401, body: { error: "Authentication required to edit the visit charge." } };
  if (!staffHasBusinessAction(staff, "chart.write")) return { status: 403, body: { error: "chart.write role required" } };
  const params = z.object({ encounterId: z.string().min(1) }).strict().safeParse(input.params);
  const body = z.object({
    procedureConceptKey: z.string().min(1).nullable().optional(),
    dxPointer: z.string().regex(/^Condition\/[A-Za-z0-9.-]+$/).nullable().optional(),
  }).strict().refine(
    (value) => Object.keys(value).length > 0,
    "At least one visit charge change is required.",
  ).safeParse(input.body);
  if (!params.success || !body.success) {
    return { status: 400, body: { error: "A valid encounter and visit procedure concept are required." } };
  }
  const service = liveService(staff, deps.now, undefined, deps.educationCatalog);
  const resolution = resolveManualVisitProposal(await service.charges.list(), params.data.encounterId);
  if (resolution.conflict) return { status: 409, body: { error: resolution.conflict } };
  if (resolution.proposal?.state === "finalized" || resolution.proposal?.chargeItemRef) {
    return { status: 409, body: { error: "A finalized visit charge cannot be changed." } };
  }
  const procedureConceptKey = body.data.procedureConceptKey;
  const dxPointer = body.data.dxPointer;
  if (procedureConceptKey !== undefined && procedureConceptKey !== null) {
    const activeKeys = new Set((await listActiveVisitProcedureFees(staff.fhir))
      .map((item) => item.procedureConceptKey));
    if (!isVisitProcedureConceptKey(procedureConceptKey) || !activeKeys.has(procedureConceptKey)) {
      return { status: 400, body: { error: "An active visit procedure concept is required." } };
    }
  }
  if (dxPointer !== undefined && dxPointer !== null) {
    const encounter = await staff.fhir.read<Encounter>("Encounter", params.data.encounterId);
    if (!encounterDiagnosisReferences(encounter).includes(dxPointer)) {
      return { status: 400, body: { error: "The diagnosis pointer is not present on this encounter." } };
    }
  }
  if (!resolution.proposal && procedureConceptKey === undefined) {
    return { status: 404, body: { error: "Visit charge proposal not found." } };
  }
  if (!resolution.proposal && procedureConceptKey === null) {
    return { status: 200, body: { proposal: undefined } };
  }
  const at = deps.now?.() ?? new Date().toISOString();
  const proposal: ChargeProposal = resolution.proposal
    ? {
        ...resolution.proposal,
        ...(procedureConceptKey === undefined || procedureConceptKey === null ? {} : { procedureConceptKey }),
        ...(dxPointer === undefined
          ? {}
          : { dxPointers: dxPointer === null ? [] : [dxPointer] }),
        ...(procedureConceptKey === undefined
          ? {}
          : { state: procedureConceptKey === null ? "removed" : "accepted" }),
        provenance: { source: "clinician-entered", actor: staff.staffReference, at },
      }
    : {
        id: `${MANUAL_VISIT_CHARGE_ID_PREFIX}${params.data.encounterId}`,
        encounterId: params.data.encounterId,
        planActionRef: MANUAL_VISIT_PLAN_ACTION_REF,
        procedureConceptKey: procedureConceptKey!,
        units: 1,
        laterality: "OU",
        dxPointers: dxPointer === undefined
          ? await initialPrincipalDiagnosisPointers(staff.fhir, params.data.encounterId)
          : dxPointer === null ? [] : [dxPointer],
        evidenceRefs: [],
        coverageEvaluations: [],
        state: "accepted",
        provenance: { source: "clinician-entered", actor: staff.staffReference, at },
      };
  const saved = await service.charges.save(proposal);
  return {
    status: 200,
    body: {
      proposal: saved,
      ...(saved.state === "accepted"
        ? { procedureFamily: visitProcedureFamily(saved.procedureConceptKey) }
        : {}),
    },
  };
}

async function encounterDiagnoses(fhir: Pick<LiveFhir, "read">, encounter: Encounter) {
  const diagnoses = [];
  for (const diagnosis of encounter.diagnosis ?? []) {
    const reference = diagnosis.condition.reference;
    const match = reference?.match(/^Condition\/([A-Za-z0-9.-]+)$/);
    if (!reference || !match) continue;
    const condition = await fhir.read<Condition>("Condition", match[1]!);
    diagnoses.push({
      reference,
      display: conditionDisplay(condition, reference),
      ...(diagnosis.rank === undefined ? {} : { rank: diagnosis.rank }),
    });
  }
  return diagnoses.sort((left, right) =>
    (left.rank ?? Number.MAX_SAFE_INTEGER) - (right.rank ?? Number.MAX_SAFE_INTEGER)
  );
}

function conditionDisplay(condition: Condition, fallback: string): string {
  return condition.code?.text ??
    condition.code?.coding?.find((coding) => coding.display)?.display ??
    condition.code?.coding?.find((coding) => coding.code)?.code ??
    fallback;
}

function encounterDiagnosisReferences(encounter: Encounter): string[] {
  return (encounter.diagnosis ?? []).flatMap((diagnosis) => {
    const reference = diagnosis.condition.reference;
    return reference?.match(/^Condition\/[A-Za-z0-9.-]+$/) ? [reference] : [];
  });
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

export async function handleProtocolFollowUpConfirmRequest(
  deps: ProtocolEndpointDeps,
  input: { authHeader: string | undefined; params: unknown; body: unknown },
) {
  const staff = await deps.authenticate(input.authHeader);
  if (!staff) return { status: 401, body: { error: "Authentication required to confirm follow-up." } };
  if (!staffHasBusinessAction(staff, "chart.write")) return { status: 403, body: { error: "chart.write role required" } };
  const params = z.object({ encounterId: z.string().min(1), actionId: z.string().min(1) }).strict().safeParse(input.params);
  const body = z.union([z.object({}).strict(), z.object({ interval: z.number().int().positive(), unit: z.enum(["days", "weeks", "months"]), reason: z.string().trim().min(1).optional() }).strict()]).safeParse(input.body);
  if (!params.success || !body.success) return { status: 400, body: { error: "Valid encounter, action, and follow-up are required." } };
  const service = liveService(staff, deps.now, undefined, deps.educationCatalog);
  try {
    return { status: 200, body: { action: await service.confirmFollowUp(params.data.encounterId, params.data.actionId, staff.staffReference,
      "interval" in body.data ? body.data : undefined) } };
  } catch (error) {
    if (error instanceof ProtocolFollowUpNotFoundError) {
      return { status: 404, body: { error: error.message } };
    }
    throw error;
  }
}

export async function handleProtocolUnapplyRequest(
  deps: ProtocolEndpointDeps,
  input: { authHeader: string | undefined; params: unknown },
) {
  const staff = await deps.authenticate(input.authHeader);
  if (!staff) return { status: 401, body: { error: "Authentication required to un-apply protocols." } };
  if (!staffHasBusinessAction(staff, "chart.write")) return { status: 403, body: { error: "chart.write role required" } };
  const parsed = z.object({ applicationId: z.string().min(1) }).safeParse(input.params);
  if (!parsed.success) return { status: 400, body: { error: "applicationId is required." } };
  try {
    return { status: 200, body: await liveService(staff, deps.now, undefined, deps.educationCatalog).unapply(parsed.data.applicationId) };
  } catch (error) {
    if (error instanceof AcceptedChargeUnapplyError || error instanceof ProtocolItemAddConflictError) {
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
  if (!staffHasBusinessAction(staff, "clinical.sign")) return { status: 403, body: { error: "clinical.sign role required" } };
  const parsed = z.object({ encounterId: z.string().min(1) }).safeParse(input.params);
  if (!parsed.success) return { status: 400, body: { error: "encounterId is required." } };
  const service = liveService(staff, deps.now, undefined, deps.educationCatalog);
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
  let annualRecall;
  try {
    annualRecall = await materializeAnnualRecallOnSign(
      staff.fhir,
      parsed.data.encounterId,
      deps.now?.() ?? new Date().toISOString(),
    );
  } catch (error) {
    annualRecall = annualRecallMaterializationRefusal(error);
  }
  return {
    status: 200,
    body: {
      abandoned,
      ...charges,
      ...(annualRecall.fullExam === true || annualRecall.materializationRefusal
        ? { annualRecall }
        : {}),
    },
  };
}

function liveService(
  staff: Staff,
  now?: () => string,
  seriesProtocols: ReadonlyMap<string, SeriesProtocolDefinition> = new Map(),
  educationCatalog?: EducationCatalogReader,
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
      if (action.actionType === "follow-up") {
        return materializeProtocolFollowUp(staff.fhir, action);
      }
      const resource = action.actionType === "order"
        ? serviceRequest(action)
        : carePlan(action, educationCatalog);
      const saved = await staff.fhir.create(resource, { "X-ODOS-Source": "protocol-module" });
      return saved.id ? `${saved.resourceType}/${saved.id}` : undefined;
    },
    async removeMaterialized(reference) {
      const [resourceType, id] = reference.split("/");
      if (!id || !["Observation", "ServiceRequest", "CarePlan"].includes(resourceType ?? "")) return;
      if (resourceType === "Observation") {
        const resource = await staff.fhir.read<Observation>("Observation", id);
        const revoked = await updateProjected(staff.fhir, "Observation", id, { ...resource, status: "entered-in-error" });
        return projectionRestore(staff.fhir, "Observation", id, resource, revoked.meta?.versionId);
      } else if (resourceType === "ServiceRequest") {
        const resource = await staff.fhir.read<ServiceRequest>("ServiceRequest", id);
        const revoked = await updateProjected(staff.fhir, "ServiceRequest", id, { ...resource, status: "revoked" });
        return projectionRestore(staff.fhir, "ServiceRequest", id, resource, revoked.meta?.versionId);
      } else {
        const resource = await staff.fhir.read<CarePlan>("CarePlan", id);
        const revoked = await updateProjected(staff.fhir, "CarePlan", id, { ...resource, status: "revoked" });
        return projectionRestore(staff.fhir, "CarePlan", id, resource, revoked.meta?.versionId);
      }
    },
  }, now);
}

async function updateProjected<T extends Observation | ServiceRequest | CarePlan>(
  fhir: LiveFhir,
  resourceType: T["resourceType"],
  id: string,
  resource: T,
  headers?: Record<string, string>,
): Promise<T> {
  const update = fhir.update as unknown as (
    type: T["resourceType"],
    id: string,
    resource: T,
    headers?: Record<string, string>,
  ) => Promise<T>;
  return update(resourceType, id, resource, { "X-ODOS-Source": "protocol-module", ...headers });
}

function projectionRestore<T extends Observation | ServiceRequest | CarePlan>(
  fhir: LiveFhir,
  resourceType: T["resourceType"],
  id: string,
  resource: T,
  revokedVersion: string | undefined,
): () => Promise<void> {
  return async () => {
    if (!revokedVersion) throw new Error(`Projection rollback refused for ${resourceType}/${id}: revoke returned no versionId.`);
    try {
      await updateProjected(fhir, resourceType, id, resource, { "If-Match": `W/"${revokedVersion}"` });
    } catch (error) {
      throw new Error(`Projection rollback failed for ${resourceType}/${id}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }
  };
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
    ...(typeof action.payload.focus === "string" ? { bodySite: [{ text: action.payload.focus }], orderDetail: [{ text: action.payload.focus }] } : {}),
    authoredOn: action.provenance.at,
  };
}

function followUpServiceRequest(action: PlanActionInstance): ServiceRequest {
  const interval = action.payload.interval;
  const unit = action.payload.unit;
  const reason = action.payload.reason;
  const explicitKind = action.payload.followUpKind;
  if (!Number.isSafeInteger(interval) || Number(interval) <= 0 || !["days", "weeks", "months"].includes(String(unit))) {
    throw new ProtocolActionMaterializationRefusal(
      "FOLLOW_UP_INTERVAL_INVALID",
      "Follow-up interval must be a positive integer in supported units.",
    );
  }
  if (typeof reason !== "string" || reason.trim().length === 0) {
    throw new ProtocolActionMaterializationRefusal(
      "FOLLOW_UP_REASON_REQUIRED",
      "Follow-up reason is required.",
    );
  }
  if (explicitKind !== undefined && explicitKind !== "medical" && explicitKind !== "routine") {
    throw new ProtocolActionMaterializationRefusal(
      "FOLLOW_UP_KIND_UNDERIVABLE",
      "Follow-up kind must be medical or routine.",
    );
  }
  const kind = explicitKind ?? (action.linkedDx.length > 0 ? "medical" : undefined);
  if (!kind) {
    throw new ProtocolActionMaterializationRefusal(
      "FOLLOW_UP_KIND_UNDERIVABLE",
      "Follow-up kind must be medical or routine.",
    );
  }
  const due = new Date(action.provenance.at);
  if (Number.isNaN(due.getTime())) {
    throw new ProtocolActionMaterializationRefusal(
      "FOLLOW_UP_PROVENANCE_INVALID",
      "Follow-up provenance time is invalid.",
    );
  }
  due.setTime(protocolFollowUpDue(action.payload, action.provenance.at));
  if (Number.isNaN(due.getTime())) {
    throw new ProtocolActionMaterializationRefusal(
      "FOLLOW_UP_INTERVAL_OVERFLOW",
      "Follow-up interval produces an invalid due date.",
    );
  }
  return {
    resourceType: "ServiceRequest",
    status: "active",
    intent: "plan",
    subject: { reference: `Patient/${action.patientId}` },
    encounter: { reference: `Encounter/${action.encounterId}` },
    authoredOn: action.provenance.at,
    occurrenceDateTime: due.toISOString().slice(0, 10),
    code: { coding: [{ system: PROTOCOL_ACTION_CODE_SYSTEM, code: "follow-up" }] },
    category: [{ coding: [{ system: PROTOCOL_ACTION_CODE_SYSTEM, code: `${kind}-follow-up` }] }],
    reasonCode: [{ text: reason }],
  };
}

export async function materializeProtocolFollowUp(
  fhir: LiveFhir,
  action: PlanActionInstance,
): Promise<string | undefined> {
  // Omitting application identity deliberately revives or updates the prior request, matching the series CarePlan precedent.
  const identifierValue = `${action.encounterId}:${action.provenance.protocolId}:${action.sourceItemKey}`;
  const intended: ServiceRequest = {
    ...followUpServiceRequest(action),
    identifier: [{ system: PROTOCOL_FOLLOW_UP_IDENTIFIER_SYSTEM, value: identifierValue }],
  };
  const saved = await fhir.create(intended, {
    "X-ODOS-Source": "protocol-module",
    "If-None-Exist": `identifier=${PROTOCOL_FOLLOW_UP_IDENTIFIER_SYSTEM}|${identifierValue}`,
  });
  if (saved.id && !Object.entries(intended).every(([key, value]) =>
    isDeepStrictEqual((saved as unknown as Record<string, unknown>)[key], value)
  )) {
    await updateProjected(fhir, "ServiceRequest", saved.id, { ...saved, ...intended });
  }
  return saved.id ? `ServiceRequest/${saved.id}` : undefined;
}
function carePlan(action: PlanActionInstance, catalog?: EducationCatalogReader): CarePlan {
  const education = action.actionType === "education"
    ? (catalog ?? loadDefaultEducationCatalogReader()).get(String(action.payload.assetRef ?? "")) : undefined;
  return {
    resourceType: "CarePlan", status: "active", intent: "plan",
    subject: { reference: `Patient/${action.patientId}` },
    encounter: { reference: `Encounter/${action.encounterId}` },
    title: education?.title ?? String(action.payload.topicKey ?? action.payload.assetRef ?? action.payload.reason ?? action.sourceItemKey ?? action.actionType),
    ...(action.actionType === "counseling" && typeof action.payload.narrativeTemplate === "string" ? { description: action.payload.narrativeTemplate } : {}),
    ...(action.actionType === "education" ? { note: [{ text: "Handout recorded; delivery is not yet tracked" }] } : {}),
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
    const path = validateLocalFhirSearchNextPath(next, fhir.baseUrl, resourceType);
    if (visited.has(path)) throw new Error("Protocol capture search returned a repeated next link.");
    visited.add(path);
    bundle = await fhir.searchUrl<T>(path, resourceType);
  }
}
