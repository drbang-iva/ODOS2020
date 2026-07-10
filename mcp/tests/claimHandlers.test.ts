import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";
import type {
  Basic,
  Bundle,
  Claim,
  ClaimResponse,
  CoverageEligibilityRequest,
  CoverageEligibilityResponse,
  PaymentReconciliation,
  Resource,
  Task,
} from "@medplum/fhirtypes";
import { OSOD_AUDIT_EVENT_TYPES, type OsodAuditEventRecord } from "../src/authz/osodAudit.js";
import { assertBusinessActionAllowed } from "../src/authz/roles.js";
import {
  handleClaimEraWorklistTaskRequest,
  handleClaimStatusRequest,
  handleEligibilityCheckRequest,
  handleEraImportRequest,
  handleEraListRequest,
  handleEraWorklistRequest,
  handleResolveEraWorklistTaskRequest,
  handleSubmitClaimRequest,
  type ClaimsHandlerDeps,
} from "../src/claims/claimmd-handlers.js";
import {
  CLAIM_REJECTED_CODE_SYSTEM,
  ERA_WORKLIST_CODE_SYSTEM,
  ERA_WORKLIST_INPUT_SYSTEM,
  ERA_WORKLIST_OUTPUT_SYSTEM,
  eraSnapshotFromTask,
  parseEraImportRecord,
} from "../src/claims/era-worklist.js";
import type { ClaimMdEraData, ProfessionalClaimInput } from "../src/claims/claimmd-fhir.js";

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
  let searchCalls = 0;
  const created = {
    Basic: [] as Basic[],
    Claim: [] as Claim[],
    ClaimResponse: [] as ClaimResponse[],
    CoverageEligibilityRequest: [] as CoverageEligibilityRequest[],
    CoverageEligibilityResponse: [] as CoverageEligibilityResponse[],
    PaymentReconciliation: [] as PaymentReconciliation[],
    Task: [] as Task[],
  };
  let claimCreateError: Error | undefined;
  const fhir = {
    create: async <T extends Resource>(resource: T): Promise<T> => {
      if (resource.resourceType === "Claim" && claimCreateError) throw claimCreateError;
      const resources = created[resource.resourceType as keyof typeof created] as Resource[] | undefined;
      if (!resources) throw new Error(`Unexpected test resource ${resource.resourceType}`);
      const id = `${resource.resourceType.toLowerCase()}-${resources.length + 1}`;
      const saved = { ...resource, id } as T;
      resources.push(saved);
      return saved;
    },
    read: async <T extends Resource>(resourceType: T["resourceType"], id: string): Promise<T> => {
      const resources = created[resourceType as keyof typeof created] as Resource[] | undefined;
      const found = resources?.find((resource) => resource.id === id);
      if (!found) throw new Error(`${resourceType}/${id} not found`);
      return found as T;
    },
    search: async <T extends Resource>(
      resourceType: T["resourceType"],
      params: Record<string, string> = {},
    ): Promise<Bundle<T>> => {
      searchCalls += 1;
      const resources = created[resourceType as keyof typeof created] as Resource[] | undefined;
      const filtered = (resources ?? []).filter((resource) => matchesSearch(resource, params));
      return {
        resourceType: "Bundle",
        type: "searchset",
        entry: filtered.map((resource) => ({ resource: resource as T })),
      };
    },
    update: async <T extends Resource>(resourceType: T["resourceType"], id: string, resource: T): Promise<T> => {
      const resources = created[resourceType as keyof typeof created] as Resource[] | undefined;
      const index = resources?.findIndex((candidate) => candidate.id === id) ?? -1;
      if (!resources || index < 0) throw new Error(`${resourceType}/${id} not found`);
      const saved = { ...resource, id } as T;
      resources[index] = saved;
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
      listEras: async () => ({
        result: {
          era: [{
            eraid: "era-900",
            payer_name: "SYNTHETIC PAYER",
            paid_date: "2026-07-09",
            paid_amount: "80.00",
          }],
        },
      }),
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
          charge: [{ chgid: "charge-1", proc_code: "PROC-A", charge: "125.00", allowed: "80.00", paid: "80.00" }],
        },
      }),
    },
    recordAudit: async (row) => {
      audits.push(row);
    },
    now: () => "2026-07-09T12:00:00.000Z",
  };
  return {
    audits,
    created,
    deps: base,
    searchCalls: () => searchCalls,
    failClaimCreate: (error: Error) => {
      claimCreateError = error;
    },
  };
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

