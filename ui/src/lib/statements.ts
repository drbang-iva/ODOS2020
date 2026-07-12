import type { ClaimsApiOptions } from "./claims-worklist";

export interface StatementInvoiceRow {
  invoiceReference: string;
  date?: string;
  grossCents: number;
  netCents: number;
  paymentsAppliedCents: number;
  balanceCents: number;
}

export interface StatementRow {
  statementReference: string;
  runReference?: string;
  generatedAt: string;
  patientReference: string;
  patientName: string;
  paymentReconciliationReferences: string[];
  invoices: StatementInvoiceRow[];
  totalGrossCents: number;
  totalNetCents: number;
  paymentsAppliedCents: number;
  balanceCents: number;
}

export interface StatementRejectRow {
  patientReference: string;
  patientName: string;
  reason: string;
}

export interface StatementRunResult {
  runReference: string;
  generatedAt: string;
  generatedCount: number;
  invalidRejects: number;
  skippedZeroBalanceCount: number;
  statements: StatementRow[];
  rejects: StatementRejectRow[];
}

export function formatStatementMoney(cents: number): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(cents / 100);
}

export async function fetchStatements(options: ClaimsApiOptions = {}): Promise<StatementRow[]> {
  const body = await requestJson<{ items?: StatementRow[] }>("/statements", {}, options);
  return body.items ?? [];
}

export function generatePatientStatement(
  patientReference: string,
  options: ClaimsApiOptions = {},
): Promise<StatementRunResult> {
  return requestJson("/statements/generate", {
    method: "POST",
    body: JSON.stringify({ patientReference }),
  }, options);
}

export function runStatements(options: ClaimsApiOptions = {}): Promise<StatementRunResult> {
  return requestJson("/statements/run", { method: "POST" }, options);
}

export function renderBalanceForwardStatement(statement: StatementRow): string {
  assertReconciled(statement);
  const invoiceRows = statement.invoices.map((invoice) => `<tr>
    <td>${escapeHtml(invoice.invoiceReference.replace("Invoice/", ""))}</td>
    <td>${invoice.date ? escapeHtml(formatDate(invoice.date)) : "—"}</td>
    <td>${formatStatementMoney(invoice.netCents)}</td>
    <td>${formatStatementMoney(invoice.paymentsAppliedCents)}</td>
    <td>${formatStatementMoney(invoice.balanceCents)}</td>
  </tr>`).join("\n");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Balance-forward statement</title></head>
<body><section class="osod-statement">
<style>
  body { margin: 0; color: #111; background: #fff; font: 14px/1.45 system-ui, sans-serif; }
  .osod-statement { max-width: 760px; margin: 0 auto; padding: 40px; }
  h1 { margin: 0 0 4px; font-size: 28px; } .sub { margin: 0 0 28px; color: #555; }
  .patient { display: grid; grid-template-columns: 1fr 1fr; gap: 8px 24px; margin-bottom: 24px; }
  table { width: 100%; border-collapse: collapse; } th, td { padding: 10px 8px; border-bottom: 1px solid #bbb; text-align: right; }
  th:first-child, td:first-child, th:nth-child(2), td:nth-child(2) { text-align: left; }
  .totals { width: min(420px, 100%); margin: 28px 0 0 auto; } .totals td:first-child { text-align: left; }
  .balance td { border-top: 2px solid #111; border-bottom: 3px double #111; font-size: 18px; font-weight: 800; }
  .note { margin-top: 28px; color: #555; }
  @media print { .osod-statement { max-width: none; } }
</style>
<h1>Balance-forward statement</h1>
<p class="sub">Printable statement · no mail or email was sent</p>
<div class="patient"><div><strong>Patient</strong><br>${escapeHtml(statement.patientName)}</div><div><strong>Statement date</strong><br>${escapeHtml(formatDate(statement.generatedAt))}</div></div>
<table><thead><tr><th>Invoice</th><th>Date</th><th>Charges</th><th>Payments</th><th>Balance</th></tr></thead><tbody>${invoiceRows}</tbody></table>
<table class="totals"><tbody>
  <tr><td>Total charges</td><td>${formatStatementMoney(statement.totalNetCents)}</td></tr>
  <tr><td>Payments applied</td><td>−${formatStatementMoney(statement.paymentsAppliedCents)}</td></tr>
  <tr class="balance"><td>Balance forward</td><td>${formatStatementMoney(statement.balanceCents)}</td></tr>
</tbody></table>
<p class="note">This balance is reconciled to the listed Invoice totals and recorded payment allocations as of the statement date.</p>
</section></body></html>`;
}

function assertReconciled(statement: StatementRow): void {
  if (statement.invoices.some((invoice) =>
    !Number.isInteger(invoice.netCents) || !Number.isInteger(invoice.paymentsAppliedCents)
    || !Number.isInteger(invoice.balanceCents) || invoice.netCents < 0 || invoice.paymentsAppliedCents < 0
    || invoice.balanceCents < 0 || invoice.balanceCents !== invoice.netCents - invoice.paymentsAppliedCents,
  )) throw new Error("Statement cannot print because an Invoice row does not reconcile.");
  const totalNetCents = sum(statement.invoices.map((invoice) => invoice.netCents));
  const paymentsAppliedCents = sum(statement.invoices.map((invoice) => invoice.paymentsAppliedCents));
  const balanceCents = sum(statement.invoices.map((invoice) => invoice.balanceCents));
  if (totalNetCents !== statement.totalNetCents || paymentsAppliedCents !== statement.paymentsAppliedCents
    || balanceCents !== statement.balanceCents || balanceCents !== totalNetCents - paymentsAppliedCents) {
    throw new Error("Statement cannot print because its persisted totals do not reconcile.");
  }
}

async function requestJson<T>(path: string, init: RequestInit, options: ClaimsApiOptions): Promise<T> {
  const response = await (options.fetchImpl ?? fetch)(`${(options.baseUrl ?? "").replace(/\/$/, "")}${path}`, {
    ...init,
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      ...(options.authorization ? { Authorization: options.authorization } : {}),
      ...init.headers,
    },
  });
  const text = await response.text();
  const body = text ? JSON.parse(text) as T & { error?: string } : {} as T & { error?: string };
  if (!response.ok) throw new Error(body.error ?? `Statement request failed with HTTP ${response.status}.`);
  return body;
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat("en-US", { year: "numeric", month: "short", day: "numeric" }).format(new Date(value));
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!);
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}
