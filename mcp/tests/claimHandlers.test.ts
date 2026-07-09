import assert from "node:assert/strict";
import { test } from "node:test";
import type { Claim, ClaimResponse, CoverageEligibilityRequest, CoverageEligibilityResponse, PaymentReconciliation } from "@medplum/fhirtypes";
import type { OsodAuditEventRecord } from "../src/authz/osodAudit.js";
import { assertBusinessActionAllowed } from "../src/authz/roles.js";
import {
  handleClaimStatusRequest,
  handleEligibilityCheckRequest,
  handleEraImportRequest,
  handleSubmitClaimRequest,
  type ClaimsHandlerDeps,
} from "../src/claims/claimmd-handlers.js";
import type { ProfessionalClaimInput } from "../src/claims/claimmd-fhir.js";

const professionalClaim: ProfessionalClaimInput = {
  created: "2026-07-09",
  serviceDate: "2026-07-09",
  patientReference: "Patient/pat-900",
  providerReference: "Practitioner/prov-1",
  insurerReference: "Organization/payer-1",
  coverageReference: "Coverage/cov-1",
  patientAccountNumber: "OSOD-CLAIM-900",
  payerId: "PAYERTEST",
  billingProvider: { name: "OSOD TEST CLINIC", npi: "1111111112", taxId: "900000001", taxIdType: "E" },
  renderingProvider: { firstName: "ALEX", lastName: "SYNTHETIC", npi: "1111111112" },
  subscriber: {
    firstName: "JAMIE",
    lastName: "SYNTHETIC",
    memberId: "TEST-900",
    dateOfBirth: "1980-01-01",
    sex: "F",
    relationshipCode: "18",
  },
  patient: { firstName: "JAMIE", lastName: "SYNTHETIC", dateOfBirth: "1980-01-01", sex: "F" },
  diagnoses: [{ system: "https://osod.test/fhir/CodeSystem/synthetic-diagnosis", code: "DX-A" }],
  chargeItems: [
    {
      resourceType: "ChargeItem",
      id: "charge-1",
      status: "billable",
      subject: { reference: "Patient/pat-900" },
      code: { coding: [{ system: "https://osod.test/fhir/CodeSystem/synthetic-procedure", code: "PROC-A" }] },
      priceOverride: { value: 125, currency: "USD" },
    },
  ],
};

function deps(role: "front-desk" | "clinician" = "front-desk") {
  const audits: OsodAuditEventRecord[] = [];
  const created = {
    Claim: [] as Claim[],
    ClaimResponse: [] as ClaimResponse[],
    CoverageEligibilityRequest: [] as CoverageEligibilityRequest[],
    CoverageEligibilityResponse: [] as CoverageEligibilityResponse[],
    PaymentReconciliation: [] as PaymentReconciliation[],
  };
  const fhir = {
    create: async <T extends { resourceType: keyof typeof created }>(resource: T): Promise<T> => {
      const id = `${resource.resourceType.toLowerCase()}-${created[resource.resourceType].length + 1}`;
      const saved = { ...resource, id } as T;
      created[resource.resourceType].push(saved as never);
      return saved;
    },
  };
  const base: ClaimsHandlerDeps = {
    authenticate: async (authHeader) =>
      authHeader === "Bearer good"
        ? { staffReference: "Practitioner/staff-1", actorRole: role, fhir }
        : null,
    adapter: {
      submitProfessionalClaim: async () => ({
        claims: [{ claimMdClaimId: "claimmd-1", claimMdId: "tracking-1", status: "A" }],
        raw: {},
      }),
      checkEligibility: async () => ({
        result: {
          elig: {
            eligid: "elig-900",
            benefit: [
              { benefit_coverage_code: "1", benefit_coverage_description: "Active Coverage" },
              { benefit_coverage_code: "B", benefit_coverage_description: "Co-Payment", benefit_amount: "25.00" },
            ],
          },
        },
      }),
      checkClaimStatus: async () => ({
        result: {
          claim: {
            claimid: "claimmd-1",
            claimmd_id: "tracking-1",
            status: "A",
            messages: { message: "STATUS - Finalized/Payment-The claim/line has been paid." },
          },
        },
      }),
      listEras: async () => ({ result: { era: [{ eraid: "era-900" }] } }),
      retrieveEraData: async () => ({
        eraid: "era-900",
        paid_date: "2026-07-09",
        payer_name: "SYNTHETIC PAYER",
        claim: {
          pcn: "OSOD-CLAIM-900",
          payer_icn: "ICN-900",
          total_charge: "125.00",
          total_paid: "80.00",
          status_code: "1",
          charge: [{ chgid: "charge-1", proc_code: "PROC-A", charge: "125.00", allowed: "100.00", paid: "80.00" }],
        },
      }),
    },
    recordAudit: async (row) => {
      audits.push(row);
    },
    now: () => "2026-07-09T12:00:00.000Z",
  };
  return { audits, created, deps: base };
}

test("front-desk and practice-admin hold claims.manage; non-billing roles do not", () => {
  assertBusinessActionAllowed("front-desk", "claims.manage");
  assertBusinessActionAllowed("practice-admin", "claims.manage");
  assert.throws(() => assertBusinessActionAllowed("clinician", "claims.manage"), /claims\.manage/);
});

