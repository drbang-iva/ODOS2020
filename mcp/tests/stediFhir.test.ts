import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildClaimResponseFromStediEra,
  buildClaimResponseFromStediStatus,
  buildCoverageEligibilityResponseFromStedi,
  buildStediEligibilityJson,
  buildStediProfessionalClaimJson,
} from "../src/claims/stedi-fhir.js";
import { buildProfessionalClaim, type ProfessionalClaimInput } from "../src/claims/claimmd-fhir.js";
import { createStediAdapter, STEDI_DEFAULT_BASE_URL, STEDI_DEFAULT_CORE_BASE_URL } from "../src/claims/stedi-adapter.js";
import { ClaimSubmissionValidationError } from "../src/claims/claim-errors.js";

const claimInput: ProfessionalClaimInput = {
  created: "2026-07-11",
  serviceDate: "2026-07-11",
  patientReference: "Patient/pat-900",
  providerReference: "Practitioner/prov-1",
  insurerReference: "Organization/payer-1",
  coverageReference: "Coverage/cov-1",
  patientAccountNumber: "ODOSCLAIM900",
  payerId: "STEDITEST",
  billingProvider: {
    name: "SYNTHETIC VISION",
    npi: "1999999984",
    taxId: "900000001",
    taxonomy: "152W00000X",
    address1: "900 TEST AVE",
    city: "TESTVILLE",
    state: "NY",
    zip: "100010000",
    phone: "5555550100",
  },
  renderingProvider: { firstName: "TEST", lastName: "PROVIDER", npi: "1999999984", taxonomy: "152W00000X" },
  subscriber: {
    firstName: "JAMIE",
    lastName: "SYNTHETIC",
    dateOfBirth: "1990-01-01",
    sex: "U",
    memberId: "MEMBER900",
    relationshipCode: "18",
    address1: "901 TEST AVE",
    city: "TESTVILLE",
    state: "NY",
    zip: "100010001",
  },
  patient: { firstName: "JAMIE", lastName: "SYNTHETIC", dateOfBirth: "1990-01-01", sex: "U" },
  diagnoses: [{ system: "https://odos.test/fhir/CodeSystem/synthetic-diagnosis", code: "DX-A" }],
  chargeItems: [{
    resourceType: "ChargeItem",
    id: "line-1",
    status: "billable",
    code: { coding: [{ system: "https://odos.test/fhir/CodeSystem/synthetic-procedure", code: "PROC-A" }] },
    subject: { reference: "Patient/pat-900" },
    quantity: { value: 1 },
    priceOverride: { value: 125, currency: "USD" },
  }],
};

test("Stedi claim mapper emits the documented 837P JSON shape", () => {
  const payload = buildStediProfessionalClaimJson(claimInput, buildProfessionalClaim(claimInput), "test");
  assert.equal(payload.usageIndicator, "T");
  assert.equal(payload.tradingPartnerServiceId, "STEDITEST");
  assert.equal(payload.submitter.submitterIdentification, "1999999984");
  assert.equal(payload.claimInformation.patientControlNumber, "ODOSCLAIM900");
  assert.equal(payload.claimInformation.serviceLines[0].providerControlNumber, "line-1");
  assert.equal(payload.claimInformation.serviceLines[0].professionalService.procedureCode, "PROC-A");
  assert.equal(payload.billing.employerId, "900000001");
});

test("Stedi claim submission rejects an incomplete subscriber address before transport", async () => {
  let fetchCalls = 0;
  const fetchImpl = (async () => {
    fetchCalls += 1;
    return new Response(JSON.stringify({ claimReference: { correlationId: "should-not-run" } }), { status: 200 });
  }) as typeof fetch;
  const adapter = createStediAdapter({
    config: { baseUrl: STEDI_DEFAULT_BASE_URL, coreBaseUrl: STEDI_DEFAULT_CORE_BASE_URL, apiKey: "test-key", submitterId: "SUBMITTER900", mode: "test" },
    fetchImpl,
  });
  const input: ProfessionalClaimInput = {
    ...claimInput,
    subscriber: { ...claimInput.subscriber, address1: undefined },
  };

  await assert.rejects(async () => {
    const payload = buildStediProfessionalClaimJson(input, buildProfessionalClaim(input), "test");
    await adapter.submitProfessionalClaim({ payload, idempotencyKey: "ODOSCLAIM900-NO-SUBSCRIBER-ADDRESS" });
  }, /subscriber address and complete physical address/);
  assert.equal(fetchCalls, 0);
});

