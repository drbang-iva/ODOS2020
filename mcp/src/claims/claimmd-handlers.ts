import type {
  Basic,
  Claim,
  ClaimResponse,
  CoverageEligibilityRequest,
  CoverageEligibilityResponse,
  PaymentReconciliation,
  Resource,
  Task,
} from "@medplum/fhirtypes";
import { buildOsodAuditEventRow, type OsodActorRole, type OsodAuditEventRecord } from "../authz/osodAudit.js";
import { assertBusinessActionAllowed, PRACTICE_ROLE_IDS, type PracticeRoleId } from "../authz/roles.js";
import type { MedplumClient } from "../fhir-client.js";
import { buildInsurancePaymentReconciliation, CLAIMMD_ERA_PAYMENT_SYSTEM } from "../payments/payment-reconciliation.js";
import { buildClaimAuditRecord, type ClaimAuditEventType } from "./claim-audit.js";
import {
  isClaimSearchStatus,
  isRelatedClaimResource,
  projectClaimSearchResults,
  type ClaimSearchFilters,
} from "./claim-search.js";
import type { ClaimMdAdapter } from "./claimmd-adapter.js";
import {
  CLAIM_REJECTED_CODE_SYSTEM,
  ERA_WORKLIST_CODE_SYSTEM,
  ERA_IMPORT_CODE,
  ERA_IMPORT_CODE_SYSTEM,
  ERA_WORKLIST_STATUS_SYSTEM,
  EraWorklistConflictError,
  EraWorklistValidationError,
  buildClaimRejectedWorklistTask,
  buildEraImportRecord,
  buildEraWorklistTask,
  claimEraWorklistTask,
  eraSnapshotFromTask,
  eraWorklistStatus,
  eraWorklistEvidence,
  isEraWorklistDisposition,
  isEraWorklistStatus,
  projectEraWorklistBundle,
  projectEraBatchReadModel,
  resolveEraWorklistTask,
  type EraWorklistCode,
} from "./era-worklist.js";
import {
  buildClaimMdProfessionalClaimJson,
  buildManualClaimResponse,
  buildClaimResponseFromClaimMdEra,
  buildClaimResponseFromClaimMdStatus,
  buildCoverageEligibilityRequest,
  buildCoverageEligibilityResponseFromClaimMd,
  buildProfessionalClaim,
  medicalEligibilitySummary,
  type ClaimMdEraClaim,
  type ClaimMdEraData,
  type ManualClaimResponseLineInput,
  type ProfessionalClaimInput,
} from "./claimmd-fhir.js";
import {
  MANUAL_EOB_CODE,
  MANUAL_EOB_CODE_SYSTEM,
  MANUAL_EOB_IDENTIFIER_SYSTEM,
  ManualEobValidationError,
  appendManualEobPosting,
  buildManualEobHeader,
  closeManualEobHeader,
  parseManualEobHeader,
} from "./manual-eob.js";

export interface AuthenticatedClaimsStaff {
  staffReference: string;
  actorRole: OsodActorRole;
  fhir: Pick<MedplumClient, "create" | "search" | "read" | "update">;
}

export interface ClaimsHandlerDeps {
  authenticate(authHeader: string | undefined): Promise<AuthenticatedClaimsStaff | null>;
  adapter: ClaimMdAdapter | null;
  recordAudit(row: OsodAuditEventRecord): Promise<void>;
  eraUnderpaymentThresholdCents?: number;
  now?: () => string;
}

export interface ClaimsHandlerResult {
  status: number;
  body: unknown;
}

export async function handleSubmitClaimRequest(
  deps: ClaimsHandlerDeps,
  input: { authHeader: string | undefined; body: unknown },
): Promise<ClaimsHandlerResult> {
  const auth = await authenticateClaimsManager(deps, input.authHeader);
  if ("status" in auth) return auth;
  if (!deps.adapter) return { status: 503, body: { error: "Claim.MD adapter is not configured." } };

  const body = input.body as { claim?: ProfessionalClaimInput };
  if (!body.claim) return { status: 400, body: { error: "claim is required." } };

  let createdClaim: Claim | undefined;
  try {
    const claim = buildProfessionalClaim(body.claim);
    createdClaim = await auth.fhir.create(claim);
    const payload = buildClaimMdProfessionalClaimJson(body.claim, createdClaim);
    const result = await deps.adapter.submitProfessionalClaim({
      fileName: `${body.claim.patientAccountNumber}.json`,
      payload,
    });
    await audit(deps, auth, "claim.submit.completed", "success", ref(createdClaim), body.claim.patientReference);
    return {
      status: 200,
      body: {
        claimId: createdClaim.id,
        claimMdClaimId: result.claims[0]?.claimMdClaimId,
        claimMdTrackingNumber: result.claims[0]?.claimMdId,
        status: result.claims[0]?.status,
      },
    };
  } catch (error) {
    await audit(
      deps,
      auth,
      "claim.submit.failed",
      "failure",
      createdClaim ? ref(createdClaim) : "Claim/uncreated",
      body.claim.patientReference,
      claimMdFailureAuditReason("submitProfessionalClaim", error),
    );
    try {
      await createAndAuditClaimRejectedTask(deps, auth, {
        claimReference: createdClaim ? ref(createdClaim) : undefined,
        patientReference: body.claim.patientReference,
        claimMdMessage: messageOf(error),
      });
    } catch {
      // The failed Claim create may reflect a broader FHIR write outage; the failure response must still return.
    }
    return { status: 502, body: { error: `Claim submission failed: ${messageOf(error)}` } };
  }
}

