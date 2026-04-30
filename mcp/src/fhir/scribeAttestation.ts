import { randomUUID } from "node:crypto";
import { z } from "zod";
import type {
  Binary,
  Bundle,
  CodeableConcept,
  Encounter,
  Observation,
  Provenance,
  Resource,
} from "@medplum/fhirtypes";
import {
  OSOD_CLINICAL_AMENDMENT_POLICY_URL,
  OSOD_CLINICAL_ATTESTATION_POLICY_URL,
} from "../../../policy/attestation-policy-urls.js";
import { OSOD_APPEND_OBSERVATION_RELATIONSHIP_FIELD } from "../../../policy/observation-relationship-types.js";
import {
  assertObservationStatusTransition,
  isObservationStatus,
  type ObservationStatus,
} from "../../../policy/observation-status-machine.js";
import {
  activityForClinicalIntent,
  assertProvenanceActivityCode,
  type OsodClinicalProvenanceIntent,
  type OsodV05cClinicalActivityCode,
} from "../../../policy/provenance-activity-map.js";
import {
  FHIR_AUTHOR_SIGNATURE_TYPE_CODE,
  FHIR_AUTHOR_SIGNATURE_TYPE_DISPLAY,
  FHIR_AUTHOR_SIGNATURE_TYPE_SYSTEM,
  OSOD_PROVENANCE_SIGNATURE_FORMAT,
} from "../../../policy/signature-formats.js";
import { OSOD_ROLE_CODE_SYSTEM, buildOsodAuditEventRow } from "../authz/osodAudit.js";
import type { OsodAuditEventRecord } from "../authz/osodAudit.js";
import type { JsonPatchOperation } from "../fhir-client.js";
import { buildProvenance } from "./ophthalmology/provenance.js";

export const OBSERVATION_ATTESTATION_UI_STATE_EXTENSION_URL =
  "https://osod.dev/fhir/StructureDefinition/observation-attestation-ui-state";

export const OBSERVATION_ATTESTATION_UI_STATE_CODES = [
  "pending-clinician-review",
  "clinician-reviewing",
  "attestation-in-flight",
] as const;

export type ObservationAttestationUiState =
  (typeof OBSERVATION_ATTESTATION_UI_STATE_CODES)[number];

const referenceStringSchema = z.string().min(1);
const optionalReferenceListSchema = z.union([z.string().min(1), z.array(z.string().min(1))]).optional();

export const scribeWriteObservationSchema = z
  .object({
    patient_id: z.string().min(1),
    encounter_id: z.string().min(1),
    intended_observation_type: z.string().min(1),
    text: z.string().min(1),
    scribe_id: z.string().min(1),
    recorded_at: z.string().optional(),
    audio_binary_id: z.string().min(1).optional(),
    source_reference: optionalReferenceListSchema,
    ui_state: z.enum(OBSERVATION_ATTESTATION_UI_STATE_CODES).optional(),
  })
  .strict();

export const clinicianAttestationSchema = z
  .object({
    observation_id: referenceStringSchema,
    clinician_id: referenceStringSchema,
    signature_data_base64: z.string().min(1),
  })
  .strict();

export const amendmentTargetStatusSchema = z.enum([
  "amended",
  "corrected",
  "entered-in-error",
]);

export const observationAmendmentSchema = z
  .object({
    observation_id: referenceStringSchema,
    clinician_id: referenceStringSchema,
    target_status: amendmentTargetStatusSchema,
    amendment_text: z.string().min(1),
    signature_data_base64: z.string().min(1),
  })
  .strict();

export const appendObservationContextSchema = z
  .object({
    source_observation_id: referenceStringSchema,
    patient_id: z.string().min(1),
    encounter_id: z.string().min(1),
    intended_observation_type: z.string().min(1),
    text: z.string().min(1),
    clinician_id: referenceStringSchema,
    signature_data_base64: z.string().min(1),
    recorded_at: z.string().optional(),
  })
  .strict();

