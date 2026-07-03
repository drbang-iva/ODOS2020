import type { ChargeItem } from "@medplum/fhirtypes";
import { HCPCS_SYSTEM } from "../catalog/frame-types.js";

export interface OpticalChargeItemInput {
  patientReference: string;
  /**
   * The glasses order (DeviceRequest) this charge line belongs to. Linked via
   * ChargeItem.supportingInformation — NOT ChargeItem.service, which in R4 cannot target
   * a DeviceRequest (Slice-3 spec §7 trap #1).
   */
  deviceRequestReference: string;
  /** HCPCS/CPT billing code for this line (ODOS never hardcodes billing codes). */
  code: string;
  /** Defaults to the HCPCS CodeSystem. */
  codeSystem?: string;
  codeDisplay?: string;
  /** Line fee in whole cents; emitted as ChargeItem.priceOverride Money (USD). */
  feeCents: number;
  /** The encounter this charge belongs to (ChargeItem.context, NOT R5 `.encounter`). */
  encounterReference?: string;
  /** Line quantity (defaults to 1). */
  quantity?: number;
  /** ChargeItem.status R4 required VS (defaults to "billable"). */
  status?: ChargeItem["status"];
  /**
   * Canonical URL of the ChargeItemDefinition that computed the engine-suggested price. Retaining
   * it alongside `priceOverride` gives the audit-gold diff of "what the engine suggested vs what was
   * billed" (Eyefinity best-of-both, spec §5).
   */
  definitionCanonical?: string;
  /** Free-text reason a doctor/staff overrode the engine price (ChargeItem.overrideReason). */
  overrideReason?: string;
}

/**
 * Build an R4 ChargeItem for one line of a cash optical order.
 *
 * The order link goes in `supportingInformation` (R4 trap #1: `.service` cannot target a
 * DeviceRequest); the fee goes in `priceOverride` (R4 trap #3: ChargeItem has no unit-price/
 * line-total pair); the encounter goes in `context` (R4 trap #4: NOT the R5 `.encounter` name).
 * Cash-only weekend build → every line is self-pay; the payer columns are deferred (spec §5).
 * See Slice-3 spec §5/§7 (dual-source verified R4).
 */
export function buildOpticalChargeItem(input: OpticalChargeItemInput): ChargeItem {
  if (!input.patientReference) {
    throw new Error("Optical charge line requires a patient (subject) reference.");
  }
  if (!input.deviceRequestReference) {
    throw new Error("Optical charge line requires the DeviceRequest (glasses order) reference.");
  }
  if (!input.code) {
    throw new Error("Optical charge line requires an HCPCS/CPT procedure code.");
  }
  if (!Number.isInteger(input.feeCents) || input.feeCents < 0) {
    throw new Error("Optical charge line fee (feeCents) must be a nonnegative integer number of cents.");
  }

  return {
    resourceType: "ChargeItem",
    status: input.status ?? "billable",
    code: {
      coding: [
        {
          system: input.codeSystem ?? HCPCS_SYSTEM,
          code: input.code,
          ...(input.codeDisplay ? { display: input.codeDisplay } : {}),
        },
      ],
    },
    subject: { reference: input.patientReference },
    ...(input.encounterReference ? { context: { reference: input.encounterReference } } : {}),
    quantity: { value: input.quantity ?? 1 },
    priceOverride: { value: input.feeCents / 100, currency: "USD" },
    ...(input.definitionCanonical ? { definitionCanonical: [input.definitionCanonical] } : {}),
    ...(input.overrideReason ? { overrideReason: input.overrideReason } : {}),
    supportingInformation: [{ reference: input.deviceRequestReference }],
  };
}
