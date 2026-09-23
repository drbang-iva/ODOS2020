import type { ChargeItem, DiagnosticReport, Encounter, Media } from "@medplum/fhirtypes";
import { searchBounded, type FhirSearchClient } from "../fhir-search.js";
import { chargeImageType, type ImageType } from "../clinical-graph/interpretation-gate.js";
import { imagingCategory } from "../clinical-graph/imaging-endpoint.js";
import { serviceDay } from "../clinical-graph/same-day-pairs.js";
import { HCPCS_CODE_SYSTEM, listProcedureFeeScheduleSnapshot, PROCEDURE_CONCEPT_SYSTEM, type ProcedureFeeScheduleItem } from "../clinical-graph/procedure-fee-schedule.js";
import { ProtocolBasicStore, PROTOCOL_BASIC_CODES, type ProtocolFhirClient } from "../clinical-graph/protocol-store.js";
import type { ChargeProposal } from "../clinical-graph/protocol-types.js";

const proposalIdentifierSystem = "https://odos2020.com/fhir/NamingSystem/charge-proposal-charge-item";
const bounds = { maxPages: 100, maxRows: 5_000 };

export interface ClaimHoldContext {
  proposals: readonly ChargeProposal[];
  fees: readonly ProcedureFeeScheduleItem[];
  failedProposalIds: ReadonlySet<string>;
}

export interface HeldClaimLine {
  index: number;
  reference?: string;
  label: string;
  reason: "needs-interpretation" | "unclassified";
  message: string;
}

export function claimProposalId(line: ChargeItem): string | undefined {
  return line.identifier?.find(identifier => identifier.system === proposalIdentifierSystem)?.value;
}

export function claimLineRequirement(line: ChargeItem, ctx: ClaimHoldContext):
  { kind: "none" } | { kind: "type"; types: ImageType[] } | { kind: "unclassified"; label: string; message?: string } {
  const proposalId = claimProposalId(line);
  if (proposalId) {
    if (ctx.failedProposalIds.has(proposalId)) {
      const label = lineLabel(line, ctx);
      return { kind: "unclassified", label,
        message: `${label} was held: its interpretation requirement could not be classified because charge proposals could not be loaded.` };
    }
    const proposal = ctx.proposals.find(candidate => candidate.id === proposalId);
    if (proposal) {
      const type = chargeImageType(proposal, ctx.fees);
      return type ? { kind: "type", types: [type] } : { kind: "none" };
    }
  }
  const concept = line.code.coding?.find(coding => coding.system === PROCEDURE_CONCEPT_SYSTEM)?.code;
  const conceptFees = concept ? ctx.fees.filter(fee => fee.procedureConceptKey === concept) : [];
  const fees = conceptFees.length ? conceptFees : ctx.fees.filter(fee => {
    const code = fee.billingCode;
    if (!code) return false;
    return line.code.coding?.some(coding => coding.code?.trim().toUpperCase() === code &&
      (coding.system === HCPCS_CODE_SYSTEM || coding.system === "urn:ama:cpt"));
  });
  if (fees.some(fee => !fee.interpretation)) {
    return { kind: "unclassified", label: fees[0]?.display ?? lineLabel(line, ctx) };
  }
  const types = [...new Set(fees.flatMap(fee => {
    const type = fee.interpretation;
    return type && type !== "not-required" ? [type] : [];
  }))];
  return types.length ? { kind: "type", types } : { kind: "none" };
}

function lineLabel(line: ChargeItem, ctx: ClaimHoldContext): string {
  const proposal = ctx.proposals.find(row => row.id === claimProposalId(line));
  const concept = proposal?.procedureConceptKey ?? line.code.coding?.find(coding => coding.system === PROCEDURE_CONCEPT_SYSTEM)?.code;
  return ctx.fees.find(fee => fee.procedureConceptKey === concept)?.display
    ?? line.code.text ?? line.code.coding?.find(coding => coding.display)?.display
    ?? line.code.coding?.find(coding => coding.code)?.code ?? "Charge";
}

