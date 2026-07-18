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

export const ODOS_V05C_CLINICAL_ACTIVITY_CODES = [
  "CREATE",
  "UPDATE",
  "REVISE",
  "APPEND",
  "NULLIFY",
] as const;

export type FhirR4ProvenanceActivityCode =
  (typeof FHIR_R4_PROVENANCE_ACTIVITY_CODES)[number];
export type OdosV05cClinicalActivityCode =
  (typeof ODOS_V05C_CLINICAL_ACTIVITY_CODES)[number];

export type OdosClinicalProvenanceIntent =
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
  OdosClinicalProvenanceIntent,
  {
    code: OdosV05cClinicalActivityCode;
    display: string;
    description: string;
  }
>;

export function activityForClinicalIntent(
  intent: OdosClinicalProvenanceIntent,
): (typeof PROVENANCE_ACTIVITY_BY_CLINICAL_INTENT)[OdosClinicalProvenanceIntent] {
  return PROVENANCE_ACTIVITY_BY_CLINICAL_INTENT[intent];
}

export function assertProvenanceActivityCode(
  code: string,
): asserts code is OdosV05cClinicalActivityCode {
  const normalized = code.trim().toUpperCase();
  if (!ODOS_V05C_CLINICAL_ACTIVITY_CODES.includes(normalized as OdosV05cClinicalActivityCode)) {
    throw new Error(
      `ledger row 21: v3-DataOperation only for v0.5c Provenance.activity (${ODOS_V05C_CLINICAL_ACTIVITY_CODES.join(", ")}).`,
    );
  }
}

export function isOdosV05cClinicalActivityCode(
  code: string,
): code is OdosV05cClinicalActivityCode {
  return ODOS_V05C_CLINICAL_ACTIVITY_CODES.includes(
    code.trim().toUpperCase() as OdosV05cClinicalActivityCode,
  );
}
