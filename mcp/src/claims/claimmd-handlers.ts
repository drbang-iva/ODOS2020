import type {
  Basic,
  Bundle,
  ChargeItem,
  Claim,
  ClaimResponse,
  CoverageEligibilityRequest,
  CoverageEligibilityResponse,
  Invoice,
  PaymentReconciliation,
  Resource,
  Task,
} from "@medplum/fhirtypes";
import { createHash } from "node:crypto";
import { buildOdosAuditEventRow, type OdosActorRole, type OdosAuditEventRecord } from "../authz/odosAudit.js";
import { assertBusinessActionAllowed, PRACTICE_ROLE_IDS, type PracticeRoleId } from "../authz/roles.js";
import type { MedplumClient } from "../fhir-client.js";
import { FhirSearchLimitError, searchAll } from "../fhir-search.js";
import {
  buildInsurancePaymentReconciliation,
  claimResponseLinePaymentAllocations,
  CLAIMMD_ERA_PAYMENT_SYSTEM,
  STEDI_ERA_PAYMENT_SYSTEM,
} from "../payments/payment-reconciliation.js";
import { StaffRoleServiceUnavailableError } from "../payments/payment-endpoint.js";
import { buildClaimAuditRecord, type ClaimAuditEventType } from "./claim-audit.js";
import { ClaimSubmissionValidationError } from "./claim-errors.js";
import {
  isClaimSearchStatus,
  type ClaimSearchFilters,
} from "./claim-search.js";
import type { ClaimReadModelStore } from "./claim-read-model-store.js";
import {
  claimProjectionUnavailableBody,
  type ClaimReadModelProjectionHealthTracker,
} from "./claim-read-model-health.js";
import {
  buildClaimTouchTransaction,
  claimTouchIdempotencyFingerprint,
  claimTouchRequestFingerprint,
} from "./claim-touch-ledger.js";
import type { ClaimMdAdapter } from "./claimmd-adapter.js";
import {
  isClearinghouseId,
  selectClearinghouseAdapter,
  type ClearinghouseAdapters,
  type ClearinghouseId,
  type ClearinghouseRoutingDefaults,
} from "./clearinghouse-adapter.js";
import {
  CLAIM_REJECTED_CODE_SYSTEM,
  ERA_WORKLIST_INPUT_SYSTEM,
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
  projectStediEraBatchReadModel,
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
  claimDiagnosisSequence,
  medicalEligibilitySummary,
  ODOS_CLAIM_CHARGE_ITEM_EXTENSION_URL,
  type ClaimMdEraClaim,
  type ClaimMdEraData,
  type ManualClaimResponseLineInput,
  type ProfessionalClaimChargeItemInput,
  type ProfessionalClaimInput,
} from "./claimmd-fhir.js";
import { buildClaimDraft, ClaimDraftAssemblyError } from "./claim-draft.js";
import { FhirDiagnosisCatalogStore } from "../clinical-graph/diagnosis-catalog-store.js";
import { StediRequestError, type StediAdapter } from "./stedi-adapter.js";
import {
  analyzeStediEraClaim,
  buildClaimResponseFromStediEra,
  buildClaimResponseFromStediStatus,
  buildCoverageEligibilityResponseFromStedi,
  buildStediProfessionalClaimJson,
  determineStediClaimResubmission,
  readStediEra,
  readStedi277,
  stediClaimInputSnapshot,
  withStediClaimInputSnapshot,
  type StediClaimResubmissionIntent,
  type StediPayerClassification,
  type Stedi277Claim,
  type StediEraClaim,
} from "./stedi-fhir.js";
import {
  MANUAL_EOB_CODE,
  MANUAL_EOB_CODE_SYSTEM,
  MANUAL_EOB_IDENTIFIER_SYSTEM,
  PROVIDER_ADJUSTMENT_CODE,
  PROVIDER_ADJUSTMENT_IDENTIFIER_SYSTEM,
  REMITTANCE_BATCH_CODE,
  REMITTANCE_BATCH_CODE_SYSTEM,
  REMITTANCE_BATCH_IDENTIFIER_SYSTEM,
  ManualEobValidationError,
  appendRemittanceAllocation,
  appendManualEobPosting,
  buildProviderAdjustment,
  buildRemittanceBatch,
  buildManualEobHeader,
  closeManualEobHeader,
  parseProviderAdjustment,
  parseRemittanceBatch,
  parseManualEobHeader,
  projectRemittanceBatch,
} from "./manual-eob.js";
import {
  PATIENT_RESPONSIBILITY_INVOICE_IDENTIFIER_SYSTEM,
  PatientResponsibilityInvoiceUnavailableError,
  buildPatientResponsibilityInvoice,
  patientResponsibilityInvoiceMatches,
} from "./patient-responsibility-invoice.js";

const CLAIM_CHARGE_ITEM_IDENTIFIER_SYSTEM = "https://odos2020.com/fhir/NamingSystem/claim-charge-item";
const ERA_DISCREPANCY_IDENTIFIER_SYSTEM = "https://odos2020.com/fhir/NamingSystem/era-worklist-discrepancy";
const CLAIM_PCN_IDENTIFIER_SYSTEM = "https://odos2020.com/fhir/NamingSystem/odos-claim-pcn";
export const STEDI_277CA_IDENTIFIER_SYSTEM = "https://odos2020.com/fhir/NamingSystem/stedi-277ca";

export interface AuthenticatedClaimsStaff {
  staffReference: string;
  actorRole: OdosActorRole;
  fhir: Pick<MedplumClient, "baseUrl" | "create" | "search" | "searchUrl" | "read" | "update">
    & Partial<Pick<MedplumClient, "executeTransaction">>;
}

export interface ClaimsHandlerDeps {
  authenticate(authHeader: string | undefined): Promise<AuthenticatedClaimsStaff | null>;
  adapter: ClaimMdAdapter | null;
  adapters?: ClearinghouseAdapters;
  routingDefaults?: ClearinghouseRoutingDefaults;
  recordAudit(row: OdosAuditEventRecord): Promise<void>;
  eraUnderpaymentThresholdCents?: number;
  now?: () => string;
  claimReadModel?: ClaimReadModelStore;
  projectionHealth?: ClaimReadModelProjectionHealthTracker;
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
  const body = input.body as { claim?: ProfessionalClaimInput; clearinghouse?: unknown };
  if (!body.claim) return { status: 400, body: { error: "claim is required." } };
  if (body.claim.claimFrequencyCode !== undefined || body.claim.claimControlNumber !== undefined) {
    return { status: 400, body: { error: "Corrected and voided claims must use the Stedi resubmission endpoint." } };
  }
  const selection = clearinghouseSelection(deps, body.clearinghouse, "transaction");
  if ("status" in selection) return selection;

  let createdClaim: Claim | undefined;
  try {
    for (const [index, chargeItem] of body.claim.chargeItems.entries()) {
      try {
        claimDiagnosisSequence(chargeItem, body.claim.diagnoses.length);
      } catch (error) {
        throw new ClaimSubmissionValidationError(`ChargeItem ${index + 1}: ${messageOf(error)}`);
      }
    }
    const persistedChargeItems = await persistClaimChargeItems(
      auth,
      body.claim.chargeItems,
      body.claim.patientReference,
      body.claim.patientAccountNumber,
    );
    const claimInput = { ...body.claim, chargeItems: persistedChargeItems };
    const claim = buildProfessionalClaim(claimInput);
    const claimToCreate = selection.id === "stedi"
      ? withStediClaimInputSnapshot(claim, body.claim)
      : claim;
    createdClaim = await auth.fhir.create(claimToCreate);
    const result = selection.id === "claimmd"
      ? await (selection.adapter as ClaimMdAdapter).submitProfessionalClaim({
        fileName: `${body.claim.patientAccountNumber}.json`,
        payload: buildClaimMdProfessionalClaimJson(body.claim, createdClaim),
      })
      : await (selection.adapter as StediAdapter).submitProfessionalClaim({
        idempotencyKey: body.claim.patientAccountNumber,
        payload: buildStediProfessionalClaimJson(
          body.claim,
          createdClaim,
          (selection.adapter as StediAdapter).mode,
          (selection.adapter as StediAdapter).submitterId,
        ),
      });
    await audit(deps, auth, "claim.submit.completed", "success", ref(createdClaim), body.claim.patientReference, undefined, selection.id);
    const claimMdResult = selection.id === "claimmd" ? result as Awaited<ReturnType<ClaimMdAdapter["submitProfessionalClaim"]>> : undefined;
    const stediResult = selection.id === "stedi" ? result as Awaited<ReturnType<StediAdapter["submitProfessionalClaim"]>> : undefined;
    return {
      status: 200,
      body: {
        claimId: createdClaim.id,
        ...(claimMdResult ? {
          claimMdClaimId: claimMdResult.claims[0]?.claimMdClaimId,
          claimMdTrackingNumber: claimMdResult.claims[0]?.claimMdId,
          status: claimMdResult.claims[0]?.status,
        } : {
          clearinghouse: "stedi",
          stediCorrelationId: stediResult?.claimReference?.correlationId,
          stediTrackingNumber: stediResult?.claimReference?.customerClaimNumber,
          status: "submitted",
        }),
      },
    };
  } catch (error) {
    if (error instanceof ClaimSubmissionValidationError) {
      return { status: 400, body: { error: error.message } };
    }
    await audit(
      deps,
      auth,
      "claim.submit.failed",
      "failure",
      createdClaim ? ref(createdClaim) : "Claim/uncreated",
      body.claim.patientReference,
      clearinghouseFailureAuditReason(selection.id, "submitProfessionalClaim", error),
      selection.id,
    );
    try {
      await createAndAuditClaimRejectedTask(deps, auth, {
        claimReference: createdClaim ? ref(createdClaim) : undefined,
        patientReference: body.claim.patientReference,
        claimMdMessage: messageOf(error),
        adapterName: selection.id,
      });
    } catch {
      // The failed Claim create may reflect a broader FHIR write outage; the failure response must still return.
    }
    return { status: 502, body: { error: `Claim submission failed: ${messageOf(error)}` } };
  }
}

export async function handleStediClaimResubmissionPreviewRequest(
  deps: ClaimsHandlerDeps,
  input: { authHeader: string | undefined; body: unknown },
): Promise<ClaimsHandlerResult> {
  const auth = await authenticateClaimsManager(deps, input.authHeader);
  if ("status" in auth) return auth;
  const body = input.body as {
    originalClaimReference?: unknown;
    intent?: unknown;
    payerClassification?: unknown;
  };
  const parsed = parseStediResubmissionRequest(body);
  if ("status" in parsed) return parsed;
  try {
    const context = await stediResubmissionContext(auth, parsed);
    await deps.recordAudit(buildOdosAuditEventRow({
      eventType: "read",
      actorReference: auth.staffReference,
      actorRole: auth.actorRole,
      patientReference: context.claim.patient.reference,
      targetReference: parsed.originalClaimReference,
      actionOutcome: "granted",
      actionReason: "CLAIM_RESUBMISSION_PREVIEW",
      eventTime: now(deps),
    }));
    return {
      status: 200,
      body: context.snapshot
        ? { determination: context.determination, originalClaim: context.snapshot }
        : {
            determination: {
              status: "manual",
              reason: "This claim predates the ODOS Stedi submission snapshot and cannot be rebuilt safely. Handle it manually.",
            },
          },
    };
  } catch (error) {
    return claimReadFailure(parsed.originalClaimReference, error);
  }
}

