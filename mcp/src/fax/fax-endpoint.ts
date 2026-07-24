import { randomBytes, timingSafeEqual } from "node:crypto";
import type {
  Bundle,
  DocumentReference,
  Organization,
  Practitioner,
  PractitionerRole,
  ProjectMembership,
  Provenance,
  Resource,
  ServiceRequest,
} from "@medplum/fhirtypes";
import { z } from "zod";
import {
  resolveBusinessActionRole,
  type PracticeRoleId,
} from "../authz/roles.js";
import { hasPatientCompartmentGrant } from "../clinical-graph/provider-assignment-endpoint.js";
import { buildProvenance } from "../fhir/ophthalmology/provenance.js";
import {
  ReferralSendConflictError,
  ReferralService,
  readReferralIncludeList,
  type ReferralFhirClient,
} from "../referral/referral-service.js";
import {
  buildFaxSendRecord,
  FAX_ERROR_EXTENSION_URL,
  FAX_STATUS_EXTENSION_URL,
  faxCallbackTokenHash,
  faxStatus,
  hashCallbackToken,
  withFaxSendResult,
  westFaxResult,
} from "./fax-record.js";
import type { WestFaxAdapter } from "./westfax-adapter.js";

export interface FaxEndpointDeps {
  authenticate(authHeader: string | undefined): Promise<{
    staffReference: string;
    actorRole: PracticeRoleId;
    roles?: PracticeRoleId[];
  } | null>;
  serviceFhir: ReferralFhirClient;
  adapter: WestFaxAdapter | null;
  callbackBaseUrl?: string;
  now?: () => string;
}

export interface FaxEndpointResult {
  status: number;
  body: unknown;
}

const fhirIdSchema = z.string().regex(/^[A-Za-z0-9.-]{1,64}$/);
const callbackTokenSchema = z.string().regex(/^[a-f0-9]{64}$/);
const destinationSchema = z.string().trim().min(3).max(64);
const filenameSchema = z.string().trim().min(1).max(180).regex(/\.pdf$/i);
const MAX_FAX_PDF_BYTES = 25 * 1024 * 1024;

