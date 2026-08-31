import type {
  Appointment,
  Address,
  Basic,
  Coverage,
  Patient,
  Practitioner,
  RelatedPerson,
  Resource,
} from "@medplum/fhirtypes";
import { practiceDate, practiceDayRange } from "../desk/day-ledger.js";
import type { MedplumClient } from "../fhir-client.js";
import {
  coverageCobApplicability,
  type CobApplicability,
} from "../insurance/cob-applicability.js";
import { collectAllPages, type PaginatedFhir } from "../watchers/fhir-pagination.js";

export type EligibilityCheckResult = "ACTIVE" | "INACTIVE" | "INVESTIGATE" | "FAILED";
export type PreventWatcherId = "W21" | "W22" | "W23";

export interface EligibilityCandidate {
  key: string;
  appointmentReference: string;
  appointmentAt: string;
  patientReference: string;
  patientDisplay: string;
  coverageReference: string;
  payerReference: string;
  payerDisplay: string;
  intendedPayerId: string;
  chartMemberId: string;
  cobApplicability: CobApplicability;
  eligibilityRequest: Record<string, unknown> & { submitterTransactionIdentifier: string };
  discoveryRequest: Record<string, unknown>;
}

export interface EligibilityFinding {
  key: string;
  watcherId: PreventWatcherId;
  appointmentReference: string;
  appointmentAt: string;
  patientReference: string;
  patientDisplay: string;
  coverageReference: string;
  payerReference: string;
  payerDisplay: string;
  intendedPayerId: string;
  sourceOccurredAt: string;
  eligibilityCheckResult?: EligibilityCheckResult;
  coverageEnd?: string;
  aaaCodes?: string[];
  cob?: {
    status: "mismatch" | "could-not-check";
    reason?: string;
    returnedPrimaryPayerId?: string;
    returnedPrimaryPayerDisplay?: string;
  };
  memberIdProposal?: {
    current: string;
    proposed: string;
    source: "insurance-discovery";
  };
  discoveryId?: string;
}

export interface EligibilitySweepState {
  date: string;
  status: "submitted" | "processing" | "healthy" | "failed";
  lastAttemptAt: string;
  lastSuccessfulAt?: string;
  batchIds: string[];
  expectedChecks: number;
  pendingDiscoveryIds?: Record<string, string>;
  failureDetail?: string;
}

export interface EligibilitySweepStore {
  loadState(date: string): Promise<EligibilitySweepState | undefined>;
  saveState(state: EligibilitySweepState): Promise<void>;
  loadCandidates(date: string): Promise<EligibilityCandidate[]>;
  loadFindings(date: string): Promise<EligibilityFinding[]>;
  replaceFindings(date: string, findings: EligibilityFinding[]): Promise<void>;
}

export interface PreventiveStediClient {
  submitBatchEligibility(input: { items: unknown[]; name: string; maxRetryHours?: number }): Promise<unknown>;
  getBatchEligibilityItems(batchId: string, input?: { pageSize?: number; pageToken?: string }): Promise<unknown>;
  pollBatchEligibility(input: { batchId: string; pageSize?: number; pageToken?: string }): Promise<unknown>;
  checkCoordinationOfBenefits(payload: unknown): Promise<unknown>;
  submitInsuranceDiscovery(payload: unknown): Promise<unknown>;
  getInsuranceDiscoveryResults(discoveryId: string): Promise<unknown>;
}

export interface EligibilitySweepTickInput {
  store: EligibilitySweepStore;
  stedi: PreventiveStediClient;
  date: string;
  now: string;
}

const BATCH_LIMIT = 10_000;
const TERMINAL_STATES = new Set(["COMPLETED", "COMPLETED_WITH_ERRORS", "VALIDATION_FAILED"]);
const TARGET_AAA_CODES = new Set(["71", "72", "74", "75"]);

