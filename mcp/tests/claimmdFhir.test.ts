import assert from "node:assert/strict";
import { test } from "node:test";
import type { ChargeItem } from "@medplum/fhirtypes";
import {
  buildClaimMdProfessionalClaimJson,
  buildClaimResponseFromClaimMdEra,
  buildManualClaimResponse,
  buildCoverageEligibilityRequest,
  buildCoverageEligibilityResponseFromClaimMd,
  buildProfessionalClaim,
  medicalEligibilitySummary,
  OSOD_CLAIM_CHARGE_ITEM_EXTENSION_URL,
  type ProfessionalClaimInput,
} from "../src/claims/claimmd-fhir.js";

const PROCEDURE_SYSTEM = "https://osod.test/fhir/CodeSystem/synthetic-procedure";
const DIAGNOSIS_SYSTEM = "https://osod.test/fhir/CodeSystem/synthetic-diagnosis";

const chargeItems: ChargeItem[] = [
  {
    resourceType: "ChargeItem",
    id: "charge-1",
    status: "billable",
    subject: { reference: "Patient/pat-900" },
    code: { coding: [{ system: PROCEDURE_SYSTEM, code: "PROC-A", display: "Synthetic exam service" }] },
    quantity: { value: 1 },
    priceOverride: { value: 125, currency: "USD" },
  },
  {
    resourceType: "ChargeItem",
    id: "charge-2",
    status: "billable",
    subject: { reference: "Patient/pat-900" },
    code: { coding: [{ system: PROCEDURE_SYSTEM, code: "PROC-B" }] },
    quantity: { value: 2 },
    priceOverride: { value: 50, currency: "USD" },
  },
];

const professionalClaimInput: ProfessionalClaimInput = {
  created: "2026-07-09",
  serviceDate: "2026-07-09",
  patientReference: "Patient/pat-900",
  providerReference: "Practitioner/prov-1",
  insurerReference: "Organization/payer-1",
  coverageReference: "Coverage/cov-1",
  patientAccountNumber: "OSOD-CLAIM-900",
  payerId: "PAYERTEST",
  billingProvider: {
    name: "OSOD TEST CLINIC",
    npi: "1111111112",
    taxId: "900000001",
    taxIdType: "E",
    address1: "1 LOCALHOST WAY",
    city: "SANTA FE",
    state: "NM",
    zip: "87501",
  },
  renderingProvider: {
    firstName: "ALEX",
    lastName: "SYNTHETIC",
    npi: "1111111112",
  },
  subscriber: {
    firstName: "JAMIE",
    lastName: "SYNTHETIC",
    memberId: "TEST-900",
    dateOfBirth: "1980-01-01",
    sex: "F",
    relationshipCode: "18",
    address1: "900 TEST ST",
    city: "SANTA FE",
    state: "NM",
    zip: "87501",
  },
  patient: {
    firstName: "JAMIE",
    lastName: "SYNTHETIC",
    dateOfBirth: "1980-01-01",
    sex: "F",
    address1: "900 TEST ST",
    city: "SANTA FE",
    state: "NM",
    zip: "87501",
  },
  diagnoses: [{ system: DIAGNOSIS_SYSTEM, code: "DX-A", display: "Synthetic diagnosis" }],
  chargeItems,
};

test("buildProfessionalClaim composes the existing ChargeItem lines into a professional FHIR Claim", () => {
  const claim = buildProfessionalClaim(professionalClaimInput);

  assert.equal(claim.resourceType, "Claim");
  assert.equal(claim.status, "active");
  assert.equal(claim.use, "claim");
  assert.equal(claim.type.coding?.[0]?.code, "professional");
  assert.equal(claim.patient.reference, "Patient/pat-900");
  assert.equal(claim.provider.reference, "Practitioner/prov-1");
  assert.equal(claim.insurer?.reference, "Organization/payer-1");
  assert.equal(claim.insurance[0].coverage.reference, "Coverage/cov-1");
  assert.equal(claim.diagnosis?.[0]?.diagnosisCodeableConcept?.coding?.[0]?.code, "DX-A");
  assert.equal(claim.item?.length, 2);
  assert.equal(claim.item?.[0]?.productOrService.coding?.[0]?.code, "PROC-A");
  assert.equal(claim.item?.[0]?.unitPrice?.value, 125);
  assert.deepEqual(claim.item?.[0]?.diagnosisSequence, [1]);
  assert.equal(claim.item?.[0]?.servicedDate, "2026-07-09");
  assert.equal(
    claim.item?.[0]?.extension?.find((extension) => extension.url === OSOD_CLAIM_CHARGE_ITEM_EXTENSION_URL)
      ?.valueReference?.reference,
    "ChargeItem/charge-1",
  );
});