test("Stedi claim mapper classifies incomplete billing and subscriber addresses as submission validation errors", () => {
  const cases: Array<{ input: ProfessionalClaimInput; message: RegExp }> = [
    {
      input: { ...claimInput, billingProvider: { ...claimInput.billingProvider, address1: undefined } },
      message: /billing name, tax ID, and complete physical address/,
    },
    {
      input: { ...claimInput, subscriber: { ...claimInput.subscriber, address1: undefined } },
      message: /subscriber address and complete physical address/,
    },
  ];

  for (const testCase of cases) {
    assert.throws(
      () => buildStediProfessionalClaimJson(testCase.input, buildProfessionalClaim(testCase.input), "test"),
      (error: unknown) => {
        assert.ok(error instanceof ClaimSubmissionValidationError);
        assert.match(error.message, testCase.message);
        return true;
      },
    );
  }
});

test("Stedi eligibility mapper and 271 response target the shared FHIR eligibility shape", () => {
  const request = buildStediEligibilityJson(claimInput, ["30"]);
  assert.equal(request.provider.npi, "1999999984");
  assert.deepEqual(request.encounter.serviceTypeCodes, ["30"]);
  const response = buildCoverageEligibilityResponseFromStedi({
    requestReference: "CoverageEligibilityRequest/elig-1",
    patientReference: "Patient/pat-900",
    coverageReference: "Coverage/cov-1",
    insurerReference: "Organization/payer-1",
    created: "2026-07-11",
    stedi: {
      planStatus: [{ statusCode: "1", status: "Active Coverage" }],
      benefitsInformation: [
        { name: "Deductible", benefitAmount: "250" },
        { name: "Co-Insurance", benefitPercent: "0.2" },
      ],
    },
  });
  assert.equal(response.insurance?.[0].inforce, true);
  assert.equal(response.insurance?.[0].item?.[0].benefit?.[0].allowedMoney?.value, 250);
  assert.equal(response.insurance?.[0].item?.[1].benefit?.[0].allowedUnsignedInt, 20);
});

test("Stedi 277 and 835 responses map to the shared FHIR ClaimResponse shape", () => {
  const status = buildClaimResponseFromStediStatus({
    claimReference: "Claim/claim-1",
    patientReference: "Patient/pat-900",
    insurerReference: "Organization/payer-1",
    created: "2026-07-11",
    status: { claims: [{ claimStatus: { statusCategoryCode: "F1", statusCodeValue: "Claim has been paid.", trackingNumber: "track-1" } }] },
  });
  assert.equal(status.outcome, "complete");
  assert.equal(status.preAuthRef, "track-1");

  const era = buildClaimResponseFromStediEra({
    claimReference: "Claim/claim-1",
    patientReference: "Patient/pat-900",
    insurerReference: "Organization/payer-1",
    created: "2026-07-11",
    transactionId: "7647d644-9348-4596-a3b4-6830b8b48cc8",
    payerName: "SYNTHETIC PAYER",
    paymentDate: "20260711",
    traceNumber: "TRACE900",
    claim: {
      claimPaymentInfo: { patientControlNumber: "ODOSCLAIM900", totalClaimChargeAmount: "125", claimPaymentAmount: "80", patientResponsibilityAmount: "20", payerClaimControlNumber: "PAYER900", claimStatusCode: "1" },
      serviceLines: [{
        lineItemControlNumber: "line-1",
        servicePaymentInformation: { lineItemChargeAmount: "125", lineItemProviderPaymentAmount: "80", adjudicatedProcedureCode: "92004" },
        serviceSupplementalAmounts: { allowedActual: "100" },
        serviceAdjustments: [{ claimAdjustmentGroupCode: "PR", adjustmentReasonCode1: "1", adjustmentAmount1: "20" }],
      }],
    },
  });
  assert.equal(era.payment?.amount.value, 80);
  assert.equal(era.item?.[0].extension?.[0]?.valueReference?.reference, "ChargeItem/line-1");
  assert.equal(era.item?.[0].adjudication.find((entry) => entry.category.text === "allowed")?.amount?.value, 100);
  assert.equal(era.payment?.identifier?.value, "TRACE900");
});
