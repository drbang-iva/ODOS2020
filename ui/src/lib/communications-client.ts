import { authHeaders, clinicalGraphApiBase } from "./clinical-graph-client";

export type SmsLaneRole = "transactional-sms" | "marketing-sms" | "clinical-sms";

export interface SmsOptOutLane {
  label: string;
  number: string;
  roles: SmsLaneRole[];
}

export interface SmsOptOutState {
  patientVersion?: PatientVersion;
  patientReference: string;
  smsOptedOut: boolean;
  remainingOptOuts: {
    global: boolean;
    numbers: string[];
  };
  smsLanes: SmsOptOutLane[];
}

export type SmsOptOutIdentityVerification = "in-person" | "phone-verified" | "portal";

export interface ClearSmsOptOutResult {
  patientVersion?: PatientVersion;
  patientReference: string;
  smsOptedOut: boolean;
  cleared: boolean;
  suppressionCleared?: boolean;
  remainingOptOuts?: {
    global: boolean;
    numbers: string[];
  };
}

export interface SmsSendResult {
  outcome: "sent" | "suppressed" | "rescheduled";
  providerMessageId?: string;
  reason?: string;
  rescheduledAt?: string;
}

export interface EducationContentItem {
  id: string;
  version: number;
  title: string;
  kind: "video" | "handout" | "report" | "page";
  audience: "patient" | "internal";
  dxCodes: string[];
  channels: Array<"sms" | "email" | "print">;
  laneHint: "clinical" | "retail";
  consentClass: "transactional" | "marketing";
  urls: {
    web?: string;
    email?: string;
    print?: string;
  };
}

export interface EducationCatalogResult {
  items: EducationContentItem[];
  chartDispatchLane: "locked_clinical" | "staff_switchable";
  availableChannels: EducationChannelAvailability;
}

export interface EducationChannelAvailability {
  clinicalSms: boolean;
  frontdeskSms: boolean;
  email: boolean;
  print: boolean;
}

export interface EducationDispatchInput {
  patientReference: string;
  educationId: string;
  version: number;
  channel: "sms" | "email" | "print";
  lane: "clinical" | "frontdesk";
  recipientOverride?: {
    reference?: string;
    phone?: string;
    email?: string;
  };
  alsoUpdateChart: boolean;
  encounterReference?: string;
  conditionReference?: string;
  idempotencyKey: string;
}

export type EducationDispatchResult =
  | { outcome: "sent"; providerMessageId: string; chartUpdate?: "conflict"; preferenceUpdate?: "failed" }
  | { outcome: "print"; url: string }
  | { outcome: "refused"; reason: string }
  | { outcome: "suppressed"; reason: "patient-opt-out" | "preference-withheld" | "frequency-cap" }
  | { outcome: "rescheduled"; reason: "quiet-hours"; rescheduledAt: string };

export class CommunicationsResponseError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

export async function readSmsOptOut(
  patientReference: string,
  fetchImpl: typeof fetch = fetch,
): Promise<SmsOptOutState> {
  const response = await fetchImpl(
    `${clinicalGraphApiBase()}/communications/opt-out?patient=${encodeURIComponent(patientReference)}`,
    { headers: authHeaders() },
  );
  const body = await response.json().catch(() => ({})) as unknown;
  if (!response.ok) {
    throw new CommunicationsResponseError(
      response.status,
      responseError(body) ?? `SMS opt-out state failed (${response.status}).`,
    );
  }
  if (!isSmsOptOutState(body)) {
    throw new CommunicationsResponseError(response.status, "SMS opt-out state returned an unexpected response.");
  }
  return body;
}