export async function runEligibilitySweepTick(input: EligibilitySweepTickInput): Promise<void> {
  const prior = await input.store.loadState(input.date);
  if (prior?.status === "healthy") return;
  try {
    if (prior?.pendingDiscoveryIds && Object.keys(prior.pendingDiscoveryIds).length > 0) {
      await pollPendingDiscoveries(input, prior);
      return;
    }
    if (!prior || (prior.status === "failed" && prior.batchIds.length === 0)) {
      await submitSweep(input, prior?.lastSuccessfulAt);
      return;
    }
    await pollAndIngestSweep(input, prior);
  } catch (error) {
    await input.store.saveState({
      date: input.date,
      status: "failed",
      lastAttemptAt: input.now,
      ...(prior?.lastSuccessfulAt ? { lastSuccessfulAt: prior.lastSuccessfulAt } : {}),
      batchIds: prior?.batchIds ?? [],
      expectedChecks: prior?.expectedChecks ?? 0,
      failureDetail: safeErrorMessage(error),
    });
    throw error;
  }
}

async function submitSweep(input: EligibilitySweepTickInput, lastSuccessfulAt?: string): Promise<void> {
  const candidates = uniqueCandidates(await input.store.loadCandidates(input.date));
  if (candidates.length === 0) {
    await input.store.replaceFindings(input.date, []);
    await input.store.saveState({
      date: input.date,
      status: "healthy",
      lastAttemptAt: input.now,
      lastSuccessfulAt: input.now,
      batchIds: [],
      expectedChecks: 0,
    });
    return;
  }
  const batchIds: string[] = [];
  for (let offset = 0; offset < candidates.length; offset += BATCH_LIMIT) {
    const chunk = candidates.slice(offset, offset + BATCH_LIMIT);
    const result = record(await input.stedi.submitBatchEligibility({
      items: chunk.map((candidate) => candidate.eligibilityRequest),
      name: batchName(input.date, offset / BATCH_LIMIT),
      maxRetryHours: 8,
    }));
    const batchId = text(result.batchId);
    if (!batchId) throw new Error("Stedi batch eligibility response omitted batchId.");
    batchIds.push(batchId);
  }
  await input.store.saveState({
    date: input.date,
    status: "submitted",
    lastAttemptAt: input.now,
    ...(lastSuccessfulAt ? { lastSuccessfulAt } : {}),
    batchIds,
    expectedChecks: candidates.length,
  });
}

async function pollAndIngestSweep(input: EligibilitySweepTickInput, state: EligibilitySweepState): Promise<void> {
  const statuses = (await Promise.all(
    state.batchIds.map((batchId) => collectPages((pageToken) =>
      input.stedi.getBatchEligibilityItems(batchId, { pageSize: 1000, ...(pageToken ? { pageToken } : {}) })
    )),
  )).flat();
  if (statuses.length < state.expectedChecks || statuses.some((item) => !TERMINAL_STATES.has(text(item.state)))) {
    await input.store.saveState({ ...state, status: "processing", lastAttemptAt: input.now });
    return;
  }

  const results = (await Promise.all(
    state.batchIds.map((batchId) => collectPages((pageToken) =>
      input.stedi.pollBatchEligibility({ batchId, pageSize: 200, ...(pageToken ? { pageToken } : {}) })
    )),
  )).flat();
  const candidates = uniqueCandidates(await input.store.loadCandidates(input.date));
  const statusByKey = indexByTransactionIdentifier(statuses);
  const resultByKey = indexByTransactionIdentifier(results);
  const findings: EligibilityFinding[] = [];
  const pendingDiscoveryIds: Record<string, string> = {};

  for (const candidate of candidates) {
    const transactionId = candidate.eligibilityRequest.submitterTransactionIdentifier;
    const status = statusByKey.get(transactionId) ?? {};
    const result = resultByKey.get(transactionId) ?? {};
    const eligibilityCheckResult = eligibilityResult(status);
    const coverageEnd = coverageEndDate(result);
    if (eligibilityCheckResult !== "ACTIVE" || (coverageEnd && coverageEnd < input.date)) {
      findings.push(baseFinding(candidate, "W21", input.now, {
        ...(eligibilityCheckResult ? { eligibilityCheckResult } : { eligibilityCheckResult: "FAILED" as const }),
        ...(coverageEnd ? { coverageEnd } : {}),
      }));
    }

    const cobFinding = await evaluateCob(input.stedi, candidate, result, input.now);
    if (cobFinding) findings.push(cobFinding);

    const aaaCodes = targetAaaCodes(status, result);
    if (aaaCodes.length > 0) {
      const w23 = baseFinding(candidate, "W23", input.now, { aaaCodes });
      const discovery = record(await input.stedi.submitInsuranceDiscovery(candidate.discoveryRequest));
      const discoveryId = text(discovery.discoveryId);
      const proposal = memberIdProposal(candidate, discovery);
      if (proposal) w23.memberIdProposal = proposal;
      if (text(discovery.status) === "PENDING" && discoveryId) {
        w23.discoveryId = discoveryId;
        pendingDiscoveryIds[w23.key] = discoveryId;
      }
      findings.push(w23);
    }
  }

  await input.store.replaceFindings(input.date, dedupeFindings(findings));
  const hasPendingDiscovery = Object.keys(pendingDiscoveryIds).length > 0;
  await input.store.saveState({
    ...state,
    status: hasPendingDiscovery ? "processing" : "healthy",
    lastAttemptAt: input.now,
    ...(!hasPendingDiscovery ? { lastSuccessfulAt: input.now } : {}),
    ...(hasPendingDiscovery ? { pendingDiscoveryIds } : { pendingDiscoveryIds: undefined }),
  });
}

