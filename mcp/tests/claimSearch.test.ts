import assert from "node:assert/strict";
import { test } from "node:test";
import type { Claim, ClaimResponse, Resource, Task } from "@medplum/fhirtypes";
import { projectClaimSearchResults } from "../src/claims/claim-search.js";
import {
  buildClaimRejectedWorklistTask,
  buildEraWorklistTask,
  claimEraWorklistTask,
  resolveEraWorklistTask,
} from "../src/claims/era-worklist.js";
import {
  buildClaimResponseFromClaimMdEra,
  buildClaimResponseFromClaimMdStatus,
  buildProfessionalClaim,
  type ClaimMdEraClaim,
  type ProfessionalClaimInput,
} from "../src/claims/claimmd-fhir.js";

const AT = "2026-07-10T12:00:00.000Z";

test("claim search derives submitted, rejected, denied, underpaid, and paid without storing a parallel status", () => {
  const claims = [1, 2, 3, 4, 5].map((number) => claim(number));
  const rejected = statusResponse("response-2", "Claim/claim-2", "Rejected by payer edit");
  const denied = eraResponse("response-3", "Claim/claim-3", "0.00", []);
  const underpaid = eraResponse("response-4", "Claim/claim-4", "80.00", [{ group: "CO", code: "45", amount: "20.00" }]);
  const paid = eraResponse("response-5", "Claim/claim-5", "80.00", [{ group: "PR", code: "1", amount: "25.00" }]);
  const tasks = [
    worklistTask("era-denial", denied),
    worklistTask("era-underpayment", underpaid),
  ];

  const rows = projectClaimSearchResults({
    claims,
    responses: [rejected, denied, underpaid, paid],
    tasks,
    relatedResources: relatedResources(),
    at: AT,
  });
  const statusByClaim = Object.fromEntries(rows.map((row) => [row.claimReference, row.status]));

  assert.deepEqual(statusByClaim, {
    "Claim/claim-1": "submitted",
    "Claim/claim-2": "rejected",
    "Claim/claim-3": "denied",
    "Claim/claim-4": "underpaid",
    "Claim/claim-5": "paid",
  });
  const paidRow = rows.find((row) => row.claimReference === "Claim/claim-5");
  assert.equal(paidRow?.totalChargedCents, 12_500);
  assert.equal(paidRow?.insurancePaidCents, 8_000);
  assert.equal(paidRow?.patientResponsibilityCents, 2_500);
});

test("claim search filters real persisted Claim fields and resolved labels", () => {
  const claims = [claim(1), claim(2), claim(3)];
  const responses = [eraResponse("response-3", "Claim/claim-3", "80.00", [])];
  const base = {
    claims,
    responses,
    tasks: [] as Task[],
    relatedResources: relatedResources(),
    at: AT,
  };

  assert.deepEqual(
    projectClaimSearchResults({ ...base, filters: { patientReferences: new Set(["Patient/patient-2"]) } }).map((row) => row.claimReference),
    ["Claim/claim-2"],
  );
  assert.deepEqual(
    projectClaimSearchResults({ ...base, filters: { claim: "OSOD-CLAIM-1", status: "submitted" } }).map((row) => row.claimReference),
    ["Claim/claim-1"],
  );
  assert.deepEqual(
    projectClaimSearchResults({
      ...base,
      filters: { carrier: "Synthetic Health", office: "Main Office", cpt: "PROC-A", minAmountCents: 12_500, maxAmountCents: 12_500 },
    }).map((row) => row.claimReference),
    ["Claim/claim-1", "Claim/claim-2", "Claim/claim-3"],
  );
  assert.deepEqual(
    projectClaimSearchResults({
      ...base,
      filters: { minDaysOutstanding: 8, maxDaysOutstanding: 8 },
    }).map((row) => row.claimReference),
    ["Claim/claim-2"],
  );
  assert.deepEqual(
    projectClaimSearchResults({ ...base, filters: { outstandingOnly: true } }).map((row) => row.claimReference),
    ["Claim/claim-1", "Claim/claim-2"],
  );
});

test("a resolved claim-rejected Task remains the persistent rejected signal", () => {
  const ready = buildClaimRejectedWorklistTask({
    claimReference: "Claim/claim-1",
    patientReference: "Patient/patient-1",
    claimMdMessage: "Claim.MD transmission failed",
    authoredOn: AT,
  });
  const claimed = claimEraWorklistTask(ready, "Practitioner/staff-1", AT);
  const resolved = resolveEraWorklistTask(claimed, { disposition: "written-off" }, AT);
  const rows = projectClaimSearchResults({
    claims: [claim(1)],
    responses: [],
    tasks: [resolved],
    relatedResources: relatedResources(),
    at: AT,
  });

  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, "rejected");
});

