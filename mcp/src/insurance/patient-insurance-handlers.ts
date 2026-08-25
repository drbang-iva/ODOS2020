import type {
  Bundle,
  Coverage,
  CoverageEligibilityRequest,
  CoverageEligibilityResponse,
  RelatedPerson,
  Resource,
} from "@medplum/fhirtypes";
import {
  buildOdosAuditEventRow,
  type OdosActorRole,
  type OdosAuditEventRecord,
  type OdosAuditEventType,
} from "../authz/odosAudit.js";
import { resolveBusinessActionRole, type PracticeRoleId } from "../authz/roles.js";
import type { MedplumClient } from "../fhir-client.js";
import { FhirSearchLimitError, searchAll } from "../fhir-search.js";
import { StaffRoleServiceUnavailableError } from "../payments/payment-endpoint.js";

export interface AuthenticatedInsuranceStaff {
  staffReference: string;
  actorRole: OdosActorRole;
  roles: readonly PracticeRoleId[];
  fhir: Pick<MedplumClient, "baseUrl" | "search" | "searchUrl" | "executeTransaction">;
}

export interface PatientInsuranceHandlerDeps {
  authenticate(authHeader: string | undefined): Promise<AuthenticatedInsuranceStaff | null>;
  recordAudit(row: OdosAuditEventRecord): Promise<void>;
}

export interface PatientInsuranceHandlerResult {
  status: number;
  body: unknown;
}

export async function handlePatientInsuranceRead(
  deps: PatientInsuranceHandlerDeps,
  input: { authHeader: string | undefined; patientReference?: string },
): Promise<PatientInsuranceHandlerResult> {
  const auth = await authenticateInsuranceStaff(deps, input.authHeader);
  if ("status" in auth) return auth;
  if (!isPatientReference(input.patientReference)) return invalidPatientReference();
  try {
    const [coverages, relatedPeople] = await Promise.all([
      searchAll<Coverage>(auth.fhir, "Coverage", { beneficiary: input.patientReference, _count: "100" }),
      searchAll<RelatedPerson>(auth.fhir, "RelatedPerson", { patient: input.patientReference, _count: "100" }),
    ]);
    return {
      status: 200,
      body: {
        coverages,
        relatedPeople,
      },
    };
  } catch (error) {
    if (error instanceof FhirSearchLimitError) return paginationConflict(error, "Patient insurance");
    return fhirFailure(error, "Unable to load patient insurance.");
  }
}

export async function handlePatientInsuranceWrite(
  deps: PatientInsuranceHandlerDeps,
  input: { authHeader: string | undefined; body: unknown },
): Promise<PatientInsuranceHandlerResult> {
  const auth = await authenticateInsuranceStaff(deps, input.authHeader);
  if ("status" in auth) return auth;
  const bundle = bodyBundle(input.body);
  if (!bundle) return { status: 400, body: { error: "A FHIR transaction bundle is required." } };
  const error = validateCoverageBundle(bundle);
  if (error) return { status: 400, body: { error } };
  const patientReference = coveragePatientReference(bundle);
  const fallbackTarget = bundleTargetReference(bundle, "Coverage");
  try {
    const response = await auth.fhir.executeTransaction(bundle);
    await auditWrite(deps, auth, "coverage.write", "success", patientReference, transactionTargetReference(response, bundle, "Coverage"));
    return { status: 200, body: response };
  } catch (cause) {
    await auditWrite(deps, auth, "coverage.write", "failure", patientReference, fallbackTarget, cause);
    return fhirFailure(cause, "Unable to save patient insurance.");
  }
}

export async function handleVisionBenefitsRead(
  deps: PatientInsuranceHandlerDeps,
  input: { authHeader: string | undefined; patientReference?: string },
): Promise<PatientInsuranceHandlerResult> {
  const auth = await authenticateInsuranceStaff(deps, input.authHeader);
  if ("status" in auth) return auth;
  if (!isPatientReference(input.patientReference)) return invalidPatientReference();
  try {
    const responses = await searchAll<CoverageEligibilityResponse>(auth.fhir, "CoverageEligibilityResponse", {
      patient: input.patientReference,
      _count: "100",
      _sort: "-created",
    });
    return { status: 200, body: { responses } };
  } catch (error) {
    if (error instanceof FhirSearchLimitError) return paginationConflict(error, "Vision benefits");
    return fhirFailure(error, "Unable to load vision-plan benefits.");
  }
}

