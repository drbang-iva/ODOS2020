import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  Basic,
  Bundle,
  Claim,
  Coverage,
  CoverageEligibilityResponse,
  RelatedPerson,
  Resource,
  Task,
} from "@medplum/fhirtypes";
import {
  handleClaimSearchRequest,
  handleEraListRequest,
  handleEraWorklistRequest,
  handleManualEobListRequest,
  type ClaimsHandlerDeps,
} from "../src/claims/claimmd-handlers.js";
import type { ClaimMdAdapter } from "../src/claims/claimmd-adapter.js";
import { buildClaimRejectedWorklistTask, buildEraImportRecord } from "../src/claims/era-worklist.js";
import { buildManualEobHeader } from "../src/claims/manual-eob.js";
import {
  handlePatientInsuranceRead,
  handleVisionBenefitsRead,
  type PatientInsuranceHandlerDeps,
} from "../src/insurance/patient-insurance-handlers.js";

test("Claim Search completes multiple pages, 409s past 1,000, and fails on an unfollowable next link", async () => {
  const claims = [claim("claim-1", "patient-1"), claim("claim-2", "patient-2")];
  const patients: Resource[] = [patient("patient-1", "One"), patient("patient-2", "Two")];
  const complete = claimsDeps(pagedFhir((resourceType) => {
    if (resourceType === "Claim") return [[claims[0]], [claims[1]]];
    if (resourceType === "Patient") return [[patients[0]], [patients[1]]];
    if (resourceType === "Practitioner") return [[practitioner()]];
    if (resourceType === "Organization") return [[payer()]];
    return [[]];
  }));
  const result = await handleClaimSearchRequest(complete, {
    authHeader: "Bearer good",
    query: { patient: "Jamie" },
  });
  assert.equal(result.status, 200);
  assert.deepEqual(
    (result.body as { items: Array<{ patient: string }> }).items.map((item) => item.patient).sort(),
    ["Jamie One", "Jamie Two"],
  );

  const capped = claimsDeps(pagedFhir((resourceType) => resourceType === "Claim"
    ? [manyClaims(1_000), [claim("claim-over-cap", "patient-over-cap")]]
    : [[]]));
  assert.deepEqual(await handleClaimSearchRequest(capped, { authHeader: "Bearer good" }), {
    status: 409,
    body: { error: "Claim query exceeded 1000 rows; no partial result was returned." },
  });

  const unfollowable = claimsDeps(pagedFhir(
    (resourceType) => resourceType === "Claim" ? [[claims[0]], [claims[1]]] : [[]],
    false,
  ));
  await assert.rejects(
    handleClaimSearchRequest(unfollowable, { authHeader: "Bearer good" }),
    /next link for Claim, but the client cannot fetch it/,
  );
});

test("ERA list completes multiple pages, 409s past 1,000, and fails on an unfollowable next link", async () => {
  const imports = [eraImport("era-1"), eraImport("era-2")];
  const complete = claimsDeps(pagedFhir((resourceType) => resourceType === "Basic"
    ? [[imports[0]], [imports[1]]]
    : [[]]), eraAdapter(["era-1", "era-2"]));
  const result = await handleEraListRequest(complete, { authHeader: "Bearer good" });
  assert.equal(result.status, 200);
  assert.deepEqual(
    (result.body as { items: Array<{ eraId: string; lane: string }> }).items.map(({ eraId, lane }) => ({ eraId, lane })),
    [{ eraId: "era-1", lane: "fully-worked" }, { eraId: "era-2", lane: "fully-worked" }],
  );

  const cappedImports = Array.from({ length: 1_001 }, (_, index) => eraImport(`era-${index}`));
  const capped = claimsDeps(pagedFhir((resourceType) => resourceType === "Basic"
    ? [cappedImports.slice(0, 1_000), cappedImports.slice(1_000)]
    : [[]]), eraAdapter([]));
  assert.deepEqual(await handleEraListRequest(capped, { authHeader: "Bearer good" }), {
    status: 409,
    body: { error: "ERA query exceeded 1000 rows; no partial result was returned." },
  });

  const unfollowable = claimsDeps(pagedFhir(
    (resourceType) => resourceType === "Basic" ? [[imports[0]], [imports[1]]] : [[]],
    false,
  ), eraAdapter([]));
  await assert.rejects(
    handleEraListRequest(unfollowable, { authHeader: "Bearer good" }),
    /next link for Basic, but the client cannot fetch it/,
  );
});

