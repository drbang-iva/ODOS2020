import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { test } from "node:test";
import type { Binary, Encounter, Observation, Provenance } from "@medplum/fhirtypes";
import {
  OSOD_CLINICAL_AMENDMENT_POLICY_URL,
  OSOD_CLINICAL_ATTESTATION_POLICY_URL,
} from "../../policy/attestation-policy-urls.js";
import { OSOD_APPEND_OBSERVATION_RELATIONSHIP_FIELD } from "../../policy/observation-relationship-types.js";
import { assertProvenanceActivityCode } from "../../policy/provenance-activity-map.js";
import {
  buildAuditEventProjection,
  buildOsodAuditEventRow,
  ocrStyleAuditQuery,
} from "../src/authz/osodAudit.js";
import { verifyRestoreIntegrity } from "../src/authz/restoreIntegrity.js";
import {
  appendObservationContextSchema,
  assertBinarySecurityContextForEncounter,
  assertSignedObservationDeleteAllowed,
  buildAmendmentTransaction,
  buildAppendObservationTransaction,
  buildAttestationTransaction,
  buildClinicalWriteAuditRow,
  buildRejectedClinicalWriteAuditRow,
  buildScribeDraftObservation,
  buildSignedObservationDeleteAttemptAuditRow,
  scribeWriteObservationSchema,
} from "../src/fhir/scribeAttestation.js";

const ENCOUNTER: Encounter = {
  resourceType: "Encounter",
  id: "enc-1",
  status: "in-progress",
  class: { system: "http://terminology.hl7.org/CodeSystem/v3-ActCode", code: "AMB" },
  subject: { reference: "Patient/patient-1" },
};

const PRELIMINARY_OBSERVATION: Observation = {
  resourceType: "Observation",
  id: "obs-prelim",
  meta: { versionId: "7" },
  status: "preliminary",
  code: { text: "Scribe draft" },
  subject: { reference: "Patient/patient-1" },
  encounter: { reference: "Encounter/enc-1" },
};

const FINAL_OBSERVATION: Observation = {
  ...PRELIMINARY_OBSERVATION,
  id: "obs-final",
  status: "final",
};

test("Mandate 7b: scribe-write schema accepts text and Binary references, rejects audio bytes and direct final status", () => {
  const valid = scribeWriteObservationSchema.parse({
    patient_id: "patient-1",
    encounter_id: "enc-1",
    intended_observation_type: "IOP note",
    text: "Applanation pressure 14 OD and 15 OS.",
    scribe_id: "scribe-1",
    audio_binary_id: "Binary/audio-1",
  });
  assert.equal(valid.text.includes("Applanation"), true);

  assert.equal(
    scribeWriteObservationSchema.safeParse({
      patient_id: "patient-1",
      encounter_id: "enc-1",
      intended_observation_type: "IOP note",
      text: "audio transcript",
      scribe_id: "scribe-1",
      audio_bytes: "AA==",
    }).success,
    false,
  );
  assert.equal(
    scribeWriteObservationSchema.safeParse({
      patient_id: "patient-1",
      encounter_id: "enc-1",
      intended_observation_type: "IOP note",
      text: "audio transcript",
      scribe_id: "scribe-1",
      status: "final",
    }).success,
    false,
  );
});

test("scribe draft builder emits preliminary Observation with scribe as Observation.performer", () => {
  const observation = buildScribeDraftObservation(
    {
      patient_id: "patient-1",
      encounter_id: "enc-1",
      intended_observation_type: "Refraction draft",
      text: "Manifest refraction draft text.",
      scribe_id: "scribe-1",
      ui_state: "pending-clinician-review",
    },
    ENCOUNTER,
  );

  assert.equal(observation.status, "preliminary");
  assert.equal(observation.performer?.[0]?.reference, "Practitioner/scribe-1");
  assert.equal(observation.note?.[0]?.text, "Manifest refraction draft text.");
});

test("scribe audio Binary verification reads a Binary id and requires Patient securityContext", () => {
  const binary: Binary = {
    resourceType: "Binary",
    id: "audio-1",
    contentType: "audio/wav",
    securityContext: { reference: "Patient/patient-1" },
  };
  assert.doesNotThrow(() => assertBinarySecurityContextForEncounter(binary, ENCOUNTER));

  assert.throws(
    () =>
      assertBinarySecurityContextForEncounter(
        { ...binary, securityContext: { reference: "Patient/other" } },
        ENCOUNTER,
      ),
    /Binary\.securityContext/,
  );
});