export type ScribeWriteObservationInput = z.infer<typeof scribeWriteObservationSchema>;
export type ClinicianAttestationInput = z.infer<typeof clinicianAttestationSchema>;
export type ObservationAmendmentInput = z.infer<typeof observationAmendmentSchema>;
export type AppendObservationContextInput = z.infer<typeof appendObservationContextSchema>;
export type AmendmentTargetStatus = z.infer<typeof amendmentTargetStatusSchema>;

export function buildScribeDraftObservation(
  input: ScribeWriteObservationInput,
  encounter?: Encounter,
): Observation {
  const recorded = input.recorded_at ?? new Date().toISOString();
  const patientReference = normalizeReference(input.patient_id, "Patient");
  const encounterReference = normalizeReference(input.encounter_id, "Encounter");
  const sourceReferences = stringList(input.source_reference);

  if (encounter) {
    assertEncounterPatientMatchesInput(input.patient_id, encounter);
  }

  const observation: Observation = {
    resourceType: "Observation",
    id: randomUUID(),
    status: "preliminary",
    code: { text: input.intended_observation_type },
    subject: { reference: patientReference },
    encounter: { reference: encounterReference },
    effectiveDateTime: recorded,
    issued: recorded,
    performer: [{ reference: normalizeReference(input.scribe_id, "Practitioner") }],
    note: [
      {
        time: recorded,
        authorReference: { reference: normalizeReference(input.scribe_id, "Practitioner") },
        text: input.text,
      },
    ],
    ...(sourceReferences.length
      ? { derivedFrom: sourceReferences.map((sourceReference) => ({ reference: sourceReference })) }
      : {}),
    ...(input.ui_state
      ? {
          extension: [
            {
              url: OBSERVATION_ATTESTATION_UI_STATE_EXTENSION_URL,
              valueCode: input.ui_state,
            },
          ],
        }
      : {}),
  };

  assertObservationStatusTransition({
    from: undefined,
    to: observation.status,
    actorRole: "scribe",
  });
  return observation;
}

export function assertEncounterPatientMatchesInput(
  patientId: string,
  encounter: Encounter,
): void {
  const expected = normalizeReference(patientId, "Patient");
  if (encounter.subject?.reference !== expected) {
    throw new Error(
      `Scribe draft rejected: Encounter/${encounter.id ?? "(unknown)"} is not in ${expected}'s patient compartment.`,
    );
  }
}

export function assertBinarySecurityContextForEncounter(
  binary: Binary,
  encounter: Encounter,
): void {
  const patientReference = encounter.subject?.reference;
  if (!patientReference) {
    throw new Error(
      `Binary.securityContext verification failed: Encounter/${encounter.id ?? "(unknown)"} has no Patient subject.`,
    );
  }
  if (binary.securityContext?.reference !== patientReference) {
    throw new Error(
      `Binary.securityContext verification failed: Binary/${binary.id ?? "(unknown)"} must be bound to ${patientReference}.`,
    );
  }
}

export function buildAttestationTransaction(input: {
  observation: Observation;
  clinicianId: string;
  signatureDataBase64: string;
  recorded?: string;
  provenanceId?: string;
}): {
  bundle: Bundle;
  provenance: Provenance;
  patchOperations: JsonPatchOperation[];
} {
  assertObservationStatusTransition({
    from: observationStatusBefore(input.observation),
    to: "final",
    actorRole: "clinician",
  });

  const recorded = input.recorded ?? new Date().toISOString();
  const provenance = buildSignedClinicalProvenance({
    id: input.provenanceId,
    targetReferences: [observationReference(input.observation)],
    clinicianId: input.clinicianId,
    recorded,
    intent: "first-final-attestation",
    policyUrl: OSOD_CLINICAL_ATTESTATION_POLICY_URL,
    signatureDataBase64: input.signatureDataBase64,
  });
  const patchOperations = statusPatchOperations(input.observation, "final");

  return {
    provenance,
    patchOperations,
    bundle: transactionBundle([
      {
        resource: jsonPatchBinaryResource(patchOperations),
        request: versionAwareRequest(input.observation, "PATCH", observationReference(input.observation)),
      },
      {
        resource: provenance,
        request: { method: "PUT", url: `Provenance/${provenance.id}` },
      },
    ]),
  };
}

