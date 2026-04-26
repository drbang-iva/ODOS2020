// MIRROR of osod/mcp/src/fhir/condition.ts. Source of truth lives in MCP. Sync manually until v0.5 monorepo refactor. Parity guarded by mcp/tests/builder-mirror-parity.test.ts.
import type { CodeableConcept, Condition, Encounter, Extension, Reference } from "@medplum/fhirtypes";

export const US_CORE_CONDITION_ENCOUNTER_DIAGNOSIS_PROFILE =
  "http://hl7.org/fhir/us/core/StructureDefinition/us-core-condition-encounter-diagnosis";
export const US_CORE_CONDITION_PROBLEMS_HEALTH_CONCERNS_PROFILE =
  "http://hl7.org/fhir/us/core/StructureDefinition/us-core-condition-problems-health-concerns";
export const FHIR_CONDITION_CATEGORY_CODE_SYSTEM =
  "http://terminology.hl7.org/CodeSystem/condition-category";
export const US_CORE_CONDITION_CATEGORY_CODE_SYSTEM =
  "http://hl7.org/fhir/us/core/CodeSystem/condition-category";
export const FHIR_CONDITION_CLINICAL_STATUS_CODE_SYSTEM =
  "http://terminology.hl7.org/CodeSystem/condition-clinical";
export const FHIR_CONDITION_VERIFICATION_STATUS_CODE_SYSTEM =
  "http://terminology.hl7.org/CodeSystem/condition-ver-status";
export const FHIR_DIAGNOSIS_ROLE_CODE_SYSTEM =
  "http://terminology.hl7.org/CodeSystem/diagnosis-role";
export const CONDITION_BODY_SITE_EXTENSION_URL =
  "http://hl7.org/fhir/StructureDefinition/bodySite";

export const CONDITION_CATEGORY_CODES = [
  "encounter-diagnosis",
  "problem-list-item",
  "health-concern",
] as const;
export const CONDITION_CLINICAL_STATUS_CODES = [
  "active",
  "recurrence",
  "relapse",
  "inactive",
  "remission",
  "resolved",
] as const;
export const CONDITION_VERIFICATION_STATUS_CODES = [
  "unconfirmed",
  "provisional",
  "differential",
  "confirmed",
  "refuted",
  "entered-in-error",
] as const;

export type ConditionCategoryCode = (typeof CONDITION_CATEGORY_CODES)[number];
export type ConditionClinicalStatusCode = (typeof CONDITION_CLINICAL_STATUS_CODES)[number];
export type ConditionVerificationStatusCode =
  (typeof CONDITION_VERIFICATION_STATUS_CODES)[number];

export interface ConditionCodeInput {
  system: string;
  code: string;
  display?: string;
  text?: string;
}

export interface ConditionBaseInput {
  patientReference: string;
  code: ConditionCodeInput | CodeableConcept;
  clinicalStatus?: ConditionClinicalStatusCode;
  verificationStatus?: ConditionVerificationStatusCode;
  onsetDateTime?: string;
  abatementDateTime?: string;
  recordedDate?: string;
  bodyStructureReference?: string;
  bodySiteText?: string;
}

export interface EncounterDiagnosisConditionInput extends ConditionBaseInput {
  encounterReference: string;
}

export function buildEncounterDiagnosisCondition(
  input: EncounterDiagnosisConditionInput,
): Condition {
  return buildCondition(input, "encounter-diagnosis");
}

export function buildProblemListCondition(input: ConditionBaseInput): Condition {
  return buildCondition(input, "problem-list-item");
}

export function buildHealthConcernCondition(input: ConditionBaseInput): Condition {
  return buildCondition(input, "health-concern");
}

export function buildEncounterDiagnosisComponent(
  conditionReference: string,
  rank: number,
): NonNullable<Encounter["diagnosis"]>[number] {
  if (!Number.isInteger(rank) || rank < 1) {
    throw new Error("Encounter diagnosis rank must be a positive integer.");
  }

  return {
    condition: reference(conditionReference),
    use: diagnosisRoleConcept("billing", "Billing"),
    rank,
  };
}

export function conditionCategoryConcept(category: ConditionCategoryCode): CodeableConcept {
  assertConditionCategory(category);
  const isHealthConcern = category === "health-concern";

  return {
    coding: [
      {
        system: isHealthConcern
          ? US_CORE_CONDITION_CATEGORY_CODE_SYSTEM
          : FHIR_CONDITION_CATEGORY_CODE_SYSTEM,
        code: category,
        display: categoryDisplay(category),
      },
    ],
    text: categoryDisplay(category),
  };
}

export function clinicalStatusConcept(code: ConditionClinicalStatusCode): CodeableConcept {
  assertClinicalStatus(code);
  return codeableConcept({
    system: FHIR_CONDITION_CLINICAL_STATUS_CODE_SYSTEM,
    code,
    display: titleCase(code),
  });
}