test("ERA worklist completes multiple pages, 409s past 1,000, and fails on an unfollowable next link", async () => {
  const tasks = [worklistTask("task-1"), worklistTask("task-2")];
  const complete = claimsDeps(pagedFhir((resourceType) => resourceType === "Task"
    ? [[tasks[0]], [tasks[1]]]
    : [[]]));
  const result = await handleEraWorklistRequest(complete, { authHeader: "Bearer good" });
  assert.equal(result.status, 200);
  assert.deepEqual((result.body as { items: Array<{ id: string }> }).items.map((item) => item.id), ["task-1", "task-2"]);

  const cappedTasks = Array.from({ length: 1_001 }, (_, index) => worklistTask(`task-${index}`));
  const capped = claimsDeps(pagedFhir((resourceType) => resourceType === "Task"
    ? [cappedTasks.slice(0, 1_000), cappedTasks.slice(1_000)]
    : [[]]));
  assert.deepEqual(await handleEraWorklistRequest(capped, { authHeader: "Bearer good" }), {
    status: 409,
    body: { error: "Worklist query exceeded 1000 rows; no partial result was returned." },
  });

  const unfollowable = claimsDeps(pagedFhir(
    (resourceType) => resourceType === "Task" ? [[tasks[0]], [tasks[1]]] : [[]],
    false,
  ));
  await assert.rejects(
    handleEraWorklistRequest(unfollowable, { authHeader: "Bearer good" }),
    /next link for Task, but the client cannot fetch it/,
  );
});

test("manual EOB list completes multiple pages, 409s past 1,000, and fails on an unfollowable next link", async () => {
  const headers = [manualEob("eob-1"), manualEob("eob-2")];
  const complete = claimsDeps(pagedFhir((resourceType) => resourceType === "Basic"
    ? [[headers[0]], [headers[1]]]
    : [[]]));
  const result = await handleManualEobListRequest(complete, { authHeader: "Bearer good" });
  assert.equal(result.status, 200);
  assert.deepEqual((result.body as { items: Array<{ id: string }> }).items.map((item) => item.id), ["eob-1", "eob-2"]);

  const cappedHeaders = Array.from({ length: 1_001 }, (_, index) => manualEob(`eob-${index}`));
  const capped = claimsDeps(pagedFhir((resourceType) => resourceType === "Basic"
    ? [cappedHeaders.slice(0, 1_000), cappedHeaders.slice(1_000)]
    : [[]]));
  assert.deepEqual(await handleManualEobListRequest(capped, { authHeader: "Bearer good" }), {
    status: 409,
    body: { error: "Manual EOB query exceeded 1000 rows; no partial result was returned." },
  });

  const unfollowable = claimsDeps(pagedFhir(
    (resourceType) => resourceType === "Basic" ? [[headers[0]], [headers[1]]] : [[]],
    false,
  ));
  await assert.rejects(
    handleManualEobListRequest(unfollowable, { authHeader: "Bearer good" }),
    /next link for Basic, but the client cannot fetch it/,
  );
});

test("patient insurance read completes both searches, 409s past 1,000, and fails closed without next-link support", async () => {
  const coverages = [coverage("coverage-1"), coverage("coverage-2")];
  const relatedPeople = [relatedPerson("related-1"), relatedPerson("related-2")];
  const complete = insuranceDeps(pagedFhir((resourceType) => resourceType === "Coverage"
    ? [[coverages[0]], [coverages[1]]]
    : resourceType === "RelatedPerson" ? [[relatedPeople[0]], [relatedPeople[1]]] : [[]]));
  const result = await handlePatientInsuranceRead(complete, {
    authHeader: "Bearer good",
    patientReference: "Patient/patient-1",
  });
  assert.deepEqual(result, { status: 200, body: { coverages, relatedPeople } });

  const cappedCoverages = Array.from({ length: 1_001 }, (_, index) => coverage(`coverage-${index}`));
  const capped = insuranceDeps(pagedFhir((resourceType) => resourceType === "Coverage"
    ? [cappedCoverages.slice(0, 1_000), cappedCoverages.slice(1_000)]
    : [[]]));
  assert.deepEqual(await handlePatientInsuranceRead(capped, {
    authHeader: "Bearer good",
    patientReference: "Patient/patient-1",
  }), {
    status: 409,
    body: { error: "Patient insurance query exceeded 1000 rows; no partial result was returned." },
  });

  const unfollowable = insuranceDeps(pagedFhir(
    (resourceType) => resourceType === "Coverage" ? [[coverages[0]], [coverages[1]]] : [[]],
    false,
  ));
  const failed = await handlePatientInsuranceRead(unfollowable, {
    authHeader: "Bearer good",
    patientReference: "Patient/patient-1",
  });
  assert.equal(failed.status, 502);
  assert.match((failed.body as { error: string }).error, /next link for Coverage, but the client cannot fetch it/);
  assert.equal("coverages" in (failed.body as object), false);
});