test("claim status error creates a claim-rejected Task with Claim focus and verbatim message", async () => {
  const { audits, created, deps: d } = deps();
  const message = "A7: claim rejected by synthetic payer edit";
  d.adapter!.checkClaimStatus = async () => ({
    result: {
      claim: {
        claimid: "claimmd-1",
        status_code: "4",
        messages: { message },
      },
    },
  });

  const res = await handleClaimStatusRequest(d, {
    authHeader: "Bearer good",
    params: { id: "claim-1" },
    body: {
      claimMdClaimId: "claimmd-1",
      patientReference: "Patient/pat-900",
      insurerReference: "Organization/payer-1",
    },
  });

  assert.equal(res.status, 200);
  assert.equal(created.ClaimResponse[0].outcome, "error");
  assert.equal(created.Task.length, 1);
  assert.equal(worklistCode(created.Task[0]), "claim-rejected");
  assert.equal(created.Task[0].focus?.reference, "Claim/claim-1");
  assert.equal(taskInput(created.Task[0], "claimmd-message")?.valueString, message);
  assert.equal(audits.some((row) => row.eventType === "claim.rejected.flagged"), true);
  const worklist = await handleEraWorklistRequest(d, { authHeader: "Bearer good" });
  const item = (worklist.body as { items: Array<{ code: string; evidence: { claimMdMessage?: string } }> }).items[0];
  assert.equal(item.code, "claim-rejected");
  assert.equal(item.evidence.claimMdMessage, message);
});

test("ERA clean-paid claim preserves auto-post behavior and creates zero worklist Tasks", async () => {
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
  assert.deepEqual(
    pickCounts(res.body),
    { posted: 1, denied: 0, underpaid: 0, flagged: 0, taskIds: [] },
  );
  assert.equal(created.ClaimResponse.length, 1);
  assert.equal(created.PaymentReconciliation.length, 1);
  assert.equal(created.Task.length, 0);
  assert.equal(created.Basic.length, 1);
  assert.deepEqual(parseEraImportRecord(created.Basic[0]), {
    eraId: "era-900",
    summary: {
      importedAt: "2026-07-09T12:00:00.000Z",
      posted: 1,
      denied: 0,
      underpaid: 0,
      flagged: 0,
      payerName: "SYNTHETIC PAYER",
      paidDate: "2026-07-09",
      paidTotalCents: 8_000,
    },
  });
  assert.equal(created.PaymentReconciliation[0].detail?.[0]?.request?.reference, "Claim/claim-1");
  assert.equal(created.PaymentReconciliation[0].detail?.[0]?.response?.reference, "ClaimResponse/claimresponse-1");
  assert.equal(audits[0].eventType, "era.import.completed");

  const batches = await handleEraListRequest(d, { authHeader: "Bearer good" });
  assert.deepEqual(batches, {
    status: 200,
    body: {
      items: [{
        eraId: "era-900",
        lane: "fully-worked",
        importedAt: "2026-07-09T12:00:00.000Z",
        posted: 1,
        denied: 0,
        underpaid: 0,
        flagged: 0,
        claimCount: 1,
        payerName: "SYNTHETIC PAYER",
        paidDate: "2026-07-09",
        paidTotalCents: 8_000,
        openTaskCount: 0,
      }],
    },
  });
});

test("re-import updates the same ERA Basic record instead of creating a duplicate", async () => {
  const { created, deps: d } = deps();
  const first = await handleEraImportRequest(d, { authHeader: "Bearer good", body: eraImportBody() });
  const second = await handleEraImportRequest(d, { authHeader: "Bearer good", body: eraImportBody() });

  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.equal(created.Basic.length, 1);
  assert.equal(created.Basic[0].id, "basic-1");
  assert.equal(parseEraImportRecord(created.Basic[0]).summary.posted, 1);
});