export function buildAmendmentTransaction(input: {
  observation: Observation;
  clinicianId: string;
  targetStatus: AmendmentTargetStatus;
  amendmentText: string;
  signatureDataBase64: string;
  recorded?: string;
  provenanceId?: string;
}): {
  bundle: Bundle;
  provenance: Provenance;
  patchOperations: JsonPatchOperation[];
  activityCode: OsodV05cClinicalActivityCode;
} {
  assertObservationStatusTransition({
    from: observationStatusBefore(input.observation),
    to: input.targetStatus,
    actorRole: "clinician",
  });

  const recorded = input.recorded ?? new Date().toISOString();
  const intent = amendmentIntentForTargetStatus(input.targetStatus);
  const activity = activityForClinicalIntent(intent);
  assertProvenanceActivityCode(activity.code);
  const provenance = buildSignedClinicalProvenance({
    id: input.provenanceId,
    targetReferences: [observationReference(input.observation)],
    clinicianId: input.clinicianId,
    recorded,
    intent,
    policyUrl: OSOD_CLINICAL_AMENDMENT_POLICY_URL,
    signatureDataBase64: input.signatureDataBase64,
  });
  const patchOperations = [
    ...statusPatchOperations(input.observation, input.targetStatus),
    notePatchOperation(input.observation, {
      time: recorded,
      authorReference: { reference: normalizeReference(input.clinicianId, "Practitioner") },
      text: input.amendmentText,
    }),
  ];

  return {
    provenance,
    patchOperations,
    activityCode: activity.code,
    bundle: transactionBundle([
      {
        resource: jsonPatchBinaryResource(patchOperations),
        request: versionAwareRequest(input.observation, "PATCH", observationReference(input.observation)),
      },
      {
        resource: provenance,
        request: { method: "PUT", url: `Provenance/${provenance.id}` },
      },
    ]),
  };
}

export function buildAppendObservationTransaction(input: {
  sourceObservation: Observation;
  appendInput: AppendObservationContextInput;
  recorded?: string;
  appendedObservationId?: string;
  provenanceId?: string;
}): {
  bundle: Bundle;
  observation: Observation;
  provenance: Provenance;
} {
  if (input.sourceObservation.status !== "final") {
    throw new Error("APPEND requires the original Observation to remain final and unchanged.");
  }

  const recorded = input.recorded ?? input.appendInput.recorded_at ?? new Date().toISOString();
  const sourceReference = observationReference(input.sourceObservation);
  const observation: Observation = {
    resourceType: "Observation",
    id: input.appendedObservationId ?? randomUUID(),
    status: "final",
    code: { text: input.appendInput.intended_observation_type },
    subject: { reference: normalizeReference(input.appendInput.patient_id, "Patient") },
    encounter: { reference: normalizeReference(input.appendInput.encounter_id, "Encounter") },
    effectiveDateTime: recorded,
    issued: recorded,
    performer: [{ reference: normalizeReference(input.appendInput.clinician_id, "Practitioner") }],
    [OSOD_APPEND_OBSERVATION_RELATIONSHIP_FIELD]: [{ reference: sourceReference }],
    note: [
      {
        time: recorded,
        authorReference: {
          reference: normalizeReference(input.appendInput.clinician_id, "Practitioner"),
        },
        text: input.appendInput.text,
      },
    ],
  };
  const provenance = buildSignedClinicalProvenance({
    id: input.provenanceId,
    targetReferences: [observationReference(observation)],
    clinicianId: input.appendInput.clinician_id,
    recorded,
    intent: "append-clinical-context",
    policyUrl: OSOD_CLINICAL_AMENDMENT_POLICY_URL,
    signatureDataBase64: input.appendInput.signature_data_base64,
  });

  return {
    observation,
    provenance,
    bundle: transactionBundle([
      {
        resource: observation,
        request: { method: "PUT", url: observationReference(observation) },
      },
      {
        resource: provenance,
        request: { method: "PUT", url: `Provenance/${provenance.id}` },
      },
    ]),
  };
}

