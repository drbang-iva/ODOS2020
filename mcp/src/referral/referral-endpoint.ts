import type { ProjectMembership, Provenance, ServiceRequest } from "@medplum/fhirtypes";
import { z } from "zod";
import {
  assertBusinessActionAllowed,
  type PracticeRoleId,
} from "../authz/roles.js";
import type { MedplumClient } from "../fhir-client.js";
import { buildProvenance } from "../fhir/ophthalmology/provenance.js";
import { hasPatientCompartmentGrant } from "../clinical-graph/provider-assignment-endpoint.js";
import { ReferralDefaultsStore } from "./referral-defaults-store.js";
import {
  readReferralIncludeList,
  ReferralService,
  type ReferralFhirClient,
  type ReferralIncludeList,
} from "./referral-service.js";

export const REFERRAL_WRITE_HEADERS = { "X-ODOS-Source": "mcp/referral-send" } as const;

export interface ReferralEndpointDeps {
  authenticate(authHeader: string | undefined): Promise<{
    staffReference: string;
    actorRole: PracticeRoleId;
    fhir: ReferralFhirClient;
  } | null>;
  serviceFhir: Pick<MedplumClient, "search" | "create" | "update">;
  now?: () => string;
}

export interface ReferralEndpointResult {
  status: number;
  body: unknown;
}

const fhirIdSchema = z.string().regex(/^[A-Za-z0-9.-]{1,64}$/);
const includeListSchema = z.object({
  letter: z.boolean(),
  demographics: z.boolean(),
  history: z.boolean(),
  clinical_summary: z.boolean(),
  images: z.boolean(),
  hipaa_cover_sheet: z.boolean(),
  history_count: z.number().int().min(1).max(50),
}).strict();
const createReferralSchema = z.object({
  targetReference: z.string().regex(/^(Practitioner|PractitionerRole|Organization)\/[A-Za-z0-9.-]{1,64}$/),
  encounterReference: z.string().regex(/^Encounter\/[A-Za-z0-9.-]{1,64}$/),
  includeList: includeListSchema,
  priority: z.enum(["routine", "urgent", "stat"]).optional(),
  reasonText: z.string().trim().min(1).optional(),
}).strict();
const saveDefaultsSchema = z.object({ includeList: includeListSchema }).strict();
const artifactSchema = z.object({
  editedLetterBody: z.string().optional(),
}).strict();

export async function handleCreateReferralRequest(
  deps: ReferralEndpointDeps,
  input: { authHeader: string | undefined; patientId: unknown; body: unknown },
): Promise<ReferralEndpointResult> {
  const context = await authorizeReferralPatient(deps, input.authHeader, input.patientId);
  if ("result" in context) return context.result;

  const parsed = createReferralSchema.safeParse(input.body);
  if (!parsed.success) {
    return {
      status: 400,
      body: { error: parsed.error.issues[0]?.message ?? "Invalid referral request." },
    };
  }

  const serviceRequest = await new ReferralService(context.staff.fhir, deps.now).createReferral({
    subjectReference: context.patientReference,
    requesterReference: context.staff.staffReference,
    targetReference: parsed.data.targetReference,
    encounterReference: parsed.data.encounterReference,
    includeList: parsed.data.includeList,
    priority: parsed.data.priority,
    reasonText: parsed.data.reasonText,
  });
  const serviceRequestReference = referralReference(serviceRequest);

  return {
    status: 201,
    body: { serviceRequest, serviceRequestReference },
  };
}

export async function handleReferralArtifactRequest(
  deps: ReferralEndpointDeps,
  input: {
    authHeader: string | undefined;
    patientId: unknown;
    referralId: unknown;
    action: "preview" | "send";
    body: unknown;
  },
): Promise<ReferralEndpointResult> {
  const context = await authorizeReferralPatient(deps, input.authHeader, input.patientId);
  if ("result" in context) return context.result;

  const parsedReferralId = fhirIdSchema.safeParse(input.referralId);
  if (!parsedReferralId.success) {
    return { status: 400, body: { error: "A valid referral ServiceRequest id is required." } };
  }
  const parsedBody = artifactSchema.safeParse(input.body);
  if (!parsedBody.success) {
    return {
      status: 400,
      body: { error: parsedBody.error.issues[0]?.message ?? "Invalid referral artifact request." },
    };
  }

  const referralId = parsedReferralId.data;
  const serviceRequest = await context.staff.fhir.read<ServiceRequest>("ServiceRequest", referralId);
  if (serviceRequest.subject.reference !== context.patientReference) {
    return { status: 409, body: { error: "The referral does not belong to the requested patient." } };
  }

  const service = new ReferralService(context.staff.fhir, deps.now);
  const serviceRequestReference = `ServiceRequest/${referralId}`;
  if (input.action === "preview") {
    const artifact = await service.assembleReferralArtifact(referralId, parsedBody.data);
    return {
      status: 200,
      body: { serviceRequestReference, artifact },
    };
  }

  const sentServiceRequest = await service.markReferralSent(
    serviceRequest,
    parsedBody.data.editedLetterBody,
  );
  const artifact = await service.assembleReferralArtifact(referralId);
  const recordedAt = deps.now?.() ?? new Date().toISOString();
  const provenance = await context.staff.fhir.create<Provenance>(buildProvenance({
    targetReferences: [serviceRequestReference],
    occurredDateTime: recordedAt,
    recorded: recordedAt,
    activityCode: "READ",
    activityDisplay: "Disclose referral",
    agents: [{
      typeCode: "transmitter",
      typeDisplay: "Transmitter",
      whoReference: context.staff.staffReference,
    }],
    entityValues: disclosedIncludeListEntities(readReferralIncludeList(sentServiceRequest)),
  }), REFERRAL_WRITE_HEADERS);

  return {
    status: 200,
    body: {
      serviceRequestReference,
      artifact,
      ...(provenance.id ? { provenanceReference: `Provenance/${provenance.id}` } : {}),
    },
  };
}