test("an eralist row with no import record is returned in the New lane without inventing a claim count", async () => {
  const { deps: d } = deps();
  const result = await handleEraListRequest(d, { authHeader: "Bearer good" });
  const item = (result.body as { items: Array<Record<string, unknown>> }).items[0];

  assert.equal(result.status, 200);
  assert.equal(item.lane, "new");
  assert.equal(item.eraId, "era-900");
  assert.equal(item.paidTotalCents, 8_000);
  assert.equal("claimCount" in item, false);
});

test("ERA matched zero-pay claim creates a denial Task with verbatim adjustment pairs and audit", async () => {
  const { audits, created, deps: d } = deps();
  d.adapter!.retrieveEraData = async () => ({
    eraid: "era-900",
    paid_date: "2026-07-09",
    payer_name: "SYNTHETIC PAYER",
    claim: {
      pcn: "OSOD-CLAIM-900",
      payer_icn: "ICN-ZERO",
      total_charge: "125.00",
      total_paid: "0.00",
      status_code: "1",
      charge: [{
        chgid: "charge-1",
        proc_code: "PROC-A",
        charge: "125.00",
        allowed: "100.00",
        paid: "0.00",
        adjustment: [{ group: "CO", code: "45", amount: "25.00" }, { group: "OA", code: "23", amount: "100.00" }],
      }],
    },
  });

  const res = await handleEraImportRequest(d, {
    authHeader: "Bearer good",
    body: eraImportBody(),
  });

  assert.equal(res.status, 200);
  assert.deepEqual(
    pickCounts(res.body),
    { posted: 0, denied: 1, underpaid: 0, flagged: 0, taskIds: ["task-1"] },
  );
  assert.equal(created.ClaimResponse.length, 1);
  assert.equal(created.PaymentReconciliation.length, 0);
  assert.equal(created.Task.length, 1);
  const task = created.Task[0];
  assert.equal(worklistCode(task), "era-denial");
  assert.deepEqual(task.groupIdentifier, {
    system: "https://osod.dev/fhir/NamingSystem/claimmd-era",
    value: "era-900",
  });
  assert.equal(task.focus?.reference, "ClaimResponse/claimresponse-1");
  assert.equal(task.for?.reference, "Patient/pat-900");
  assert.deepEqual(
    taskInputs(task, "adjustment-group-code").map((entry) => JSON.parse(entry.valueString!)),
    [{ group: "CO", code: "45" }, { group: "OA", code: "23" }],
  );
  assert.equal(audits.some((row) => row.eventType === "era.denial.flagged" && row.resourceType === "Task"), true);

  d.adapter!.listEras = async () => ({
    result: { era: [{ eraid: "era-900", payer_name: "SYNTHETIC PAYER", paid_date: "2026-07-09", paid_amount: "0.00" }] },
  });
  const imported = await handleEraListRequest(d, { authHeader: "Bearer good" });
  assert.equal((imported.body as { items: Array<{ lane: string; openTaskCount: number }> }).items[0].lane, "imported");
  assert.equal((imported.body as { items: Array<{ lane: string; openTaskCount: number }> }).items[0].openTaskCount, 1);

  await handleClaimEraWorklistTaskRequest(d, { authHeader: "Bearer good", params: { id: "task-1" } });
  await handleResolveEraWorklistTaskRequest(d, {
    authHeader: "Bearer good",
    params: { id: "task-1" },
    body: { disposition: "written-off" },
  });
  const fullyWorked = await handleEraListRequest(d, { authHeader: "Bearer good" });
  assert.equal((fullyWorked.body as { items: Array<{ lane: string; openTaskCount: number }> }).items[0].lane, "fully-worked");
  assert.equal((fullyWorked.body as { items: Array<{ lane: string; openTaskCount: number }> }).items[0].openTaskCount, 0);
});