function claim(number: number): Claim {
  const input: ProfessionalClaimInput = {
    created: `2026-07-0${number}`,
    serviceDate: `2026-06-0${number}`,
    patientReference: `Patient/patient-${number}`,
    providerReference: "Practitioner/provider-1",
    insurerReference: "Organization/payer-1",
    coverageReference: `Coverage/coverage-${number}`,
    patientAccountNumber: `OSOD-CLAIM-${number}`,
    payerId: "PAYERTEST",
    billingProvider: { name: "OSOD TEST CLINIC", npi: "1111111112" },
    renderingProvider: { firstName: "Alex", lastName: "Synthetic", npi: "1111111112" },
    subscriber: { firstName: "Jamie", lastName: "Synthetic", dateOfBirth: "1980-01-01", sex: "F" },
    patient: { firstName: "Jamie", lastName: "Synthetic", dateOfBirth: "1980-01-01", sex: "F" },
    diagnoses: [{ system: "https://osod.test/fhir/CodeSystem/diagnosis", code: "DX-A" }],
    facilityReference: "Location/main-office",
    chargeItems: [{
      resourceType: "ChargeItem",
      id: `charge-${number}`,
      status: "billable",
      subject: { reference: `Patient/patient-${number}` },
      code: { coding: [{ system: "https://osod.test/fhir/CodeSystem/procedure", code: "PROC-A" }] },
      priceOverride: { value: 125, currency: "USD" },
    }],
  };
  return { ...buildProfessionalClaim(input), id: `claim-${number}` };
}

function statusResponse(id: string, claimReference: string, message: string): ClaimResponse {
  return {
    ...buildClaimResponseFromClaimMdStatus({
      claimReference,
      patientReference: claimReference.replace("Claim/claim-", "Patient/patient-"),
      insurerReference: "Organization/payer-1",
      created: AT,
      status: { result: { claim: { status_code: "4", messages: { message } } } },
    }),
    id,
  };
}

function eraResponse(
  id: string,
  claimReference: string,
  totalPaid: string,
  adjustments: Array<{ group: string; code: string; amount: string }>,
): ClaimResponse {
  const eraClaim: ClaimMdEraClaim = {
    pcn: claimReference,
    total_charge: "125.00",
    total_paid: totalPaid,
    status_code: "1",
    charge: [{ proc_code: "PROC-A", charge: "125.00", allowed: "100.00", paid: totalPaid, adjustment: adjustments }],
  };
  return {
    ...buildClaimResponseFromClaimMdEra({
      claimReference,
      patientReference: claimReference.replace("Claim/claim-", "Patient/patient-"),
      insurerReference: "Organization/payer-1",
      created: AT,
      era: { eraid: id, paid_date: "2026-07-10", payer_name: "Synthetic Health", claim: eraClaim },
    }),
    id,
  };
}

function worklistTask(code: "era-denial" | "era-underpayment", response: ClaimResponse): Task {
  const claimReference = response.request?.reference ?? "";
  const eraClaim: ClaimMdEraClaim = {
    pcn: claimReference,
    total_charge: "125.00",
    total_paid: String(response.payment?.amount?.value ?? 0),
    charge: [{ charge: "125.00", allowed: "100.00", paid: String(response.payment?.amount?.value ?? 0) }],
  };
  return buildEraWorklistTask({
    code,
    era: { eraid: response.id, claim: eraClaim },
    eraClaim,
    claimResponseReference: `ClaimResponse/${response.id}`,
    patientReference: claimReference.replace("Claim/claim-", "Patient/patient-"),
    authoredOn: AT,
  });
}

function relatedResources(): Resource[] {
  return [
    ...[1, 2, 3, 4, 5].map((number) => ({
      resourceType: "Patient" as const,
      id: `patient-${number}`,
      name: [{ given: ["Jamie"], family: `Synthetic ${number}` }],
    })),
    { resourceType: "Practitioner", id: "provider-1", name: [{ given: ["Alex"], family: "Synthetic" }] },
    { resourceType: "Organization", id: "payer-1", name: "Synthetic Health" },
    { resourceType: "Location", id: "main-office", status: "active", name: "Main Office" },
  ];
}
