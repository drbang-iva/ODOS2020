import type {
  Claim,
  ClaimResponse,
  HumanName,
  Location,
  Organization,
  Patient,
  Practitioner,
  PractitionerRole,
  Resource,
  Task,
} from "@medplum/fhirtypes";
import {
  CLAIM_REJECTED_CODE_SYSTEM,
  ERA_WORKLIST_CODE_SYSTEM,
  ERA_WORKLIST_STATUS_SYSTEM,
} from "./era-worklist.js";

export const CLAIM_SEARCH_STATUSES = [
  "submitted",
  "accepted",
  "queued",
  "rejected",
  "paid",
  "denied",
  "underpaid",
] as const;

export type ClaimSearchStatus = (typeof CLAIM_SEARCH_STATUSES)[number];

export interface ClaimSearchFilters {
  patientReferences?: ReadonlySet<string>;
  claim?: string;
  status?: ClaimSearchStatus;
  carrier?: string;
  office?: string;
  cpt?: string;
  minAmountCents?: number;
  maxAmountCents?: number;
}

export interface ClaimSearchRow {
  claimReference: string;
  claimNumber: string;
  patientReference: string;
  patient: string;
  providerReference: string;
  provider: string;
  cptCodes: string[];
  totalChargedCents: number;
  insurancePaidCents: number;
  patientResponsibilityCents: number;
  status: ClaimSearchStatus;
  payerReference: string;
  payer: string;
  officeReference?: string;
  office?: string;
  daysSinceSubmission: number;
}

export function isClaimSearchStatus(value: string): value is ClaimSearchStatus {
  return CLAIM_SEARCH_STATUSES.includes(value as ClaimSearchStatus);
}

export function projectClaimSearchResults(input: {
  claims: readonly Claim[];
  responses: readonly ClaimResponse[];
  tasks: readonly Task[];
  relatedResources: readonly Resource[];
  submittedClaimReferences: ReadonlySet<string>;
  filters?: ClaimSearchFilters;
  at: string;
}): ClaimSearchRow[] {
  const filters = input.filters ?? {};
  const resources = new Map(
    input.relatedResources.flatMap((resource) => resource.id
      ? [[`${resource.resourceType}/${resource.id}`, resource] as const]
      : []),
  );
  const responsesByClaim = groupResponsesByClaim(input.responses);
  const taskStatusByClaim = deriveTaskStatuses(input.tasks, input.responses);

  return input.claims
    .flatMap((claim) => projectClaim(
      claim,
      responsesByClaim,
      taskStatusByClaim,
      resources,
      input.submittedClaimReferences,
      input.at,
    ))
    .filter((row) => matchesFilters(row, filters))
    .sort((a, b) => b.daysSinceSubmission - a.daysSinceSubmission || a.claimNumber.localeCompare(b.claimNumber));
}

function projectClaim(
  claim: Claim,
  responsesByClaim: ReadonlyMap<string, ClaimResponse[]>,
  taskStatusByClaim: ReadonlyMap<string, ClaimSearchStatus>,
  resources: ReadonlyMap<string, Resource>,
  submittedClaimReferences: ReadonlySet<string>,
  at: string,
): ClaimSearchRow[] {
  if (!claim.id || !claim.patient.reference || !claim.provider?.reference || !claim.insurer?.reference) return [];
  const claimReference = `Claim/${claim.id}`;
  const responses = responsesByClaim.get(claimReference) ?? [];
  const paymentResponse = newestResponse(responses.filter((response) => response.payment?.amount));
  const latestResponse = newestResponse(responses);
  const facilityReference = claim.facility?.reference;
  const status = taskStatusByClaim.get(claimReference)
    ?? responseStatus(latestResponse, paymentResponse, submittedClaimReferences.has(claimReference));
  if (!status) return [];
  return [{
    claimReference,
    claimNumber: claim.identifier?.find((identifier) => identifier.value)?.value ?? claim.id,
    patientReference: claim.patient.reference,
    patient: referenceLabel(claim.patient.reference, claim.patient.display, resources),
    providerReference: claim.provider.reference,
    provider: referenceLabel(claim.provider.reference, claim.provider.display, resources),
    cptCodes: unique((claim.item ?? []).flatMap((item) => item.productOrService.coding?.flatMap((coding) => coding.code ? [coding.code] : []) ?? [])),
    totalChargedCents: moneyToCents(claim.total?.value),
    insurancePaidCents: moneyToCents(paymentResponse?.payment?.amount?.value),
    patientResponsibilityCents: patientResponsibilityCents(paymentResponse),
    status,
    payerReference: claim.insurer.reference,
    payer: referenceLabel(claim.insurer.reference, claim.insurer.display, resources),
    ...(facilityReference ? {
      officeReference: facilityReference,
      office: referenceLabel(facilityReference, claim.facility?.display, resources),
    } : {}),
    daysSinceSubmission: elapsedDays(claim.created, at),
  }];
}

function matchesFilters(row: ClaimSearchRow, filters: ClaimSearchFilters): boolean {
  if (filters.patientReferences && !filters.patientReferences.has(row.patientReference)) return false;
  if (filters.claim && !includesAny([row.claimReference, row.claimNumber], filters.claim)) return false;
  if (filters.status && row.status !== filters.status) return false;
  if (filters.carrier && !includesAny([row.payerReference, row.payer], filters.carrier)) return false;
  if (filters.office && !includesAny([row.officeReference ?? "", row.office ?? ""], filters.office)) return false;
  if (filters.cpt && !row.cptCodes.some((code) => normalized(code) === normalized(filters.cpt ?? ""))) return false;
  if (filters.minAmountCents !== undefined && row.totalChargedCents < filters.minAmountCents) return false;
  if (filters.maxAmountCents !== undefined && row.totalChargedCents > filters.maxAmountCents) return false;
  return true;
}