async function pollPendingDiscoveries(
  input: EligibilitySweepTickInput,
  state: EligibilitySweepState,
): Promise<void> {
  const findings = await input.store.loadFindings(input.date);
  const pending: Record<string, string> = {};
  for (const [findingKey, discoveryId] of Object.entries(state.pendingDiscoveryIds ?? {})) {
    const result = record(await input.stedi.getInsuranceDiscoveryResults(discoveryId));
    if (text(result.status) === "PENDING") {
      pending[findingKey] = discoveryId;
      continue;
    }
    const finding = findings.find((candidate) => candidate.key === findingKey);
    if (!finding) continue;
    const candidate = (await input.store.loadCandidates(input.date)).find(
      (value) => findingKey.startsWith(`${value.key}:`),
    );
    if (!candidate) continue;
    const proposal = memberIdProposal(candidate, result);
    if (proposal) finding.memberIdProposal = proposal;
    delete finding.discoveryId;
  }
  await input.store.replaceFindings(input.date, findings);
  const hasPending = Object.keys(pending).length > 0;
  await input.store.saveState({
    ...state,
    status: hasPending ? "processing" : "healthy",
    lastAttemptAt: input.now,
    ...(!hasPending ? { lastSuccessfulAt: input.now } : {}),
    ...(hasPending ? { pendingDiscoveryIds: pending } : { pendingDiscoveryIds: undefined }),
  });
}

async function evaluateCob(
  stedi: PreventiveStediClient,
  candidate: EligibilityCandidate,
  eligibility: Record<string, unknown>,
  now: string,
): Promise<EligibilityFinding | undefined> {
  if (candidate.cobApplicability !== "supported") {
    return baseFinding(candidate, "W22", now, {
      cob: { status: "could-not-check", reason: candidate.cobApplicability },
    });
  }
  const subscriber = record(eligibility.subscriber);
  if (Object.keys(subscriber).length === 0) {
    return baseFinding(candidate, "W22", now, {
      cob: { status: "could-not-check", reason: "eligibility-unavailable" },
    });
  }
  const request = {
    subscriber: structuredClone(subscriber),
    ...(isRecord(eligibility.dependent) ? { dependent: structuredClone(eligibility.dependent) } : {}),
    encounter: { dateOfService: candidate.appointmentAt.slice(0, 10), serviceTypeCode: "30" },
    provider: structuredClone(record(candidate.eligibilityRequest.provider)),
    tradingPartnerServiceId: candidate.intendedPayerId,
  };
  const response = record(await stedi.checkCoordinationOfBenefits(request));
  const summary = record(response.coordinationOfBenefits);
  const primary = cobPrimary(response);
  if (primary?.id && primary.id !== candidate.intendedPayerId) {
    return baseFinding(candidate, "W22", now, {
      cob: {
        status: "mismatch",
        returnedPrimaryPayerId: primary.id,
        ...(primary.display ? { returnedPrimaryPayerDisplay: primary.display } : {}),
      },
    });
  }
  if (text(summary.classification) === "CobInstanceExistsPrimacyUndetermined") {
    return baseFinding(candidate, "W22", now, {
      cob: { status: "could-not-check", reason: "primacy-undetermined" },
    });
  }
  return undefined;
}

