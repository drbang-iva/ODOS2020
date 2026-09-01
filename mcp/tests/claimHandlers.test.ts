import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";
import type {
  Basic,
  Bundle,
  ChargeItem,
  Claim,
  ClaimResponse,
  Coverage,
  CoverageEligibilityRequest,
  CoverageEligibilityResponse,
  Encounter,
  Invoice,
  Patient,
  PaymentReconciliation,
  Resource,
  Task,
} from "@medplum/fhirtypes";
import type { OdosAuditEventRecord } from "../src/authz/odosAudit.js";
import * as claimHandlers from "../src/claims/claimmd-handlers.js";
import { assertBusinessActionAllowed } from "../src/authz/roles.js";
import { StaffRoleServiceUnavailableError } from "../src/payments/payment-endpoint.js";
import {
  CLAIMMD_ERA_PAYMENT_SYSTEM,
  STEDI_ERA_PAYMENT_SYSTEM,
} from "../src/payments/payment-reconciliation.js";
import {
  handleClaimEraWorklistTaskRequest,
  handleClaimStatusRequest,
  handleCloseManualEobRequest,
  handleCreateManualEobRequest,
  handleEligibilityCheckRequest,
  handleEraImportRequest,
  handleEraListRequest,
  handleEraWorklistRequest,
  handleManualEobListRequest,
  handlePostManualEobClaimRequest,
  handleResolveEraWorklistTaskRequest,
  handleStediClaimResubmissionPreviewRequest,
  handleStediClaimResubmissionRequest,
  handleSubmitClaimRequest,
  handleStedi277ImportRequest,
  handleClaimDraftRequest,
  type ClaimsHandlerDeps,
} from "../src/claims/claimmd-handlers.js";
import { chargeItemBodysite } from "../src/fhir/charge-item-laterality.js";
import {
  CLAIM_REJECTED_CODE_SYSTEM,
  ERA_WORKLIST_CODE_SYSTEM,
  ERA_WORKLIST_INPUT_SYSTEM,
  ERA_WORKLIST_OUTPUT_SYSTEM,
  eraSnapshotFromTask,
  eraWorklistEvidence,
  parseEraImportRecord,
  projectEraWorklistTask,
} from "../src/claims/era-worklist.js";
import {
  buildClaimResponseFromClaimMdEra,
  buildProfessionalClaim,
  ODOS_CLAIM_CHARGE_ITEM_EXTENSION_URL,
  type ClaimMdEraData,
  type ProfessionalClaimInput,
} from "../src/claims/claimmd-fhir.js";
import {
  PROVIDER_ADJUSTMENT_CODE,
  REMITTANCE_BATCH_CODE,
  appendRemittanceAllocation,
  buildProviderAdjustment,
  buildRemittanceBatch,
  parseManualEobHeader,
  parseProviderAdjustment,
  parseRemittanceBatch,
  projectRemittanceBatch,
} from "../src/claims/manual-eob.js";
import {
  buildPatientResponsibilityInvoice,
  ODOS_SOURCE_CLAIM_EXTENSION_URL,
} from "../src/claims/patient-responsibility-invoice.js";
import { StediRequestError } from "../src/claims/stedi-adapter.js";
import { claimTouchState } from "../src/claims/claim-touch-ledger.js";
import { withStediClaimInputSnapshot } from "../src/claims/stedi-fhir.js";
import { handleGeneratePatientStatementRequest, type StatementRunResult } from "../src/statements/statements.js";

const professionalClaim: ProfessionalClaimInput = {
  created: "2026-07-09",
  serviceDate: "2026-07-09",
  patientReference: "Patient/pat-900",
  providerReference: "Practitioner/prov-1",
  insurerReference: "Organization/payer-1",
  coverageReference: "Coverage/cov-1",
  patientAccountNumber: "ODOS-CLAIM-900",
  payerId: "PAYERTEST",
  billingProvider: {
    name: "ODOS TEST CLINIC",
    npi: "1111111112",
    taxId: "900000001",
    taxIdType: "E",
    address1: "900 TEST AVE",
    city: "TESTVILLE",
    state: "NY",
    zip: "100010000",
    phone: "5555550100",
  },
  renderingProvider: { firstName: "ALEX", lastName: "SYNTHETIC", npi: "1111111112" },
  subscriber: {
    firstName: "JAMIE",
    lastName: "SYNTHETIC",
    memberId: "TEST-900",
    dateOfBirth: "1980-01-01",
    sex: "F",
    relationshipCode: "18",
    address1: "901 TEST AVE",
    city: "TESTVILLE",
    state: "NY",
    zip: "100010001",
  },
  patient: { firstName: "JAMIE", lastName: "SYNTHETIC", dateOfBirth: "1980-01-01", sex: "F" },
  diagnoses: [{ system: "https://odos.test/fhir/CodeSystem/synthetic-diagnosis", code: "DX-A" }],
  chargeItems: [
    {
      resourceType: "ChargeItem",
      id: "charge-1",
      status: "billable",
      subject: { reference: "Patient/pat-900" },
      code: { coding: [{ system: "https://odos.test/fhir/CodeSystem/synthetic-procedure", code: "PROC-A" }] },
      priceOverride: { value: 125, currency: "USD" },
    },
  ],
};

