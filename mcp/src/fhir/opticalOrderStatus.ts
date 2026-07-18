import type { CodeableConcept } from "@medplum/fhirtypes";

/**
 * Local ODOS vocabulary for the spectacle optical-order lifecycle.
 *
 * Source: Foxfire reverse-engineering corpus, `orders-optical-cl.md:171` — the 17 spectacle
 * order-status values, verbatim. This is an ODOS-internal CodeSystem (NOT an external medical
 * code system), bound to `Task.businessStatus` on the optical order; `Task.status` stays on the
 * FHIR R4 required workflow vocabulary. See the Slice-3 spec §4/§7.
 */
export const ODOS_OPTICAL_ORDER_STATUS_SYSTEM = "https://odos2020.com/fhir/CodeSystem/optical-order-status";

export const OPTICAL_ORDER_STATUSES = [
  { code: "quote", display: "Quote" },
  { code: "waiting-for-pre-auth", display: "Waiting for Pre Auth" },
  { code: "at-lab", display: "At Lab" },
  { code: "lenses-on-order", display: "Lenses On Order" },
  { code: "frame-on-order", display: "Frame On Order" },
  { code: "waiting-on-patients-frame", display: "Waiting on Patients Frame" },
  { code: "notified", display: "Notified" },
  { code: "notified-left-message", display: "Notified - Left Message" },
  { code: "dispensed", display: "Dispensed" },
  { code: "complete-unable-to-notify", display: "Complete - Unable to Notify" },
  { code: "waiting-on-payment", display: "Waiting On Payment" },
  { code: "cancelled", display: "Cancelled" },
  { code: "quick-order", display: "Quick Order" },
  { code: "frame-only", display: "Frame Only" },
  { code: "gift-card-order", display: "Gift Card Order" },
  { code: "doctor-change", display: "Doctor Change" },
  { code: "vsp-ordered", display: "VSP Ordered" },
] as const;

export type OpticalOrderStatusCode = (typeof OPTICAL_ORDER_STATUSES)[number]["code"];

const STATUS_BY_CODE = new Map<string, (typeof OPTICAL_ORDER_STATUSES)[number]>(
  OPTICAL_ORDER_STATUSES.map((status) => [status.code, status]),
);

export function assertOpticalOrderStatus(code: string): asserts code is OpticalOrderStatusCode {
  if (!STATUS_BY_CODE.has(code)) {
    throw new Error(
      `Unknown optical order status "${code}" — must be one of the 17 defined optical order status values.`,
    );
  }
}

export function opticalOrderStatusConcept(code: string): CodeableConcept {
  assertOpticalOrderStatus(code);
  const status = STATUS_BY_CODE.get(code)!;
  return {
    coding: [
      {
        system: ODOS_OPTICAL_ORDER_STATUS_SYSTEM,
        code: status.code,
        display: status.display,
      },
    ],
    text: status.display,
  };
}
