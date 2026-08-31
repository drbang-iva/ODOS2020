import type { ClaimsApiOptions, ClaimsWorklistItem } from "./claims-worklist";

export const WORK_LANES = [
  { id: "aging", label: "Aging" },
  { id: "holds", label: "Holds" },
  { id: "denials", label: "Denials" },
  { id: "underpaid", label: "Underpaid" },
  { id: "unmatched", label: "Unmatched" },
  { id: "untouched", label: "Untouched" },
  { id: "hygiene", label: "Hygiene" },
] as const;

export type WorkLaneId = (typeof WORK_LANES)[number]["id"];
export type ClaimProjectionState = "uninitialized" | "healthy" | "failed" | "stale";

export interface ClaimProjectionStatus {
  state: ClaimProjectionState;
  lastAttemptAt: string | null;
  lastSuccessfulAt: string | null;
  lastFailureAt: string | null;
  invalidatedAt: string | null;
  staleAfterMs: number;
}

export interface ClaimWorklistRow {
  claimReference: string;
  claimNumber: string;
  patientReference: string;
  patient: string;
  providerReference: string;
  provider: string;
  cptCodes: string[];
  totalChargedCents: number;
  collectedCents: number;
  patientResponsibilityCents: number;
  status: string;
  payerReference: string;
  payer: string;
  officeReference?: string;
  office?: string;
  billedAt: string;
  open: boolean;
  touchCount: number;
  lastTouchedAt: string | null;
  lastTouchedBy: string | null;
  reasonCode: string | null;
  reasonDisplay: string | null;
  resolutionPath: string | null;
  daysSinceBilled: number;
  agingBucket: string;
  daysSinceTouched: number | null;
  untouchedRankingDays: number;
  outstandingCents: number;
}

export interface ClaimWorklistGroup {
  reason: { code: string | null; display: string; resolutionPath: string | null };
  count: number;
  totalOutstandingCents: number;
  rows: ClaimWorklistRow[];
}

interface WorkGroupBase {
  key: string;
  title: string;
  count: number;
  totalOutstandingCents: number;
  claimReferences: string[];
  claimWatchEligible: boolean;
  oldestDaysBilled: number | null;
}

export interface WorkClaimGroup extends WorkGroupBase {
  kind: "claim";
  rows: ClaimWorklistRow[];
  reason: ClaimWorklistGroup["reason"];
  primaryAction: string;
}

export interface WorkEraGroup extends WorkGroupBase {
  kind: "era" | "legacy-remit";
  items: ClaimsWorklistItem[];
  primaryAction: "Review remit";
}

export type WorkGroup = WorkClaimGroup | WorkEraGroup;

export interface WorkLane {
  id: WorkLaneId;
  label: string;
  count: number;
  groups: WorkGroup[];
}

export interface WorkHealthyProjection {
  status: "healthy";
  lastSuccessfulAt: string;
  lanes: WorkLane[];
}

export interface WorkDegradedProjection {
  status: "degraded";
  reason: Exclude<ClaimProjectionState, "healthy">;
  lastSuccessfulAt?: string;
}

export type WorkProjection = WorkHealthyProjection | WorkDegradedProjection;

export interface BatchTouchInput {
  claimReferences: string[];
  action: "note" | "resubmission" | "contact" | "status-reason" | "resolution";
  detail?: string;
  reasonCode?: string;
  idempotencyKey: string;
}

export interface BatchTouchResult {
  requested: number;
  touched: number;
  readModelSynced?: boolean;
  items: Array<{
    claimReference: string;
    touchCount: number;
    lastTouchedAt?: string;
    lastTouchedBy?: string;
    idempotentReplay: boolean;
  }>;
}