export async function handleEligibilityCheckRequest(
  deps: ClaimsHandlerDeps,
  input: { authHeader: string | undefined; body: unknown },
): Promise<ClaimsHandlerResult> {
  const auth = await authenticateClaimsManager(deps, input.authHeader);
  if ("status" in auth) return auth;
  if (!deps.adapter) return { status: 503, body: { error: "Claim.MD adapter is not configured." } };

  const body = input.body as {
    patientReference?: string;
    coverageReference?: string;
    insurerReference?: string;
    providerReference?: string;
    serviceDate?: string;
    claimMd?: Record<string, string>;
  };
  if (!body.patientReference || !body.coverageReference || !body.insurerReference || !body.serviceDate || !body.claimMd) {
    return { status: 400, body: { error: "patientReference, coverageReference, insurerReference, serviceDate, and claimMd are required." } };
  }

  let request: CoverageEligibilityRequest | undefined;
  try {
    request = await auth.fhir.create(buildCoverageEligibilityRequest({
      patientReference: body.patientReference,
      coverageReference: body.coverageReference,
      insurerReference: body.insurerReference,
      providerReference: body.providerReference,
      created: today(deps),
      serviceDate: body.serviceDate,
    }));
    const claimMd = await deps.adapter.checkEligibility(body.claimMd);
    const response = await auth.fhir.create(buildCoverageEligibilityResponseFromClaimMd({
      requestReference: ref(request),
      patientReference: body.patientReference,
      coverageReference: body.coverageReference,
      insurerReference: body.insurerReference,
      requestorReference: body.providerReference,
      created: today(deps),
      claimMd,
    }));
    await audit(deps, auth, "eligibility.check.completed", "success", ref(response), body.patientReference);
    return {
      status: 200,
      body: {
        requestId: request.id,
        responseId: response.id,
        response,
        summary: medicalEligibilitySummary(response),
      },
    };
  } catch (error) {
    await audit(
      deps,
      auth,
      "eligibility.check.failed",
      "failure",
      request ? ref(request) : "CoverageEligibilityRequest/uncreated",
      body.patientReference,
      claimMdFailureAuditReason("checkEligibility", error),
    );
    return { status: 502, body: { error: `Eligibility check failed: ${messageOf(error)}` } };
  }
}

export async function handleClaimStatusRequest(
  deps: ClaimsHandlerDeps,
  input: { authHeader: string | undefined; params: { id?: string }; body: unknown },
): Promise<ClaimsHandlerResult> {
  const auth = await authenticateClaimsManager(deps, input.authHeader);
  if ("status" in auth) return auth;
  if (!deps.adapter) return { status: 503, body: { error: "Claim.MD adapter is not configured." } };

  const body = input.body as {
    claimMdClaimId?: unknown;
    patientReference?: unknown;
    insurerReference?: unknown;
    providerReference?: unknown;
    responseId?: unknown;
  };
  const claimMdClaimId = stringValue(body.claimMdClaimId);
  const patientReference = stringValue(body.patientReference);
  const insurerReference = stringValue(body.insurerReference);
  const providerReference = stringValue(body.providerReference);
  const responseId = stringValue(body.responseId);
  if (!input.params.id || !claimMdClaimId || !patientReference || !insurerReference) {
    return { status: 400, body: { error: "claim id, claimMdClaimId, patientReference, and insurerReference are required." } };
  }

  try {
    const status = await deps.adapter.checkClaimStatus({
      claimMdClaimId,
      responseId,
    });
    const response = await auth.fhir.create(buildClaimResponseFromClaimMdStatus({
      claimReference: `Claim/${input.params.id}`,
      patientReference,
      insurerReference,
      providerReference,
      created: today(deps),
      status,
    }));
    await audit(deps, auth, "claim.status.checked", "success", ref(response), patientReference);
    if (response.outcome === "error") {
      await createAndAuditClaimRejectedTask(deps, auth, {
        claimReference: `Claim/${input.params.id}`,
        patientReference,
        claimMdMessage: response.disposition ?? "",
      });
    }
    return { status: 200, body: { claimResponseId: response.id, response } };
  } catch (error) {
    await audit(
      deps,
      auth,
      "claim.status.checked",
      "failure",
      `Claim/${input.params.id}`,
      patientReference,
      claimMdFailureAuditReason("checkClaimStatus", error),
    );
    return { status: 502, body: { error: `Claim status check failed: ${messageOf(error)}` } };
  }
}