function baseFinding(
  candidate: EligibilityCandidate,
  watcherId: PreventWatcherId,
  now: string,
  extra: Partial<EligibilityFinding>,
): EligibilityFinding {
  return {
    key: `${candidate.key}:${watcherId}`,
    watcherId,
    appointmentReference: candidate.appointmentReference,
    appointmentAt: candidate.appointmentAt,
    patientReference: candidate.patientReference,
    patientDisplay: candidate.patientDisplay,
    coverageReference: candidate.coverageReference,
    payerReference: candidate.payerReference,
    payerDisplay: candidate.payerDisplay,
    intendedPayerId: candidate.intendedPayerId,
    sourceOccurredAt: now,
    ...extra,
  };
}

async function collectPages(load: (pageToken?: string) => Promise<unknown>): Promise<Record<string, unknown>[]> {
  const items: Record<string, unknown>[] = [];
  let pageToken: string | undefined;
  do {
    const page = record(await load(pageToken));
    if (Array.isArray(page.items)) items.push(...page.items.filter(isRecord));
    pageToken = text(page.nextPageToken) || undefined;
  } while (pageToken);
  return items;
}

function indexByTransactionIdentifier(items: Record<string, unknown>[]): Map<string, Record<string, unknown>> {
  return new Map(items.flatMap((item) => {
    const key = text(item.submitterTransactionIdentifier)
      || text(record(record(item.additionalInfo).eligibility).submitterTransactionIdentifier);
    return key ? [[key, item] as const] : [];
  }));
}

function eligibilityResult(status: Record<string, unknown>): EligibilityCheckResult | undefined {
  const value = text(status.eligibilityCheckResult)
    || text(record(record(status.additionalInfo).eligibility).eligibilityCheckResult);
  return value === "ACTIVE" || value === "INACTIVE" || value === "INVESTIGATE" || value === "FAILED"
    ? value
    : text(status.state) === "COMPLETED_WITH_ERRORS" || text(status.state) === "VALIDATION_FAILED"
      ? "FAILED"
      : undefined;
}

function targetAaaCodes(...values: Record<string, unknown>[]): string[] {
  const codes = new Set<string>();
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (!isRecord(value)) return;
    if (typeof value.code === "string" && TARGET_AAA_CODES.has(value.code)) codes.add(value.code);
    for (const child of Object.values(value)) visit(child);
  };
  for (const value of values) visit(value);
  return [...codes].sort();
}

function coverageEndDate(result: Record<string, unknown>): string | undefined {
  const dateInfo = record(result.planDateInformation);
  const raw = text(dateInfo.planEnd) || text(dateInfo.eligibilityEnd) || text(dateInfo.policyExpiration);
  if (/^\d{8}$/.test(raw)) return `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}`;
  return /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : undefined;
}

function cobPrimary(response: Record<string, unknown>): { id?: string; display?: string } | undefined {
  const benefits = Array.isArray(response.benefitsInformation)
    ? response.benefitsInformation.filter(isRecord)
    : [];
  for (const benefit of benefits) {
    if (text(benefit.code) !== "R") continue;
    const entities = Array.isArray(benefit.benefitsRelatedEntities)
      ? benefit.benefitsRelatedEntities.filter(isRecord)
      : [];
    const payer = entities.find((entity) => text(entity.entityIdentifier) === "Primary Payer");
    if (!payer) continue;
    return {
      id: text(payer.entityIdentificationValue) || undefined,
      display: text(payer.entityName) || undefined,
    };
  }
  return undefined;
}

