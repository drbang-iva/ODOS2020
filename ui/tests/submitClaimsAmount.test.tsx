import assert from "node:assert/strict";
import { test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ClaimReview } from "../src/scenes/claims/SubmitClaims";
import type { ProfessionalClaimInput } from "../src/lib/submit-claims";

test("claim review shows priceOverride as the line total without multiplying by quantity", () => {
  const html = renderToStaticMarkup(
    <ClaimReview
      claim={claimInput()}
      submitting={false}
      onEdit={() => undefined}
      onSubmit={() => undefined}
    />,
  );

  assert.match(html, /Fee \$20\.00 · Qty 2/);
  assert.match(html, /Claim total.*\$20\.00/);
  assert.doesNotMatch(html, /\$40\.00/);
});

function claimInput(): ProfessionalClaimInput {
  return {
    created: "2026-09-07",
    serviceDate: "2026-09-07",
    patientReference: "Patient/pat-m1a",
    providerReference: "Practitioner/prov-m1a",
    insurerReference: "Organization/payer-m1a",
    coverageReference: "Coverage/cov-m1a",
    patientAccountNumber: "M1A-WITNESS",
    payerId: "PAYERTEST",
    billingProvider: { name: "SYNTHETIC PRACTICE", npi: "1999999984" },
    renderingProvider: { firstName: "TEST", lastName: "PROVIDER", npi: "1999999984" },
    subscriber: { firstName: "TEST", lastName: "PATIENT", dateOfBirth: "1980-01-01", sex: "U" },
    patient: { firstName: "TEST", lastName: "PATIENT", dateOfBirth: "1980-01-01", sex: "U" },
    diagnoses: [{ system: "https://odos.test/diagnosis", code: "DX-M1A" }],
    chargeItems: [{
      resourceType: "ChargeItem",
      id: "line-b",
      status: "billable",
      code: { coding: [{ system: "https://odos.test/procedure", code: "PROC-M1A" }] },
      subject: { reference: "Patient/pat-m1a" },
      quantity: { value: 2 },
      priceOverride: { value: 20, currency: "USD" },
    }],
  };
}
