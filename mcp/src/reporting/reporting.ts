import type { Invoice, PaymentReconciliation, Resource } from "@medplum/fhirtypes";
import { resolveBusinessActionRole } from "../authz/roles.js";
import type { MedplumClient } from "../fhir-client.js";
import { ODOS_PAYMENT_TENDER_EXTENSION_URL } from "../fhir/odosPaymentTender.js";
import type { AuthenticatedStaff } from "../payments/payment-charge-handler.js";
import {
  isBalanceFundingInvoice,
  ODOS_PACKAGE_CREDIT_TENDER_CODE,
} from "../commercial-engine/package-service.js";
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

export interface ServiceProductionEndpointDeps {
  authenticate(authHeader: string | undefined): Promise<AuthenticatedStaff | null>;
  now?: () => string;
}

export interface ServiceProductionReport {
  period: string;
  cashCollectedCents: number;
  productionCents: number;
  balanceFundingCents: number;
  productionInvoiceCount: number;
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

export async function handleServiceProductionRequest(
  deps: ServiceProductionEndpointDeps,
  input: { authHeader: string | undefined; period?: string },
): Promise<ReportingResult> {
  const staff = await deps.authenticate(input.authHeader);
  if (!staff) return { status: 401, body: { error: "Authentication required to view production reporting." } };
  if (!resolveBusinessActionRole(staff.roles ?? [], "margin.read")) {
    return { status: 403, body: { error: "margin.read role required" } };
  }
  const period = input.period ?? (deps.now?.() ?? new Date().toISOString()).slice(0, 7);
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(period)) {
    return { status: 400, body: { error: "period must use YYYY-MM." } };
  }
  const start = `${period}-01`;
  const end = nextMonth(period);
  const [invoices, reconciliations] = await Promise.all([
    completePage<Invoice>(staff.fhir, "Invoice", [
      ["date", `ge${start}`],
      ["date", `lt${end}`],
      ["_count", "1000"],
    ]),
    completePage<PaymentReconciliation>(staff.fhir, "PaymentReconciliation", [
      ["created", `ge${start}`],
      ["created", `lt${end}`],
      ["status", "active"],
      ["_count", "1000"],
    ]),
  ]);
  if (!invoices.complete || !reconciliations.complete) {
    return { status: 409, body: { error: "Production reporting exceeded one complete FHIR page." } };
  }
  return { status: 200, body: projectServiceProduction(period, invoices.resources, reconciliations.resources) };
}

export function projectServiceProduction(
  period: string,
  invoices: readonly Invoice[],
  reconciliations: readonly PaymentReconciliation[],
): ServiceProductionReport {
  const allocatedCentsByInvoice = new Map<string, number>();
  for (const payment of reconciliations) {
    if (payment.status !== "active" || payment.outcome !== "complete") continue;
    for (const detail of payment.detail ?? []) {
      const invoiceReference = detail.request?.reference;
      if (!/^Invoice\/[A-Za-z0-9.-]+$/.test(invoiceReference ?? "")) continue;
      const amountCents = moneyCents(detail.amount?.value, "PaymentReconciliation detail amount");
      allocatedCentsByInvoice.set(invoiceReference!, (allocatedCentsByInvoice.get(invoiceReference!) ?? 0) + amountCents);
    }
  }
  let cashCollectedCents = 0;
  let productionCents = 0;
  let balanceFundingCents = 0;
  let productionInvoiceCount = 0;
  for (const invoice of invoices) {
    const reference = invoice.id ? `Invoice/${invoice.id}` : undefined;
    const allocatedCents = reference ? allocatedCentsByInvoice.get(reference) ?? 0 : 0;
    const tenderedInvoice = invoice.extension?.some((extension) => extension.url === ODOS_PAYMENT_TENDER_EXTENSION_URL);
    const netCents = invoiceNetCents(invoice);
    const collected = invoice.status === "balanced" || tenderedInvoice || allocatedCents >= netCents;
    if (!collected) continue;
    if (isBalanceFundingInvoice(invoice)) {
      balanceFundingCents += netCents;
    } else {
      productionCents += invoiceProductionCents(invoice);
      productionInvoiceCount += 1;
    }
    if (tenderedInvoice) cashCollectedCents += netCents;
  }
  cashCollectedCents += reconciliations
    .filter((payment) => payment.status === "active" && payment.outcome === "complete" && !isPackageCredit(payment))
    .reduce((sum, payment) => sum + moneyCents(payment.paymentAmount?.value, "PaymentReconciliation paymentAmount"), 0);
  return { period, cashCollectedCents, productionCents, balanceFundingCents, productionInvoiceCount };
}

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

function invoiceProductionCents(invoice: Invoice): number {
  return (invoice.lineItem ?? []).reduce((total, line) => {
    const base = (line.priceComponent ?? []).filter((component) => component.type === "base")
      .reduce((sum, component) => sum + moneyCents(component.amount?.value, "Invoice base amount"), 0);
    const discount = (line.priceComponent ?? []).filter((component) => component.type === "discount")
      .reduce((sum, component) => sum + moneyCents(component.amount?.value, "Invoice discount amount"), 0);
    return total + base - discount;
  }, 0);
}

function invoiceNetCents(invoice: Invoice): number {
  return moneyCents(invoice.totalNet?.value, `Invoice/${invoice.id ?? "(unknown)"} totalNet`);
}

function moneyCents(value: number | undefined, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new Error(`${label} is invalid.`);
  const cents = Math.round(value * 100);
  if (!Number.isSafeInteger(cents) || Math.abs(value * 100 - cents) > 0.000001) {
    throw new Error(`${label} is not representable in whole cents.`);
  }
  return cents;
}

function isPackageCredit(payment: PaymentReconciliation): boolean {
  return payment.extension?.some((extension) =>
    extension.url === ODOS_PAYMENT_TENDER_EXTENSION_URL
    && extension.valueCodeableConcept?.coding?.some((coding) => coding.code === ODOS_PACKAGE_CREDIT_TENDER_CODE),
  ) ?? false;
}

function nextMonth(period: string): string {
  const [year, month] = period.split("-").map(Number);
  return new Date(Date.UTC(year, month, 1)).toISOString().slice(0, 10);
}

async function completePage<T extends Resource>(
  fhir: Pick<MedplumClient, "search">,
  resourceType: T["resourceType"],
  params: Array<[string, string]>,
): Promise<{ complete: boolean; resources: T[] }> {
  const bundle = await fhir.search<T>(resourceType, params);
  if (bundle.link?.some((link) => link.relation === "next")) return { complete: false, resources: [] };
  return { complete: true, resources: (bundle.entry ?? []).flatMap((entry) => entry.resource ? [entry.resource] : []) };
}
