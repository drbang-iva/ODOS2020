import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  ChargeItem,
  ChargeItemDefinition,
  Claim,
  ClaimResponse,
  Invoice,
  PaymentReconciliation,
  Task,
} from "@medplum/fhirtypes";
import { ODOS_CLAIM_CHARGE_ITEM_EXTENSION_URL } from "../src/claims/claimmd-fhir.js";
import {
  ERA_WORKLIST_CODE_SYSTEM,
  ERA_WORKLIST_STATUS_SYSTEM,
} from "../src/claims/era-worklist.js";
import { ODOS_WHOLESALE_COST_EXTENSION_URL } from "../src/catalog/frame-charge-item-definition.js";
import {
  MARGIN_LEDGER_GENESIS_DATE,
  projectMarginLedger,
} from "../src/reporting/margin-ledger.js";
import type { PlanProfile } from "../src/reporting/plan-profiles.js";

const PLAN_REFERENCE = "Organization/vsp";

test("MarginLine projection keeps all three states honest and computes the four period numerals in cents", () => {
  const result = projectMarginLedger({
    period: "2026-07",
    invoices: [
      invoice("invoice-settled", "charge-settled", "2026-07-15T14:32:00Z", 6_500, 455),
      invoice("invoice-estimated", "charge-estimated", "2026-07-16T10:00:00Z", 14_000, 980),
      invoice("invoice-flagged", "charge-flagged", "2026-07-17T09:00:00Z", 8_500, 595),
    ],
    chargeItems: [
      charge("charge-settled", "frame-settled", 18_500, 1),
      charge("charge-estimated", "contact-estimated", 21_000, 2),
      charge("charge-flagged", "frame-flagged", 22_500, 1),
    ],
    definitions: [
      definition("frame-settled", 6_200, "frame", "Meridian 88"),
      definition("contact-estimated", 9_600, "contact", "Oasys 1-Day"),
      definition("frame-flagged", 7_100, "frame", "Ateliers 5"),
    ],
    claims: [
      claim("claim-settled", "charge-settled"),
      claim("claim-estimated", "charge-estimated"),
      claim("claim-flagged", "charge-flagged", "Organization/vsp-high"),
    ],
    responses: [
      response("response-settled", "claim-settled", "charge-settled", 6_600, 1_200),
      response("response-flagged", "claim-flagged", "charge-flagged", 10_000, 1_000),
    ],
    reconciliations: [
      reconciliation("payment-settled", "charge-settled", "response-settled", 6_600),
      reconciliation("payment-flagged", "charge-flagged", "response-flagged", 10_000),
    ],
    tasks: [linkageTask("task-flagged", "response-flagged")],
    profiles: [profile(PLAN_REFERENCE, 7_000), profile("Organization/vsp-high", 8_400)],
  });

  assert.equal(result.genesisDate, MARGIN_LEDGER_GENESIS_DATE);
  assert.equal(result.realizedMarginCents, 5_700);
  assert.equal(result.inFlightCents, 22_000);
  assert.equal(result.driftCents, -2_400);
  assert.equal(result.realizedMultiplierMilli, 1_919);
  assert.equal(result.settledLineCount, 1);
  assert.equal(result.inFlightLineCount, 2);

  const settled = result.lines.find((line) => line.id === "charge-settled")!;
  assert.equal(settled.state, "Settled");
  assert.equal(settled.patientPaidCents, 6_500);
  assert.equal(settled.taxCents, 455);
  assert.equal(settled.planPaidCents, 5_400);
  assert.equal(settled.marginCents, 5_700);
  assert.equal(settled.estimatedMarginCents, 8_100);
  assert.equal(settled.driftCents, -2_400);
  assert.deepEqual(settled.deductions, [{ label: "ERA adjustment (CO-45)", amountCents: 1_200 }]);

  const estimated = result.lines.find((line) => line.id === "charge-estimated")!;
  assert.equal(estimated.state, "Estimated");
  assert.equal(estimated.patientPaidCents, 14_000);
  assert.equal(estimated.taxCents, 980);
  assert.equal(estimated.estimatedPlanPaidCents, 7_000);
  assert.equal(estimated.estimatedMarginCents, 11_400);
  assert.equal(estimated.marginCents, undefined);

  const flagged = result.lines.find((line) => line.id === "charge-flagged")!;
  assert.equal(flagged.state, "Flagged");
  assert.equal(flagged.estimatedPlanPaidCents, 9_200);
  assert.equal(flagged.estimatedMarginCents, 10_600);
  assert.equal(flagged.planPaidCents, undefined);
  assert.equal(flagged.marginCents, undefined);
  assert.equal(flagged.multiplierMilli, undefined);
  assert.equal(flagged.linkageTaskReference, "Task/task-flagged");
});

test("pre-d0 receipts are deliberately absent from margin truth", () => {
  const result = projectMarginLedger({
    period: "2026-07",
    invoices: [invoice("invoice-old", "charge-old", "2026-07-14T23:59:59Z", 6_500, 0)],
    chargeItems: [charge("charge-old", "frame-old", 18_500, 1)],
    definitions: [definition("frame-old", 6_200, "frame", "Old frame")],
    claims: [],
    responses: [],
    reconciliations: [],
    tasks: [],
    profiles: [],
  });
  assert.deepEqual(result.lines, []);
  assert.equal(result.realizedMarginCents, 0);
});