function memberIdProposal(
  candidate: EligibilityCandidate,
  discovery: Record<string, unknown>,
): EligibilityFinding["memberIdProposal"] | undefined {
  const items = Array.isArray(discovery.items) ? discovery.items.filter(isRecord) : [];
  const proposed = items.map((item) => text(record(item.subscriber).memberId)).find(Boolean);
  if (!proposed || proposed === candidate.chartMemberId) return undefined;
  return { current: candidate.chartMemberId, proposed, source: "insurance-discovery" };
}

function uniqueCandidates(candidates: EligibilityCandidate[]): EligibilityCandidate[] {
  return [...new Map(candidates.map((candidate) => [candidate.key, candidate])).values()];
}

function dedupeFindings(findings: EligibilityFinding[]): EligibilityFinding[] {
  return [...new Map(findings.map((finding) => [finding.key, finding])).values()];
}

function batchName(date: string, index: number): string {
  return `odos-${date.replaceAll("-", "")}-${index + 1}`;
}

function safeErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.slice(0, 300);
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function record(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

export const ELIGIBILITY_SWEEP_CODE_SYSTEM = "https://odos2020.com/fhir/CodeSystem/eligibility-sweep";
export const ELIGIBILITY_SWEEP_IDENTIFIER_SYSTEM = "https://odos2020.com/fhir/NamingSystem/eligibility-sweep";
const ELIGIBILITY_SWEEP_STATE_EXTENSION_URL = "https://odos2020.com/fhir/StructureDefinition/eligibility-sweep-state";
const ELIGIBILITY_SWEEP_FINDING_EXTENSION_URL = "https://odos2020.com/fhir/StructureDefinition/eligibility-sweep-finding";
const INACTIVE_APPOINTMENT_STATUSES = new Set(["cancelled", "noshow", "entered-in-error"]);

export interface EligibilitySweepFhir extends PaginatedFhir, Pick<MedplumClient, "read" | "create" | "update"> {}

export function createFhirEligibilitySweepStore(
  fhir: EligibilitySweepFhir,
  timeZone: string,
): EligibilitySweepStore {
  return {
    loadState: async (date) => {
      const resources = await collectAllPages<Basic>(
        fhir,
        "Basic",
        { identifier: `${ELIGIBILITY_SWEEP_IDENTIFIER_SYSTEM}|state:${date}`, _count: "2" },
        `eligibility sweep state ${date}`,
      );
      if (resources.length > 1) throw new Error(`Eligibility sweep ${date} has duplicate state resources.`);
      return resources[0] ? parseStateResource(resources[0]) : undefined;
    },
    saveState: async (state) => {
      const resources = await collectAllPages<Basic>(
        fhir,
        "Basic",
        { identifier: `${ELIGIBILITY_SWEEP_IDENTIFIER_SYSTEM}|state:${state.date}`, _count: "2" },
        `eligibility sweep state ${state.date}`,
      );
      if (resources.length > 1) throw new Error(`Eligibility sweep ${state.date} has duplicate state resources.`);
      const resource = stateResource(state, resources[0]);
      if (resource.id) await fhir.update("Basic", resource.id, resource);
      else await fhir.create(resource, {
        "If-None-Exist": `identifier=${ELIGIBILITY_SWEEP_IDENTIFIER_SYSTEM}|state:${state.date}`,
      });
    },
    loadCandidates: (date) => loadEligibilityCandidates(fhir, date, timeZone),
    loadFindings: async (date) => (await loadFindingResources(fhir, date)).map((value) => value.finding),
    replaceFindings: async (date, findings) => {
      const existing = await loadFindingResources(fhir, date, true);
      const byKey = new Map(existing.map((value) => [value.finding.key, value.resource]));
      const activeKeys = new Set(findings.map((finding) => finding.key));
      for (const finding of findings) {
        const prior = byKey.get(finding.key);
        const resource = findingResource(date, finding, true, prior);
        if (resource.id) await fhir.update("Basic", resource.id, resource);
        else await fhir.create(resource, {
          "If-None-Exist": `identifier=${ELIGIBILITY_SWEEP_IDENTIFIER_SYSTEM}|finding:${finding.key}`,
        });
      }
      for (const { resource, finding } of existing) {
        if (!resource.id || activeKeys.has(finding.key)) continue;
        await fhir.update("Basic", resource.id, findingResource(date, finding, false, resource));
      }
    },
  };
}

export async function loadEligibilityCandidates(
  fhir: EligibilitySweepFhir,
  date: string,
  timeZone: string,
): Promise<EligibilityCandidate[]> {
  const range = practiceDayRange(date, timeZone);
  const appointments = (await collectAllPages<Appointment>(
    fhir,
    "Appointment",
    [["date", `ge${range.start}`], ["date", `lt${range.end}`], ["_count", "1000"], ["_sort", "date"]],
    `eligibility appointments ${date}`,
  )).filter((appointment) => Boolean(
    appointment.id && appointment.start && !INACTIVE_APPOINTMENT_STATUSES.has(appointment.status),
  ));
  const output: EligibilityCandidate[] = [];
  for (const appointment of appointments) {
    const patientReference = participantReference(appointment, "Patient");
    const practitionerReference = participantReference(appointment, "Practitioner");
    if (!patientReference || !practitionerReference) {
      throw new Error(`Appointment/${appointment.id} cannot be checked because patient or practitioner linkage is missing.`);
    }
    const [patient, practitioner] = await Promise.all([
      readReference<Patient>(fhir, patientReference, "Patient"),
      readReference<Practitioner>(fhir, practitionerReference, "Practitioner"),
    ]);
    const coverages = (await collectAllPages<Coverage>(
      fhir,
      "Coverage",
      { beneficiary: patientReference, status: "active", _count: "100" },
      `active Coverage for ${patientReference}`,
    )).filter((coverage) => coverageAppliesOn(coverage, date));
    const coverage = [...coverages].sort((left, right) => (left.order ?? 999) - (right.order ?? 999))[0];
    if (!coverage?.id) {
      throw new Error(`Appointment/${appointment.id} cannot be checked because no active Coverage applies.`);
    }
    const payer = coverage.payor[0];
    const intendedPayerId = payer?.identifier?.value?.trim() ?? "";
    if (!payer?.reference || !intendedPayerId) {
      throw new Error(`Coverage/${coverage.id} cannot be checked because its payer reference or payer ID is missing.`);
    }
    const provider = eligibilityProvider(practitioner);
    const subscriber = await eligibilitySubscriber(fhir, coverage, patient);
    const memberId = coverage.subscriberId?.trim()
      || coverage.identifier?.find((identifier) => identifier.value?.trim())?.value?.trim()
      || "";
    if (!memberId) throw new Error(`Coverage/${coverage.id} cannot be checked because its member ID is missing.`);
    subscriber.memberId = memberId;
    const appointmentReference = `Appointment/${appointment.id}`;
    const coverageReference = `Coverage/${coverage.id}`;
    const key = `${date}:${appointment.id}:${coverage.id}`;
    const encounter = { dateOfService: date.replaceAll("-", ""), serviceTypeCodes: ["30"] };
    output.push({
      key,
      appointmentReference,
      appointmentAt: appointment.start!,
      patientReference,
      patientDisplay: patientDisplay(patient, appointment),
      coverageReference,
      payerReference: payer.reference,
      payerDisplay: payer.display?.trim() || intendedPayerId,
      intendedPayerId,
      chartMemberId: memberId,
      cobApplicability: coverageCobApplicability(coverage),
      eligibilityRequest: {
        submitterTransactionIdentifier: key,
        tradingPartnerServiceId: intendedPayerId,
        encounter,
        provider,
        subscriber,
      },
      discoveryRequest: {
        encounter: { dateOfService: date.replaceAll("-", "") },
        provider,
        subscriber: withoutMemberId(subscriber),
      },
    });
  }
  return output;
}

export function eligibilitySweepWorkerIntervalMs(value: string | undefined): number {
  if (value === undefined || value.trim() === "") return 5 * 60_000;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 10_000) {
    throw new Error("ODOS_ELIGIBILITY_SWEEP_MS must be an integer of at least 10 seconds.");
  }
  return parsed;
}

