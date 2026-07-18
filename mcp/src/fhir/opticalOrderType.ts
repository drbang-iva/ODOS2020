import type { CodeableConcept } from "@medplum/fhirtypes";

export const ODOS_OPTICAL_ORDER_TYPE_SYSTEM = "https://odos2020.com/fhir/CodeSystem/optical-order-type";

export const OPTICAL_ORDER_TYPES = [
  { code: "rx", display: "Rx" },
  { code: "frame-only", display: "Frame Only" },
  { code: "lenses-only", display: "Lenses Only" },
  { code: "quote", display: "Quote" },
  { code: "gift-card", display: "Gift Card" },
] as const;

export type OpticalOrderTypeCode = (typeof OPTICAL_ORDER_TYPES)[number]["code"];

const TYPE_BY_CODE = new Map<string, (typeof OPTICAL_ORDER_TYPES)[number]>(
  OPTICAL_ORDER_TYPES.map((type) => [type.code, type]),
);

export function assertOpticalOrderType(code: string): asserts code is OpticalOrderTypeCode {
  if (!TYPE_BY_CODE.has(code)) {
    throw new Error(
      `Unknown optical order type "${code}" — must be one of the 5 defined optical order type values.`,
    );
  }
}

export function opticalOrderTypeConcept(code: string): CodeableConcept {
  assertOpticalOrderType(code);
  const type = TYPE_BY_CODE.get(code)!;
  return {
    coding: [
      {
        system: ODOS_OPTICAL_ORDER_TYPE_SYSTEM,
        code: type.code,
        display: type.display,
      },
    ],
    text: type.display,
  };
}
