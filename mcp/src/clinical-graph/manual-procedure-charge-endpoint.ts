import { randomUUID } from "node:crypto";
import type { Condition, Encounter } from "@medplum/fhirtypes";
import type { Express } from "express";
import { z } from "zod";
import { assertBusinessActionAllowed, type PracticeRoleId } from "../authz/roles.js";
import {
  isVisitProcedureConceptKey,
  listActiveCodedNonVisitProcedureFees,
  listProcedureFeeScheduleSnapshot,
  type ProcedureFeeScheduleFhir,
} from "./procedure-fee-schedule.js";
import { PROTOCOL_BASIC_CODES, ProtocolBasicStore, type ProtocolFhirClient } from "./protocol-store.js";
import type { ChargeProposal } from "./protocol-types.js";

export const MANUAL_PROCEDURE_CHARGE_ID_PREFIX = "manual-procedure-charge:";

type ManualProcedureChargeFhir = ProcedureFeeScheduleFhir & ProtocolFhirClient;

interface Staff {
  staffReference: string;
  actorRole: PracticeRoleId;
  fhir: ManualProcedureChargeFhir;
}

export interface ManualProcedureChargeEndpointDeps {
  authenticate(authHeader: string | undefined): Promise<Staff | null>;
  id?: () => string;
  now?: () => string;
}

export interface ManualProcedureChargeRouteDeps {
  authenticateService(): Promise<void>;
  authenticateRead: ManualProcedureChargeEndpointDeps["authenticate"];
  authenticateWrite: ManualProcedureChargeEndpointDeps["authenticate"];
  id?: () => string;
  now?: () => string;
}

const encounterParamsSchema = z.object({ encounterId: z.string().min(1) }).strict();
const proposalParamsSchema = encounterParamsSchema.extend({ proposalId: z.string().min(1) }).strict();
const createSchema = z.object({ procedureConceptKey: z.string().min(1) }).strict();
const patchSchema = z.object({
  laterality: z.enum(["OD", "OS", "OU"]).nullable().optional(),
  dxPointer: z.string().regex(/^Condition\/[A-Za-z0-9.-]+$/).nullable().optional(),
  state: z.enum(["accepted", "removed"]).optional(),
}).strict().refine(
  (value) => Object.keys(value).length > 0,
  "At least one procedure charge change is required.",
);

export function registerManualProcedureChargeRoutes(
  app: Express,
  deps: ManualProcedureChargeRouteDeps,
): void {
  app.route("/clinical-graph/protocols/encounters/:encounterId/procedure-charges")
    .get(async (req, res) => {
      try {
        await deps.authenticateService();
        const result = await handleProcedureChargesRequest(
          { authenticate: deps.authenticateRead, id: deps.id, now: deps.now },
          { authHeader: req.header("authorization"), params: req.params },
        );
        res.status(result.status).json(result.body);
      } catch (error) {
        console.error("odos-mcp: procedure charges route failed:", error);
        if (!res.headersSent) res.status(500).json({ error: "procedure charges route failed" });
      }
    })
    .post(async (req, res) => {
      try {
        await deps.authenticateService();
        const result = await handleProcedureChargeCreateRequest(
          { authenticate: deps.authenticateWrite, id: deps.id, now: deps.now },
          { authHeader: req.header("authorization"), params: req.params, body: req.body },
        );
        res.status(result.status).json(result.body);
      } catch (error) {
        console.error("odos-mcp: procedure charge create route failed:", error);
        if (!res.headersSent) res.status(500).json({ error: "procedure charge create route failed" });
      }
    });

  app.patch(
    "/clinical-graph/protocols/encounters/:encounterId/procedure-charges/:proposalId",
    async (req, res) => {
      try {
        await deps.authenticateService();
        const result = await handleProcedureChargePatchRequest(
          { authenticate: deps.authenticateWrite, id: deps.id, now: deps.now },
          { authHeader: req.header("authorization"), params: req.params, body: req.body },
        );
        res.status(result.status).json(result.body);
      } catch (error) {
        console.error("odos-mcp: procedure charge patch route failed:", error);
        if (!res.headersSent) res.status(500).json({ error: "procedure charge patch route failed" });
      }
    },
  );
}

