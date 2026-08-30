import assert from "node:assert/strict";
import { test } from "node:test";
import type { Bundle, Claim, ClaimResponse, Resource } from "@medplum/fhirtypes";
import { handleClaimSearchRequest, type ClaimsHandlerDeps } from "../src/claims/claimmd-handlers.js";
import type { ClaimReadModelStore } from "../src/claims/claim-read-model-store.js";
import {
  buildClaimResponseFromClaimMdStatus,
  buildProfessionalClaim,
  type ProfessionalClaimInput,
} from "../src/claims/claimmd-fhir.js";

test("claims.manage protects GET /claims/search with the existing claims 401/403 bodies", async () => {
  const unauthenticated = fixture(undefined);
  assert.deepEqual(await handleClaimSearchRequest(unauthenticated.deps, { authHeader: undefined }), {
    status: 401,
    body: { error: "Authentication required to manage claims." },
  });
  assert.equal(unauthenticated.searchCalls(), 0);

  const forbidden = fixture("provider");
  assert.deepEqual(await handleClaimSearchRequest(forbidden.deps, { authHeader: "Bearer good" }), {
    status: 403,
    body: { error: "claims.manage role required" },
  });
  assert.equal(forbidden.searchCalls(), 0);
});

test("GET /claims/search supports patient name, claim number, and derived status combinations", async () => {
  const { deps } = fixture("staff");
  const patient = await handleClaimSearchRequest(deps, {
    authHeader: "Bearer good",
    query: { patient: "Jamie Two" },
  });
  const claim = await handleClaimSearchRequest(deps, {
    authHeader: "Bearer good",
    query: { claim: "ODOS-CLAIM-1" },
  });
  const status = await handleClaimSearchRequest(deps, {
    authHeader: "Bearer good",
    query: { status: "rejected" },
  });

  assert.deepEqual(references(patient), ["Claim/claim-2"]);
  assert.deepEqual(references(claim), ["Claim/claim-1"]);
  assert.deepEqual(references(status), ["Claim/claim-2"]);
});

test("GET /claims/search returns explicit projection failure instead of stale items", async () => {
  const { deps } = fixture("staff");
  let readModelCalls = 0;
  deps.claimReadModel = {
    search: async () => {
      readModelCalls += 1;
      return [];
    },
  } as unknown as ClaimReadModelStore;
  const failedProjection = {
    state: "failed" as const,
    lastAttemptAt: "2026-08-30T11:59:00.000Z",
    lastSuccessfulAt: "2026-08-30T11:50:00.000Z",
    lastFailureAt: "2026-08-30T11:59:00.000Z",
    invalidatedAt: null,
    staleAfterMs: 180_000,
  };
  (deps as ClaimsHandlerDeps & { projectionHealth: { status(at: string): typeof failedProjection } }).projectionHealth = {
    status: () => failedProjection,
  };

  const result = await handleClaimSearchRequest(deps, { authHeader: "Bearer good" });

  assert.deepEqual(result, {
    status: 503,
    body: {
      error: "Claim read model projection is failed; FHIR remains authoritative.",
      projection: failedProjection,
    },
  });
  assert.equal(readModelCalls, 0);
});