export async function handleEraImportRequest(
  deps: ClaimsHandlerDeps,
  input: { authHeader: string | undefined; body: unknown },
): Promise<ClaimsHandlerResult> {
  const auth = await authenticateClaimsManager(deps, input.authHeader);
  if ("status" in auth) return auth;
  if (!deps.adapter) return { status: 503, body: { error: "Claim.MD adapter is not configured." } };

  const body = input.body as {
    eraId?: string;
    claimReferenceByPcn?: Record<string, string>;
    patientReferenceByPcn?: Record<string, string>;
    insurerReference?: string;
    providerReference?: string;
    practiceOrgReference?: string;
    appealDeadlineByPcn?: Record<string, string>;
  };
  if (!body.eraId || !body.claimReferenceByPcn || !body.patientReferenceByPcn || !body.insurerReference) {
    return { status: 400, body: { error: "eraId, claimReferenceByPcn, patientReferenceByPcn, and insurerReference are required." } };
  }

  const claimResponseIds: string[] = [];
  const paymentReconciliationIds: string[] = [];
  const taskIds: string[] = [];
  let posted = 0;
  let denied = 0;
  let underpaid = 0;
  let flagged = 0;
  let paidTotalCents = 0;
  try {
    const era = await deps.adapter.retrieveEraData(body.eraId) as ClaimMdEraData;
    const eraId = era.eraid ?? body.eraId;
    for (const eraClaim of arrayOf(era.claim)) {
      const pcn = eraClaim.pcn ?? "";
      const claimReference = body.claimReferenceByPcn[pcn];
      const patientReference = body.patientReferenceByPcn[pcn];
      if (!claimReference || !patientReference) {
        const task = await auth.fhir.create(buildEraWorklistTask({
          code: "era-unmatched",
          era: { ...era, eraid: eraId },
          eraClaim,
          authoredOn: now(deps),
          appealDeadline: body.appealDeadlineByPcn?.[pcn],
        }));
        taskIds.push(requiredId(task));
        await audit(deps, auth, "era.unmatched.flagged", "success", ref(task));
        flagged += 1;
        continue;
      }

      const result = await persistMatchedEraClaim(deps, auth, {
        era: { ...era, eraid: eraId },
        eraClaim,
        claimReference,
        patientReference,
        insurerReference: body.insurerReference,
        providerReference: body.providerReference,
        practiceOrgReference: body.practiceOrgReference,
        appealDeadline: body.appealDeadlineByPcn?.[pcn],
      });
      claimResponseIds.push(...result.claimResponseIds);
      paymentReconciliationIds.push(...result.paymentReconciliationIds);
      taskIds.push(...result.taskIds);
      posted += result.posted;
      denied += result.denied;
      underpaid += result.underpaid;
      paidTotalCents += result.paidCents;
    }
    await upsertEraImportRecord(auth, eraId, {
      importedAt: now(deps),
      posted,
      denied,
      underpaid,
      flagged,
      ...(era.payer_name ? { payerName: era.payer_name } : {}),
      ...(era.paid_date ? { paidDate: era.paid_date } : {}),
      paidTotalCents,
    });
    await audit(deps, auth, "era.import.completed", "success", `PaymentReconciliation/${paymentReconciliationIds[0] ?? "none"}`);
    return {
      status: 200,
      body: {
        eraId: body.eraId,
        posted,
        denied,
        underpaid,
        flagged,
        taskIds,
        claimResponseIds,
        paymentReconciliationIds,
      },
    };
  } catch (error) {
    await audit(
      deps,
      auth,
      "era.import.failed",
      "failure",
      `Claim.MD/ERA/${body.eraId}`,
      undefined,
      claimMdFailureAuditReason("retrieveEraData", error),
    );
    return { status: 502, body: { error: `ERA import failed: ${messageOf(error)}` } };
  }
}

export async function handleEraListRequest(
  deps: ClaimsHandlerDeps,
  input: { authHeader: string | undefined },
): Promise<ClaimsHandlerResult> {
  const auth = await authenticateClaimsManager(deps, input.authHeader);
  if ("status" in auth) return auth;
  if (!deps.adapter) return { status: 503, body: { error: "Claim.MD adapter is not configured." } };

  const [rawEraList, importBundle, openTaskBundle] = await Promise.all([
    deps.adapter.listEras(),
    auth.fhir.search<Basic>("Basic", {
      code: `${ERA_IMPORT_CODE_SYSTEM}|${ERA_IMPORT_CODE}`,
      _count: "100",
    }),
    auth.fhir.search<Task>("Task", {
      code: `${ERA_WORKLIST_CODE_SYSTEM}|`,
      "business-status": `${ERA_WORKLIST_STATUS_SYSTEM}|new,${ERA_WORKLIST_STATUS_SYSTEM}|in-review`,
      _count: "100",
    }),
  ]);
  return { status: 200, body: { items: projectEraBatchReadModel(rawEraList, importBundle, openTaskBundle) } };
}

export async function handleEraWorklistRequest(
  deps: ClaimsHandlerDeps,
  input: { authHeader: string | undefined; query?: { status?: unknown } },
): Promise<ClaimsHandlerResult> {
  const auth = await authenticateClaimsManager(deps, input.authHeader);
  if ("status" in auth) return auth;
  const requestedStatus = stringValue(input.query?.status);
  if (requestedStatus && !isEraWorklistStatus(requestedStatus)) {
    return { status: 400, body: { error: "status must be new, in-review, or resolved." } };
  }
  const bundle = await auth.fhir.search<Task>("Task", {
    code: `${ERA_WORKLIST_CODE_SYSTEM}|,${CLAIM_REJECTED_CODE_SYSTEM}|`,
    ...(requestedStatus ? { "business-status": `${ERA_WORKLIST_STATUS_SYSTEM}|${requestedStatus}` } : {}),
    _count: "100",
    _sort: "-authored-on",
  });
  return { status: 200, body: { items: projectEraWorklistBundle(bundle, now(deps)) } };
}