export async function loadClaimHoldContext(fhir: FhirSearchClient, lines: readonly ChargeItem[]): Promise<ClaimHoldContext> {
  const fees = await listProcedureFeeScheduleSnapshot(fhir);
  const ids = [...new Set(lines.map(claimProposalId).filter((id): id is string => Boolean(id)))];
  const store = new ProtocolBasicStore<ChargeProposal>(fhir as unknown as ProtocolFhirClient, PROTOCOL_BASIC_CODES.chargeProposal);
  const proposals: ChargeProposal[] = [];
  const failedProposalIds = new Set<string>();
  await Promise.all(ids.map(async id => {
    try {
      const proposal = await store.get(id);
      if (proposal) proposals.push(proposal);
    } catch {
      failedProposalIds.add(id);
    }
  }));
  return { fees, proposals, failedProposalIds };
}

export async function loadClaimAdvisoryProposals(fhir: FhirSearchClient): Promise<ChargeProposal[]> {
  return new ProtocolBasicStore<ChargeProposal>(fhir as unknown as ProtocolFhirClient, PROTOCOL_BASIC_CODES.chargeProposal).list();
}

export async function claimServiceEncounters(fhir: FhirSearchClient, patientReference: string, day: string): Promise<Encounter[]> {
  if (!day) return [];
  const rows = await searchBounded<Encounter>(fhir, "Encounter", { subject: patientReference, _count: "100" }, bounds);
  return rows.filter(row => row.subject?.reference === patientReference && serviceDay(row) === day);
}

export async function loadClaimEvidence(fhir: FhirSearchClient, patientReference: string, day: string): Promise<Set<ImageType>> {
  const encounters = await claimServiceEncounters(fhir, patientReference, day);
  const evidence = new Set<ImageType>();
  for (const encounter of encounters) {
    if (!encounter.id) continue;
    const reference = `Encounter/${encounter.id}`;
    const [media, reports] = await Promise.all([
      searchBounded<Media>(fhir, "Media", { encounter: reference, _count: "100" }, bounds),
      searchBounded<DiagnosticReport>(fhir, "DiagnosticReport", { encounter: reference, _count: "100" }, bounds),
    ]);
    for (const report of reports) {
      if (report.encounter?.reference !== reference || !["final", "amended", "corrected"].includes(report.status) || !report.conclusion?.trim()) continue;
      for (const row of media) {
        if (!row.id || row.status !== "completed" || row.encounter?.reference !== reference ||
          !report.media?.some(link => link.link.reference === `Media/${row.id}`)) continue;
        const type = imagingCategory(row);
        if (type === "visual-field" || type === "fundus-photo" || type === "anterior-segment-photo" || type === "oct" || type === "biometry") evidence.add(type);
      }
    }
  }
  return evidence;
}

export function holdLines<T extends ChargeItem>(lines: readonly T[], evidence: ReadonlySet<ImageType>, ctx: ClaimHoldContext): { kept: T[]; held: HeldClaimLine[] } {
  const kept: T[] = [];
  const held: HeldClaimLine[] = [];
  lines.forEach((line, index) => {
    const requirement = claimLineRequirement(line, ctx);
    if (requirement.kind === "none" || requirement.kind === "type" && requirement.types.some(type => evidence.has(type))) {
      kept.push(line);
      return;
    }
    const label = requirement.kind === "unclassified" ? requirement.label : lineLabel(line, ctx);
    held.push({ index, ...(line.id ? { reference: `ChargeItem/${line.id}` } : {}), label,
      reason: requirement.kind === "unclassified" ? "unclassified" : "needs-interpretation",
      message: requirement.kind === "unclassified"
        ? requirement.message ?? `${label} was held: classify it in the fee schedule (does it need an interpretation?).`
        : `${label} was held: it needs an interpretation and report on this visit.`,
    });
  });
  return { kept, held };
}