test("clinician attestation transaction patches preliminary to final and creates signed CREATE Provenance", () => {
  const transaction = buildAttestationTransaction({
    observation: PRELIMINARY_OBSERVATION,
    clinicianId: "clinician-1",
    signatureDataBase64: signature("attest"),
    recorded: "2026-04-30T12:00:00.000Z",
    provenanceId: "prov-attest",
  });
  const provenance = transaction.provenance;

  assert.equal(transaction.bundle.type, "transaction");
  assert.equal(transaction.bundle.entry?.[0]?.request?.method, "PATCH");
  assert.equal(transaction.bundle.entry?.[1]?.request?.method, "PUT");
  assert.equal(provenance.activity?.coding?.[0]?.code, "CREATE");
  assert.equal(provenance.policy?.[0], OSOD_CLINICAL_ATTESTATION_POLICY_URL);
  assert.equal(provenance.agent[0].who.reference, "Practitioner/clinician-1");
  assert.equal(provenance.agent[0].role?.[0]?.coding?.[0]?.code, "clinician");
  assert.equal(provenance.signature?.[0]?.type?.[0]?.code, "1.2.840.10065.1.12.1.1");
  assert.equal(provenance.signature?.[0]?.sigFormat, "application/jose");
  assert.equal(provenance.signature?.[0]?.data, signature("attest"));

  const integrity = verifyRestoreIntegrity({
    manifestAuditSnapshot: { count: 0, projectionQueueDrained: true },
    restoredAuditRows: [],
    provenanceSamples: [provenance],
    restoredBinaries: [],
    auditEvents: [],
    accessPolicyRoundTripPassed: true,
  });
  assert.equal(integrity.checks.find((check) => check.name.includes("signature"))?.passed, true);
});

test("attestation audit row carries clinician attribution, policy URL, and Provenance id", () => {
  const row = buildClinicalWriteAuditRow({
    eventType: "update",
    actorId: "clinician-1",
    actorRole: "clinician",
    observation: PRELIMINARY_OBSERVATION,
    provenanceId: "prov-attest",
    policyUrl: OSOD_CLINICAL_ATTESTATION_POLICY_URL,
  });
  const auditEvent = buildAuditEventProjection(row);

  assert.equal(row.eventType, "update");
  assert.equal(row.actorId, "clinician-1");
  assert.equal(row.actorRole, "clinician");
  assert.equal(row.patientId, "patient-1");
  assert.equal(row.provenanceId, "prov-attest");
  assert.equal(auditEvent.outcome, "0");
  assert.equal(auditEvent.agent[0].policy?.[0], OSOD_CLINICAL_ATTESTATION_POLICY_URL);
});

test("Mandate 8 negative 5: failed attestation transaction has serious-failure audit row shape", () => {
  const row = buildRejectedClinicalWriteAuditRow({
    actorId: "clinician-1",
    actorRole: "clinician",
    observation: PRELIMINARY_OBSERVATION,
    actionReason: "attestation failed: Provenance create rejected; transaction rolled back",
    policyUrl: OSOD_CLINICAL_ATTESTATION_POLICY_URL,
  });
  const auditEvent = buildAuditEventProjection(row);

  assert.equal(row.actionOutcome, "denied");
  assert.equal(auditEvent.outcome, "8");
  assert.match(row.actionReason ?? "", /transaction rolled back/);
});

test("amendment transactions map target statuses to canonical Provenance.activity codes", () => {
  const amended = buildAmendmentTransaction({
    observation: FINAL_OBSERVATION,
    clinicianId: "clinician-1",
    targetStatus: "amended",
    amendmentText: "Added follow-up context.",
    signatureDataBase64: signature("amend"),
    recorded: "2026-04-30T12:01:00.000Z",
    provenanceId: "prov-amend",
  });
  assert.equal(amended.activityCode, "UPDATE");
  assert.equal(amended.provenance.activity?.coding?.[0]?.code, "UPDATE");

  const revised = buildAmendmentTransaction({
    observation: FINAL_OBSERVATION,
    clinicianId: "clinician-1",
    targetStatus: "corrected",
    amendmentText: "Corrected transcribed measurement.",
    signatureDataBase64: signature("revise"),
    recorded: "2026-04-30T12:02:00.000Z",
    provenanceId: "prov-revise",
  });
  assert.equal(revised.activityCode, "REVISE");

  const nullified = buildAmendmentTransaction({
    observation: FINAL_OBSERVATION,
    clinicianId: "clinician-1",
    targetStatus: "entered-in-error",
    amendmentText: "Wrong patient.",
    signatureDataBase64: signature("nullify"),
    recorded: "2026-04-30T12:03:00.000Z",
    provenanceId: "prov-nullify",
  });
  assert.equal(nullified.activityCode, "NULLIFY");
  assert.equal(nullified.provenance.policy?.[0], OSOD_CLINICAL_AMENDMENT_POLICY_URL);
});