export async function handleClaimSearchRequest(
  deps: ClaimsHandlerDeps,
  input: { authHeader: string | undefined; query?: Record<string, unknown> },
): Promise<ClaimsHandlerResult> {
  const auth = await authenticateClaimsManager(deps, input.authHeader);
  if ("status" in auth) return auth;
  const patient = trimmedValue(input.query?.patient);
  const status = trimmedValue(input.query?.status);
  if (status && !isClaimSearchStatus(status)) {
    return { status: 400, body: { error: "status must be submitted, accepted, queued, rejected, paid, denied, or underpaid." } };
  }
  const requestedStatus = status && isClaimSearchStatus(status) ? status : undefined;
  const minAmountCents = amountCents(input.query?.minAmount);
  const maxAmountCents = amountCents(input.query?.maxAmount);
  if (minAmountCents === null || maxAmountCents === null) {
    return { status: 400, body: { error: "minAmount and maxAmount must be non-negative dollar amounts." } };
  }
  if (minAmountCents !== undefined && maxAmountCents !== undefined && minAmountCents > maxAmountCents) {
    return { status: 400, body: { error: "minAmount cannot exceed maxAmount." } };
  }

  const [claimBundle, responseBundle, taskBundle] = await Promise.all([
    auth.fhir.search<Claim>("Claim", { _count: "100", _sort: "-created" }),
    auth.fhir.search<ClaimResponse>("ClaimResponse", { _count: "200", _sort: "-created" }),
    auth.fhir.search<Task>("Task", {
      code: `${ERA_WORKLIST_CODE_SYSTEM}|,${CLAIM_REJECTED_CODE_SYSTEM}|`,
      _count: "200",
      _sort: "-authored-on",
    }),
  ]);
  const claims = bundleResources(claimBundle);
  const responses = bundleResources(responseBundle);
  const tasks = bundleResources(taskBundle);
  let patientReferences: Set<string> | undefined;
  const relatedResources: Resource[] = [];
  if (patient) {
    if (/^Patient\/[A-Za-z0-9.-]+$/.test(patient)) {
      patientReferences = new Set([patient]);
    } else {
      const patientBundle = await auth.fhir.search<Resource>("Patient", { name: patient, _count: "100" });
      const patients = bundleResources(patientBundle).filter(isRelatedClaimResource);
      relatedResources.push(...patients);
      patientReferences = new Set(patients.flatMap((resource) => resource.id ? [`Patient/${resource.id}`] : []));
    }
  }

  const referenceBundles = await Promise.all(
    (["Patient", "Practitioner", "PractitionerRole", "Organization", "Location"] as const).map(async (resourceType) => {
      const ids = claimReferenceIds(claims, resourceType);
      if (ids.length === 0) return [];
      const bundle = await auth.fhir.search<Resource>(resourceType, { _id: ids.join(","), _count: String(ids.length) });
      return bundleResources(bundle).filter(isRelatedClaimResource);
    }),
  );
  relatedResources.push(...referenceBundles.flat());

  const filters: ClaimSearchFilters = {
    ...(patientReferences ? { patientReferences } : {}),
    ...(trimmedValue(input.query?.claim) ? { claim: trimmedValue(input.query?.claim) } : {}),
    ...(requestedStatus ? { status: requestedStatus } : {}),
    ...(trimmedValue(input.query?.carrier) ? { carrier: trimmedValue(input.query?.carrier) } : {}),
    ...(trimmedValue(input.query?.office) ? { office: trimmedValue(input.query?.office) } : {}),
    ...(trimmedValue(input.query?.cpt) ? { cpt: trimmedValue(input.query?.cpt) } : {}),
    ...(minAmountCents !== undefined ? { minAmountCents } : {}),
    ...(maxAmountCents !== undefined ? { maxAmountCents } : {}),
  };
  return {
    status: 200,
    body: {
      items: projectClaimSearchResults({
        claims,
        responses,
        tasks,
        relatedResources,
        filters,
        at: now(deps),
      }),
    },
  };
}

export async function handleCreateManualEobRequest(
  deps: ClaimsHandlerDeps,
  input: { authHeader: string | undefined; body: unknown },
): Promise<ClaimsHandlerResult> {
  const auth = await authenticateClaimsManager(deps, input.authHeader);
  if ("status" in auth) return auth;
  const body = input.body as Record<string, unknown>;
  const payerReference = stringValue(body.payerReference);
  const paymentReference = trimmedValue(body.paymentReference);
  const paymentDate = stringValue(body.paymentDate);
  const depositDate = stringValue(body.depositDate);
  const totalAmountCents = integerValue(body.totalAmountCents);
  if (!payerReference || !paymentReference || !paymentDate || !depositDate || totalAmountCents === undefined) {
    return {
      status: 400,
      body: { error: "payerReference, paymentReference, paymentDate, depositDate, and totalAmountCents are required." },
    };
  }

  const existing = await auth.fhir.search<Basic>("Basic", {
    code: `${MANUAL_EOB_CODE_SYSTEM}|${MANUAL_EOB_CODE}`,
    identifier: `${MANUAL_EOB_IDENTIFIER_SYSTEM}|${paymentReference}`,
    _count: "1",
  });
  if (bundleResources(existing).length > 0) {
    return { status: 409, body: { error: "A manual EOB with this payment reference already exists." } };
  }
  try {
    const created = await auth.fhir.create(buildManualEobHeader({
      payerReference,
      paymentReference,
      paymentDate,
      depositDate,
      totalAmountCents,
      createdAt: now(deps),
    }));
    return { status: 201, body: { header: parseManualEobHeader(created) } };
  } catch (error) {
    if (error instanceof ManualEobValidationError) return { status: 400, body: { error: error.message } };
    throw error;
  }
}

