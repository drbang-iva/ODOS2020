import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildClaimResponseFromStediEra,
  buildClaimResponseFromStediStatus,
  buildCoverageEligibilityResponseFromStedi,
  buildStediEligibilityJson,
  buildStediProfessionalClaimJson,
  determineStediClaimResubmission,
  readStedi277,
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

test("pre-adjudication correction stays CFC 1 without a payer claim control number", () => {
  assert.deepEqual(determineStediClaimResubmission({ intent: "correct" }), {
    status: "ready",
    claimFrequencyCode: "1",
  });
});

test("pre-adjudication void stays manual because there is no payer claim to cancel", () => {
  const result = determineStediClaimResubmission({ intent: "void" });
  assert.equal(result.status, "manual");
  assert.match(result.status === "manual" ? result.reason : "", /no payer claim control number|nothing to cancel/i);
});

test("adjudicated non-Medicare correction and void use CFC 7/8 with the PCCN", () => {
  assert.deepEqual(determineStediClaimResubmission({
    intent: "correct",
    payerClaimControlNumber: "PCCN-900",
    payerClassification: "confirmed-non-medicare",
  }), {
    status: "ready",
    claimFrequencyCode: "7",
    claimControlNumber: "PCCN-900",
  });
  assert.deepEqual(determineStediClaimResubmission({
    intent: "void",
    payerClaimControlNumber: "PCCN-900",
    payerClassification: "confirmed-non-medicare",
  }), {
    status: "ready",
    claimFrequencyCode: "8",
    claimControlNumber: "PCCN-900",
  });
});

test("adjudicated Medicare or unknown payer classification stays manual", () => {
  for (const payerClassification of ["original-medicare", undefined] as const) {
    const result = determineStediClaimResubmission({
      intent: "correct",
      payerClaimControlNumber: "PCCN-900",
      payerClassification,
    });
    assert.equal(result.status, "manual");
  }
});

test("default Stedi claim remains CFC 1 without supplemental claim information", () => {
  const payload = buildStediProfessionalClaimJson(claimInput, buildProfessionalClaim(claimInput), "test");
  assert.equal(payload.claimInformation.claimFrequencyCode, "1");
  assert.equal("claimSupplementalInformation" in payload.claimInformation, false);
});