test("ERA underpayment posts moved money, creates a shortfall Task, and honors the configured threshold", async () => {
  const underpaidEra = {
    eraid: "era-underpaid",
    paid_date: "2026-07-09",
    payer_name: "SYNTHETIC PAYER",
    claim: {
      pcn: "OSOD-CLAIM-900",
      payer_icn: "ICN-UNDER",
      total_charge: "125.00",
      total_paid: "70.00",
      status_code: "1",
      charge: [{
        chgid: "charge-1",
        proc_code: "PROC-A",
        charge: "125.00",
        allowed: "100.00",
        paid: "70.00",
        adjustment: { group: "PR", code: "1", amount: "20.00" },
      }],
    },
  };
  const flagged = deps();
  flagged.deps.adapter!.retrieveEraData = async () => underpaidEra;

  const flaggedResult = await handleEraImportRequest(flagged.deps, {
    authHeader: "Bearer good",
    body: eraImportBody(),
  });

  assert.equal(flaggedResult.status, 200);
  assert.deepEqual(
    pickCounts(flaggedResult.body),
    { posted: 1, denied: 0, underpaid: 1, flagged: 0, taskIds: ["task-1"] },
  );
  assert.equal(flagged.created.PaymentReconciliation.length, 1);
  assert.equal(worklistCode(flagged.created.Task[0]), "era-underpayment");
  assert.equal(taskInput(flagged.created.Task[0], "shortfall-cents")?.valueInteger, 1_000);
  assert.equal(flagged.audits.some((row) => row.eventType === "era.underpayment.flagged"), true);

  const belowThreshold = deps();
  belowThreshold.deps.adapter!.retrieveEraData = async () => underpaidEra;
  belowThreshold.deps.eraUnderpaymentThresholdCents = 1_001;
  const belowResult = await handleEraImportRequest(belowThreshold.deps, {
    authHeader: "Bearer good",
    body: eraImportBody(),
  });

  assert.equal(belowResult.status, 200);
  assert.deepEqual(
    pickCounts(belowResult.body),
    { posted: 1, denied: 0, underpaid: 0, flagged: 0, taskIds: [] },
  );
  assert.equal(belowThreshold.created.PaymentReconciliation.length, 1);
  assert.equal(belowThreshold.created.Task.length, 0);
});

test("ERA unmatched PCN persists a fully recoverable unmatched Task snapshot", async () => {
  const { audits, created, deps: d } = deps();
  const era = await d.adapter!.retrieveEraData("era-900") as ClaimMdEraData;
  d.adapter!.retrieveEraData = async () => era;

  const res = await handleEraImportRequest(d, {
    authHeader: "Bearer good",
    body: { ...eraImportBody(), claimReferenceByPcn: {}, patientReferenceByPcn: {} },
  });

  assert.equal(res.status, 200);
  assert.deepEqual(
    pickCounts(res.body),
    { posted: 0, denied: 0, underpaid: 0, flagged: 1, taskIds: ["task-1"] },
  );
  assert.equal(created.ClaimResponse.length, 0);
  assert.equal(created.PaymentReconciliation.length, 0);
  assert.equal(created.Task.length, 1);
  const task = created.Task[0];
  assert.equal(worklistCode(task), "era-unmatched");
  assert.equal(task.focus, undefined);
  assert.equal(task.for, undefined);
  assert.equal(taskInput(task, "pcn")?.valueString, "OSOD-CLAIM-900");
  assert.equal(taskInput(task, "payer-icn")?.valueString, "ICN-900");
  assert.equal(taskInput(task, "charged-cents")?.valueInteger, 12_500);
  assert.equal(taskInput(task, "allowed-cents")?.valueInteger, 8_000);
  assert.equal(taskInput(task, "paid-cents")?.valueInteger, 8_000);
  assert.deepEqual(eraSnapshotFromTask(task).claim, era.claim);
  assert.equal(audits.some((row) => row.eventType === "era.unmatched.flagged"), true);
});