export async function handleReferralFaxRequest(
  deps: FaxEndpointDeps,
  input: {
    authHeader: string | undefined;
    patientId: unknown;
    referralId: unknown;
    destinationNumber: unknown;
    billingCode: unknown;
    filename: unknown;
    document: unknown;
  },
): Promise<FaxEndpointResult> {
  if (!deps.adapter || !deps.callbackBaseUrl) {
    return {
      status: 503,
      body: { error: "WestFax is not configured for this practice." },
    };
  }
  const context = await authorizeFaxPatient(deps, input);
  if ("result" in context) return context.result;

  const parsedDestination = destinationSchema.safeParse(input.destinationNumber);
  const parsedFilename = filenameSchema.safeParse(input.filename);
  const document = Buffer.isBuffer(input.document) ? input.document : undefined;
  if (!parsedDestination.success) {
    return { status: 400, body: { error: "A valid destination fax number is required." } };
  }
  if (!parsedFilename.success) {
    return { status: 400, body: { error: "A PDF filename is required." } };
  }
  if (input.billingCode !== context.referralId) {
    return { status: 400, body: { error: "Fax billing code must match the referral id." } };
  }
  if (!document?.length || document.length > MAX_FAX_PDF_BYTES || !isPdf(document)) {
    return {
      status: 400,
      body: { error: "A valid combined PDF no larger than 25 MB is required." },
    };
  }

  const allowedFaxNumbers = await referralTargetFaxNumbers(
    deps.serviceFhir,
    context.serviceRequest,
  );
  const destinationNumber = allowedFaxNumbers.find(
    (fax) => normalizedFax(fax) === normalizedFax(parsedDestination.data),
  );
  if (!destinationNumber) {
    return {
      status: 409,
      body: { error: "The destination fax number no longer matches the referral consultant." },
    };
  }

  const now = deps.now ?? (() => new Date().toISOString());
  const callbackToken = randomBytes(32).toString("hex");
  const record = await deps.serviceFhir.create<DocumentReference>(
    buildFaxSendRecord({
      serviceRequest: context.serviceRequest,
      senderReference: context.staff.staffReference,
      destinationNumber,
      filename: parsedFilename.data,
      size: document.length,
      recordedAt: now(),
      callbackToken,
    }),
    { "X-ODOS-Source": "mcp/fax-send" },
  );
  if (!record.id) throw new Error("Fax DocumentReference create response did not include an id.");

  const callbackUrl =
    `${deps.callbackBaseUrl.replace(/\/$/, "")}/fax/callback/${encodeURIComponent(record.id)}`
    + `?token=${encodeURIComponent(callbackToken)}`;
  let result;
  try {
    result = await deps.adapter.sendFax({
      destinationNumbers: [destinationNumber],
      files: [{ content: document, filename: parsedFilename.data }],
      billingCode: context.referralId,
      faxQuality: "Fine",
      callbackUrl,
    });
  } catch (caught) {
    const error = caught instanceof Error ? caught.message : "WestFax request failed.";
    const failed = await mutateFaxRecord(deps.serviceFhir, record.id, (current) =>
      withFaxSendResult(current, { status: "Failed", error, updatedAt: now() }));
    return { status: 502, body: { error, fax: faxSummary(failed) } };
  }
  if (!result.success || !result.jobId) {
    const error = result.errorString ?? result.infoString ?? "WestFax rejected the fax request.";
    const failed = await mutateFaxRecord(deps.serviceFhir, record.id, (current) =>
      withFaxSendResult(current, { status: "Failed", error, updatedAt: now() }));
    return {
      status: 502,
      body: {
        error,
        fax: faxSummary(failed),
      },
    };
  }

  const accepted = await mutateFaxRecord(deps.serviceFhir, record.id, (current) =>
    withFaxSendResult(current, {
      status: faxStatus(current),
      jobId: result.jobId,
      updatedAt: now(),
    }));

  let provenanceReference: string | undefined;
  let warning: string | undefined;
  try {
    const recordedAt = now();
    const serviceRequestReference = `ServiceRequest/${context.referralId}`;
    const provenance: Provenance = buildProvenance({
      targetReferences: [serviceRequestReference, `DocumentReference/${record.id}`],
      occurredDateTime: recordedAt,
      recorded: recordedAt,
      activityCode: "READ",
      activityDisplay: "Fax referral",
      agents: [{
        typeCode: "transmitter",
        typeDisplay: "Transmitter",
        whoReference: context.staff.staffReference,
      }],
      entityValues: disclosedIncludeListEntities(readReferralIncludeList(context.serviceRequest)),
    });
    const committed = await new ReferralService(deps.serviceFhir, now)
      .commitReferralSend(context.serviceRequest, provenance);
    provenanceReference = committed.provenanceReference;
  } catch (error) {
    warning = error instanceof ReferralSendConflictError
      ? "Fax accepted, but the referral changed before disclosure finalization. Do not resend; review the fax record."
      : "Fax accepted, but disclosure finalization needs review. Do not resend; review the fax record.";
  }

  return {
    status: 202,
    body: {
      fax: faxSummary(accepted),
      ...(provenanceReference ? { provenanceReference } : {}),
      ...(warning ? { warning } : {}),
    },
  };
}

