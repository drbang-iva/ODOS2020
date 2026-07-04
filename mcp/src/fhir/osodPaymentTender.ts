import type { Extension } from "@medplum/fhirtypes";

/**
 * Local ODOS vocabulary + extension for the payment tender on a cash optical order.
 *
 * R4 has no coded field for how a payment was tendered (CASH vs CHECK), so the Slice-3 spec §7
 * trap #5 calls for a local `osod-payment-tender` extension carried on the Invoice. Source: Foxfire
 * reverse-engineering corpus `orders-optical-cl.md:85` — the Transactions-screen payment Codes,
 * verbatim (CASH · CHECK). Card/processor tenders are deferred (no live processor in the cash tier).
 */
export const OSOD_PAYMENT_TENDER_EXTENSION_URL =
  "https://osod.dev/fhir/StructureDefinition/osod-payment-tender";

export const OSOD_PAYMENT_TENDER_SYSTEM = "https://osod.dev/fhir/CodeSystem/payment-tender";

export const PAYMENT_TENDERS = [
  { code: "CASH", display: "Cash" },
  { code: "CHECK", display: "Check" },
] as const;

export type PaymentTenderCode = (typeof PAYMENT_TENDERS)[number]["code"];

const TENDER_BY_CODE = new Map<string, (typeof PAYMENT_TENDERS)[number]>(
  PAYMENT_TENDERS.map((tender) => [tender.code, tender]),
);

export function assertPaymentTender(code: string): asserts code is PaymentTenderCode {
  if (!TENDER_BY_CODE.has(code)) {
    throw new Error(
      `Unknown payment tender "${code}" — the cash tier accepts only CASH or CHECK (no card/processor tenders).`,
    );
  }
}

/** Build the osod-payment-tender extension carrying the CASH/CHECK tender as a coded value. */
export function paymentTenderExtension(code: string): Extension {
  assertPaymentTender(code);
  const tender = TENDER_BY_CODE.get(code)!;
  return {
    url: OSOD_PAYMENT_TENDER_EXTENSION_URL,
    valueCodeableConcept: {
      coding: [
        {
          system: OSOD_PAYMENT_TENDER_SYSTEM,
          code: tender.code,
          display: tender.display,
        },
      ],
      text: tender.display,
    },
  };
}