export function startEligibilitySweepWorker(input: {
  authenticate(): Promise<void>;
  store: EligibilitySweepStore;
  stedi: PreventiveStediClient;
  timeZone: string;
  intervalMs?: number;
  now?: () => string;
}): { stop(): void } {
  const run = () => {
    const now = input.now?.() ?? new Date().toISOString();
    const date = addDate(practiceDate(now, input.timeZone), 1);
    void input.authenticate()
      .then(() => runEligibilitySweepTick({ store: input.store, stedi: input.stedi, date, now }))
      .catch((error) => console.error("odos-mcp: eligibility sweep failed:", safeErrorMessage(error)));
  };
  run();
  const timer = setInterval(run, input.intervalMs ?? 5 * 60_000);
  return { stop: () => clearInterval(timer) };
}

function stateResource(state: EligibilitySweepState, existing?: Basic): Basic {
  return {
    resourceType: "Basic",
    ...(existing?.id ? { id: existing.id } : {}),
    ...(existing?.meta ? { meta: existing.meta } : {}),
    identifier: [{ system: ELIGIBILITY_SWEEP_IDENTIFIER_SYSTEM, value: `state:${state.date}` }],
    code: { coding: [{ system: ELIGIBILITY_SWEEP_CODE_SYSTEM, code: "state" }], text: "ODOS eligibility sweep state" },
    extension: [{ url: ELIGIBILITY_SWEEP_STATE_EXTENSION_URL, valueString: JSON.stringify(state) }],
  };
}

