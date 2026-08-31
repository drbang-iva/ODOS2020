export const WORKLIST_CODES = ["era-denial", "era-integrity", "era-line-linkage", "era-underpayment", "era-unmatched", "claim-rejected"] as const;
export const WORKLIST_STATUSES = ["new", "in-review", "resolved"] as const;
export const WORKLIST_DISPOSITIONS = ["rebilled", "appealed", "written-off", "matched", "posted-ok", "legacy"] as const;

export type WorklistCode = (typeof WORKLIST_CODES)[number];
export type WorklistStatus = (typeof WORKLIST_STATUSES)[number];
export type WorklistFilterStatus = WorklistStatus | "open";
export type WorklistDisposition = (typeof WORKLIST_DISPOSITIONS)[number];
export type EraBatchLane = "new" | "imported" | "fully-worked";

export interface EraBatchItem {
  eraId: string;
  lane: EraBatchLane;
  importedAt?: string;
  posted: number;
  denied: number;
  underpaid: number;
  flagged: number;
  payerName?: string;
  paidDate?: string;
  paidTotalCents: number;
  claimCount?: number;
  openTaskCount: number;
}

export interface EraEvidence {
  kind: "era";
  pcn: string;
  payerIcn?: string;
  eraId: string;
  chargedCents: number;
  allowedCents: number;
  paidCents: number;
  patientResponsibilityCents: number;
  shortfallCents: number;
  adjustments: Array<{ group?: string; code?: string }>;
}

export interface ClaimRejectedEvidence {
  kind: "claim-rejected";
  claimMdMessage: string;
}

export interface ClaimsWorklistItem {
  id: string;
  taskReference: string;
  title: string;
  code: WorklistCode;
  patientReference?: string;
  focusReference?: string;
  severity: "high" | "medium";
  ageTimer: { startedAt: string; elapsedMinutes: number };
  action: "claim" | "resolve" | "none";
  owner?: string;
  status: WorklistStatus;
  resolutionDisposition?: WorklistDisposition;
  evidence: EraEvidence | ClaimRejectedEvidence;
}

export interface ClaimsApiOptions {
  authorization?: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

export interface ResolveWorklistInput {
  disposition: WorklistDisposition;
  claimReference?: string;
  patientReference?: string;
  insurerReference?: string;
}

export const WORKLIST_LANES: ReadonlyArray<{ code: WorklistCode; label: string }> = [
  { code: "era-denial", label: "ERA denials" },
  { code: "era-integrity", label: "ERA integrity" },
  { code: "era-line-linkage", label: "Line linkage" },
  { code: "era-underpayment", label: "Underpayments" },
  { code: "era-unmatched", label: "Unmatched ERAs" },
  { code: "claim-rejected", label: "Rejected claims" },
];

export const ERA_BATCH_LANES: ReadonlyArray<{ code: EraBatchLane; label: string }> = [
  { code: "new", label: "New" },
  { code: "imported", label: "Imported" },
  { code: "fully-worked", label: "Fully worked" },
];

export function groupWorklistItems(items: readonly ClaimsWorklistItem[]): Record<WorklistCode, ClaimsWorklistItem[]> {
  const grouped: Record<WorklistCode, ClaimsWorklistItem[]> = {
    "era-denial": [],
    "era-integrity": [],
    "era-line-linkage": [],
    "era-underpayment": [],
    "era-unmatched": [],
    "claim-rejected": [],
  };
  for (const item of items) grouped[item.code].push(item);
  return grouped;
}

export function dispositionsForLane(code: WorklistCode): WorklistDisposition[] {
  const shared: WorklistDisposition[] = ["rebilled", "appealed", "written-off", "posted-ok"];
  return code === "era-unmatched" ? [...shared, "matched", "legacy"] : shared;
}

export async function fetchClaimsWorklist(
  status: WorklistFilterStatus | undefined,
  options: ClaimsApiOptions = {},
): Promise<ClaimsWorklistItem[]> {
  const query = status ? `?status=${encodeURIComponent(status)}` : "";
  const body = await requestJson<{ items?: ClaimsWorklistItem[] }>(`/claims/worklist${query}`, {}, options);
  return body.items ?? [];
}

export async function fetchEraBatches(options: ClaimsApiOptions = {}): Promise<EraBatchItem[]> {
  const body = await requestJson<{ items?: EraBatchItem[] }>("/claims/era", {}, options);
  return body.items ?? [];
}

export function worklistItemsForEra(
  items: readonly ClaimsWorklistItem[],
  eraId: string,
): ClaimsWorklistItem[] {
  return items.filter((item) => item.evidence.kind === "era" && item.evidence.eraId === eraId);
}

export async function claimWorklistItem(id: string, options: ClaimsApiOptions = {}): Promise<void> {
  await requestJson(`/claims/worklist/${encodeURIComponent(id)}/claim`, { method: "POST" }, options);
}

export async function resolveWorklistItem(
  id: string,
  input: ResolveWorklistInput,
  options: ClaimsApiOptions = {},
): Promise<void> {
  await requestJson(
    `/claims/worklist/${encodeURIComponent(id)}/resolve`,
    { method: "POST", body: JSON.stringify(input) },
    options,
  );
}

async function requestJson<T = unknown>(path: string, init: RequestInit, options: ClaimsApiOptions): Promise<T> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await fetchImpl(`${(options.baseUrl ?? "").replace(/\/$/, "")}${path}`, {
    ...init,
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      ...(options.authorization ? { Authorization: options.authorization } : {}),
      ...init.headers,
    },
  });
  const text = await response.text();
  const body = text ? JSON.parse(text) as { error?: string } : {};
  if (!response.ok) {
    throw new Error(body.error ?? `Claims worklist request failed with HTTP ${response.status}.`);
  }
  return body as T;
}
