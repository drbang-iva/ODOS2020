import type { Invoice, InvoiceLineItemPriceComponent } from "@medplum/fhirtypes";
import { paymentTenderExtension } from "./osodPaymentTender.js";
import { OSOD_OPTICAL_ADJUSTMENT_SYSTEM, opticalAdjustmentDisplay } from "./osodOpticalAdjustment.js";

// Self-pay discount vocabulary now lives in ./osodOpticalAdjustment (harvested from live Foxfire
// 2026-07-03). Re-exported for consumers that discovered it here first. Unknown (practice-custom)
// codes are still accepted and carried verbatim; known codes get a corpus-verbatim display.
export { OSOD_OPTICAL_ADJUSTMENT_SYSTEM } from "./osodOpticalAdjustment.js";

export interface OpticalInvoiceLineInput {
  /** The ChargeItem this payment line settles (Invoice.lineItem.chargeItemReference). */
  chargeItemReference: string;
  /** Base line amount in whole cents (the ChargeItem's billed price). */
  amountCents: number;
  /** Sales tax for this line in whole cents. */
  taxCents?: number;
  /** Optional self-pay adjustment (e.g. PPAY, FAMILY) → a discount priceComponent on this line. */
  discount?: { code: string; amountCents: number };
}

export interface OpticalInvoiceInput {
  patientReference: string;
  /**
   * CASH, CHECK, or record-only CARD_MANUAL — carried in the osod-payment-tender extension.
   * Optional: the Invoice is the bill and exists before it is paid. A processor order issues the
   * Invoice untendered — the tender lives on the settling PaymentReconciliation instead (seam spec
   * 2026-07-05 §6; the receipt then requires explicit payment lines, never a tender fallback).
   */
  tender?: string;
  lineItems: OpticalInvoiceLineInput[];
  /** Invoice.status R4 required VS (defaults to "issued"). */
  status?: Invoice["status"];
}

/**
 * Build the R4 Invoice that records a record-only payment for a spectacle optical order.
 *
 * Each lineItem references a ChargeItem (chargeItemReference); the record-only tender rides in the
 * osod-payment-tender extension (Slice-3 spec §7 trap #5); totals are Money in USD. Invoice — NOT
 * PaymentReconciliation, which is payer/insurer-scoped (trap #2). Weekend build is an internal
 * ledger record: no live processor. See Slice-3 spec §5/§7 (dual-source verified R4).
 */
export function buildOpticalInvoice(input: OpticalInvoiceInput): Invoice {
  if (!input.patientReference) {
    throw new Error("Optical invoice requires a patient (subject) reference.");
  }
  if (!input.lineItems || input.lineItems.length === 0) {
    throw new Error("Optical invoice requires at least one line item.");
  }

  let grossCents = 0;
  let netCents = 0;

  const lineItem = input.lineItems.map((li, index) => {
    const priceComponent: InvoiceLineItemPriceComponent[] = [
      { type: "base", amount: { value: li.amountCents / 100, currency: "USD" } },
    ];
    grossCents += li.amountCents;
    netCents += li.amountCents;

    if (li.taxCents !== undefined) {
      if (!Number.isInteger(li.taxCents) || li.taxCents < 0) {
        throw new Error("Optical invoice tax amount (taxCents) must be a nonnegative integer.");
      }
      grossCents += li.taxCents;
      netCents += li.taxCents;
      if (li.taxCents > 0) {
        priceComponent.push({
          type: "tax",
          amount: { value: li.taxCents / 100, currency: "USD" },
        });
      }
    }

    if (li.discount) {
      if (!Number.isInteger(li.discount.amountCents) || li.discount.amountCents < 0) {
        throw new Error("Optical invoice discount amount (amountCents) must be a nonnegative integer.");
      }
      netCents -= li.discount.amountCents;
      priceComponent.push({
        type: "discount",
        code: {
          coding: [
            {
              system: OSOD_OPTICAL_ADJUSTMENT_SYSTEM,
              code: li.discount.code,
              ...(opticalAdjustmentDisplay(li.discount.code)
                ? { display: opticalAdjustmentDisplay(li.discount.code) }
                : {}),
            },
          ],
        },
        amount: { value: li.discount.amountCents / 100, currency: "USD" },
      });
    }

    return {
      sequence: index + 1,
      chargeItemReference: { reference: li.chargeItemReference },
      priceComponent,
    };
  });

  return {
    resourceType: "Invoice",
    status: input.status ?? "issued",
    subject: { reference: input.patientReference },
    ...(input.tender !== undefined ? { extension: [paymentTenderExtension(input.tender)] } : {}),
    lineItem,
    totalGross: { value: grossCents / 100, currency: "USD" },
    totalNet: { value: netCents / 100, currency: "USD" },
  };
}
