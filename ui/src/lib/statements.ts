import type { ClaimsApiOptions } from "./claims-worklist";

export interface StatementInvoiceRow {
  invoiceReference: string;
  date?: string;
  grossCents: number;
  netCents: number;
  paymentsAppliedCents: number;
  balanceCents: number;
}

export interface StatementAddress { lines: string[]; cityStatePostal?: string }
export interface StatementHeader {
  practiceName: string;
  practiceAddress?: StatementAddress;
  practicePhone?: string;
  providerName?: string;
  providerNpi?: string;
  providerLicense?: string;
  patientAddress?: StatementAddress;
}
export interface StatementAdjustmentRow { group?: string; code?: string; label: string; amountCents: number }
export interface StatementPaymentRow { paymentReference: string; date: string; amountCents: number }
export interface StatementClaimLine {
  sequence: number;
  serviceDate?: string;
  procedureCode?: string;
  procedureDisplay?: string;
  diagnosisCodes: string[];
  quantity: number;
  retailCents: number;
  payerName: string;
  insurancePaidCents: number;
  insuranceAdjustments: StatementAdjustmentRow[];
  patientAdjustments: StatementAdjustmentRow[];
}
export interface StatementOrderGroup {
  invoiceReference: string;
  orderNumber: string;
  claimReference?: string;
  claimNumber?: string;
  payerName?: string;
  mode: "insurance-aware" | "invoice-only";
  lines: StatementClaimLine[];
  patientPayments: StatementPaymentRow[];
}
export interface StatementDetail { header: StatementHeader; orders: StatementOrderGroup[] }

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
  unappliedPaymentReconciliationReferences?: string[];
  unappliedCreditCents?: number;
  balanceDueCents?: number;
  creditBalanceCents?: number;
  detail?: StatementDetail;
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
  if (statement.detail) return renderDetailedStatement(statement);
  const credit = accountCredit(statement);
  const invoiceRows = statement.invoices.map((invoice) => `<tr>
    <td>${escapeHtml(invoice.invoiceReference.replace("Invoice/", ""))}</td>
    <td>${invoice.date ? escapeHtml(formatDate(invoice.date)) : "—"}</td>
    <td>${formatStatementMoney(invoice.netCents)}</td>
    <td>${formatStatementMoney(invoice.paymentsAppliedCents)}</td>
    <td>${formatStatementMoney(invoice.balanceCents)}</td>
  </tr>`).join("\n");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Balance-forward statement</title></head>
