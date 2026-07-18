import type { PaymentCreditHandlerDeps, PatientPaymentRow } from "../payments/payment-credit-handler.js";
import {
  handlePaymentReconciliationsRequest,
} from "../payments/payment-credit-handler.js";
import type { ClaimSearchRow } from "../claims/claim-search.js";
import type { EraBatchItem, EraWorklistAttentionItem, WorklistCode } from "../claims/era-worklist.js";
import {
  handleClaimSearchRequest,
  handleEraListRequest,
  handleEraWorklistRequest,
  type ClaimsHandlerDeps,
} from "../claims/claimmd-handlers.js";

export interface ReportingHandlerDeps {
  claims: ClaimsHandlerDeps;
  payments: Pick<PaymentCreditHandlerDeps, "authenticate" | "now">;
}

export interface ReportingResult {
  status: number;
  body: unknown;
  csvFilename?: string;
}

export interface AgingBucket {
  code: "0-30" | "31-60" | "61-90" | "91-plus";
  label: string;
  minDays: number;
  maxDays?: number;
  claimCount: number;
}

export interface AccountsReceivableDashboard {
  totalOutstanding: {
    status: "unavailable";
    reason: string;
  };
  outstandingClaimCount: number;
  averageDaysOutstanding: number | null;
  agingBuckets: AgingBucket[];
  openWorklistCounts: Record<WorklistCode, number>;
  openWorklistTotal: number;
}

const TOTAL_OUTSTANDING_GAP =
  "Claim Search has submitted charges and insurer payment state, while Patient Payments settles Invoices. "
  + "No shipped Claim-to-Invoice balance link or post-adjustment balance supports an honest dollar total.";

export async function handleAccountsReceivableDashboardRequest(
  deps: ReportingHandlerDeps,
  input: { authHeader: string | undefined },
): Promise<ReportingResult> {
  const claims = await handleClaimSearchRequest(deps.claims, {
    authHeader: input.authHeader,
    query: { outstanding: "true" },
  });
  if (claims.status !== 200) return claims;
  const worklist = await handleEraWorklistRequest(deps.claims, {
    authHeader: input.authHeader,
    query: { status: "open" },
  });
  if (worklist.status !== 200) return worklist;
  return {
    status: 200,
    body: projectAccountsReceivableDashboard(
      itemsFrom<ClaimSearchRow>(claims.body),
      itemsFrom<EraWorklistAttentionItem>(worklist.body),
    ),
  };
}

export async function handleClaimSearchExportRequest(
  deps: ReportingHandlerDeps,
  input: { authHeader: string | undefined; query?: Record<string, unknown> },
): Promise<ReportingResult> {
  const result = await handleClaimSearchRequest(deps.claims, input);
  if (result.status !== 200) return result;
  return csvResult("claim-search.csv", [
    "Claim #",
    "Patient",
    "Provider",
    "CPT",
    "Charged",
    "Insurance paid",
    "Patient responsibility",
    "Status",
    "Payer",
    "Office",
    "Days since submission",
  ], itemsFrom<ClaimSearchRow>(result.body).map((item) => [
    item.claimNumber,
    item.patient,
    item.provider,
    item.cptCodes.join("; "),
    cents(item.totalChargedCents),
    cents(item.insurancePaidCents),
    cents(item.patientResponsibilityCents),
    item.status,
    item.payer,
    item.office ?? "",
    item.daysSinceSubmission,
  ]));
}

export async function handleRemittanceExportRequest(
  deps: ReportingHandlerDeps,
  input: { authHeader: string | undefined; query?: Record<string, unknown> },
): Promise<ReportingResult> {
  const result = await handleEraListRequest(deps.claims, { authHeader: input.authHeader });
  if (result.status !== 200) return result;
  const lane = queryString(input.query?.lane);
  if (lane && lane !== "new" && lane !== "imported" && lane !== "fully-worked") {
    return { status: 400, body: { error: "lane must be new, imported, or fully-worked." } };
  }
  const items = itemsFrom<EraBatchItem>(result.body).filter((item) => !lane || item.lane === lane);
  return csvResult("remittance-queue.csv", [
    "ERA id",
    "Lane",
    "Payer",
    "Paid date",
    "Claims",
    "Paid total",
    "Posted",
    "Denied",
    "Underpaid",
    "Unmatched",
    "Open tasks",
  ], items.map((item) => [
    item.eraId,
    item.lane,
    item.payerName ?? "",
    item.paidDate ?? "",
    item.claimCount ?? "",
    cents(item.paidTotalCents),
    item.posted,
    item.denied,
    item.underpaid,
    item.flagged,
    item.openTaskCount,
  ]));
}