test("buildProfessionalClaim refuses an unpersisted ChargeItem instead of writing a fake provenance reference", () => {
  const input = structuredClone(professionalClaimInput);
  delete input.chargeItems[0].id;
  assert.throws(() => buildProfessionalClaim(input), /must be persisted/);
});

test("buildClaimMdProfessionalClaimJson round-trips the FHIR claim to Claim.MD's JSON upload shape", () => {
  const claim = buildProfessionalClaim(professionalClaimInput);
  const payload = buildClaimMdProfessionalClaimJson(professionalClaimInput, claim);

  assert.equal(payload.claim.length, 1);
  assert.equal(payload.claim[0].claim_form, "1500");
  assert.equal(payload.claim[0].payerid, "PAYERTEST");
  assert.equal(payload.claim[0].pcn, "OSOD-CLAIM-900");
  assert.equal(payload.claim[0].total_charge, "225.00");
  assert.equal(payload.claim[0].diag_1, "DX-A");
  assert.equal(payload.claim[0].charge.length, 2);
  assert.equal(payload.claim[0].charge[0].proc_code, "PROC-A");
  assert.equal(payload.claim[0].charge[0].charge, "125.00");
  assert.equal(payload.claim[0].charge[0].remote_chgid, "charge-1");
  assert.equal(payload.claim[0].charge[1].units, "2");
});

test("Claim.MD payload stays byte-identical when only persisted Claim provenance and servicedDate change", () => {
  const before = buildClaimMdProfessionalClaimJson(
    professionalClaimInput,
    {
      ...buildProfessionalClaim(professionalClaimInput),
      item: buildProfessionalClaim(professionalClaimInput).item?.map(({ extension: _extension, servicedDate: _servicedDate, ...item }) => item),
    },
  );
  const after = buildClaimMdProfessionalClaimJson(professionalClaimInput, buildProfessionalClaim(professionalClaimInput));
  assert.equal(JSON.stringify(after), JSON.stringify(before));
});

test("buildClaimResponseFromClaimMdEra maps ERA paid, allowed, adjustment, and patient responsibility amounts", () => {
  const response = buildClaimResponseFromClaimMdEra({
    claimReference: "Claim/claim-1",
    patientReference: "Patient/pat-900",
    insurerReference: "Organization/payer-1",
    providerReference: "Practitioner/prov-1",
    created: "2026-07-09",
    era: {
      eraid: "era-900",
      paid_date: "2026-07-09",
      payer_name: "SYNTHETIC PAYER",
      claim: {
        pcn: "OSOD-CLAIM-900",
        payer_icn: "ICN-900",
        total_charge: "225.00",
        total_paid: "170.00",
        status_code: "1",
        charge: [
          {
            chgid: "charge-1",
            proc_code: "PROC-A",
            charge: "125.00",
            allowed: "100.00",
            paid: "80.00",
            adjustment: [
              { group: "PR", code: "2", amount: "15.00" },
              { group: "CO", code: "45", amount: "30.00" },
            ],
          },
        ],
      },
    },
  });

  assert.equal(response.resourceType, "ClaimResponse");
  assert.equal(response.request?.reference, "Claim/claim-1");
  assert.equal(response.preAuthRef, "ICN-900");
  assert.equal(response.outcome, "complete");
  assert.equal(response.payment?.amount.value, 170);
  assert.equal(response.item?.[0]?.itemSequence, 1);
  assert.equal(
    response.item?.[0]?.extension?.find((extension) => extension.url === OSOD_CLAIM_CHARGE_ITEM_EXTENSION_URL)
      ?.valueReference?.reference,
    "ChargeItem/charge-1",
  );
  assert.equal(response.item?.[0]?.adjudication.find((a) => a.category.text === "paid")?.amount?.value, 80);
  assert.equal(
    response.item?.[0]?.adjudication.find((a) => a.category.text === "patient responsibility")?.amount?.value,
    15,
  );
});

