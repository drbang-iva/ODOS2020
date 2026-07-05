import { randomUUID } from "node:crypto";
import type { Bundle, BundleEntry, Resource } from "@medplum/fhirtypes";
import { buildSpectacleOrderDeviceRequest, buildOpticalOrderTask } from "./opticalOrder.js";
import { buildOpticalChargeItem } from "./opticalCharge.js";
import { buildOpticalInvoice } from "./opticalInvoice.js";

export interface OpticalCashOrderChargeInput {
  /** HCPCS/CPT billing code for this charge line. */
  code: string;
  codeSystem?: string;
  codeDisplay?: string;
  /** Billed fee in whole cents (ChargeItem.priceOverride and the Invoice line base). */
  feeCents: number;
  quantity?: number;
  /** Engine price rule (ChargeItemDefinition canonical) retained for the audit diff. */
  definitionCanonical?: string;
  overrideReason?: string;
  /** Self-pay adjustment applied at payment (Invoice discount priceComponent), e.g. PPAY/FAMILY. */
  discount?: { code: string; amountCents: number };
}

export interface AssembleOpticalCashOrderInput {
  patientReference: string;
  /** The signed spectacle Rx (VisionPrescription) the order fulfills — DeviceRequest.basedOn. */
  visionPrescriptionReference: string;
  /** The visit the order/charges belong to (ChargeItem.context). */
  encounterReference?: string;
  /** Product code for the order itself (DeviceRequest.code), e.g. V2020. */
  orderHcpcsCode: string;
  orderHcpcsDisplay?: string;
  /** The charge lines (frame + lenses + services). At least one is required. */
  charges: OpticalCashOrderChargeInput[];
  /**
   * CASH or CHECK for a manual cash order. Omit for a processor order: the Invoice is issued
   * untendered and the tender rides on the settling PaymentReconciliation (seam spec §6).
   */
  tender?: string;
  /** Initial optical order lifecycle status (Task.businessStatus); defaults to "quote". */
  businessStatus?: string;
  /** Optical order type carried on Task.code; defaults to "rx". Immutable after create. */
  orderType?: string;
}

/**
 * Assemble a complete cash spectacle order as a FHIR R4 transaction Bundle, ready to POST atomically.
 *
 * Wires the Slice-3 composite (spec §7): a DeviceRequest (the glasses order, basedOn→VisionPrescription),
 * a sibling Task owning the 17-value lifecycle (focus→DeviceRequest), one ChargeItem per line
 * (supportingInformation→DeviceRequest, context→Encounter), and an Invoice recording the cash/check
 * payment (lineItem.chargeItemReference→each ChargeItem). Intra-bundle references use urn:uuid fullUrls
 * so the whole graph resolves in a single transaction. Delegates every resource to its verified builder.
 */
export function assembleOpticalCashOrder(input: AssembleOpticalCashOrderInput): Bundle {
  if (!input.charges || input.charges.length === 0) {
    throw new Error("A cash optical order requires at least one charge line.");
  }

  const deviceRequestUrn = `urn:uuid:${randomUUID()}`;
  const taskUrn = `urn:uuid:${randomUUID()}`;
  const chargeUrns = input.charges.map(() => `urn:uuid:${randomUUID()}`);
  const invoiceUrn = `urn:uuid:${randomUUID()}`;

  const deviceRequest = buildSpectacleOrderDeviceRequest({
    patientReference: input.patientReference,
    visionPrescriptionReference: input.visionPrescriptionReference,
    hcpcsCode: input.orderHcpcsCode,
    hcpcsDisplay: input.orderHcpcsDisplay,
  });

  const task = buildOpticalOrderTask({
    patientReference: input.patientReference,
    deviceRequestReference: deviceRequestUrn,
    businessStatus: input.businessStatus,
    orderType: input.orderType,
  });

  const chargeItems = input.charges.map((charge) =>
    buildOpticalChargeItem({
      patientReference: input.patientReference,
      deviceRequestReference: deviceRequestUrn,
      encounterReference: input.encounterReference,
      code: charge.code,
      codeSystem: charge.codeSystem,
      codeDisplay: charge.codeDisplay,
      feeCents: charge.feeCents,
      quantity: charge.quantity,
      definitionCanonical: charge.definitionCanonical,
      overrideReason: charge.overrideReason,
    }),
  );

  const invoice = buildOpticalInvoice({
    patientReference: input.patientReference,
    tender: input.tender,
    lineItems: input.charges.map((charge, index) => ({
      chargeItemReference: chargeUrns[index],
      amountCents: charge.feeCents,
      discount: charge.discount,
    })),
  });

  const entries: BundleEntry[] = [
    entry(deviceRequestUrn, deviceRequest),
    entry(taskUrn, task),
    ...chargeItems.map((chargeItem, index) => entry(chargeUrns[index], chargeItem)),
    entry(invoiceUrn, invoice),
  ];

  return { resourceType: "Bundle", type: "transaction", entry: entries };
}

function entry(fullUrl: string, resource: Resource): BundleEntry {
  return {
    fullUrl,
    resource,
    request: { method: "POST", url: resource.resourceType },
  };
}