export async function handleVisionBenefitsWrite(
  deps: PatientInsuranceHandlerDeps,
  input: { authHeader: string | undefined; body: unknown },
): Promise<PatientInsuranceHandlerResult> {
  const auth = await authenticateInsuranceStaff(deps, input.authHeader);
  if ("status" in auth) return auth;
  const bundle = bodyBundle(input.body);
  if (!bundle) return { status: 400, body: { error: "A FHIR transaction bundle is required." } };
  const error = validateBenefitsBundle(bundle);
  if (error) return { status: 400, body: { error } };
  const patientReference = benefitsPatientReference(bundle);
  const fallbackTarget = bundleTargetReference(bundle, "CoverageEligibilityResponse");
  try {
    const response = await auth.fhir.executeTransaction(bundle);
    await auditWrite(deps, auth, "benefits.manual-entry", "success", patientReference, transactionTargetReference(response, bundle, "CoverageEligibilityResponse"));
    return { status: 200, body: response };
  } catch (cause) {
    await auditWrite(deps, auth, "benefits.manual-entry", "failure", patientReference, fallbackTarget, cause);
    return fhirFailure(cause, "Unable to save vision-plan benefits.");
  }
}

async function auditWrite(
  deps: PatientInsuranceHandlerDeps,
  staff: AuthenticatedInsuranceStaff,
  eventType: Extract<OdosAuditEventType, "coverage.write" | "benefits.manual-entry">,
  outcome: "success" | "failure",
  patientReference: string,
  targetReference: string,
  error?: unknown,
): Promise<void> {
  await deps.recordAudit(buildOdosAuditEventRow({
    eventType,
    actorReference: staff.staffReference,
    actorRole: staff.actorRole,
    patientReference,
    targetReference,
    actionOutcome: outcome === "success" ? "granted" : "denied",
    actionReason: [eventType, outcome, error ? messageOf(error) : undefined].filter(Boolean).join(" "),
  }));
}

function coveragePatientReference(bundle: Bundle): string {
  return (bundle.entry?.find((entry) => entry.resource?.resourceType === "Coverage")?.resource as Coverage).beneficiary.reference!;
}

function benefitsPatientReference(bundle: Bundle): string {
  return (bundle.entry?.find((entry) => entry.resource?.resourceType === "CoverageEligibilityResponse")?.resource as CoverageEligibilityResponse).patient.reference!;
}

function bundleTargetReference(bundle: Bundle, resourceType: Resource["resourceType"]): string {
  const entry = bundle.entry?.find((candidate) => candidate.resource?.resourceType === resourceType);
  return entry?.resource?.id ? `${resourceType}/${entry.resource.id}` : `${resourceType}/uncreated`;
}

function transactionTargetReference(response: Bundle, request: Bundle, resourceType: Resource["resourceType"]): string {
  const index = request.entry?.findIndex((entry) => entry.resource?.resourceType === resourceType) ?? -1;
  const location = index >= 0 ? response.entry?.[index]?.response?.location : undefined;
  const match = location?.match(new RegExp(`^${resourceType}/[^/]+`));
  return match?.[0] ?? bundleTargetReference(request, resourceType);
}

function validateCoverageBundle(bundle: Bundle): string | undefined {
  if (bundle.type !== "transaction") return "Patient insurance writes require a transaction bundle.";
  const entries = bundle.entry ?? [];
  const coverages = entries.filter((entry) => entry.resource?.resourceType === "Coverage");
  const relatedPeople = entries.filter((entry) => entry.resource?.resourceType === "RelatedPerson");
  if (coverages.length !== 1) return "Patient insurance writes require exactly one Coverage.";
  if (relatedPeople.length > 1) return "Patient insurance writes allow at most one RelatedPerson.";
  if (entries.some((entry) => entry.resource?.resourceType !== "Coverage" && entry.resource?.resourceType !== "RelatedPerson")) {
    return "Patient insurance writes may contain only Coverage and RelatedPerson resources.";
  }
  if (entries.some((entry) => entry.request?.method !== "POST" && entry.request?.method !== "PUT")) {
    return "Patient insurance transaction entries must use POST or PUT.";
  }
  const coverage = coverages[0].resource as Coverage;
  if (!isPatientReference(coverage.beneficiary.reference)) return "Coverage.beneficiary must reference a Patient.";
  const subscriber = coverage.subscriber?.reference;
  if (subscriber?.startsWith("urn:uuid:") && !relatedPeople.some((entry) => entry.fullUrl === subscriber)) {
    return "Coverage.subscriber cannot point at a missing transaction RelatedPerson.";
  }
  const relatedPerson = relatedPeople[0]?.resource as RelatedPerson | undefined;
  if (relatedPerson && relatedPerson.patient.reference !== coverage.beneficiary.reference) {
    return "RelatedPerson.patient must match Coverage.beneficiary.";
  }
  return undefined;
}