test("buildManualClaimResponse preserves paid, allowed, and distinct PR-1/2/3 adjudications", () => {
  const response = buildManualClaimResponse({
    claimReference: "Claim/claim-1",
    patientReference: "Patient/pat-900",
    insurerReference: "Organization/payer-1",
    providerReference: "Practitioner/prov-1",
    created: "2026-07-10",
    paymentDate: "2026-07-10",
    paymentReference: "EFT-900",
    paymentIdentifierSystem: "https://osod.dev/fhir/NamingSystem/manual-eob",
    lines: [{
      itemSequence: 1,
      submittedCents: 12_500,
      allowedCents: 10_000,
      paidCents: 7_000,
      deductibleCents: 1_000,
      coinsuranceCents: 1_200,
      copayCents: 800,
    }],
  });

  const adjudications = response.item?.[0]?.adjudication ?? [];
  assert.equal(response.disposition, "Manual EOB posting");
  assert.equal(response.payment?.amount.value, 70);
  assert.equal(adjudications.find((entry) => entry.category.text === "submitted")?.amount?.value, 125);
  assert.equal(adjudications.find((entry) => entry.category.text === "allowed")?.amount?.value, 100);
  assert.equal(adjudications.find((entry) => entry.category.text === "paid")?.amount?.value, 70);
  assert.equal(adjudications.find((entry) => entry.category.text === "patient responsibility")?.amount?.value, 30);
  assert.equal(adjudications.find((entry) => entry.category.text === "adjustment PR 1")?.amount?.value, 10);
  assert.equal(adjudications.find((entry) => entry.category.text === "adjustment PR 2")?.amount?.value, 12);
  assert.equal(adjudications.find((entry) => entry.category.text === "adjustment PR 3")?.amount?.value, 8);
});

test("buildCoverageEligibilityRequest and response mapper capture medical eligibility fields", () => {
  const request = buildCoverageEligibilityRequest({
    patientReference: "Patient/pat-900",
    coverageReference: "Coverage/cov-1",
    insurerReference: "Organization/payer-1",
    providerReference: "Practitioner/prov-1",
    created: "2026-07-09",
    serviceDate: "2026-07-09",
  });
  assert.deepEqual(request.purpose, ["validation", "benefits", "auth-requirements"]);
  assert.equal(request.insurance?.[0]?.coverage.reference, "Coverage/cov-1");

  const response = buildCoverageEligibilityResponseFromClaimMd({
    requestReference: "CoverageEligibilityRequest/elig-req-1",
    patientReference: "Patient/pat-900",
    coverageReference: "Coverage/cov-1",
    insurerReference: "Organization/payer-1",
    requestorReference: "Practitioner/prov-1",
    created: "2026-07-09",
    claimMd: {
      result: {
        elig: {
          eligid: "elig-900",
          benefit: [
            { benefit_coverage_code: "1", benefit_coverage_description: "Active Coverage", benefit_description: "Health Benefit Plan Coverage" },
            { benefit_coverage_code: "C", benefit_coverage_description: "Deductible", benefit_amount: "300.00", benefit_period_description: "Calendar Year" },
            { benefit_coverage_code: "B", benefit_coverage_description: "Co-Payment", benefit_amount: "25.00" },
            { benefit_coverage_code: "A", benefit_coverage_description: "Co-Insurance", benefit_percent: "20" },
            { benefit_coverage_code: "P", benefit_coverage_description: "Prior Authorization Required" },
          ],
        },
      },
    },
  });

  assert.equal(response.insurance?.[0]?.inforce, true);
  const summary = medicalEligibilitySummary(response);
  assert.equal(summary.coverageStatus, "active");
  assert.equal(summary.deductibleRemainingCents, 30000);
  assert.equal(summary.copayCents, 2500);
  assert.equal(summary.coinsurancePercent, 20);
  assert.equal(summary.priorAuthRequired, true);
});
