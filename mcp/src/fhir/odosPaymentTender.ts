import type { Extension } from "@medplum/fhirtypes";

/**
 * Local ODOS vocabulary + extension for record-only payment tenders.
 *
 * R4 has no coded field for how a payment was tendered, so the Slice-3 spec §7
 * trap #5 calls for a local `odos-payment-tender` extension carried on the Invoice. Source: Foxfire
 * reverse-engineering corpus `orders-optical-cl.md:85` — the Transactions-screen payment Codes,
 * verbatim (CASH · CHECK). CARD_MANUAL is ODOS's record-only keyed-card tender; it carries no
 * processor interaction or card data.
 */
export const ODOS_PAYMENT_TENDER_EXTENSION_URL =
  "https://odos2020.com/fhir/StructureDefinition/odos-payment-tender";

export const ODOS_PAYMENT_TENDER_SYSTEM = "https://odos2020.com/fhir/CodeSystem/payment-tender";

export const PAYMENT_TENDERS = [
  { code: "CASH", display: "Cash" },
  { code: "CHECK", display: "Check" },
  { code: "CARD_MANUAL", display: "Card — manual entry" },
] as const;

/**
 * Non-cash tenders recorded on a PaymentReconciliation (never on the cash Invoice path). Codes are
 * Foxfire transaction-code verbatim (corpus harvest 2026-07-03) plus the ODOS-generic CARD; the
 * vocabulary is practice-extensible, so unknown codes are accepted verbatim by the lenient builder.
 * Seam spec 2026-07-05 §7 delta 1.
 */
export const PROCESSOR_PAYMENT_TENDERS = [
  { code: "CARD", display: "Card" },
  { code: "CCP", display: "Credit Card Payment" },
  { code: "CLOVER", display: "Clover Processing" },
  { code: "CARE", display: "Care Credit" },
  { code: "SP_CARD", display: "Credit Card" },
  { code: "SP_ACH", display: "ACH Check" },
  { code: "SP_ACF", display: "Alternative Financing" },
] as const;

export type PaymentTenderCode = (typeof PAYMENT_TENDERS)[number]["code"];

const TENDER_BY_CODE = new Map<string, (typeof PAYMENT_TENDERS)[number]>(
  PAYMENT_TENDERS.map((tender) => [tender.code, tender]),
);

const KNOWN_DISPLAY_BY_CODE = new Map<string, string>(
  [...PAYMENT_TENDERS, ...PROCESSOR_PAYMENT_TENDERS].map((tender) => [tender.code, tender.display]),
);

export function assertPaymentTender(code: string): asserts code is PaymentTenderCode {
  if (!TENDER_BY_CODE.has(code)) {
    throw new Error(
      `Unknown payment tender "${code}" — accepted record-only tenders are CASH, CHECK, and CARD_MANUAL.`,
    );
  }
}

/** Build the odos-payment-tender extension carrying a record-only tender as a coded value. */
export function paymentTenderExtension(code: string): Extension {
  assertPaymentTender(code);
  const tender = TENDER_BY_CODE.get(code)!;
  return {
    url: ODOS_PAYMENT_TENDER_EXTENSION_URL,
    valueCodeableConcept: {
      coding: [
        {
          system: ODOS_PAYMENT_TENDER_SYSTEM,
          code: tender.code,
          display: tender.display,
        },
      ],
      text: tender.display,
    },
  };
}

/**
 * Build the odos-payment-tender extension for a PaymentReconciliation (the settling payment).
 *
 * Lenient by design: known manual + processor codes get their corpus-verbatim display, the adapter
 * may override the display with an instrument label (e.g. "VISA ****4242" — brand + last-4 are not
 * PCI-scoped), and unknown practice-custom codes are carried verbatim. The strict record-only
 * assertion above keeps guarding the cash Invoice path; it must not gate this one (seam spec §7).
 */
export function paymentTenderExtensionForReconciliation(tender: {
  code: string;
  display?: string;
}): Extension {
  if (!tender.code) {
    throw new Error("Payment reconciliation tender code must be a nonempty string.");
  }
  const display = tender.display ?? KNOWN_DISPLAY_BY_CODE.get(tender.code);
  return {
    url: ODOS_PAYMENT_TENDER_EXTENSION_URL,
    valueCodeableConcept: {
      coding: [
        {
          system: ODOS_PAYMENT_TENDER_SYSTEM,
          code: tender.code,
          ...(display ? { display } : {}),
        },
      ],
      ...(display ? { text: display } : {}),
    },
  };
}