function parseStateResource(resource: Basic): EligibilitySweepState {
  const raw = resource.extension?.find((extension) => extension.url === ELIGIBILITY_SWEEP_STATE_EXTENSION_URL)?.valueString;
  if (!raw) throw new Error(`Eligibility sweep state Basic/${resource.id ?? "unknown"} is missing state.`);
  return JSON.parse(raw) as EligibilitySweepState;
}

function findingResource(date: string, finding: EligibilityFinding, active: boolean, existing?: Basic): Basic {
  return {
    resourceType: "Basic",
    ...(existing?.id ? { id: existing.id } : {}),
    ...(existing?.meta ? { meta: existing.meta } : {}),
    identifier: [{ system: ELIGIBILITY_SWEEP_IDENTIFIER_SYSTEM, value: `finding:${finding.key}` }],
    code: { coding: [{ system: ELIGIBILITY_SWEEP_CODE_SYSTEM, code: "finding" }], text: "ODOS eligibility sweep finding" },
    subject: { reference: finding.patientReference, display: finding.patientDisplay },
    extension: [{
      url: ELIGIBILITY_SWEEP_FINDING_EXTENSION_URL,
      valueString: JSON.stringify({ date, active, finding }),
    }],
  };
}

async function loadFindingResources(
  fhir: EligibilitySweepFhir,
  date: string,
  includeInactive = false,
): Promise<Array<{ resource: Basic; finding: EligibilityFinding }>> {
  const resources = await collectAllPages<Basic>(
    fhir,
    "Basic",
    { code: `${ELIGIBILITY_SWEEP_CODE_SYSTEM}|finding`, _count: "1000" },
    `eligibility findings ${date}`,
  );
  return resources.flatMap((resource) => {
    const raw = resource.extension?.find((extension) => extension.url === ELIGIBILITY_SWEEP_FINDING_EXTENSION_URL)?.valueString;
    if (!raw) return [];
    const parsed = JSON.parse(raw) as { date?: string; active?: boolean; finding?: EligibilityFinding };
    return parsed.date === date && parsed.finding && (includeInactive || parsed.active)
      ? [{ resource, finding: parsed.finding }]
      : [];
  });
}