test("ERA worklist resolve-as-rebilled records the Claim reference and rejects missing disposition", async () => {
  const { created, deps: d } = deps();
  d.adapter!.retrieveEraData = async () => ({
    eraid: "era-zero",
    paid_date: "2026-07-09",
    claim: {
      pcn: "OSOD-CLAIM-900",
      payer_icn: "ICN-ZERO",
      total_charge: "125.00",
      total_paid: "0.00",
      charge: [{ charge: "125.00", allowed: "100.00", paid: "0.00" }],
    },
  });
  await handleEraImportRequest(d, { authHeader: "Bearer good", body: eraImportBody() });

  const claimed = await handleClaimEraWorklistTaskRequest(d, {
    authHeader: "Bearer good",
    params: { id: "task-1" },
  });
  assert.equal(claimed.status, 200);
  assert.equal(created.Task[0].owner?.reference, "Practitioner/staff-1");

  const missing = await handleResolveEraWorklistTaskRequest(d, {
    authHeader: "Bearer good",
    params: { id: "task-1" },
    body: {},
  });
  assert.deepEqual(missing, { status: 400, body: { error: "A coded resolution disposition is required." } });

  const resolved = await handleResolveEraWorklistTaskRequest(d, {
    authHeader: "Bearer good",
    params: { id: "task-1" },
    body: { disposition: "rebilled", claimReference: "Claim/claim-2" },
  });
  assert.equal(resolved.status, 200);
  assert.equal(created.Task[0].status, "completed");
  assert.equal(taskOutput(created.Task[0], "disposition")?.valueCode, "rebilled");
  assert.equal(taskOutput(created.Task[0], "claim-reference")?.valueReference?.reference, "Claim/claim-2");
});

test("claim-rejected uses the shared claim and resolve lifecycle with the same conflict semantics", async () => {
  const { created, deps: d } = deps();
  d.adapter!.submitProfessionalClaim = async () => {
    throw new Error("Claim.MD edit rejection R-17");
  };
  await handleSubmitClaimRequest(d, {
    authHeader: "Bearer good",
    body: { claim: professionalClaim },
  });

  const claimed = await handleClaimEraWorklistTaskRequest(d, {
    authHeader: "Bearer good",
    params: { id: "task-1" },
  });
  assert.equal(claimed.status, 200);
  assert.equal(created.Task[0].status, "in-progress");

  const duplicateClaim = await handleClaimEraWorklistTaskRequest(d, {
    authHeader: "Bearer good",
    params: { id: "task-1" },
  });
  assert.equal(duplicateClaim.status, 409);

  const missingDisposition = await handleResolveEraWorklistTaskRequest(d, {
    authHeader: "Bearer good",
    params: { id: "task-1" },
    body: {},
  });
  assert.equal(missingDisposition.status, 400);

  const resolved = await handleResolveEraWorklistTaskRequest(d, {
    authHeader: "Bearer good",
    params: { id: "task-1" },
    body: { disposition: "rebilled", claimReference: "Claim/claim-1" },
  });
  assert.equal(resolved.status, 200);
  assert.equal(taskOutput(created.Task[0], "disposition")?.valueCode, "rebilled");

  const duplicateResolve = await handleResolveEraWorklistTaskRequest(d, {
    authHeader: "Bearer good",
    params: { id: "task-1" },
    body: { disposition: "written-off" },
  });
  assert.equal(duplicateResolve.status, 409);
});

test("claim-rejected polling deduplicates only while the same Claim has an open Task", async () => {
  const { audits, created, deps: d } = deps();
  d.adapter!.checkClaimStatus = async () => ({
    result: { claim: { claimid: "claimmd-1", status_code: "4", messages: { message: "Rejected" } } },
  });
  const request = {
    authHeader: "Bearer good",
    params: { id: "claim-1" },
    body: {
      claimMdClaimId: "claimmd-1",
      patientReference: "Patient/pat-900",
      insurerReference: "Organization/payer-1",
    },
  };

  await handleClaimStatusRequest(d, request);
  await handleClaimStatusRequest(d, request);
  assert.equal(created.Task.length, 1);
  assert.equal(audits.filter((row) => row.eventType === "claim.rejected.flagged").length, 1);

  await handleClaimEraWorklistTaskRequest(d, { authHeader: "Bearer good", params: { id: "task-1" } });
  await handleResolveEraWorklistTaskRequest(d, {
    authHeader: "Bearer good",
    params: { id: "task-1" },
    body: { disposition: "written-off" },
  });
  await handleClaimStatusRequest(d, request);
  assert.equal(created.Task.length, 2);
  assert.equal(audits.filter((row) => row.eventType === "claim.rejected.flagged").length, 2);
});