export async function handleManualEobListRequest(
  deps: ClaimsHandlerDeps,
  input: { authHeader: string | undefined },
): Promise<ClaimsHandlerResult> {
  const auth = await authenticateClaimsManager(deps, input.authHeader);
  if ("status" in auth) return auth;
  const bundle = await auth.fhir.search<Basic>("Basic", {
    code: `${MANUAL_EOB_CODE_SYSTEM}|${MANUAL_EOB_CODE}`,
    _count: "100",
    _sort: "-_lastUpdated",
  });
  return { status: 200, body: { items: bundleResources(bundle).map(parseManualEobHeader) } };
}

export async function handlePostManualEobClaimRequest(
  deps: ClaimsHandlerDeps,
  input: { authHeader: string | undefined; params: { id?: string }; body: unknown },
): Promise<ClaimsHandlerResult> {
  const auth = await authenticateClaimsManager(deps, input.authHeader);
  if ("status" in auth) return auth;
  if (!input.params.id) return { status: 400, body: { error: "manual EOB id is required." } };
  const body = input.body as Record<string, unknown>;
  const claimReference = stringValue(body.claimReference);
  const lineInputs = manualLineInputs(body.lines);
  if (!claimReference || !/^Claim\/[A-Za-z0-9.-]+$/.test(claimReference) || !lineInputs) {
    return { status: 400, body: { error: "claimReference and a complete lines array are required." } };
  }

  const [headerResource, claim] = await Promise.all([
    auth.fhir.read<Basic>("Basic", input.params.id),
    auth.fhir.read<Claim>("Claim", claimReference.slice("Claim/".length)),
  ]);
  let header;
  try {
    header = parseManualEobHeader(headerResource);
  } catch (error) {
    if (error instanceof ManualEobValidationError) return { status: 400, body: { error: error.message } };
    throw error;
  }
  if (header.status !== "draft") {
    return { status: 409, body: { error: "Only a draft manual EOB can receive claim postings." } };
  }
  if (header.postings.some((posting) => posting.claimReference === claimReference)) {
    return { status: 409, body: { error: `${claimReference} is already posted on this manual EOB.` } };
  }
  if (claim.insurer?.reference !== header.payerReference) {
    return { status: 400, body: { error: "The selected Claim insurer does not match the manual EOB payer." } };
  }
  const patientReference = claim.patient.reference;
  if (!patientReference || !claim.provider?.reference) {
    return { status: 400, body: { error: "The selected Claim is missing its patient or provider reference." } };
  }
  const claimItems = claim.item ?? [];
  const sequences = new Set(lineInputs.map((line) => line.itemSequence));
  if (
    lineInputs.length !== claimItems.length
    || sequences.size !== claimItems.length
    || claimItems.some((item) => !sequences.has(item.sequence))
  ) {
    return { status: 400, body: { error: "Every Claim item must be adjudicated exactly once." } };
  }
  let responseResource: ClaimResponse;
  try {
    const lines: ManualClaimResponseLineInput[] = lineInputs.map((line) => {
      const item = claimItems.find((candidate) => candidate.sequence === line.itemSequence)!;
      return { ...line, submittedCents: claimItemSubmittedCents(item) };
    });
    responseResource = buildManualClaimResponse({
      claimReference,
      patientReference,
      insurerReference: header.payerReference,
      providerReference: claim.provider.reference,
      created: today(deps),
      paymentDate: header.paymentDate,
      paymentReference: header.paymentReference,
      paymentIdentifierSystem: MANUAL_EOB_IDENTIFIER_SYSTEM,
      lines,
    });
    const paidCents = Math.round((responseResource.payment?.amount.value ?? 0) * 100);
    if (paidCents > header.remainingAmountCents) {
      return { status: 400, body: { error: "Claim payment exceeds the manual EOB remaining amount." } };
    }
  } catch (error) {
    return { status: 400, body: { error: messageOf(error) } };
  }

  const response = await auth.fhir.create(responseResource);
  const paidCents = Math.round((response.payment?.amount.value ?? 0) * 100);
  const reconciliation = await auth.fhir.create(buildInsurancePaymentReconciliation({
    createdIso: now(deps),
    paymentDate: header.paymentDate,
    amountCents: paidCents,
    claimReference,
    claimResponseReference: ref(response),
    insurerReference: header.payerReference,
    processorTransactionId: header.paymentReference,
    processorTransactionSystem: MANUAL_EOB_IDENTIFIER_SYSTEM,
    description: `Manual EOB ${header.paymentReference}`,
  }));
  const updatedHeaderResource = await auth.fhir.update<Basic>(
    "Basic",
    header.id,
    appendManualEobPosting(headerResource, {
      claimReference,
      claimResponseReference: ref(response),
      paymentReconciliationReference: ref(reconciliation),
      amountCents: paidCents,
      postedAt: now(deps),
    }),
  );
  await audit(
    deps,
    auth,
    "claim.manual-eob.posted",
    "success",
    ref(response),
    patientReference,
    `manual-eob=${header.id}`,
    "manual-eob",
  );
  return {
    status: 201,
    body: {
      header: parseManualEobHeader(updatedHeaderResource),
      claimResponseId: requiredId(response),
      paymentReconciliationId: requiredId(reconciliation),
    },
  };
}