test("vision benefits read completes multiple pages, 409s past 1,000, and fails closed without next-link support", async () => {
  const responses = [benefits("benefits-1"), benefits("benefits-2")];
  const complete = insuranceDeps(pagedFhir((resourceType) => resourceType === "CoverageEligibilityResponse"
    ? [[responses[0]], [responses[1]]]
    : [[]]));
  assert.deepEqual(await handleVisionBenefitsRead(complete, {
    authHeader: "Bearer good",
    patientReference: "Patient/patient-1",
  }), { status: 200, body: { responses } });

  const cappedResponses = Array.from({ length: 1_001 }, (_, index) => benefits(`benefits-${index}`));
  const capped = insuranceDeps(pagedFhir((resourceType) => resourceType === "CoverageEligibilityResponse"
    ? [cappedResponses.slice(0, 1_000), cappedResponses.slice(1_000)]
    : [[]]));
  assert.deepEqual(await handleVisionBenefitsRead(capped, {
    authHeader: "Bearer good",
    patientReference: "Patient/patient-1",
  }), {
    status: 409,
    body: { error: "Vision benefits query exceeded 1000 rows; no partial result was returned." },
  });

  const unfollowable = insuranceDeps(pagedFhir(
    (resourceType) => resourceType === "CoverageEligibilityResponse" ? [[responses[0]], [responses[1]]] : [[]],
    false,
  ));
  const failed = await handleVisionBenefitsRead(unfollowable, {
    authHeader: "Bearer good",
    patientReference: "Patient/patient-1",
  });
  assert.equal(failed.status, 502);
  assert.match((failed.body as { error: string }).error, /next link for CoverageEligibilityResponse, but the client cannot fetch it/);
  assert.equal("responses" in (failed.body as object), false);
});

type PageResolver = (resourceType: Resource["resourceType"], params: Record<string, string>) => Resource[][];

function pagedFhir(resolvePages: PageResolver, canFollow = true) {
  let token = 0;
  const nextPages = new Map<string, Bundle>();
  function chain(resourceType: Resource["resourceType"], pages: Resource[][]): Bundle {
    const [current = [], ...remaining] = pages;
    const nextUrl = remaining.length > 0 ? `/fhir/R4/${resourceType}?_getpages=test-${++token}` : undefined;
    if (nextUrl) nextPages.set(nextUrl, chain(resourceType, remaining));
    return bundle(current, nextUrl);
  }
  return {
    create: async <T extends Resource>(resource: T) => resource,
    read: async <T extends Resource>(): Promise<T> => { throw new Error("unexpected read"); },
    update: async <T extends Resource>(_resourceType: T["resourceType"], _id: string, resource: T) => resource,
    search: async <T extends Resource>(resourceType: T["resourceType"], params: Record<string, string> = {}) =>
      chain(resourceType, resolvePages(resourceType, params)) as Bundle<T>,
    ...(canFollow ? {
      searchUrl: async <T extends Resource>(url: string) => {
        const page = nextPages.get(url);
        if (!page) throw new Error(`unknown next page ${url}`);
        return page as Bundle<T>;
      },
    } : {}),
    executeTransaction: async (transaction: Bundle) => transaction,
  };
}