export function buildClinicalWriteAuditRow(input: {
  eventType: "create" | "update";
  actorId: string;
  actorRole: "scribe" | "clinician" | "system";
  observation: Observation;
  provenanceId?: string;
  policyUrl?: string;
  actionReason?: string;
}): OsodAuditEventRecord {
  return buildOsodAuditEventRow({
    eventType: input.eventType,
    actorId: normalizeReferenceId(input.actorId, "Practitioner"),
    actorRole: input.actorRole,
    patientReference: input.observation.subject?.reference,
    resourceType: "Observation",
    resourceId: input.observation.id,
    targetReference: observationReference(input.observation),
    actionOutcome: "granted",
    actionReason: input.actionReason,
    policyUrl: input.policyUrl,
    provenanceId: input.provenanceId,
  });
}

export function buildRejectedClinicalWriteAuditRow(input: {
  eventType?: "update" | "delete-attempt";
  actorId: string;
  actorRole: "clinician" | "system";
  observation: Observation;
  actionReason: string;
  policyUrl?: string;
}): OsodAuditEventRecord {
  return buildOsodAuditEventRow({
    eventType: input.eventType ?? "update",
    actorId: normalizeReferenceId(input.actorId, "Practitioner"),
    actorRole: input.actorRole,
    patientReference: input.observation.subject?.reference,
    resourceType: "Observation",
    resourceId: input.observation.id,
    targetReference: observationReference(input.observation),
    actionOutcome: "denied",
    actionReason: input.actionReason,
    policyUrl: input.policyUrl,
  });
}

export function buildSignedObservationDeleteAttemptAuditRow(input: {
  actorId: string;
  observation: Observation;
}): OsodAuditEventRecord {
  return buildRejectedClinicalWriteAuditRow({
    eventType: "delete-attempt",
    actorId: input.actorId,
    actorRole: "clinician",
    observation: input.observation,
    actionReason:
      "Hard-delete rejected for signed clinical Observation; use entered-in-error transition with NULLIFY Provenance as the canonical retract path.",
    policyUrl: OSOD_CLINICAL_AMENDMENT_POLICY_URL,
  });
}

export function assertClinicianSessionMatches(input: {
  clinicianId: string;
  sessionPractitionerId?: string;
}): void {
  const clinicianId = normalizeReferenceId(input.clinicianId, "Practitioner");
  const sessionPractitionerId = input.sessionPractitionerId
    ? normalizeReferenceId(input.sessionPractitionerId, "Practitioner")
    : undefined;
  if (!sessionPractitionerId || sessionPractitionerId !== clinicianId) {
    throw new Error(
      "Mandate 8 boundary + ledger row 20: clinician attestation requires the clinician_id to match the calling user's Practitioner session.",
    );
  }
}

export function assertSignedObservationDeleteAllowed(observation: Observation): void {
  if (
    observation.status === "final" ||
    observation.status === "amended" ||
    observation.status === "corrected" ||
    observation.status === "entered-in-error"
  ) {
    throw new Error(
      "Hard-delete rejected for signed clinical Observation; use entered-in-error with NULLIFY Provenance.",
    );
  }
}