export function buildWorkLanes(
  claimGroups: readonly ClaimWorklistGroup[],
  eraItems: readonly ClaimsWorklistItem[],
): WorkLane[] {
  const rows = claimGroups.flatMap((group) => group.rows);
  const openEra = eraItems.filter((item) => item.status !== "resolved");
  const legacyEra = eraItems.filter((item) => (
    item.code === "era-unmatched"
    && item.status === "resolved"
    && item.resolutionDisposition === "legacy"
  ));
  const groupsByLane: Record<WorkLaneId, WorkGroup[]> = {
    aging: claimGroupsForLane("aging", rows.filter((row) => row.open && row.agingBucket !== "current")),
    holds: claimGroupsForLane("holds", rows.filter((row) => (
      row.open
      && row.reasonCode !== null
      && !["denied", "underpaid", "rejected"].includes(row.status)
    ))),
    denials: [
      ...claimGroupsForLane("denials", rows.filter((row) => row.open && row.status === "denied")),
      ...eraGroupsForLane("denials", openEra.filter((item) => item.code === "era-denial")),
    ],
    underpaid: [
      ...claimGroupsForLane("underpaid", rows.filter((row) => row.open && row.status === "underpaid")),
      ...eraGroupsForLane("underpaid", openEra.filter((item) => item.code === "era-underpayment")),
    ],
    unmatched: [
      ...eraGroupsForLane("unmatched", openEra.filter((item) => (
        item.code === "era-unmatched" || item.code === "era-line-linkage" || item.code === "claim-rejected"
      ))),
      ...(legacyEra.length ? [legacyGroup(legacyEra)] : []),
    ],
    untouched: claimGroupsForLane("untouched", rows.filter((row) => row.open && row.touchCount === 0)),
    hygiene: eraGroupsForLane("hygiene", openEra.filter((item) => item.code === "era-integrity")),
  };
  return WORK_LANES.map(({ id, label }) => ({
    id,
    label,
    groups: groupsByLane[id],
    count: groupsByLane[id].reduce((sum, group) => sum + group.count, 0),
  }));
}

export function rowFacts(row: ClaimWorklistRow): {
  daysSinceBilled: number;
  daysSinceTouched: number | null;
} {
  return {
    daysSinceBilled: row.daysSinceBilled,
    daysSinceTouched: row.daysSinceTouched,
  };
}

export async function loadClaimWork(options: ClaimsApiOptions = {}): Promise<WorkProjection> {
  const projectionResponse = await request("/claims/follow-up-worklist", {}, options);
  const projectionBody = await jsonBody<{
    projection?: ClaimProjectionStatus;
    groups?: ClaimWorklistGroup[];
    error?: string;
  }>(projectionResponse);
  const status = projectionBody.projection;
  if (!projectionResponse.ok || !status || status.state !== "healthy") {
    if (status && status.state !== "healthy") return degradedProjection(status);
    throw new Error(projectionBody.error ?? `Claim Work request failed with HTTP ${projectionResponse.status}.`);
  }
  const eraResponse = await request("/claims/worklist", {}, options);
  const eraBody = await jsonBody<{ items?: ClaimsWorklistItem[]; error?: string }>(eraResponse);
  if (!eraResponse.ok) {
    throw new Error(eraBody.error ?? `Claim Work request failed with HTTP ${eraResponse.status}.`);
  }
  if (!status.lastSuccessfulAt) throw new Error("Healthy claim projection is missing lastSuccessfulAt.");
  return {
    status: "healthy",
    lastSuccessfulAt: status.lastSuccessfulAt,
    lanes: buildWorkLanes(projectionBody.groups ?? [], eraBody.items ?? []),
  };
}

export async function batchTouchClaims(
  input: BatchTouchInput,
  options: ClaimsApiOptions = {},
): Promise<BatchTouchResult> {
  const response = await request("/claims/touches/batch", {
    method: "POST",
    body: JSON.stringify(input),
  }, options);
  const body = await jsonBody<BatchTouchResult & { error?: string }>(response);
  if (!response.ok) {
    throw new Error(body.error ?? `Claim batch touch failed with HTTP ${response.status}.`);
  }
  if (body.requested !== input.claimReferences.length || body.touched !== input.claimReferences.length) {
    throw new Error(`Batch touch incomplete: ${body.touched} of ${input.claimReferences.length} claims were stamped.`);
  }
  const returnedReferences = new Set(body.items.map((item) => item.claimReference));
  const missing = input.claimReferences.filter((reference) => !returnedReferences.has(reference));
  if (missing.length) {
    throw new Error(`Batch touch incomplete: ${input.claimReferences.length - missing.length} of ${input.claimReferences.length} claims were reported.`);
  }
  return body;
}

