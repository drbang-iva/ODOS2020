import type { Resource } from "@medplum/fhirtypes";
import { z } from "zod";
import type { PracticeRoleId } from "../authz/roles.js";
import {
  InboundFaxTriageService,
  type InboundFaxFhir,
} from "./inbound-fax.js";

export interface InboundFaxEndpointDeps {
  authenticate(authHeader: string | undefined): Promise<{
    staffReference: string;
    actorRole: PracticeRoleId;
  } | null>;
  serviceFhir: InboundFaxFhir;
  now?: () => string;
}

export interface InboundFaxEndpointResult {
  status: number;
  body: unknown;
}

export interface InboundFaxDocumentResult {
  status: number;
  body?: { error: string };
  contentType?: "application/pdf";
  dataBase64?: string;
  filename?: string;
}

const fhirIdSchema = z.string().regex(/^[A-Za-z0-9.-]{1,64}$/);
const patientReferenceSchema = z.string().regex(/^Patient\/[A-Za-z0-9.-]{1,64}$/);
const providerReferenceSchema = z.string().regex(
  /^(Practitioner|PractitionerRole)\/[A-Za-z0-9.-]{1,64}$/,
);
const referrerReferenceSchema = z.string().regex(
  /^(Practitioner|PractitionerRole|Organization)\/[A-Za-z0-9.-]{1,64}$/,
);
const attachSchema = z.object({
  patientReference: patientReferenceSchema,
}).strict();
const promoteSchema = z.object({
  patientReference: patientReferenceSchema,
  patientDisplay: z.string().trim().min(1).max(200),
  referrerReference: referrerReferenceSchema.optional(),
  referrerDisplay: z.string().trim().min(1).max(200),
  performerReference: providerReferenceSchema,
  performerDisplay: z.string().trim().min(1).max(200),
  reasonText: z.string().trim().min(1).max(2_000),
}).strict();
const inboxSchema = z.object({}).strict();

export async function handleInboundFaxActionRequest(
  deps: InboundFaxEndpointDeps,
  input: {
    authHeader: string | undefined;
    faxId: unknown;
    action: "attach" | "promote" | "inbox";
    body: unknown;
  },
): Promise<InboundFaxEndpointResult> {
  const authorized = await authorizeInboundFax(deps, input.authHeader);
  if ("result" in authorized) {
    return {
      status: authorized.result.status,
      body: authorized.result.body as { error: string },
    };
  }
  const faxId = fhirIdSchema.safeParse(input.faxId);
  if (!faxId.success) {
    return { status: 400, body: { error: "A valid inbound fax id is required." } };
  }
  const documentReference = `DocumentReference/${faxId.data}`;
  const triage = new InboundFaxTriageService(
    deps.serviceFhir,
    deps.now,
  );
  if (input.action === "inbox") {
    if (!inboxSchema.safeParse(input.body).success) {
      return { status: 400, body: { error: "General inbox action accepts no fields." } };
    }
    const document = await triage.routeToInbox(
      documentReference,
      authorized.staff.actorRole,
    );
    return { status: 200, body: { documentReference: referenceOf(document) } };
  }
  if (input.action === "attach") {
    const parsed = attachSchema.safeParse(input.body);
    if (!parsed.success) {
      return {
        status: 400,
        body: { error: parsed.error.issues[0]?.message ?? "Invalid inbound fax attachment." },
      };
    }
    const document = await triage.attach({
      faxDocumentReference: documentReference,
      patientReference: parsed.data.patientReference,
      actorReference: authorized.staff.staffReference,
      actorRole: authorized.staff.actorRole,
    });
    return { status: 200, body: { documentReference: referenceOf(document) } };
  }
  const parsed = promoteSchema.safeParse(input.body);
  if (!parsed.success) {
    return {
      status: 400,
      body: { error: parsed.error.issues[0]?.message ?? "Invalid inbound referral promotion." },
    };
  }
  const promoted = await triage.promote({
    faxDocumentReference: documentReference,
    ...parsed.data,
    actorReference: authorized.staff.staffReference,
    actorRole: authorized.staff.actorRole,
  });
  return {
    status: 200,
    body: {
      documentReference: referenceOf(promoted.documentReference),
      serviceRequest: referenceOf(promoted.serviceRequest),
    },
  };
}

export async function handleInboundFaxDocumentRequest(
  deps: InboundFaxEndpointDeps,
  input: {
    authHeader: string | undefined;
    faxId: unknown;
  },
): Promise<InboundFaxDocumentResult> {
  const authorized = await authorizeInboundFax(deps, input.authHeader);
  if ("result" in authorized) {
    return {
      status: authorized.result.status,
      body: authorized.result.body as { error: string },
    };
  }
  const faxId = fhirIdSchema.safeParse(input.faxId);
  if (!faxId.success) {
    return { status: 400, body: { error: "A valid inbound fax id is required." } };
  }
  const pdf = await new InboundFaxTriageService(
    deps.serviceFhir,
    deps.now,
  ).pdf(`DocumentReference/${faxId.data}`);
  return {
    status: 200,
    contentType: pdf.contentType,
    dataBase64: pdf.data,
    filename: pdf.filename,
  };
}

async function authorizeInboundFax(
  deps: InboundFaxEndpointDeps,
  authHeader: string | undefined,
): Promise<
  | { staff: NonNullable<Awaited<ReturnType<InboundFaxEndpointDeps["authenticate"]>>> }
  | { result: InboundFaxEndpointResult }
> {
  const staff = await deps.authenticate(authHeader);
  if (!staff) {
    return {
      result: {
        status: 401,
        body: { error: "Authentication required to manage inbound faxes." },
      },
    };
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

function referenceOf(resource: Pick<Resource, "resourceType" | "id">): string {
  if (!resource.id) throw new Error(`${resource.resourceType} response did not include an id.`);
  return `${resource.resourceType}/${resource.id}`;
}