<body><section class="odos-statement">
<style>
  body { margin: 0; color: #111; background: #fff; font: 14px/1.45 system-ui, sans-serif; }
  .odos-statement { max-width: 760px; margin: 0 auto; padding: 40px; }
  h1 { margin: 0 0 4px; font-size: 28px; } .sub { margin: 0 0 28px; color: #555; }
  .patient { display: grid; grid-template-columns: 1fr 1fr; gap: 8px 24px; margin-bottom: 24px; }
  table { width: 100%; border-collapse: collapse; } th, td { padding: 10px 8px; border-bottom: 1px solid #bbb; text-align: right; }
  th:first-child, td:first-child, th:nth-child(2), td:nth-child(2) { text-align: left; }
  .totals { width: min(420px, 100%); margin: 28px 0 0 auto; } .totals td:first-child { text-align: left; }
  .balance td { border-top: 2px solid #111; border-bottom: 3px double #111; font-size: 18px; font-weight: 800; }
  .note { margin-top: 28px; color: #555; }
  @media print { .odos-statement { max-width: none; } }
</style>
<h1>Balance-forward statement</h1>
<p class="sub">Printable statement · no mail or email was sent</p>
<div class="patient"><div><strong>Patient</strong><br>${escapeHtml(statement.patientName)}</div><div><strong>Statement date</strong><br>${escapeHtml(formatDate(statement.generatedAt))}</div></div>
<table><thead><tr><th>Invoice</th><th>Date</th><th>Charges</th><th>Payments</th><th>Balance</th></tr></thead><tbody>${invoiceRows}</tbody></table>
<table class="totals"><tbody>
  <tr><td>Total charges</td><td>${formatStatementMoney(statement.totalNetCents)}</td></tr>
  <tr><td>Payments applied</td><td>−${formatStatementMoney(statement.paymentsAppliedCents)}</td></tr>
  <tr><td>Invoice balance</td><td>${formatStatementMoney(statement.balanceCents)}</td></tr>
  <tr><td>Unapplied credit on account</td><td>−${formatStatementMoney(credit.unappliedCreditCents)}</td></tr>
  <tr class="balance"><td>Balance due</td><td>${formatStatementMoney(credit.balanceDueCents)}</td></tr>
  ${credit.creditBalanceCents > 0 ? `<tr class="credit"><td><strong>Credit balance</strong></td><td><strong>${formatStatementMoney(credit.creditBalanceCents)}</strong></td></tr>` : ""}
</tbody></table>
<p class="note">This balance is reconciled to the listed Invoice totals and recorded payment allocations as of the statement date.</p>
</section></body></html>`;
}

function renderDetailedStatement(statement: StatementRow): string {
  const detail = statement.detail!;
  const credit = accountCredit(statement);
  const practiceAddress = renderAddress(detail.header.practiceAddress);
  const patientAddress = renderAddress(detail.header.patientAddress);
  const orders = detail.orders.map((order) => {
    const invoice = statement.invoices.find((candidate) => candidate.invoiceReference === order.invoiceReference)!;
    if (order.mode === "invoice-only") {
      return `<section class="order degraded"><div class="order-head"><strong>Order # ${escapeHtml(order.orderNumber)}</strong><span>Invoice-only detail</span></div>
      <table><thead><tr><th>Date</th><th>Description</th><th>Qty</th><th>Retail</th><th>Insurance</th><th>Patient</th></tr></thead><tbody>
      <tr><td>${invoice.date ? escapeHtml(formatDate(invoice.date)) : "—"}</td><td>Invoice detail unavailable for this pre-seam balance</td><td>—</td><td>${formatStatementMoney(invoice.grossCents)}</td><td>—</td><td>${formatStatementMoney(invoice.netCents)}</td></tr>
      ${renderPatientPayments(order.patientPayments)}</tbody><tfoot><tr><th colspan="5">Order balance</th><th>${formatStatementMoney(invoice.balanceCents)}</th></tr></tfoot></table></section>`;
    }
    const rows = order.lines.map((line) => {
      const description = [line.procedureCode, line.diagnosisCodes.length ? `/ ${line.diagnosisCodes.join(", ")}` : "", line.procedureDisplay ? ` — ${line.procedureDisplay}` : ""].join("");
      return `<tr class="service"><td>${line.serviceDate ? escapeHtml(formatDate(line.serviceDate)) : "—"}</td><td><strong>${escapeHtml(description || "Claim line")}</strong><br><span class="muted">${escapeHtml(line.payerName)}</span></td><td>${escapeHtml(String(line.quantity))}</td><td>${formatStatementMoney(line.retailCents)}</td><td>${line.insurancePaidCents ? `Payment −${formatStatementMoney(line.insurancePaidCents)}` : "—"}</td><td>—</td></tr>
      ${line.insuranceAdjustments.map((adjustment) => renderAdjustment("Insurance adjustment", adjustment, "insurance")).join("")}
      ${line.patientAdjustments.map((adjustment) => renderAdjustment("Patient adjustment", adjustment, "patient")).join("")}`;
    }).join("");
    const quantity = order.lines.reduce((total, line) => total + line.quantity, 0);
    const retail = sum(order.lines.map((line) => line.retailCents));
    const insurance = sum(order.lines.flatMap((line) => [line.insurancePaidCents, ...line.insuranceAdjustments.map((row) => row.amountCents)]));
    const patient = sum(order.lines.flatMap((line) => line.patientAdjustments.map((row) => row.amountCents)));
    return `<section class="order"><div class="order-head"><strong>Order # ${escapeHtml(order.orderNumber)}</strong><span>Claim # ${escapeHtml(order.claimNumber ?? "—")} · ${escapeHtml(order.payerName ?? "Payer not listed")}</span></div>
    <table><thead><tr><th>Date</th><th>Description</th><th>Qty</th><th>Retail</th><th>Insurance</th><th>Patient</th></tr></thead><tbody>${rows}${renderPatientPayments(order.patientPayments)}</tbody>
    <tfoot><tr><th colspan="2">Subtotal</th><th>${escapeHtml(String(quantity))}</th><th>${formatStatementMoney(retail)}</th><th>${formatStatementMoney(insurance)}</th><th>${formatStatementMoney(patient)}</th></tr>
    <tr><th colspan="5">Order balance</th><th>${formatStatementMoney(invoice.balanceCents)}</th></tr></tfoot></table></section>`;
  }).join("");
  const detailTotals = detail.orders.reduce((totals, order) => {
    if (order.mode === "invoice-only") {
      const invoice = statement.invoices.find((candidate) => candidate.invoiceReference === order.invoiceReference)!;
      totals.retailCents += invoice.grossCents;
      totals.patientCents += invoice.netCents;
      return totals;
    }
    for (const line of order.lines) {
      totals.quantity += line.quantity;
      totals.retailCents += line.retailCents;
      totals.insuranceCents += line.insurancePaidCents + sum(line.insuranceAdjustments.map((row) => row.amountCents));
      totals.patientCents += sum(line.patientAdjustments.map((row) => row.amountCents));
    }
    return totals;
  }, { quantity: 0, retailCents: 0, insuranceCents: 0, patientCents: 0 });
  const provider = [detail.header.providerName, detail.header.providerNpi ? `NPI ${detail.header.providerNpi}` : undefined, detail.header.providerLicense ? `License # ${detail.header.providerLicense}` : undefined]
    .filter(Boolean).map((value) => escapeHtml(value!)).join("<br>");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Patient statement</title></head><body><main class="mailer">
  <style>
    * { box-sizing: border-box; } body { margin: 0; color: #111; background: #fff; font: 12px/1.35 Arial, sans-serif; }
    .mailer { max-width: 8.5in; margin: 0 auto; padding: .38in; } .top { display: grid; grid-template-columns: 1.25fr .9fr; gap: 24px; }
    h1 { margin: 0; font-size: 24px; } .practice { font-size: 13px; } .meta { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
    .box { border: 1px solid #222; padding: 9px; } .label { color: #555; font-size: 10px; font-weight: 700; letter-spacing: .06em; text-transform: uppercase; }
    .pay { background: #111; color: #fff; text-align: center; } .pay strong { display: block; margin-top: 3px; font-size: 25px; }
    .addresses { display: grid; grid-template-columns: 1fr 1fr; gap: 18px; margin: 18px 0; } .order { margin-top: 17px; break-inside: avoid; }
    .order-head { display: flex; justify-content: space-between; gap: 12px; padding: 7px 9px; background: #e7e7e7; border: 1px solid #999; }
    .degraded .order-head { background: #f5f1dd; } table { width: 100%; border-collapse: collapse; table-layout: fixed; }
    th, td { border: 1px solid #aaa; padding: 6px; text-align: right; vertical-align: top; } th:nth-child(1), td:nth-child(1) { width: 13%; text-align: left; }
    th:nth-child(2), td:nth-child(2) { width: 39%; text-align: left; } th:nth-child(3), td:nth-child(3) { width: 8%; }
    .activity td { border-top: 0; } .muted { color: #555; } tfoot th { background: #f1f1f1; }
    .detail-total { margin-top: 12px; } .detail-total th:first-child { text-align: right; }
    .statement-total { width: 48%; margin: 18px 0 0 auto; } .statement-total .due th { border-top: 2px solid #111; font-size: 16px; }
    .tear { margin-top: 28px; padding-top: 16px; border-top: 2px dashed #555; break-inside: avoid; } .tear-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 18px; }
    .fields { display: grid; grid-template-columns: 1fr 72px 72px; gap: 9px; margin-top: 12px; } .blank { display: block; min-height: 22px; border-bottom: 1px solid #111; }
    .signature { margin-top: 14px; } @media print { .mailer { max-width: none; } }
  </style>
  <section class="top"><div class="practice"><h1>${escapeHtml(detail.header.practiceName)}</h1>${practiceAddress}${detail.header.practicePhone ? `<div>${escapeHtml(detail.header.practicePhone)}</div>` : ""}</div>
  <div class="meta"><div class="box"><span class="label">Statement date</span><br>${escapeHtml(formatDate(statement.generatedAt))}</div><div class="box pay"><span class="label">Pay this amount</span><strong>${formatStatementMoney(credit.balanceDueCents)}</strong></div></div></section>
  <section class="addresses"><div class="box"><span class="label">Mail to</span><br><strong>${escapeHtml(statement.patientName)}</strong>${patientAddress ? `<br>${patientAddress}` : ""}</div>
  <div class="box"><span class="label">Remit payment to</span><br><strong>${escapeHtml(detail.header.practiceName)}</strong>${practiceAddress ? `<br>${practiceAddress}` : ""}${provider ? `<br><br>${provider}` : ""}</div></section>
  ${orders}
  <table class="detail-total"><tbody><tr><th colspan="2">Total</th><th>${escapeHtml(String(detailTotals.quantity))}</th><th>${formatStatementMoney(detailTotals.retailCents)}</th><th>${formatStatementMoney(detailTotals.insuranceCents)}</th><th>${formatStatementMoney(detailTotals.patientCents)}</th></tr></tbody></table>
  <table class="statement-total"><tbody><tr><th>Invoice balance</th><td>${formatStatementMoney(statement.balanceCents)}</td></tr><tr><th>Unapplied credit</th><td>−${formatStatementMoney(credit.unappliedCreditCents)}</td></tr><tr class="due"><th>PAY THIS AMOUNT</th><td>${formatStatementMoney(credit.balanceDueCents)}</td></tr></tbody></table>
  <section class="tear"><div class="tear-grid"><div><strong>Detach and return with payment</strong><br>Due: Upon Receipt<br>Make checks payable to ${escapeHtml(detail.header.practiceName)}.</div><div><span class="label">Amount enclosed</span><span class="blank"></span><br>☐ VISA &nbsp;&nbsp; ☐ MasterCard &nbsp;&nbsp; ☐ Check</div></div>
  <div class="fields"><div><span class="label">Card number</span><span class="blank"></span></div><div><span class="label">Exp.</span><span class="blank"></span></div><div><span class="label">CVV</span><span class="blank"></span></div></div>
  <div class="signature">I authorize the practice to charge the amount written above to the card listed on this form.<br><span class="blank"></span><span class="label">Signature</span></div></section>
  </main></body></html>`;
}

function renderAdjustment(kind: string, adjustment: StatementAdjustmentRow, column: "insurance" | "patient"): string {
  const label = `${kind}: ${adjustment.label}`;
  return `<tr class="activity"><td></td><td>${escapeHtml(label)}</td><td></td><td></td><td>${column === "insurance" ? `−${formatStatementMoney(adjustment.amountCents)}` : ""}</td><td>${column === "patient" ? formatStatementMoney(adjustment.amountCents) : ""}</td></tr>`;
}

function renderPatientPayments(payments: StatementPaymentRow[]): string {
  return payments.map((payment) => `<tr class="activity"><td>${escapeHtml(formatDate(payment.date))}</td><td>Patient payment</td><td></td><td></td><td></td><td>−${formatStatementMoney(payment.amountCents)}</td></tr>`).join("");
}

function renderAddress(address: StatementAddress | undefined): string {
  if (!address) return "";
  return [...address.lines, address.cityStatePostal].filter(Boolean).map((line) => escapeHtml(line!)).join("<br>");
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
  accountCredit(statement);
}

export function accountCredit(statement: StatementRow): {
  unappliedCreditCents: number;
  balanceDueCents: number;
  creditBalanceCents: number;
} {
  const unappliedCreditCents = statement.unappliedCreditCents ?? 0;
  const balanceDueCents = statement.balanceDueCents ?? statement.balanceCents;
  const creditBalanceCents = statement.creditBalanceCents ?? 0;
  if (![unappliedCreditCents, balanceDueCents, creditBalanceCents].every((value) => Number.isInteger(value) && value >= 0)
    || balanceDueCents !== Math.max(0, statement.balanceCents - unappliedCreditCents)
    || creditBalanceCents !== Math.max(0, unappliedCreditCents - statement.balanceCents)) {
    throw new Error("Statement account credit does not reconcile.");
  }
  return { unappliedCreditCents, balanceDueCents, creditBalanceCents };
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