export async function handleProcedureChargesRequest(
  deps: ManualProcedureChargeEndpointDeps,
  input: { authHeader: string | undefined; params: unknown },
) {
  const staff = await deps.authenticate(input.authHeader);
  if (!staff) return { status: 401, body: { error: "Authentication required to read procedure charges." } };
  if (!may(staff.actorRole, "chart.read")) return { status: 403, body: { error: "chart.read role required" } };
  const params = encounterParamsSchema.safeParse(input.params);
  if (!params.success) return { status: 400, body: { error: "A valid encounter is required." } };

  const encounter = await staff.fhir.read<Encounter>("Encounter", params.data.encounterId);
  const store = chargeStore(staff.fhir);
  const [options, diagnoses, proposals, feeSchedule] = await Promise.all([
    listProcedureOptions(staff.fhir),
    encounterDiagnoses(staff.fhir, encounter),
    store.list(),
    listProcedureFeeScheduleSnapshot(staff.fhir),
  ]);
  const displayByConcept = new Map(feeSchedule.map((item) => [item.procedureConceptKey, item.display]));
  return {
    status: 200,
    body: {
      options,
      diagnoses,
      proposals: proposals.filter((proposal) =>
        isManualProcedureProposal(proposal, params.data.encounterId)
      ),
      attachedProcedures: proposals.filter((proposal) =>
        proposal.encounterId === params.data.encounterId &&
        proposal.state !== "removed" &&
        proposal.dxPointers.length > 0
      ).map((proposal) => ({
        proposalId: proposal.id,
        procedureConceptKey: proposal.procedureConceptKey,
        display: displayByConcept.get(proposal.procedureConceptKey) ?? proposal.procedureConceptKey,
        diagnosisReferences: [...proposal.dxPointers],
      })),
    },
  };
}

export async function handleProcedureChargeCreateRequest(
  deps: ManualProcedureChargeEndpointDeps,
  input: { authHeader: string | undefined; params: unknown; body: unknown },
) {
  const staff = await deps.authenticate(input.authHeader);
  if (!staff) return { status: 401, body: { error: "Authentication required to add a procedure charge." } };
  if (!may(staff.actorRole, "chart.write")) return { status: 403, body: { error: "chart.write role required" } };
  const params = encounterParamsSchema.safeParse(input.params);
  const body = createSchema.safeParse(input.body);
  if (!params.success || !body.success) {
    return { status: 400, body: { error: "A valid encounter and procedure concept are required." } };
  }

  const options = await listActiveCodedNonVisitProcedureFees(staff.fhir);
  if (!options.some((option) => option.procedureConceptKey === body.data.procedureConceptKey)) {
    return { status: 400, body: { error: "An active coded non-visit procedure concept is required." } };
  }
  const encounter = await staff.fhir.read<Encounter>("Encounter", params.data.encounterId);
  const id = `${MANUAL_PROCEDURE_CHARGE_ID_PREFIX}${deps.id?.() ?? randomUUID()}`;
  const store = chargeStore(staff.fhir);
  if (await store.get(id)) {
    return { status: 409, body: { error: "Manual procedure charge identity already exists; no charge was changed." } };
  }
  const at = deps.now?.() ?? new Date().toISOString();
  const proposal: ChargeProposal = {
    id,
    encounterId: params.data.encounterId,
    planActionRef: id,
    procedureConceptKey: body.data.procedureConceptKey,
    units: 1,
    dxPointers: principalDiagnosisPointers(encounter),
    evidenceRefs: [],
    coverageEvaluations: [],
    state: "accepted",
    provenance: {
      source: "clinician-entered",
      actor: staff.staffReference,
      at,
    },
  };
  return { status: 201, body: { proposal: await store.save(proposal) } };
}

