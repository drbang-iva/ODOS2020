import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { test } from "node:test";
import type { ClaimResponse } from "@medplum/fhirtypes";
import type { StructureDefinition } from "@medplum/fhirtypes";
import { buildProfessionalClaim, type ProfessionalClaimInput } from "../src/claims/claimmd-fhir.js";
import {
  OSOD_SOURCE_CLAIM_EXTENSION_URL,
  buildPatientResponsibilityInvoice,
  patientResponsibilityInvoiceMatches,
} from "../src/claims/patient-responsibility-invoice.js";

const input: ProfessionalClaimInput = {
  created: "2026-07-12",
  serviceDate: "2026-07-10",
  patientReference: "Patient/p1",
  providerReference: "Practitioner/provider-1",
  insurerReference: "Organization/payer-1",
  coverageReference: "Coverage/coverage-1",
  patientAccountNumber: "CLAIM-1",
  payerId: "PAYER",
  billingProvider: { npi: "1111111112" },
  renderingProvider: { npi: "1111111112" },
  subscriber: { firstName: "Jamie", lastName: "Test", dateOfBirth: "1980-01-01", sex: "F" },
  patient: { firstName: "Jamie", lastName: "Test", dateOfBirth: "1980-01-01", sex: "F" },
  diagnoses: [{ system: "https://osod.test/diagnosis", code: "DX" }],
  chargeItems: [
    { resourceType: "ChargeItem", id: "charge-1", status: "billable", code: { coding: [{ system: "https://osod.test/procedure", code: "PROC-1", display: "Line one" }] }, subject: { reference: "Patient/p1" }, priceOverride: { value: 200, currency: "USD" } },
    { resourceType: "ChargeItem", id: "charge-2", status: "billable", code: { coding: [{ system: "https://osod.test/procedure", code: "PROC-2", display: "Line two" }] }, subject: { reference: "Patient/p1" }, priceOverride: { value: 100, currency: "USD" } },
  ],
};

test("patient-responsibility Invoice uses per-line posted PR only and preserves ChargeItem provenance", () => {
  const claim = { ...buildProfessionalClaim(input), id: "claim-1" };
  const response: ClaimResponse = {
    resourceType: "ClaimResponse",
    id: "response-1",
    status: "active",
    type: claim.type,
    use: "claim",
    patient: { reference: "Patient/p1" },
    created: "2026-07-12",
    insurer: { reference: "Organization/payer-1" },
    request: { reference: "Claim/claim-1" },
    outcome: "complete",
    item: [
      { itemSequence: 1, adjudication: [
        adjudication("submitted", 20_000),
        adjudication("adjustment CO 45", 5_000),
        adjudication("patient responsibility", 5_698),
        adjudication("adjustment PR 1", 3_000),
        adjudication("adjustment PR 2", 2_698),
      ] },
      { itemSequence: 2, adjudication: [
        adjudication("adjustment PR 3", 11_491),
        adjudication("paid", 4_000),
      ] },
    ],
  };

  const invoice = buildPatientResponsibilityInvoice(claim, response)!;

  assert.deepEqual(invoice.lineItem?.map((line) => ({
    sequence: line.sequence,
    charge: line.chargeItemReference?.reference,
    value: line.priceComponent?.[0]?.amount?.value,
  })), [
    { sequence: 1, charge: "ChargeItem/charge-1", value: 56.98 },
    { sequence: 2, charge: "ChargeItem/charge-2", value: 114.91 },
  ]);
  assert.equal(invoice.totalGross?.value, 171.89);
  assert.equal(invoice.totalNet?.value, 171.89);
  assert.equal(invoice.extension?.find((extension) => extension.url === OSOD_SOURCE_CLAIM_EXTENSION_URL)
    ?.valueReference?.reference, "Claim/claim-1");
});

test("zero PR and denial responses emit no Invoice", () => {
  const claim = { ...buildProfessionalClaim(input), id: "claim-1" };
  const base: ClaimResponse = {
    resourceType: "ClaimResponse", status: "active", type: claim.type, use: "claim",
    patient: { reference: "Patient/p1" }, created: "2026-07-12",
    insurer: { reference: "Organization/payer-1" }, request: { reference: "Claim/claim-1" }, outcome: "complete",
    item: [{ itemSequence: 1, adjudication: [adjudication("adjustment CO 45", 5_000)] }],
  };
  assert.equal(buildPatientResponsibilityInvoice(claim, base), undefined);
  assert.equal(buildPatientResponsibilityInvoice(claim, {
    ...base,
    outcome: "error",
    item: [{ itemSequence: 1, adjudication: [adjudication("adjustment PR 1", 5_000)] }],
  }), undefined);
});

test("patient-responsibility Invoice rejects fractional cents", () => {
  const claim = { ...buildProfessionalClaim(input), id: "claim-1" };
  const response: ClaimResponse = {
    resourceType: "ClaimResponse", status: "active", type: claim.type, use: "claim",
    patient: { reference: "Patient/p1" }, created: "2026-07-12",
    insurer: { reference: "Organization/payer-1" }, request: { reference: "Claim/claim-1" }, outcome: "complete",
    item: [{ itemSequence: 1, adjudication: [{
      category: { text: "adjustment PR 1" }, amount: { value: 10.001, currency: "USD" },
    }] }],
  };
  assert.throws(() => buildPatientResponsibilityInvoice(claim, response), /whole cents/);
});

test("money comparison detects a corrected remit without treating metadata drift as money mutation", () => {
  const claim = { ...buildProfessionalClaim(input), id: "claim-1" };
  const response: ClaimResponse = {
    resourceType: "ClaimResponse", status: "active", type: claim.type, use: "claim",
    patient: { reference: "Patient/p1" }, created: "2026-07-12",
    insurer: { reference: "Organization/payer-1" }, request: { reference: "Claim/claim-1" }, outcome: "complete",
    item: [{ itemSequence: 1, adjudication: [adjudication("adjustment PR 1", 5_000)] }],
  };
  const invoice = buildPatientResponsibilityInvoice(claim, response)!;
  assert.equal(patientResponsibilityInvoiceMatches({ ...invoice, id: "stored", date: "2026-07-13" }, invoice), true);
  assert.equal(patientResponsibilityInvoiceMatches({
    ...invoice,
    totalGross: { value: 49, currency: "USD" },
    totalNet: { value: 49, currency: "USD" },
  }, invoice), false);
});

test("claim-invoice seam extensions are installable R4 Reference constraints", async () => {
  const cases = [
    ["osod-charge-item.json", ["Claim.item", "ClaimResponse.item"], "http://hl7.org/fhir/StructureDefinition/ChargeItem"],
    ["osod-source-claim.json", ["Invoice"], "http://hl7.org/fhir/StructureDefinition/Claim"],
  ] as const;
  for (const [file, contexts, targetProfile] of cases) {
    const definition = JSON.parse(await readFile(
      resolve(import.meta.dirname, "../../data/canonical-extensions", file),
      "utf8",
    )) as StructureDefinition;
    assert.equal(definition.fhirVersion, "4.0.1");
    assert.deepEqual(definition.context, contexts.map((expression) => ({ type: "element", expression })));
    assert.equal(definition.differential?.element.find((element) => element.id === "Extension.extension")?.max, "0");
    assert.deepEqual(
      definition.differential?.element.find((element) => element.id === "Extension.value[x]")?.type,
      [{ code: "Reference", targetProfile: [targetProfile] }],
    );
  }
});

function adjudication(category: string, cents: number) {
  return { category: { text: category }, amount: { value: cents / 100, currency: "USD" as const } };
}
