import { z } from "zod";
import type { Encounter } from "@medplum/fhirtypes";
import { staffHasBusinessAction } from "../authz/roles.js";
import type { ExamOverviewEndpointDeps } from "./exam-overview-endpoint.js";
import { FhirEncounterExamScopeStore, type ProposedExamTest } from "./exam-scope-store.js";
import { listProcedureFeeScheduleSnapshot, type ProcedureFeeScheduleItem } from "./procedure-fee-schedule.js";
import { ProtocolBasicStore, PROTOCOL_BASIC_CODES } from "./protocol-store.js";
import type { PlanActionInstance } from "./protocol-types.js";
import { PENDING_ORDERABLES } from "./plan-sets/glaucoma.js";

export interface FollowUpQueueRow {
  orderable: string;
  focus?: string;
  label: string;
  sources: string[];
  state: "for-review" | "already-ordered" | "unavailable";
  actionIds?: string[];
  reason?: string;
}
export type FollowUpQueue = { recorded: false } | { recorded: true; rows: FollowUpQueueRow[] };

export function deriveFollowUpQueue(
  testsProposed: readonly ProposedExamTest[] | undefined,
  fees: readonly ProcedureFeeScheduleItem[],
  actions: readonly PlanActionInstance[],
  encounterId: string,
  patientId: string,
): FollowUpQueue {
  if (testsProposed === undefined) return { recorded: false };
  const active = new Map(fees.filter(fee => fee.active).map(fee => [fee.procedureConceptKey, fee]));
  return { recorded: true, rows: testsProposed.map(test => {
    const fee = active.get(test.orderable);
    const row = {
      orderable: test.orderable, ...(test.focus ? { focus: test.focus } : {}),
      label: test.label ?? (fee ? `${fee.display}${test.focus ? ` — ${test.focus}` : ""}` : test.orderable),
      sources: test.sources.map(source => source.kind === "profile"
        ? `from the ${source.profileLabel ?? source.profileKey} shape`
        : `from the ${source.planSetKey} plan set`),
    };
    const actionIds = actions.filter(action => action.encounterId === encounterId && action.patientId === patientId &&
      action.actionType === "order" && !["removed", "cancelled"].includes(action.state) &&
      action.payload.orderableKey === test.orderable && (action.payload.focus ?? "") === (test.focus ?? "")
    ).map(action => action.id);
    if (actionIds.length) return { ...row, state: "already-ordered", actionIds };
    if (!fee) return { ...row, state: "unavailable", reason: test.unavailableReason ?? (PENDING_ORDERABLES.has(test.orderable)
      ? "On ODOS's pending-orderables list." : "Not in the practice catalogue.") };
    return { ...row, state: "for-review" };
  }) };
}

export async function handleFollowUpQueueRequest(
  deps: Pick<ExamOverviewEndpointDeps, "authenticate" | "serviceFhir">,
  input: { authHeader: string | undefined; params: unknown },
): Promise<{ status: number; body: unknown }> {
  const staff = await deps.authenticate(input.authHeader);
  if (!staff) return { status: 401, body: { error: "Authentication required." } };
  if (!staffHasBusinessAction(staff, "chart.read")) return { status: 403, body: { error: "chart.read role required" } };
  const params = z.object({ encounterId: z.string().regex(/^[A-Za-z0-9.-]+$/) }).safeParse(input.params);
  if (!params.success) return { status: 400, body: { error: "A valid encounter id is required." } };
  const { encounterId } = params.data;
  try {
    const encounter = await staff.fhir.read<Encounter>("Encounter", encounterId);
    if (!encounter.subject?.reference?.match(/^Patient\/[^/]+$/)) return { status: 400, body: { error: "Encounter patient required." } };
    const serviceFhir = deps.serviceFhir ?? staff.fhir;
    const [scope, fees, actions] = await Promise.all([
      new FhirEncounterExamScopeStore(serviceFhir).get(encounterId),
      listProcedureFeeScheduleSnapshot(serviceFhir),
      new ProtocolBasicStore<PlanActionInstance>(staff.fhir, PROTOCOL_BASIC_CODES.planActionInstance).list(),
    ]);
    return { status: 200, body: deriveFollowUpQueue(scope.testsProposed, fees, actions, encounterId, encounter.subject.reference.slice(8)) };
  } catch (error) {
    const status = (error as { status?: unknown; statusCode?: unknown })?.status ?? (error as { statusCode?: unknown })?.statusCode;
    if (status === 401 || status === 403) return { status: 403, body: { error: "Encounter is outside the caller's patient compartment." } };
    if (status === 404 || status === 410) return { status: 404, body: { error: "Encounter was not found." } };
    return { status: 502, body: { error: "The tests for this visit could not be loaded." } };
  }
}
