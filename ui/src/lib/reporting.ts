import type { ClaimsApiOptions, WorklistCode } from "./claims-worklist";

export interface AgingBucket {
  code: "0-30" | "31-60" | "61-90" | "91-plus";
  label: string;
  minDays: number;
  maxDays?: number;
  claimCount: number;
}

export interface AccountsReceivableDashboardData {
  totalOutstanding: { status: "unavailable"; reason: string };
  outstandingClaimCount: number;
  averageDaysOutstanding: number | null;
  agingBuckets: AgingBucket[];
  openWorklistCounts: Record<WorklistCode, number>;
  openWorklistTotal: number;
}

export async function fetchAccountsReceivableDashboard(
  options: ClaimsApiOptions = {},
): Promise<AccountsReceivableDashboardData> {
  const response = await request("/reports/accounts-receivable", options);
  return response.json() as Promise<AccountsReceivableDashboardData>;
}

export async function downloadCsvExport(
  path: string,
  fallbackFilename: string,
  options: ClaimsApiOptions = {},
): Promise<void> {
  const response = await request(path, options);
  const blob = await response.blob();
  const filename = response.headers.get("Content-Disposition")?.match(/filename="([^"]+)"/)?.[1]
    ?? fallbackFilename;
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

export function queryPath(path: string, values: object): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) {
    if (typeof value === "string" && value) query.set(key, value);
  }
  return query.size > 0 ? `${path}?${query.toString()}` : path;
}

async function request(path: string, options: ClaimsApiOptions): Promise<Response> {
  const response = await (options.fetchImpl ?? fetch)(
    `${(options.baseUrl ?? "").replace(/\/$/, "")}${path}`,
    {
      headers: {
        Accept: path.endsWith("/export") || path.includes("/export?") ? "text/csv" : "application/json",
        ...(options.authorization ? { Authorization: options.authorization } : {}),
      },
    },
  );
  if (!response.ok) {
    const text = await response.text();
    let message = `Reporting request failed with HTTP ${response.status}.`;
    try { message = (JSON.parse(text) as { error?: string }).error ?? message; } catch { /* response was not JSON */ }
    throw new Error(message);
  }
  return response;
}