function claimGroupsForLane(lane: WorkLaneId, rows: ClaimWorklistRow[]): WorkClaimGroup[] {
  const grouped = new Map<string, ClaimWorklistRow[]>();
  for (const row of rows) {
    const key = row.reasonCode ?? "";
    grouped.set(key, [...(grouped.get(key) ?? []), row]);
  }
  return [...grouped.entries()].map(([reasonCode, values]) => {
    const first = values[0];
    return {
      kind: "claim" as const,
      key: `${lane}:claim:${reasonCode || "untyped"}`,
      title: first.reasonDisplay ?? "No typed reason",
      count: values.length,
      totalOutstandingCents: values.reduce((sum, row) => sum + row.outstandingCents, 0),
      claimReferences: values.map((row) => row.claimReference),
      claimWatchEligible: true,
      oldestDaysBilled: Math.max(...values.map((row) => row.daysSinceBilled)),
      rows: [...values].sort(compareClaimRows),
      reason: {
        code: first.reasonCode,
        display: first.reasonDisplay ?? "No typed reason",
        resolutionPath: first.resolutionPath,
      },
      primaryAction: first.resolutionPath ?? "Work claims",
    };
  }).sort(compareWorkGroups);
}

function eraGroupsForLane(lane: WorkLaneId, items: ClaimsWorklistItem[]): WorkEraGroup[] {
  const grouped = new Map<string, ClaimsWorklistItem[]>();
  for (const item of items) grouped.set(item.code, [...(grouped.get(item.code) ?? []), item]);
  return [...grouped.entries()].map(([code, values]) => ({
    kind: "era" as const,
    key: `${lane}:era:${code}`,
    title: values[0].title,
    count: values.length,
    totalOutstandingCents: values.reduce((sum, item) => sum + eraOutstanding(item), 0),
    claimReferences: [],
    claimWatchEligible: true,
    oldestDaysBilled: null,
    items: values,
    primaryAction: "Review remit" as const,
  }));
}

function legacyGroup(items: ClaimsWorklistItem[]): WorkEraGroup {
  return {
    kind: "legacy-remit",
    key: "unmatched:legacy-remits",
    title: "Legacy — belongs to the prior system",
    count: items.length,
    totalOutstandingCents: 0,
    claimReferences: [],
    claimWatchEligible: false,
    oldestDaysBilled: null,
    items,
    primaryAction: "Review remit",
  };
}

function compareClaimRows(left: ClaimWorklistRow, right: ClaimWorklistRow): number {
  return right.untouchedRankingDays - left.untouchedRankingDays
    || right.daysSinceBilled - left.daysSinceBilled
    || left.claimReference.localeCompare(right.claimReference);
}

function compareWorkGroups(left: WorkClaimGroup, right: WorkClaimGroup): number {
  const leftUntouched = Math.max(...left.rows.map((row) => row.untouchedRankingDays));
  const rightUntouched = Math.max(...right.rows.map((row) => row.untouchedRankingDays));
  return rightUntouched - leftUntouched
    || (right.oldestDaysBilled ?? 0) - (left.oldestDaysBilled ?? 0)
    || left.title.localeCompare(right.title);
}

function eraOutstanding(item: ClaimsWorklistItem): number {
  if (item.evidence.kind !== "era") return 0;
  return Math.max(0, item.evidence.shortfallCents);
}

function degradedProjection(status: ClaimProjectionStatus): WorkDegradedProjection {
  return {
    status: "degraded",
    reason: status.state as Exclude<ClaimProjectionState, "healthy">,
    ...(status.lastSuccessfulAt ? { lastSuccessfulAt: status.lastSuccessfulAt } : {}),
  };
}

function request(path: string, init: RequestInit, options: ClaimsApiOptions): Promise<Response> {
  const fetchImpl = options.fetchImpl ?? fetch;
  return fetchImpl(`${(options.baseUrl ?? "").replace(/\/$/, "")}${path}`, {
    ...init,
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      ...(options.authorization ? { Authorization: options.authorization } : {}),
      ...init.headers,
    },
  });
}

async function jsonBody<T>(response: Response): Promise<T> {
  const text = await response.text();
  return (text ? JSON.parse(text) : {}) as T;
}