export function verificationStatusConcept(code: ConditionVerificationStatusCode): CodeableConcept {
  assertVerificationStatus(code);
  return codeableConcept({
    system: FHIR_CONDITION_VERIFICATION_STATUS_CODE_SYSTEM,
    code,
    display: code === "entered-in-error" ? "Entered in Error" : titleCase(code),
  });
}

export function diagnosisRoleConcept(code: "billing" | "CC" | "CM", display?: string): CodeableConcept {
  return codeableConcept({
    system: FHIR_DIAGNOSIS_ROLE_CODE_SYSTEM,
    code,
    display: display ?? (code === "CC" ? "Chief complaint" : code === "CM" ? "Comorbidity diagnosis" : "Billing"),
  });
}

export function conditionCodeConcept(input: ConditionCodeInput | CodeableConcept): CodeableConcept {
  if (isCodeableConcept(input)) {
    return input;
  }
  return codeableConcept(input);
}

export function hasConditionCategory(condition: Condition, category: ConditionCategoryCode): boolean {
  const expectedSystem =
    category === "health-concern"
      ? US_CORE_CONDITION_CATEGORY_CODE_SYSTEM
      : FHIR_CONDITION_CATEGORY_CODE_SYSTEM;

  return Boolean(
    condition.category?.some((concept) =>
      concept.coding?.some(
        (coding) => coding.system === expectedSystem && coding.code === category,
      ),
    ),
  );
}

export function conditionBodySiteReferenceExtension(bodyStructureReference: string): Extension {
  return {
    url: CONDITION_BODY_SITE_EXTENSION_URL,
    valueReference: reference(bodyStructureReference),
  };
}

export function conditionBodySite(bodyStructureReference: string, text?: string): CodeableConcept[] {
  return [
    {
      text: text ?? "Referenced body site",
      extension: [conditionBodySiteReferenceExtension(bodyStructureReference)],
    },
  ];
}

export function assertConditionCategory(value: string): asserts value is ConditionCategoryCode {
  if (!CONDITION_CATEGORY_CODES.includes(value as ConditionCategoryCode)) {
    throw new Error(
      `Unsupported Condition.category "${value}". Expected one of: ${CONDITION_CATEGORY_CODES.join(", ")}.`,
    );
  }
}

export function assertClinicalStatus(value: string): asserts value is ConditionClinicalStatusCode {
  if (!CONDITION_CLINICAL_STATUS_CODES.includes(value as ConditionClinicalStatusCode)) {
    throw new Error(
      `Unsupported Condition.clinicalStatus "${value}". Expected one of: ${CONDITION_CLINICAL_STATUS_CODES.join(", ")}.`,
    );
  }
}

export function assertVerificationStatus(
  value: string,
): asserts value is ConditionVerificationStatusCode {
  if (!CONDITION_VERIFICATION_STATUS_CODES.includes(value as ConditionVerificationStatusCode)) {
    throw new Error(
      `Unsupported Condition.verificationStatus "${value}". Expected one of: ${CONDITION_VERIFICATION_STATUS_CODES.join(", ")}.`,
    );
  }
}

function buildCondition(
  input: ConditionBaseInput & { encounterReference?: string },
  category: ConditionCategoryCode,
): Condition {
  const verificationStatus = input.verificationStatus ?? "confirmed";
  const includeClinicalStatus = verificationStatus !== "entered-in-error";

  return {
    resourceType: "Condition",
    meta: {
      profile: [
        category === "encounter-diagnosis"
          ? US_CORE_CONDITION_ENCOUNTER_DIAGNOSIS_PROFILE
          : US_CORE_CONDITION_PROBLEMS_HEALTH_CONCERNS_PROFILE,
      ],
    },
    category: [conditionCategoryConcept(category)],
    code: conditionCodeConcept(input.code),
    subject: reference(input.patientReference),
    ...(category === "encounter-diagnosis" && input.encounterReference
      ? { encounter: reference(input.encounterReference) }
      : {}),
    ...(includeClinicalStatus
      ? { clinicalStatus: clinicalStatusConcept(input.clinicalStatus ?? "active") }
      : {}),
    verificationStatus: verificationStatusConcept(verificationStatus),
    ...(input.onsetDateTime ? { onsetDateTime: input.onsetDateTime } : {}),
    ...(input.abatementDateTime ? { abatementDateTime: input.abatementDateTime } : {}),
    ...(input.recordedDate ? { recordedDate: input.recordedDate } : {}),
    ...(input.bodyStructureReference
      ? { bodySite: conditionBodySite(input.bodyStructureReference, input.bodySiteText) }
      : {}),
  };
}

function codeableConcept(input: ConditionCodeInput): CodeableConcept {
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

function isCodeableConcept(input: ConditionCodeInput | CodeableConcept): input is CodeableConcept {
  return "coding" in input;
}

function categoryDisplay(category: ConditionCategoryCode): string {
  if (category === "encounter-diagnosis") return "Encounter Diagnosis";
  if (category === "problem-list-item") return "Problem List Item";
  return "Health Concern";
}

function titleCase(value: string): string {
  return value
    .split("-")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function reference(value: string): Reference<never> {
  return { reference: value };
}