function fixture(role: "staff" | "provider" | undefined) {
  let calls = 0;
  const claim1 = claimResource(1);
  const claim2 = claimResource(2);
  const response2: ClaimResponse = {
    ...buildClaimResponseFromClaimMdStatus({
      claimReference: "Claim/claim-2",
      patientReference: "Patient/patient-2",
      insurerReference: "Organization/payer-1",
      created: "2026-07-09T12:00:00.000Z",
      status: { result: { claim: { status_code: "4", messages: { message: "Rejected" } } } },
    }),
    id: "response-2",
  };
  const resources: Resource[] = [
    claim1,
    claim2,
    response2,
    { resourceType: "Patient", id: "patient-1", name: [{ given: ["Jamie"], family: "One" }] },
    { resourceType: "Patient", id: "patient-2", name: [{ given: ["Jamie"], family: "Two" }] },
    { resourceType: "Practitioner", id: "provider-1", name: [{ given: ["Alex"], family: "Synthetic" }] },
    { resourceType: "Organization", id: "payer-1", name: "Synthetic Health" },
    { resourceType: "Location", id: "main-office", status: "active", name: "Main Office" },
  ];
  const fhir = {
    create: async <T extends Resource>(resource: T) => resource,
    read: async <T extends Resource>(resourceType: T["resourceType"], id: string): Promise<T> => {
      const resource = resources.find((candidate) => candidate.resourceType === resourceType && candidate.id === id);
      if (!resource) throw new Error(`${resourceType}/${id} not found`);
      return resource as T;
    },
    update: async <T extends Resource>(_resourceType: T["resourceType"], _id: string, resource: T) => resource,
    search: async <T extends Resource>(resourceType: T["resourceType"], params: Record<string, string> = {}): Promise<Bundle<T>> => {
      calls += 1;
      const ids = new Set((params._id ?? "").split(",").filter(Boolean));
      const name = params.name?.toLowerCase();
      const matches = resources.filter((resource) => {
        if (resource.resourceType !== resourceType) return false;
        if (ids.size > 0 && (!resource.id || !ids.has(resource.id))) return false;
        if (name && resource.resourceType === "Patient") {
          const text = resource.name?.flatMap((humanName) => [...(humanName.given ?? []), humanName.family ?? ""]).join(" ").toLowerCase() ?? "";
          if (!text.includes(name)) return false;
        }
        return true;
      });
      return {
        resourceType: "Bundle",
        type: "searchset",
        entry: matches.map((resource) => ({ resource: resource as T })),
      };
    },
  };
  const deps: ClaimsHandlerDeps = {
    authenticate: async (authHeader) => authHeader === "Bearer good" && role
      ? { staffReference: "Practitioner/staff-1", actorRole: role, fhir }
      : null,
    adapter: null,
    recordAudit: async () => undefined,
    now: () => "2026-07-10T12:00:00.000Z",
    projectionHealth: {
      begin: () => 1,
      succeed: () => undefined,
      fail: () => undefined,
      invalidate: () => undefined,
      status: () => ({
        state: "healthy",
        lastAttemptAt: "2026-07-10T12:00:00.000Z",
        lastSuccessfulAt: "2026-07-10T12:00:00.000Z",
        lastFailureAt: null,
        invalidatedAt: null,
        staleAfterMs: 180_000,
      }),
    },
    claimReadModel: {
      search: async ({ filters }) => [
        searchRow(1, "Jamie One", "submitted"),
        searchRow(2, "Jamie Two", "rejected"),
      ].filter((row) =>
        (!filters.patient || row.patient.toLowerCase().includes(filters.patient.toLowerCase()))
        && (!filters.claim || row.claimNumber.includes(filters.claim))
        && (!filters.status || row.status === filters.status)
      ),
    } as ClaimReadModelStore,
  };
  return { deps, searchCalls: () => calls };
}

function searchRow(number: number, patient: string, status: "submitted" | "rejected") {
  return {
    claimReference: `Claim/claim-${number}`,
    claimNumber: `ODOS-CLAIM-${number}`,
    patientReference: `Patient/patient-${number}`,
    patient,
    providerReference: "Practitioner/provider-1",
    provider: "Alex Synthetic",
    cptCodes: ["PROC-A"],
    totalChargedCents: 12_500,
    insurancePaidCents: 0,
    patientResponsibilityCents: 0,
    status,
    payerReference: "Organization/payer-1",
    payer: "Synthetic Health",
    officeReference: "Location/main-office",
    office: "Main Office",
    daysSinceSubmission: number,
    touchCount: 0,
    lastTouchedAt: null,
    lastTouchedBy: null,
  };
}

function claimResource(number: number): Claim {
  const input: ProfessionalClaimInput = {
    created: `2026-07-0${number}`,
    serviceDate: `2026-06-0${number}`,
    patientReference: `Patient/patient-${number}`,
    providerReference: "Practitioner/provider-1",
    insurerReference: "Organization/payer-1",
    coverageReference: `Coverage/coverage-${number}`,
    patientAccountNumber: `ODOS-CLAIM-${number}`,
    payerId: "PAYERTEST",
    billingProvider: { name: "ODOS TEST CLINIC", npi: "1111111112" },
    renderingProvider: { firstName: "Alex", lastName: "Synthetic", npi: "1111111112" },
    subscriber: { firstName: "Jamie", lastName: "Synthetic", dateOfBirth: "1980-01-01", sex: "F" },
    patient: { firstName: "Jamie", lastName: "Synthetic", dateOfBirth: "1980-01-01", sex: "F" },
    diagnoses: [{ system: "https://odos.test/fhir/CodeSystem/diagnosis", code: "DX-A" }],
    facilityReference: "Location/main-office",
    chargeItems: [{
      resourceType: "ChargeItem",
      id: `charge-${number}`,
      status: "billable",
      subject: { reference: `Patient/patient-${number}` },
      code: { coding: [{ system: "https://odos.test/fhir/CodeSystem/procedure", code: "PROC-A" }] },
      priceOverride: { value: 125, currency: "USD" },
    }],
  };
  return { ...buildProfessionalClaim(input), id: `claim-${number}` };
}

function references(result: { body: unknown }): string[] {
  return (result.body as { items: Array<{ claimReference: string }> }).items.map((item) => item.claimReference);
}