function groupResponsesByClaim(responses: readonly ClaimResponse[]): Map<string, ClaimResponse[]> {
  const grouped = new Map<string, ClaimResponse[]>();
  for (const response of responses) {
    const claimReference = response.request?.reference;
    if (!claimReference) continue;
    grouped.set(claimReference, [...(grouped.get(claimReference) ?? []), response]);
  }
  return grouped;
}

function deriveTaskStatuses(
  tasks: readonly Task[],
  responses: readonly ClaimResponse[],
): Map<string, ClaimSearchStatus> {
  const claimByResponse = new Map<string, string>(
    responses.flatMap((response) => response.id && response.request?.reference
      ? [[`ClaimResponse/${response.id}`, response.request.reference] as const]
      : []),
  );
  const statuses = new Map<string, ClaimSearchStatus>();
  for (const task of tasks) {
    if (!isOpenTask(task)) continue;
    const code = worklistCode(task);
    const focus = task.focus?.reference;
    const claimReference = focus?.startsWith("Claim/") ? focus : focus ? claimByResponse.get(focus) : undefined;
    if (!claimReference || !code) continue;
    const status = code === "era-denial"
      ? "denied"
      : code === "era-underpayment"
        ? "underpaid"
        : code === "claim-rejected"
          ? "rejected"
          : undefined;
    if (status && statusPriority(status) > statusPriority(statuses.get(claimReference))) {
      statuses.set(claimReference, status);
    }
  }
  return statuses;
}

function responseStatus(
  latestResponse: ClaimResponse | undefined,
  paymentResponse: ClaimResponse | undefined,
  submitted: boolean,
): ClaimSearchStatus | undefined {
  if (moneyToCents(paymentResponse?.payment?.amount?.value) > 0) return "paid";
  if (!latestResponse) return submitted ? "submitted" : undefined;
  if (latestResponse.outcome === "error") return "rejected";
  if (latestResponse.outcome === "queued") return "queued";
  return "accepted";
}

function patientResponsibilityCents(response: ClaimResponse | undefined): number {
  return response?.item?.reduce((claimTotal, item) => claimTotal + item.adjudication.reduce(
    (itemTotal, adjudication) => normalized(adjudication.category.text ?? "") === "patient responsibility"
      ? itemTotal + moneyToCents(adjudication.amount?.value)
      : itemTotal,
    0,
  ), 0) ?? 0;
}

function newestResponse(responses: readonly ClaimResponse[]): ClaimResponse | undefined {
  return [...responses].sort((a, b) => responseTime(b) - responseTime(a))[0];
}

function responseTime(response: ClaimResponse): number {
  return Date.parse(response.created ?? response.meta?.lastUpdated ?? "") || 0;
}

function isOpenTask(task: Task): boolean {
  const status = task.businessStatus?.coding?.find((coding) => coding.system === ERA_WORKLIST_STATUS_SYSTEM)?.code;
  return status === "new" || status === "in-review";
}

function worklistCode(task: Task): string | undefined {
  return task.code?.coding?.find((coding) =>
    coding.system === ERA_WORKLIST_CODE_SYSTEM || coding.system === CLAIM_REJECTED_CODE_SYSTEM,
  )?.code;
}

function statusPriority(status: ClaimSearchStatus | undefined): number {
  if (status === "denied") return 3;
  if (status === "underpaid") return 2;
  if (status === "rejected") return 1;
  return 0;
}

function referenceLabel(
  reference: string,
  display: string | undefined,
  resources: ReadonlyMap<string, Resource>,
): string {
  const resource = resources.get(reference);
  if (resource?.resourceType === "Patient" || resource?.resourceType === "Practitioner") {
    return humanName(resource.name?.[0]) || display || reference;
  }
  if (resource?.resourceType === "Organization" || resource?.resourceType === "Location") {
    return resource.name || display || reference;
  }
  if (resource?.resourceType === "PractitionerRole") {
    return resource.code?.[0]?.text ?? resource.code?.[0]?.coding?.[0]?.display ?? display ?? reference;
  }
  return display || reference;
}

function humanName(name: HumanName | undefined): string {
  return [...(name?.prefix ?? []), ...(name?.given ?? []), name?.family, ...(name?.suffix ?? [])]
    .filter(Boolean)
    .join(" ");
}

function includesAny(values: readonly string[], query: string): boolean {
  const needle = normalized(query);
  return values.some((value) => normalized(value).includes(needle));
}

function normalized(value: string): string {
  return value.trim().toLowerCase();
}

function moneyToCents(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.round(value * 100) : 0;
}

function elapsedDays(created: string, at: string): number {
  const elapsed = Date.parse(at) - Date.parse(created);
  return Number.isFinite(elapsed) ? Math.max(0, Math.floor(elapsed / 86_400_000)) : 0;
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

type RelatedClaimResource = Patient | Practitioner | PractitionerRole | Organization | Location;

export function isRelatedClaimResource(resource: Resource): resource is RelatedClaimResource {
  return ["Patient", "Practitioner", "PractitionerRole", "Organization", "Location"].includes(resource.resourceType);
}