function claimsDeps(fhir: ReturnType<typeof pagedFhir>, adapter: ClaimMdAdapter | null = null): ClaimsHandlerDeps {
  return {
    authenticate: async () => ({ staffReference: "Practitioner/staff-1", actorRole: "front-desk", fhir }),
    adapter,
    recordAudit: async () => undefined,
    now: () => "2026-07-10T12:00:00.000Z",
  };
}

function insuranceDeps(fhir: ReturnType<typeof pagedFhir>): PatientInsuranceHandlerDeps {
  return {
    authenticate: async () => ({ staffReference: "Practitioner/staff-1", actorRole: "front-desk", fhir }),
    recordAudit: async () => undefined,
  };
}

function eraAdapter(eraIds: string[]): ClaimMdAdapter {
  const unused = async () => { throw new Error("unexpected Claim.MD call"); };
  return {
    submitProfessionalClaim: unused,
    checkEligibility: unused,
    checkClaimStatus: unused,
    listEras: async () => ({ result: { era: eraIds.map((eraid) => ({ eraid })) } }),
    retrieveEraData: unused,
  };
}

function claim(id: string, patientId: string): Claim {
  return {
    resourceType: "Claim",
    id,
    status: "active",
    type: { coding: [{ system: "http://terminology.hl7.org/CodeSystem/claim-type", code: "professional" }] },
    use: "claim",
    patient: { reference: `Patient/${patientId}` },
    created: "2026-07-01",
    insurer: { reference: "Organization/payer-1" },
    provider: { reference: "Practitioner/provider-1" },
    priority: { coding: [{ system: "http://terminology.hl7.org/CodeSystem/processpriority", code: "normal" }] },
  };
}

function manyClaims(count: number): Claim[] {
  return Array.from({ length: count }, (_, index) => claim(`claim-${index}`, `patient-${index}`));
}

function patient(id: string, family: string): Resource {
  return { resourceType: "Patient", id, name: [{ given: ["Jamie"], family }] };
}

function practitioner(): Resource {
  return { resourceType: "Practitioner", id: "provider-1", name: [{ given: ["Alex"], family: "Synthetic" }] };
}

function payer(): Resource {
  return { resourceType: "Organization", id: "payer-1", name: "Synthetic Health" };
}

function eraImport(eraId: string): Basic {
  return {
    ...buildEraImportRecord(eraId, {
      importedAt: "2026-07-10T12:00:00.000Z",
      posted: 1,
      denied: 0,
      underpaid: 0,
      flagged: 0,
      paidTotalCents: 100,
    }),
    id: `import-${eraId}`,
  };
}

function worklistTask(id: string): Task {
  return {
    ...buildClaimRejectedWorklistTask({
      claimReference: `Claim/${id}`,
      patientReference: "Patient/patient-1",
      claimMdMessage: "Synthetic rejection",
      authoredOn: "2026-07-10T10:00:00.000Z",
    }),
    id,
  };
}

function manualEob(id: string): Basic {
  return {
    ...buildManualEobHeader({
      payerReference: "Organization/payer-1",
      paymentReference: `payment-${id}`,
      paymentDate: "2026-07-10",
      depositDate: "2026-07-10",
      totalAmountCents: 100,
      createdAt: "2026-07-10T12:00:00.000Z",
    }),
    id,
  };
}

function coverage(id: string): Coverage {
  return {
    resourceType: "Coverage",
    id,
    status: "active",
    beneficiary: { reference: "Patient/patient-1" },
    payor: [{ reference: "Organization/payer-1" }],
  };
}

function relatedPerson(id: string): RelatedPerson {
  return {
    resourceType: "RelatedPerson",
    id,
    patient: { reference: "Patient/patient-1" },
  };
}

function benefits(id: string): CoverageEligibilityResponse {
  return {
    resourceType: "CoverageEligibilityResponse",
    id,
    status: "active",
    purpose: ["benefits"],
    patient: { reference: "Patient/patient-1" },
    created: "2026-07-10T12:00:00.000Z",
    request: { reference: "CoverageEligibilityRequest/request-1" },
    outcome: "complete",
    insurer: { reference: "Organization/payer-1" },
  };
}

function bundle(resources: Resource[], nextUrl?: string): Bundle {
  return {
    resourceType: "Bundle",
    type: "searchset",
    entry: resources.map((resource) => ({ resource })),
    ...(nextUrl ? { link: [{ relation: "next", url: nextUrl }] } : {}),
  };
}