export async function handleWorklistExportRequest(
  deps: ReportingHandlerDeps,
  input: { authHeader: string | undefined; query?: Record<string, unknown> },
): Promise<ReportingResult> {
  const result = await handleEraWorklistRequest(deps.claims, input);
  if (result.status !== 200) return result;
  return csvResult("claims-worklist.csv", [
    "Task",
    "Lane",
    "Title",
    "Patient",
    "Severity",
    "Status",
    "Owner",
    "Started at",
    "Age minutes",
    "Evidence",
  ], itemsFrom<EraWorklistAttentionItem>(result.body).map((item) => [
    item.taskReference,
    item.code,
    item.title,
    item.patientReference ?? "",
    item.severity,
    item.status,
    item.owner ?? "",
    item.ageTimer.startedAt,
    item.ageTimer.elapsedMinutes,
    evidenceSummary(item),
  ]));
}

export async function handlePatientPaymentsExportRequest(
  deps: ReportingHandlerDeps,
  input: { authHeader: string | undefined; query?: Record<string, unknown> },
): Promise<ReportingResult> {
  const result = await handlePaymentReconciliationsRequest(deps.payments, input);
  if (result.status !== 200) return result;
  return csvResult("patient-payments.csv", [
    "Payment",
    "Patient",
    "Date",
    "Tender",
    "Amount",
    "Allocated",
    "Unapplied",
    "Linked invoices",
    "Status",
  ], itemsFrom<PatientPaymentRow>(result.body).map((item) => [
    item.paymentReconciliationReference,
    item.patientReference,
    item.date,
    item.tender,
    cents(item.amountCents),
    cents(item.allocatedCents),
    cents(item.unappliedCents),
    item.invoices.map((invoice) => invoice.label).join("; "),
    item.status,
  ]));
}

export function projectAccountsReceivableDashboard(
  outstandingClaims: readonly ClaimSearchRow[],
  openWorklist: readonly EraWorklistAttentionItem[],
): AccountsReceivableDashboard {
  const totalDays = outstandingClaims.reduce((sum, claim) => sum + claim.daysSinceSubmission, 0);
  const openWorklistCounts: Record<WorklistCode, number> = {
    "era-denial": 0,
    "era-line-linkage": 0,
    "era-underpayment": 0,
    "era-unmatched": 0,
    "claim-rejected": 0,
  };
  for (const item of openWorklist) openWorklistCounts[item.code] += 1;
  return {
    totalOutstanding: { status: "unavailable", reason: TOTAL_OUTSTANDING_GAP },
    outstandingClaimCount: outstandingClaims.length,
    averageDaysOutstanding: outstandingClaims.length === 0
      ? null
      : Math.round((totalDays / outstandingClaims.length) * 10) / 10,
    agingBuckets: [
      agingBucket("0-30", "0-30 days", 0, 30, outstandingClaims),
      agingBucket("31-60", "31-60 days", 31, 60, outstandingClaims),
      agingBucket("61-90", "61-90 days", 61, 90, outstandingClaims),
      agingBucket("91-plus", "91+ days", 91, undefined, outstandingClaims),
    ],
    openWorklistCounts,
    openWorklistTotal: openWorklist.length,
  };
}

export function toCsv(headers: readonly string[], rows: ReadonlyArray<ReadonlyArray<string | number>>): string {
  return `\uFEFF${[headers, ...rows].map((row) => row.map(csvCell).join(",")).join("\r\n")}\r\n`;
}

function agingBucket(
  code: AgingBucket["code"],
  label: string,
  minDays: number,
  maxDays: number | undefined,
  claims: readonly ClaimSearchRow[],
): AgingBucket {
  return {
    code,
    label,
    minDays,
    ...(maxDays === undefined ? {} : { maxDays }),
    claimCount: claims.filter((claim) =>
      claim.daysSinceSubmission >= minDays && (maxDays === undefined || claim.daysSinceSubmission <= maxDays),
    ).length,
  };
}

function evidenceSummary(item: EraWorklistAttentionItem): string {
  if (item.evidence.kind === "claim-rejected") return item.evidence.claimMdMessage;
  return [
    `ERA ${item.evidence.eraId}`,
    `PCN ${item.evidence.pcn}`,
    `charged ${cents(item.evidence.chargedCents)}`,
    `paid ${cents(item.evidence.paidCents)}`,
    `shortfall ${cents(item.evidence.shortfallCents)}`,
  ].join("; ");
}

function csvResult(
  csvFilename: string,
  headers: readonly string[],
  rows: ReadonlyArray<ReadonlyArray<string | number>>,
): ReportingResult {
  return { status: 200, body: toCsv(headers, rows), csvFilename };
}

function itemsFrom<T>(body: unknown): T[] {
  return (body as { items?: T[] }).items ?? [];
}

function csvCell(value: string | number): string {
  let text = String(value);
  if (/^\s*[=+@-]/.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function cents(value: number): string {
  return (value / 100).toFixed(2);
}

function queryString(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (Array.isArray(value) && typeof value[0] === "string") return value[0];
  return undefined;
}
