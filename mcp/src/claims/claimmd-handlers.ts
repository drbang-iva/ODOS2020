import type {
  Claim,
  ClaimResponse,
  CoverageEligibilityRequest,
  CoverageEligibilityResponse,
  PaymentReconciliation,
} from "@medplum/fhirtypes";
import type { OsodActorRole, OsodAuditEventRecord } from "../authz/osodAudit.js";
import { assertBusinessActionAllowed, PRACTICE_ROLE_IDS, type PracticeRoleId } from "../authz/roles.js";
import { buildInsurancePaymentReconciliation, CLAIMMD_ERA_PAYMENT_SYSTEM } from "../payments/payment-reconciliation.js";
import { buildClaimAuditRecord, type ClaimAuditEventType } from "./claim-audit.js";
import type { ClaimMdAdapter } from "./claimmd-adapter.js";
import {
  buildClaimMdProfessionalClaimJson,
  buildClaimResponseFromClaimMdEra,
  buildClaimResponseFromClaimMdStatus,
  buildCoverageEligibilityRequest,
  buildCoverageEligibilityResponseFromClaimMd,
  buildProfessionalClaim,
  medicalEligibilitySummary,
  type ClaimMdEraClaim,
  type ClaimMdEraData,
  type ProfessionalClaimInput,
} from "./claimmd-fhir.js";

export interface AuthenticatedClaimsStaff {
  staffReference: string;
  actorRole: OsodActorRole;
  fhir: {
    create<T extends Claim | ClaimResponse | CoverageEligibilityRequest | CoverageEligibilityResponse | PaymentReconciliation>(resource: T): Promise<T>;
  };
}

export interface ClaimsHandlerDeps {
  authenticate(authHeader: string | undefined): Promise<AuthenticatedClaimsStaff | null>;
  adapter: ClaimMdAdapter | null;
  recordAudit(row: OsodAuditEventRecord): Promise<void>;
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
      messageOf(error),
    );
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
    await audit(deps, auth, "eligibility.check.failed", "failure", request ? ref(request) : "CoverageEligibilityRequest/uncreated", body.patientReference, messageOf(error));
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
    return { status: 200, body: { claimResponseId: response.id, response } };
  } catch (error) {
    await audit(deps, auth, "claim.status.checked", "failure", `Claim/${input.params.id}`, patientReference, messageOf(error));
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
  };
  if (!body.eraId || !body.claimReferenceByPcn || !body.patientReferenceByPcn || !body.insurerReference) {
    return { status: 400, body: { error: "eraId, claimReferenceByPcn, patientReferenceByPcn, and insurerReference are required." } };
  }

  const claimResponseIds: string[] = [];
  const paymentReconciliationIds: string[] = [];
  let posted = 0;
  let flagged = 0;
  try {
    const era = await deps.adapter.retrieveEraData(body.eraId) as ClaimMdEraData;
    for (const eraClaim of arrayOf(era.claim)) {
      const pcn = eraClaim.pcn ?? "";
      const claimReference = body.claimReferenceByPcn[pcn];
      const patientReference = body.patientReferenceByPcn[pcn];
      if (!claimReference || !patientReference) {
        flagged += 1;
        continue;
      }

      const response = await auth.fhir.create(buildClaimResponseFromClaimMdEra({
        claimReference,
        patientReference,
        insurerReference: body.insurerReference,
        providerReference: body.providerReference,
        created: today(deps),
        era: { ...era, claim: eraClaim },
      }));
      claimResponseIds.push(response.id!);

      const paidCents = Math.round((response.payment?.amount.value ?? 0) * 100);
      if (paidCents > 0) {
        const pr = await auth.fhir.create(buildInsurancePaymentReconciliation({
          createdIso: now(deps),
          paymentDate: response.payment?.date ?? today(deps),
          amountCents: paidCents,
          claimReference,
          claimResponseReference: ref(response),
          insurerReference: body.insurerReference,
          practiceOrgReference: body.practiceOrgReference,
          processorTransactionId: era.eraid ?? body.eraId,
          processorTransactionSystem: CLAIMMD_ERA_PAYMENT_SYSTEM,
          description: `Claim.MD ERA ${era.eraid ?? body.eraId}`,
        }));
        paymentReconciliationIds.push(pr.id!);
      }
      posted += 1;
    }
    await audit(deps, auth, "era.import.completed", "success", `PaymentReconciliation/${paymentReconciliationIds[0] ?? "none"}`);
    return { status: 200, body: { eraId: body.eraId, posted, flagged, claimResponseIds, paymentReconciliationIds } };
  } catch (error) {
    await audit(deps, auth, "era.import.failed", "failure", `Claim.MD/ERA/${body.eraId}`, undefined, messageOf(error));
    return { status: 502, body: { error: `ERA import failed: ${messageOf(error)}` } };
  }
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
): Promise<void> {
  await deps.recordAudit(buildClaimAuditRecord({
    eventType,
    staffReference: staff.staffReference,
    actorRole: staff.actorRole,
    patientReference,
    targetReference,
    adapterName: "claimmd",
    outcome,
    reason,
    timestamp: now(deps),
  }));
}

function ref(resource: { resourceType: string; id?: string }): string {
  if (!resource.id) throw new Error(`${resource.resourceType} create did not return an id.`);
  return `${resource.resourceType}/${resource.id}`;
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

function stringValue(value: unknown): string | undefined {
  if (typeof value === "string" && value.length > 0) return value;
  if (Array.isArray(value)) return stringValue(value[0]);
  return undefined;
}