export async function handleProcedureChargePatchRequest(
  deps: ManualProcedureChargeEndpointDeps,
  input: { authHeader: string | undefined; params: unknown; body: unknown },
) {
  const staff = await deps.authenticate(input.authHeader);
  if (!staff) return { status: 401, body: { error: "Authentication required to edit a procedure charge." } };
  if (!may(staff.actorRole, "chart.write")) return { status: 403, body: { error: "chart.write role required" } };
  const params = proposalParamsSchema.safeParse(input.params);
  const body = patchSchema.safeParse(input.body);
  if (!params.success || !body.success) {
    return { status: 400, body: { error: "A valid procedure charge change is required." } };
  }

  const store = chargeStore(staff.fhir);
  const proposal = await store.get(params.data.proposalId);
  if (!proposal) return { status: 404, body: { error: "Procedure charge proposal not found." } };
  if (!isManualProcedureProposal(proposal, params.data.encounterId)) {
    return { status: 409, body: { error: "Conflicting manual procedure charge identity; no charge was changed." } };
  }
  if (proposal.state === "finalized" || proposal.chargeItemRef) {
    return { status: 409, body: { error: "A finalized procedure charge cannot be changed." } };
  }
  const removalOnly = body.data.state === "removed" &&
    body.data.laterality === undefined && body.data.dxPointer === undefined;
  if (!removalOnly) {
    const options = await listActiveCodedNonVisitProcedureFees(staff.fhir);
    if (!options.some((option) => option.procedureConceptKey === proposal.procedureConceptKey)) {
      return { status: 409, body: { error: "The procedure charge concept is no longer active and coded." } };
    }
  }
  if (body.data.dxPointer !== undefined && body.data.dxPointer !== null) {
    const encounter = await staff.fhir.read<Encounter>("Encounter", params.data.encounterId);
    if (!encounterDiagnosisReferences(encounter).includes(body.data.dxPointer)) {
      return { status: 400, body: { error: "The diagnosis pointer is not present on this encounter." } };
    }
  }

  const at = deps.now?.() ?? new Date().toISOString();
  let updated: ChargeProposal = {
    ...proposal,
    ...(body.data.dxPointer === undefined
      ? {}
      : { dxPointers: body.data.dxPointer === null ? [] : [body.data.dxPointer] }),
    ...(body.data.state === undefined ? {} : { state: body.data.state }),
    provenance: {
      source: "clinician-entered",
      actor: staff.staffReference,
      at,
    },
  };
  if (body.data.laterality === null) {
    const { laterality: _laterality, ...withoutLaterality } = updated;
    updated = withoutLaterality;
  } else if (body.data.laterality !== undefined) {
    updated = { ...updated, laterality: body.data.laterality };
  }
  return { status: 200, body: { proposal: await store.save(updated) } };
}

function chargeStore(fhir: ManualProcedureChargeFhir): ProtocolBasicStore<ChargeProposal> {
  return new ProtocolBasicStore<ChargeProposal>(fhir, PROTOCOL_BASIC_CODES.chargeProposal);
}

function isManualProcedureProposal(proposal: ChargeProposal, encounterId: string): boolean {
  return proposal.id.startsWith(MANUAL_PROCEDURE_CHARGE_ID_PREFIX) &&
    proposal.encounterId === encounterId &&
    (proposal.protocolApplicationId === undefined || proposal.protocolApplicationId === null) &&
    proposal.planActionRef === proposal.id &&
    !isVisitProcedureConceptKey(proposal.procedureConceptKey);
}

async function listProcedureOptions(fhir: ManualProcedureChargeFhir) {
  return (await listActiveCodedNonVisitProcedureFees(fhir)).map((option) => ({
    procedureConceptKey: option.procedureConceptKey,
    display: option.display,
    billingCode: option.billingCode,
  }));
}

async function encounterDiagnoses(fhir: ManualProcedureChargeFhir, encounter: Encounter) {
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

function principalDiagnosisPointers(encounter: Encounter): string[] {
  const principal = (encounter.diagnosis ?? []).flatMap((diagnosis) => {
    const reference = diagnosis.rank === 1 ? diagnosis.condition.reference : undefined;
    return reference?.match(/^Condition\/[A-Za-z0-9.-]+$/) ? [reference] : [];
  });
  return principal.length === 1 ? principal : [];
}

function may(role: PracticeRoleId, action: "chart.read" | "chart.write"): boolean {
  try {
    assertBusinessActionAllowed(role, action);
    return true;
  } catch {
    return false;
  }
}