export async function handleReadReferralDefaultsRequest(
  deps: ReferralEndpointDeps,
  input: { authHeader: string | undefined },
): Promise<ReferralEndpointResult> {
  const context = await authorizeReferralStaff(deps, input.authHeader);
  if ("result" in context) return context.result;
  const includeList = await new ReferralDefaultsStore(deps.serviceFhir).read(
    context.staff.staffReference,
  );
  return { status: 200, body: { includeList } };
}

export async function handleSaveReferralDefaultsRequest(
  deps: ReferralEndpointDeps,
  input: { authHeader: string | undefined; body: unknown },
): Promise<ReferralEndpointResult> {
  const context = await authorizeReferralStaff(deps, input.authHeader);
  if ("result" in context) return context.result;
  const parsed = saveDefaultsSchema.safeParse(input.body);
  if (!parsed.success) {
    return {
      status: 400,
      body: { error: parsed.error.issues[0]?.message ?? "Invalid referral defaults." },
    };
  }
  const includeList = await new ReferralDefaultsStore(deps.serviceFhir).save(
    context.staff.staffReference,
    parsed.data.includeList,
  );
  return { status: 200, body: { includeList } };
}

async function authorizeReferralPatient(
  deps: ReferralEndpointDeps,
  authHeader: string | undefined,
  patientId: unknown,
): Promise<
  | {
      staff: NonNullable<Awaited<ReturnType<ReferralEndpointDeps["authenticate"]>>>;
      patientReference: string;
    }
  | { result: ReferralEndpointResult }
> {
  const context = await authorizeReferralStaff(deps, authHeader);
  if ("result" in context) return context;
  const { staff } = context;

  const parsedPatientId = fhirIdSchema.safeParse(patientId);
  if (!parsedPatientId.success) {
    return { result: { status: 400, body: { error: "A valid Patient id is required." } } };
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
        body: { error: "The requested patient is outside the clinician's patient compartment." },
      },
    };
  }

  return { staff, patientReference };
}

async function authorizeReferralStaff(
  deps: ReferralEndpointDeps,
  authHeader: string | undefined,
): Promise<
  | { staff: NonNullable<Awaited<ReturnType<ReferralEndpointDeps["authenticate"]>>> }
  | { result: ReferralEndpointResult }
> {
  const staff = await deps.authenticate(authHeader);
  if (!staff) {
    return { result: { status: 401, body: { error: "Authentication required to manage referrals." } } };
  }
  if (!staffMayWriteChart(staff.actorRole)) {
    return { result: { status: 403, body: { error: "chart.write role required" } } };
  }
  return { staff };
}

function staffMayWriteChart(role: PracticeRoleId): boolean {
  try {
    assertBusinessActionAllowed(role, "chart.write");
    return true;
  } catch {
    return false;
  }
}

function referralReference(serviceRequest: ServiceRequest): string {
  if (!serviceRequest.id) throw new Error("Referral create response did not include an id.");
  return `ServiceRequest/${serviceRequest.id}`;
}

function disclosedIncludeListEntities(includeList: ReferralIncludeList): Array<{
  role: "source";
  display: string;
}> {
  const entities = [
    ["letter", includeList.letter],
    ["demographics", includeList.demographics],
    ["history", includeList.history],
    ["clinical_summary", includeList.clinical_summary],
    ["images", includeList.images],
    ["hipaa_cover_sheet", includeList.hipaa_cover_sheet],
  ]
    .filter((entry): entry is [string, true] => entry[1] === true)
    .map(([flag]) => ({ role: "source" as const, display: `Referral include-list flag: ${flag}` }));
  if (includeList.history) {
    entities.push({
      role: "source",
      display: `Referral history_count: ${includeList.history_count}`,
    });
  }
  return entities.length
    ? entities
    : [{ role: "source", display: "Referral include-list: no optional content flags enabled" }];
}
