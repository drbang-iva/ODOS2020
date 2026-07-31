import type {
  AuditEvent,
  Patient,
  ProjectMembership,
  Provenance,
  ServiceRequest,
} from "@medplum/fhirtypes";
import { z } from "zod";
import type { PracticeRoleId } from "../authz/roles.js";
import {
  buildOdosAuditEventRow,
  type OdosAuditEventRecord,
} from "../authz/odosAudit.js";
import {
  CorrespondenceService,
  type CorrespondenceConfigFhirClient,
} from "../correspondence/correspondence-service.js";
import {
  assertCorrespondenceActionAllowed,
  buildCorrespondenceAuditEvent,
  CorrespondencePolicyStore,
} from "../correspondence/correspondence-workflow.js";
import { ProviderSignatureImageStore } from "../correspondence/signature-image-store.js";
import type { CorrespondenceRenderer } from "../correspondence/weasyprint-renderer.js";
import { buildProvenance } from "../fhir/ophthalmology/provenance.js";
import { searchAll } from "../fhir-search.js";
import { hasPatientCompartmentGrant } from "../clinical-graph/provider-assignment-endpoint.js";
import { ReferralDefaultsStore } from "./referral-defaults-store.js";
import { ReferralDirectory } from "./referral-directory.js";
import {
  InboundReferralService,
  type InboundReferralCaptureSource,
} from "./reciprocal-referral.js";
import {
  readReferralIncludeList,
  ReferralSendConflictError,
  ReferralService,
  readCorrespondenceSender,
  REFERRAL_DIRECTION_CODE_SYSTEM,
  referralDirectionOf,
  type ReferralFhirClient,
  type ReferralIncludeList,
} from "./referral-service.js";

export interface ReferralEndpointDeps {
  authenticate(authHeader: string | undefined): Promise<{
    staffReference: string;
    actorRole: PracticeRoleId;
    roles?: readonly PracticeRoleId[];
    fhir: ReferralFhirClient;
  } | null>;
  serviceFhir: CorrespondenceConfigFhirClient;
  correspondenceRenderer: CorrespondenceRenderer;
  recordAudit(row: OdosAuditEventRecord): Promise<void>;
  now?: () => string;
}

export interface ReferralEndpointResult {
  status: number;
  body: unknown;
}