export async function handleCloseManualEobRequest(
  deps: ClaimsHandlerDeps,
  input: { authHeader: string | undefined; params: { id?: string } },
): Promise<ClaimsHandlerResult> {
  const auth = await authenticateClaimsManager(deps, input.authHeader);
  if ("status" in auth) return auth;
  if (!input.params.id) return { status: 400, body: { error: "manual EOB id is required." } };
  const existing = await auth.fhir.read<Basic>("Basic", input.params.id);
  try {
    const updated = await auth.fhir.update<Basic>("Basic", input.params.id, closeManualEobHeader(existing));
    return { status: 200, body: { header: parseManualEobHeader(updated) } };
  } catch (error) {
    if (error instanceof ManualEobValidationError) return { status: 400, body: { error: error.message } };
    throw error;
  }
}

async function createAndAuditClaimRejectedTask(
  deps: ClaimsHandlerDeps,
  auth: AuthenticatedClaimsStaff,
  input: {
    claimReference?: string;
    patientReference?: string;
    claimMdMessage: string;
  },
): Promise<Task> {
  if (input.claimReference) {
    const existing = await auth.fhir.search<Task>("Task", {
      code: `${CLAIM_REJECTED_CODE_SYSTEM}|claim-rejected`,
      focus: input.claimReference,
      "business-status": `${ERA_WORKLIST_STATUS_SYSTEM}|new,${ERA_WORKLIST_STATUS_SYSTEM}|in-review`,
      _count: "1",
    });
    const open = (existing.entry ?? [])
      .flatMap((entry) => entry.resource ? [entry.resource] : [])
      .find((task) =>
        task.focus?.reference === input.claimReference
        && (eraWorklistStatus(task) === "new" || eraWorklistStatus(task) === "in-review"),
      );
    if (open) return open;
  }
  const task = await auth.fhir.create(buildClaimRejectedWorklistTask({
    ...input,
    authoredOn: now(deps),
  }));
  await audit(deps, auth, "claim.rejected.flagged", "success", ref(task), input.patientReference);
  return task;
}

export async function handleClaimEraWorklistTaskRequest(
  deps: ClaimsHandlerDeps,
  input: { authHeader: string | undefined; params: { id?: string } },
): Promise<ClaimsHandlerResult> {
  const auth = await authenticateClaimsManager(deps, input.authHeader);
  if ("status" in auth) return auth;
  if (!input.params.id) return { status: 400, body: { error: "worklist Task id is required." } };
  try {
    const task = await auth.fhir.read<Task>("Task", input.params.id);
    const updated = await auth.fhir.update<Task>(
      "Task",
      input.params.id,
      claimEraWorklistTask(task, auth.staffReference, now(deps)),
    );
    await auditTaskWrite(deps, auth, updated, "ERA_WORKLIST claimed");
    return { status: 200, body: { task: updated } };
  } catch (error) {
    if (error instanceof EraWorklistConflictError) return { status: 409, body: { error: error.message } };
    if (error instanceof EraWorklistValidationError) return { status: 400, body: { error: error.message } };
    throw error;
  }
}

export async function handleResolveEraWorklistTaskRequest(
  deps: ClaimsHandlerDeps,
  input: { authHeader: string | undefined; params: { id?: string }; body: unknown },
): Promise<ClaimsHandlerResult> {
  const auth = await authenticateClaimsManager(deps, input.authHeader);
  if ("status" in auth) return auth;
  if (!input.params.id) return { status: 400, body: { error: "worklist Task id is required." } };
  const body = input.body as {
    disposition?: unknown;
    claimReference?: unknown;
    patientReference?: unknown;
    insurerReference?: unknown;
    providerReference?: unknown;
    practiceOrgReference?: unknown;
  };
  if (!isEraWorklistDisposition(body.disposition)) {
    return { status: 400, body: { error: "A coded resolution disposition is required." } };
  }
  const claimReference = stringValue(body.claimReference);
  try {
    const task = await auth.fhir.read<Task>("Task", input.params.id);
    const resolvedTask = resolveEraWorklistTask(
      task,
      { disposition: body.disposition, claimReference },
      now(deps),
    );
    let reimport: EraClaimPersistenceResult | undefined;
    if (body.disposition === "matched") {
      const patientReference = stringValue(body.patientReference);
      const insurerReference = stringValue(body.insurerReference);
      if (!claimReference || !patientReference || !insurerReference) {
        return {
          status: 400,
          body: { error: "matched requires claimReference, patientReference, and insurerReference." },
        };
      }
      const era = eraSnapshotFromTask(task);
      reimport = await persistMatchedEraClaim(deps, auth, {
        era,
        eraClaim: era.claim,
        claimReference,
        patientReference,
        insurerReference,
        providerReference: stringValue(body.providerReference),
        practiceOrgReference: stringValue(body.practiceOrgReference),
      });
    }
    const updated = await auth.fhir.update<Task>(
      "Task",
      input.params.id,
      resolvedTask,
    );
    await auditTaskWrite(deps, auth, updated, `ERA_WORKLIST resolved disposition=${body.disposition}`);
    return { status: 200, body: { task: updated, ...(reimport ? { reimport } : {}) } };
  } catch (error) {
    if (error instanceof EraWorklistConflictError) return { status: 409, body: { error: error.message } };
    if (error instanceof EraWorklistValidationError) return { status: 400, body: { error: error.message } };
    throw error;
  }
}

interface EraClaimPersistenceResult {
  posted: number;
  denied: number;
  underpaid: number;
  claimResponseIds: string[];
  paymentReconciliationIds: string[];
  taskIds: string[];
  paidCents: number;
}