export function buildSignedClinicalProvenance(input: {
  id?: string;
  targetReferences: string[];
  clinicianId: string;
  recorded: string;
  intent: OsodClinicalProvenanceIntent;
  policyUrl: string;
  signatureDataBase64: string;
}): Provenance {
  const activity = activityForClinicalIntent(input.intent);
  assertProvenanceActivityCode(activity.code);
  const clinicianReference = normalizeReference(input.clinicianId, "Practitioner");
  return {
    ...buildProvenance({
      targetReferences: input.targetReferences,
      recorded: input.recorded,
      policyUrls: [input.policyUrl],
      activityCode: activity.code,
      activityDisplay: activity.display,
      agents: [
        {
          typeCode: "author",
          typeDisplay: "Author",
          roleConcepts: [clinicianRoleConcept()],
          whoReference: clinicianReference,
        },
      ],
      signatures: [
        {
          type: [
            {
              system: FHIR_AUTHOR_SIGNATURE_TYPE_SYSTEM,
              code: FHIR_AUTHOR_SIGNATURE_TYPE_CODE,
              display: FHIR_AUTHOR_SIGNATURE_TYPE_DISPLAY,
            },
          ],
          when: input.recorded,
          who: { reference: clinicianReference },
          sigFormat: OSOD_PROVENANCE_SIGNATURE_FORMAT,
          data: input.signatureDataBase64,
        },
      ],
    }),
    id: input.id ?? randomUUID(),
  };
}

function amendmentIntentForTargetStatus(
  targetStatus: AmendmentTargetStatus,
): OsodClinicalProvenanceIntent {
  switch (targetStatus) {
    case "amended":
      return "post-final-amendment";
    case "corrected":
      return "post-final-correction";
    case "entered-in-error":
      return "should-never-have-existed";
  }
}

function statusPatchOperations(
  observation: Observation,
  targetStatus: ObservationStatus,
): JsonPatchOperation[] {
  return [
    { op: "test", path: "/status", value: observation.status },
    { op: "replace", path: "/status", value: targetStatus },
  ];
}

function notePatchOperation(
  observation: Observation,
  note: NonNullable<Observation["note"]>[number],
): JsonPatchOperation {
  if (observation.note?.length) {
    return { op: "add", path: "/note/-", value: note };
  }
  return { op: "add", path: "/note", value: [note] };
}

function jsonPatchBinaryResource(operations: JsonPatchOperation[]): Binary {
  return {
    resourceType: "Binary",
    contentType: "application/json-patch+json",
    data: Buffer.from(JSON.stringify(operations), "utf8").toString("base64"),
  };
}

function transactionBundle(entries: NonNullable<Bundle["entry"]>): Bundle {
  return {
    resourceType: "Bundle",
    type: "transaction",
    entry: entries,
  };
}

function versionAwareRequest(
  resource: Resource,
  method: "PATCH" | "PUT",
  url: string,
): NonNullable<NonNullable<Bundle["entry"]>[number]["request"]> {
  return {
    method,
    url,
    ...(resource.meta?.versionId ? { ifMatch: `W/"${resource.meta.versionId}"` } : {}),
  };
}

function observationStatusBefore(observation: Observation): ObservationStatus {
  if (!isObservationStatus(observation.status)) {
    throw new Error(`Observation/${observation.id ?? "(unknown)"} has invalid status ${observation.status}.`);
  }
  return observation.status;
}

function observationReference(observation: Observation): string {
  if (!observation.id) {
    throw new Error("Observation id is required for attestation/amendment transaction.");
  }
  return `Observation/${observation.id}`;
}

function clinicianRoleConcept(): CodeableConcept {
  return {
    text: "clinician",
    coding: [
      {
        system: OSOD_ROLE_CODE_SYSTEM,
        code: "clinician",
        display: "clinician",
      },
    ],
  };
}

function normalizeReference(value: string, resourceType: string): string {
  return value.startsWith(`${resourceType}/`) ? value : `${resourceType}/${value}`;
}

function normalizeReferenceId(value: string, resourceType: string): string {
  return value.startsWith(`${resourceType}/`) ? value.slice(resourceType.length + 1) : value;
}

function stringList(value: string | string[] | undefined): string[] {
  if (!value) {
    return [];
  }
  return Array.isArray(value) ? value : [value];
}
