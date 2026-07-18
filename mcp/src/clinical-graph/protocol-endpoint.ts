import type { Basic, CarePlan, Observation, ServiceRequest } from "@medplum/fhirtypes";
import { z } from "zod";
import { assertBusinessActionAllowed, type PracticeRoleId } from "../authz/roles.js";
import { GLAUCOMA_SUSPECT_PROTOCOL } from "./protocol-fixtures.js";
import { ProtocolService } from "./protocol-service.js";
import type { ProtocolFhirClient } from "./protocol-store.js";
import { protocolFindingToGonioObservation } from "./gonioscopy.js";
import type { PlanActionInstance, ProtocolFindingInstance } from "./protocol-types.js";

const FINDING_SOURCE_URL = "https://odos2020.com/fhir/StructureDefinition/finding-source";

interface LiveFhir extends ProtocolFhirClient {
  read<T extends Observation | ServiceRequest | CarePlan>(resourceType: T["resourceType"], id: string): Promise<T>;
  create<T extends Basic | Observation | ServiceRequest | CarePlan>(resource: T, headers?: Record<string, string>): Promise<T>;
}
interface Staff { staffReference: string; actorRole: PracticeRoleId; fhir: LiveFhir }
export interface ProtocolEndpointDeps {
  authenticate(authHeader: string | undefined): Promise<Staff | null>;
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
  diagnosis: z.object({ reference: z.string(), code: z.string(), confirmed: z.literal(true) }).strict(),
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
  const service = liveService(staff, deps.now);
  if (!await service.definitions.get(GLAUCOMA_SUSPECT_PROTOCOL.id)) {
    await service.definitions.save(GLAUCOMA_SUSPECT_PROTOCOL);
  }
  return { status: 200, body: { protocols: await service.offers(parsed.data.diagnoses) } };
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
      charges: (await service.charges.list()).filter((row) => row.provenance.protocolId === parsed.data.protocolId),
    },
  };
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
  deps: ProtocolEndpointDeps,
  input: { authHeader: string | undefined; params: unknown },
) {
  const staff = await deps.authenticate(input.authHeader);
  if (!staff) return { status: 401, body: { error: "Authentication required for protocol sign cleanup." } };
  if (!may(staff.actorRole, "chart.write")) return { status: 403, body: { error: "chart.write role required" } };
  const parsed = z.object({ encounterId: z.string().min(1) }).safeParse(input.params);
  if (!parsed.success) return { status: 400, body: { error: "encounterId is required." } };
  return { status: 200, body: { abandoned: await liveService(staff, deps.now).abandonOpenForSignedEncounter(parsed.data.encounterId) } };
}

function liveService(staff: Staff, now?: () => string): ProtocolService {
  return new ProtocolService(staff.fhir, {
    async commitFinding(finding) {
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

function protocolFindingObservation(finding: ProtocolFindingInstance): Observation {
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
      : { valueString: finding.value === undefined ? "promptOnly" : String(finding.value) }),
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