export async function recordSmsOptOut(
  input: {
    patientReference: string;
    reason: string;
    identityVerification: SmsOptOutIdentityVerification;
    scope: "global" | "per-number";
    number?: string;
  },
  fetchImpl: typeof fetch = fetch,
): Promise<SmsOptOutState> {
  const response = await fetchImpl(`${clinicalGraphApiBase()}/communications/opt-out/record`, {
    method: "POST",
    headers: { ...authHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  const body = await response.json().catch(() => ({})) as unknown;
  if (!response.ok) {
    throw new CommunicationsResponseError(
      response.status,
      responseError(body) ?? `SMS opt-out record failed (${response.status}).`,
    );
  }
  if (!isSmsOptOutState(body)) {
    throw new CommunicationsResponseError(response.status, "SMS opt-out record returned an unexpected response.");
  }
  return body;
}

export async function clearSmsOptOut(
  input: {
    patientReference: string;
    reason: string;
    identityVerification: SmsOptOutIdentityVerification;
    number?: string;
  },
  fetchImpl: typeof fetch = fetch,
): Promise<ClearSmsOptOutResult> {
  const response = await fetchImpl(`${clinicalGraphApiBase()}/communications/opt-out/clear`, {
    method: "POST",
    headers: { ...authHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  const body = await response.json().catch(() => ({})) as unknown;
  if (!response.ok) {
    throw new CommunicationsResponseError(
      response.status,
      responseError(body) ?? `SMS opt-out clear failed (${response.status}).`,
    );
  }
  if (!isClearSmsOptOutResult(body)) {
    throw new CommunicationsResponseError(response.status, "SMS opt-out clear returned an unexpected response.");
  }
  return body;
}

export async function listEducation(
  query: { dxCode?: string; channel?: "sms" | "email" | "print" },
  fetchImpl: typeof fetch = fetch,
): Promise<EducationCatalogResult> {
  const params = new URLSearchParams();
  if (query.dxCode) params.set("dxCode", query.dxCode);
  if (query.channel) params.set("channel", query.channel);
  const suffix = params.size ? `?${params.toString()}` : "";
  const response = await fetchImpl(`${clinicalGraphApiBase()}/communications/education${suffix}`, {
    headers: authHeaders(),
  });
  const body = await response.json().catch(() => ({})) as unknown;
  if (!response.ok) {
    throw new CommunicationsResponseError(
      response.status,
      responseError(body) ?? `Education catalog failed (${response.status}).`,
    );
  }
  if (!isRecord(body)
    || !Array.isArray(body.items)
    || !body.items.every(isEducationContentItem)
    || (body.chartDispatchLane !== "locked_clinical" && body.chartDispatchLane !== "staff_switchable")
    || !isEducationChannelAvailability(body.availableChannels)) {
    throw new CommunicationsResponseError(response.status, "Education catalog returned an unexpected response.");
  }
  return {
    items: body.items,
    chartDispatchLane: body.chartDispatchLane,
    availableChannels: body.availableChannels,
  };
}

export async function dispatchEducation(
  input: EducationDispatchInput,
  fetchImpl: typeof fetch = fetch,
): Promise<EducationDispatchResult> {
  const response = await fetchImpl(`${clinicalGraphApiBase()}/communications/education/dispatch`, {
    method: "POST",
    headers: { ...authHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  const body = await response.json().catch(() => ({})) as unknown;
  if (!response.ok) {
    throw new CommunicationsResponseError(
      response.status,
      responseError(body) ?? dispatchRefusalReason(body) ?? `Education dispatch failed (${response.status}).`,
    );
  }
  if (!isEducationDispatchResult(body)) {
    throw new CommunicationsResponseError(response.status, "Education dispatch returned an unexpected response.");
  }
  return body;
}

function isSmsOptOutState(value: unknown): value is SmsOptOutState {
  if (!isRecord(value)
    || typeof value.patientReference !== "string"
    || typeof value.smsOptedOut !== "boolean"
    || !isRemainingOptOuts(value.remainingOptOuts)
    || !optionalPatientVersion(value)) return false;
  if (!Array.isArray(value.smsLanes)) return false;
  return value.smsLanes.every((lane) =>
    isRecord(lane)
    && typeof lane.label === "string"
    && typeof lane.number === "string"
    && Array.isArray(lane.roles)
    && lane.roles.every(isSmsLaneRole));
}

function isClearSmsOptOutResult(value: unknown): value is ClearSmsOptOutResult {
  return isRecord(value)
    && typeof value.patientReference === "string"
    && typeof value.smsOptedOut === "boolean"
    && typeof value.cleared === "boolean"
    && optionalPatientVersion(value)
    && (value.suppressionCleared === undefined || typeof value.suppressionCleared === "boolean")
    && (value.remainingOptOuts === undefined || isRemainingOptOuts(value.remainingOptOuts));
}

function isEducationChannelAvailability(value: unknown): value is EducationChannelAvailability {
  return isRecord(value)
    && typeof value.clinicalSms === "boolean"
    && typeof value.frontdeskSms === "boolean"
    && typeof value.email === "boolean"
    && typeof value.print === "boolean";
}

function isRemainingOptOuts(value: unknown): value is SmsOptOutState["remainingOptOuts"] {
  return isRecord(value)
    && typeof value.global === "boolean"
    && Array.isArray(value.numbers)
    && value.numbers.every((number) => typeof number === "string");
}

function isSmsLaneRole(value: unknown): value is SmsLaneRole {
  return value === "transactional-sms" || value === "marketing-sms" || value === "clinical-sms";
}

function isEducationContentItem(value: unknown): value is EducationContentItem {
  if (!isRecord(value)
    || typeof value.id !== "string"
    || typeof value.version !== "number"
    || typeof value.title !== "string"
    || !["video", "handout", "report", "page"].includes(String(value.kind))
    || !["patient", "internal"].includes(String(value.audience))
    || !Array.isArray(value.dxCodes)
    || !value.dxCodes.every((code) => typeof code === "string")
    || !Array.isArray(value.channels)
    || !value.channels.every((channel) => ["sms", "email", "print"].includes(String(channel)))
    || !["clinical", "retail"].includes(String(value.laneHint))
    || !["transactional", "marketing"].includes(String(value.consentClass))
    || !isRecord(value.urls)) return false;
  return (value.urls.web === undefined || typeof value.urls.web === "string")
    && (value.urls.email === undefined || typeof value.urls.email === "string")
    && (value.urls.print === undefined || typeof value.urls.print === "string");
}

function isEducationDispatchResult(value: unknown): value is EducationDispatchResult {
  if (!isRecord(value) || typeof value.outcome !== "string") return false;
  if (value.outcome === "sent") {
    return typeof value.providerMessageId === "string"
      && (value.chartUpdate === undefined || value.chartUpdate === "conflict")
      && (value.preferenceUpdate === undefined || value.preferenceUpdate === "failed");
  }
  if (value.outcome === "print") return typeof value.url === "string";
  if (value.outcome === "suppressed") {
    return value.reason === "patient-opt-out" || value.reason === "preference-withheld" || value.reason === "frequency-cap";
  }
  if (value.outcome === "rescheduled") {
    return value.reason === "quiet-hours" && typeof value.rescheduledAt === "string";
  }
  return value.outcome === "refused" && typeof value.reason === "string";
}

function dispatchRefusalReason(value: unknown): string | undefined {
  return isRecord(value) && value.outcome === "refused" && typeof value.reason === "string"
    ? value.reason
    : undefined;
}

function responseError(value: unknown): string | undefined {
  return isRecord(value) && typeof value.error === "string" ? value.error : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function sendSms(
  input: {
    patientReference: string;
    body: string;
    idempotencyKey: string;
  },
  fetchImpl: typeof fetch = fetch,
): Promise<SmsSendResult> {
  const response = await fetchImpl(`${clinicalGraphApiBase()}/communications/messages`, {
    method: "POST",
    headers: { ...authHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  const body = await response.json().catch(() => ({})) as SmsSendResult & { error?: string };
  if (!response.ok) {
    throw new CommunicationsResponseError(
      response.status,
      body.error ?? `SMS send failed (${response.status}).`,
    );
  }
  return body;
}

export type EducationSequenceReviewAction = "skip" | "resume";
export interface EducationSequenceWorkItem {
  id: string;
  enrollmentId: string;
  rowId?: string;
  reason: string;
  patientReference?: string;
  at: string;
  state: "open" | "settled";
  expectedVersion?: string;
  disposition?: string;
  holdReason?: string;
  channel?: "sms" | "email" | "print";
  encounterReference?: string;
  allowedActions?: EducationSequenceReviewAction[];
}

export async function listEducationSequenceWork(fetchImpl: typeof fetch = fetch): Promise<EducationSequenceWorkItem[]> {
  const response = await fetchImpl(`${clinicalGraphApiBase()}/communications/education/sequence-work`, { headers: authHeaders() });
  const body = await response.json().catch(() => ({})) as unknown;
  if (!response.ok) throw new CommunicationsResponseError(response.status, responseError(body) ?? dispatchRefusalReason(body) ?? "Education review list could not load.");
  if (!isRecord(body) || !Array.isArray(body.items) || !body.items.every(isEducationSequenceWorkItem))
    throw new CommunicationsResponseError(response.status, "Education review returned an unexpected response.");
  return body.items;
}

export async function reviewEducationSequenceStep(
  enrollmentId: string,
  rowId: string,
  input: { action: EducationSequenceReviewAction; reason: string; expectedVersion: string; reviewedEncounterReference?: string },
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const response = await fetchImpl(`${clinicalGraphApiBase()}/communications/education/enrollments/${encodeURIComponent(enrollmentId)}/scheduled-sends/${encodeURIComponent(rowId)}/review`, {
    method: "POST", headers: { ...authHeaders(), "Content-Type": "application/json" }, body: JSON.stringify(input),
  });
  const body = await response.json().catch(() => ({})) as unknown;
  if (!response.ok) throw new CommunicationsResponseError(response.status, responseError(body) ?? dispatchRefusalReason(body) ?? "Education review could not be recorded.");
  if (!isRecord(body) || !isRecord(body.enrollment) || typeof body.expectedVersion !== "string")
    throw new CommunicationsResponseError(response.status, "Education review returned an unexpected response. Refresh before trying again.");
}

function isEducationSequenceWorkItem(value: unknown): value is EducationSequenceWorkItem {
  if (!isRecord(value) || !["id", "enrollmentId", "reason", "at"].every(key => typeof value[key] === "string")
    || !["open", "settled"].includes(String(value.state))) return false;
  for (const key of ["rowId", "patientReference", "expectedVersion", "disposition", "holdReason", "encounterReference"])
    if (value[key] !== undefined && typeof value[key] !== "string") return false;
  return (value.channel === undefined || ["sms", "email", "print"].includes(String(value.channel)))
    && (value.allowedActions === undefined || (Array.isArray(value.allowedActions) && value.allowedActions.every(action => action === "skip" || action === "resume")));
}

export const COMMS_PURPOSES = ["recalls", "appointment", "product-pickup", "marketing-promo", "education"] as const;
export const COMMS_PREFERENCE_CHANNELS = ["sms", "call", "email", "mail"] as const;
export type CommsPurpose = typeof COMMS_PURPOSES[number];
export type CommsPreferenceChannel = typeof COMMS_PREFERENCE_CHANNELS[number];
export type CommunicationPreferenceSource = "default" | "explicit" | "legacy-marketing-consent" | "suppression";
export type CommunicationPreferenceSurface = "staff-demographics" | "staff-registration" | "staff-manual-send" | "inbound-start";
export interface PatientVersion { writtenAgainst: string; current: string }
export interface CommunicationPreferenceCell {
  value: boolean;
  source: CommunicationPreferenceSource;
  setBy?: { reference: string; display?: string };
  surface?: CommunicationPreferenceSurface;
  recordedAt?: string;
  evidence?: { reference: string; display?: string };
}
export interface CommunicationPreferenceRow extends CommunicationPreferenceCell {
  purpose: CommsPurpose;
  channel: CommsPreferenceChannel;
  evidenceSummary: Array<{ reference?: string; dateTime?: string; capture?: { url: string; extension?: Array<{ url: string; valueCode?: string }> } }>;
  lastSet: { recordedAt: string; setBy: { reference: string; display?: string }; surface: CommunicationPreferenceSurface } | null;
  evidenceStatus: "not-applicable" | "suppressed" | "gap" | "recorded" | "not-required";
}
export interface CommunicationPreferencesResponse {
  patientReference: string;
  matrix: Record<CommsPurpose, Record<CommsPreferenceChannel, CommunicationPreferenceCell>>;
  rows: CommunicationPreferenceRow[];
  patientVersion?: PatientVersion;
}
export interface CommunicationPreferenceInput { purpose: CommsPurpose; channel: CommsPreferenceChannel; allowed: boolean }
export interface CommunicationPreferencesInput {
  cells: CommunicationPreferenceInput[];
  confirmedVia?: "in-person" | "paper-form" | null;
  formDate?: string;
}
export interface CommunicationPreferenceDefaultsResponse {
  version: string;
  defaults: Record<CommsPurpose, Record<CommsPreferenceChannel, boolean>>;
}
export interface EvidenceGapFilters { tier?: "1" | "2" | "3"; purpose?: CommsPurpose; channel?: "sms" | "email"; cursor?: string }
export interface EvidenceGapRow { patientReference: string; purpose: CommsPurpose; channel: "sms" | "email"; tier: 1 | 2 | 3; source: CommunicationPreferenceSource }
export interface EvidenceGapReport { rows: EvidenceGapRow[]; suppressed: EvidenceGapRow[]; counts: { "1": number; "2": number; "3": number }; truncated: boolean; cursor?: string }

function nonemptyString(value: unknown): value is string { return typeof value === "string" && value.length > 0; }
export function isPatientVersion(value: unknown): value is PatientVersion {
  return isRecord(value) && nonemptyString(value.writtenAgainst) && nonemptyString(value.current);
}
function optionalPatientVersion(value: Record<string, unknown>): boolean {
  return !("patientVersion" in value) || isPatientVersion(value.patientVersion);
}
function isPreferenceSource(value: unknown): value is CommunicationPreferenceSource {
  return value === "default" || value === "explicit" || value === "legacy-marketing-consent" || value === "suppression";
}
function isPreferenceSurface(value: unknown): value is CommunicationPreferenceSurface {
  return value === "staff-demographics" || value === "staff-registration" || value === "staff-manual-send" || value === "inbound-start";
}
function isReference(value: unknown): boolean {
  return isRecord(value) && nonemptyString(value.reference) && (value.display === undefined || typeof value.display === "string");
}
function isPreferenceCell(value: unknown): value is CommunicationPreferenceCell {
  return isRecord(value) && typeof value.value === "boolean" && isPreferenceSource(value.source)
    && (value.setBy === undefined || isReference(value.setBy))
    && (value.surface === undefined || isPreferenceSurface(value.surface))
    && (value.recordedAt === undefined || nonemptyString(value.recordedAt))
    && (value.evidence === undefined || isReference(value.evidence));
}
function isPurpose(value: unknown): value is CommsPurpose { return COMMS_PURPOSES.some(purpose => purpose === value); }
function isChannel(value: unknown): value is CommsPreferenceChannel { return COMMS_PREFERENCE_CHANNELS.some(channel => channel === value); }
function isEvidenceSummary(value: unknown): boolean {
  return isRecord(value) && (value.reference === undefined || nonemptyString(value.reference))
    && (value.dateTime === undefined || nonemptyString(value.dateTime))
    && (value.capture === undefined || (isRecord(value.capture) && nonemptyString(value.capture.url)
      && (value.capture.extension === undefined || (Array.isArray(value.capture.extension) && value.capture.extension.every(part =>
        isRecord(part) && nonemptyString(part.url) && (part.valueCode === undefined || nonemptyString(part.valueCode)))))));
}
function isPreferenceRow(value: unknown): value is CommunicationPreferenceRow {
  return isRecord(value) && isPreferenceCell(value) && isPurpose(value.purpose) && isChannel(value.channel)
    && Array.isArray(value.evidenceSummary) && value.evidenceSummary.every(isEvidenceSummary)
    && (value.lastSet === null || (isRecord(value.lastSet) && nonemptyString(value.lastSet.recordedAt)
      && isReference(value.lastSet.setBy) && isPreferenceSurface(value.lastSet.surface)))
    && ["not-applicable", "suppressed", "gap", "recorded", "not-required"].some(status => status === value.evidenceStatus);
}
function isFullMatrix(value: unknown, cellParser: (cell: unknown) => boolean): boolean {
  return isRecord(value) && Object.keys(value).length === COMMS_PURPOSES.length && COMMS_PURPOSES.every(purpose => {
    const row = value[purpose];
    return isRecord(row) && Object.keys(row).length === COMMS_PREFERENCE_CHANNELS.length
      && COMMS_PREFERENCE_CHANNELS.every(channel => cellParser(row[channel]));
  });
}
export function isCommunicationPreferencesResponse(value: unknown): value is CommunicationPreferencesResponse {
  return isRecord(value) && nonemptyString(value.patientReference) && isFullMatrix(value.matrix, isPreferenceCell)
    && Array.isArray(value.rows) && value.rows.length === COMMS_PURPOSES.length * COMMS_PREFERENCE_CHANNELS.length
    && value.rows.every(isPreferenceRow) && new Set(value.rows.map(row => `${row.purpose}/${row.channel}`)).size === value.rows.length
    && optionalPatientVersion(value);
}
export function isCommunicationPreferenceDefaultsResponse(value: unknown): value is CommunicationPreferenceDefaultsResponse {
  return isRecord(value) && nonemptyString(value.version) && isFullMatrix(value.defaults, cell => typeof cell === "boolean");
}
function isEvidenceGapRow(value: unknown): value is EvidenceGapRow {
  return isRecord(value) && nonemptyString(value.patientReference) && isPurpose(value.purpose)
    && (value.channel === "sms" || value.channel === "email") && (value.tier === 1 || value.tier === 2 || value.tier === 3)
    && isPreferenceSource(value.source);
}
export function isEvidenceGapReport(value: unknown): value is EvidenceGapReport {
  if (!isRecord(value) || !isRecord(value.counts)) return false;
  const counts = value.counts;
  return Array.isArray(value.rows) && value.rows.every(isEvidenceGapRow)
    && Array.isArray(value.suppressed) && value.suppressed.every(isEvidenceGapRow)
    && ["1", "2", "3"].every(tier => Number.isSafeInteger(counts[tier]) && Number(counts[tier]) >= 0)
    && typeof value.truncated === "boolean" && (value.cursor === undefined || nonemptyString(value.cursor))
    && (!value.truncated || nonemptyString(value.cursor));
}
async function preferenceRequest<T>(path: string, parser: (value: unknown) => value is T, fetchImpl: typeof fetch, input?: unknown): Promise<T> {
  const response = await fetchImpl(`${clinicalGraphApiBase()}/communications/preferences${path}`, {
    headers: { ...authHeaders(), ...(input === undefined ? {} : { "Content-Type": "application/json" }) },
    ...(input === undefined ? {} : { method: "PUT", body: JSON.stringify(input) }),
  });
  const body: unknown = await response.json().catch(() => ({}));
  if (!response.ok) throw new CommunicationsResponseError(response.status, responseError(body) ?? `Communication preferences failed (${response.status}).`);
  if (!parser(body)) throw new CommunicationsResponseError(response.status, "Communication preferences returned an unexpected response.");
  return body;
}
export function readCommunicationPreferences(patientReference: string, fetchImpl: typeof fetch = fetch): Promise<CommunicationPreferencesResponse> {
  return preferenceRequest(`?patient=${encodeURIComponent(patientReference)}`,
    (value): value is CommunicationPreferencesResponse => isCommunicationPreferencesResponse(value) && value.patientReference === patientReference, fetchImpl);
}
export function saveCommunicationPreferences(input: CommunicationPreferencesInput & { patientReference: string }, fetchImpl: typeof fetch = fetch): Promise<CommunicationPreferencesResponse> {
  return preferenceRequest("",
    (value): value is CommunicationPreferencesResponse => isCommunicationPreferencesResponse(value) && value.patientReference === input.patientReference, fetchImpl, input);
}
export function readCommunicationPreferenceDefaults(fetchImpl: typeof fetch = fetch): Promise<CommunicationPreferenceDefaultsResponse> {
  return preferenceRequest("/defaults", isCommunicationPreferenceDefaultsResponse, fetchImpl);
}
function evidenceGapQuery(filters: EvidenceGapFilters, format: "json" | "csv"): URLSearchParams {
  const query = new URLSearchParams({ format });
  for (const [key, value] of Object.entries(filters)) if (value !== undefined) query.set(key, value);
  return query;
}
export function listEvidenceGaps(filters: EvidenceGapFilters = {}, fetchImpl: typeof fetch = fetch): Promise<EvidenceGapReport> {
  return preferenceRequest(`/evidence-gaps?${evidenceGapQuery(filters, "json")}`, isEvidenceGapReport, fetchImpl);
}
export async function downloadEvidenceGapsCsv(filters: EvidenceGapFilters = {}, fetchImpl: typeof fetch = fetch): Promise<{ text: string; truncated: string | null; cursor: string | null }> {
  const response = await fetchImpl(`${clinicalGraphApiBase()}/communications/preferences/evidence-gaps?${evidenceGapQuery(filters, "csv")}`, { headers: authHeaders() });
  if (!response.ok) {
    const body: unknown = await response.json().catch(() => ({}));
    throw new CommunicationsResponseError(response.status, responseError(body) ?? `Consent evidence export failed (${response.status}).`);
  }
  return { text: await response.text(), truncated: response.headers.get("X-ODOS-Truncated"), cursor: response.headers.get("X-ODOS-Cursor") };
}