async function persistMatchedEraClaim(
  deps: ClaimsHandlerDeps,
  auth: AuthenticatedClaimsStaff,
  input: {
    era: ClaimMdEraData;
    eraClaim: ClaimMdEraClaim;
    claimReference: string;
    patientReference: string;
    insurerReference: string;
    providerReference?: string;
    practiceOrgReference?: string;
    appealDeadline?: string;
  },
): Promise<EraClaimPersistenceResult> {
  const response = await auth.fhir.create(buildClaimResponseFromClaimMdEra({
    claimReference: input.claimReference,
    patientReference: input.patientReference,
    insurerReference: input.insurerReference,
    providerReference: input.providerReference,
    created: today(deps),
    era: { ...input.era, claim: input.eraClaim },
  }));
  const paidCents = Math.round((response.payment?.amount.value ?? 0) * 100);
  const evidence = eraWorklistEvidence(input.eraClaim, input.era.eraid ?? "");
  const paymentReconciliationIds: string[] = [];
  const taskIds: string[] = [];
  let posted = 0;
  let denied = 0;
  let underpaid = 0;

  if (paidCents > 0) {
    const pr = await auth.fhir.create(buildInsurancePaymentReconciliation({
      createdIso: now(deps),
      paymentDate: response.payment?.date ?? today(deps),
      amountCents: paidCents,
      claimReference: input.claimReference,
      claimResponseReference: ref(response),
      insurerReference: input.insurerReference,
      practiceOrgReference: input.practiceOrgReference,
      processorTransactionId: input.era.eraid ?? "unknown-era",
      processorTransactionSystem: CLAIMMD_ERA_PAYMENT_SYSTEM,
      description: `Claim.MD ERA ${input.era.eraid ?? "unknown"}`,
    }));
    paymentReconciliationIds.push(requiredId(pr));
    posted = 1;
  }

  if (paidCents === 0) {
    const task = await createAndAuditEraWorklistTask(deps, auth, "era-denial", input, response);
    taskIds.push(requiredId(task));
    denied = 1;
  } else if (
    evidence.shortfallCents > 0
    && evidence.shortfallCents >= (deps.eraUnderpaymentThresholdCents ?? 1)
  ) {
    const task = await createAndAuditEraWorklistTask(deps, auth, "era-underpayment", input, response);
    taskIds.push(requiredId(task));
    underpaid = 1;
  }

  return {
    posted,
    denied,
    underpaid,
    claimResponseIds: [requiredId(response)],
    paymentReconciliationIds,
    taskIds,
    paidCents,
  };
}

async function upsertEraImportRecord(
  auth: AuthenticatedClaimsStaff,
  eraId: string,
  summary: Parameters<typeof buildEraImportRecord>[1],
): Promise<Basic> {
  const bundle = await auth.fhir.search<Basic>("Basic", {
    code: `${ERA_IMPORT_CODE_SYSTEM}|${ERA_IMPORT_CODE}`,
    identifier: `${CLAIMMD_ERA_PAYMENT_SYSTEM}|${eraId}`,
    _count: "1",
  });
  const existing = bundle.entry?.find((entry) => entry.resource)?.resource;
  const resource = buildEraImportRecord(eraId, summary, existing);
  return existing?.id
    ? auth.fhir.update<Basic>("Basic", existing.id, resource)
    : auth.fhir.create(resource);
}

async function createAndAuditEraWorklistTask(
  deps: ClaimsHandlerDeps,
  auth: AuthenticatedClaimsStaff,
  code: Exclude<EraWorklistCode, "era-unmatched">,
  input: {
    era: ClaimMdEraData;
    eraClaim: ClaimMdEraClaim;
    patientReference: string;
    appealDeadline?: string;
  },
  response: ClaimResponse,
): Promise<Task> {
  const task = await auth.fhir.create(buildEraWorklistTask({
    code,
    era: input.era,
    eraClaim: input.eraClaim,
    claimResponseReference: ref(response),
    patientReference: input.patientReference,
    authoredOn: now(deps),
    appealDeadline: input.appealDeadline,
  }));
  const eventType = code === "era-denial" ? "era.denial.flagged" : "era.underpayment.flagged";
  await audit(deps, auth, eventType, "success", ref(task), input.patientReference);
  return task;
}

export function eraUnderpaymentThresholdCentsFromEnv(env: Record<string, string | undefined>): number {
  const value = env.OSOD_ERA_UNDERPAYMENT_THRESHOLD_CENTS;
  if (value === undefined || value === "") return 1;
  if (!/^\d+$/.test(value)) {
    throw new Error("OSOD_ERA_UNDERPAYMENT_THRESHOLD_CENTS must be a nonnegative whole number of cents.");
  }
  return Number(value);
}

async function auditTaskWrite(
  deps: ClaimsHandlerDeps,
  staff: AuthenticatedClaimsStaff,
  task: Task,
  actionReason: string,
): Promise<void> {
  await deps.recordAudit(buildOsodAuditEventRow({
    eventType: "update",
    actorReference: staff.staffReference,
    actorRole: staff.actorRole,
    patientReference: task.for?.reference,
    targetReference: ref(task),
    actionOutcome: "granted",
    actionReason,
    eventTime: now(deps),
  }));
}

async function authenticateClaimsManager(
  deps: ClaimsHandlerDeps,
  authHeader: string | undefined,
): Promise<AuthenticatedClaimsStaff | ClaimsHandlerResult> {
  const staff = await deps.authenticate(authHeader);
  if (!staff) return { status: 401, body: { error: "Authentication required to manage claims." } };
  if (!staffMayManageClaims(staff.actorRole)) {
    return { status: 403, body: { error: "claims.manage role required" } };
  }
  return staff;
}