test("an issued but uncollected patient-responsibility Invoice does not become patient-paid margin", () => {
  const uncollected = invoice("invoice-uncollected", "charge-uncollected", "2026-07-16T12:00:00Z", 6_500, 455);
  uncollected.extension = undefined;
  const result = projectMarginLedger({
    period: "2026-07",
    invoices: [uncollected],
    chargeItems: [charge("charge-uncollected", "frame-uncollected", 18_500, 1)],
    definitions: [definition("frame-uncollected", 6_200, "frame", "Uncollected frame")],
    claims: [],
    responses: [],
    reconciliations: [],
    tasks: [],
    profiles: [],
  });
  assert.deepEqual(result.lines, []);
});

function invoice(
  id: string,
  chargeId: string,
  date: string,
  patientPaidCents: number,
  taxCents: number,
): Invoice {
  return {
    resourceType: "Invoice",
    id,
    status: "issued",
    date,
    extension: [{
      url: "https://odos2020.com/fhir/StructureDefinition/odos-payment-tender",
      valueCodeableConcept: { coding: [{ code: "CASH" }] },
    }],
    lineItem: [{
      sequence: 1,
      chargeItemReference: { reference: `ChargeItem/${chargeId}` },
      priceComponent: [
        { type: "base", amount: usd(patientPaidCents) },
        ...(taxCents ? [{ type: "tax" as const, amount: usd(taxCents) }] : []),
      ],
    }],
  };
}

function charge(id: string, definitionId: string, retailCents: number, quantity: number): ChargeItem {
  return {
    resourceType: "ChargeItem",
    id,
    status: "billable",
    code: { coding: [{ code: definitionId.startsWith("contact") ? "V2520" : "V2020", display: definitionId }] },
    subject: { reference: "Patient/patient-1" },
    quantity: { value: quantity },
    priceOverride: usd(retailCents),
    definitionCanonical: [`https://odos2020.com/pricing/${definitionId}`],
  };
}

function definition(
  id: string,
  wholesaleCents: number,
  productClass: "frame" | "contact",
  display: string,
): ChargeItemDefinition {
  return {
    resourceType: "ChargeItemDefinition",
    id,
    url: `https://odos2020.com/pricing/${id}`,
    status: "active",
    extension: [
      { url: ODOS_WHOLESALE_COST_EXTENSION_URL, valueMoney: usd(wholesaleCents) },
      ...(productClass === "contact" ? [{
        url: "https://odos2020.com/fhir/StructureDefinition/odos-contact-lens-product-identity",
        extension: [
          { url: "manufacturer-display", valueString: "Johnson & Johnson" },
          { url: "product-display", valueString: display },
        ],
      }] : []),
    ],
    ...(productClass === "frame" ? { derivedFromUri: [`https://odos2020.com/catalog/frames/${id}`] } : {}),
  };
}

function claim(id: string, chargeId: string, insurerReference = PLAN_REFERENCE): Claim {
  return {
    resourceType: "Claim",
    id,
    status: "active",
    type: { text: "professional" },
    use: "claim",
    patient: { reference: "Patient/patient-1" },
    created: "2026-07-15",
    insurer: { reference: insurerReference },
    provider: { reference: "Practitioner/provider-1" },
    priority: { text: "normal" },
    item: [{
      sequence: 1,
      extension: [{
        url: ODOS_CLAIM_CHARGE_ITEM_EXTENSION_URL,
        valueReference: { reference: `ChargeItem/${chargeId}` },
      }],
      productOrService: { text: "Optical line" },
    }],
  };
}

function response(
  id: string,
  claimId: string,
  chargeId: string,
  paidCents: number,
  deductionCents: number,
): ClaimResponse {
  return {
    resourceType: "ClaimResponse",
    id,
    status: "active",
    type: { text: "professional" },
    use: "claim",
    patient: { reference: "Patient/patient-1" },
    created: "2026-07-16",
    insurer: { reference: PLAN_REFERENCE },
    request: { reference: `Claim/${claimId}` },
    outcome: "complete",
    item: [{
      itemSequence: 1,
      extension: [{
        url: ODOS_CLAIM_CHARGE_ITEM_EXTENSION_URL,
        valueReference: { reference: `ChargeItem/${chargeId}` },
      }],
      adjudication: [
        { category: { text: "paid" }, amount: usd(paidCents) },
        { category: { text: "adjustment CO 45" }, amount: usd(deductionCents) },
      ],
    }],
  };
}

function reconciliation(
  id: string,
  chargeId: string,
  responseId: string,
  paidCents: number,
): PaymentReconciliation {
  return {
    resourceType: "PaymentReconciliation",
    id,
    status: "active",
    outcome: "complete",
    created: "2026-07-16T13:00:00Z",
    paymentAmount: usd(paidCents),
    detail: [{
      type: { text: "ChargeItem allocation" },
      request: { reference: `ChargeItem/${chargeId}` },
      response: { reference: `ClaimResponse/${responseId}` },
      amount: usd(paidCents),
    }],
  };
}

function linkageTask(id: string, responseId: string): Task {
  return {
    resourceType: "Task",
    id,
    status: "ready",
    intent: "order",
    code: { coding: [{ system: ERA_WORKLIST_CODE_SYSTEM, code: "era-line-linkage" }] },
    businessStatus: { coding: [{ system: ERA_WORKLIST_STATUS_SYSTEM, code: "new" }] },
    authoredOn: "2026-07-17T10:00:00Z",
    focus: { reference: `ClaimResponse/${responseId}` },
  };
}

function profile(planKey: string, frameAllowanceCents: number): PlanProfile {
  return {
    id: `profile-${planKey.split("/").at(-1)}`,
    planKey,
    displayName: "VSP",
    dispensingFeeCents: 800,
    frameAllowanceCents,
    contactLensPerBoxCents: 3_500,
    active: true,
  };
}

function usd(cents: number): { value: number; currency: "USD" } {
  return { value: cents / 100, currency: "USD" };
}