test("ERA unmatched resolution validates in-review lifecycle before any matched re-import side effect", async () => {
  const { created, deps: d } = deps();
  await handleEraImportRequest(d, {
    authHeader: "Bearer good",
    body: { ...eraImportBody(), claimReferenceByPcn: {}, patientReferenceByPcn: {} },
  });

  const result = await handleResolveEraWorklistTaskRequest(d, {
    authHeader: "Bearer good",
    params: { id: "task-1" },
    body: {
      disposition: "matched",
      claimReference: "Claim/claim-1",
      patientReference: "Patient/pat-900",
      insurerReference: "Organization/payer-1",
    },
  });

  assert.deepEqual(result, { status: 409, body: { error: "Only an in-review ERA worklist Task can be resolved." } });
  assert.equal(created.ClaimResponse.length, 0);
  assert.equal(created.PaymentReconciliation.length, 0);
  assert.equal(created.Task.length, 1);
  assert.equal(created.Task[0].status, "ready");
});

test("claims.manage protects GET /claims/worklist with the existing claims 401/403 shapes", async () => {
  const unauthenticated = deps();
  const unauthorized = await handleEraWorklistRequest(unauthenticated.deps, {
    authHeader: undefined,
  });
  assert.deepEqual(unauthorized, {
    status: 401,
    body: { error: "Authentication required to manage claims." },
  });
  assert.equal(unauthenticated.searchCalls(), 0);

  const forbidden = deps("clinician");
  const denied = await handleEraWorklistRequest(forbidden.deps, {
    authHeader: "Bearer good",
  });
  assert.deepEqual(denied, {
    status: 403,
    body: { error: "claims.manage role required" },
  });
  assert.equal(forbidden.searchCalls(), 0);

  const allowed = deps();
  const ok = await handleEraWorklistRequest(allowed.deps, { authHeader: "Bearer good" });
  assert.deepEqual(ok, { status: 200, body: { items: [] } });
  assert.equal(allowed.searchCalls(), 1);
});

test("claims.manage protects GET /claims/era with the existing claims 401/403 shapes", async () => {
  const unauthenticated = deps();
  assert.deepEqual(await handleEraListRequest(unauthenticated.deps, { authHeader: undefined }), {
    status: 401,
    body: { error: "Authentication required to manage claims." },
  });
  assert.equal(unauthenticated.searchCalls(), 0);

  const forbidden = deps("clinician");
  assert.deepEqual(await handleEraListRequest(forbidden.deps, { authHeader: "Bearer good" }), {
    status: 403,
    body: { error: "claims.manage role required" },
  });
  assert.equal(forbidden.searchCalls(), 0);

  const unavailable = deps();
  unavailable.deps.adapter = null;
  assert.deepEqual(await handleEraListRequest(unavailable.deps, { authHeader: "Bearer good" }), {
    status: 503,
    body: { error: "Claim.MD adapter is not configured." },
  });
  assert.equal(unavailable.searchCalls(), 0);
});

test("claims audit migration drop-and-re-add constraint exactly matches the TypeScript event union", () => {
  const sql = readFileSync(
    resolve(process.cwd(), "../data/migrations/2026-07-09-claim-rejected-event.sql"),
    "utf8",
  );
  const dropIndex = sql.indexOf("DROP CONSTRAINT IF EXISTS osod_audit_events_event_type_check");
  const addIndex = sql.indexOf("ADD CONSTRAINT osod_audit_events_event_type_check CHECK");
  assert.ok(dropIndex >= 0);
  assert.ok(addIndex > dropIndex);
  const sqlTypes = [...sql.matchAll(/'([^']+)'/g)].map((match) => match[1]);
  assert.deepEqual(sqlTypes, [...OSOD_AUDIT_EVENT_TYPES]);
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
  assert.equal(created.Task.length, 1);
  assert.equal(created.Task[0].focus?.reference, "Claim/claim-1");
  assert.equal(taskInput(created.Task[0], "claimmd-message")?.valueString, `Claim.MD request failed with HTTP 502: ${phiToken}`);
  assert.equal(audits.length, 2);
  assert.equal(audits[0].eventType, "claim.submit.failed");
  assert.equal(audits[0].actionOutcome, "denied");
  assert.equal(audits[0].resourceType, "Claim");
  assert.equal(audits[0].resourceId, "claim-1");
  assert.equal(audits[0].patientId, "pat-900");
  assert.match(audits[0].actionReason ?? "", /submitProfessionalClaim/);
  assert.match(audits[0].actionReason ?? "", /HTTP 502/);
  assert.doesNotMatch(audits[0].actionReason ?? "", new RegExp(phiToken));
  assert.equal(audits[1].eventType, "claim.rejected.flagged");
});

