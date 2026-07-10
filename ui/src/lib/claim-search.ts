import type { ClaimsApiOptions, ClaimsWorklistItem } from "./claims-worklist";

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
  patient?: string;
  claim?: string;
  status?: ClaimSearchStatus;
  carrier?: string;
  office?: string;
  cpt?: string;
  minAmount?: string;
  maxAmount?: string;
  minDays?: string;
  maxDays?: string;
  outstanding?: "true";
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

export async function fetchClaimSearch(
  filters: ClaimSearchFilters,
  options: ClaimsApiOptions = {},
): Promise<ClaimSearchRow[]> {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) {
    if (value?.trim()) query.set(key, value.trim());
  }
  const suffix = query.size > 0 ? `?${query.toString()}` : "";
  const response = await (options.fetchImpl ?? fetch)(
    `${(options.baseUrl ?? "").replace(/\/$/, "")}/claims/search${suffix}`,
    {
      headers: {
        Accept: "application/json",
        ...(options.authorization ? { Authorization: options.authorization } : {}),
      },
    },
  );
  const text = await response.text();
  const body = text ? JSON.parse(text) as { items?: ClaimSearchRow[]; error?: string } : {};
  if (!response.ok) throw new Error(body.error ?? `Claim search failed with HTTP ${response.status}.`);
  return body.items ?? [];
}

export function failedClaimsCount(items: readonly ClaimsWorklistItem[]): number {
  return items.filter((item) =>
    (item.code === "claim-rejected" || item.code === "era-denial")
    && (item.status === "new" || item.status === "in-review"),
  ).length;
}

export function claimSearchFiltersFromQuery(search: string): ClaimSearchFilters {
  const query = new URLSearchParams(search);
  const status = query.get("status") ?? undefined;
  return {
    ...queryFilter(query, "patient"),
    ...queryFilter(query, "claim"),
    ...(status && CLAIM_SEARCH_STATUSES.includes(status as ClaimSearchStatus)
      ? { status: status as ClaimSearchStatus }
      : {}),
    ...queryFilter(query, "carrier"),
    ...queryFilter(query, "office"),
    ...queryFilter(query, "cpt"),
    ...queryFilter(query, "minAmount"),
    ...queryFilter(query, "maxAmount"),
    ...queryFilter(query, "minDays"),
    ...queryFilter(query, "maxDays"),
    ...(query.get("outstanding") === "true" ? { outstanding: "true" as const } : {}),
  };
}

function queryFilter(query: URLSearchParams, key: keyof ClaimSearchFilters): Partial<ClaimSearchFilters> {
  const value = query.get(key)?.trim();
  return value ? { [key]: value } : {};
}
