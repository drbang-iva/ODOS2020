// MIRROR of osod/mcp/src/fhir/allergyIntolerance.ts. Source of truth lives in MCP. Sync manually until v0.5 monorepo refactor. Parity guarded by mcp/tests/builder-mirror-parity.test.ts.
import type { AllergyIntolerance, CodeableConcept, Reference } from "@medplum/fhirtypes";

export const US_CORE_ALLERGY_INTOLERANCE_PROFILE =
  "http://hl7.org/fhir/us/core/StructureDefinition/us-core-allergyintolerance";
export const SNOMED_CT_CODE_SYSTEM = "http://snomed.info/sct";
export const RXNORM_CODE_SYSTEM = "http://www.nlm.nih.gov/research/umls/rxnorm";
export const ALLERGY_CLINICAL_STATUS_CODE_SYSTEM =
  "http://terminology.hl7.org/CodeSystem/allergyintolerance-clinical";
export const ALLERGY_VERIFICATION_STATUS_CODE_SYSTEM =
  "http://terminology.hl7.org/CodeSystem/allergyintolerance-verification";
export const NO_KNOWN_ALLERGY_SNOMED_CODE = "716186003";

export const ALLERGY_CLINICAL_STATUS_CODES = ["active", "inactive", "resolved"] as const;
export const ALLERGY_VERIFICATION_STATUS_CODES = [
  "unconfirmed",
  "confirmed",
  "refuted",
  "entered-in-error",
] as const;

export type AllergyClinicalStatusCode = (typeof ALLERGY_CLINICAL_STATUS_CODES)[number];
export type AllergyVerificationStatusCode =
  (typeof ALLERGY_VERIFICATION_STATUS_CODES)[number];

export interface AllergyCodeInput {
  system: string;
  code: string;
  display?: string;
  text?: string;
}

export interface AllergyReactionInput {
  manifestation: AllergyCodeInput | CodeableConcept;
  substance?: AllergyCodeInput | CodeableConcept;
  severity?: "mild" | "moderate" | "severe";
  description?: string;
}

export interface AllergyIntoleranceInput {
  patientReference: string;
  code?: AllergyCodeInput | CodeableConcept;
  noKnownAllergy?: boolean;
  clinicalStatus?: AllergyClinicalStatusCode;
  verificationStatus?: AllergyVerificationStatusCode;
  recordedDate?: string;
  recorderReference?: string;
  reaction?: AllergyReactionInput[];
}

export function buildAllergyIntolerance(input: AllergyIntoleranceInput): AllergyIntolerance {
  const verificationStatus =
    input.verificationStatus ?? (input.noKnownAllergy ? "confirmed" : "unconfirmed");
  const includeClinicalStatus = verificationStatus !== "entered-in-error";

  return {
    resourceType: "AllergyIntolerance",
    meta: { profile: [US_CORE_ALLERGY_INTOLERANCE_PROFILE] },
    ...(includeClinicalStatus
      ? { clinicalStatus: allergyClinicalStatusConcept(input.clinicalStatus ?? "active") }
      : {}),
    verificationStatus: allergyVerificationStatusConcept(verificationStatus),
    code: input.noKnownAllergy ? noKnownAllergyConcept() : allergyCodeConcept(requiredCode(input)),
    patient: reference(input.patientReference),
    ...(input.recordedDate ? { recordedDate: input.recordedDate } : {}),
    ...(input.recorderReference ? { recorder: reference(input.recorderReference) } : {}),
    ...(input.reaction?.length
      ? {
          reaction: input.reaction.map((reaction) => ({
            manifestation: [allergyCodeConcept(reaction.manifestation)],
            ...(reaction.substance ? { substance: allergyCodeConcept(reaction.substance) } : {}),
            ...(reaction.severity ? { severity: reaction.severity } : {}),
            ...(reaction.description ? { description: reaction.description } : {}),
          })),
        }
      : {}),
  };
}

export function noKnownAllergyConcept(): CodeableConcept {
  return {
    coding: [
      {
        system: SNOMED_CT_CODE_SYSTEM,
        code: NO_KNOWN_ALLERGY_SNOMED_CODE,
        display: "No known allergy",
      },
    ],
    text: "No known allergy",
  };
}

export function allergyClinicalStatusConcept(code: AllergyClinicalStatusCode): CodeableConcept {
  assertAllergyClinicalStatus(code);
  return {
    coding: [
      {
        system: ALLERGY_CLINICAL_STATUS_CODE_SYSTEM,
        code,
        display: code.charAt(0).toUpperCase() + code.slice(1),
      },
    ],
    text: code,
  };
}

export function allergyVerificationStatusConcept(code: AllergyVerificationStatusCode): CodeableConcept {
  assertAllergyVerificationStatus(code);
  return {
    coding: [
      {
        system: ALLERGY_VERIFICATION_STATUS_CODE_SYSTEM,
        code,
        display: code === "entered-in-error" ? "Entered in Error" : code.charAt(0).toUpperCase() + code.slice(1),
      },
    ],
    text: code,
  };
}

export function allergyCodeConcept(input: AllergyCodeInput | CodeableConcept): CodeableConcept {
  if (isCodeableConcept(input)) {
    return input;
  }

  return {
    coding: [
      {
        system: input.system,
        code: input.code,
        ...(input.display ? { display: input.display } : {}),
      },
    ],
    text: input.text ?? input.display ?? input.code,
  };
}

function isCodeableConcept(input: AllergyCodeInput | CodeableConcept): input is CodeableConcept {
  return "coding" in input;
}

export function assertAllergyClinicalStatus(
  value: string,
): asserts value is AllergyClinicalStatusCode {
  if (!ALLERGY_CLINICAL_STATUS_CODES.includes(value as AllergyClinicalStatusCode)) {
    throw new Error(
      `Unsupported AllergyIntolerance.clinicalStatus "${value}". Expected one of: ${ALLERGY_CLINICAL_STATUS_CODES.join(", ")}.`,
    );
  }
}

export function assertAllergyVerificationStatus(
  value: string,
): asserts value is AllergyVerificationStatusCode {
  if (!ALLERGY_VERIFICATION_STATUS_CODES.includes(value as AllergyVerificationStatusCode)) {
    throw new Error(
      `Unsupported AllergyIntolerance.verificationStatus "${value}". Expected one of: ${ALLERGY_VERIFICATION_STATUS_CODES.join(", ")}.`,
    );
  }
}

function requiredCode(input: AllergyIntoleranceInput): AllergyCodeInput | CodeableConcept {
  if (!input.code) {
    throw new Error("AllergyIntolerance.code is required unless noKnownAllergy is true.");
  }
  return input.code;
}

function reference(value: string): Reference<never> {
  return { reference: value };
}
