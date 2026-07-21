import type { Basic, CarePlan, Condition, Observation, ServiceRequest } from "@medplum/fhirtypes";
import { z } from "zod";
import { assertBusinessActionAllowed, type PracticeRoleId } from "../authz/roles.js";
import { GLAUCOMA_SUSPECT_PROTOCOL } from "./protocol-fixtures.js";
import { matchesCode, ProtocolService } from "./protocol-service.js";
import type { ProtocolFhirClient } from "./protocol-store.js";
import { protocolFindingToGonioObservation } from "./gonioscopy.js";
import type { PlanActionInstance, ProtocolFindingInstance } from "./protocol-types.js";
import {
  materializeAcceptedChargeProposals,
  type ProcedureChargeFhir,
  type ProcedureFeeScheduleFhir,
} from "./procedure-fee-schedule.js";

const FINDING_SOURCE_URL = "https://odos2020.com/fhir/StructureDefinition/finding-source";

interface LiveFhir extends ProtocolFhirClient {
  read<T extends Observation | ServiceRequest | CarePlan | Condition>(resourceType: T["resourceType"], id: string): Promise<T>;
  create<T extends Basic | Observation | ServiceRequest | CarePlan>(resource: T, headers?: Record<string, string>): Promise<T>;
}
interface Staff { staffReference: string; actorRole: PracticeRoleId; fhir: LiveFhir }
export interface ProtocolEndpointDeps {
  authenticate(authHeader: string | undefined): Promise<Staff | null>;
  feeScheduleFhir?: ProcedureFeeScheduleFhir;
  now?: () => string;
}

const diagnosesSchema = z.array(z.object({
  reference: z.string(),
  code: z.string(),
  confirmed: z.boolean(),
}).strict());
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
}).strict();

export async function handleProtocolOffersRequest(
  deps: ProtocolEndpointDeps,
  input: { authHeader: string | undefined; body: unknown },
) {
  const staff = await deps.authenticate(input.authHeader);
  if (!staff) return { status: 401, body: { error: "Authentication required to read protocols." } };
  if (!may(staff.actorRole, "chart.read")) return { status: 403, body: { error: "chart.read role required" } };
  const parsed = z.object({ diagnoses: diagnosesSchema }).strict().safeParse(input.body);
  if (!parsed.success) return { status: 400, body: { error: "Valid diagnoses are required." } };
  return { status: 200, body: { protocols: await liveService(staff, deps.now).offers(parsed.data.diagnoses) } };
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
  if (!await service.definitions.get(GLAUCOMA_SUSPECT_PROTOCOL.id)) {
    await service.definitions.save(GLAUCOMA_SUSPECT_PROTOCOL);
  }
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
  const opened = await service.open(parsed.data.protocolId, {
    encounterId: parsed.data.encounterId,
    patientId: parsed.data.patientId,
    diagnosis: parsed.data.diagnosis,
    actor: staff.staffReference,
  });
  await service.commit(opened.application.id, parsed.data.selections ?? [], [parsed.data.diagnosis.reference]);
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

export async function handleProtocolUnapplyRequest(
  deps: ProtocolEndpointDeps,
  input: { authHeader: string | undefined; params: unknown },
) {
  const staff = await deps.authenticate(input.authHeader);
  if (!staff) return { status: 401, body: { error: "Authentication required to un-apply protocols." } };
  if (!may(staff.actorRole, "chart.write")) return { status: 403, body: { error: "chart.write role required" } };
  const parsed = z.object({ applicationId: z.string().min(1) }).safeParse(input.params);
  if (!parsed.success) return { status: 400, body: { error: "applicationId is required." } };
  return { status: 200, body: await liveService(staff, deps.now).unapply(parsed.data.applicationId) };
}

export async function handleProtocolSignCleanupRequest(
  deps: ProtocolEndpointDeps & { feeScheduleFhir: ProcedureFeeScheduleFhir },
  input: { authHeader: string | undefined; params: unknown },
) {
  const staff = await deps.authenticate(input.authHeader);
  if (!staff) return { status: 401, body: { error: "Authentication required for protocol sign cleanup." } };
  if (!may(staff.actorRole, "chart.write")) return { status: 403, body: { error: "chart.write role required" } };
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

function liveService(staff: Staff, now?: () => string): ProtocolService {
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
function may(role: PracticeRoleId, action: "chart.read" | "chart.write"): boolean {
  try { assertBusinessActionAllowed(role, action); return true; } catch { return false; }
}
