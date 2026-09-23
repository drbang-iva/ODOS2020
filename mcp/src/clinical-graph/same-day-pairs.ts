import type { Encounter } from "@medplum/fhirtypes";
import { collectBoundedSearch } from "../fhir-search.js";
import type { ExamOverviewFhirClient } from "./exam-overview-endpoint.js";
import { chargeImageType, type ImageType } from "./interpretation-gate.js";
import type { ProcedureFeeScheduleItem } from "./procedure-fee-schedule.js";
import { ProtocolBasicStore, PROTOCOL_BASIC_CODES } from "./protocol-store.js";
import type { ChargeProposal } from "./protocol-types.js";

export const SAME_DAY_EXCLUSIVE_PAIRS: readonly { types: readonly [ImageType, ImageType]; message: string; citations: readonly string[] }[] = [{
  types: ["oct", "fundus-photo"],
  message: "Usually not billed together on the same day — document why both were needed.",
  citations: ["NCCI mutually exclusive pair (state table R-d)", "Palmetto GBA A56825", "Novitas L35038"],
}];

export function serviceDay(encounter: Encounter): string | undefined {
  return encounter.period?.start?.match(/^\d{4}-\d{2}-\d{2}/)?.[0];
}

export function sameDayWarnings(input: {
  proposals: readonly ChargeProposal[];
  fees: readonly ProcedureFeeScheduleItem[];
}): Map<string, string> {
  const typed = input.proposals.filter(proposal => proposal.state === "accepted" || proposal.state === "finalized")
    .map(proposal => ({ id: proposal.id, type: chargeImageType(proposal, input.fees) }));
  const warnings = new Map<string, string>();
  for (const pair of SAME_DAY_EXCLUSIVE_PAIRS) {
    if (!pair.types.every(type => typed.some(proposal => proposal.type === type))) continue;
    for (const proposal of typed) {
      if (proposal.type && pair.types.includes(proposal.type)) warnings.set(proposal.id, pair.message);
    }
  }
  return warnings;
}

export async function loadSameDayWarnings(input: {
  fhir: ExamOverviewFhirClient;
  encounter: Encounter;
  patientId: string;
  fees: readonly ProcedureFeeScheduleItem[];
}): Promise<Map<string, string>> {
  const day = serviceDay(input.encounter);
  if (!day) return new Map();
  const bundle = await input.fhir.search<Encounter>("Encounter", { subject: `Patient/${input.patientId}`, _count: "100" });
  const encounters = await collectBoundedSearch<Encounter>(input.fhir, "Encounter", bundle, { maxPages: 100, maxRows: 5_000 });
  const ids = new Set(encounters.filter(encounter => encounter.subject?.reference === `Patient/${input.patientId}` && serviceDay(encounter) === day).map(encounter => encounter.id));
  const proposals = (await new ProtocolBasicStore<ChargeProposal>(input.fhir, PROTOCOL_BASIC_CODES.chargeProposal).list())
    .filter(proposal => ids.has(proposal.encounterId));
  return sameDayWarnings({ proposals, fees: input.fees });
}