export async function handleFaxCallbackRequest(
  deps: Pick<FaxEndpointDeps, "serviceFhir" | "now">,
  input: { recordId: unknown; callbackToken: unknown; body: unknown },
): Promise<FaxEndpointResult> {
  const parsedId = fhirIdSchema.safeParse(input.recordId);
  if (!parsedId.success) {
    return { status: 400, body: { error: "A valid fax record id is required." } };
  }
  const parsedToken = callbackTokenSchema.safeParse(input.callbackToken);
  if (!parsedToken.success) {
    return { status: 401, body: { error: "Fax callback authentication failed." } };
  }
  const body = isRecord(input.body) ? input.body : {};
  const existing = await deps.serviceFhir.read<DocumentReference>(
    "DocumentReference",
    parsedId.data,
  );
  const expectedTokenHash = faxCallbackTokenHash(existing);
  if (
    !existing.extension?.some((extension) => extension.url === FAX_STATUS_EXTENSION_URL)
    || !expectedTokenHash
    || !callbackTokenMatches(hashCallbackToken(parsedToken.data), expectedTokenHash)
  ) {
    return { status: 401, body: { error: "Fax callback authentication failed." } };
  }
  const rawStatus = body.Result ?? body.result ?? body.Status ?? body.status;
  const status = westFaxResult(rawStatus);
  const success = body.Success ?? body.success;
  const error = stringValue(body.ErrorString ?? body.errorString)
    ?? (success === false && status === "Unknown" ? "WestFax reported callback failure." : undefined);
  const now = deps.now ?? (() => new Date().toISOString());

  const updated = await mutateFaxRecord(deps.serviceFhir, parsedId.data, (current) =>
    withFaxSendResult(current, {
      status: error && status === "Unknown" ? "Failed" : status,
      error,
      updatedAt: now(),
    }));
  return { status: 200, body: { fax: faxSummary(updated) } };
}

export async function handleReferralFaxStatusRequest(
  deps: FaxEndpointDeps,
  input: {
    authHeader: string | undefined;
    patientId: unknown;
    referralId: unknown;
  },
): Promise<FaxEndpointResult> {
  const context = await authorizeFaxPatient(deps, input);
  if ("result" in context) return context.result;
  const bundle = await deps.serviceFhir.search<DocumentReference>("DocumentReference", {
    subject: context.patientReference,
    _sort: "-date",
    _count: "50",
  });
  const sourceReference = `ServiceRequest/${context.referralId}`;
  const records = resources(bundle)
    .filter((record) => record.context?.related?.some((related) => related.reference === sourceReference))
    .filter((record) => record.extension?.some(
      (extension) => extension.url === FAX_STATUS_EXTENSION_URL,
    ))
    .sort((left, right) => (right.date ?? "").localeCompare(left.date ?? ""));
  return {
    status: 200,
    body: { fax: records[0] ? faxSummary(records[0]) : null },
  };
}

async function authorizeFaxPatient(
  deps: FaxEndpointDeps,
  input: {
    authHeader: string | undefined;
    patientId: unknown;
    referralId: unknown;
  },
): Promise<
  | {
      staff: NonNullable<Awaited<ReturnType<FaxEndpointDeps["authenticate"]>>>;
      patientReference: string;
      referralId: string;
      serviceRequest: ServiceRequest;
    }
  | { result: FaxEndpointResult }
> {
  const staff = await deps.authenticate(input.authHeader);
  if (!staff) {
    return { result: { status: 401, body: { error: "Authentication required to send faxes." } } };
  }
  const roles = staff.roles ?? [staff.actorRole];
  if (!resolveBusinessActionRole(roles, "document.fax-send")) {
    return { result: { status: 403, body: { error: "document.fax-send role required" } } };
  }
  const parsedPatientId = fhirIdSchema.safeParse(input.patientId);
  const parsedReferralId = fhirIdSchema.safeParse(input.referralId);
  if (!parsedPatientId.success || !parsedReferralId.success) {
    return {
      result: { status: 400, body: { error: "Valid patient and referral ids are required." } },
    };
  }
  const patientReference = `Patient/${parsedPatientId.data}`;
  const memberships = await deps.serviceFhir.search<ProjectMembership>("ProjectMembership", {
    profile: staff.staffReference,
  });
  const membership = memberships.entry?.[0]?.resource;
  if (!membership || !hasPatientCompartmentGrant(membership, patientReference)) {
    return {
      result: {
        status: 403,
        body: { error: "The requested patient is outside the staff member's patient compartment." },
      },
    };
  }

  const serviceRequest = await deps.serviceFhir.read<ServiceRequest>(
    "ServiceRequest",
    parsedReferralId.data,
  );
  if (serviceRequest.subject.reference !== patientReference) {
    return {
      result: {
        status: 409,
        body: { error: "The referral does not belong to the requested patient." },
      },
    };
  }
  return {
    staff,
    patientReference,
    referralId: parsedReferralId.data,
    serviceRequest,
  };
}