test("Claim FHIR create failure returns the failure response without fabricating a focus", async () => {
  const fixture = deps();
  fixture.failClaimCreate(new Error("FHIR Claim create rejected the resource"));

  const res = await handleSubmitClaimRequest(fixture.deps, {
    authHeader: "Bearer good",
    body: { claim: professionalClaim },
  });

  assert.equal(res.status, 502);
  assert.equal(fixture.created.Claim.length, 0);
  assert.equal(fixture.created.Task.length, 1);
  assert.equal(fixture.created.Task[0].focus, undefined);
  assert.equal(worklistCode(fixture.created.Task[0]), "claim-rejected");
});

function eraImportBody(): Record<string, unknown> {
  return {
    eraId: "era-900",
    claimReferenceByPcn: { "OSOD-CLAIM-900": "Claim/claim-1" },
    patientReferenceByPcn: { "OSOD-CLAIM-900": "Patient/pat-900" },
    insurerReference: "Organization/payer-1",
    providerReference: "Practitioner/prov-1",
    practiceOrgReference: "Organization/practice-1",
  };
}

function pickCounts(body: unknown): {
  posted: number;
  denied: number;
  underpaid: number;
  flagged: number;
  taskIds: string[];
} {
  const result = body as {
    posted: number;
    denied: number;
    underpaid: number;
    flagged: number;
    taskIds: string[];
  };
  return {
    posted: result.posted,
    denied: result.denied,
    underpaid: result.underpaid,
    flagged: result.flagged,
    taskIds: result.taskIds,
  };
}

function worklistCode(task: Task): string | undefined {
  return task.code?.coding?.find((coding) =>
    coding.system === ERA_WORKLIST_CODE_SYSTEM || coding.system === CLAIM_REJECTED_CODE_SYSTEM,
  )?.code;
}

function taskInputs(task: Task, code: string): NonNullable<Task["input"]> {
  return (task.input ?? []).filter((entry) =>
    entry.type.coding?.some((coding) => coding.system === ERA_WORKLIST_INPUT_SYSTEM && coding.code === code),
  );
}

function taskInput(task: Task, code: string): NonNullable<Task["input"]>[number] | undefined {
  return taskInputs(task, code)[0];
}

function taskOutput(task: Task, code: string): NonNullable<Task["output"]>[number] | undefined {
  return task.output?.find((entry) =>
    entry.type.coding?.some((coding) => coding.system === ERA_WORKLIST_OUTPUT_SYSTEM && coding.code === code),
  );
}

function matchesSearch(resource: Resource, params: Record<string, string>): boolean {
  if (resource.resourceType === "Basic") {
    const basic = resource as Basic;
    if (params.code && !matchesCodingToken(basic.code?.coding, params.code)) return false;
    if (params.identifier && !matchesIdentifierToken(basic.identifier, params.identifier)) return false;
  }
  if (resource.resourceType === "Task") {
    const task = resource as Task;
    if (params.code && !matchesCodingToken(task.code?.coding, params.code)) return false;
    if (params.focus && task.focus?.reference !== params.focus) return false;
    if (params["business-status"] && !matchesCodingToken(task.businessStatus?.coding, params["business-status"])) return false;
  }
  return true;
}

function matchesCodingToken(
  codings: Array<{ system?: string; code?: string }> | undefined,
  token: string,
): boolean {
  return token.split(",").some((candidate) => {
    const [system, code] = candidate.split("|");
    return codings?.some((coding) => coding.system === system && (!code || coding.code === code));
  });
}

function matchesIdentifierToken(
  identifiers: Array<{ system?: string; value?: string }> | undefined,
  token: string,
): boolean {
  const separator = token.indexOf("|");
  const system = token.slice(0, separator);
  const value = token.slice(separator + 1);
  return identifiers?.some((identifier) => identifier.system === system && identifier.value === value) ?? false;
}