test("successive amendments create distinct Provenance ids, timestamps, and signatures", () => {
  const first = buildAmendmentTransaction({
    observation: { ...FINAL_OBSERVATION, id: "obs-amended", status: "amended" },
    clinicianId: "clinician-1",
    targetStatus: "amended",
    amendmentText: "First amendment.",
    signatureDataBase64: signature("amend-1"),
    recorded: "2026-04-30T12:04:00.000Z",
    provenanceId: "prov-amend-1",
  }).provenance;
  const second = buildAmendmentTransaction({
    observation: { ...FINAL_OBSERVATION, id: "obs-amended", status: "amended" },
    clinicianId: "clinician-1",
    targetStatus: "amended",
    amendmentText: "Second amendment.",
    signatureDataBase64: signature("amend-2"),
    recorded: "2026-04-30T12:05:00.000Z",
    provenanceId: "prov-amend-2",
  }).provenance;

  assert.notEqual(first.id, second.id);
  assert.notEqual(first.recorded, second.recorded);
  assert.notEqual(first.signature?.[0]?.data, second.signature?.[0]?.data);
});

test("APPEND creates a new final Observation linked by derivedFrom and leaves original final status unchanged", () => {
  const transaction = buildAppendObservationTransaction({
    sourceObservation: FINAL_OBSERVATION,
    appendInput: appendObservationContextSchema.parse({
      source_observation_id: "obs-final",
      patient_id: "patient-1",
      encounter_id: "enc-1",
      intended_observation_type: "Additional clinical context",
      text: "Added later correlation note.",
      clinician_id: "clinician-1",
      signature_data_base64: signature("append"),
      recorded_at: "2026-04-30T12:06:00.000Z",
    }),
    appendedObservationId: "obs-append",
    provenanceId: "prov-append",
  });

  assert.equal(FINAL_OBSERVATION.status, "final");
  assert.equal(transaction.observation.status, "final");
  assert.equal(transaction.observation[OSOD_APPEND_OBSERVATION_RELATIONSHIP_FIELD]?.[0]?.reference, "Observation/obs-final");
  assert.equal(transaction.provenance.activity?.coding?.[0]?.code, "APPEND");
});

test("Mandate 8 negative 6: non-ValueSet Provenance activity is rejected with ledger row 21 message", () => {
  const invalidActivity = ["cor", "rect"].join("");
  assert.throws(
    () => assertProvenanceActivityCode(invalidActivity),
    /ledger row 21: v3-DataOperation only/,
  );
});

test("Mandate 8 negative 7: signed Observation hard-delete is rejected with canonical retract path audit row", () => {
  assert.throws(() => assertSignedObservationDeleteAllowed(FINAL_OBSERVATION), /Hard-delete rejected/);
  const row = buildSignedObservationDeleteAttemptAuditRow({
    actorId: "clinician-1",
    observation: FINAL_OBSERVATION,
  });
  const auditEvent = buildAuditEventProjection(row);

  assert.equal(row.eventType, "delete-attempt");
  assert.match(row.actionReason ?? "", /entered-in-error.*NULLIFY Provenance/);
  assert.equal(auditEvent.outcome, "12");
});

test("OCR-style 90-day query surfaces v0.5c audit rows with full attribution", () => {
  const rows = [
    buildOsodAuditEventRow({
      eventType: "read",
      eventTime: "2026-04-01T12:00:00.000Z",
      actorId: "front-desk-1",
      actorRole: "front-desk",
      patientId: "patient-1",
      actionOutcome: "granted",
    }),
    buildClinicalWriteAuditRow({
      eventType: "create",
      actorId: "scribe-1",
      actorRole: "scribe",
      observation: PRELIMINARY_OBSERVATION,
      actionReason: "scribe-draft preliminary",
    }),
    buildClinicalWriteAuditRow({
      eventType: "update",
      actorId: "clinician-1",
      actorRole: "clinician",
      observation: FINAL_OBSERVATION,
      provenanceId: "prov-amend",
      policyUrl: OSOD_CLINICAL_AMENDMENT_POLICY_URL,
      actionReason: "UPDATE",
    }),
  ];

  const result = ocrStyleAuditQuery(rows, {
    patientId: "patient-1",
    from: "2026-01-30T00:00:00.000Z",
    to: "2026-04-30T23:59:59.999Z",
  });

  assert.equal(result.length, 3);
  assert.equal(result.some((row) => row.actorRole === "scribe"), true);
  assert.equal(result.some((row) => row.provenanceId === "prov-amend"), true);
  assert.equal(result.some((row) => row.policyUrl === OSOD_CLINICAL_AMENDMENT_POLICY_URL), true);
});

function signature(label: string): string {
  return Buffer.from(`signature:${label}`).toString("base64");
}