async function referralTargetFaxNumbers(
  fhir: ReferralFhirClient,
  serviceRequest: ServiceRequest,
): Promise<string[]> {
  const reference = serviceRequest.performer?.[0]?.reference;
  if (!reference) throw new Error("Referral is missing its consultant reference.");
  const [resourceType, id, extra] = reference.split("/");
  if (extra || !id || !["Practitioner", "PractitionerRole", "Organization"].includes(resourceType ?? "")) {
    throw new Error("Referral consultant reference is invalid.");
  }
  const target = await fhir.read<Practitioner | PractitionerRole | Organization>(
    resourceType as "Practitioner" | "PractitionerRole" | "Organization",
    id,
  );
  return (target.telecom ?? [])
    .filter((contact) => contact.system === "fax" && contact.value?.trim())
    .map((contact) => contact.value!.trim());
}

async function mutateFaxRecord(
  fhir: ReferralFhirClient,
  id: string,
  mutate: (record: DocumentReference) => DocumentReference,
): Promise<DocumentReference> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const current = await fhir.read<DocumentReference>("DocumentReference", id);
    const versionId = current.meta?.versionId;
    try {
      return await fhir.update<DocumentReference>(
        "DocumentReference",
        id,
        mutate(current),
        {
          "X-ODOS-Source": "mcp/fax-status",
          ...(versionId ? { "If-Match": `W/"${versionId}"` } : {}),
        },
      );
    } catch (error) {
      const status = (error as Error & { status?: number }).status;
      if ((status === 409 || status === 412) && attempt < 2) continue;
      throw error;
    }
  }
  throw new Error("Fax record update retry limit reached.");
}

function faxSummary(record: DocumentReference): {
  reference: string;
  status: string;
  jobId?: string;
  error?: string;
  updatedAt?: string;
} {
  if (!record.id) throw new Error("Fax DocumentReference is missing its id.");
  const error = record.extension?.find(
    (extension) => extension.url === FAX_ERROR_EXTENSION_URL,
  )?.valueString;
  const jobId = record.identifier?.find(
    (identifier) => identifier.system === "https://odos2020.com/fhir/NamingSystem/westfax-job-id",
  )?.value;
  return {
    reference: `DocumentReference/${record.id}`,
    status: faxStatus(record),
    ...(jobId ? { jobId } : {}),
    ...(error ? { error } : {}),
    ...(record.date ? { updatedAt: record.date } : {}),
  };
}

function disclosedIncludeListEntities(includeList: ReturnType<typeof readReferralIncludeList>): Array<{
  role: "source";
  display: string;
}> {
  const entries = Object.entries(includeList)
    .filter(([name, value]) => name !== "history_count" && value === true)
    .map(([name]) => ({ role: "source" as const, display: `Referral include-list flag: ${name}` }));
  return entries.length
    ? entries
    : [{ role: "source", display: "Referral include-list: no optional content flags enabled" }];
}

function resources<T extends Resource>(bundle: Bundle<T>): T[] {
  return (bundle.entry ?? []).flatMap((entry) => entry.resource ? [entry.resource] : []);
}

function normalizedFax(value: string): string {
  return value.replace(/\D/g, "");
}

function callbackTokenMatches(token: string, expectedToken: string): boolean {
  const actual = Buffer.from(token);
  const expected = Buffer.from(expectedToken);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function isPdf(value: Buffer): boolean {
  return value.subarray(0, 5).toString("ascii") === "%PDF-";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