test("invalid Stedi claim frequency code fails before transport", async () => {
  let fetchCalls = 0;
  const adapter = createStediAdapter({
    config: { baseUrl: STEDI_DEFAULT_BASE_URL, coreBaseUrl: STEDI_DEFAULT_CORE_BASE_URL, apiKey: "test-key", submitterId: "SUBMITTER900", mode: "test" },
    fetchImpl: (async () => {
      fetchCalls += 1;
      return new Response("{}", { status: 200 });
    }) as typeof fetch,
  });
  const invalid = { ...claimInput, claimFrequencyCode: "9" } as ProfessionalClaimInput;

  await assert.rejects(async () => {
    const payload = buildStediProfessionalClaimJson(invalid, buildProfessionalClaim(invalid), "test");
    await adapter.submitProfessionalClaim({ payload, idempotencyKey: "INVALID-CFC" });
  }, /claim frequency code must be 1, 7, or 8/);
  assert.equal(fetchCalls, 0);
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

test("Stedi claim mapper uses each ChargeItem's diagnosis pointers", () => {
  const input = structuredClone(claimInput);
  input.diagnoses.push({ system: "https://odos.test/fhir/CodeSystem/synthetic-diagnosis", code: "DX-B" });
  input.chargeItems[0]!.diagnosisSequence = [2];
  const payload = buildStediProfessionalClaimJson(input, buildProfessionalClaim(input), "test");
  assert.deepEqual(
    payload.claimInformation.serviceLines[0].professionalService.compositeDiagnosisCodePointers.diagnosisCodePointers,
    ["2"],
  );
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

test("Stedi ERA preserves all populated service and claim adjustment slots, including zero and negative amounts", () => {
  const era = buildClaimResponseFromStediEra({
    claimReference: "Claim/claim-1",
    patientReference: "Patient/pat-900",
    insurerReference: "Organization/payer-1",
    created: "2026-07-11",
    transactionId: "era-adjustments-900",
    paymentDate: "20260711",
    claim: {
      claimPaymentInfo: {
        patientControlNumber: "ODOSCLAIM900",
        totalClaimChargeAmount: "125",
        claimPaymentAmount: "80",
        patientResponsibilityAmount: "25",
        claimStatusCode: "1",
      },
      claimAdjustments: [{
        claimAdjustmentGroupCode: "CO",
        adjustmentReasonCode1: "45",
        adjustmentAmount1: "10",
        adjustmentReasonCode2: "94",
        adjustmentAmount2: "0",
        adjustmentReasonCode3: "253",
        adjustmentAmount3: "-5",
        adjustmentReasonCode4: "97",
        adjustmentAmount4: "2",
        adjustmentReasonCode5: "131",
        adjustmentAmount5: "-1",
        adjustmentReasonCode6: "234",
        adjustmentAmount6: "3",
      }],
      serviceLines: [{
        lineItemControlNumber: "line-1",
        servicePaymentInformation: {
          lineItemChargeAmount: "125",
          lineItemProviderPaymentAmount: "0",
          adjudicatedProcedureCode: "92004",
        },
        serviceSupplementalAmounts: { allowedActual: "100" },
        serviceAdjustments: [{
          claimAdjustmentGroupCode: "PR",
          adjustmentReasonCode1: "1",
          adjustmentAmount1: "10",
          adjustmentReasonCode2: "2",
          adjustmentAmount2: "0",
          adjustmentReasonCode3: "3",
          adjustmentAmount3: "15",
          adjustmentReasonCode4: "4",
          adjustmentAmount4: "-2",
          adjustmentReasonCode5: "5",
          adjustmentAmount5: "1",
          adjustmentReasonCode6: "6",
          adjustmentAmount6: "1",
        }],
      }],
    } as any,
  });

  assert.deepEqual(
    era.item?.[0].adjudication.map((entry) => [entry.category.text, entry.amount?.value]),
    [
      ["submitted", 125],
      ["allowed", 100],
      ["paid", 0],
      ["adjustment PR 1", 10],
      ["adjustment PR 2", 0],
      ["adjustment PR 3", 15],
      ["adjustment PR 4", -2],
      ["adjustment PR 5", 1],
      ["adjustment PR 6", 1],
    ],
  );
  assert.deepEqual(
    era.total?.filter((entry) => entry.category.text?.startsWith("claim adjustment"))
      .map((entry) => [entry.category.text, entry.amount.value]),
    [
      ["claim adjustment CO 45", 10],
      ["claim adjustment CO 94", 0],
      ["claim adjustment CO 253", -5],
      ["claim adjustment CO 97", 2],
      ["claim adjustment CO 131", -1],
      ["claim adjustment CO 234", 3],
    ],
  );
});

test("Stedi ERA maps every documented claim status without treating forwarded or pricing-only claims as ordinary payments", () => {
  const cases = [
    ["1", "complete", "Processed as Primary"],
    ["2", "complete", "Processed as Secondary"],
    ["3", "complete", "Processed as Tertiary"],
    ["4", "error", "Denied"],
    ["19", "partial", "Processed as Primary, Forwarded to Additional Payer(s)"],
    ["20", "partial", "Processed as Secondary, Forwarded to Additional Payer(s)"],
    ["21", "partial", "Processed as Tertiary, Forwarded to Additional Payer(s)"],
    ["22", "complete", "Reversal of Previous Payment"],
    ["23", "partial", "Not Our Claim, Forwarded to Additional Payer(s)"],
    ["25", "complete", "Predetermination Pricing Only, No Payment"],
  ] as const;

  for (const [claimStatusCode, outcome, statusText] of cases) {
    const era = buildClaimResponseFromStediEra({
      claimReference: "Claim/claim-1",
      patientReference: "Patient/pat-900",
      insurerReference: "Organization/payer-1",
      created: "2026-07-11",
      transactionId: `era-status-${claimStatusCode}`,
      paymentDate: "20260711",
      claim: {
        claimPaymentInfo: {
          patientControlNumber: "ODOSCLAIM900",
          claimPaymentAmount: claimStatusCode === "22" ? "-80" : "80",
          claimStatusCode,
        },
      },
    });
    assert.equal(era.outcome, outcome, claimStatusCode);
    assert.match(era.disposition ?? "", new RegExp(statusText.replace(/[()]/g, "\\$&")), claimStatusCode);
    if (claimStatusCode === "22") assert.equal(era.payment?.amount.value, -80);
    if (claimStatusCode === "25" || claimStatusCode === "23") assert.equal(era.payment, undefined);
  }
});

test("Stedi ERA surfaces authoritative patient responsibility, discrepancy evidence, and crossover carrier", () => {
  const era = buildClaimResponseFromStediEra({
    claimReference: "Claim/claim-1",
    patientReference: "Patient/pat-900",
    insurerReference: "Organization/payer-1",
    created: "2026-07-11",
    transactionId: "era-crossover-900",
    paymentDate: "20260711",
    claim: {
      claimPaymentInfo: {
        patientControlNumber: "ODOSCLAIM900",
        claimPaymentAmount: "80",
        patientResponsibilityAmount: "30",
        claimStatusCode: "19",
      },
      crossoverCarrier: {
        organizationName: "SYNTHETIC SECONDARY",
        payorId: "SECONDARY900",
      },
      serviceLines: [{
        servicePaymentInformation: { lineItemChargeAmount: "100", lineItemProviderPaymentAmount: "80" },
        serviceAdjustments: [{
          claimAdjustmentGroupCode: "PR",
          adjustmentReasonCode3: "1",
          adjustmentAmount3: "20",
        }],
      }],
    } as any,
  });

  assert.equal(
    era.total?.find((entry) => entry.category.text === "patient responsibility")?.amount.value,
    30,
  );
  assert.match(era.processNote?.map((note) => note.text).join(" ") ?? "", /differs from summed service-line PR adjustments.*20\.00/i);
  assert.match(era.disposition ?? "", /SYNTHETIC SECONDARY.*SECONDARY900/);
  assert.match(era.processNote?.map((note) => note.text).join(" ") ?? "", /crossover carrier/i);
});

test("readStedi277 extracts three claim outcomes, rejection reasons, sender type, and correlation identifiers", () => {
  const report = readStedi277(stedi277Report([
    stedi277Claim("PCN-ACCEPTED", "A2", "20", "Accepted for processing."),
    stedi277Claim("PCN-REJECTED", "A7", "21", "Invalid procedure code BADCODE.", "Claim issue: invalid procedure code."),
    stedi277Claim("PCN-RECEIVED", "A1", "16", "Claim forwarded to payer."),
  ]), "ack-three");

  assert.deepEqual(report.claims.map((claim) => [claim.patientControlNumber, claim.outcome]), [
    ["PCN-ACCEPTED", "accepted-for-processing"],
    ["PCN-REJECTED", "rejected"],
    ["PCN-RECEIVED", "informational"],
  ]);
  assert.deepEqual(report.claims[1].sender, {
    organizationName: "SYNTHETIC PAYER",
    entityType: "Payer",
    identifier: "PAYER900",
  });
  assert.deepEqual(report.claims[1].traceIdentifiers, {
    transactionId: "ack-three",
    controlNumber: "CONTROL-900",
    referenceIdentification: "REFERENCE-900",
    claimTransactionBatchNumber: "BATCH-900",
    clearinghouseTraceNumber: "CLEARINGHOUSE-PCN-REJECTED",
    tradingPartnerClaimNumber: "PAYER-PCN-REJECTED",
    metaTraceId: "META-TRACE-900",
  });
  assert.match(report.claims[1].reasons.join(" "), /BADCODE/);
  assert.match(report.claims[1].reasons.join(" "), /Claim issue/);
});

test("readStedi277 surfaces a service-line rejection from the claim row with its reason", () => {
  const claim = stedi277Claim("PCN-LINE-REJECTED", "A1", "16", "Claim received.") as any;
  claim.claimStatus.informationClaimStatuses = [];
  claim.serviceLines = [{
    lineItemControlNumber: "line-1",
    serviceClaimStatuses: [{
      serviceStatuses: [{
        healthCareClaimStatusCategoryCode: "A7",
        healthCareClaimStatusCategoryCodeValue: "Rejected for invalid information.",
        statusCode: "21",
        statusCodeValue: "Invalid service-line procedure BADCODE.",
      }],
    }],
  }];

  const report = readStedi277(stedi277Report([claim]), "ack-service-line");

  assert.equal(report.claims[0].outcome, "rejected");
  assert.match(report.claims[0].reasons.join(" "), /service-line procedure BADCODE/i);
});

test("readStedi277 merges claim-level and service-line statuses", () => {
  const claim = stedi277Claim("PCN-MERGED", "A1", "16", "Claim received.") as any;
  claim.serviceLines = [{
    lineItemControlNumber: "line-1",
    serviceClaimStatuses: [{
      serviceStatuses: [{
        healthCareClaimStatusCategoryCode: "A7",
        healthCareClaimStatusCategoryCodeValue: "Rejected for invalid information.",
        statusCode: "21",
        statusCodeValue: "Service line rejected.",
      }],
    }],
  }];

  const report = readStedi277(stedi277Report([claim]), "ack-merged");

  assert.deepEqual(report.claims[0].statuses.map((status) => status.categoryCode), ["A1", "A7"]);
  assert.equal(report.claims[0].outcome, "rejected");
});

test("readStedi277 retains multiple acknowledgments for the same claim and surfaces unknown categories for review", () => {
  const raw = stedi277Report([stedi277Claim("PCN-SAME", "A1", "16", "Forwarded")]) as any;
  raw.transactions.push(...(stedi277Report([
    stedi277Claim("PCN-SAME", "ZZ", "999", "Non-compliant status"),
  ]) as any).transactions);

  const report = readStedi277(raw, "ack-multi");
  assert.equal(report.claims.length, 2);
  assert.equal(report.claims[0].outcome, "informational");
  assert.equal(report.claims[1].outcome, "review");
  assert.deepEqual(report.claims[1].statuses.map((status) => status.categoryCode), ["ZZ"]);
});

test("readStedi277 preserves valid claims while flagging an empty nested acknowledgment branch", () => {
  const raw = stedi277Report([stedi277Claim("PCN-GOOD", "A2", "20", "Accepted")]) as any;
  raw.transactions.push({
    controlNumber: "CONTROL-BAD",
    payers: [{
      organizationName: "SYNTHETIC PAYER",
      claimStatusTransactions: [{ claimStatusDetails: [] }],
    }],
  });

  const report = readStedi277(raw, "ack-partial");
  assert.deepEqual(report.claims.map((claim) => claim.patientControlNumber), ["PCN-GOOD"]);
  assert.match(report.issues.join(" "), /no claim status details/i);
});

function stedi277Report(claims: unknown[]): Record<string, unknown> {
  return {
    meta: { transactionId: "ack-three", traceId: "META-TRACE-900" },
    transactions: [{
      controlNumber: "CONTROL-900",
      referenceIdentification: "REFERENCE-900",
      payers: [{
        organizationName: "SYNTHETIC PAYER",
        entityIdentifierCodeValue: "Payer",
        payerIdentification: "PAYER900",
        claimStatusTransactions: [{
          claimTransactionBatchNumber: "BATCH-900",
          claimStatusDetails: [{ patientClaimStatusDetails: [{ claims }] }],
        }],
      }],
    }],
  };
}

function stedi277Claim(
  patientControlNumber: string,
  categoryCode: string,
  statusCode: string,
  statusCodeValue: string,
  statusMessage?: string,
): Record<string, unknown> {
  return {
    claimStatus: {
      referencedTransactionTraceNumber: patientControlNumber,
      patientAccountNumber: patientControlNumber,
      clearinghouseTraceNumber: `CLEARINGHOUSE-${patientControlNumber}`,
      tradingPartnerClaimNumber: `PAYER-${patientControlNumber}`,
      informationClaimStatuses: [{
        ...(statusMessage ? { statusMessage } : {}),
        informationStatuses: [{
          healthCareClaimStatusCategoryCode: categoryCode,
          healthCareClaimStatusCategoryCodeValue: `Category ${categoryCode}`,
          statusCode,
          statusCodeValue,
          entityIdentifierCodeValue: "Payer",
        }],
      }],
    },
  };
}
