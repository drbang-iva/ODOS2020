export const HL7_V3_DATA_OPERATION_CODE_SYSTEM =
  "http://terminology.hl7.org/CodeSystem/v3-DataOperation";

export const FHIR_R4_PROVENANCE_ACTIVITY_CODES = [
  "CREATE",
  "UPDATE",
  "REVISE",
  "DELETE",
  "APPEND",
  "NULLIFY",
] as const;

export const OSOD_V05C_CLINICAL_ACTIVITY_CODES = [
  "CREATE",
  "UPDATE",
  "REVISE",
  "APPEND",
  "NULLIFY",
] as const;

export type FhirR4ProvenanceActivityCode =
  (typeof FHIR_R4_PROVENANCE_ACTIVITY_CODES)[number];
export type OsodV05cClinicalActivityCode =
  (typeof OSOD_V05C_CLINICAL_ACTIVITY_CODES)[number];

export type OsodClinicalProvenanceIntent =
  | "first-final-attestation"
  | "post-final-amendment"
  | "post-final-correction"
  | "should-never-have-existed"
  | "append-clinical-context";

export const PROVENANCE_ACTIVITY_BY_CLINICAL_INTENT = {
  "first-final-attestation": {
    code: "CREATE",
    display: "Create",
    description: "Clinician originates the final clinical record from a preliminary scribe draft.",
  },
  "post-final-amendment": {
    code: "UPDATE",
    display: "Update",
    description: "Final content was incomplete or needs additional context.",
  },
  "post-final-correction": {
    code: "REVISE",
    display: "Revise",
    description: "Final content was clinically wrong and must be corrected.",
  },
  "should-never-have-existed": {
    code: "NULLIFY",
    display: "Nullify",
    description: "Signed resource should not be treated as valid, without hard-delete.",
  },
  "append-clinical-context": {
    code: "APPEND",
    display: "Append",
    description: "New linked Observation adds successor context while the original remains final.",
  },
} as const satisfies Record<
  OsodClinicalProvenanceIntent,
  {
    code: OsodV05cClinicalActivityCode;
    display: string;
    description: string;
  }
>;

export function activityForClinicalIntent(
  intent: OsodClinicalProvenanceIntent,
): (typeof PROVENANCE_ACTIVITY_BY_CLINICAL_INTENT)[OsodClinicalProvenanceIntent] {
  return PROVENANCE_ACTIVITY_BY_CLINICAL_INTENT[intent];
}

export function assertProvenanceActivityCode(
  code: string,
): asserts code is OsodV05cClinicalActivityCode {
  const normalized = code.trim().toUpperCase();
  if (!OSOD_V05C_CLINICAL_ACTIVITY_CODES.includes(normalized as OsodV05cClinicalActivityCode)) {
    throw new Error(
      `ledger row 21: v3-DataOperation only for v0.5c Provenance.activity (${OSOD_V05C_CLINICAL_ACTIVITY_CODES.join(", ")}).`,
    );
  }
}

export function isOsodV05cClinicalActivityCode(
  code: string,
): code is OsodV05cClinicalActivityCode {
  return OSOD_V05C_CLINICAL_ACTIVITY_CODES.includes(
    code.trim().toUpperCase() as OsodV05cClinicalActivityCode,
  );
}
