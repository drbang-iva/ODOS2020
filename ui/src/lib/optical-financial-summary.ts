import type {
  ChargeItem,
  Invoice,
  InvoiceLineItemPriceComponent,
  PaymentReconciliation,
} from "@medplum/fhirtypes";
import { OSOD_PAYMENT_TENDER_EXTENSION_URL } from "./optical-order";

/**
 * Slice-3c patient receipt / financial summary. Assembles the patient money document from the
 * cash-order kernel's outputs: the Invoice (money truth: base/discount/tax priceComponents,
 * totals, tender) + the ChargeItem[] (line identity: description + code, display-only pass-through).
 * Completes the cash-dispensary output pair with the Slice-3b lab sheet (corpus §1.6 — the two
 * outputs Foxfire staff confuse; ODOS names them unmistakably). See performance-od
 * decisions/2026-07-04-odos-slice3c-patient-receipt-t0-spec.md.
 */

export interface FinancialSummaryLine {
  description: string;
  /** CPT/HCPCS shown on the receipt — display-only pass-through, never asserted by ODOS. */
  code?: string;
  quantity: number;
  feeCents: number;
  discount?: { code: string; amountCents: number };
  taxCents: number;
  /** fee − discount + tax for this line. */
  patientBalanceCents: number;
}

export interface FinancialSummaryTenderLine {
  tender: string;
  amountCents: number;
}

export interface FinancialSummary {
  header: {
    practiceName: string;
    patientName: string;
    patientRef?: string;
    receiptDate: string;
    orderId: string;
    providerName?: string;
    invoiceId?: string;
  };
  lines: FinancialSummaryLine[];
  totals: {
    chargesSubtotalCents: number;
    discountTotalCents: number;
    taxTotalCents: number;
    chargesPlusTaxCents: number;
    netCents: number;
  };
  payments: {
    tenderLines: FinancialSummaryTenderLine[];
    paymentsAppliedCents: number;
  };
  amountDueNowCents: number;
}

export interface BuildFinancialSummaryInput {
  practiceName: string;
  patientName: string;
  patientRef?: string;
  receiptDate: string;
  orderId: string;
  providerName?: string;
  /** The cash-order Invoice (money truth). */
  invoice: Invoice;
  /** The order's ChargeItems, in the same order as the Invoice lines (composite-assembler order). */
  chargeItems: ChargeItem[];
  /** Payments actually collected. Defaults to one line of the Invoice tender for the full net. */
  payments?: FinancialSummaryTenderLine[];
}

