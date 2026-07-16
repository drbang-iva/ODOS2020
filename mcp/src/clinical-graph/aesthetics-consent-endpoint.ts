import type {
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
} from "../fhir/aestheticsConsent.js";
import { buildProvenance } from "../fhir/ophthalmology/provenance.js";

export interface AestheticsConsentFhirClient {
  read<T extends Encounter>(resourceType: T["resourceType"], id: string): Promise<T>;
  create<T extends QuestionnaireResponse | Provenance>(
    resource: T,
    extraHeaders?: Record<string, string>,
  ): Promise<T>;
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

function staffMay(
  role: PracticeRoleId,
  action: "chart.read" | "aesthetics.procedure.write",
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
  return undefined;
}
