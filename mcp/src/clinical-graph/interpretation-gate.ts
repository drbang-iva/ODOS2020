import type { DiagnosticReport, Media } from "@medplum/fhirtypes";
import { conceptInterpreted, readImagingResources } from "./follow-up-queue-endpoint.js";
import { imagingCategory } from "./imaging-endpoint.js";
import { listProcedureFeeScheduleSnapshot, type ProcedureFeeScheduleFhir, type ProcedureFeeScheduleItem } from "./procedure-fee-schedule.js";
import type { ChargeProposal, PlanActionInstance } from "./protocol-types.js";
import type { ExamOverviewFhirClient } from "./exam-overview-endpoint.js";

export type InterpretationBlockReason = "duplicate-fee" | "unclassified-fee" | "needs-interpretation" | "no-interpreted-result";
export interface InterpretationBlock {
  proposalId: string;
  procedureConceptKey: string;
  label: string;
  reason: InterpretationBlockReason;
}

export function interpretationBlocks(input: {
  encounterId: string;
  proposals: readonly ChargeProposal[];
  actions: readonly PlanActionInstance[];
  fees: readonly ProcedureFeeScheduleItem[];
  mediaRows: readonly Media[];
  reports: readonly DiagnosticReport[];
}): InterpretationBlock[] {
  const byKey = new Map<string, ProcedureFeeScheduleItem[]>();
  for (const fee of input.fees) byKey.set(fee.procedureConceptKey, [...(byKey.get(fee.procedureConceptKey) ?? []), fee]);
  const validMedia = input.mediaRows.filter(media => media.status === "completed" &&
    media.encounter?.reference === `Encounter/${input.encounterId}`);
  const validReports = input.reports.filter(report => report.encounter?.reference === `Encounter/${input.encounterId}` &&
    ["final", "amended", "corrected"].includes(report.status) && Boolean(report.conclusion?.trim()));
  const blocks: InterpretationBlock[] = [];
  for (const proposal of input.proposals) {
    if (proposal.encounterId !== input.encounterId || proposal.state !== "accepted") continue;
    const definitions = byKey.get(proposal.procedureConceptKey) ?? [];
    const live = definitions[0]?.interpretation ?? "unanswered";
    const snap = proposal.interpretation?.answer;
    const label = definitions[0]?.display ?? proposal.procedureConceptKey;
    let reason: InterpretationBlockReason | undefined;
    if (definitions.length > 1) {
      reason = "duplicate-fee";
    } else {
      const imageTypes = new Set(["visual-field", "fundus-photo", "anterior-segment-photo", "oct", "biometry"]);
      const imageType = imageTypes.has(snap ?? "") ? snap : imageTypes.has(live) ? live : undefined;
      if (!imageType) {
        if (snap === "unanswered" || live === "unanswered") reason = "unclassified-fee";
      } else {
        const orders = new Set(input.actions.filter(action => action.encounterId === input.encounterId &&
          action.actionType === "order" && action.payload.orderableKey === proposal.procedureConceptKey &&
          !["removed", "cancelled"].includes(action.state))
          .flatMap(action => action.materializedFhirRef?.match(/^ServiceRequest\/[A-Za-z0-9.-]+$/) ? [action.materializedFhirRef] : []));
        if (orders.size) {
          if (!conceptInterpreted(orders, validMedia, validReports)) reason = "needs-interpretation";
        } else if (!validReports.some(report => report.media?.some(link => validMedia.some(media =>
          link.link.reference === `Media/${media.id}` && imagingCategory(media) === imageType)))) {
          reason = "no-interpreted-result";
        }
      }
    }
    if (reason) blocks.push({ proposalId: proposal.id, procedureConceptKey: proposal.procedureConceptKey, label, reason });
  }
  return blocks;
}

const sentence = (block: InterpretationBlock): string => {
  switch (block.reason) {
    case "needs-interpretation": return `${block.label} needs an interpretation and report before this visit can be signed (or remove its charge).`;
    case "no-interpreted-result": return `${block.label} was charged but has no interpreted result on this visit.`;
    case "unclassified-fee": return `Classify ${block.label} in the fee schedule (does it need an interpretation?) before this visit can be signed.`;
    case "duplicate-fee": return `${block.label} has duplicate fee definitions; fix the fee schedule before signing.`;
  }
};

export class InterpretationRequiredError extends Error {
  constructor(readonly tests: readonly InterpretationBlock[]) {
    super(tests.map(sentence).join(" "));
  }
}

export async function loadInterpretationBlocks(input: {
  encounterId: string;
  proposals: readonly ChargeProposal[];
  actions: { list(): Promise<PlanActionInstance[]> };
  fhir: ExamOverviewFhirClient;
  feeScheduleFhir: ProcedureFeeScheduleFhir;
}): Promise<InterpretationBlock[]> {
  if (!input.proposals.some(row => row.encounterId === input.encounterId && row.state === "accepted")) return [];
  const [actions, fees, imaging] = await Promise.all([
    input.actions.list(),
    listProcedureFeeScheduleSnapshot(input.feeScheduleFhir),
    readImagingResources(input.fhir, input.encounterId),
  ]);
  return interpretationBlocks({ encounterId: input.encounterId, proposals: input.proposals, actions, fees, ...imaging });
}