function participantReference(appointment: Appointment, type: "Patient" | "Practitioner"): string | undefined {
  return appointment.participant
    .map((participant) => participant.actor?.reference)
    .find((reference): reference is string => Boolean(reference?.startsWith(`${type}/`)));
}

async function readReference<T extends Resource>(
  fhir: Pick<MedplumClient, "read">,
  reference: string,
  expectedType: T["resourceType"],
): Promise<T> {
  const [resourceType, id, extra] = reference.split("/");
  if (resourceType !== expectedType || !id || extra) throw new Error(`${reference} is not a valid ${expectedType} reference.`);
  return fhir.read<T>(expectedType, id);
}

async function eligibilitySubscriber(
  fhir: Pick<MedplumClient, "read">,
  coverage: Coverage,
  patient: Patient,
): Promise<Record<string, unknown>> {
  const reference = coverage.subscriber?.reference;
  if (!reference || reference === `Patient/${patient.id}`) return personPayload(patient);
  if (reference.startsWith("RelatedPerson/")) {
    return personPayload(await readReference<RelatedPerson>(fhir, reference, "RelatedPerson"));
  }
  throw new Error(`Coverage/${coverage.id ?? "unknown"} has an unsupported subscriber reference.`);
}

function personPayload(person: Patient | RelatedPerson): Record<string, unknown> {
  const name = person.name?.[0];
  if (!name?.family || !name.given?.[0]) throw new Error(`${person.resourceType}/${person.id ?? "unknown"} is missing subscriber name.`);
  return compact({
    firstName: name.given[0],
    middleName: name.given.slice(1).join(" ") || undefined,
    lastName: name.family,
    dateOfBirth: person.birthDate?.replaceAll("-", ""),
    gender: person.gender === "male" ? "M" : person.gender === "female" ? "F" : undefined,
    address: addressPayload(person.address?.[0]),
  });
}

function addressPayload(address: Address | undefined): Record<string, unknown> | undefined {
  if (!address) return undefined;
  return compact({
    address1: address.line?.[0],
    address2: address.line?.slice(1).join(" ") || undefined,
    city: address.city,
    state: address.state,
    postalCode: address.postalCode?.replace(/[^A-Za-z0-9]/g, ""),
  });
}

function eligibilityProvider(practitioner: Practitioner): Record<string, unknown> {
  const npi = practitioner.identifier?.find((identifier) => identifier.system?.includes("us-npi"))?.value?.trim();
  const name = practitioner.name?.[0];
  if (!npi || !name?.family || !name.given?.[0]) {
    throw new Error(`Practitioner/${practitioner.id ?? "unknown"} is missing NPI or name for eligibility.`);
  }
  return { npi, firstName: name.given[0], lastName: name.family };
}

function withoutMemberId(value: Record<string, unknown>): Record<string, unknown> {
  const copy = { ...value };
  delete copy.memberId;
  return copy;
}

function patientDisplay(patient: Patient, appointment: Appointment): string {
  const name = patient.name?.[0];
  const formatted = [name?.given?.[0], name?.family ? `${name.family.slice(0, 1)}.` : undefined].filter(Boolean).join(" ");
  return formatted || appointment.participant.find((participant) => participant.actor?.reference === `Patient/${patient.id}`)?.actor?.display || `Patient/${patient.id}`;
}

function coverageAppliesOn(coverage: Coverage, date: string): boolean {
  return coverage.status === "active"
    && (!coverage.period?.start || coverage.period.start <= date)
    && (!coverage.period?.end || coverage.period.end >= date);
}

function addDate(date: string, days: number): string {
  const parsed = new Date(`${date}T12:00:00.000Z`);
  parsed.setUTCDate(parsed.getUTCDate() + days);
  return parsed.toISOString().slice(0, 10);
}

function compact(input: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined && value !== ""));
}
