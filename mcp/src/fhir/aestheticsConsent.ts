import type {
  Questionnaire,
  QuestionnaireResponse,
} from "@medplum/fhirtypes";
import { reference } from "./ophthalmology/extensions.js";

export const AESTHETICS_COSMETIC_CONSENT_URL =
  "https://odos2020.com/fhir/Questionnaire/aesthetics-cosmetic-consent";
export const AESTHETICS_CONSENT_ACKNOWLEDGEMENT_LINK_ID =
  "cosmetic-procedure-acknowledgement";

export function buildAestheticsConsentQuestionnaire(): Questionnaire {
  return {
    resourceType: "Questionnaire",
    url: AESTHETICS_COSMETIC_CONSENT_URL,
    version: "0.1.0",
    name: "ODOSAestheticsCosmeticConsent",
    title: "Cosmetic procedure consent acknowledgement",
    status: "active",
    experimental: true,
    subjectType: ["Patient"],
    date: "2026-07-16",
    publisher: "ODOS",
    description:
      "Prototype acknowledgement for the aesthetics seam spike; not a production legal consent template.",
    item: [
      {
        linkId: "prototype-notice",
        text: "This prototype form demonstrates shared FHIR consent persistence and requires practice-specific legal review before production use.",
        type: "display",
      },
      {
        linkId: AESTHETICS_CONSENT_ACKNOWLEDGEMENT_LINK_ID,
        text: "I acknowledge that the proposed cosmetic procedure is elective and that expected benefits, material risks, alternatives, and aftercare must be reviewed with the treating clinician.",
        type: "boolean",
        required: true,
      },
    ],
  };
}

export function buildAestheticsConsentQuestionnaireResponse(input: {
  patientReference: string;
  encounterReference: string;
  acknowledged: boolean;
  authored?: string;
  authorReference?: string;
  sourceReference?: string;
}): QuestionnaireResponse {
  if (!input.acknowledged) {
    throw new Error("Cosmetic consent acknowledgement must be accepted before submission.");
  }
  return {
    resourceType: "QuestionnaireResponse",
    questionnaire: AESTHETICS_COSMETIC_CONSENT_URL,
    status: "completed",
    subject: reference(input.patientReference),
    encounter: reference(input.encounterReference),
    authored: input.authored ?? new Date().toISOString(),
    ...(input.authorReference ? { author: reference(input.authorReference) } : {}),
    ...(input.sourceReference ? { source: reference(input.sourceReference) } : {}),
    item: [{
      linkId: AESTHETICS_CONSENT_ACKNOWLEDGEMENT_LINK_ID,
      text: buildAestheticsConsentQuestionnaire().item?.[1]?.text,
      answer: [{ valueBoolean: true }],
    }],
  };
}

export function buildAestheticsCanonicalResources(): Questionnaire[] {
  return [buildAestheticsConsentQuestionnaire()];
}