test("submit claim creates the Claim, calls Claim.MD, and audits claim.submit.completed", async () => {
  const { audits, created, deps: d } = deps();
  const res = await handleSubmitClaimRequest(d, {
    authHeader: "Bearer good",
    body: { claim: professionalClaim },
  });

  assert.equal(res.status, 200);
  assert.equal(created.Claim.length, 1);
  assert.equal((res.body as { claimId: string }).claimId, "claim-1");
  assert.equal((res.body as { claimMdTrackingNumber: string }).claimMdTrackingNumber, "tracking-1");
  assert.equal(audits[0].eventType, "claim.submit.completed");
  assert.equal(audits[0].resourceType, "Claim");
});

test("eligibility check creates request/response resources and audits eligibility.check.completed", async () => {
  const { audits, created, deps: d } = deps();
  const res = await handleEligibilityCheckRequest(d, {
    authHeader: "Bearer good",
    body: {
      patientReference: "Patient/pat-900",
      coverageReference: "Coverage/cov-1",
      insurerReference: "Organization/payer-1",
      providerReference: "Practitioner/prov-1",
      serviceDate: "2026-07-09",
      claimMd: {
        ins_name_l: "SYNTHETIC",
        ins_name_f: "JAMIE",
        payerid: "PAYERTEST",
        pat_rel: "18",
        fdos: "20260709",
        prov_npi: "1111111112",
        prov_taxid: "900000001",
      },
    },
  });

  assert.equal(res.status, 200);
  assert.equal(created.CoverageEligibilityRequest.length, 1);
  assert.equal(created.CoverageEligibilityResponse.length, 1);
  assert.equal(audits[0].eventType, "eligibility.check.completed");
});

test("claim status check returns a ClaimResponse projection and audits claim.status.checked", async () => {
  const { audits, created, deps: d } = deps();
  const res = await handleClaimStatusRequest(d, {
    authHeader: "Bearer good",
    params: { id: "claim-1" },
    body: {
      claimMdClaimId: "claimmd-1",
      patientReference: "Patient/pat-900",
      insurerReference: "Organization/payer-1",
      providerReference: "Practitioner/prov-1",
    },
  });

  assert.equal(res.status, 200);
  assert.equal(created.ClaimResponse.length, 1);
  assert.equal(audits[0].eventType, "claim.status.checked");
});

test("ERA import auto-posts matched claims and flags unmatched lines for review", async () => {
  const { audits, created, deps: d } = deps();
  const res = await handleEraImportRequest(d, {
    authHeader: "Bearer good",
    body: {
      eraId: "era-900",
      claimReferenceByPcn: { "OSOD-CLAIM-900": "Claim/claim-1" },
      patientReferenceByPcn: { "OSOD-CLAIM-900": "Patient/pat-900" },
      insurerReference: "Organization/payer-1",
      providerReference: "Practitioner/prov-1",
      practiceOrgReference: "Organization/practice-1",
    },
  });

  assert.equal(res.status, 200);
  assert.equal((res.body as { posted: number; flagged: number }).posted, 1);
  assert.equal((res.body as { posted: number; flagged: number }).flagged, 0);
  assert.equal(created.ClaimResponse.length, 1);
  assert.equal(created.PaymentReconciliation.length, 1);
  assert.equal(created.PaymentReconciliation[0].detail?.[0]?.request?.reference, "Claim/claim-1");
  assert.equal(created.PaymentReconciliation[0].detail?.[0]?.response?.reference, "ClaimResponse/claimresponse-1");
  assert.equal(audits[0].eventType, "era.import.completed");
});

test("claims.manage denial happens before adapter calls or audit writes", async () => {
  const { audits, deps: d } = deps("clinician");
  let called = false;
  d.adapter.submitProfessionalClaim = async () => {
    called = true;
    return { claims: [], raw: {} };
  };
  const res = await handleSubmitClaimRequest(d, {
    authHeader: "Bearer good",
    body: { claim: professionalClaim },
  });
  assert.equal(res.status, 403);
  assert.equal(called, false);
  assert.equal(audits.length, 0);
});

test("Claim.MD adapter failures audit a sanitized reason without response-body PHI", async () => {
  const { audits, created, deps: d } = deps();
  const phiToken = "MEMBER=JANE DOE";
  d.adapter.submitProfessionalClaim = async () => {
    throw new Error(`Claim.MD request failed with HTTP 502: ${phiToken}`);
  };

  const res = await handleSubmitClaimRequest(d, {
    authHeader: "Bearer good",
    body: { claim: professionalClaim },
  });

  assert.equal(res.status, 502);
  assert.match((res.body as { error: string }).error, new RegExp(phiToken));
  assert.equal(created.Claim.length, 1);
  assert.equal(audits.length, 1);
  assert.equal(audits[0].eventType, "claim.submit.failed");
  assert.equal(audits[0].actionOutcome, "denied");
  assert.equal(audits[0].resourceType, "Claim");
  assert.equal(audits[0].resourceId, "claim-1");
  assert.equal(audits[0].patientId, "pat-900");
  assert.match(audits[0].actionReason ?? "", /submitProfessionalClaim/);
  assert.match(audits[0].actionReason ?? "", /HTTP 502/);
  assert.doesNotMatch(audits[0].actionReason ?? "", new RegExp(phiToken));
});