export async function handleStediClaimResubmissionRequest(
  deps: ClaimsHandlerDeps,
  input: { authHeader: string | undefined; body: unknown },
): Promise<ClaimsHandlerResult> {
  const auth = await authenticateClaimsManager(deps, input.authHeader);
  if ("status" in auth) return auth;
  const body = input.body as {
    originalClaimReference?: unknown;
    intent?: unknown;
    payerClassification?: unknown;
    patientControlNumber?: unknown;
    revisedClaim?: ProfessionalClaimInput;
  };
  const parsed = parseStediResubmissionRequest(body);
  if ("status" in parsed) return parsed;
  const patientControlNumber = trimmedValue(body.patientControlNumber);
  if (!patientControlNumber) {
    return { status: 400, body: { error: "patientControlNumber is required for the new claim." } };
  }

  const selection = clearinghouseSelection(deps, "stedi", "transaction");
  if ("status" in selection) return selection;
  let context: Awaited<ReturnType<typeof stediResubmissionContext>>;
  try {
    context = await stediResubmissionContext(auth, parsed);
  } catch (error) {
    return claimReadFailure(parsed.originalClaimReference, error);
  }
  let createdClaim: Claim | undefined;
  let patientReference: string | undefined;
  try {
    if (!context.snapshot) {
      return {
        status: 409,
        body: { error: "This claim predates the ODOS Stedi submission snapshot and must be handled manually." },
      };
    }
    if (context.determination.status === "manual") {
      return { status: 409, body: { error: context.determination.reason, determination: context.determination } };
    }
    if (patientControlNumber === context.snapshot.patientAccountNumber) {
      return { status: 400, body: { error: "A resubmission requires a new patientControlNumber." } };
    }
    if (parsed.intent === "correct" && !body.revisedClaim) {
      return { status: 400, body: { error: "revisedClaim is required for a correction." } };
    }
    const source = parsed.intent === "correct" ? body.revisedClaim! : context.snapshot;
    patientReference = source.patientReference;
    if (
      source.patientReference !== context.claim.patient.reference
      || source.coverageReference !== context.snapshot.coverageReference
    ) {
      return { status: 400, body: { error: "The revised claim must retain the original patient and Coverage." } };
    }
    const resubmissionInput: ProfessionalClaimInput = {
      ...source,
      created: today(deps),
      patientAccountNumber: patientControlNumber,
      claimFrequencyCode: context.determination.claimFrequencyCode,
      ...(context.determination.claimControlNumber
        ? { claimControlNumber: context.determination.claimControlNumber }
        : { claimControlNumber: undefined }),
    };
    for (const [index, chargeItem] of resubmissionInput.chargeItems.entries()) {
      try {
        claimDiagnosisSequence(chargeItem, resubmissionInput.diagnoses.length);
      } catch (error) {
        throw new ClaimSubmissionValidationError(`ChargeItem ${index + 1}: ${messageOf(error)}`);
      }
    }
    const persistedChargeItems = await persistClaimChargeItems(
      auth,
      resubmissionInput.chargeItems,
      resubmissionInput.patientReference,
      patientControlNumber,
    );
    const claim = buildProfessionalClaim({ ...resubmissionInput, chargeItems: persistedChargeItems });
    claim.related = [{
      claim: { reference: parsed.originalClaimReference },
      relationship: { text: parsed.intent === "correct" ? "replacement" : "void" },
    }];
    const payload = buildStediProfessionalClaimJson(
      resubmissionInput,
      claim,
      (selection.adapter as StediAdapter).mode,
      (selection.adapter as StediAdapter).submitterId,
    );
    createdClaim = await auth.fhir.create(withStediClaimInputSnapshot(claim, resubmissionInput));
    const result = await (selection.adapter as StediAdapter).submitProfessionalClaim({
      idempotencyKey: patientControlNumber,
      payload,
    });
    const touchAt = now(deps);
    const touchOutcome = await recordResubmissionTouch(auth, context.claim, patientControlNumber, touchAt);
    if (touchOutcome === "conflict") {
      return { status: 409, body: { error: "The resubmission idempotency key was already used for different touch content." } };
    }
    if (touchOutcome === "failed") {
      deps.projectionHealth?.invalidate(touchAt);
      return { status: 503, body: { error: "Claim was transmitted, but the original Claim touch could not be recorded; retry reconciliation before continuing." } };
    }
    if (touchOutcome === "recorded" || touchOutcome === "reconciled") {
      deps.projectionHealth?.invalidate(touchAt);
    }
    await audit(
      deps,
      auth,
      "claim.submit.completed",
      "success",
      ref(createdClaim),
      patientReference,
      `resubmission intent=${parsed.intent} cfc=${context.determination.claimFrequencyCode} payerClassification=${parsed.payerClassification ?? "not-required"}`,
      "stedi",
    );
    return {
      status: 200,
      body: {
        claimId: createdClaim.id,
        claimReference: ref(createdClaim),
        originalClaimReference: parsed.originalClaimReference,
        intent: parsed.intent,
        claimFrequencyCode: context.determination.claimFrequencyCode,
        ...(context.determination.claimControlNumber
          ? { claimControlNumber: context.determination.claimControlNumber }
          : {}),
        clearinghouse: "stedi",
        stediCorrelationId: result.claimReference?.correlationId,
        stediTrackingNumber: result.claimReference?.customerClaimNumber,
        status: "submitted",
      },
    };
  } catch (error) {
    if (error instanceof ClaimSubmissionValidationError) {
      return { status: 400, body: { error: error.message } };
    }
    await audit(
      deps,
      auth,
      "claim.submit.failed",
      "failure",
      createdClaim ? ref(createdClaim) : parsed.originalClaimReference,
      patientReference,
      clearinghouseFailureAuditReason("stedi", "submitProfessionalClaim", error),
      "stedi",
    );
    try {
      await createAndAuditClaimRejectedTask(deps, auth, {
        claimReference: createdClaim ? ref(createdClaim) : parsed.originalClaimReference,
        patientReference,
        claimMdMessage: messageOf(error),
        adapterName: "stedi",
      });
    } catch {
      // The submission failure response must still return if the worklist write is unavailable.
    }
    return { status: 502, body: { error: `Claim resubmission failed: ${messageOf(error)}` } };
  }
}

async function recordResubmissionTouch(
  auth: AuthenticatedClaimsStaff,
  claim: Claim,
  patientControlNumber: string,
  at: string,
): Promise<"recorded" | "reconciled" | "existing" | "conflict" | "failed"> {
  if (!auth.fhir.executeTransaction || !claim.id) return "failed";
  const key = `stedi-${createHash("sha256").update(patientControlNumber).digest("hex")}`;
  const fingerprint = claimTouchRequestFingerprint({
    claimReference: `Claim/${claim.id}`,
    actorReference: auth.staffReference,
    actorRole: auth.actorRole,
    action: "resubmission",
  });
  const existing = claimTouchIdempotencyFingerprint(claim, key);
  if (existing) return existing === fingerprint ? "existing" : "conflict";
  try {
    await auth.fhir.executeTransaction(buildClaimTouchTransaction({
      claim,
      principal: { kind: "human", actorReference: auth.staffReference, actorRole: auth.actorRole },
      action: "resubmission",
      at,
      idempotency: { key, fingerprint },
    }));
    return "recorded";
  } catch {
    try {
      const committed = await auth.fhir.read<Claim>("Claim", claim.id);
      const committedFingerprint = claimTouchIdempotencyFingerprint(committed, key);
      if (!committedFingerprint) return "failed";
      return committedFingerprint === fingerprint ? "reconciled" : "conflict";
    } catch {
      return "failed";
    }
  }
}

export async function handleClaimDraftRequest(
  deps: ClaimsHandlerDeps,
  input: { authHeader: string | undefined; encounterId?: string },
): Promise<ClaimsHandlerResult> {
  const auth = await authenticateClaimsManager(deps, input.authHeader);
  if ("status" in auth) return auth;
  try {
    const diagnosisCatalog = await new FhirDiagnosisCatalogStore(auth.fhir).list();
    const draft = await buildClaimDraft(auth.fhir, input.encounterId ?? "", diagnosisCatalog);
    await deps.recordAudit(buildOdosAuditEventRow({
      eventType: "read",
      actorReference: auth.staffReference,
      actorRole: auth.actorRole,
      patientReference: draft.patientReference,
      targetReference: draft.encounterReference,
      actionOutcome: "granted",
      actionReason: "CLAIM_DRAFT",
      eventTime: now(deps),
    }));
    return { status: 200, body: draft };
  } catch (error) {
    if (error instanceof ClaimDraftAssemblyError) {
      return { status: 400, body: { error: error.message } };
    }
    if (error instanceof FhirSearchLimitError) {
      return { status: 409, body: { error: error.message } };
    }
    return { status: 502, body: { error: "Unable to assemble the encounter claim draft." } };
  }
}