export function buildFinancialSummary(input: BuildFinancialSummaryInput): FinancialSummary {
  const invoiceLines = input.invoice.lineItem ?? [];
  if (invoiceLines.length === 0) {
    throw new Error("Financial summary requires an Invoice with at least one line item.");
  }
  if (invoiceLines.length !== input.chargeItems.length) {
    throw new Error(
      `Financial summary line mismatch: Invoice has ${invoiceLines.length} lines but ${input.chargeItems.length} ChargeItems were supplied.`,
    );
  }

  const lines = invoiceLines.map((invoiceLine, index) => {
    const chargeItem = input.chargeItems[index];
    const coding = chargeItem.code?.coding?.[0];
    const feeCents = componentCents(invoiceLine.priceComponent, "base");
    const taxCents = componentCents(invoiceLine.priceComponent, "tax");
    const discountComponent = invoiceLine.priceComponent?.find((pc) => pc.type === "discount");
    const discount = discountComponent
      ? {
          code: discountComponent.code?.coding?.[0]?.code ?? "ADJ",
          amountCents: toCents(discountComponent.amount?.value ?? 0),
        }
      : undefined;

    return {
      description: coding?.display ?? coding?.code ?? "Charge",
      ...(coding?.code ? { code: coding.code } : {}),
      quantity: chargeItem.quantity?.value ?? 1,
      feeCents,
      ...(discount ? { discount } : {}),
      taxCents,
      patientBalanceCents: feeCents - (discount?.amountCents ?? 0) + taxCents,
    };
  });

  const chargesSubtotalCents = sum(lines.map((line) => line.feeCents));
  const discountTotalCents = sum(lines.map((line) => line.discount?.amountCents ?? 0));
  const taxTotalCents = sum(lines.map((line) => line.taxCents));
  const chargesPlusTaxCents = chargesSubtotalCents + taxTotalCents;
  const netCents = chargesSubtotalCents - discountTotalCents + taxTotalCents;

  const invoiceGrossCents = toCents(input.invoice.totalGross?.value ?? NaN);
  const invoiceNetCents = toCents(input.invoice.totalNet?.value ?? NaN);
  if (chargesSubtotalCents + taxTotalCents !== invoiceGrossCents || netCents !== invoiceNetCents) {
    throw new Error(
      `Financial summary does not reconcile to the Invoice: computed gross ${chargesPlusTaxCents}/net ${netCents} cents vs Invoice gross ${invoiceGrossCents}/net ${invoiceNetCents}.`,
    );
  }

  const tenderLines = input.payments ?? [{ tender: invoiceTender(input.invoice), amountCents: netCents }];
  const paymentsAppliedCents = sum(tenderLines.map((line) => line.amountCents));

  return {
    header: {
      practiceName: input.practiceName,
      patientName: input.patientName,
      ...(input.patientRef ? { patientRef: input.patientRef } : {}),
      receiptDate: input.receiptDate,
      orderId: input.orderId,
      ...(input.providerName ? { providerName: input.providerName } : {}),
      ...(input.invoice.id ? { invoiceId: input.invoice.id } : {}),
    },
    lines,
    totals: { chargesSubtotalCents, discountTotalCents, taxTotalCents, chargesPlusTaxCents, netCents },
    payments: { tenderLines, paymentsAppliedCents },
    amountDueNowCents: netCents - paymentsAppliedCents,
  };
}

export function paymentReconciliationsToTenderLines(
  paymentReconciliations: PaymentReconciliation[],
  invoiceReference?: string,
): FinancialSummaryTenderLine[] {
  return paymentReconciliations.flatMap((pr) => {
    if (pr.status === "cancelled") {
      return [];
    }
    const coding = pr.extension?.find((ext) => ext.url === OSOD_PAYMENT_TENDER_EXTENSION_URL)
      ?.valueCodeableConcept?.coding?.[0];
    const tender = coding?.display ?? coding?.code;
    if (!tender) {
      throw new Error(
        "PaymentReconciliation is missing the osod-payment-tender extension — cannot derive the receipt tender label.",
      );
    }
    const amountCents = invoiceReference
      ? sum((pr.detail ?? [])
          .filter((detail) => detail.request?.reference === invoiceReference)
          .map((detail) => toCents(detail.amount?.value ?? NaN)))
      : toCents(pr.paymentAmount?.value ?? NaN);
    return amountCents > 0 ? [{ tender, amountCents }] : [];
  });
}

const DASH = "—";