const fhirIdSchema = z.string().regex(/^[A-Za-z0-9.-]{1,64}$/);
const targetReferenceSchema = z.string().regex(/^(Practitioner|PractitionerRole|Organization)\/[A-Za-z0-9.-]{1,64}$/);
const providerReferenceSchema = z.string().regex(/^(Practitioner|PractitionerRole)\/[A-Za-z0-9.-]{1,64}$/);
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
  targetReference: targetReferenceSchema,
  encounterReference: z.string().regex(/^Encounter\/[A-Za-z0-9.-]{1,64}$/),
  includeList: includeListSchema,
  priority: z.enum(["routine", "urgent", "stat"]).optional(),
  reasonText: z.string().trim().min(1).optional(),
}).strict();
const updateReferralSchema = z.object({
  targetReference: targetReferenceSchema.optional(),
  includeList: includeListSchema.optional(),
  priority: z.enum(["routine", "urgent", "stat"]).optional(),
  reasonText: z.string().trim().nullable().optional(),
  letterBody: z.string().min(1).optional(),
}).strict().refine((value) => Object.values(value).some((field) => field !== undefined), {
  message: "At least one referral field is required.",
});
const saveDefaultsSchema = z.object({ includeList: includeListSchema }).strict();
const artifactSchema = z.object({
  editedLetterBody: z.string().optional(),
  templateId: fhirIdSchema.optional(),
}).strict();
const applyTemplateSchema = z.object({ templateId: fhirIdSchema }).strict();
const inboundReferralSchema = z.object({
  referrerReference: targetReferenceSchema.optional(),
  referrerDisplay: z.string().trim().min(1).max(200),
  performerReference: providerReferenceSchema,
  captureSource: z.enum(["front-desk", "fax", "chart"]),
  reasonText: z.string().trim().min(1).max(2_000),
}).strict();
const signatureUploadSchema = z.object({
  contentType: z.enum(["image/png", "image/jpeg"]),
  dataBase64: z.string().min(1),
}).strict();
const consultArtifactSchema = z.object({
  editedBodyHtml: z.string().optional(),
  templateId: fhirIdSchema.optional(),
  encounterReference: z.string().regex(/^Encounter\/[A-Za-z0-9.-]{1,64}$/).optional(),
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

export async function handleCreateInboundReferralRequest(
  deps: ReferralEndpointDeps,
  input: { authHeader: string | undefined; patientId: unknown; body: unknown },
): Promise<ReferralEndpointResult> {
  const context = await authorizeReferralPatient(deps, input.authHeader, input.patientId);
  if ("result" in context) return context.result;
  const parsed = inboundReferralSchema.safeParse(input.body);
  if (!parsed.success) {
    return {
      status: 400,
      body: { error: parsed.error.issues[0]?.message ?? "Invalid inbound referral." },
    };
  }
  const [patient, performer] = await Promise.all([
    context.staff.fhir.read<Patient>(
      "Patient",
      context.patientReference.slice("Patient/".length),
    ),
    readCorrespondenceSender(
      context.staff.fhir,
      parsed.data.performerReference,
    ),
  ]);
  const serviceRequest = await new InboundReferralService(
    context.staff.fhir,
    deps.now,
  ).create({
    subjectReference: context.patientReference,
    subjectDisplay: patientDisplay(patient),
    referrerReference: parsed.data.referrerReference,
    referrerDisplay: parsed.data.referrerDisplay,
    performerReference: parsed.data.performerReference,
    performerDisplay: performer.name,
    captureSource: parsed.data.captureSource as InboundReferralCaptureSource,
    reasonText: parsed.data.reasonText,
  });
  return {
    status: 201,
    body: {
      serviceRequest,
      serviceRequestReference: referralReference(serviceRequest),
    },
  };
}

export async function handleListInboundReferralsRequest(
  deps: ReferralEndpointDeps,
  input: { authHeader: string | undefined; patientId: unknown },
): Promise<ReferralEndpointResult> {
  const context = await authorizeReferralPatient(deps, input.authHeader, input.patientId);
  if ("result" in context) return context.result;
  const serviceRequests = await searchAll<ServiceRequest>(
    context.staff.fhir,
    "ServiceRequest",
    {
      subject: context.patientReference,
      category: `${REFERRAL_DIRECTION_CODE_SYSTEM}|inbound`,
      _sort: "-authored",
      _count: "200",
    },
  );
  return {
    status: 200,
    body: {
      serviceRequests: serviceRequests.filter(
        (serviceRequest) => referralDirectionOf(serviceRequest) === "inbound",
      ),
    },
  };
}

export async function handleProviderSignatureRequest(
  deps: ReferralEndpointDeps,
  input: {
    authHeader: string | undefined;
    providerId: unknown;
    action: "read" | "set" | "clear";
    body?: unknown;
  },
): Promise<ReferralEndpointResult> {
  const authorized = await authorizeReferralStaff(deps, input.authHeader);
  if ("result" in authorized) return authorized.result;
  const parsedProviderId = fhirIdSchema.safeParse(input.providerId);
  if (!parsedProviderId.success) {
    return { status: 400, body: { error: "A valid provider id is required." } };
  }
  const providerReference = `Practitioner/${parsedProviderId.data}`;
  const roles = authorized.staff.roles ?? [authorized.staff.actorRole];
  if (
    input.action !== "read"
    && authorized.staff.staffReference !== providerReference
    && !roles.includes("practice-admin")
  ) {
    return {
      status: 403,
      body: { error: "Only the provider or a practice administrator may change this signature." },
    };
  }
  const store = new ProviderSignatureImageStore(deps.serviceFhir);
  if (input.action === "read") {
    return { status: 200, body: { signature: await store.read(providerReference) ?? null } };
  }
  if (input.action === "clear") {
    await store.clear(providerReference);
    return { status: 200, body: { signature: null } };
  }
  const parsed = signatureUploadSchema.safeParse(input.body);
  if (!parsed.success) {
    return {
      status: 400,
      body: { error: parsed.error.issues[0]?.message ?? "Invalid provider signature image." },
    };
  }
  const bytes = strictBase64(parsed.data.dataBase64);
  if (!bytes) {
    return { status: 400, body: { error: "Provider signature image must be valid base64." } };
  }
  const signature = await store.set(providerReference, {
    contentType: parsed.data.contentType,
    bytes,
  });
  return { status: 200, body: { signature } };
}

export async function handleConsultArtifactRequest(
  deps: ReferralEndpointDeps,
  input: {
    authHeader: string | undefined;
    patientId: unknown;
    referralId: unknown;
    action: "preview" | "sign" | "send";
    body: unknown;
  },
): Promise<ReferralEndpointResult> {
  const context = await authorizeReferralPatient(deps, input.authHeader, input.patientId);
  if ("result" in context) return context.result;
  const parsedReferralId = fhirIdSchema.safeParse(input.referralId);
  const parsed = consultArtifactSchema.safeParse(input.body);
  if (!parsedReferralId.success || !parsed.success) {
    return { status: 400, body: { error: "Invalid consult-report request." } };
  }
  const serviceRequest = await context.staff.fhir.read<ServiceRequest>(
    "ServiceRequest",
    parsedReferralId.data,
  );
  if (
    serviceRequest.subject.reference !== context.patientReference
    || referralDirectionOf(serviceRequest) !== "inbound"
  ) {
    return { status: 409, body: { error: "Inbound referral does not match this patient." } };
  }
  const policy = await new CorrespondencePolicyStore(deps.serviceFhir).read();
  try {
    assertCorrespondenceActionAllowed(
      context.staff.actorRole,
      input.action === "preview" ? "draft" : input.action,
      "consult-report",
      policy.staffSendableLetterTypes,
    );
  } catch (error) {
    return {
      status: 403,
      body: { error: error instanceof Error ? error.message : "Correspondence action denied." },
    };
  }
  const correspondence = new CorrespondenceService(
    context.staff.fhir,
    deps.serviceFhir,
    deps.correspondenceRenderer,
    deps.now,
  );
  const rendered = await correspondence.renderConsultReport({
    serviceRequest,
    authorReference: context.staff.staffReference,
    encounterReference: parsed.data.encounterReference,
    templateId: parsed.data.templateId,
    editedBodyHtml: parsed.data.editedBodyHtml,
    ...(input.action === "preview"
      ? {}
      : { signedByReference: context.staff.staffReference }),
  });
  const documentReferenceValue = documentReference(rendered.documentReference);
  if (input.action === "sign" || input.action === "send") {
    await deps.serviceFhir.create<AuditEvent>(buildCorrespondenceAuditEvent({
      action: "sign",
      actorReference: context.staff.staffReference,
      actorRole: context.staff.actorRole,
      patientReference: context.patientReference,
      documentReference: documentReferenceValue,
      recordedAt: deps.now?.() ?? new Date().toISOString(),
    }));
  }
  let provenanceReference: string | undefined;
  if (input.action === "send") {
    const recordedAt = deps.now?.() ?? new Date().toISOString();
    const provenance = await context.staff.fhir.create<Provenance>(buildProvenance({
      targetReferences: [
        `ServiceRequest/${parsedReferralId.data}`,
        documentReferenceValue,
      ],
      occurredDateTime: recordedAt,
      recorded: recordedAt,
      activityCode: "READ",
      activityDisplay: "Disclose consult report",
      agents: [{
        typeCode: "transmitter",
        typeDisplay: "Transmitter",
        whoReference: context.staff.staffReference,
      }],
    }));
    if (provenance.id) provenanceReference = `Provenance/${provenance.id}`;
    await deps.serviceFhir.create<AuditEvent>(buildCorrespondenceAuditEvent({
      action: "send",
      actorReference: context.staff.staffReference,
      actorRole: context.staff.actorRole,
      patientReference: context.patientReference,
      documentReference: documentReferenceValue,
      recordedAt,
    }));
  }
  return {
    status: 200,
    body: {
      serviceRequestReference: `ServiceRequest/${parsedReferralId.data}`,
      pdfBase64: rendered.pdf.toString("base64"),
      bodyHtml: rendered.bodyHtml,
      sourceEncounter: rendered.sourceEncounter,
      documentReference: documentReferenceValue,
      ...(provenanceReference ? { provenanceReference } : {}),
    },
  };
}

export async function handleSearchReferralConsultantsRequest(
  deps: ReferralEndpointDeps,
  input: { authHeader: string | undefined; query: unknown },
): Promise<ReferralEndpointResult> {
  const context = await authorizeReferralStaff(deps, input.authHeader);
  if ("result" in context) return context.result;
  const query = typeof input.query === "string" ? input.query : "";
  const consultants = await new ReferralDirectory(context.staff.fhir).search(query);
  return { status: 200, body: { consultants } };
}

export async function handleRecentReferralConsultantsRequest(
  deps: ReferralEndpointDeps,
  input: { authHeader: string | undefined },
): Promise<ReferralEndpointResult> {
  const context = await authorizeReferralStaff(deps, input.authHeader);
  if ("result" in context) return context.result;
  const consultants = await new ReferralDirectory(context.staff.fhir).recent(
    context.staff.staffReference,
  );
  return { status: 200, body: { consultants } };
}

export async function handleUpdateReferralDraftRequest(
  deps: ReferralEndpointDeps,
  input: {
    authHeader: string | undefined;
    patientId: unknown;
    referralId: unknown;
    body: unknown;
  },
): Promise<ReferralEndpointResult> {
  const context = await readPatientReferral(deps, input);
  if ("result" in context) return context.result;
  const parsed = updateReferralSchema.safeParse(input.body);
  if (!parsed.success) {
    return {
      status: 400,
      body: { error: parsed.error.issues[0]?.message ?? "Invalid referral update." },
    };
  }
  try {
    const serviceRequest = await new ReferralService(context.staff.fhir, deps.now)
      .updateReferralDraft(context.serviceRequest, parsed.data);
    return { status: 200, body: { serviceRequest } };
  } catch (error) {
    if (error instanceof ReferralSendConflictError) {
      return { status: 409, body: { error: error.message } };
    }
    throw error;
  }
}

export async function handleRegenerateReferralLetterRequest(
  deps: ReferralEndpointDeps,
  input: {
    authHeader: string | undefined;
    patientId: unknown;
    referralId: unknown;
  },
): Promise<ReferralEndpointResult> {
  const context = await readPatientReferral(deps, input);
  if ("result" in context) return context.result;
  try {
    const serviceRequest = await new ReferralService(context.staff.fhir, deps.now)
      .regenerateReferralLetter(context.serviceRequest);
    return { status: 200, body: { serviceRequest } };
  } catch (error) {
    if (error instanceof ReferralSendConflictError) {
      return { status: 409, body: { error: error.message } };
    }
    throw error;
  }
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
  const correspondence = new CorrespondenceService(
    context.staff.fhir,
    deps.serviceFhir,
    deps.correspondenceRenderer,
    deps.now,
  );
  const serviceRequestReference = `ServiceRequest/${referralId}`;
  if (input.action === "preview") {
    const rendered = await renderReferralWithAudit(deps, correspondence, {
      serviceRequest,
      staffReference: context.staff.staffReference,
      actorRole: context.staff.actorRole,
      patientReference: context.patientReference,
      serviceRequestReference,
      templateId: parsedBody.data.templateId,
      editedBodyHtml: parsedBody.data.editedLetterBody,
    });
    return {
      status: 200,
      body: {
        serviceRequestReference,
        pdfBase64: rendered.pdf.toString("base64"),
        bodyHtml: rendered.bodyHtml,
        documentReference: documentReference(rendered.documentReference),
      },
    };
  }

  const policy = await new CorrespondencePolicyStore(deps.serviceFhir).read();
  try {
    assertCorrespondenceActionAllowed(
      context.staff.actorRole,
      "send",
      "referral",
      policy.staffSendableLetterTypes,
    );
  } catch (error) {
    return {
      status: 403,
      body: { error: error instanceof Error ? error.message : "Correspondence action denied." },
    };
  }

  try {
    const preparedServiceRequest = await service.prepareReferralSend(
      serviceRequest,
      parsedBody.data.editedLetterBody,
    );
    const rendered = await renderReferralWithAudit(deps, correspondence, {
      serviceRequest: preparedServiceRequest,
      staffReference: context.staff.staffReference,
      actorRole: context.staff.actorRole,
      patientReference: context.patientReference,
      serviceRequestReference,
      templateId: parsedBody.data.templateId,
      editedBodyHtml: parsedBody.data.editedLetterBody,
      signedByReference: context.staff.staffReference,
    });
    const recordedAt = deps.now?.() ?? new Date().toISOString();
    const provenance: Provenance = buildProvenance({
      targetReferences: [
        serviceRequestReference,
        documentReference(rendered.documentReference),
      ],
      occurredDateTime: recordedAt,
      recorded: recordedAt,
      activityCode: "READ",
      activityDisplay: "Disclose referral",
      agents: [{
        typeCode: "transmitter",
        typeDisplay: "Transmitter",
        whoReference: context.staff.staffReference,
      }],
      entityValues: disclosedIncludeListEntities(readReferralIncludeList(preparedServiceRequest)),
    });
    const committed = await service.commitReferralSend(preparedServiceRequest, provenance);
    const correspondenceReference = documentReference(rendered.documentReference);
    await Promise.all([
      deps.serviceFhir.create<AuditEvent>(buildCorrespondenceAuditEvent({
        action: "sign",
        actorReference: context.staff.staffReference,
        actorRole: context.staff.actorRole,
        patientReference: context.patientReference,
        documentReference: correspondenceReference,
        recordedAt,
      })),
      deps.serviceFhir.create<AuditEvent>(buildCorrespondenceAuditEvent({
        action: "send",
        actorReference: context.staff.staffReference,
        actorRole: context.staff.actorRole,
        patientReference: context.patientReference,
        documentReference: correspondenceReference,
        recordedAt,
      })),
    ]);

    return {
      status: 200,
      body: {
        serviceRequestReference,
        pdfBase64: rendered.pdf.toString("base64"),
        bodyHtml: rendered.bodyHtml,
        documentReference: correspondenceReference,
        ...(committed.provenanceReference
          ? { provenanceReference: committed.provenanceReference }
          : {}),
      },
    };
  } catch (error) {
    if (error instanceof ReferralSendConflictError) {
      return { status: 409, body: { error: error.message } };
    }
    throw error;
  }
}

async function renderReferralWithAudit(
  deps: ReferralEndpointDeps,
  correspondence: CorrespondenceService,
  input: {
    serviceRequest: ServiceRequest;
    staffReference: string;
    actorRole: PracticeRoleId;
    patientReference: string;
    serviceRequestReference: string;
    templateId?: string;
    editedBodyHtml?: string;
    signedByReference?: string;
  },
) {
  let rendered;
  try {
    rendered = await correspondence.renderReferral({
      serviceRequest: input.serviceRequest,
      authorReference: input.staffReference,
      templateId: input.templateId,
      editedBodyHtml: input.editedBodyHtml,
      signedByReference: input.signedByReference,
    });
  } catch (error) {
    try {
      await deps.recordAudit(buildOdosAuditEventRow({
        eventType: "document.generate.failed",
        eventTime: deps.now?.(),
        actorReference: input.staffReference,
        actorRole: input.actorRole,
        patientReference: input.patientReference,
        targetReference: input.serviceRequestReference,
        outcome: "error",
        actionReason: `document-kind=letter; service-request=${input.serviceRequestReference}`,
      }));
    } catch (auditError) {
      console.error("odos-mcp: failed to audit referral generation failure:", auditError);
    }
    throw error;
  }
  const renderedDocumentReference = documentReference(rendered.documentReference);
  await deps.recordAudit(buildOdosAuditEventRow({
    eventType: "document.generate.completed",
    eventTime: deps.now?.(),
    actorReference: input.staffReference,
    actorRole: input.actorRole,
    patientReference: input.patientReference,
    targetReference: renderedDocumentReference,
    actionOutcome: "granted",
    actionReason: `document-kind=letter; service-request=${input.serviceRequestReference}; document-reference=${renderedDocumentReference}`,
  }));
  return rendered;
}

export async function handleListCorrespondenceTemplatesRequest(
  deps: ReferralEndpointDeps,
  input: { authHeader: string | undefined; letterType: unknown },
): Promise<ReferralEndpointResult> {
  const context = await authorizeReferralStaff(deps, input.authHeader);
  if ("result" in context) return context.result;
  const letterType = typeof input.letterType === "string" && input.letterType.trim()
    ? input.letterType.trim()
    : "referral";
  const templates = await new CorrespondenceService(
    context.staff.fhir,
    deps.serviceFhir,
    deps.correspondenceRenderer,
    deps.now,
  ).listTemplates(letterType);
  return { status: 200, body: { templates } };
}

export async function handleApplyReferralTemplateRequest(
  deps: ReferralEndpointDeps,
  input: {
    authHeader: string | undefined;
    patientId: unknown;
    referralId: unknown;
    body: unknown;
  },
): Promise<ReferralEndpointResult> {
  const context = await readPatientReferral(deps, input);
  if ("result" in context) return context.result;
  const parsed = applyTemplateSchema.safeParse(input.body);
  if (!parsed.success) {
    return {
      status: 400,
      body: { error: parsed.error.issues[0]?.message ?? "Invalid correspondence template." },
    };
  }
  const bodyHtml = await new CorrespondenceService(
    context.staff.fhir,
    deps.serviceFhir,
    deps.correspondenceRenderer,
    deps.now,
  ).resolveReferralTemplate(context.serviceRequest, parsed.data.templateId);
  try {
    const serviceRequest = await new ReferralService(context.staff.fhir, deps.now)
      .updateReferralDraft(context.serviceRequest, { letterBody: bodyHtml });
    return { status: 200, body: { serviceRequest, bodyHtml } };
  } catch (error) {
    if (error instanceof ReferralSendConflictError) {
      return { status: 409, body: { error: error.message } };
    }
    throw error;
  }
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

async function readPatientReferral(
  deps: ReferralEndpointDeps,
  input: {
    authHeader: string | undefined;
    patientId: unknown;
    referralId: unknown;
  },
): Promise<
  | {
      staff: NonNullable<Awaited<ReturnType<ReferralEndpointDeps["authenticate"]>>>;
      patientReference: string;
      serviceRequest: ServiceRequest;
    }
  | { result: ReferralEndpointResult }
> {
  const context = await authorizeReferralPatient(deps, input.authHeader, input.patientId);
  if ("result" in context) return context;
  const parsedReferralId = fhirIdSchema.safeParse(input.referralId);
  if (!parsedReferralId.success) {
    return { result: { status: 400, body: { error: "A valid referral ServiceRequest id is required." } } };
  }
  const serviceRequest = await context.staff.fhir.read<ServiceRequest>(
    "ServiceRequest",
    parsedReferralId.data,
  );
  if (serviceRequest.subject.reference !== context.patientReference) {
    return {
      result: {
        status: 409,
        body: { error: "The referral does not belong to the requested patient." },
      },
    };
  }
  return { ...context, serviceRequest };
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
  if (!["practice-admin", "clinician", "front-desk"].includes(staff.actorRole)) {
    return {
      result: {
        status: 403,
        body: { error: "Correspondence staff role required." },
      },
    };
  }
  return { staff };
}

function referralReference(serviceRequest: ServiceRequest): string {
  if (!serviceRequest.id) throw new Error("Referral create response did not include an id.");
  return `ServiceRequest/${serviceRequest.id}`;
}

function documentReference(resource: { id?: string }): string {
  if (!resource.id) throw new Error("Rendered DocumentReference create response did not include an id.");
  return `DocumentReference/${resource.id}`;
}

function patientDisplay(patient: Patient): string {
  const name = patient.name?.find((candidate) => candidate.use === "official")
    ?? patient.name?.[0];
  const display = name?.text?.trim()
    || [name?.given?.join(" "), name?.family].filter(Boolean).join(" ").trim();
  return display || `Patient/${patient.id ?? "unknown"}`;
}

function strictBase64(value: string): Buffer | undefined {
  const normalized = value.replace(/\s+/g, "");
  if (!normalized || !/^[A-Za-z0-9+/]*={0,2}$/.test(normalized)) return undefined;
  const bytes = Buffer.from(normalized, "base64");
  return bytes.length > 0 && bytes.toString("base64").replace(/=+$/, "")
      === normalized.replace(/=+$/, "")
    ? bytes
    : undefined;
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