function staffMayManageClaims(actorRole: OsodActorRole): boolean {
  if (!PRACTICE_ROLE_IDS.includes(actorRole as PracticeRoleId)) return false;
  try {
    assertBusinessActionAllowed(actorRole as PracticeRoleId, "claims.manage");
    return true;
  } catch {
    return false;
  }
}

async function audit(
  deps: ClaimsHandlerDeps,
  staff: AuthenticatedClaimsStaff,
  eventType: ClaimAuditEventType,
  outcome: "success" | "failure",
  targetReference: string,
  patientReference?: string,
  reason?: string,
  adapterName: "claimmd" | "manual-eob" = "claimmd",
): Promise<void> {
  await deps.recordAudit(buildClaimAuditRecord({
    eventType,
    staffReference: staff.staffReference,
    actorRole: staff.actorRole,
    patientReference,
    targetReference,
    adapterName,
    outcome,
    reason,
    timestamp: now(deps),
  }));
}

function ref(resource: { resourceType: string; id?: string }): string {
  if (!resource.id) throw new Error(`${resource.resourceType} create did not return an id.`);
  return `${resource.resourceType}/${resource.id}`;
}

function requiredId(resource: { resourceType: string; id?: string }): string {
  if (!resource.id) throw new Error(`${resource.resourceType} create did not return an id.`);
  return resource.id;
}

function now(deps: Pick<ClaimsHandlerDeps, "now">): string {
  return deps.now?.() ?? new Date().toISOString();
}

function today(deps: Pick<ClaimsHandlerDeps, "now">): string {
  return now(deps).slice(0, 10);
}

function arrayOf<T>(value: T | T[] | undefined): T[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function claimMdFailureAuditReason(operation: string, error: unknown): string {
  const status = claimMdHttpStatus(error);
  return status ? `Claim.MD ${operation} failed with HTTP ${status}` : `Claim.MD ${operation} failed`;
}

function claimMdHttpStatus(error: unknown): string | undefined {
  if (typeof error === "object" && error !== null && "status" in error) {
    const status = (error as { status?: unknown }).status;
    if (typeof status === "number" && Number.isInteger(status)) return String(status);
    if (typeof status === "string" && /^[1-5]\d{2}$/.test(status)) return status;
  }
  return messageOf(error).match(/\bHTTP\s+([1-5]\d{2})\b/i)?.[1];
}

function stringValue(value: unknown): string | undefined {
  if (typeof value === "string" && value.length > 0) return value;
  if (Array.isArray(value)) return stringValue(value[0]);
  return undefined;
}

function trimmedValue(value: unknown): string | undefined {
  const text = stringValue(value)?.trim();
  return text || undefined;
}

function amountCents(value: unknown): number | undefined | null {
  const text = trimmedValue(value);
  if (text === undefined) return undefined;
  const amount = Number(text);
  return Number.isFinite(amount) && amount >= 0 ? Math.round(amount * 100) : null;
}

function integerValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) ? value : undefined;
}

function manualLineInputs(value: unknown): Array<Omit<ManualClaimResponseLineInput, "submittedCents">> | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  const fields = [
    "itemSequence",
    "allowedCents",
    "paidCents",
    "deductibleCents",
    "coinsuranceCents",
    "copayCents",
  ] as const;
  if (value.some((entry) =>
    typeof entry !== "object"
    || entry === null
    || fields.some((field) => !Number.isInteger((entry as Record<string, unknown>)[field])),
  )) return undefined;
  return value.map((entry) => {
    const row = entry as Record<(typeof fields)[number], number>;
    return {
      itemSequence: row.itemSequence,
      allowedCents: row.allowedCents,
      paidCents: row.paidCents,
      deductibleCents: row.deductibleCents,
      coinsuranceCents: row.coinsuranceCents,
      copayCents: row.copayCents,
    };
  });
}

function claimItemSubmittedCents(item: NonNullable<Claim["item"]>[number]): number {
  const net = item.net?.value;
  if (net !== undefined && Number.isFinite(net)) return Math.round(net * 100);
  const unitPrice = item.unitPrice?.value;
  const quantity = item.quantity?.value ?? 1;
  if (unitPrice === undefined || !Number.isFinite(unitPrice) || !Number.isFinite(quantity)) {
    throw new ManualEobValidationError(`Claim item ${item.sequence} is missing its submitted amount.`);
  }
  return Math.round(unitPrice * quantity * 100);
}

function bundleResources<T extends Resource>(bundle: { entry?: Array<{ resource?: T }> }): T[] {
  return bundle.entry?.flatMap((entry) => entry.resource ? [entry.resource] : []) ?? [];
}

function claimReferenceIds(
  claims: readonly Claim[],
  resourceType: "Patient" | "Practitioner" | "PractitionerRole" | "Organization" | "Location",
): string[] {
  const references = claims.flatMap((claim) => [
    claim.patient.reference,
    claim.provider?.reference,
    claim.insurer?.reference,
    claim.facility?.reference,
  ]).filter((reference): reference is string => Boolean(reference));
  return [...new Set(references.flatMap((reference) => {
    const match = reference.match(new RegExp(`^${resourceType}/([A-Za-z0-9.-]+)$`));
    return match ? [match[1]] : [];
  }))];
}