export async function handleEligibilityCheckRequest(
  deps: ClaimsHandlerDeps,
  input: { authHeader: string | undefined; body: unknown },
): Promise<ClaimsHandlerResult> {
  const auth = await authenticateClaimsManager(deps, input.authHeader);
  if ("status" in auth) return auth;
  const body = input.body as {
    patientReference?: string;
    coverageReference?: string;
    insurerReference?: string;
    providerReference?: string;
    serviceDate?: string;
    claimMd?: Record<string, string>;
    stedi?: Record<string, unknown>;
    clearinghouse?: unknown;
  };
  const selection = clearinghouseSelection(deps, body.clearinghouse, "transaction");
  if ("status" in selection) return selection;
  const vendorRequest = selection.id === "claimmd" ? body.claimMd : body.stedi;
  if (!body.patientReference || !body.coverageReference || !body.insurerReference || !body.serviceDate || !vendorRequest) {
    return { status: 400, body: { error: `patientReference, coverageReference, insurerReference, serviceDate, and ${selection.id} are required.` } };
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
    const vendorResponse = selection.id === "claimmd"
      ? await (selection.adapter as ClaimMdAdapter).checkEligibility(vendorRequest as Record<string, string>)
      : await (selection.adapter as StediAdapter).checkEligibility(vendorRequest);
    const responseInput = {
      requestReference: ref(request),
      patientReference: body.patientReference,
      coverageReference: body.coverageReference,
      insurerReference: body.insurerReference,
      requestorReference: body.providerReference,
      created: today(deps),
    };
    const response = await auth.fhir.create(selection.id === "claimmd"
      ? buildCoverageEligibilityResponseFromClaimMd({ ...responseInput, claimMd: vendorResponse })
      : buildCoverageEligibilityResponseFromStedi({ ...responseInput, stedi: vendorResponse }));
    await audit(deps, auth, "eligibility.check.completed", "success", ref(response), body.patientReference, undefined, selection.id);
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
      clearinghouseFailureAuditReason(selection.id, "checkEligibility", error),
      selection.id,
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
  const body = input.body as {
    claimMdClaimId?: unknown;
    patientReference?: unknown;
    insurerReference?: unknown;
    providerReference?: unknown;
    responseId?: unknown;
    stedi?: unknown;
    clearinghouse?: unknown;
  };
  const selection = clearinghouseSelection(deps, body.clearinghouse, "transaction");
  if ("status" in selection) return selection;
  const claimMdClaimId = stringValue(body.claimMdClaimId);
  const patientReference = stringValue(body.patientReference);
  const insurerReference = stringValue(body.insurerReference);
  const providerReference = stringValue(body.providerReference);
  const responseId = stringValue(body.responseId);
  if (!input.params.id || !patientReference || !insurerReference || (selection.id === "claimmd" && !claimMdClaimId) || (selection.id === "stedi" && !body.stedi)) {
    return { status: 400, body: { error: `claim id, ${selection.id === "claimmd" ? "claimMdClaimId" : "stedi"}, patientReference, and insurerReference are required.` } };
  }

  try {
    const status = selection.id === "claimmd"
      ? await (selection.adapter as ClaimMdAdapter).checkClaimStatus({ claimMdClaimId: claimMdClaimId!, responseId })
      : await (selection.adapter as StediAdapter).checkClaimStatus(body.stedi);
    const responseInput = {
      claimReference: `Claim/${input.params.id}`,
      patientReference,
      insurerReference,
      providerReference,
      created: today(deps),
      status,
    };
    const response = await auth.fhir.create(selection.id === "claimmd"
      ? buildClaimResponseFromClaimMdStatus(responseInput)
      : buildClaimResponseFromStediStatus(responseInput));
    await audit(deps, auth, "claim.status.checked", "success", ref(response), patientReference, undefined, selection.id);
    if (response.outcome === "error") {
      await createAndAuditClaimRejectedTask(deps, auth, {
        claimReference: `Claim/${input.params.id}`,
        patientReference,
        claimMdMessage: response.disposition ?? "",
        adapterName: selection.id,
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
      clearinghouseFailureAuditReason(selection.id, "checkClaimStatus", error),
      selection.id,
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

  const body = input.body as {
    eraId?: string;
    claimReferenceByPcn?: Record<string, string>;
    patientReferenceByPcn?: Record<string, string>;
    insurerReference?: string;
    providerReference?: string;
    practiceOrgReference?: string;
    appealDeadlineByPcn?: Record<string, string>;
    clearinghouse?: unknown;
  };
  if (!body.eraId || !body.claimReferenceByPcn || !body.patientReferenceByPcn || !body.insurerReference) {
    return { status: 400, body: { error: "eraId, claimReferenceByPcn, patientReferenceByPcn, and insurerReference are required." } };
  }
  const selection = clearinghouseSelection(deps, body.clearinghouse, "era");
  if ("status" in selection) return selection;
  if (selection.id === "stedi") {
    return importStediEra(deps, auth, selection.adapter as StediAdapter, body as Required<Pick<typeof body,
      "eraId" | "claimReferenceByPcn" | "patientReferenceByPcn" | "insurerReference"
    >> & typeof body);
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
    const era = await (selection.adapter as ClaimMdAdapter).retrieveEraData(body.eraId) as ClaimMdEraData;
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
      flagged += result.flagged;
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
      clearinghouseFailureAuditReason("claimmd", "retrieveEraData", error),
      "claimmd",
    );
    return { status: 502, body: { error: `ERA import failed: ${messageOf(error)}` } };
  }
}

export async function handleStedi277ImportRequest(
  deps: ClaimsHandlerDeps,
  input: { authHeader: string | undefined; body: unknown },
): Promise<ClaimsHandlerResult> {
  const auth = await authenticateClaimsManager(deps, input.authHeader);
  if ("status" in auth) return auth;
  const body = input.body as { clearinghouse?: unknown; pageToken?: unknown; startDateTime?: unknown };
  const selection = clearinghouseSelection(deps, body.clearinghouse, "transaction");
  if ("status" in selection) return selection;
  if (!selection.adapter.list277s || !selection.adapter.retrieve277Data) {
    return {
      status: 501,
      body: { error: `${selection.id === "claimmd" ? "Claim.MD" : "The selected clearinghouse"} does not support 277CA retrieval.` },
    };
  }

  try {
    const rawList = await selection.adapter.list277s({
      ...(stringValue(body.pageToken) ? { pageToken: stringValue(body.pageToken) } : {}),
      ...(stringValue(body.startDateTime) ? { startDateTime: stringValue(body.startDateTime) } : {}),
    });
    const transactionIds = stedi277TransactionIds(rawList);
    const nextPageToken = stedi277NextPageToken(rawList);
    const claimsByPcn = new Map<string, Claim[]>();
    const acknowledgments: Array<{
      transactionId: string;
      status: "processed" | "review";
      claims: Array<{
        patientControlNumber: string;
        outcome: Stedi277Claim["outcome"];
        claimReference?: string;
        taskId?: string;
        reasons: string[];
      }>;
      issues?: string[];
    }> = [];

    for (const transactionId of transactionIds) {
      try {
        const report = readStedi277(await selection.adapter.retrieve277Data(transactionId), transactionId);
        const claimResults: (typeof acknowledgments)[number]["claims"] = [];
        let requiresReview = report.issues.length > 0;
        if (report.issues.length > 0) {
          await createAndAuditClaimRejectedTask(deps, auth, {
            claimMdMessage: `Stedi 277CA ${report.transactionId} requires review: ${report.issues.join(" ")}`,
            adapterName: "stedi",
            identifier: stedi277TaskIdentifier(report.transactionId, "report"),
          });
        }
        for (const claimAcknowledgment of report.claims) {
          const claimKey = claimAcknowledgment.patientControlNumber.toLowerCase();
          let matchingClaims = claimsByPcn.get(claimKey);
          if (!matchingClaims) {
            matchingClaims = await localClaimsForPcn(auth, claimAcknowledgment.patientControlNumber);
            claimsByPcn.set(claimKey, matchingClaims);
          }
          const localClaim = matchingClaims.length === 1 ? matchingClaims[0] : undefined;
          const claimReference = localClaim?.id ? `Claim/${localClaim.id}` : undefined;
          const correlationIssue = matchingClaims.length > 1
            ? `Multiple local Claims match patient control number ${claimAcknowledgment.patientControlNumber}.`
            : matchingClaims.length === 0
              ? `No local Claim matches patient control number ${claimAcknowledgment.patientControlNumber}.`
              : undefined;
          const shouldCreateTask = claimAcknowledgment.outcome === "rejected"
            || claimAcknowledgment.outcome === "review"
            || Boolean(correlationIssue);
          requiresReview ||= claimAcknowledgment.outcome === "review" || Boolean(correlationIssue);
          let taskId: string | undefined;
          if (shouldCreateTask) {
            const task = await createAndAuditClaimRejectedTask(deps, auth, {
              claimReference,
              patientReference: localClaim?.patient.reference,
              claimMdMessage: stedi277TaskMessage(claimAcknowledgment, correlationIssue),
              adapterName: "stedi",
              identifier: stedi277TaskIdentifier(
                report.transactionId,
                claimAcknowledgment.patientControlNumber.toLowerCase(),
              ),
            });
            taskId = requiredId(task);
          }
          claimResults.push({
            patientControlNumber: claimAcknowledgment.patientControlNumber,
            outcome: claimAcknowledgment.outcome,
            ...(claimReference ? { claimReference } : {}),
            ...(taskId ? { taskId } : {}),
            reasons: claimAcknowledgment.reasons,
          });
        }
        acknowledgments.push({
          transactionId: report.transactionId,
          status: requiresReview ? "review" : "processed",
          claims: claimResults,
          ...(report.issues.length ? { issues: report.issues } : {}),
        });
      } catch (error) {
        try {
          await createAndAuditClaimRejectedTask(deps, auth, {
            claimMdMessage: `Stedi 277CA ${transactionId} is malformed or could not be retrieved and requires review: ${messageOf(error)}`,
            adapterName: "stedi",
            identifier: stedi277TaskIdentifier(transactionId, "report"),
          });
        } catch (taskError) {
          console.error(`odos-mcp: Stedi 277CA ${transactionId} failure-path worklist/audit write failed:`, taskError);
        }
        acknowledgments.push({
          transactionId,
          status: "review",
          claims: [],
          issues: [messageOf(error)],
        });
      }
    }
    return {
      status: 200,
      body: { acknowledgments, ...(nextPageToken ? { nextPageToken } : {}) },
    };
  } catch (error) {
    return { status: 502, body: { error: `277CA polling failed: ${messageOf(error)}` } };
  }
}

async function importStediEra(
  deps: ClaimsHandlerDeps,
  auth: AuthenticatedClaimsStaff,
  adapter: StediAdapter,
  body: {
    eraId: string;
    claimReferenceByPcn: Record<string, string>;
    patientReferenceByPcn: Record<string, string>;
    insurerReference: string;
    providerReference?: string;
    practiceOrgReference?: string;
    appealDeadlineByPcn?: Record<string, string>;
  },
): Promise<ClaimsHandlerResult> {
  const claimResponseIds: string[] = [];
  const paymentReconciliationIds: string[] = [];
  const taskIds: string[] = [];
  let posted = 0;
  let denied = 0;
  let underpaid = 0;
  let flagged = 0;
  let paidTotalCents = 0;
  let failureOperation = "retrieveEraData";
  try {
    const rawEra = await adapter.retrieveEraData(body.eraId);
    failureOperation = "importEraData";
    const era = readStediEra(rawEra, body.eraId);
    const remittanceBatchIdentifier = `stedi:${era.transactionId}`;
    const batchCandidate = buildRemittanceBatch({
      payerReference: body.insurerReference,
      paymentReference: era.traceNumber ?? era.transactionId,
      remittanceDate: isoStediDate(era.paymentDate),
      creationDate: now(deps),
      totalAmountCents: era.totalAmountCents,
      provenance: "clearinghouse",
      sourceReference: `urn:stedi:835:${era.transactionId}`,
    });
    batchCandidate.identifier = [
      ...(batchCandidate.identifier ?? []),
      { system: REMITTANCE_BATCH_IDENTIFIER_SYSTEM, value: remittanceBatchIdentifier },
    ];
    let remittanceBatch = await auth.fhir.create(batchCandidate, {
      "If-None-Exist": `identifier=${REMITTANCE_BATCH_IDENTIFIER_SYSTEM}|${remittanceBatchIdentifier}`,
    });
    const remittanceBatchId = requiredId(remittanceBatch);
    const providerAdjustmentIds: string[] = [];
    for (const [index, providerAdjustment] of era.providerAdjustments.entries()) {
      const adjustmentIdentifier = `${era.transactionId}:${providerAdjustment.providerAdjustmentIdentifier}:${index + 1}`;
      const adjustment = await auth.fhir.create(buildProviderAdjustment({
        batchReference: ref(remittanceBatch),
        payerReference: body.insurerReference,
        identifier: adjustmentIdentifier,
        reasonCode: providerAdjustment.adjustmentReasonCode,
        reasonText: providerAdjustment.adjustmentReasonText,
        rawSourceAmountCents: providerAdjustment.providerAdjustmentAmountCents,
        sourceSystem: "stedi-835",
        createdAt: now(deps),
      }), {
        "If-None-Exist": `identifier=${PROVIDER_ADJUSTMENT_IDENTIFIER_SYSTEM}|${adjustmentIdentifier}`,
      });
      providerAdjustmentIds.push(requiredId(adjustment));
      await audit(
        deps,
        auth,
        "era.import.completed",
        "success",
        ref(adjustment),
        undefined,
        `provider-level-adjustment batch=${remittanceBatchId}`,
        "stedi",
      );
    }
    await audit(
      deps,
      auth,
      "era.import.completed",
      "success",
      ref(remittanceBatch),
      undefined,
      "remittance-batch",
      "stedi",
    );
    const priorBatchResources = await searchAll<Basic>(auth.fhir, "Basic", {
      code: `${REMITTANCE_BATCH_CODE_SYSTEM}|${REMITTANCE_BATCH_CODE}`,
      _count: "100",
    });
    for (const stediClaim of era.claims) {
      const eraClaim = claimMdLikeStediEraClaim(stediClaim);
      const stediAnalysis = analyzeStediEraClaim(stediClaim);
      const pcn = eraClaim.pcn ?? "";
      const claimReference = body.claimReferenceByPcn[pcn];
      const patientReference = body.patientReferenceByPcn[pcn];
      const taskEra: ClaimMdEraData = {
        eraid: era.transactionId,
        paid_date: era.paymentDate,
        payer_name: era.payerName,
        payment_method: "Stedi ERA",
      };
      if (!claimReference || !patientReference) {
        const task = await auth.fhir.create(buildEraWorklistTask({
          code: "era-unmatched",
          era: taskEra,
          eraClaim,
          authoredOn: now(deps),
          appealDeadline: body.appealDeadlineByPcn?.[pcn],
          identifierSystem: STEDI_ERA_PAYMENT_SYSTEM,
        }));
        taskIds.push(requiredId(task));
        await audit(deps, auth, "era.unmatched.flagged", "success", ref(task), undefined, undefined, "stedi");
        flagged += 1;
        continue;
      }

      const submittedClaimId = claimReference.match(/^Claim\/([A-Za-z0-9.-]{1,64})$/)?.[1];
      let submittedClaim: Claim | undefined;
      if (submittedClaimId) {
        try {
          submittedClaim = await auth.fhir.read<Claim>("Claim", submittedClaimId);
        } catch {
          submittedClaim = undefined;
        }
      }

      const candidateResponse = buildClaimResponseFromStediEra({
        claimReference,
        submittedClaim,
        patientReference,
        insurerReference: body.insurerReference,
        providerReference: body.providerReference,
        created: today(deps),
        transactionId: era.transactionId,
        payerName: era.payerName,
        paymentDate: era.paymentDate,
        traceNumber: era.traceNumber,
        claim: stediClaim,
      });
      const verifiedLinkage = await verifyClaimResponseChargeItemLinks(auth, claimReference, candidateResponse);
      const response = await auth.fhir.create(verifiedLinkage.response);
      claimResponseIds.push(requiredId(response));
      const verifiedPatientReference = response.patient.reference ?? patientReference;
      const paidCents = Math.round((response.payment?.amount.value ?? 0) * 100);
      paidTotalCents += paidCents;
      const evidence = eraWorklistEvidence(eraClaim, era.transactionId);
      const invoiceResult: PatientResponsibilityInvoiceResult = stediAnalysis.allowsPatientResponsibilityInvoice
        ? await ensurePatientResponsibilityInvoice(
          auth,
          claimReference,
          response,
          stediAnalysis.authoritativePatientResponsibilityCents,
        )
        : "none";
      let reconciliation: PaymentReconciliation | undefined;
      if (paidCents > 0 && stediAnalysis.allowsReconciliation) {
        const reconciliationIdentifierValue = `${era.transactionId}:${claimReference}`;
        const reconciliationCandidate = buildInsurancePaymentReconciliation({
          createdIso: now(deps),
          paymentDate: response.payment?.date ?? today(deps),
          amountCents: paidCents,
          claimReference,
          claimResponseReference: ref(response),
          insurerReference: body.insurerReference,
          practiceOrgReference: body.practiceOrgReference,
          processorTransactionId: era.traceNumber ?? era.transactionId,
          processorTransactionSystem: STEDI_ERA_PAYMENT_SYSTEM,
          description: `Stedi ERA ${era.transactionId}`,
          lineAllocations: claimResponseLinePaymentAllocations(response),
        });
        reconciliationCandidate.identifier = [{
          system: STEDI_ERA_PAYMENT_SYSTEM,
          value: reconciliationIdentifierValue,
        }];
        reconciliation = await auth.fhir.create(reconciliationCandidate, {
          "If-None-Exist": `identifier=${STEDI_ERA_PAYMENT_SYSTEM}|${reconciliationIdentifierValue}`,
        });
        paymentReconciliationIds.push(requiredId(reconciliation));
        posted += 1;
      }
      const allocationId = remittanceAllocationId(era.transactionId, claimReference);
      if (paidCents !== 0 && !parseRemittanceBatch(remittanceBatch).allocations.some(
        (allocation) => allocation.id === allocationId,
      )) {
        if (stediAnalysis.claimStatusCode === "22") {
          const claimLineageDepths = await loadClaimLineageDepths(auth, claimReference, submittedClaim);
          const original = findReversedAllocation(
            [...priorBatchResources, remittanceBatch],
            claimReference,
            claimLineageDepths,
            paidCents,
          );
          if (original) {
            remittanceBatch = await persistRemittanceAllocation(
              auth,
              remittanceBatch,
              {
                id: allocationId,
                claimReference,
                claimResponseReference: ref(response),
                amountCents: paidCents,
                origin: "machine-proposed",
                confidence: 1,
                recordedAt: now(deps),
                reversalOfAllocationId: original.allocationId,
                reversalOfBatchReference: original.batchReference,
              },
            );
          }
        } else if (paidCents > 0 && stediAnalysis.allowsReconciliation) {
          remittanceBatch = await persistRemittanceAllocation(
            auth,
            remittanceBatch,
            {
              id: allocationId,
              claimReference,
              claimResponseReference: ref(response),
              ...(reconciliation ? { paymentReconciliationReference: ref(reconciliation) } : {}),
              amountCents: paidCents,
              origin: "machine-proposed",
              confidence: 1,
              recordedAt: now(deps),
            },
          );
        }
      }
      if (verifiedLinkage.reviewReason) {
        const task = await createEraLineLinkageReviewTask(deps, auth, {
          adapterName: "stedi",
          era: taskEra,
          eraClaim,
          claimReference,
          claimResponseReference: ref(response),
          patientReference: verifiedPatientReference,
          reason: verifiedLinkage.reviewReason,
        });
        taskIds.push(requiredId(task));
        flagged += 1;
      }
      const unresolvedReversal = stediAnalysis.claimStatusCode === "22"
        && !parseRemittanceBatch(remittanceBatch).allocations.some((allocation) => allocation.id === allocationId);
      const integrityReviewReasons = [
        ...stediAnalysis.reviewReasons,
        ...(unresolvedReversal
          ? ["Stedi ERA reversal could not be linked to an unreversed prior payment allocation for this claim version lineage."]
          : []),
      ];
      if (integrityReviewReasons.length > 0) {
        const task = await createStediEraIntegrityReviewTask(deps, auth, {
          era: taskEra,
          eraClaim,
          claimReference,
          claimResponseReference: ref(response),
          patientReference: verifiedPatientReference,
          reasons: integrityReviewReasons,
          appealDeadline: body.appealDeadlineByPcn?.[pcn],
        });
        taskIds.push(requiredId(task));
        flagged += 1;
      }
      if (
        stediAnalysis.isDenial
        || (stediAnalysis.allowsReconciliation && (
          invoiceResult === "different"
          || invoiceResult === "unavailable"
          || (evidence.shortfallCents > 0 && evidence.shortfallCents >= (deps.eraUnderpaymentThresholdCents ?? 1))
        ))
      ) {
        const code = stediAnalysis.isDenial ? "era-denial" : "era-underpayment";
        const task = await createAndAuditEraWorklistTask(
          deps,
          auth,
          code,
          { era: taskEra, eraClaim, patientReference: verifiedPatientReference, appealDeadline: body.appealDeadlineByPcn?.[pcn] },
          response,
          "stedi",
        );
        taskIds.push(requiredId(task));
        if (code === "era-denial") denied += 1;
        else underpaid += 1;
      }
    }
    await upsertEraImportRecord(auth, era.transactionId, {
      importedAt: now(deps),
      posted,
      denied,
      underpaid,
      flagged,
      ...(era.payerName ? { payerName: era.payerName } : {}),
      ...(isoStediDate(era.paymentDate) ? { paidDate: isoStediDate(era.paymentDate) } : {}),
      paidTotalCents,
    }, STEDI_ERA_PAYMENT_SYSTEM);
    await audit(deps, auth, "era.import.completed", "success", `PaymentReconciliation/${paymentReconciliationIds[0] ?? "none"}`, undefined, undefined, "stedi");
    return {
      status: 200,
      body: {
        eraId: era.transactionId,
        remittanceBatchId,
        providerAdjustmentIds,
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
      `Stedi/ERA/${body.eraId}`,
      undefined,
      clearinghouseFailureAuditReason("stedi", failureOperation, error),
      "stedi",
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
  const selection = clearinghouseSelection(deps, undefined, "era");
  if ("status" in selection) return selection;

  try {
    const [rawEraList, imports, openTasks] = await Promise.all([
      selection.adapter.listEras(),
      searchAll<Basic>(auth.fhir, "Basic", {
        code: `${ERA_IMPORT_CODE_SYSTEM}|${ERA_IMPORT_CODE}`,
        _count: "100",
      }),
      searchAll<Task>(auth.fhir, "Task", {
        code: `${ERA_WORKLIST_CODE_SYSTEM}|`,
        "business-status": `${ERA_WORKLIST_STATUS_SYSTEM}|new,${ERA_WORKLIST_STATUS_SYSTEM}|in-review`,
        _count: "100",
      }),
    ]);
    const project = selection.id === "stedi" ? projectStediEraBatchReadModel : projectEraBatchReadModel;
    return { status: 200, body: { items: project(rawEraList, searchBundle(imports), searchBundle(openTasks)) } };
  } catch (error) {
    const conflict = paginationConflict(error, "ERA");
    if (conflict) return conflict;
    throw error;
  }
}

export async function handleEraWorklistRequest(
  deps: ClaimsHandlerDeps,
  input: { authHeader: string | undefined; query?: { status?: unknown } },
): Promise<ClaimsHandlerResult> {
  const auth = await authenticateClaimsManager(deps, input.authHeader);
  if ("status" in auth) return auth;
  const requestedStatus = stringValue(input.query?.status);
  if (requestedStatus && requestedStatus !== "open" && !isEraWorklistStatus(requestedStatus)) {
    return { status: 400, body: { error: "status must be open, new, in-review, or resolved." } };
  }
  try {
    const tasks = await searchAll<Task>(auth.fhir, "Task", {
      code: `${ERA_WORKLIST_CODE_SYSTEM}|,${CLAIM_REJECTED_CODE_SYSTEM}|`,
      ...(requestedStatus === "open"
        ? { "business-status": `${ERA_WORKLIST_STATUS_SYSTEM}|new,${ERA_WORKLIST_STATUS_SYSTEM}|in-review` }
        : requestedStatus ? { "business-status": `${ERA_WORKLIST_STATUS_SYSTEM}|${requestedStatus}` } : {}),
      _count: "100",
      _sort: "-authored-on",
    });
    return { status: 200, body: { items: projectEraWorklistBundle(searchBundle(tasks), now(deps)) } };
  } catch (error) {
    const conflict = paginationConflict(error, "Worklist");
    if (conflict) return conflict;
    throw error;
  }
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
  const minDaysOutstanding = wholeNumber(input.query?.minDays);
  const maxDaysOutstanding = wholeNumber(input.query?.maxDays);
  const outstandingOnly = trimmedValue(input.query?.outstanding);
  if (minAmountCents === null || maxAmountCents === null) {
    return { status: 400, body: { error: "minAmount and maxAmount must be non-negative dollar amounts." } };
  }
  if (minAmountCents !== undefined && maxAmountCents !== undefined && minAmountCents > maxAmountCents) {
    return { status: 400, body: { error: "minAmount cannot exceed maxAmount." } };
  }
  if (minDaysOutstanding === null || maxDaysOutstanding === null) {
    return { status: 400, body: { error: "minDays and maxDays must be non-negative whole numbers." } };
  }
  if (minDaysOutstanding !== undefined && maxDaysOutstanding !== undefined && minDaysOutstanding > maxDaysOutstanding) {
    return { status: 400, body: { error: "minDays cannot exceed maxDays." } };
  }
  if (outstandingOnly && outstandingOnly !== "true") {
    return { status: 400, body: { error: "outstanding must be true when supplied." } };
  }
  if (!deps.claimReadModel || !deps.projectionHealth) {
    return { status: 503, body: { error: "Claim read model is unavailable; rebuild from FHIR before searching." } };
  }

  try {
    const at = now(deps);
    const projection = deps.projectionHealth.status(at);
    const unavailable = claimProjectionUnavailableBody(projection);
    if (unavailable) return { status: 503, body: unavailable };
    const filters: ClaimSearchFilters = {
      ...(patient ? /^Patient\/[A-Za-z0-9.-]+$/.test(patient)
        ? { patientReferences: new Set([patient]) }
        : { patient } : {}),
      ...(trimmedValue(input.query?.claim) ? { claim: trimmedValue(input.query?.claim) } : {}),
      ...(requestedStatus ? { status: requestedStatus } : {}),
      ...(trimmedValue(input.query?.carrier) ? { carrier: trimmedValue(input.query?.carrier) } : {}),
      ...(trimmedValue(input.query?.office) ? { office: trimmedValue(input.query?.office) } : {}),
      ...(trimmedValue(input.query?.cpt) ? { cpt: trimmedValue(input.query?.cpt) } : {}),
      ...(minAmountCents !== undefined ? { minAmountCents } : {}),
      ...(maxAmountCents !== undefined ? { maxAmountCents } : {}),
      ...(minDaysOutstanding !== undefined ? { minDaysOutstanding } : {}),
      ...(maxDaysOutstanding !== undefined ? { maxDaysOutstanding } : {}),
      ...(outstandingOnly === "true" ? { outstandingOnly: true } : {}),
    };
    return {
      status: 200,
      body: {
        items: await deps.claimReadModel.search({ filters, at }),
        projection,
      },
    };
  } catch (error) {
    const conflict = paginationConflict(error, "Claim");
    if (conflict) return conflict;
    throw error;
  }
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
  try {
    const headers = await searchAll<Basic>(auth.fhir, "Basic", {
      code: `${MANUAL_EOB_CODE_SYSTEM}|${MANUAL_EOB_CODE}`,
      _count: "100",
      _sort: "-_lastUpdated",
    });
    return {
      status: 200,
      body: {
        items: headers
          .filter((header) => parseRemittanceBatch(header).provenance === "manual")
          .map(parseManualEobHeader),
      },
    };
  } catch (error) {
    const conflict = paginationConflict(error, "Manual EOB");
    if (conflict) return conflict;
    throw error;
  }
}

export async function handleRemittanceBatchListRequest(
  deps: ClaimsHandlerDeps,
  input: { authHeader: string | undefined },
): Promise<ClaimsHandlerResult> {
  const auth = await authenticateClaimsManager(deps, input.authHeader);
  if ("status" in auth) return auth;
  try {
    const [batches, adjustmentResources] = await Promise.all([
      searchAll<Basic>(auth.fhir, "Basic", {
        code: `${REMITTANCE_BATCH_CODE_SYSTEM}|${REMITTANCE_BATCH_CODE}`,
        _count: "100",
      }),
      searchAll<Basic>(auth.fhir, "Basic", {
        code: `${REMITTANCE_BATCH_CODE_SYSTEM}|${PROVIDER_ADJUSTMENT_CODE}`,
        _count: "100",
      }),
    ]);
    const adjustmentsByBatch = new Map<string, Basic[]>();
    for (const resource of adjustmentResources) {
      const adjustment = parseProviderAdjustment(resource);
      const entries = adjustmentsByBatch.get(adjustment.batchReference) ?? [];
      entries.push(resource);
      adjustmentsByBatch.set(adjustment.batchReference, entries);
    }
    const items = batches
      .map((batch) => projectRemittanceBatch(
        batch,
        adjustmentsByBatch.get(`Basic/${batch.id}`) ?? [],
        now(deps),
      ))
      .sort((left, right) => right.ageDays - left.ageDays || left.paymentReference.localeCompare(right.paymentReference));
    return { status: 200, body: { items } };
  } catch (error) {
    const conflict = paginationConflict(error, "Remittance batch");
    if (conflict) return conflict;
    throw error;
  }
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
    adapterName?: "claimmd" | "stedi";
    identifier?: { system: string; value: string };
  },
): Promise<Task> {
  if (input.identifier) {
    const existing = await auth.fhir.search<Task>("Task", {
      identifier: `${input.identifier.system}|${input.identifier.value}`,
      _count: "1",
    });
    const found = (existing.entry ?? []).flatMap((entry) => entry.resource ? [entry.resource] : [])[0];
    if (found) return found;
  } else if (input.claimReference) {
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
  const task = await auth.fhir.create(
    buildClaimRejectedWorklistTask({ ...input, authoredOn: now(deps) }),
    input.identifier
      ? { "If-None-Exist": `identifier=${input.identifier.system}|${input.identifier.value}` }
      : undefined,
  );
  await audit(deps, auth, "claim.rejected.flagged", "success", ref(task), input.patientReference, undefined, input.adapterName ?? "claimmd");
  return task;
}

function stedi277TransactionIds(raw: unknown): string[] {
  if (typeof raw !== "object" || raw === null || !Array.isArray((raw as { items?: unknown }).items)) {
    throw new Error("Stedi 277CA polling response is malformed.");
  }
  return (raw as { items: unknown[] }).items.flatMap((item) => {
    if (typeof item !== "object" || item === null) return [];
    const row = item as { transactionId?: unknown; direction?: unknown; x12?: any };
    return row.direction === "INBOUND"
      && row.x12?.metadata?.transaction?.transactionSetIdentifier === "277"
      && typeof row.transactionId === "string"
      ? [row.transactionId]
      : [];
  });
}

function stedi277NextPageToken(raw: unknown): string | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  return stringValue((raw as { nextPageToken?: unknown }).nextPageToken);
}

async function localClaimsForPcn(
  auth: AuthenticatedClaimsStaff,
  patientControlNumber: string,
): Promise<Claim[]> {
  return searchAll<Claim>(auth.fhir, "Claim", {
    identifier: `${CLAIM_PCN_IDENTIFIER_SYSTEM}|${patientControlNumber}`,
    _count: "2",
  }, { maxRows: 100 });
}

function stedi277TaskIdentifier(transactionId: string, claimKey: string): { system: string; value: string } {
  return { system: STEDI_277CA_IDENTIFIER_SYSTEM, value: `${transactionId}:${claimKey}` };
}

function stedi277TaskMessage(claim: Stedi277Claim, correlationIssue?: string): string {
  const statusCodes = claim.statuses.map((status) =>
    [status.categoryCode, status.statusCode].filter(Boolean).join("/")).filter(Boolean).join(", ");
  const sender = [claim.sender.organizationName, claim.sender.entityType].filter(Boolean).join(" — ");
  const outcome = claim.outcome === "review"
    ? `status ${statusCodes || "missing"} requires review`
    : `${claim.outcome}${statusCodes ? ` (${statusCodes})` : ""}`;
  const reasons = claim.reasons.length ? claim.reasons.join("; ") : "No rejection reason message was supplied.";
  return [
    `Stedi 277CA from ${sender || "unknown sender"}: ${outcome}.`,
    reasons,
    correlationIssue,
  ].filter(Boolean).join(" ");
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
  flagged: number;
  claimResponseIds: string[];
  paymentReconciliationIds: string[];
  taskIds: string[];
  paidCents: number;
}

async function verifyClaimResponseChargeItemLinks(
  auth: AuthenticatedClaimsStaff,
  claimReference: string,
  response: ClaimResponse,
): Promise<{ response: ClaimResponse; reviewReason?: string }> {
  const referencesByItem = (response.item ?? []).map((item) => item.extension?.flatMap((extension) =>
    extension.url === ODOS_CLAIM_CHARGE_ITEM_EXTENSION_URL && extension.valueReference?.reference
      ? [extension.valueReference.reference]
      : [],
  ) ?? []);
  if (referencesByItem.some((references) => references.length !== 1)) {
    return {
      response: withoutClaimResponseChargeItemLinks(response),
      reviewReason: "One or more ERA service lines omitted a valid ChargeItem control number.",
    };
  }
  const echoedReferences = referencesByItem.flat();
  if (echoedReferences.length === 0) return { response };

  if (new Set(echoedReferences).size !== echoedReferences.length) {
    return {
      response: withoutClaimResponseChargeItemLinks(response),
      reviewReason: "ERA service lines echoed a duplicate ChargeItem control number.",
    };
  }

  const claimId = claimReference.match(/^Claim\/([A-Za-z0-9.-]{1,64})$/)?.[1];
  if (!claimId) {
    return {
      response: withoutClaimResponseChargeItemLinks(response),
      reviewReason: "ERA line linkage could not verify its local Claim reference.",
    };
  }

  try {
    const claim = await auth.fhir.read<Claim>("Claim", claimId);
    const claimChargeItems = new Set((claim.item ?? []).flatMap((item) => item.extension?.flatMap((extension) =>
      extension.url === ODOS_CLAIM_CHARGE_ITEM_EXTENSION_URL
      && /^ChargeItem\/[A-Za-z0-9.-]{1,64}$/.test(extension.valueReference?.reference ?? "")
        ? [extension.valueReference!.reference!]
        : [],
    ) ?? []));
    if (!echoedReferences.every((reference) => claimChargeItems.has(reference))) {
      return {
        response: withoutClaimResponseChargeItemLinks(response),
        reviewReason: "ERA line linkage echoed a ChargeItem that is not owned by the matched Claim.",
      };
    }

    const chargeItems = await Promise.all(echoedReferences.map(async (reference) => {
      const id = reference.slice("ChargeItem/".length);
      return auth.fhir.read<ChargeItem>("ChargeItem", id);
    }));
    if (
      response.patient.reference !== claim.patient.reference
      || chargeItems.some((chargeItem, index) =>
        `ChargeItem/${chargeItem.id ?? ""}` !== echoedReferences[index]
        || chargeItem.subject.reference !== claim.patient.reference,
      )
    ) {
      const withoutLinks = withoutClaimResponseChargeItemLinks(response);
      return {
        response: { ...withoutLinks, patient: { reference: claim.patient.reference } },
        reviewReason: "ERA line linkage could not verify ChargeItem existence and patient ownership.",
      };
    }
  } catch {
    return {
      response: withoutClaimResponseChargeItemLinks(response),
      reviewReason: "ERA line linkage could not load its matched Claim and ChargeItems.",
    };
  }

  return { response };
}

function withoutClaimResponseChargeItemLinks(response: ClaimResponse): ClaimResponse {
  return {
    ...response,
    item: response.item?.map((item) => {
      const extensions = item.extension?.filter(
        (extension) => extension.url !== ODOS_CLAIM_CHARGE_ITEM_EXTENSION_URL,
      ) ?? [];
      const { extension: _extension, ...withoutExtensions } = item;
      return extensions.length > 0 ? { ...withoutExtensions, extension: extensions } : withoutExtensions;
    }),
  };
}

async function createEraLineLinkageReviewTask(
  deps: ClaimsHandlerDeps,
  auth: AuthenticatedClaimsStaff,
  input: {
    adapterName: "claimmd" | "stedi";
    era: ClaimMdEraData;
    eraClaim: ClaimMdEraClaim;
    claimReference: string;
    claimResponseReference: string;
    patientReference: string;
    reason: string;
  },
): Promise<Task> {
  const identifierValue = `${input.era.eraid ?? "unknown-era"}:${input.claimReference}:line-linkage`;
  const candidate = buildEraWorklistTask({
    code: "era-line-linkage",
    era: input.era,
    eraClaim: input.eraClaim,
    claimResponseReference: input.claimResponseReference,
    patientReference: input.patientReference,
    authoredOn: now(deps),
    identifierSystem: input.adapterName === "stedi" ? STEDI_ERA_PAYMENT_SYSTEM : CLAIMMD_ERA_PAYMENT_SYSTEM,
  });
  candidate.identifier = [{ system: ERA_DISCREPANCY_IDENTIFIER_SYSTEM, value: identifierValue }];
  candidate.description = "ERA line linkage requires review";
  candidate.input = [
    ...(candidate.input ?? []),
    {
      type: {
        coding: [{ system: ERA_WORKLIST_INPUT_SYSTEM, code: "line-linkage-review-reason" }],
        text: "Line-linkage review reason",
      },
      valueString: input.reason,
    },
  ];
  const task = await auth.fhir.create(candidate, {
    "If-None-Exist": `identifier=${ERA_DISCREPANCY_IDENTIFIER_SYSTEM}|${identifierValue}`,
  });
  await audit(deps, auth, "era.line-linkage.flagged", "success", ref(task), undefined, undefined, input.adapterName);
  return task;
}

async function createStediEraIntegrityReviewTask(
  deps: ClaimsHandlerDeps,
  auth: AuthenticatedClaimsStaff,
  input: {
    era: ClaimMdEraData;
    eraClaim: ClaimMdEraClaim;
    claimReference: string;
    claimResponseReference: string;
    patientReference: string;
    reasons: string[];
    appealDeadline?: string;
  },
): Promise<Task> {
  const identifierValue = `${input.era.eraid ?? "unknown-era"}:${input.claimReference}:stedi-integrity`;
  const candidate = buildEraWorklistTask({
    code: "era-integrity",
    era: input.era,
    eraClaim: input.eraClaim,
    claimResponseReference: input.claimResponseReference,
    patientReference: input.patientReference,
    authoredOn: now(deps),
    appealDeadline: input.appealDeadline,
    identifierSystem: STEDI_ERA_PAYMENT_SYSTEM,
  });
  candidate.identifier = [{ system: ERA_DISCREPANCY_IDENTIFIER_SYSTEM, value: identifierValue }];
  candidate.description = "Stedi ERA integrity requires review";
  candidate.input = [
    ...(candidate.input ?? []),
    {
      type: {
        coding: [{ system: ERA_WORKLIST_INPUT_SYSTEM, code: "stedi-era-review-reason" }],
        text: "Stedi ERA review reason",
      },
      valueString: input.reasons.join(" "),
    },
  ];
  const task = await auth.fhir.create(candidate, {
    "If-None-Exist": `identifier=${ERA_DISCREPANCY_IDENTIFIER_SYSTEM}|${identifierValue}`,
  });
  await audit(deps, auth, "era.integrity.flagged", "success", ref(task), input.patientReference, undefined, "stedi");
  return task;
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
  const candidateResponse = buildClaimResponseFromClaimMdEra({
    claimReference: input.claimReference,
    patientReference: input.patientReference,
    insurerReference: input.insurerReference,
    providerReference: input.providerReference,
    created: today(deps),
    era: { ...input.era, claim: input.eraClaim },
  });
  const verifiedLinkage = await verifyClaimResponseChargeItemLinks(auth, input.claimReference, candidateResponse);
  const response = await auth.fhir.create(verifiedLinkage.response);
  const verifiedPatientReference = response.patient.reference ?? input.patientReference;
  const paidCents = Math.round((response.payment?.amount.value ?? 0) * 100);
  const evidence = eraWorklistEvidence(input.eraClaim, input.era.eraid ?? "");
  const invoiceResult = await ensurePatientResponsibilityInvoice(auth, input.claimReference, response);
  const paymentReconciliationIds: string[] = [];
  const taskIds: string[] = [];
  let posted = 0;
  let denied = 0;
  let underpaid = 0;
  let flagged = 0;

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
      lineAllocations: claimResponseLinePaymentAllocations(response),
    }));
    paymentReconciliationIds.push(requiredId(pr));
    posted = 1;
  }

  if (verifiedLinkage.reviewReason) {
    const task = await createEraLineLinkageReviewTask(deps, auth, {
      adapterName: "claimmd",
      era: input.era,
      eraClaim: input.eraClaim,
      claimReference: input.claimReference,
      claimResponseReference: ref(response),
      patientReference: verifiedPatientReference,
      reason: verifiedLinkage.reviewReason,
    });
    taskIds.push(requiredId(task));
    flagged = 1;
  }

  if (paidCents === 0) {
    const task = await createAndAuditEraWorklistTask(
      deps,
      auth,
      "era-denial",
      { ...input, patientReference: verifiedPatientReference },
      response,
    );
    taskIds.push(requiredId(task));
    denied = 1;
  } else if (
    invoiceResult === "different"
    || invoiceResult === "unavailable"
    || (evidence.shortfallCents > 0
      && evidence.shortfallCents >= (deps.eraUnderpaymentThresholdCents ?? 1))
  ) {
    const task = await createAndAuditEraWorklistTask(
      deps,
      auth,
      "era-underpayment",
      { ...input, patientReference: verifiedPatientReference },
      response,
    );
    taskIds.push(requiredId(task));
    underpaid = 1;
  }

  return {
    posted,
    denied,
    underpaid,
    flagged,
    claimResponseIds: [requiredId(response)],
    paymentReconciliationIds,
    taskIds,
    paidCents,
  };
}

type PatientResponsibilityInvoiceResult = "none" | "created" | "unchanged" | "different" | "unavailable";

async function ensurePatientResponsibilityInvoice(
  auth: AuthenticatedClaimsStaff,
  claimReference: string,
  response: ClaimResponse,
  authoritativePatientResponsibilityCents?: number,
): Promise<PatientResponsibilityInvoiceResult> {
  const invoiceResponse = authoritativePatientResponsibilityCents === undefined
    ? response
    : withAuthoritativePatientResponsibility(response, authoritativePatientResponsibilityCents);
  if (!(invoiceResponse.item ?? []).some((item) => item.adjudication.some((adjudication) =>
    /^adjustment\s+PR(?:\s|$)/i.test(adjudication.category.text ?? "")
    && (adjudication.amount?.value ?? 0) > 0,
  ))) return "none";
  const claimId = claimReference.match(/^Claim\/([A-Za-z0-9.-]+)$/)?.[1];
  if (!claimId) throw new Error("Patient-responsibility Invoice requires a local Claim/<id> reference.");
  const claim = await auth.fhir.read<Claim>("Claim", claimId);
  let candidate: Invoice | undefined;
  try {
    candidate = buildPatientResponsibilityInvoice(claim, invoiceResponse);
  } catch (error) {
    if (error instanceof PatientResponsibilityInvoiceUnavailableError) return "unavailable";
    throw error;
  }
  if (!candidate) return "none";
  const existingBundle = await auth.fhir.search<Invoice>("Invoice", {
    identifier: `${PATIENT_RESPONSIBILITY_INVOICE_IDENTIFIER_SYSTEM}|${claimReference}`,
    _count: "2",
  });
  const existingInvoices = bundleResources(existingBundle);
  if (existingInvoices.length > 1) {
    throw new Error(`${claimReference} has duplicate patient-responsibility Invoices.`);
  }
  const existing = existingInvoices[0];
  if (!existing) {
    const condition = `identifier=${PATIENT_RESPONSIBILITY_INVOICE_IDENTIFIER_SYSTEM}|${claimReference}`;
    const created = await auth.fhir.create(candidate, { "If-None-Exist": condition });
    return patientResponsibilityInvoiceMatches(created, candidate) ? "created" : "different";
  }
  return patientResponsibilityInvoiceMatches(existing, candidate) ? "unchanged" : "different";
}

function withAuthoritativePatientResponsibility(response: ClaimResponse, targetCents: number): ClaimResponse {
  if (targetCents < 0) throw new Error("Stedi patient responsibility cannot be negative.");
  const entries = (response.item ?? []).flatMap((item, itemIndex) => item.adjudication.flatMap((entry, entryIndex) =>
    /^adjustment\s+PR(?:\s|$)/i.test(entry.category.text ?? "") && (entry.amount?.value ?? 0) > 0
      ? [{ itemIndex, entryIndex, cents: Math.round((entry.amount?.value ?? 0) * 100) }]
      : [],
  ));
  const sourceTotal = entries.reduce((sum, entry) => sum + entry.cents, 0);
  let remainingTarget = targetCents;
  let remainingSource = sourceTotal;
  const allocations = entries.map((entry, index) => {
    const allocation = index === entries.length - 1
      ? remainingTarget
      : Math.min(remainingTarget, Math.round(remainingTarget * entry.cents / remainingSource));
    remainingTarget -= allocation;
    remainingSource -= entry.cents;
    return allocation;
  });
  const items = (response.item ?? []).map((item, itemIndex) => ({
    ...item,
    adjudication: item.adjudication.map((entry, entryIndex) => {
      const allocationIndex = entries.findIndex((candidate) =>
        candidate.itemIndex === itemIndex && candidate.entryIndex === entryIndex,
      );
      return allocationIndex === -1
        ? entry
        : { ...entry, amount: { value: allocations[allocationIndex] / 100, currency: "USD" as const } };
    }),
  }));
  if (sourceTotal === 0 && targetCents > 0 && items[0]) {
    items[0].adjudication = [
      ...items[0].adjudication,
      { category: { text: "adjustment PR claim-level" }, amount: { value: targetCents / 100, currency: "USD" as const } },
    ];
  }
  return { ...response, item: items };
}

async function persistClaimChargeItems(
  auth: AuthenticatedClaimsStaff,
  chargeItems: ProfessionalClaimChargeItemInput[],
  patientReference: string,
  submissionKey: string,
): Promise<ProfessionalClaimChargeItemInput[]> {
  const validated: Array<ProfessionalClaimChargeItemInput | {
    candidate: ChargeItem;
    identifierValue: string;
    diagnosisSequence?: number[];
  }> = [];
  for (const [index, chargeItem] of chargeItems.entries()) {
    if (chargeItem.id) {
      if (!/^[A-Za-z0-9.-]+$/.test(chargeItem.id)) {
        throw new ClaimSubmissionValidationError(`ChargeItem id ${chargeItem.id} is not a valid local FHIR id.`);
      }
      let stored: ChargeItem;
      try {
        stored = await auth.fhir.read<ChargeItem>("ChargeItem", chargeItem.id);
      } catch {
        throw new ClaimSubmissionValidationError(`ChargeItem/${chargeItem.id} could not be loaded for this Claim.`);
      }
      assertChargeItemPatient(stored, patientReference);
      validated.push({
        ...stored,
        ...(chargeItem.diagnosisSequence ? { diagnosisSequence: chargeItem.diagnosisSequence } : {}),
      });
      continue;
    }
    assertChargeItemPatient(chargeItem, patientReference);
    const identifierValue = `${submissionKey}:${index + 1}`;
    const { diagnosisSequence, ...fhirChargeItem } = chargeItem;
    validated.push({
      identifierValue,
      candidate: {
        ...fhirChargeItem,
        identifier: [
          ...(chargeItem.identifier ?? []).filter((identifier) => identifier.system !== CLAIM_CHARGE_ITEM_IDENTIFIER_SYSTEM),
          { system: CLAIM_CHARGE_ITEM_IDENTIFIER_SYSTEM, value: identifierValue },
        ],
      },
      ...(diagnosisSequence ? { diagnosisSequence } : {}),
    });
  }

  const persisted: ProfessionalClaimChargeItemInput[] = [];
  for (const item of validated) {
    if ("resourceType" in item) {
      persisted.push(item);
      continue;
    }
    const { candidate, identifierValue, diagnosisSequence } = item;
    const stored = await auth.fhir.create(candidate, {
      "If-None-Exist": `identifier=${CLAIM_CHARGE_ITEM_IDENTIFIER_SYSTEM}|${identifierValue}`,
    });
    assertChargeItemPatient(stored, patientReference);
    persisted.push({
      ...stored,
      ...(diagnosisSequence ? { diagnosisSequence } : {}),
    });
  }
  return persisted;
}

function assertChargeItemPatient(chargeItem: ChargeItem, patientReference: string): void {
  const reference = chargeItem.id ? `ChargeItem/${chargeItem.id}` : "Unpersisted ChargeItem";
  if (chargeItem.subject.reference !== patientReference) {
    throw new ClaimSubmissionValidationError(
      `${reference} belongs to ${chargeItem.subject.reference || "no patient"}, not ${patientReference}.`,
    );
  }
}

async function upsertEraImportRecord(
  auth: AuthenticatedClaimsStaff,
  eraId: string,
  summary: Parameters<typeof buildEraImportRecord>[1],
  identifierSystem = CLAIMMD_ERA_PAYMENT_SYSTEM,
): Promise<Basic> {
  const bundle = await auth.fhir.search<Basic>("Basic", {
    code: `${ERA_IMPORT_CODE_SYSTEM}|${ERA_IMPORT_CODE}`,
    identifier: `${identifierSystem}|${eraId}`,
    _count: "1",
  });
  const existing = bundle.entry?.find((entry) => entry.resource)?.resource;
  const resource = buildEraImportRecord(eraId, summary, existing, identifierSystem);
  return existing?.id
    ? auth.fhir.update<Basic>("Basic", existing.id, resource)
    : auth.fhir.create(resource);
}

async function createAndAuditEraWorklistTask(
  deps: ClaimsHandlerDeps,
  auth: AuthenticatedClaimsStaff,
  code: Exclude<EraWorklistCode, "era-line-linkage" | "era-unmatched">,
  input: {
    era: ClaimMdEraData;
    eraClaim: ClaimMdEraClaim;
    patientReference: string;
    appealDeadline?: string;
  },
  response: ClaimResponse,
  adapterName: "claimmd" | "stedi" = "claimmd",
): Promise<Task> {
  const claimReference = response.request?.reference;
  if (!claimReference || !/^Claim\/[A-Za-z0-9.-]+$/.test(claimReference)) {
    throw new Error("ERA discrepancy Task requires a local Claim/<id> reference.");
  }
  const identifierValue = `${input.era.eraid ?? "unknown-era"}:${claimReference}:${code}`;
  const identifierToken = `${ERA_DISCREPANCY_IDENTIFIER_SYSTEM}|${identifierValue}`;
  const existing = bundleResources(await auth.fhir.search<Task>("Task", {
    identifier: identifierToken,
    _count: "2",
  }));
  if (existing.length > 1) throw new Error(`Duplicate ERA discrepancy Tasks exist for ${claimReference}.`);
  if (existing[0]) return existing[0];
  const candidate = buildEraWorklistTask({
    code,
    era: input.era,
    eraClaim: input.eraClaim,
    claimResponseReference: ref(response),
    patientReference: input.patientReference,
    authoredOn: now(deps),
    appealDeadline: input.appealDeadline,
    identifierSystem: adapterName === "stedi" ? STEDI_ERA_PAYMENT_SYSTEM : CLAIMMD_ERA_PAYMENT_SYSTEM,
  });
  candidate.identifier = [{ system: ERA_DISCREPANCY_IDENTIFIER_SYSTEM, value: identifierValue }];
  const task = await auth.fhir.create(candidate, { "If-None-Exist": `identifier=${identifierToken}` });
  const eventType = code === "era-denial" ? "era.denial.flagged" : "era.underpayment.flagged";
  await audit(deps, auth, eventType, "success", ref(task), input.patientReference, undefined, adapterName);
  return task;
}

export function eraUnderpaymentThresholdCentsFromEnv(env: Record<string, string | undefined>): number {
  const value = env.ODOS_ERA_UNDERPAYMENT_THRESHOLD_CENTS;
  if (value === undefined || value === "") return 1;
  if (!/^\d+$/.test(value)) {
    throw new Error("ODOS_ERA_UNDERPAYMENT_THRESHOLD_CENTS must be a nonnegative whole number of cents.");
  }
  return Number(value);
}

async function auditTaskWrite(
  deps: ClaimsHandlerDeps,
  staff: AuthenticatedClaimsStaff,
  task: Task,
  actionReason: string,
): Promise<void> {
  await deps.recordAudit(buildOdosAuditEventRow({
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

function parseStediResubmissionRequest(body: {
  originalClaimReference?: unknown;
  intent?: unknown;
  payerClassification?: unknown;
}): {
  originalClaimReference: string;
  intent: StediClaimResubmissionIntent;
  payerClassification?: StediPayerClassification;
} | ClaimsHandlerResult {
  const originalClaimReference = trimmedValue(body.originalClaimReference);
  if (!originalClaimReference?.match(/^Claim\/[A-Za-z0-9.-]+$/)) {
    return { status: 400, body: { error: "originalClaimReference must be Claim/<id>." } };
  }
  if (body.intent !== "correct" && body.intent !== "void") {
    return { status: 400, body: { error: "intent must be correct or void." } };
  }
  if (
    body.payerClassification !== undefined
    && body.payerClassification !== "confirmed-non-medicare"
    && body.payerClassification !== "original-medicare"
  ) {
    return {
      status: 400,
      body: { error: "payerClassification must be confirmed-non-medicare or original-medicare." },
    };
  }
  return {
    originalClaimReference,
    intent: body.intent,
    ...(body.payerClassification ? { payerClassification: body.payerClassification } : {}),
  };
}

async function stediResubmissionContext(
  auth: AuthenticatedClaimsStaff,
  input: {
    originalClaimReference: string;
    intent: StediClaimResubmissionIntent;
    payerClassification?: StediPayerClassification;
  },
): Promise<{
  claim: Claim;
  snapshot?: ProfessionalClaimInput;
  determination: ReturnType<typeof determineStediClaimResubmission>;
}> {
  const claimId = input.originalClaimReference.slice("Claim/".length);
  const claim = await auth.fhir.read<Claim>("Claim", claimId);
  const responses = await searchAll<ClaimResponse>(auth.fhir, "ClaimResponse", {
    request: input.originalClaimReference,
    _count: "200",
    _sort: "-created",
  });
  const payerClaimControlNumber = responses.find((response) =>
    response.request?.reference === input.originalClaimReference && response.preAuthRef?.trim())?.preAuthRef?.trim();
  return {
    claim,
    snapshot: stediClaimInputSnapshot(claim),
    determination: determineStediClaimResubmission({
      intent: input.intent,
      payerClaimControlNumber,
      payerClassification: input.payerClassification,
    }),
  };
}

function claimReadFailure(claimReference: string, error: unknown): ClaimsHandlerResult {
  return claimMdHttpStatus(error) === "404"
    ? { status: 404, body: { error: `${claimReference} was not found.` } }
    : { status: 502, body: { error: `Claim resubmission preview failed: ${messageOf(error)}` } };
}

async function authenticateClaimsManager(
  deps: ClaimsHandlerDeps,
  authHeader: string | undefined,
): Promise<AuthenticatedClaimsStaff | ClaimsHandlerResult> {
  let staff: AuthenticatedClaimsStaff | null;
  try {
    staff = await deps.authenticate(authHeader);
  } catch (error) {
    if (error instanceof StaffRoleServiceUnavailableError) {
      return { status: 503, body: { error: "Claims service temporarily unavailable." } };
    }
    throw error;
  }
  if (!staff) return { status: 401, body: { error: "Authentication required to manage claims." } };
  if (!staffMayManageClaims(staff.actorRole)) {
    return { status: 403, body: { error: "claims.manage role required" } };
  }
  return staff;
}

function staffMayManageClaims(actorRole: OdosActorRole): boolean {
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
  adapterName: "claimmd" | "stedi" | "manual-eob" = "claimmd",
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

function remittanceAllocationId(transactionId: string, claimReference: string): string {
  return `era-${createHash("sha256").update(`${transactionId}|${claimReference}`).digest("hex").slice(0, 24)}`;
}

function findReversedAllocation(
  resources: readonly Basic[],
  claimReference: string,
  claimLineageDepths: ReadonlyMap<string, number>,
  reversalAmountCents: number,
): { batchReference: string; allocationId: string } | undefined {
  const batches = resources.flatMap((resource) => {
    try {
      return [{ resource, batch: parseRemittanceBatch(resource) }];
    } catch {
      return [];
    }
  });
  const reversed = new Set<string>();
  for (const { resource, batch } of batches) {
    const batchReference = `Basic/${resource.id}`;
    for (const allocation of batch.allocations) {
      if (allocation.reversalOfAllocationId) {
        reversed.add(`${allocation.reversalOfBatchReference ?? batchReference}#${allocation.reversalOfAllocationId}`);
      }
    }
  }
  const candidates = batches
    .flatMap(({ resource, batch }) => batch.allocations
      .filter((allocation) =>
        allocation.amountCents === -reversalAmountCents
        && allocation.amountCents > 0
        && claimLineageDepths.has(allocation.claimReference)
        && !reversed.has(`Basic/${resource.id}#${allocation.id}`),
      )
      .map((allocation) => ({
        batchReference: `Basic/${resource.id}`,
        allocationId: allocation.id,
        claimReference: allocation.claimReference,
        lineageDepth: claimLineageDepths.get(allocation.claimReference)!,
      })))
  const predecessorDepths = [...new Set(candidates
    .map((candidate) => candidate.lineageDepth)
    .filter((depth) => depth > 0))].sort((left, right) => left - right);
  for (const depth of predecessorDepths) {
    const atDepth = candidates.filter((candidate) => candidate.lineageDepth === depth);
    if (atDepth.length > 0) return atDepth.length === 1 ? atDepth[0] : undefined;
  }
  const currentVersionCandidates = candidates.filter((candidate) => candidate.claimReference === claimReference);
  return currentVersionCandidates.length === 1 ? currentVersionCandidates[0] : undefined;
}

async function loadClaimLineageDepths(
  auth: AuthenticatedClaimsStaff,
  claimReference: string,
  submittedClaim: Claim | undefined,
): Promise<Map<string, number>> {
  const depths = new Map<string, number>([[claimReference, 0]]);
  const queue = (submittedClaim?.related ?? []).flatMap((related) =>
    related.claim?.reference ? [{ reference: related.claim.reference, depth: 1 }] : []);
  for (let index = 0; index < queue.length; index += 1) {
    const { reference, depth } = queue[index];
    if (depths.has(reference)) continue;
    const claimId = reference.match(/^Claim\/([A-Za-z0-9.-]{1,64})$/)?.[1];
    if (!claimId) continue;
    depths.set(reference, depth);
    let claim: Claim;
    try {
      claim = await auth.fhir.read<Claim>("Claim", claimId);
    } catch {
      continue;
    }
    queue.push(...(claim.related ?? []).flatMap((related) =>
      related.claim?.reference
        ? [{ reference: related.claim.reference, depth: depth + 1 }]
        : []));
  }
  return depths;
}

async function persistRemittanceAllocation(
  auth: AuthenticatedClaimsStaff,
  initialBatch: Basic,
  allocation: Parameters<typeof appendRemittanceAllocation>[1],
): Promise<Basic> {
  let current = initialBatch;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (parseRemittanceBatch(current).allocations.some((existing) => existing.id === allocation.id)) {
      return current;
    }
    if (!current.id || !current.meta?.versionId) {
      throw new Error("Remittance batch is missing id/meta.versionId; refusing a non-atomic allocation update.");
    }
    try {
      return await auth.fhir.update<Basic>(
        "Basic",
        current.id,
        appendRemittanceAllocation(current, allocation),
        { "If-Match": `W/"${current.meta.versionId}"` },
      );
    } catch (error) {
      if (!isFhirVersionConflict(error) || attempt === 2) throw error;
      current = await auth.fhir.read<Basic>("Basic", current.id);
    }
  }
  throw new Error("Remittance allocation retry exhausted unexpectedly.");
}

function isFhirVersionConflict(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const status = "status" in error ? error.status : undefined;
  const message = "message" in error && typeof error.message === "string" ? error.message : "";
  return status === 409 || status === 412 || /FHIR (409|412)\b/.test(message);
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

function claimMdLikeStediEraClaim(claim: StediEraClaim): ClaimMdEraClaim {
  return {
    pcn: claim.claimPaymentInfo.patientControlNumber,
    payer_icn: claim.claimPaymentInfo.payerClaimControlNumber,
    total_charge: claim.claimPaymentInfo.totalClaimChargeAmount,
    total_paid: claim.claimPaymentInfo.claimPaymentAmount,
    status_code: claim.claimPaymentInfo.claimStatusCode,
    charge: (claim.serviceLines ?? []).map((line) => ({
      proc_code: line.servicePaymentInformation?.adjudicatedProcedureCode,
      charge: line.servicePaymentInformation?.lineItemChargeAmount,
      allowed: line.serviceSupplementalAmounts?.allowedActual,
      paid: line.servicePaymentInformation?.lineItemProviderPaymentAmount,
      adjustment: (line.serviceAdjustments ?? []).flatMap((adjustment) => {
        const fields = adjustment as Record<string, string | undefined>;
        return [1, 2, 3, 4, 5, 6].flatMap((slot) => fields[`adjustmentAmount${slot}`] === undefined
          ? []
          : [{
            group: adjustment.claimAdjustmentGroupCode,
            code: fields[`adjustmentReasonCode${slot}`],
            amount: fields[`adjustmentAmount${slot}`],
          }]);
      }),
    })),
  };
}

function isoStediDate(value: string): string | undefined {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  const match = value.match(/^(\d{4})(\d{2})(\d{2})$/);
  return match ? `${match[1]}-${match[2]}-${match[3]}` : undefined;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function claimMdFailureAuditReason(operation: string, error: unknown): string {
  const status = claimMdHttpStatus(error);
  return status ? `Claim.MD ${operation} failed with HTTP ${status}` : `Claim.MD ${operation} failed`;
}

function clearinghouseFailureAuditReason(id: ClearinghouseId, operation: string, error: unknown): string {
  if (id === "claimmd") return claimMdFailureAuditReason(operation, error);
  const status = claimMdHttpStatus(error);
  const base = status ? `Stedi ${operation} failed with HTTP ${status}` : `Stedi ${operation} failed`;
  if (!(error instanceof StediRequestError)) return base;
  const allCodes = (error.errors ?? []).flatMap((detail) =>
    typeof detail.code === "string" && detail.code.trim() ? [detail.code.trim()] : []);
  const codes = allCodes.slice(0, 3);
  const omittedCount = allCodes.length - codes.length;
  const codeDetail = codes.length
    ? `[${codes.join(", ")}${omittedCount ? `, +${omittedCount} more` : ""}]`
    : undefined;
  return [base, codeDetail, error.correlationId ? `[correlationId: ${error.correlationId}]` : undefined]
    .filter(Boolean)
    .join(" ");
}

function clearinghouseSelection(
  deps: ClaimsHandlerDeps,
  requested: unknown,
  operation: "transaction" | "era",
): { id: ClearinghouseId; adapter: ClaimMdAdapter | StediAdapter } | ClaimsHandlerResult {
  if (requested !== undefined && !isClearinghouseId(requested)) {
    return { status: 400, body: { error: "clearinghouse must be claimmd or stedi." } };
  }
  const adapters: ClearinghouseAdapters = {
    ...(deps.adapter ? { claimmd: deps.adapter } : {}),
    ...deps.adapters,
  };
  try {
    const adapter = selectClearinghouseAdapter(adapters, requested, operation, deps.routingDefaults);
    return { id: adapter.id, adapter: adapter as ClaimMdAdapter | StediAdapter };
  } catch (error) {
    return { status: 503, body: { error: messageOf(error) } };
  }
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

function wholeNumber(value: unknown): number | undefined | null {
  const text = trimmedValue(value);
  if (text === undefined) return undefined;
  return /^\d+$/.test(text) ? Number(text) : null;
}

function searchBundle<T extends Resource>(resources: T[]): Bundle<T> {
  return {
    resourceType: "Bundle",
    type: "searchset",
    entry: resources.map((resource) => ({ resource })),
  };
}

function paginationConflict(error: unknown, label: string): ClaimsHandlerResult | undefined {
  if (!(error instanceof FhirSearchLimitError)) return undefined;
  return {
    status: 409,
    body: { error: `${label} query exceeded ${error.maxRows} rows; no partial result was returned.` },
  };
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
