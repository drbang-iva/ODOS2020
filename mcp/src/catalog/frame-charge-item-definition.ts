import type { ChargeItemDefinition } from "@medplum/fhirtypes";
import {
  HCPCS_SYSTEM,
  OSOD_OPTOMETRY_SERVICE_LINE_CODE,
  SNOMED_SYSTEM,
  type ClaimLineItem,
  type FrameHcpcsCode,
} from "./frame-types.js";

export interface FrameChargeItemDefinitionInput {
  readonly practiceId: string;
  readonly catalogCanonicalUrl: string;
  readonly practiceSalePriceCents: number;
  readonly hcpcsBaseCode: Extract<FrameHcpcsCode, "V2020">;
}

export function buildFrameChargeItemDefinition(
  input: FrameChargeItemDefinitionInput,
): ChargeItemDefinition {
  return {
    resourceType: "ChargeItemDefinition",
    url: `https://osod.dev/practice/${encodeURIComponent(input.practiceId)}/charge-rules/frames/${encodeURIComponent(input.catalogCanonicalUrl)}`,
    version: "1",
    status: "active",
    code: {
      coding: [
        {
          system: HCPCS_SYSTEM,
          code: input.hcpcsBaseCode,
          display: "Frames, purchases",
        },
        {
          system: SNOMED_SYSTEM,
          code: OSOD_OPTOMETRY_SERVICE_LINE_CODE,
          display: "Optometry service",
        },
      ],
    },
    derivedFromUri: [input.catalogCanonicalUrl],
    propertyGroup: [
      {
        priceComponent: [
          {
            type: "base",
            code: {
              coding: [
                { system: "http://terminology.hl7.org/CodeSystem/v3-ActCode", code: "CHRG" },
              ],
            },
            amount: { value: input.practiceSalePriceCents / 100, currency: "USD" },
          },
        ],
      },
    ],
  };
}

export function emitFrameClaimLines(args: {
  readonly practiceId: string;
  readonly catalogCanonicalUrl: string;
  readonly isDeluxe: boolean;
  readonly standardFrameCostCents: number;
  readonly deluxeChargeCents?: number;
}): ClaimLineItem[] {
  if (args.standardFrameCostCents < 0) {
    throw new Error("emitFrameClaimLines: standardFrameCostCents must be nonnegative");
  }
  if (!args.isDeluxe) {
    return [claimLine("V2020", args.standardFrameCostCents)];
  }
  if (typeof args.deluxeChargeCents !== "number") {
    throw new Error("emitFrameClaimLines: deluxeChargeCents required when isDeluxe=true");
  }
  if (args.deluxeChargeCents < args.standardFrameCostCents) {
    throw new Error("emitFrameClaimLines: deluxeChargeCents must be at least standardFrameCostCents");
  }
  return [
    claimLine("V2020", args.standardFrameCostCents),
    claimLine("V2025", args.deluxeChargeCents - args.standardFrameCostCents),
  ];
}

/**
 * AV modifier roster is [provisional — single-source as of 2026-05-09] until
 * a second independent primary source corroborates the Noridian DME MAC list.
 */
export function validateFrameClaimModifiers(args: {
  readonly hcpcsCode: string;
  readonly modifiers: readonly string[];
}): void {
  const frameCodes = new Set(["V2020", "V2025", "V2600"]);
  if (!frameCodes.has(args.hcpcsCode)) {
    return;
  }

  for (const modifier of args.modifiers) {
    if (modifier === "RT" || modifier === "LT") {
      throw new Error(
        `validateFrameClaimModifiers: ${modifier} modifier prohibited on ${args.hcpcsCode} per CMS LCD L33793 / Article A52499`,
      );
    }
    if (modifier === "AV") {
      throw new Error(
        `validateFrameClaimModifiers: AV modifier restricted per Noridian DME MAC to A4217 / A4450 / A4452 / A5120 / A6531 / A6532 / A6545 [provisional — single-source as of 2026-05-09]; cannot apply to ${args.hcpcsCode}`,
      );
    }
  }
}

export function validateLensClaimMutualExclusion(args: {
  readonly lineItems: readonly ClaimLineItem[];
}): void {
  const codes = new Set(
    args.lineItems.flatMap((line) => line.productOrService.coding.map((coding) => coding.code)),
  );
  if (codes.has("V2755") && codes.has("V2784")) {
    throw new Error(
      "validateLensClaimMutualExclusion: V2755 and V2784 cannot appear on the same lens claim; CMS LCD L33793 / Article A52499 denies the combination as not reasonable and necessary, not as an NCCI PTP edit",
    );
  }
}

function claimLine(code: "V2020" | "V2025", amountCents: number): ClaimLineItem {
  return {
    productOrService: { coding: [{ system: HCPCS_SYSTEM, code }] },
    unitPrice: { value: amountCents / 100, currency: "USD" },
    quantity: { value: 1 },
  };
}
