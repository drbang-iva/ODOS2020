import type {
  Bundle,
  Encounter,
  QuestionnaireResponse,
  Provenance,
} from "@medplum/fhirtypes";
import { z } from "zod";
import {
  assertBusinessActionAllowed,
  type PracticeRoleId,
} from "../authz/roles.js";
import {
  buildAestheticsConsentQuestionnaire,
  buildAestheticsConsentQuestionnaireResponse,
  buildClinicalPhotographyConsentQuestionnaire,
  buildClinicalPhotographyConsentQuestionnaireResponse,
  isCompletedClinicalPhotographyConsent,
} from "../fhir/aestheticsConsent.js";
import { buildProvenance } from "../fhir/ophthalmology/provenance.js";
import { ODOS_DISCIPLINE_SYSTEM } from "../scheduling/clinic-mode.js";

export interface AestheticsConsentFhirClient {
  read<T extends Encounter>(resourceType: T["resourceType"], id: string): Promise<T>;
  create<T extends QuestionnaireResponse | Provenance>(
    resource: T,
    extraHeaders?: Record<string, string>,
  ): Promise<T>;
  search<T extends QuestionnaireResponse>(
    resourceType: T["resourceType"],
    params?: Record<string, string>,
  ): Promise<Bundle<T>>;
}

export interface AestheticsConsentEndpointDeps {
  authenticate(authHeader: string | undefined): Promise<{
    staffReference: string;
    actorRole: PracticeRoleId;
    fhir: AestheticsConsentFhirClient;
  } | null>;
  now?: () => string;
}

const WRITE_HEADERS = {
  "X-ODOS-Source": "mcp/create_aesthetics_consent_response",
} as const;

const consentSchema = z.object({
  patientReference: z.string().regex(/^Patient\/[^/]+$/),
  encounterReference: z.string().regex(/^Encounter\/[^/]+$/),
  acknowledged: z.literal(true),
}).strict();

const photographyConsentQuerySchema = z.object({
  patient: z.string().regex(/^Patient\/[^/]+$/),
}).strict();

export async function handleAestheticsConsentDefinitionRequest(
  deps: AestheticsConsentEndpointDeps,
  input: { authHeader: string | undefined },
): Promise<{ status: number; body: unknown }> {
  const staff = await deps.authenticate(input.authHeader);
  if (!staff) return { status: 401, body: { error: "Authentication required to read consent." } };
  if (!staffMay(staff.actorRole, "chart.read")) {
    return { status: 403, body: { error: "chart.read role required" } };
  }
  return { status: 200, body: { questionnaire: buildAestheticsConsentQuestionnaire() } };
}

export async function handleAestheticsConsentSubmissionRequest(
  deps: AestheticsConsentEndpointDeps,
  input: { authHeader: string | undefined; body: unknown },
): Promise<{ status: number; body: unknown }> {
  const staff = await deps.authenticate(input.authHeader);
  if (!staff) return { status: 401, body: { error: "Authentication required to submit consent." } };
  if (!staffMay(staff.actorRole, "aesthetics.procedure.write")) {
    return { status: 403, body: { error: "aesthetics.procedure.write role required" } };
  }
  const parsed = consentSchema.safeParse(input.body);
  if (!parsed.success) {
    return { status: 400, body: { error: parsed.error.issues[0]?.message ?? "Invalid consent submission." } };
  }
  const encounterError = await validateEncounterPatient(
    staff.fhir,
    parsed.data.encounterReference,
    parsed.data.patientReference,
  );
  if (encounterError) {
    return { status: 422, body: { error: encounterError } };
  }
  const authored = deps.now?.() ?? new Date().toISOString();
  const questionnaireResponse = await staff.fhir.create(
    buildAestheticsConsentQuestionnaireResponse({
      ...parsed.data,
      authored,
      authorReference: staff.staffReference,
      sourceReference: parsed.data.patientReference,
    }),
    WRITE_HEADERS,
  );
  const responseReference = `QuestionnaireResponse/${questionnaireResponse.id}`;
  const provenance = await staff.fhir.create(
    buildProvenance({
      targetReferences: [responseReference, parsed.data.patientReference],
      occurredDateTime: authored,
      activityCode: "CREATE",
      activityDisplay: "Create",
      agents: [{
        typeCode: "author",
        typeDisplay: "Author",
        whoReference: staff.staffReference,
      }],
    }),
    WRITE_HEADERS,
  );
  return {
    status: 201,
    body: {
      questionnaireResponse,
      questionnaireResponseReference: responseReference,
      ...(provenance.id ? { provenanceReference: `Provenance/${provenance.id}` } : {}),
    },
  };
}