function validateBenefitsBundle(bundle: Bundle): string | undefined {
  if (bundle.type !== "transaction") return "Vision-benefit writes require a transaction bundle.";
  const entries = bundle.entry ?? [];
  const requests = entries.filter((entry) => entry.resource?.resourceType === "CoverageEligibilityRequest");
  const responses = entries.filter((entry) => entry.resource?.resourceType === "CoverageEligibilityResponse");
  if (entries.length !== 2 || requests.length !== 1 || responses.length !== 1) {
    return "Vision-benefit writes require one CoverageEligibilityRequest and one CoverageEligibilityResponse.";
  }
  if (entries.some((entry) => entry.request?.method !== "POST")) return "Manual benefit history entries must be newly created.";
  const request = requests[0].resource as CoverageEligibilityRequest;
  const response = responses[0].resource as CoverageEligibilityResponse;
  if (!isPatientReference(request.patient.reference) || request.patient.reference !== response.patient.reference) {
    return "Eligibility request and response must reference the same Patient.";
  }
  if (response.request.reference !== requests[0].fullUrl) {
    return "CoverageEligibilityResponse.request must reference its transaction request entry.";
  }
  const requestedCoverage = request.insurance?.[0]?.coverage.reference;
  const responseCoverage = response.insurance?.[0]?.coverage.reference;
  if (!requestedCoverage || requestedCoverage !== responseCoverage) {
    return "Eligibility request and response must reference the same Coverage.";
  }
  return undefined;
}

async function authenticateInsuranceStaff(
  deps: PatientInsuranceHandlerDeps,
  authHeader: string | undefined,
): Promise<AuthenticatedInsuranceStaff | PatientInsuranceHandlerResult> {
  let staff: AuthenticatedInsuranceStaff | null;
  try {
    staff = await deps.authenticate(authHeader);
  } catch (error) {
    if (error instanceof StaffRoleServiceUnavailableError) {
      return { status: 503, body: { error: "Patient insurance service temporarily unavailable." } };
    }
    throw error;
  }
  if (!staff) return { status: 401, body: { error: "Authentication required to manage patient insurance." } };
  const actorRole = resolveBusinessActionRole(staff.roles, "claims.manage");
  if (!actorRole) {
    return { status: 403, body: { error: "claims.manage role required" } };
  }
  return { ...staff, actorRole };
}

function bodyBundle(body: unknown): Bundle | undefined {
  if (typeof body !== "object" || body === null || !("bundle" in body)) return undefined;
  const bundle = (body as { bundle?: unknown }).bundle;
  if (typeof bundle !== "object" || bundle === null || (bundle as { resourceType?: unknown }).resourceType !== "Bundle") return undefined;
  return bundle as Bundle;
}

function isPatientReference(value: string | undefined): value is string {
  return Boolean(value && /^Patient\/[^/]+$/.test(value));
}

function invalidPatientReference(): PatientInsuranceHandlerResult {
  return { status: 400, body: { error: "patientReference must be a Patient/{id} reference." } };
}

function paginationConflict(error: FhirSearchLimitError, label: string): PatientInsuranceHandlerResult {
  return {
    status: 409,
    body: { error: `${label} query exceeded ${error.maxRows} rows; no partial result was returned.` },
  };
}

function fhirFailure(error: unknown, fallback: string): PatientInsuranceHandlerResult {
  const status = errorStatus(error);
  if (status === 409) return { status: 409, body: { error: "This record changed while you were editing it. Reload and try again." } };
  return { status: status && status >= 400 && status < 500 ? status : 502, body: { error: messageOf(error) || fallback } };
}

function errorStatus(error: unknown): number | undefined {
  if (typeof error === "object" && error !== null && "status" in error && typeof (error as { status?: unknown }).status === "number") {
    return (error as { status: number }).status;
  }
  const match = messageOf(error).match(/FHIR\s+(\d{3})/);
  return match ? Number(match[1]) : undefined;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