function money(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  return `${sign}$${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
}

function text(value: string | undefined): string {
  return value === undefined || value === "" ? DASH : escapeHtml(value);
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

/**
 * Render the patient-facing Receipt / Financial Summary as a self-contained printable HTML sheet —
 * the money document of the cash-dispensary output pair (the lab sheet is the other half). Titled
 * unmistakably per the corpus §1.6 lesson; AMOUNT DUE NOW is the prominent line. Zero dependency;
 * browser print-to-PDF. Em-dash for absent optionals, never blank/undefined.
 */
export function renderReceiptSheet(summary: FinancialSummary): string {
  const h = summary.header;
  const rows = summary.lines
    .map(
      (line) =>
        `<tr><td>${text(line.description)}</td><td>${text(line.code)}</td><td>${line.quantity}</td><td>${money(line.feeCents)}</td><td>${line.discount ? `${money(line.discount.amountCents)} (${escapeHtml(line.discount.code)})` : DASH}</td><td>${money(line.taxCents)}</td><td>${money(line.patientBalanceCents)}</td></tr>`,
    )
    .join("\n    ");
  const tenderRows = summary.payments.tenderLines
    .map((line) => `<tr><td>${text(line.tender)}</td><td>${money(line.amountCents)}</td></tr>`)
    .join("\n    ");

  return `<section class="osod-receipt">
<style>
  .osod-receipt { font-family: system-ui, sans-serif; color: #111; max-width: 8.5in; }
  .osod-receipt h1 { font-size: 1.2rem; margin: 0 0 .25rem; }
  .osod-receipt h2 { font-size: .85rem; text-transform: uppercase; letter-spacing: .04em; color: #555; border-bottom: 1px solid #ccc; margin: 1rem 0 .4rem; padding-bottom: .15rem; }
  .osod-receipt table { border-collapse: collapse; width: 100%; font-size: .85rem; }
  .osod-receipt th, .osod-receipt td { border: 1px solid #ddd; padding: .25rem .4rem; text-align: left; }
  .osod-receipt .kv { display: grid; grid-template-columns: repeat(3, 1fr); gap: .25rem .75rem; font-size: .85rem; }
  .osod-receipt .kv b { color: #555; font-weight: 600; }
  .osod-receipt .totals td:first-child { font-weight: 600; color: #555; }
  .osod-receipt .due { font-size: 1.05rem; font-weight: 700; border: 2px solid #111; padding: .5rem .75rem; margin-top: .75rem; display: inline-block; }
  @media print { .osod-receipt { max-width: none; } }
</style>
<h1>Receipt / Financial Summary</h1>
<div class="kv">
  <div><b>Practice:</b> ${text(h.practiceName)}</div>
  <div><b>Date:</b> ${text(h.receiptDate)}</div>
  <div><b>Order #:</b> ${text(h.orderId)}</div>
  <div><b>Patient:</b> ${text(h.patientName)}</div>
  <div><b>Provider:</b> ${text(h.providerName)}</div>
  <div><b>Invoice:</b> ${text(h.invoiceId)}</div>
</div>
<h2>Charges</h2>
<table>
  <thead><tr><th>Description</th><th>Code</th><th>Qty</th><th>Fee</th><th>Discount</th><th>Tax</th><th>Patient Balance</th></tr></thead>
  <tbody>
    ${rows}
  </tbody>
</table>
<h2>Totals</h2>
<table class="totals">
  <tbody>
    <tr><td>Charges Subtotal</td><td>${money(summary.totals.chargesSubtotalCents)}</td></tr>
    <tr><td>Discounts</td><td>${money(summary.totals.discountTotalCents)}</td></tr>
    <tr><td>Tax</td><td>${money(summary.totals.taxTotalCents)}</td></tr>
    <tr><td>Charges + Tax Total</td><td>${money(summary.totals.chargesPlusTaxCents)}</td></tr>
    <tr><td>Net (after discounts)</td><td>${money(summary.totals.netCents)}</td></tr>
  </tbody>
</table>
<h2>Payments</h2>
<table>
  <thead><tr><th>Tender</th><th>Amount</th></tr></thead>
  <tbody>
    ${tenderRows}
  </tbody>
</table>
<div class="due">AMOUNT DUE NOW: ${money(summary.amountDueNowCents)}</div>
</section>`;
}

function componentCents(components: InvoiceLineItemPriceComponent[] | undefined, type: string): number {
  return sum((components ?? []).filter((pc) => pc.type === type).map((pc) => toCents(pc.amount?.value ?? 0)));
}

function invoiceTender(invoice: Invoice): string {
  const tender = invoice.extension?.find((ext) => ext.url === OSOD_PAYMENT_TENDER_EXTENSION_URL)
    ?.valueCodeableConcept?.coding?.[0]?.code;
  if (!tender) {
    throw new Error("Financial summary could not derive the payment tender from the Invoice (osod-payment-tender extension missing).");
  }
  return tender;
}

function toCents(dollars: number): number {
  return Math.round(dollars * 100);
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}