export async function handleClinicalPhotographyConsentStatusRequest(
  deps: AestheticsConsentEndpointDeps,
  input: { authHeader: string | undefined; query: unknown },
): Promise<{ status: number; body: unknown }> {
  const staff = await deps.authenticate(input.authHeader);
  if (!staff) return { status: 401, body: { error: "Authentication required to read photography consent." } };
  if (!staffMay(staff.actorRole, "chart.read")) {
    return { status: 403, body: { error: "chart.read role required" } };
  }
  const parsed = photographyConsentQuerySchema.safeParse(input.query);
  if (!parsed.success) {
    return { status: 400, body: { error: "A valid Patient reference is required." } };
  }
  const response = await findClinicalPhotographyConsent(staff.fhir, parsed.data.patient);
  return {
    status: 200,
    body: {
      questionnaire: buildClinicalPhotographyConsentQuestionnaire(),
      consented: Boolean(response),
      ...(response?.id ? { questionnaireResponseReference: `QuestionnaireResponse/${response.id}` } : {}),
    },
  };
}

export async function handleClinicalPhotographyConsentSubmissionRequest(
  deps: AestheticsConsentEndpointDeps,
  input: { authHeader: string | undefined; body: unknown },
): Promise<{ status: number; body: unknown }> {
  const staff = await deps.authenticate(input.authHeader);
  if (!staff) return { status: 401, body: { error: "Authentication required to record photography consent." } };
  if (!staffMay(staff.actorRole, "chart.write")) {
    return { status: 403, body: { error: "chart.write role required" } };
  }
  const parsed = consentSchema.safeParse(input.body);
  if (!parsed.success) {
    return { status: 400, body: { error: parsed.error.issues[0]?.message ?? "Invalid photography consent submission." } };
  }
  const encounterError = await validateEncounterPatient(
    staff.fhir,
    parsed.data.encounterReference,
    parsed.data.patientReference,
    false,
  );
  if (encounterError) return { status: 422, body: { error: encounterError } };
  const authored = deps.now?.() ?? new Date().toISOString();
  const questionnaireResponse = await staff.fhir.create(
    buildClinicalPhotographyConsentQuestionnaireResponse({
      ...parsed.data,
      authored,
      authorReference: staff.staffReference,
      sourceReference: parsed.data.patientReference,
    }),
    WRITE_HEADERS,
  );
  const responseReference = `QuestionnaireResponse/${questionnaireResponse.id}`;
  const provenance = await staff.fhir.create(
    buildProvenance({
      targetReferences: [responseReference, parsed.data.patientReference],
      occurredDateTime: authored,
      activityCode: "CREATE",
      activityDisplay: "Create",
      agents: [{
        typeCode: "author",
        typeDisplay: "Author",
        whoReference: staff.staffReference,
      }],
    }),
    WRITE_HEADERS,
  );
  return {
    status: 201,
    body: {
      questionnaireResponse,
      questionnaireResponseReference: responseReference,
      ...(provenance.id ? { provenanceReference: `Provenance/${provenance.id}` } : {}),
    },
  };
}

export async function findClinicalPhotographyConsent(
  fhir: Pick<AestheticsConsentFhirClient, "search">,
  patientReference: string,
): Promise<QuestionnaireResponse | undefined> {
  const bundle = await fhir.search<QuestionnaireResponse>("QuestionnaireResponse", {
    subject: patientReference,
    status: "completed",
    _sort: "-authored",
    _count: "100",
  });
  return (bundle.entry ?? [])
    .map((entry) => entry.resource)
    .find((response): response is QuestionnaireResponse =>
      Boolean(response && isCompletedClinicalPhotographyConsent(response, patientReference))
    );
}

function staffMay(
  role: PracticeRoleId,
  action: "chart.read" | "chart.write" | "aesthetics.procedure.write",
): boolean {
  try {
    assertBusinessActionAllowed(role, action);
    return true;
  } catch {
    return false;
  }
}

async function validateEncounterPatient(
  fhir: AestheticsConsentFhirClient,
  encounterReference: string,
  patientReference: string,
  requireAesthetics = true,
): Promise<string | undefined> {
  const encounterId = encounterReference.slice("Encounter/".length);
  let encounter: Encounter;
  try {
    encounter = await fhir.read<Encounter>("Encounter", encounterId);
  } catch {
    return `Unable to validate ${encounterReference} because the Encounter could not be read.`;
  }
  if (encounter.subject?.reference !== patientReference) {
    return `${encounterReference} does not belong to ${patientReference}.`;
  }
  if (requireAesthetics && !encounter.serviceType?.coding?.some((coding) =>
    coding.system === ODOS_DISCIPLINE_SYSTEM && coding.code === "aesthetics"
  )) {
    return `${encounterReference} is not an aesthetics Encounter.`;
  }
  return undefined;
}