function deps(role: "staff" | "provider" = "staff") {
  const audits: OdosAuditEventRecord[] = [];
  const createHeaders: Array<{ resourceType: string; headers?: Record<string, string> }> = [];
  let searchCalls = 0;
  const created = {
    Basic: [] as Basic[],
    ChargeItem: [structuredClone(professionalClaim.chargeItems[0])] as ChargeItem[],
    Claim: [] as Claim[],
    ClaimResponse: [] as ClaimResponse[],
    Communication: [] as Resource[],
    Coverage: [{
      resourceType: "Coverage",
      id: "cov-1",
      status: "active",
      beneficiary: { reference: "Patient/pat-900" },
      order: 1,
      payor: [{ reference: "Organization/payer-1", identifier: { value: "PAYERTEST" } }],
    }] as Coverage[],
    CoverageEligibilityRequest: [] as CoverageEligibilityRequest[],
    CoverageEligibilityResponse: [] as CoverageEligibilityResponse[],
    Encounter: [{
      resourceType: "Encounter",
      id: "enc-1",
      status: "finished",
      class: {},
      subject: { reference: "Patient/pat-900" },
      period: { start: "2026-07-09T09:00:00.000Z" },
    }] as Encounter[],
    Invoice: [] as Invoice[],
    Patient: [] as Patient[],
    PaymentReconciliation: [] as PaymentReconciliation[],
    Provenance: [] as Resource[],
    Task: [] as Task[],
  };
  let claimCreateError: Error | undefined;
  const fhir = {
    create: async <T extends Resource>(resource: T, headers?: Record<string, string>): Promise<T> => {
      createHeaders.push({ resourceType: resource.resourceType, headers });
      const resources = created[resource.resourceType as keyof typeof created] as Resource[] | undefined;
      if (!resources) throw new Error(`Unexpected test resource ${resource.resourceType}`);
      const conditionalIdentifier = headers?.["If-None-Exist"]?.match(/^identifier=([^|]+)\|(.+)$/);
      if (conditionalIdentifier) {
        const existing = resources.find((candidate) => matchesIdentifierToken(
          "identifier" in candidate ? candidate.identifier as Array<{ system?: string; value?: string }> : undefined,
          `${conditionalIdentifier[1]}|${conditionalIdentifier[2]}`,
        ));
        if (existing) return existing as T;
      }
      if (resource.resourceType === "Claim" && claimCreateError) {
        const error = claimCreateError;
        claimCreateError = undefined;
        throw error;
      }
      const id = `${resource.resourceType.toLowerCase()}-${resources.length + 1}`;
      const saved = {
        ...resource,
        id,
        ...(resource.resourceType === "Basic"
          ? { meta: { ...resource.meta, versionId: "1" } }
          : {}),
      } as T;
      resources.push(saved);
      return saved;
    },
    read: async <T extends Resource>(resourceType: T["resourceType"], id: string): Promise<T> => {
      const resources = created[resourceType as keyof typeof created] as Resource[] | undefined;
      const found = resources?.find((resource) => resource.id === id);
      if (!found) throw Object.assign(new Error(`${resourceType}/${id} not found`), { status: 404 });
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
    update: async <T extends Resource>(
      resourceType: T["resourceType"],
      id: string,
      resource: T,
      headers?: Record<string, string>,
    ): Promise<T> => {
      const resources = created[resourceType as keyof typeof created] as Resource[] | undefined;
      const index = resources?.findIndex((candidate) => candidate.id === id) ?? -1;
      if (!resources || index < 0) throw new Error(`${resourceType}/${id} not found`);
      const current = resources[index];
      const versionId = current.meta?.versionId;
      if (headers?.["If-Match"] && headers["If-Match"] !== `W/"${versionId}"`) {
        throw Object.assign(new Error("FHIR 412 Precondition Failed"), { status: 412 });
      }
      const saved = {
        ...resource,
        id,
        ...(resourceType === "Basic"
          ? { meta: { ...resource.meta, versionId: String(Number(versionId ?? "0") + 1) } }
          : {}),
      } as T;
      resources[index] = saved;
      return saved;
    },
    executeTransaction: async (bundle: Bundle): Promise<Bundle> => {
      const responseEntries = (bundle.entry ?? []).map((entry) => {
        const resource = entry.resource;
        if (!resource) throw new Error("Unexpected empty transaction resource");
        const resources = created[resource.resourceType as keyof typeof created] as Resource[] | undefined;
        if (!resources) throw new Error(`Unexpected transaction resource ${resource.resourceType}`);
        const requestedId = entry.request?.method === "PUT"
          ? entry.request.url.replace(`${resource.resourceType}/`, "")
          : undefined;
        const id = requestedId ?? `${resource.resourceType.toLowerCase()}-${resources.length + 1}`;
        const saved = { ...structuredClone(resource), id, meta: { ...resource.meta, versionId: "1" } };
        const existingIndex = resources.findIndex((candidate) => candidate.id === id);
        if (existingIndex >= 0) resources[existingIndex] = saved;
        else resources.push(saved);
        return { response: { status: requestedId ? "200" : "201", location: `${resource.resourceType}/${id}/_history/1` } };
      });
      return { resourceType: "Bundle", type: "transaction-response", entry: responseEntries };
    },
  };
  const base: ClaimsHandlerDeps = {
    authenticate: async (authHeader) =>
      authHeader === "Bearer good"
        ? { staffReference: "Practitioner/staff-1", actorRole: role, fhir }
        : null,
    adapter: {
      id: "claimmd",
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
          pcn: "ODOS-CLAIM-900",
          payer_icn: "ICN-900",
          total_charge: "125.00",
          total_paid: "80.00",
          status_code: "1",
          charge: [{ chgid: "claimmd-charge-101", remote_chgid: "charge-1", proc_code: "PROC-A", charge: "125.00", allowed: "80.00", paid: "80.00" }],
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
    fhir,
    createHeaders,
    searchCalls: () => searchCalls,
    failClaimCreate: (error: Error) => {
      claimCreateError = error;
    },
  };
}

test("front-desk and practice-admin hold claims.manage; non-billing roles do not", () => {
  assertBusinessActionAllowed("staff", "claims.manage");
  assertBusinessActionAllowed("admin", "claims.manage");
  assert.throws(() => assertBusinessActionAllowed("provider", "claims.manage"), /claims\.manage/);
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

test("ordinary claim submission cannot bypass the Stedi resubmission determination", async () => {
  const fixture = deps();
  const result = await handleSubmitClaimRequest(fixture.deps, {
    authHeader: "Bearer good",
    body: { claim: { ...professionalClaim, claimFrequencyCode: "7", claimControlNumber: "PCCN-900" } },
  });
  assert.equal(result.status, 400);
  assert.match((result.body as { error: string }).error, /resubmission endpoint/);
  assert.equal(fixture.created.Claim.length, 0);
});

test("client-supplied ChargeItem is re-read and must belong to the Claim patient", async () => {
  const matching = deps();
  const callerInput = structuredClone(professionalClaim);
  callerInput.chargeItems[0].subject.reference = "Patient/caller-tampered";
  const accepted = await handleSubmitClaimRequest(matching.deps, {
    authHeader: "Bearer good",
    body: { claim: callerInput },
  });
  assert.equal(accepted.status, 200);
  assert.equal(matching.created.Claim[0].patient.reference, "Patient/pat-900");

  const crossPatient = deps();
  crossPatient.created.ChargeItem[0].subject.reference = "Patient/other";
  const rejected = await handleSubmitClaimRequest(crossPatient.deps, {
    authHeader: "Bearer good",
    body: { claim: professionalClaim },
  });
  assert.equal(rejected.status, 400);
  assert.match((rejected.body as { error: string }).error, /belongs to Patient\/other, not Patient\/pat-900/);
  assert.equal(crossPatient.created.Claim.length, 0);
  assert.equal(crossPatient.created.Task.length, 0);

  const missing = deps();
  missing.created.ChargeItem.length = 0;
  const notFound = await handleSubmitClaimRequest(missing.deps, {
    authHeader: "Bearer good",
    body: { claim: professionalClaim },
  });
  assert.equal(notFound.status, 400);
  assert.match((notFound.body as { error: string }).error, /ChargeItem\/charge-1 could not be loaded/);
  assert.equal(missing.created.Claim.length, 0);
});

test("submit reuses a stored ChargeItem without dropping its draft diagnosis pointers", async () => {
  const fixture = deps();
  const input = structuredClone(professionalClaim);
  input.diagnoses.push({ system: "https://odos.test/fhir/CodeSystem/synthetic-diagnosis", code: "DX-B" });
  input.chargeItems[0]!.diagnosisSequence = [2];
  fixture.created.ChargeItem[0]!.bodysite = chargeItemBodysite("OS");
  let submittedPayload: any;
  fixture.deps.adapter!.submitProfessionalClaim = async (request) => {
    submittedPayload = request.payload;
    return { claims: [{ claimMdClaimId: "claimmd-1", claimMdId: "tracking-1", status: "A" }], raw: {} };
  };

  const result = await handleSubmitClaimRequest(fixture.deps, {
    authHeader: "Bearer good",
    body: { claim: input },
  });

  assert.equal(result.status, 200);
  assert.deepEqual(fixture.created.Claim[0].item?.[0]?.diagnosisSequence, [2]);
  assert.equal(fixture.created.Claim[0].item?.[0]?.bodySite?.text, "OS");
  assert.equal(submittedPayload.claim[0].charge[0].diag_ref, "B");
  assert.equal("diagnosisSequence" in fixture.created.ChargeItem[0], false);
  assert.equal("laterality" in fixture.created.ChargeItem[0], false);
});

test("submit persists idless ChargeItems once while keeping the Claim.MD payload on the original input shape", async () => {
  const { created, deps: d } = deps();
  const input = structuredClone(professionalClaim);
  input.diagnoses.push({ system: "https://odos.test/fhir/CodeSystem/synthetic-diagnosis", code: "DX-B" });
  delete input.chargeItems[0].id;
  input.chargeItems[0].diagnosisSequence = [2];
  input.chargeItems[0].bodysite = chargeItemBodysite("OS");
  let submittedPayload: any;
  d.adapter!.submitProfessionalClaim = async (request) => {
    submittedPayload = request.payload;
    return { claims: [{ claimMdClaimId: "claimmd-1", claimMdId: "tracking-1", status: "A" }], raw: {} };
  };

  const result = await handleSubmitClaimRequest(d, {
    authHeader: "Bearer good",
    body: { claim: input },
  });

  assert.equal(result.status, 200);
  assert.equal(created.ChargeItem.length, 2);
  assert.equal(created.Claim[0].item?.[0]?.extension?.[0]?.valueReference?.reference, "ChargeItem/chargeitem-2");
  assert.equal(created.ChargeItem[1].subject.reference, "Patient/pat-900");
  assert.equal("diagnosisSequence" in created.ChargeItem[1], false);
  assert.equal("laterality" in created.ChargeItem[1], false);
  assert.equal(created.Claim[0].item?.[0]?.servicedDate, input.serviceDate);
  assert.deepEqual(created.Claim[0].item?.[0]?.diagnosisSequence, [2]);
  assert.equal(created.Claim[0].item?.[0]?.bodySite?.text, "OS");
  assert.equal(submittedPayload.claim[0].charge[0].remote_chgid, undefined);
  assert.equal(submittedPayload.claim[0].charge[0].from_date, "20260709");
  assert.equal(submittedPayload.claim[0].charge[0].diag_ref, "B");
});

test("stored ChargeItem bodysite overrides conflicting request-only laterality", async () => {
  const fixture = deps();
  fixture.created.ChargeItem[0]!.bodysite = chargeItemBodysite("OD");
  const input = structuredClone(professionalClaim) as unknown as typeof professionalClaim & {
    chargeItems: Array<(typeof professionalClaim.chargeItems)[number] & { laterality?: string }>;
  };
  input.chargeItems[0]!.laterality = "OS";

  const result = await handleSubmitClaimRequest(fixture.deps, {
    authHeader: "Bearer good",
    body: { claim: input },
  });

  assert.equal(result.status, 200);
  assert.deepEqual(fixture.created.ChargeItem[0]!.bodysite, chargeItemBodysite("OD"));
  assert.equal(fixture.created.Claim[0].item?.[0]?.bodySite?.text, "OD");
});

test("submit validates the full ChargeItem batch before persisting an idless item", async () => {
  const fixture = deps();
  fixture.created.ChargeItem[0].subject.reference = "Patient/other";
  const input = structuredClone(professionalClaim);
  const idless = structuredClone(input.chargeItems[0]);
  delete idless.id;
  input.chargeItems = [idless, input.chargeItems[0]];

  const result = await handleSubmitClaimRequest(fixture.deps, {
    authHeader: "Bearer good",
    body: { claim: input },
  });

  assert.equal(result.status, 400);
  assert.match((result.body as { error: string }).error, /belongs to Patient\/other, not Patient\/pat-900/);
  assert.equal(fixture.created.ChargeItem.length, 1);
  assert.equal(fixture.createHeaders.filter((write) => write.resourceType === "ChargeItem").length, 0);
  assert.equal(fixture.created.Claim.length, 0);
});

test("submit rejects invalid diagnosis pointers before persisting an idless ChargeItem", async () => {
  const cases = [
    { sequence: [] as number[], diagnosisCount: 1 },
    { sequence: [2], diagnosisCount: 1 },
    { sequence: [1, 2, 3, 4, 5], diagnosisCount: 5 },
  ];

  for (const testCase of cases) {
    const fixture = deps();
    fixture.created.ChargeItem.length = 0;
    const input = structuredClone(professionalClaim);
    input.diagnoses = Array.from({ length: testCase.diagnosisCount }, (_, index) => ({
      system: "https://odos.test/fhir/CodeSystem/synthetic-diagnosis",
      code: `DX-${index + 1}`,
    }));
    delete input.chargeItems[0].id;
    input.chargeItems[0].diagnosisSequence = testCase.sequence;

    const result = await handleSubmitClaimRequest(fixture.deps, {
      authHeader: "Bearer good",
      body: { claim: input },
    });

    assert.equal(result.status, 400);
    assert.match((result.body as { error: string }).error, /diagnosis(?:Sequence| pointer| pointers)/);
    assert.equal(fixture.created.ChargeItem.length, 0);
    assert.equal(fixture.created.Claim.length, 0);
  }
});

test("claim draft reads audit the authenticated staff member and Encounter", async () => {
  const fixture = deps();
  const result = await handleClaimDraftRequest(fixture.deps, {
    authHeader: "Bearer good",
    encounterId: "enc-1",
  });

  assert.equal(result.status, 200);
  const audit = fixture.audits.at(-1);
  assert.equal(audit?.eventType, "read");
  assert.equal(audit?.actorId, "staff-1");
  assert.equal(audit?.patientId, "pat-900");
  assert.equal(audit?.resourceType, "Encounter");
  assert.equal(audit?.resourceId, "enc-1");
  assert.equal(audit?.actionReason, "CLAIM_DRAFT");
});

test("claim draft maps a missing Encounter read to a client error", async () => {
  const fixture = deps();
  const result = await handleClaimDraftRequest(fixture.deps, {
    authHeader: "Bearer good",
    encounterId: "missing",
  });

  assert.equal(result.status, 400);
  assert.match((result.body as { error: string }).error, /Encounter\/missing could not be loaded/);
});

test("Stedi selector submits through the parallel adapter and attributes the existing audit event", async () => {
  const { audits, created, deps: d } = deps();
  let submitted: unknown;
  d.adapters = {
    stedi: {
      id: "stedi",
      mode: "test",
      submitterId: "SUBMITTER900",
      submitProfessionalClaim: async (input: unknown) => {
        submitted = input;
        return { claimReference: { correlationId: "stedi-1", customerClaimNumber: "track-1" } };
      },
      checkEligibility: async () => ({}),
      checkClaimStatus: async () => ({}),
      listEras: async () => ({}),
      retrieveEraData: async () => ({}),
    } as any,
  };
  const result = await handleSubmitClaimRequest(d, {
    authHeader: "Bearer good",
    body: { clearinghouse: "stedi", claim: professionalClaim },
  });

  assert.equal(result.status, 200);
  assert.equal((result.body as any).stediCorrelationId, "stedi-1");
  assert.equal((submitted as any).payload.usageIndicator, "T");
  assert.match(audits[0].actionReason ?? "", /adapter=stedi/);
  assert.ok(created.Claim[0].extension?.some((extension) =>
    extension.url.endsWith("/odos-stedi-claim-input") && extension.valueString?.includes("ODOS-CLAIM-900")));
});

test("pre-adjudication correction previews and submits CFC 1 without a PCCN", async () => {
  const fixture = deps();
  fixture.created.Claim.push({
    ...withStediClaimInputSnapshot(buildProfessionalClaim(professionalClaim), professionalClaim),
    id: "claim-original",
  });
  let submitted: any;
  fixture.deps.adapters = { stedi: stediSubmissionAdapter((request) => { submitted = request; }) };

  const preview = await handleStediClaimResubmissionPreviewRequest(fixture.deps, {
    authHeader: "Bearer good",
    body: { originalClaimReference: "Claim/claim-original", intent: "correct" },
  });
  const result = await handleStediClaimResubmissionRequest(fixture.deps, {
    authHeader: "Bearer good",
    body: {
      originalClaimReference: "Claim/claim-original",
      intent: "correct",
      patientControlNumber: "ODOS-CORRECT-901",
      revisedClaim: professionalClaim,
    },
  });

  assert.equal(preview.status, 200);
  assert.deepEqual((preview.body as any).determination, { status: "ready", claimFrequencyCode: "1" });
  assert.equal(result.status, 200);
  assert.equal(submitted.payload.claimInformation.claimFrequencyCode, "1");
  assert.equal("claimSupplementalInformation" in submitted.payload.claimInformation, false);
  assert.equal(submitted.payload.claimInformation.patientControlNumber, "ODOS-CORRECT-901");
  assert.equal(fixture.created.Claim.at(-1)?.related?.[0]?.claim.reference, "Claim/claim-original");
  assert.deepEqual(claimTouchState(fixture.created.Claim[0]), {
    touchCount: 1,
    lastTouchedAt: "2026-07-09T12:00:00.000Z",
    lastTouchedBy: "Practitioner/staff-1",
  });
});

test("retry after a lost resubmission-touch response records one touch and one Provenance", async () => {
  const fixture = deps();
  let projectionFailureMarks = 0;
  fixture.deps.projectionHealth = {
    begin: () => 1,
    succeed: () => undefined,
    fail: () => undefined,
    invalidate: () => { projectionFailureMarks += 1; },
    status: () => { throw new Error("not read"); },
  };
  fixture.created.Claim.push({
    ...withStediClaimInputSnapshot(buildProfessionalClaim(professionalClaim), professionalClaim),
    id: "claim-original",
  });
  fixture.deps.adapters = { stedi: stediSubmissionAdapter(() => undefined) };
  const executeTransaction = fixture.fhir.executeTransaction;
  let loseFirstResponse = true;
  fixture.fhir.executeTransaction = async (bundle) => {
    const response = await executeTransaction(bundle);
    if (loseFirstResponse) {
      loseFirstResponse = false;
      throw new Error("synthetic lost transaction response");
    }
    return response;
  };
  const request = {
    authHeader: "Bearer good",
    body: {
      originalClaimReference: "Claim/claim-original",
      intent: "correct" as const,
      patientControlNumber: "ODOS-RETRY-901",
      revisedClaim: professionalClaim,
    },
  };

  const first = await handleStediClaimResubmissionRequest(fixture.deps, request);
  const retry = await handleStediClaimResubmissionRequest(fixture.deps, request);

  assert.equal(first.status, 200);
  assert.equal(retry.status, 200);
  assert.equal(claimTouchState(fixture.created.Claim[0]).touchCount, 1);
  assert.equal(fixture.created.Provenance.length, 1);
  assert.equal(projectionFailureMarks, 1);
});

test("pre-adjudication void returns manual handling without building or submitting a claim", async () => {
  const fixture = deps();
  fixture.created.Claim.push({
    ...withStediClaimInputSnapshot(buildProfessionalClaim(professionalClaim), professionalClaim),
    id: "claim-original",
  });
  let transportCalls = 0;
  fixture.deps.adapters = { stedi: stediSubmissionAdapter(() => { transportCalls += 1; }) };

  const preview = await handleStediClaimResubmissionPreviewRequest(fixture.deps, {
    authHeader: "Bearer good",
    body: { originalClaimReference: "Claim/claim-original", intent: "void" },
  });
  const result = await handleStediClaimResubmissionRequest(fixture.deps, {
    authHeader: "Bearer good",
    body: {
      originalClaimReference: "Claim/claim-original",
      intent: "void",
      patientControlNumber: "ODOS-VOID-901",
    },
  });

  assert.equal((preview.body as any).determination.status, "manual");
  assert.equal(result.status, 409);
  assert.match((result.body as { error: string }).error, /nothing to cancel/i);
  assert.equal(fixture.created.Claim.length, 1);
  assert.equal(transportCalls, 0);
});

test("adjudicated non-Medicare correction and void submit CFC 7/8 with the PCCN", async () => {
  for (const intent of ["correct", "void"] as const) {
    const fixture = deps();
    fixture.created.Claim.push({
      ...withStediClaimInputSnapshot(buildProfessionalClaim(professionalClaim), professionalClaim),
      id: "claim-original",
    });
    fixture.created.ClaimResponse.push({
      resourceType: "ClaimResponse",
      id: "response-1",
      status: "active",
      type: {},
      use: "claim",
      patient: { reference: professionalClaim.patientReference },
      created: "2026-07-09",
      insurer: { reference: professionalClaim.insurerReference },
      outcome: "complete",
      request: { reference: "Claim/claim-original" },
      preAuthRef: "PCCN-900",
    });
    let submitted: any;
    fixture.deps.adapters = { stedi: stediSubmissionAdapter((request) => { submitted = request; }) };

    const result = await handleStediClaimResubmissionRequest(fixture.deps, {
      authHeader: "Bearer good",
      body: {
        originalClaimReference: "Claim/claim-original",
        intent,
        payerClassification: "confirmed-non-medicare",
        patientControlNumber: intent === "correct" ? "ODOS-CORRECT-902" : "ODOS-VOID-902",
        ...(intent === "correct" ? { revisedClaim: professionalClaim } : {}),
      },
    });

    assert.equal(result.status, 200);
    assert.equal(submitted.payload.claimInformation.claimFrequencyCode, intent === "correct" ? "7" : "8");
    assert.equal(submitted.payload.claimInformation.claimSupplementalInformation.claimControlNumber, "PCCN-900");
    assert.match(fixture.audits.at(-1)?.actionReason ?? "", /payerClassification=confirmed-non-medicare/);
  }
});

test("adjudicated Medicare or unknown classification returns manual handling without building a claim", async () => {
  for (const payerClassification of ["original-medicare", undefined] as const) {
    const fixture = deps();
    fixture.created.Claim.push({
      ...withStediClaimInputSnapshot(buildProfessionalClaim(professionalClaim), professionalClaim),
      id: "claim-original",
    });
    fixture.created.ClaimResponse.push({
      resourceType: "ClaimResponse",
      id: "response-1",
      status: "active",
      type: {},
      use: "claim",
      patient: { reference: professionalClaim.patientReference },
      created: "2026-07-09",
      insurer: { reference: professionalClaim.insurerReference },
      outcome: "complete",
      request: { reference: "Claim/claim-original" },
      preAuthRef: "PCCN-900",
    });
    let transportCalls = 0;
    fixture.deps.adapters = { stedi: stediSubmissionAdapter(() => { transportCalls += 1; }) };

    const preview = await handleStediClaimResubmissionPreviewRequest(fixture.deps, {
      authHeader: "Bearer good",
      body: {
        originalClaimReference: "Claim/claim-original",
        intent: "correct",
        ...(payerClassification ? { payerClassification } : {}),
      },
    });
    const result = await handleStediClaimResubmissionRequest(fixture.deps, {
      authHeader: "Bearer good",
      body: {
        originalClaimReference: "Claim/claim-original",
        intent: "correct",
        ...(payerClassification ? { payerClassification } : {}),
        patientControlNumber: "ODOS-CORRECT-903",
        revisedClaim: professionalClaim,
      },
    });

    assert.equal((preview.body as any).determination.status, "manual");
    assert.equal(result.status, 409);
    assert.equal(fixture.created.Claim.length, 1);
    assert.equal(transportCalls, 0);
  }
});

test("missing original claim returns 404 without a rejected Task or submit-failed audit", async () => {
  const fixture = deps();
  let transportCalls = 0;
  fixture.deps.adapters = { stedi: stediSubmissionAdapter(() => { transportCalls += 1; }) };

  const result = await handleStediClaimResubmissionRequest(fixture.deps, {
    authHeader: "Bearer good",
    body: {
      originalClaimReference: "Claim/missing-original",
      intent: "correct",
      patientControlNumber: "ODOS-CORRECT-904",
      revisedClaim: professionalClaim,
    },
  });

  assert.equal(result.status, 404);
  assert.equal(fixture.created.Claim.length, 0);
  assert.equal(fixture.created.Task.length, 0);
  assert.equal(fixture.audits.some((entry) => entry.eventType === "claim.submit.failed"), false);
  assert.equal(transportCalls, 0);
});

test("Stedi subscriber address validation returns 400 before transport without a rejected Task or clearinghouse-failure audit", async () => {
  const { audits, created, deps: d } = deps();
  const input = structuredClone(professionalClaim);
  delete input.subscriber.address1;
  let submitted = false;
  d.adapters = {
    stedi: {
      id: "stedi",
      mode: "test",
      submitterId: "SUBMITTER900",
      submitProfessionalClaim: async () => {
        submitted = true;
        return { claimReference: { correlationId: "should-not-run" } };
      },
      checkEligibility: async () => ({}),
      checkClaimStatus: async () => ({}),
      listEras: async () => ({}),
      retrieveEraData: async () => ({}),
    } as any,
  };

  const result = await handleSubmitClaimRequest(d, {
    authHeader: "Bearer good",
    body: { clearinghouse: "stedi", claim: input },
  });

  assert.equal(result.status, 400);
  assert.match((result.body as { error: string }).error, /subscriber address and complete physical address/);
  assert.equal(submitted, false);
  assert.equal(created.Task.length, 0);
  assert.equal(audits.some((entry) => entry.eventType === "claim.submit.failed"), false);
});

test("Stedi transport errors return human-usable reasons while audits retain only safe trace fields", async () => {
  const { audits, deps: d } = deps();
  const x12 = "SYNTHETIC-X12-CONTENT-MUST-NOT-LEAK";
  const responseBody = {
    errors: [
      { code: "INVALID_VALUE", description: "Procedure code is invalid.", followupAction: "Correct and resubmit." },
      { code: "MISSING_FIELD", description: "Subscriber gender is required.", followupAction: "Add the missing field." },
    ],
    claimReference: { correlationId: "corr-handler-900" },
    x12,
  };
  d.adapters = {
    stedi: {
      id: "stedi",
      mode: "test",
      submitterId: "SUBMITTER900",
      submitProfessionalClaim: async () => {
        throw new StediRequestError(400, responseBody);
      },
      checkEligibility: async () => ({}),
      checkClaimStatus: async () => ({}),
      listEras: async () => ({}),
      retrieveEraData: async () => ({}),
    } as any,
  };

  const result = await handleSubmitClaimRequest(d, {
    authHeader: "Bearer good",
    body: { clearinghouse: "stedi", claim: professionalClaim },
  });

  assert.equal(result.status, 502);
  const returnedError = (result.body as { error: string }).error;
  assert.match(returnedError, /Procedure code is invalid\./);
  assert.match(returnedError, /Subscriber gender is required\./);
  assert.match(returnedError, /corr-handler-900/);
  assert.doesNotMatch(returnedError, new RegExp(x12));

  const failureAudit = audits.find((entry) => entry.eventType === "claim.submit.failed");
  assert.match(failureAudit?.actionReason ?? "", /INVALID_VALUE/);
  assert.match(failureAudit?.actionReason ?? "", /MISSING_FIELD/);
  assert.match(failureAudit?.actionReason ?? "", /corr-handler-900/);
  assert.doesNotMatch(failureAudit?.actionReason ?? "", /Procedure code is invalid\./);
  assert.doesNotMatch(failureAudit?.actionReason ?? "", /Subscriber gender is required\./);
  assert.doesNotMatch(failureAudit?.actionReason ?? "", new RegExp(x12));
});

test("Stedi payload also remains on the original idless charge input after provenance persistence", async () => {
  const { created, deps: d } = deps();
  const input = structuredClone(professionalClaim);
  delete input.chargeItems[0].id;
  let submitted: any;
  d.adapters = {
    stedi: {
      id: "stedi",
      mode: "test",
      submitterId: "SUBMITTER900",
      submitProfessionalClaim: async (request: unknown) => {
        submitted = request;
        return { claimReference: { correlationId: "stedi-1", customerClaimNumber: "track-1" } };
      },
      checkEligibility: async () => ({}), checkClaimStatus: async () => ({}), listEras: async () => ({}), retrieveEraData: async () => ({}),
    } as any,
  };

  const result = await handleSubmitClaimRequest(d, {
    authHeader: "Bearer good",
    body: { clearinghouse: "stedi", claim: input },
  });

  assert.equal(result.status, 200);
  assert.equal(created.ChargeItem.length, 2);
  assert.equal(submitted.payload.claimInformation.serviceLines[0].providerControlNumber, "chargeitem-2");
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

test("Stedi eligibility uses the parallel 271 mapper with unchanged RBAC and audit event type", async () => {
  const { audits, created, deps: d } = deps();
  d.adapters = {
    stedi: {
      id: "stedi",
      checkEligibility: async () => ({ planStatus: [{ statusCode: "1", status: "Active Coverage" }], benefitsInformation: [] }),
      submitProfessionalClaim: async () => ({}),
      checkClaimStatus: async () => ({}),
      listEras: async () => ({}),
      retrieveEraData: async () => ({}),
    },
  };
  const result = await handleEligibilityCheckRequest(d, {
    authHeader: "Bearer good",
    body: {
      clearinghouse: "stedi",
      patientReference: "Patient/pat-900",
      coverageReference: "Coverage/cov-1",
      insurerReference: "Organization/payer-1",
      serviceDate: "2026-07-09",
      stedi: { tradingPartnerServiceId: "STEDITEST" },
    },
  });
  assert.equal(result.status, 200);
  assert.equal(created.CoverageEligibilityResponse[0].insurance?.[0].inforce, true);
  assert.equal(audits[0].eventType, "eligibility.check.completed");
  assert.match(audits[0].actionReason ?? "", /adapter=stedi/);
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

test("Stedi claim status maps fixture 277 data and keeps the shared audit event", async () => {
  const { audits, created, deps: d } = deps();
  d.adapters = {
    stedi: {
      id: "stedi",
      checkClaimStatus: async () => ({ claims: [{ claimStatus: { statusCategoryCode: "F1", statusCodeValue: "Claim has been paid." } }] }),
      submitProfessionalClaim: async () => ({}),
      checkEligibility: async () => ({}),
      listEras: async () => ({}),
      retrieveEraData: async () => ({}),
    },
  };
  const result = await handleClaimStatusRequest(d, {
    authHeader: "Bearer good",
    params: { id: "claim-1" },
    body: {
      clearinghouse: "stedi",
      patientReference: "Patient/pat-900",
      insurerReference: "Organization/payer-1",
      stedi: { tradingPartnerServiceId: "STEDITEST" },
    },
  });
  assert.equal(result.status, 200);
  assert.equal(created.ClaimResponse[0].outcome, "complete");
  assert.equal(audits[0].eventType, "claim.status.checked");
  assert.match(audits[0].actionReason ?? "", /adapter=stedi/);
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
  created.Claim.push({ ...buildProfessionalClaim(professionalClaim), id: "claim-1" });
  const res = await handleEraImportRequest(d, {
    authHeader: "Bearer good",
    body: {
      eraId: "era-900",
      claimReferenceByPcn: { "ODOS-CLAIM-900": "Claim/claim-1" },
      patientReferenceByPcn: { "ODOS-CLAIM-900": "Patient/pat-900" },
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
  assert.equal(created.PaymentReconciliation[0].detail?.[1]?.request?.reference, "ChargeItem/charge-1");
  assert.equal(created.PaymentReconciliation[0].detail?.[1]?.amount?.value, 80);
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

test("ERA line linkage falls back to whole-claim detail when the echoed ChargeItem is not owned by the Claim", async () => {
  const fixture = deps();
  fixture.created.Claim.push({ ...buildProfessionalClaim(professionalClaim), id: "claim-1" });
  fixture.created.ChargeItem.push({
    ...structuredClone(professionalClaim.chargeItems[0]),
    id: "charge-other",
  });
  fixture.deps.adapter!.retrieveEraData = async () => ({
    eraid: "era-foreign-link",
    paid_date: "2026-07-09",
    payer_name: "SYNTHETIC PAYER",
    claim: {
      pcn: "ODOS-CLAIM-900",
      total_charge: "80.00",
      total_paid: "80.00",
      charge: [{
        chgid: "claimmd-charge-foreign",
        remote_chgid: "charge-other",
        charge: "80.00",
        allowed: "80.00",
        paid: "80.00",
      }],
    },
  });

  const result = await handleEraImportRequest(fixture.deps, {
    authHeader: "Bearer good",
    body: { ...eraImportBody(), eraId: "era-foreign-link" },
  });

  assert.equal(result.status, 200);
  assert.equal(fixture.created.PaymentReconciliation[0].detail?.length, 1);
  assert.equal(fixture.created.PaymentReconciliation[0].detail?.[0]?.request?.reference, "Claim/claim-1");
  assert.equal(fixture.created.ClaimResponse[0].item?.[0]?.extension?.some(
    (extension) => extension.url === ODOS_CLAIM_CHARGE_ITEM_EXTENSION_URL,
  ) ?? false, false);
  assert.equal(worklistCode(fixture.created.Task[0]), "era-line-linkage");
  assert.equal(fixture.created.Task[0].focus?.reference, "ClaimResponse/claimresponse-1");
  assert.equal(fixture.created.Task[0].for?.reference, "Patient/pat-900");
  assert.equal(fixture.created.Task[0].description, "ERA line linkage requires review");
  assert.match(taskInput(fixture.created.Task[0], "line-linkage-review-reason")?.valueString ?? "", /not owned/);
});

test("an invalid line identity falls back and creates a dedicated linkage review Task", async () => {
  const fixture = deps();
  fixture.created.Claim.push({ ...buildProfessionalClaim(professionalClaim), id: "claim-1" });
  fixture.deps.adapter!.retrieveEraData = async () => ({
    eraid: "era-invalid-link",
    paid_date: "2026-07-09",
    payer_name: "SYNTHETIC PAYER",
    claim: {
      pcn: "ODOS-CLAIM-900",
      total_charge: "80.00",
      total_paid: "80.00",
      charge: [{
        chgid: "claimmd-charge-invalid",
        remote_chgid: "invalid/charge",
        charge: "80.00",
        allowed: "80.00",
        paid: "80.00",
      }],
    },
  });

  const result = await handleEraImportRequest(fixture.deps, {
    authHeader: "Bearer good",
    body: { ...eraImportBody(), eraId: "era-invalid-link" },
  });

  assert.equal(result.status, 200);
  assert.equal(fixture.created.PaymentReconciliation[0].detail?.length, 1);
  assert.equal(worklistCode(fixture.created.Task[0]), "era-line-linkage");
  assert.match(taskInput(fixture.created.Task[0], "line-linkage-review-reason")?.valueString ?? "", /omitted/);
});

test("a mismatched ClaimResponse patient is corrected from the Claim and never receives a line link", async () => {
  const fixture = deps();
  fixture.created.Claim.push({ ...buildProfessionalClaim(professionalClaim), id: "claim-1" });
  fixture.deps.adapter!.retrieveEraData = async () => ({
    eraid: "era-patient-mismatch",
    paid_date: "2026-07-09",
    payer_name: "SYNTHETIC PAYER",
    claim: {
      pcn: "ODOS-CLAIM-900",
      total_charge: "125.00",
      total_paid: "70.00",
      charge: [{
        chgid: "claimmd-charge-patient-mismatch",
        remote_chgid: "charge-1",
        charge: "125.00",
        allowed: "100.00",
        paid: "70.00",
      }],
    },
  });

  const result = await handleEraImportRequest(fixture.deps, {
    authHeader: "Bearer good",
    body: {
      ...eraImportBody(),
      patientReferenceByPcn: { "ODOS-CLAIM-900": "Patient/pat-wrong" },
    },
  });

  assert.equal(result.status, 200);
  assert.equal(fixture.created.ClaimResponse[0].patient.reference, "Patient/pat-900");
  assert.equal(fixture.created.ClaimResponse[0].item?.[0]?.extension?.some(
    (extension) => extension.url === ODOS_CLAIM_CHARGE_ITEM_EXTENSION_URL,
  ) ?? false, false);
  assert.equal(fixture.created.PaymentReconciliation[0].detail?.length, 1);
  assert.equal(worklistCode(fixture.created.Task[0]), "era-line-linkage");
  assert.equal(fixture.created.Task[0].for?.reference, "Patient/pat-900");
  assert.equal(worklistCode(fixture.created.Task[1]), "era-underpayment");
  assert.equal(fixture.created.Task[1].for?.reference, "Patient/pat-900");
  assert.match(taskInput(fixture.created.Task[0], "line-linkage-review-reason")?.valueString ?? "", /patient ownership/);
  assert.equal(fixture.audits.some((row) => row.eventType === "era.line-linkage.flagged"), true);
});

test("a duplicate line echo falls back for that claim, flags review, and does not abort the ERA batch", async () => {
  const fixture = deps();
  fixture.created.Claim.push({ ...buildProfessionalClaim(professionalClaim), id: "claim-1" });
  const secondCharge = {
    ...structuredClone(professionalClaim.chargeItems[0]),
    id: "charge-2",
  };
  fixture.created.ChargeItem.push(secondCharge);
  fixture.created.Claim.push({
    ...buildProfessionalClaim({
      ...professionalClaim,
      patientAccountNumber: "ODOS-CLAIM-901",
      chargeItems: [secondCharge],
    }),
    id: "claim-2",
  });
  fixture.deps.adapter!.retrieveEraData = async () => ({
    eraid: "era-two-claims",
    paid_date: "2026-07-09",
    payer_name: "SYNTHETIC PAYER",
    claim: [
      {
        pcn: "ODOS-CLAIM-900",
        total_charge: "80.00",
        total_paid: "80.00",
        charge: [{ chgid: "claimmd-charge-1", remote_chgid: "charge-1", charge: "80.00", allowed: "80.00", paid: "80.00" }],
      },
      {
        pcn: "ODOS-CLAIM-901",
        total_charge: "80.00",
        total_paid: "80.00",
        charge: [
          { chgid: "claimmd-charge-2a", remote_chgid: "charge-2", charge: "40.00", allowed: "40.00", paid: "40.00" },
          { chgid: "claimmd-charge-2b", remote_chgid: "charge-2", charge: "40.00", allowed: "40.00", paid: "40.00" },
        ],
      },
    ],
  });

  const result = await handleEraImportRequest(fixture.deps, {
    authHeader: "Bearer good",
    body: {
      ...eraImportBody(),
      eraId: "era-two-claims",
      claimReferenceByPcn: { "ODOS-CLAIM-900": "Claim/claim-1", "ODOS-CLAIM-901": "Claim/claim-2" },
      patientReferenceByPcn: { "ODOS-CLAIM-900": "Patient/pat-900", "ODOS-CLAIM-901": "Patient/pat-900" },
    },
  });

  assert.equal(result.status, 200);
  assert.equal(fixture.created.ClaimResponse.length, 2);
  assert.equal(fixture.created.PaymentReconciliation.length, 2);
  assert.equal(fixture.created.PaymentReconciliation[0].detail?.length, 2);
  assert.equal(fixture.created.PaymentReconciliation[1].detail?.length, 1);
  assert.equal(fixture.created.PaymentReconciliation[1].detail?.[0]?.amount?.value, 80);
  assert.equal(fixture.created.Task.length, 1);
  assert.equal(worklistCode(fixture.created.Task[0]), "era-line-linkage");
  assert.equal(fixture.created.Task[0].focus?.reference, "ClaimResponse/claimresponse-2");
  assert.equal(fixture.created.Task[0].for?.reference, "Patient/pat-900");
  assert.equal(fixture.created.Task[0].description, "ERA line linkage requires review");
  assert.match(taskInput(fixture.created.Task[0], "line-linkage-review-reason")?.valueString ?? "", /duplicate/);
  assert.deepEqual(
    pickCounts(result.body),
    { posted: 2, denied: 0, underpaid: 0, flagged: 1, taskIds: ["task-1"] },
  );
});

test("Stedi ERA fixture creates the same insurance PaymentReconciliation shape without enrollment side effects", async () => {
  const { audits, created, deps: d } = deps();
  created.Claim.push({ ...buildProfessionalClaim(professionalClaim), id: "claim-1" });
  let stediTransactionId = "7647d644-9348-4596-a3b4-6830b8b48cc8";
  let lineItemControlNumber = "charge-1";
  d.adapters = {
    stedi: {
      id: "stedi",
      submitProfessionalClaim: async () => ({}),
      checkEligibility: async () => ({}),
      checkClaimStatus: async () => ({}),
      listEras: async () => ({}),
      retrieveEraData: async () => ({
        meta: { transactionId: stediTransactionId },
        transactions: [{
          payer: { name: "SYNTHETIC PAYER" },
          financialInformation: {
            checkIssueOrEFTEffectiveDate: "20260709",
            totalActualProviderPaymentAmount: "80",
          },
          paymentAndRemitReassociationDetails: { checkOrEFTTraceNumber: "TRACE900" },
          detailInfo: [{ paymentInfo: [{
            claimPaymentInfo: {
              patientControlNumber: "ODOS-CLAIM-900",
              totalClaimChargeAmount: "125",
              claimPaymentAmount: "80",
              patientResponsibilityAmount: "20",
              payerClaimControlNumber: "PAYER900",
              claimStatusCode: "1",
            },
            serviceLines: [{
              lineItemControlNumber,
              servicePaymentInformation: { lineItemChargeAmount: "125", lineItemProviderPaymentAmount: "80", adjudicatedProcedureCode: "PROC-A" },
              serviceSupplementalAmounts: { allowedActual: "100" },
              serviceAdjustments: [{ claimAdjustmentGroupCode: "PR", adjustmentReasonCode3: "1", adjustmentAmount3: "20" }],
            }],
          }] }],
        }],
      }),
    },
  };
  const result = await handleEraImportRequest(d, {
    authHeader: "Bearer good",
    body: { ...eraImportBody(), clearinghouse: "stedi" },
  });
  assert.equal(result.status, 200);
  assert.equal(created.ClaimResponse[0].disposition, "Stedi ERA from SYNTHETIC PAYER — 1: Processed as Primary");
  assert.equal(created.PaymentReconciliation[0].detail?.[0].request?.reference, "Claim/claim-1");
  assert.equal(created.PaymentReconciliation[0].detail?.[1]?.request?.reference, "ChargeItem/charge-1");
  assert.equal(created.PaymentReconciliation[0].detail?.[1]?.amount?.value, 80);
  assert.equal(created.PaymentReconciliation[0].paymentIdentifier?.system, "https://odos2020.com/fhir/NamingSystem/stedi-era");
  assert.equal(created.Invoice.length, 1);
  assert.equal(created.Invoice[0].totalNet?.value, 20);
  assert.match(audits[0].actionReason ?? "", /adapter=stedi/);

  stediTransactionId = "7647d644-9348-4596-a3b4-6830b8b48cc9";
  lineItemControlNumber = "charge-other";
  const unverifiedLine = await handleEraImportRequest(d, {
    authHeader: "Bearer good",
    body: { ...eraImportBody(), eraId: "stedi-foreign-line", clearinghouse: "stedi" },
  });
  assert.equal(unverifiedLine.status, 200);
  assert.equal(created.PaymentReconciliation[1].detail?.length, 1);
  assert.equal(created.PaymentReconciliation[1].detail?.[0]?.request?.reference, "Claim/claim-1");
  assert.equal(created.ClaimResponse[1].item?.[0]?.extension?.some(
    (extension) => extension.url === ODOS_CLAIM_CHARGE_ITEM_EXTENSION_URL,
  ) ?? false, false);
  assert.equal(worklistCode(created.Task[0]), "era-line-linkage");
  assert.equal(created.Task[0].focus?.reference, "ClaimResponse/claimresponse-2");
  assert.equal(created.Task[0].for?.reference, "Patient/pat-900");
  assert.equal(created.Task[0].description, "ERA line linkage requires review");
  assert.match(taskInput(created.Task[0], "line-linkage-review-reason")?.valueString ?? "", /omitted a valid/);
  assert.deepEqual(
    pickCounts(unverifiedLine.body),
    { posted: 1, denied: 0, underpaid: 0, flagged: 1, taskIds: ["task-1"] },
  );

  const unmatched = await handleEraImportRequest(d, {
    authHeader: "Bearer good",
    body: {
      ...eraImportBody(),
      clearinghouse: "stedi",
      claimReferenceByPcn: {},
      patientReferenceByPcn: {},
    },
  });
  assert.equal(unmatched.status, 200);
  assert.equal(created.Task[1].groupIdentifier?.system, STEDI_ERA_PAYMENT_SYSTEM);
});

test("Stedi ERA creates one balancing remittance batch and distinct audited provider-level adjustments", async () => {
  const fixture = deps();
  fixture.created.Claim.push({ ...buildProfessionalClaim(professionalClaim), id: "claim-1" });
  const raw = stediEraReport({ transactionId: "era-plb", claimPaymentAmount: "85" }) as any;
  raw.transactions[0].financialInformation.totalActualProviderPaymentAmount = "80";
  raw.transactions[0].providerAdjustments = [{
    fiscalPeriodDate: "20261231",
    providerIdentifier: "1111111112",
    adjustments: [{
      adjustmentReasonCode: "WO",
      adjustmentReasonCodeValue: "Overpayment Recovery",
      providerAdjustmentAmount: "5",
      providerAdjustmentIdentifier: "PLB-RECOVERY-1",
    }],
  }];
  fixture.deps.adapters = { stedi: stediEraAdapter(raw) };

  const result = await handleEraImportRequest(fixture.deps, {
    authHeader: "Bearer good",
    body: { ...eraImportBody(), eraId: "era-plb", clearinghouse: "stedi" },
  });

  assert.equal(result.status, 200);
  const batch = fixture.created.Basic.find((basic) => basic.code?.coding?.some((coding) => coding.code === REMITTANCE_BATCH_CODE));
  const adjustment = fixture.created.Basic.find((basic) => basic.code?.coding?.some((coding) => coding.code === PROVIDER_ADJUSTMENT_CODE));
  assert.ok(batch);
  assert.ok(adjustment);
  assert.equal(parseProviderAdjustment(adjustment).claimReference, undefined);
  assert.deepEqual(projectRemittanceBatch(batch, [adjustment], "2026-08-30T00:00:00.000Z"), {
    ...projectRemittanceBatch(batch, [adjustment], "2026-08-30T00:00:00.000Z"),
    claimActivityCents: 8_500,
    providerActivityCents: -500,
    accountedAmountCents: 8_000,
    unallocatedAmountCents: 0,
    balanced: true,
  });
  assert.equal(fixture.audits.some((row) => row.resourceType === "Basic" && row.resourceId === batch.id), true);
  assert.equal(fixture.audits.some((row) => row.resourceType === "Basic" && row.resourceId === adjustment.id), true);
  assert.equal((result.body as any).remittanceBatchId, batch.id);
  assert.deepEqual((result.body as any).providerAdjustmentIds, [adjustment.id]);
});

test("Stedi ERA uses payer-stated patient responsibility for the Invoice and flags a line-total disagreement", async () => {
  const { audits, created, deps: d } = deps();
  created.Claim.push({ ...buildProfessionalClaim(professionalClaim), id: "claim-1" });
  d.adapters = { stedi: stediEraAdapter(stediEraReport({
    transactionId: "era-pr-discrepancy",
    patientResponsibilityAmount: "35",
    serviceAdjustments: [{
      claimAdjustmentGroupCode: "PR",
      adjustmentReasonCode3: "1",
      adjustmentAmount3: "20",
    }],
  })) };

  const result = await handleEraImportRequest(d, {
    authHeader: "Bearer good",
    body: { ...eraImportBody(), eraId: "era-pr-discrepancy", clearinghouse: "stedi" },
  });

  assert.equal(result.status, 200);
  assert.equal(created.Invoice[0].totalNet?.value, 35);
  assert.equal(created.Task.length, 1);
  assert.equal(worklistCode(created.Task[0]), "era-integrity");
  assert.equal(created.Task[0].description, "Stedi ERA integrity requires review");
  assert.match(taskInput(created.Task[0], "stedi-era-review-reason")?.valueString ?? "", /patient responsibility.*35\.00.*20\.00/i);
  assert.equal(audits.some((row) => row.eventType === "era.integrity.flagged"), true);
  assert.deepEqual(pickCounts(result.body), {
    posted: 1,
    denied: 0,
    underpaid: 0,
    flagged: 1,
    taskIds: ["task-1"],
  });
});

test("a malformed amount on the third Stedi claim is reviewed without aborting the batch", async () => {
  const fixture = deps();
  fixture.created.ChargeItem.length = 0;
  const reports = [1, 2, 3].map((index) => {
    const chargeItem = {
      ...structuredClone(professionalClaim.chargeItems[0]),
      id: `charge-${index}`,
      subject: { reference: `Patient/pat-90${index}` },
    };
    fixture.created.ChargeItem.push(chargeItem);
    fixture.created.Claim.push({
      ...buildProfessionalClaim({
        ...professionalClaim,
        patientReference: `Patient/pat-90${index}`,
        patientAccountNumber: `ODOS-CLAIM-90${index}`,
        chargeItems: [chargeItem],
      }),
      id: `claim-${index}`,
    });
    const report = stediEraReport({
      transactionId: "era-malformed-third",
      patientResponsibilityAmount: "20",
      serviceAdjustments: [{
        claimAdjustmentGroupCode: "PR",
        adjustmentReasonCode1: "1",
        adjustmentAmount1: "20",
      }],
    }) as any;
    const claim = report.transactions[0].detailInfo[0].paymentInfo[0];
    claim.claimPaymentInfo.patientControlNumber = `ODOS-CLAIM-90${index}`;
    claim.claimPaymentInfo.payerClaimControlNumber = `PAYER90${index}`;
    claim.serviceLines[0].lineItemControlNumber = `charge-${index}`;
    return claim;
  });
  reports[2].claimPaymentInfo.claimPaymentAmount = "not-a-decimal";
  const raw = stediEraReport({ transactionId: "era-malformed-third" }) as any;
  raw.transactions[0].detailInfo[0].paymentInfo = reports;
  fixture.deps.adapters = { stedi: stediEraAdapter(raw) };

  const result = await handleEraImportRequest(fixture.deps, {
    authHeader: "Bearer good",
    body: {
      ...eraImportBody(),
      eraId: "era-malformed-third",
      clearinghouse: "stedi",
      claimReferenceByPcn: {
        "ODOS-CLAIM-901": "Claim/claim-1",
        "ODOS-CLAIM-902": "Claim/claim-2",
        "ODOS-CLAIM-903": "Claim/claim-3",
      },
      patientReferenceByPcn: {
        "ODOS-CLAIM-901": "Patient/pat-901",
        "ODOS-CLAIM-902": "Patient/pat-902",
        "ODOS-CLAIM-903": "Patient/pat-903",
      },
    },
  });

  assert.equal(result.status, 200);
  assert.equal(fixture.created.ClaimResponse.length, 3);
  assert.deepEqual(
    fixture.created.Invoice.map((invoice) => invoice.extension?.find(
      (extension) => extension.url === ODOS_SOURCE_CLAIM_EXTENSION_URL,
    )?.valueReference?.reference),
    ["Claim/claim-1", "Claim/claim-2", "Claim/claim-3"],
  );
  assert.equal(fixture.created.PaymentReconciliation.length, 2);
  const review = fixture.created.Task.find((task) => worklistCode(task) === "era-integrity");
  assert.equal(review?.focus?.reference, "ClaimResponse/claimresponse-3");
  assert.match(taskInput(review!, "stedi-era-review-reason")?.valueString ?? "", /claimPaymentInfo\.claimPaymentAmount/);
});

test("repeating the same Stedi ERA import creates one PaymentReconciliation per claim", async () => {
  const fixture = deps();
  fixture.created.Claim.push({ ...buildProfessionalClaim(professionalClaim), id: "claim-1" });
  fixture.deps.adapters = { stedi: stediEraAdapter(stediEraReport({ transactionId: "era-retry" })) };

  const first = await handleEraImportRequest(fixture.deps, {
    authHeader: "Bearer good",
    body: { ...eraImportBody(), eraId: "era-retry", clearinghouse: "stedi" },
  });
  const second = await handleEraImportRequest(fixture.deps, {
    authHeader: "Bearer good",
    body: { ...eraImportBody(), eraId: "era-retry", clearinghouse: "stedi" },
  });

  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.equal(fixture.created.PaymentReconciliation.length, 1);
  assert.equal(fixture.created.PaymentReconciliation[0].paymentIdentifier?.value, "TRACE-era-retry");
  assert.deepEqual(fixture.created.PaymentReconciliation[0].identifier, [{
    system: STEDI_ERA_PAYMENT_SYSTEM,
    value: "era-retry:Claim/claim-1",
  }]);
  assert.equal(
    fixture.createHeaders.find((write) => write.resourceType === "PaymentReconciliation")?.headers?.["If-None-Exist"],
    `identifier=${STEDI_ERA_PAYMENT_SYSTEM}|era-retry:Claim/claim-1`,
  );
});

test("a claim-level-only Stedi responsibility remains visible and opens integrity review", async () => {
  const fixture = deps();
  fixture.created.Claim.push({ ...buildProfessionalClaim(professionalClaim), id: "claim-1" });
  const raw = stediEraReport({ transactionId: "era-claim-level-only", patientResponsibilityAmount: "35" }) as any;
  raw.transactions[0].detailInfo[0].paymentInfo[0].serviceLines = [];
  fixture.deps.adapters = { stedi: stediEraAdapter(raw) };

  const result = await handleEraImportRequest(fixture.deps, {
    authHeader: "Bearer good",
    body: { ...eraImportBody(), eraId: "era-claim-level-only", clearinghouse: "stedi" },
  });

  assert.equal(result.status, 200);
  assert.equal(fixture.created.Invoice.length, 0);
  assert.equal(fixture.created.ClaimResponse[0].total?.find(
    (total) => total.category.text === "patient responsibility",
  )?.amount.value, 35);
  assert.equal(worklistCode(fixture.created.Task[0]), "era-integrity");
  assert.match(
    taskInput(fixture.created.Task[0], "stedi-era-review-reason")?.valueString ?? "",
    /payer-stated patient responsibility 35\.00.*no service lines/i,
  );
});

test("an in-loop Stedi import failure is not audited as an ERA retrieval failure", async () => {
  const fixture = deps();
  fixture.deps.adapters = { stedi: stediEraAdapter(stediEraReport({
    transactionId: "era-import-failure",
    patientResponsibilityAmount: "20",
  })) };

  const result = await handleEraImportRequest(fixture.deps, {
    authHeader: "Bearer good",
    body: {
      ...eraImportBody(),
      eraId: "era-import-failure",
      clearinghouse: "stedi",
      claimReferenceByPcn: { "ODOS-CLAIM-900": "not-a-claim-reference" },
    },
  });

  assert.equal(result.status, 502);
  assert.match(fixture.audits.at(-1)?.actionReason ?? "", /Stedi importEraData failed/);
  assert.doesNotMatch(fixture.audits.at(-1)?.actionReason ?? "", /retrieveEraData/);
});

test("Stedi reversal nets against the prior claim-version allocation without fabricating a second reconciliation", async () => {
  const { created, deps: d } = deps();
  d.eraUnderpaymentThresholdCents = 100_000;
  created.Claim.push({ ...buildProfessionalClaim(professionalClaim), id: "claim-1" });
  d.adapters = { stedi: stediEraAdapter(stediEraReport({ transactionId: "era-original" })) };
  const original = await handleEraImportRequest(d, {
    authHeader: "Bearer good",
    body: { ...eraImportBody(), eraId: "era-original", clearinghouse: "stedi" },
  });
  assert.equal(original.status, 200);
  created.Claim.push({
    ...buildProfessionalClaim(professionalClaim),
    id: "claim-2",
    related: [{ claim: { reference: "Claim/claim-1" }, relationship: { text: "replacement" } }],
  });
  d.adapters = { stedi: stediEraAdapter(stediEraReport({
    transactionId: "era-reversal",
    claimStatusCode: "22",
    totalClaimChargeAmount: "-125",
    claimPaymentAmount: "-80",
    lineItemChargeAmount: "-125",
    lineItemProviderPaymentAmount: "-80",
    allowedActual: "-80",
  })) };

  const result = await handleEraImportRequest(d, {
    authHeader: "Bearer good",
    body: {
      ...eraImportBody(),
      eraId: "era-reversal",
      clearinghouse: "stedi",
      claimReferenceByPcn: { "ODOS-CLAIM-900": "Claim/claim-2" },
    },
  });

  assert.equal(result.status, 200);
  assert.equal(created.ClaimResponse[1].outcome, "complete");
  assert.match(created.ClaimResponse[1].disposition ?? "", /Reversal of Previous Payment/);
  assert.equal(created.ClaimResponse[1].payment?.amount.value, -80);
  assert.equal(created.PaymentReconciliation.length, 1);
  assert.equal(created.Task.length, 0);
  const batches = created.Basic.filter((basic) => basic.code?.coding?.some((coding) => coding.code === REMITTANCE_BATCH_CODE));
  assert.equal(batches.length, 2);
  const originalBatch = parseRemittanceBatch(batches[0]);
  const reversalBatch = parseRemittanceBatch(batches[1]);
  assert.equal(originalBatch.allocations[0].amountCents, 8_000);
  assert.equal(reversalBatch.allocations[0].amountCents, -8_000);
  assert.equal(reversalBatch.allocations[0].claimReference, "Claim/claim-2");
  assert.equal(reversalBatch.allocations[0].reversalOfAllocationId, originalBatch.allocations[0].id);
  assert.equal(reversalBatch.allocations[0].reversalOfBatchReference, `Basic/${originalBatch.id}`);
  assert.equal(originalBatch.allocations[0].amountCents + reversalBatch.allocations[0].amountCents, 0);
  assert.deepEqual(pickCounts(result.body), {
    posted: 0,
    denied: 0,
    underpaid: 0,
    flagged: 0,
    taskIds: [],
  });
});

test("Stedi reversal prefers the directly related prior claim when equal payments exist in one lineage", async () => {
  const fixture = deps();
  fixture.deps.eraUnderpaymentThresholdCents = 100_000;
  let clock = "2026-07-09T10:00:00.000Z";
  fixture.deps.now = () => clock;
  fixture.created.Claim.push({ ...buildProfessionalClaim(professionalClaim), id: "claim-1" });
  fixture.deps.adapters = { stedi: stediEraAdapter(stediEraReport({ transactionId: "era-lineage-original" })) };
  await handleEraImportRequest(fixture.deps, {
    authHeader: "Bearer good",
    body: { ...eraImportBody(), eraId: "era-lineage-original", clearinghouse: "stedi" },
  });
  fixture.created.Claim.push({
    ...buildProfessionalClaim(professionalClaim),
    id: "claim-2",
    related: [{ claim: { reference: "Claim/claim-1" }, relationship: { text: "replacement" } }],
  });
  clock = "2026-07-09T11:00:00.000Z";
  fixture.deps.adapters = { stedi: stediEraAdapter(stediEraReport({ transactionId: "era-lineage-reissue" })) };
  await handleEraImportRequest(fixture.deps, {
    authHeader: "Bearer good",
    body: {
      ...eraImportBody(),
      eraId: "era-lineage-reissue",
      clearinghouse: "stedi",
      claimReferenceByPcn: { "ODOS-CLAIM-900": "Claim/claim-2" },
    },
  });
  clock = "2026-07-09T12:00:00.000Z";
  fixture.deps.adapters = { stedi: stediEraAdapter(stediEraReport({
    transactionId: "era-lineage-reversal",
    claimStatusCode: "22",
    totalClaimChargeAmount: "-125",
    claimPaymentAmount: "-80",
    lineItemChargeAmount: "-125",
    lineItemProviderPaymentAmount: "-80",
    allowedActual: "-80",
  })) };

  const result = await handleEraImportRequest(fixture.deps, {
    authHeader: "Bearer good",
    body: {
      ...eraImportBody(),
      eraId: "era-lineage-reversal",
      clearinghouse: "stedi",
      claimReferenceByPcn: { "ODOS-CLAIM-900": "Claim/claim-2" },
    },
  });

  assert.equal(result.status, 200);
  const batches = fixture.created.Basic.filter((basic) => basic.code?.coding?.some(
    (coding) => coding.code === REMITTANCE_BATCH_CODE,
  ));
  const original = parseRemittanceBatch(batches[0]);
  const reissue = parseRemittanceBatch(batches[1]);
  const reversal = parseRemittanceBatch(batches[2]);
  assert.equal(reversal.allocations[0].reversalOfBatchReference, `Basic/${batches[0].id}`);
  assert.equal(reversal.allocations[0].reversalOfAllocationId, original.allocations[0].id);
  assert.notEqual(reversal.allocations[0].reversalOfAllocationId, reissue.allocations[0].id);
});

test("Stedi reversal follows Claim.related through an unpaid intermediate generation", async () => {
  const fixture = deps();
  fixture.deps.eraUnderpaymentThresholdCents = 100_000;
  fixture.created.Claim.push({ ...buildProfessionalClaim(professionalClaim), id: "claim-1" });
  fixture.deps.adapters = { stedi: stediEraAdapter(stediEraReport({ transactionId: "era-ancestor-original" })) };
  await handleEraImportRequest(fixture.deps, {
    authHeader: "Bearer good",
    body: { ...eraImportBody(), eraId: "era-ancestor-original", clearinghouse: "stedi" },
  });
  fixture.created.Claim.push({
    ...buildProfessionalClaim(professionalClaim),
    id: "claim-2",
    related: [{ claim: { reference: "Claim/claim-1" }, relationship: { text: "replacement" } }],
  });
  fixture.created.Claim.push({
    ...buildProfessionalClaim(professionalClaim),
    id: "claim-3",
    related: [{ claim: { reference: "Claim/claim-2" }, relationship: { text: "replacement" } }],
  });
  fixture.deps.adapters = { stedi: stediEraAdapter(stediEraReport({
    transactionId: "era-ancestor-reversal",
    claimStatusCode: "22",
    totalClaimChargeAmount: "-125",
    claimPaymentAmount: "-80",
    lineItemChargeAmount: "-125",
    lineItemProviderPaymentAmount: "-80",
    allowedActual: "-80",
  })) };

  const result = await handleEraImportRequest(fixture.deps, {
    authHeader: "Bearer good",
    body: {
      ...eraImportBody(),
      eraId: "era-ancestor-reversal",
      clearinghouse: "stedi",
      claimReferenceByPcn: { "ODOS-CLAIM-900": "Claim/claim-3" },
    },
  });

  assert.equal(result.status, 200);
  assert.equal(fixture.created.Task.length, 0);
  const batches = fixture.created.Basic.filter((basic) => basic.code?.coding?.some(
    (coding) => coding.code === REMITTANCE_BATCH_CODE,
  ));
  const original = parseRemittanceBatch(batches[0]);
  const reversal = parseRemittanceBatch(batches[1]);
  assert.equal(reversal.allocations[0].reversalOfBatchReference, `Basic/${batches[0].id}`);
  assert.equal(reversal.allocations[0].reversalOfAllocationId, original.allocations[0].id);
});

test("Stedi allocation retries a version conflict without discarding the concurrent allocation", async () => {
  const fixture = deps();
  fixture.created.Claim.push({ ...buildProfessionalClaim(professionalClaim), id: "claim-1" });
  fixture.deps.adapters = { stedi: stediEraAdapter(stediEraReport({ transactionId: "era-concurrent" })) };
  const originalUpdate = fixture.fhir.update;
  let injectedConflict = false;
  fixture.fhir.update = async (resourceType, id, resource, headers) => {
    if (resourceType === "Basic" && !injectedConflict) {
      injectedConflict = true;
      const index = fixture.created.Basic.findIndex((candidate) => candidate.id === id);
      const current = fixture.created.Basic[index];
      fixture.created.Basic[index] = {
        ...appendRemittanceAllocation(current, {
          id: "concurrent-human-allocation",
          claimReference: "Claim/concurrent",
          claimResponseReference: "ClaimResponse/concurrent",
          amountCents: 500,
          origin: "human-entered",
          recordedAt: "2026-07-09T11:59:00.000Z",
        }),
        meta: { ...current.meta, versionId: "2" },
      };
      throw Object.assign(new Error("FHIR 412 Precondition Failed"), { status: 412 });
    }
    return originalUpdate(resourceType, id, resource, headers);
  };

  const result = await handleEraImportRequest(fixture.deps, {
    authHeader: "Bearer good",
    body: { ...eraImportBody(), eraId: "era-concurrent", clearinghouse: "stedi" },
  });

  assert.equal(result.status, 200);
  const batch = fixture.created.Basic.find((basic) => basic.code?.coding?.some(
    (coding) => coding.code === REMITTANCE_BATCH_CODE,
  ));
  assert.deepEqual(parseRemittanceBatch(batch!).allocations.map((allocation) => allocation.id).sort(), [
    "concurrent-human-allocation",
    parseRemittanceBatch(batch!).allocations.find((allocation) => allocation.id !== "concurrent-human-allocation")!.id,
  ].sort());
  assert.equal(parseRemittanceBatch(batch!).allocations.length, 2);
});

test("Stedi predetermination cannot post money and an accepted zero-paid line is not mislabeled as denied", async () => {
  const predetermination = deps();
  predetermination.created.Claim.push({ ...buildProfessionalClaim(professionalClaim), id: "claim-1" });
  predetermination.deps.adapters = { stedi: stediEraAdapter(stediEraReport({
    transactionId: "era-pricing-only",
    claimStatusCode: "25",
    claimPaymentAmount: "80",
    patientResponsibilityAmount: "20",
    serviceAdjustments: [{
      claimAdjustmentGroupCode: "PR",
      adjustmentReasonCode1: "1",
      adjustmentAmount1: "20",
    }],
  })) };
  const pricingResult = await handleEraImportRequest(predetermination.deps, {
    authHeader: "Bearer good",
    body: { ...eraImportBody(), eraId: "era-pricing-only", clearinghouse: "stedi" },
  });
  assert.equal(pricingResult.status, 200);
  assert.equal(predetermination.created.PaymentReconciliation.length, 0);
  assert.equal(predetermination.created.Invoice.length, 0);
  assert.equal(predetermination.created.Task.length, 1);
  assert.match(taskInput(predetermination.created.Task[0], "stedi-era-review-reason")?.valueString ?? "", /predetermination.*no payment/i);

  const zeroPaid = deps();
  zeroPaid.created.Claim.push({ ...buildProfessionalClaim(professionalClaim), id: "claim-1" });
  zeroPaid.deps.adapters = { stedi: stediEraAdapter(stediEraReport({
    transactionId: "era-zero-paid",
    claimStatusCode: "1",
    totalClaimChargeAmount: "0",
    claimPaymentAmount: "0",
    lineItemChargeAmount: "0",
    lineItemProviderPaymentAmount: "0",
    allowedActual: "0",
  })) };
  const zeroResult = await handleEraImportRequest(zeroPaid.deps, {
    authHeader: "Bearer good",
    body: { ...eraImportBody(), eraId: "era-zero-paid", clearinghouse: "stedi" },
  });
  assert.equal(zeroResult.status, 200);
  assert.equal(
    zeroPaid.created.ClaimResponse[0].item?.[0].adjudication.find((entry) => entry.category.text === "paid")?.amount?.value,
    0,
  );
  assert.deepEqual(pickCounts(zeroResult.body), {
    posted: 0,
    denied: 0,
    underpaid: 0,
    flagged: 0,
    taskIds: [],
  });
});

test("Claim.MD ERA response, worklist evidence, and patient-responsibility Invoice remain byte-for-byte stable", () => {
  const era = {
    eraid: "era-regression",
    paid_date: "2026-07-09",
    payer_name: "SYNTHETIC PAYER",
    payment_method: "ACH",
    claim: {
      pcn: "ODOS-CLAIM-900",
      payer_icn: "ICN-900",
      total_charge: "125.00",
      total_paid: "80.00",
      status_code: "1",
      charge: [{
        remote_chgid: "charge-1",
        proc_code: "PROC-A",
        charge: "125.00",
        allowed: "100.00",
        paid: "80.00",
        adjustment: [
          { group: "CO", code: "45", amount: "5.00" },
          { group: "PR", code: "1", amount: "20.00" },
        ],
      }],
    },
  } satisfies ClaimMdEraData & { claim: NonNullable<ClaimMdEraData["claim"]> };
  const response = buildClaimResponseFromClaimMdEra({
    claimReference: "Claim/claim-1",
    patientReference: "Patient/pat-900",
    insurerReference: "Organization/payer-1",
    providerReference: "Practitioner/prov-1",
    created: "2026-07-11",
    era,
  });
  const claim = { ...buildProfessionalClaim(professionalClaim), id: "claim-1" };
  const evidence = eraWorklistEvidence(era.claim, era.eraid);
  const invoice = buildPatientResponsibilityInvoice(claim, response);
  const digest = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");

  assert.equal(digest(response), "bfc61df66a12c12bd8dd9a89a3a9dd9bb22334219e433acf6e25cf2fb44640bb");
  assert.equal(digest(evidence), "ca795fd6f2f81789d41ef24340d205635f0484e51e4328ea7cc5d17ef3489793");
  assert.equal(digest(invoice), "1ffa22898cd8beb8ab7af87e26a710edc6ac47c4f9236a62aff69a66ef67b8d3");
});

test("re-import updates the same ERA Basic record instead of creating a duplicate", async () => {
  const { created, deps: d } = deps();
  created.Claim.push({ ...buildProfessionalClaim(professionalClaim), id: "claim-1" });
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

test("Stedi ERA routing projects inbound 835 polling rows into the shared remittance queue", async () => {
  const { deps: d } = deps();
  d.routingDefaults = { transaction: "claimmd", era: "stedi" };
  d.adapters = {
    stedi: {
      id: "stedi",
      submitProfessionalClaim: async () => ({}),
      checkEligibility: async () => ({}),
      checkClaimStatus: async () => ({}),
      retrieveEraData: async () => ({}),
      listEras: async () => ({
        items: [{
          transactionId: "7647d644-9348-4596-a3b4-6830b8b48cc8",
          direction: "INBOUND",
          x12: { metadata: { transaction: { transactionSetIdentifier: "835" } } },
        }],
      }),
    },
  };
  const result = await handleEraListRequest(d, { authHeader: "Bearer good" });
  assert.deepEqual(result, {
    status: 200,
    body: { items: [{
      eraId: "7647d644-9348-4596-a3b4-6830b8b48cc8",
      lane: "new",
      posted: 0,
      denied: 0,
      underpaid: 0,
      flagged: 0,
      paidTotalCents: 0,
      openTaskCount: 0,
    }] },
  });
});

test("a rejecting 277CA creates a visible worklist Task naming the rejection reason", async () => {
  const fixture = deps();
  fixture.created.Claim.push({ ...buildProfessionalClaim(professionalClaim), id: "claim-1" });
  fixture.deps.adapters = { stedi: stedi277Adapter({
    "ack-rejected": stedi277HandlerReport("ack-rejected", [
      stedi277HandlerClaim("ODOS-CLAIM-900", "A7", "Invalid procedure code BADCODE."),
    ]),
  }) };

  const result = await handleStedi277ImportRequest(fixture.deps, {
    authHeader: "Bearer good",
    body: { clearinghouse: "stedi", startDateTime: "2026-07-22T00:00:00.000Z" },
  });

  assert.equal(result.status, 200);
  assert.equal((result.body as { nextPageToken?: string }).nextPageToken, "stedi-next-page");
  assert.equal(fixture.created.Task.length, 1);
  assert.equal(fixture.created.Task[0].focus?.reference, "Claim/claim-1");
  assert.match(taskInput(fixture.created.Task[0], "claimmd-message")?.valueString ?? "", /BADCODE/);
  assert.equal(fixture.created.ClaimResponse.length, 0);
});

test("one 277CA referencing three claims produces accepted, rejected, and informational outcomes", async () => {
  const fixture = deps();
  fixture.created.Claim.push(
    { ...buildProfessionalClaim({ ...professionalClaim, patientAccountNumber: "PCN-A" }), id: "claim-a" },
    { ...buildProfessionalClaim({ ...professionalClaim, patientAccountNumber: "PCN-B" }), id: "claim-b" },
    { ...buildProfessionalClaim({ ...professionalClaim, patientAccountNumber: "PCN-C" }), id: "claim-c" },
  );
  fixture.deps.adapters = { stedi: stedi277Adapter({
    "ack-three": stedi277HandlerReport("ack-three", [
      stedi277HandlerClaim("PCN-A", "A2", "Accepted for processing."),
      stedi277HandlerClaim("PCN-B", "A3", "Returned as unprocessable."),
      stedi277HandlerClaim("PCN-C", "A1", "Received and forwarded."),
    ]),
  }) };

  const result = await handleStedi277ImportRequest(fixture.deps, {
    authHeader: "Bearer good",
    body: { clearinghouse: "stedi" },
  });

  assert.deepEqual((result.body as any).acknowledgments[0].claims.map((claim: any) => claim.outcome), [
    "accepted-for-processing", "rejected", "informational",
  ]);
  assert.equal(fixture.created.Task.length, 1);
  assert.equal(fixture.created.Task[0].focus?.reference, "Claim/claim-b");
});

test("reprocessing the same 277CA creates no duplicate Task or ClaimResponse", async () => {
  const fixture = deps();
  fixture.created.Claim.push({ ...buildProfessionalClaim(professionalClaim), id: "claim-1" });
  fixture.deps.adapters = { stedi: stedi277Adapter({
    "ack-retry": stedi277HandlerReport("ack-retry", [
      stedi277HandlerClaim("ODOS-CLAIM-900", "A6", "Missing subscriber information."),
    ]),
  }) };

  await handleStedi277ImportRequest(fixture.deps, { authHeader: "Bearer good", body: { clearinghouse: "stedi" } });
  await handleStedi277ImportRequest(fixture.deps, { authHeader: "Bearer good", body: { clearinghouse: "stedi" } });

  assert.equal(fixture.created.Task.length, 1);
  assert.equal(fixture.created.ClaimResponse.length, 0);
  assert.equal(
    fixture.createHeaders.filter((write) => write.resourceType === "Task").every((write) =>
      write.headers?.["If-None-Exist"]?.includes("stedi-277ca")),
    true,
  );
});

test("an unmappable 277CA category is surfaced for review and never accepted", async () => {
  const fixture = deps();
  fixture.created.Claim.push({ ...buildProfessionalClaim(professionalClaim), id: "claim-1" });
  fixture.deps.adapters = { stedi: stedi277Adapter({
    "ack-unknown": stedi277HandlerReport("ack-unknown", [
      stedi277HandlerClaim("ODOS-CLAIM-900", "ZZ", "Non-compliant category."),
    ]),
  }) };

  const result = await handleStedi277ImportRequest(fixture.deps, {
    authHeader: "Bearer good",
    body: { clearinghouse: "stedi" },
  });

  assert.equal((result.body as any).acknowledgments[0].status, "review");
  assert.equal((result.body as any).acknowledgments[0].claims[0].outcome, "review");
  assert.equal(fixture.created.Task.length, 1);
  assert.match(taskInput(fixture.created.Task[0], "claimmd-message")?.valueString ?? "", /ZZ.*requires review/i);
});

test("one malformed 277CA is flagged without preventing the rest of the batch", async () => {
  const fixture = deps();
  fixture.created.Claim.push({ ...buildProfessionalClaim(professionalClaim), id: "claim-1" });
  fixture.deps.adapters = { stedi: stedi277Adapter({
    "ack-malformed": { meta: { transactionId: "ack-malformed" }, transactions: "not-an-array" },
    "ack-good": stedi277HandlerReport("ack-good", [
      stedi277HandlerClaim("ODOS-CLAIM-900", "A7", "Invalid procedure code BADCODE."),
    ]),
  }) };

  const result = await handleStedi277ImportRequest(fixture.deps, {
    authHeader: "Bearer good",
    body: { clearinghouse: "stedi" },
  });

  assert.equal(result.status, 200);
  assert.deepEqual((result.body as any).acknowledgments.map((ack: any) => ack.status), ["review", "processed"]);
  assert.equal(fixture.created.Task.length, 2);
  assert.match(taskInput(fixture.created.Task[0], "claimmd-message")?.valueString ?? "", /malformed/i);
  assert.match(taskInput(fixture.created.Task[1], "claimmd-message")?.valueString ?? "", /BADCODE/);
});

test("a failure-path audit error is logged without aborting the 277CA batch", async () => {
  const fixture = deps();
  fixture.created.Claim.push({ ...buildProfessionalClaim(professionalClaim), id: "claim-1" });
  fixture.deps.recordAudit = async () => {
    throw new Error("synthetic audit outage");
  };
  fixture.deps.adapters = { stedi: stedi277Adapter({
    "ack-malformed-audit": { meta: { transactionId: "ack-malformed-audit" }, transactions: "not-an-array" },
    "ack-good-after-audit": stedi277HandlerReport("ack-good-after-audit", [
      stedi277HandlerClaim("ODOS-CLAIM-900", "A2", "Accepted for processing."),
    ]),
  }) };
  const logged: unknown[][] = [];
  const originalConsoleError = console.error;
  console.error = (...args: unknown[]) => {
    logged.push(args);
  };

  try {
    const result = await handleStedi277ImportRequest(fixture.deps, {
      authHeader: "Bearer good",
      body: { clearinghouse: "stedi" },
    });

    assert.equal(result.status, 200);
    assert.deepEqual((result.body as any).acknowledgments.map((ack: any) => ack.status), ["review", "processed"]);
    assert.match(logged.flat().join(" "), /ack-malformed-audit.*audit outage/i);
  } finally {
    console.error = originalConsoleError;
  }
});

test("277CA import returns a clear unsupported response for Claim.MD", async () => {
  const fixture = deps();
  const result = await handleStedi277ImportRequest(fixture.deps, {
    authHeader: "Bearer good",
    body: { clearinghouse: "claimmd" },
  });
  assert.equal(result.status, 501);
  assert.match((result.body as { error: string }).error, /not support 277CA/i);
});

test("an empty 277CA poll advances the cursor without scanning the local Claim population", async () => {
  const fixture = deps();
  fixture.deps.adapters = { stedi: stedi277Adapter({}) };

  const result = await handleStedi277ImportRequest(fixture.deps, {
    authHeader: "Bearer good",
    body: { clearinghouse: "stedi" },
  });

  assert.equal(result.status, 200);
  assert.equal((result.body as { nextPageToken?: string }).nextPageToken, "stedi-next-page");
  assert.equal(fixture.searchCalls(), 0);
});

test("ERA matched zero-pay claim creates a denial Task with verbatim adjustment pairs and audit", async () => {
  const { audits, created, deps: d } = deps();
  created.Claim.push({ ...buildProfessionalClaim(professionalClaim), id: "claim-1" });
  d.adapter!.retrieveEraData = async () => ({
    eraid: "era-900",
    paid_date: "2026-07-09",
    payer_name: "SYNTHETIC PAYER",
    claim: {
      pcn: "ODOS-CLAIM-900",
      payer_icn: "ICN-ZERO",
      total_charge: "125.00",
      total_paid: "0.00",
      status_code: "1",
      charge: [{
        chgid: "claimmd-charge-zero",
        remote_chgid: "charge-1",
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
    system: "https://odos2020.com/fhir/NamingSystem/claimmd-era",
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
      pcn: "ODOS-CLAIM-900",
      payer_icn: "ICN-UNDER",
      total_charge: "125.00",
      total_paid: "70.00",
      status_code: "1",
      charge: [{
        chgid: "claimmd-charge-under",
        remote_chgid: "charge-1",
        proc_code: "PROC-A",
        charge: "125.00",
        allowed: "100.00",
        paid: "70.00",
        adjustment: { group: "PR", code: "1", amount: "20.00" },
      }],
    },
  };
  const flagged = deps();
  flagged.created.Claim.push({ ...buildProfessionalClaim(professionalClaim), id: "claim-1" });
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
  belowThreshold.created.Claim.push({ ...buildProfessionalClaim(professionalClaim), id: "claim-1" });
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

test("patient-responsibility Invoice is create-once; a differing remit preserves money and opens one exception", async () => {
  const fixture = deps();
  fixture.created.Claim.push({ ...buildProfessionalClaim(professionalClaim), id: "claim-1" });
  const era = (patientResponsibilityEra(17_189) as { claim: { charge: Array<{ adjustment: { amount: string } }> } });
  fixture.deps.adapter!.retrieveEraData = async () => era as any;

  const first = await handleEraImportRequest(fixture.deps, { authHeader: "Bearer good", body: eraImportBody() });
  const repeated = await handleEraImportRequest(fixture.deps, { authHeader: "Bearer good", body: eraImportBody() });

  assert.equal(first.status, 200);
  assert.equal(repeated.status, 200);
  assert.equal(fixture.created.Invoice.length, 1);
  assert.equal(fixture.created.Invoice[0].totalNet?.value, 171.89);
  assert.equal(
    fixture.createHeaders.find((write) => write.resourceType === "Invoice")?.headers?.["If-None-Exist"],
    "identifier=https://odos2020.com/fhir/NamingSystem/patient-responsibility-invoice|Claim/claim-1",
  );
  assert.equal(fixture.created.Task.length, 0);

  era.claim.charge[0].adjustment.amount = "170.00";
  const differing = await handleEraImportRequest(fixture.deps, { authHeader: "Bearer good", body: eraImportBody() });

  assert.equal(differing.status, 200);
  assert.equal(fixture.created.Invoice.length, 1);
  assert.equal(fixture.created.Invoice[0].totalNet?.value, 171.89);
  assert.equal(fixture.created.Task.length, 1);
  assert.equal(worklistCode(fixture.created.Task[0]), "era-underpayment");

  const retriedDifference = await handleEraImportRequest(fixture.deps, { authHeader: "Bearer good", body: eraImportBody() });
  assert.equal(retriedDifference.status, 200);
  assert.equal(fixture.created.Task.length, 1);
});

test("insurance visit flows Claim to ERA to PR Invoice to the unchanged T0 statement at $171.89", async () => {
  const fixture = deps();
  const claim = { ...buildProfessionalClaim(professionalClaim), id: "claim-1" };
  fixture.created.Claim.push(claim);
  fixture.created.Patient.push({
    resourceType: "Patient",
    id: "pat-900",
    birthDate: "1980-01-02",
    name: [{ text: "Jamie Synthetic" }],
  });
  fixture.deps.adapter!.retrieveEraData = async () => patientResponsibilityEra(17_189);

  const imported = await handleEraImportRequest(fixture.deps, { authHeader: "Bearer good", body: eraImportBody() });
  const invoice = fixture.created.Invoice[0];
  const statementResult = await handleGeneratePatientStatementRequest({
    authenticate: async () => ({
      staffReference: "Practitioner/staff-1",
      actorRole: "staff",
      roles: ["staff"],
      fhir: fixture.fhir,
    }),
    now: () => "2026-07-12T12:00:00.000Z",
    generateId: (() => { let id = 0; return () => `statement-${++id}`; })(),
  }, { authHeader: "Bearer good", body: { patientReference: "Patient/pat-900" } });

  assert.equal(imported.status, 200);
  assert.equal(statementResult.status, 200);
  assert.equal(invoice.lineItem?.[0]?.chargeItemReference?.reference, "ChargeItem/charge-1");
  assert.equal(invoice.extension?.find((extension) => extension.url === ODOS_SOURCE_CLAIM_EXTENSION_URL)
    ?.valueReference?.reference, "Claim/claim-1");
  assert.equal(invoice.totalGross?.value, 171.89);
  assert.equal(invoice.totalNet?.value, 171.89);
  assert.equal((statementResult.body as StatementRunResult).statements[0].balanceCents, 17_189);
});

test("zero-PR and denied remits do not emit a patient-responsibility Invoice", async () => {
  const zero = deps();
  zero.created.Claim.push({ ...buildProfessionalClaim(professionalClaim), id: "claim-1" });
  await handleEraImportRequest(zero.deps, { authHeader: "Bearer good", body: eraImportBody() });
  assert.equal(zero.created.Invoice.length, 0);

  const denied = deps();
  denied.created.Claim.push({ ...buildProfessionalClaim(professionalClaim), id: "claim-1" });
  const denial = patientResponsibilityEra(5_000) as any;
  denial.claim.total_paid = "0.00";
  denial.claim.status_code = "4";
  denial.claim.charge[0].paid = "0.00";
  denied.deps.adapter!.retrieveEraData = async () => denial;
  await handleEraImportRequest(denied.deps, { authHeader: "Bearer good", body: eraImportBody() });
  assert.equal(denied.created.Invoice.length, 0);
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
  assert.equal(task.groupIdentifier?.system, CLAIMMD_ERA_PAYMENT_SYSTEM);
  assert.equal(task.focus, undefined);
  assert.equal(task.for, undefined);
  assert.equal(taskInput(task, "pcn")?.valueString, "ODOS-CLAIM-900");
  assert.equal(taskInput(task, "payer-icn")?.valueString, "ICN-900");
  assert.equal(taskInput(task, "charged-cents")?.valueInteger, 12_500);
  assert.equal(taskInput(task, "allowed-cents")?.valueInteger, 8_000);
  assert.equal(taskInput(task, "paid-cents")?.valueInteger, 8_000);
  assert.deepEqual(eraSnapshotFromTask(task).claim, era.claim);
  assert.equal(audits.some((row) => row.eventType === "era.unmatched.flagged"), true);
});

test("legacy disposition remains typed and is accepted only for an unmatched remit", async () => {
  const unmatched = deps();
  await handleEraImportRequest(unmatched.deps, {
    authHeader: "Bearer good",
    body: { ...eraImportBody(), claimReferenceByPcn: {}, patientReferenceByPcn: {} },
  });
  await handleClaimEraWorklistTaskRequest(unmatched.deps, {
    authHeader: "Bearer good",
    params: { id: "task-1" },
  });

  const legacy = await handleResolveEraWorklistTaskRequest(unmatched.deps, {
    authHeader: "Bearer good",
    params: { id: "task-1" },
    body: { disposition: "legacy" },
  });

  assert.equal(legacy.status, 200);
  assert.equal(taskOutput(unmatched.created.Task[0], "disposition")?.valueCode, "legacy");
  assert.equal(
    projectEraWorklistTask(unmatched.created.Task[0], "2026-07-10T12:00:00.000Z").resolutionDisposition,
    "legacy",
  );

  const liveClaim = deps();
  liveClaim.deps.adapter!.submitProfessionalClaim = async () => {
    throw new Error("Claim.MD edit rejection R-17");
  };
  await handleSubmitClaimRequest(liveClaim.deps, {
    authHeader: "Bearer good",
    body: { claim: professionalClaim },
  });
  await handleClaimEraWorklistTaskRequest(liveClaim.deps, {
    authHeader: "Bearer good",
    params: { id: "task-1" },
  });
  const rejected = await handleResolveEraWorklistTaskRequest(liveClaim.deps, {
    authHeader: "Bearer good",
    params: { id: "task-1" },
    body: { disposition: "legacy" },
  });
  assert.deepEqual(rejected, {
    status: 400,
    body: { error: "legacy is only valid for an era-unmatched Task." },
  });
});

test("ERA worklist resolve-as-rebilled records the Claim reference and rejects missing disposition", async () => {
  const { created, deps: d } = deps();
  d.adapter!.retrieveEraData = async () => ({
    eraid: "era-zero",
    paid_date: "2026-07-09",
    claim: {
      pcn: "ODOS-CLAIM-900",
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

  const forbidden = deps("provider");
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

test("a per-person claims.manage revocation overrides the staff role on Claim.MD handlers", async () => {
  const fixture = deps();
  const result = await handleEraWorklistRequest({
    ...fixture.deps,
    authenticate: async () => ({
      staffReference: "Practitioner/staff-1",
      actorRole: "staff",
      businessActions: [],
      fhir: fixture.fhir,
    }),
  }, { authHeader: "Bearer good" });

  assert.deepEqual(result, {
    status: 403,
    body: { error: "claims.manage role required" },
  });
  assert.equal(fixture.searchCalls(), 0);
});

test("claims worklist maps an unavailable staff-role service to a clean 503", async () => {
  const fixture = deps();
  const result = await handleEraWorklistRequest({
    ...fixture.deps,
    authenticate: async () => { throw new StaffRoleServiceUnavailableError(new Error("refresh failed")); },
  }, { authHeader: "Bearer good" });

  assert.deepEqual(result, {
    status: 503,
    body: { error: "Claims service temporarily unavailable." },
  });
  assert.equal(fixture.searchCalls(), 0);
});

test("claims.manage protects GET /claims/era with the existing claims 401/403 shapes", async () => {
  const unauthenticated = deps();
  assert.deepEqual(await handleEraListRequest(unauthenticated.deps, { authHeader: undefined }), {
    status: 401,
    body: { error: "Authentication required to manage claims." },
  });
  assert.equal(unauthenticated.searchCalls(), 0);

  const forbidden = deps("provider");
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

test("remittance list exposes unallocated remainder and age using remittance date before creation date", async () => {
  const fixture = deps();
  const list = (claimHandlers as unknown as {
    handleRemittanceBatchListRequest?: typeof handleEraListRequest;
  }).handleRemittanceBatchListRequest;
  assert.equal(typeof list, "function");
  fixture.created.Basic.push({
    ...buildRemittanceBatch({
      payerReference: "Organization/payer-1",
      paymentReference: "TRACE-LIST",
      remittanceDate: "2026-07-01",
      creationDate: "2026-07-08T12:00:00.000Z",
      totalAmountCents: 10_000,
      provenance: "clearinghouse",
      sourceReference: "urn:stedi:835:list",
    }),
    id: "batch-list",
  });
  fixture.created.Basic.push({
    ...buildProviderAdjustment({
      batchReference: "Basic/batch-list",
      payerReference: "Organization/payer-1",
      identifier: "PLB-LIST",
      reasonText: "Provider adjustment",
      rawSourceAmountCents: -1_000,
      sourceSystem: "stedi-835",
      createdAt: "2026-07-08T12:00:00.000Z",
    }),
    id: "plb-list",
  });

  const result = await list!(fixture.deps, { authHeader: "Bearer good" });

  assert.equal(result.status, 200);
  assert.deepEqual((result.body as any).items.map((item: any) => ({
    id: item.id,
    ageDays: item.ageDays,
    providerActivityCents: item.providerActivityCents,
    unallocatedAmountCents: item.unallocatedAmountCents,
    balanced: item.balanced,
  })), [{
    id: "batch-list",
    ageDays: 8,
    providerActivityCents: 1_000,
    unallocatedAmountCents: 9_000,
    balanced: false,
  }]);
});

test("manual EOB routes preserve claims.manage 401/403 parity before FHIR access", async () => {
  const unauthenticated = deps();
  assert.deepEqual(await handleCreateManualEobRequest(unauthenticated.deps, {
    authHeader: undefined,
    body: {},
  }), {
    status: 401,
    body: { error: "Authentication required to manage claims." },
  });
  assert.deepEqual(await handlePostManualEobClaimRequest(unauthenticated.deps, {
    authHeader: undefined,
    params: { id: "eob-1" },
    body: {},
  }), {
    status: 401,
    body: { error: "Authentication required to manage claims." },
  });

  const forbidden = deps("provider");
  assert.deepEqual(await handleManualEobListRequest(forbidden.deps, { authHeader: "Bearer good" }), {
    status: 403,
    body: { error: "claims.manage role required" },
  });
  assert.deepEqual(await handleCloseManualEobRequest(forbidden.deps, {
    authHeader: "Bearer good",
    params: { id: "eob-1" },
  }), {
    status: 403,
    body: { error: "claims.manage role required" },
  });
  assert.equal(unauthenticated.searchCalls(), 0);
  assert.equal(forbidden.searchCalls(), 0);
});

test("manual EOB posts ClaimResponse and insurance payment while retaining a resumable partial header", async () => {
  const { audits, created, deps: d } = deps();
  created.Claim.push({ ...buildProfessionalClaim(professionalClaim), id: "claim-1" });
  const createdHeader = await handleCreateManualEobRequest(d, {
    authHeader: "Bearer good",
    body: {
      payerReference: "Organization/payer-1",
      paymentReference: "EFT-900",
      paymentDate: "2026-07-10",
      depositDate: "2026-07-11",
      totalAmountCents: 10_000,
    },
  });
  assert.equal(createdHeader.status, 201);

  const posted = await handlePostManualEobClaimRequest(d, {
    authHeader: "Bearer good",
    params: { id: "basic-1" },
    body: {
      claimReference: "Claim/claim-1",
      lines: [{
        itemSequence: 1,
        allowedCents: 10_000,
        paidCents: 7_000,
        deductibleCents: 1_000,
        coinsuranceCents: 1_200,
        copayCents: 800,
      }],
    },
  });

  assert.equal(posted.status, 201);
  assert.equal(created.ClaimResponse.length, 1);
  assert.equal(created.PaymentReconciliation.length, 1);
  assert.equal(created.Basic.length, 1);
  const adjudications = created.ClaimResponse[0].item?.[0]?.adjudication ?? [];
  assert.equal(adjudications.find((entry) => entry.category.text === "patient responsibility")?.amount?.value, 30);
  assert.equal(adjudications.find((entry) => entry.category.text === "adjustment PR 1")?.amount?.value, 10);
  assert.equal(adjudications.find((entry) => entry.category.text === "adjustment PR 2")?.amount?.value, 12);
  assert.equal(adjudications.find((entry) => entry.category.text === "adjustment PR 3")?.amount?.value, 8);
  assert.equal(created.PaymentReconciliation[0].detail?.[0]?.request?.reference, "Claim/claim-1");
  assert.equal(created.PaymentReconciliation[0].detail?.[0]?.response?.reference, "ClaimResponse/claimresponse-1");
  assert.deepEqual(parseManualEobHeader(created.Basic[0]), {
    id: "basic-1",
    payerReference: "Organization/payer-1",
    paymentReference: "EFT-900",
    paymentDate: "2026-07-10",
    depositDate: "2026-07-11",
    totalAmountCents: 10_000,
    appliedAmountCents: 7_000,
    remainingAmountCents: 3_000,
    status: "draft",
    createdAt: "2026-07-09T12:00:00.000Z",
    provenance: "manual",
    sourceReference: "urn:odos:manual-eob:EFT-900",
    postings: [{
      claimReference: "Claim/claim-1",
      claimResponseReference: "ClaimResponse/claimresponse-1",
      paymentReconciliationReference: "PaymentReconciliation/paymentreconciliation-1",
      amountCents: 7_000,
      postedAt: "2026-07-09T12:00:00.000Z",
    }],
  });
  assert.equal(audits.at(-1)?.eventType, "claim.manual-eob.posted");

  const resumed = await handleManualEobListRequest(d, { authHeader: "Bearer good" });
  const item = (resumed.body as { items: Array<{ appliedAmountCents: number; status: string }> }).items[0];
  assert.equal(item.appliedAmountCents, 7_000);
  assert.equal(item.status, "draft");
});

test("manual EOB audit migration uses drop-and-re-add and registers its claims event", () => {
  const sql = readFileSync(
    resolve(process.cwd(), "../data/migrations/2026-07-10-manual-eob-event.sql"),
    "utf8",
  );
  const dropIndex = sql.indexOf("DROP CONSTRAINT IF EXISTS odos_audit_events_event_type_check");
  const addIndex = sql.indexOf("ADD CONSTRAINT odos_audit_events_event_type_check CHECK");
  assert.ok(dropIndex >= 0);
  assert.ok(addIndex > dropIndex);
  assert.match(sql, /'claim\.manual-eob\.posted'/);
});

test("line-linkage audit migration uses drop-and-re-add and registers its claims event", () => {
  const sql = readFileSync(
    resolve(process.cwd(), "../data/migrations/2026-07-15-era-line-linkage-event.sql"),
    "utf8",
  );
  const validationSql = readFileSync(
    resolve(process.cwd(), "../data/migrations/2026-07-15-era-line-linkage-event.validate.sql"),
    "utf8",
  );
  const dropIndex = sql.indexOf("DROP CONSTRAINT IF EXISTS odos_audit_events_event_type_check");
  const addIndex = sql.indexOf("ADD CONSTRAINT odos_audit_events_event_type_check CHECK");
  assert.ok(dropIndex >= 0);
  assert.ok(addIndex > dropIndex);
  assert.match(sql, /'era\.line-linkage\.flagged'/);
  assert.match(sql, /\) NOT VALID;/);
  assert.doesNotMatch(sql, /VALIDATE CONSTRAINT/);
  assert.match(validationSql, /VALIDATE CONSTRAINT odos_audit_events_event_type_check/);
});

test("claims.manage denial happens before adapter calls or audit writes", async () => {
  const { audits, deps: d } = deps("provider");
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

test("claim-write failure and retry reuse the same conditionally-created ChargeItem", async () => {
  const fixture = deps();
  fixture.created.ChargeItem.length = 0;
  const input = structuredClone(professionalClaim);
  delete input.chargeItems[0].id;
  fixture.failClaimCreate(new Error("FHIR Claim create rejected the resource"));

  const failed = await handleSubmitClaimRequest(fixture.deps, {
    authHeader: "Bearer good",
    body: { claim: input },
  });
  const retried = await handleSubmitClaimRequest(fixture.deps, {
    authHeader: "Bearer good",
    body: { claim: input },
  });

  assert.equal(failed.status, 502);
  assert.equal(retried.status, 200);
  assert.equal(fixture.created.ChargeItem.length, 1);
  assert.equal(fixture.created.Claim[0].item?.[0]?.extension?.[0]?.valueReference?.reference, "ChargeItem/chargeitem-1");
  assert.equal(
    fixture.createHeaders.filter((write) => write.resourceType === "ChargeItem").every((write) =>
      write.headers?.["If-None-Exist"] === "identifier=https://odos2020.com/fhir/NamingSystem/claim-charge-item|ODOS-CLAIM-900:1"),
    true,
  );
});

function eraImportBody(): Record<string, unknown> {
  return {
    eraId: "era-900",
    claimReferenceByPcn: { "ODOS-CLAIM-900": "Claim/claim-1" },
    patientReferenceByPcn: { "ODOS-CLAIM-900": "Patient/pat-900" },
    insurerReference: "Organization/payer-1",
    providerReference: "Practitioner/prov-1",
    practiceOrgReference: "Organization/practice-1",
  };
}

function stediEraAdapter(raw: unknown): any {
  return {
    id: "stedi",
    submitProfessionalClaim: async () => ({}),
    checkEligibility: async () => ({}),
    checkClaimStatus: async () => ({}),
    listEras: async () => ({}),
    retrieveEraData: async () => raw,
  };
}

function stediSubmissionAdapter(onSubmit: (request: any) => void): any {
  return {
    id: "stedi",
    mode: "test",
    submitterId: "SUBMITTER900",
    submitProfessionalClaim: async (request: any) => {
      onSubmit(request);
      return { claimReference: { correlationId: "stedi-resubmission", customerClaimNumber: "tracking-resubmission" } };
    },
    checkEligibility: async () => ({}),
    checkClaimStatus: async () => ({}),
    listEras: async () => ({}),
    retrieveEraData: async () => ({}),
  };
}

function stedi277Adapter(reports: Record<string, unknown>): any {
  return {
    id: "stedi",
    submitProfessionalClaim: async () => ({}),
    checkEligibility: async () => ({}),
    checkClaimStatus: async () => ({}),
    listEras: async () => ({}),
    retrieveEraData: async () => ({}),
    list277s: async () => ({
      items: Object.keys(reports).map((transactionId) => ({
        transactionId,
        direction: "INBOUND",
        x12: { metadata: { transaction: { transactionSetIdentifier: "277" } } },
      })),
      nextPageToken: "stedi-next-page",
    }),
    retrieve277Data: async (transactionId: string) => reports[transactionId],
  };
}

function stedi277HandlerReport(transactionId: string, claims: unknown[]): Record<string, unknown> {
  return {
    meta: { transactionId, traceId: `TRACE-${transactionId}` },
    transactions: [{
      controlNumber: `CONTROL-${transactionId}`,
      payers: [{
        organizationName: "SYNTHETIC PAYER",
        entityIdentifierCodeValue: "Payer",
        payerIdentification: "PAYER900",
        claimStatusTransactions: [{
          claimTransactionBatchNumber: `BATCH-${transactionId}`,
          claimStatusDetails: [{ patientClaimStatusDetails: [{ claims }] }],
        }],
      }],
    }],
  };
}

function stedi277HandlerClaim(patientControlNumber: string, categoryCode: string, reason: string): Record<string, unknown> {
  return {
    claimStatus: {
      referencedTransactionTraceNumber: patientControlNumber,
      informationClaimStatuses: [{
        statusMessage: reason,
        informationStatuses: [{
          healthCareClaimStatusCategoryCode: categoryCode,
          healthCareClaimStatusCategoryCodeValue: `Category ${categoryCode}`,
          statusCode: "21",
          statusCodeValue: reason,
          entityIdentifierCodeValue: "Payer",
        }],
      }],
    },
  };
}

function stediEraReport(input: {
  transactionId: string;
  claimStatusCode?: string;
  totalClaimChargeAmount?: string;
  claimPaymentAmount?: string;
  patientResponsibilityAmount?: string;
  lineItemChargeAmount?: string;
  lineItemProviderPaymentAmount?: string;
  allowedActual?: string;
  serviceAdjustments?: Array<Record<string, string>>;
  totalProviderPaymentAmount?: string;
}): Record<string, unknown> {
  return {
    meta: { transactionId: input.transactionId },
    transactions: [{
      payer: { name: "SYNTHETIC PAYER" },
      financialInformation: {
        checkIssueOrEFTEffectiveDate: "20260709",
        totalActualProviderPaymentAmount: input.totalProviderPaymentAmount ?? input.claimPaymentAmount ?? "80",
      },
      paymentAndRemitReassociationDetails: { checkOrEFTTraceNumber: `TRACE-${input.transactionId}` },
      detailInfo: [{ paymentInfo: [{
        claimPaymentInfo: {
          patientControlNumber: "ODOS-CLAIM-900",
          totalClaimChargeAmount: input.totalClaimChargeAmount ?? "125",
          claimPaymentAmount: input.claimPaymentAmount ?? "80",
          ...(input.patientResponsibilityAmount !== undefined
            ? { patientResponsibilityAmount: input.patientResponsibilityAmount }
            : {}),
          payerClaimControlNumber: "PAYER900",
          claimStatusCode: input.claimStatusCode ?? "1",
        },
        serviceLines: [{
          lineItemControlNumber: "charge-1",
          servicePaymentInformation: {
            lineItemChargeAmount: input.lineItemChargeAmount ?? "125",
            lineItemProviderPaymentAmount: input.lineItemProviderPaymentAmount ?? "80",
            adjudicatedProcedureCode: "PROC-A",
          },
          serviceSupplementalAmounts: { allowedActual: input.allowedActual ?? "100" },
          ...(input.serviceAdjustments ? { serviceAdjustments: input.serviceAdjustments } : {}),
        }],
      }] }],
    }],
  };
}

function patientResponsibilityEra(amountCents: number): ClaimMdEraData {
  const amount = (amountCents / 100).toFixed(2);
  const paid = 100;
  return {
    eraid: "era-pr",
    paid_date: "2026-07-09",
    payer_name: "SYNTHETIC PAYER",
    claim: {
      pcn: "ODOS-CLAIM-900",
      payer_icn: "ICN-PR",
      total_charge: "300.00",
      total_paid: paid.toFixed(2),
      status_code: "1",
      charge: [{
        chgid: "claimmd-charge-pr",
        remote_chgid: "charge-1",
        proc_code: "PROC-A",
        charge: "300.00",
        allowed: ((paid * 100 + amountCents) / 100).toFixed(2),
        paid: paid.toFixed(2),
        adjustment: { group: "PR", code: "1", amount },
      }],
    },
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
    if (params._id && !params._id.split(",").includes(task.id ?? "")) return false;
    if (params.identifier && !matchesIdentifierToken(task.identifier, params.identifier)) return false;
    if (params.code && !matchesCodingToken(task.code?.coding, params.code)) return false;
    if (params.focus && task.focus?.reference !== params.focus) return false;
    if (params["business-status"] && !matchesCodingToken(task.businessStatus?.coding, params["business-status"])) return false;
  }
  if (resource.resourceType === "Invoice") {
    const invoice = resource as Invoice;
    if (params.identifier && !matchesIdentifierToken(invoice.identifier, params.identifier)) return false;
    if (params.status && invoice.status !== params.status) return false;
    if (params.subject && invoice.subject?.reference !== params.subject) return false;
  }
  if (resource.resourceType === "Claim") {
    const claim = resource as Claim;
    if (params.identifier && !matchesIdentifierToken(claim.identifier, params.identifier)) return false;
  }
  if (resource.resourceType === "Patient") {
    const patient = resource as Patient;
    if (params._id && !params._id.split(",").includes(patient.id ?? "")) return false;
  }
  if (resource.resourceType === "PaymentReconciliation") {
    const payment = resource as PaymentReconciliation;
    if (params.status && payment.status !== params.status) return false;
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
