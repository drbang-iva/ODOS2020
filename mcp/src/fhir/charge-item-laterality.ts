import type { ChargeItem, CodeableConcept } from "@medplum/fhirtypes";

export type ChargeLaterality = "OD" | "OS" | "OU";
export const ODOS_CHARGE_LATERALITY_SYSTEM =
  "https://odos2020.com/fhir/CodeSystem/laterality";

export interface ChargeItemLateralityResult {
  laterality?: ChargeLaterality;
  conflict: boolean;
}

export function chargeItemBodysite(laterality: ChargeLaterality): CodeableConcept[] {
  return [{
    coding: [{ system: ODOS_CHARGE_LATERALITY_SYSTEM, code: laterality }],
    text: laterality,
  }];
}

export function chargeItemLaterality(
  chargeItem: Pick<ChargeItem, "bodysite">,
): ChargeItemLateralityResult {
  const values = new Set<ChargeLaterality>();
  for (const site of chargeItem.bodysite ?? []) {
    for (const coding of site.coding ?? []) {
      if (coding.system === ODOS_CHARGE_LATERALITY_SYSTEM && isChargeLaterality(coding.code)) {
        values.add(coding.code);
      }
    }
    const text = site.text?.trim().toUpperCase();
    if (isChargeLaterality(text)) values.add(text);
  }
  return values.size === 1
    ? { laterality: [...values][0], conflict: false }
    : { conflict: values.size > 1 };
}

function isChargeLaterality(value: string | undefined): value is ChargeLaterality {
  return value === "OD" || value === "OS" || value === "OU";
}
