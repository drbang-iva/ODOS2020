import assert from "node:assert/strict";
import { test } from "node:test";
import type { Bundle, Encounter, Patient } from "@medplum/fhirtypes";
import {
  buildEncounterStatusPatchBundle,
  buildStartEncounterCreateBundle,
} from "../../ui/src/lib/encounter-bundles.js";

test("live scoped-clinician exam-start RBAC matrix", { timeout: 90_000 }, async (t) => {
  const clinicianToken = process.env.OSOD_TEST_CLINICIAN_TOKEN;
  const otherClinicianToken = process.env.OSOD_TEST_OTHER_CLINICIAN_TOKEN;
  const patientId = process.env.OSOD_TEST_PATIENT_ID;
  if (!clinicianToken || !otherClinicianToken || !patientId) {
    t.skip(
      "OSOD_TEST_CLINICIAN_TOKEN, OSOD_TEST_OTHER_CLINICIAN_TOKEN, and " +
      "OSOD_TEST_PATIENT_ID are required for the operator-assisted live RBAC gate.",
    );
    return;
  }

  const fhirBase = `${(process.env.MEDPLUM_BASE_URL ?? "http://localhost:8103").replace(/\/$/, "")}/fhir/R4`;
  const coreBase = (process.env.OSOD_CORE_BASE_URL ?? "http://localhost:3333").replace(/\/$/, "");
  const patientReference = `Patient/${patientId}`;
  const clinicianHeaders = fhirHeaders(clinicianToken);

  const firstAssignment = await fetch(
    `${coreBase}/clinical-graph/patients/${patientId}/assign-provider`,
    { method: "POST", headers: clinicianHeaders },
  );
  assert.equal(firstAssignment.status, 200, await firstAssignment.clone().text());
  const firstAssignmentBody = await firstAssignment.json() as {
    practitionerReference: string;
    membershipUpdated: boolean;
  };
  assert.equal(firstAssignmentBody.membershipUpdated, true);

  const secondAssignment = await fetch(
    `${coreBase}/clinical-graph/patients/${patientId}/assign-provider`,
    { method: "POST", headers: clinicianHeaders },
  );
  assert.equal(secondAssignment.status, 200, await secondAssignment.clone().text());
  const secondAssignmentBody = await secondAssignment.json() as {
    assigned: boolean;
    patientUpdated: boolean;
    membershipUpdated: boolean;
  };
  assert.equal(secondAssignmentBody.assigned, false);
  assert.equal(secondAssignmentBody.patientUpdated, false);
  assert.equal(secondAssignmentBody.membershipUpdated, false);

  const patientResponse = await fetch(`${fhirBase}/${patientReference}`, {
    headers: clinicianHeaders,
  });
  assert.equal(patientResponse.status, 200, await patientResponse.clone().text());
  const patient = await patientResponse.json() as Patient;
  assert.equal(
    patient.generalPractitioner?.filter(
      (reference) => reference.reference === firstAssignmentBody.practitionerReference,
    ).length,
    1,
  );

  const preliminary = await createObservation(
    fhirBase,
    clinicianHeaders,
    patientReference,
    "preliminary",
  );
  assert.equal(preliminary.status, 201, await preliminary.text());
  const final = await createObservation(
    fhirBase,
    clinicianHeaders,
    patientReference,
    "final",
  );
  assert.equal(final.status, 403, await final.text());

  const encounterResponse = await fetch(`${fhirBase}/Encounter`, {
    method: "POST",
    headers: clinicianHeaders,
    body: JSON.stringify(encounterResource(patientReference)),
  });
  assert.equal(encounterResponse.status, 201, await encounterResponse.clone().text());
  const encounter = await encounterResponse.json() as Encounter;
  assert.ok(encounter.id);

  const provenanceResponse = await fetch(`${fhirBase}/Provenance`, {
    method: "POST",
    headers: clinicianHeaders,
    body: JSON.stringify({
      resourceType: "Provenance",
      target: [
        { reference: `Encounter/${encounter.id}` },
        { reference: patientReference },
      ],
      recorded: new Date().toISOString(),
      agent: [{ who: { reference: firstAssignmentBody.practitionerReference } }],
    }),
  });
  assert.equal(provenanceResponse.status, 201, await provenanceResponse.text());

  const startResponse = await fetch(fhirBase, {
    method: "POST",
    headers: clinicianHeaders,
    body: JSON.stringify(buildStartEncounterCreateBundle({
      patientId,
      now: new Date().toISOString(),
      practitionerReference: firstAssignmentBody.practitionerReference,
    })),
  });
  assert.equal(startResponse.status, 200, await startResponse.clone().text());
  const startBundle = await startResponse.json() as Bundle;
  const startedEncounterId = startBundle.entry?.[0]?.response?.location?.match(/^Encounter\/([^/]+)/)?.[1];
  assert.ok(startedEncounterId);

  const statusResponse = await fetch(fhirBase, {
    method: "POST",
    headers: clinicianHeaders,
    body: JSON.stringify(buildEncounterStatusPatchBundle({
      encounterId: startedEncounterId,
      patientId,
      recorded: new Date().toISOString(),
      operatorDisplay: "OSOD live clinician RBAC gate",
      practitionerReference: firstAssignmentBody.practitionerReference,
      ops: [{ op: "replace", path: "/status", value: "in-progress" }],
    })),
  });
  assert.equal(statusResponse.status, 200, await statusResponse.text());

  const otherHeaders = fhirHeaders(otherClinicianToken);
  const otherRead = await fetch(`${fhirBase}/${patientReference}`, { headers: otherHeaders });
  assert.equal(otherRead.status, 404, await otherRead.text());
  const otherWrite = await createObservation(
    fhirBase,
    otherHeaders,
    patientReference,
    "preliminary",
  );
  assert.equal(otherWrite.status, 403, await otherWrite.text());
});

function fhirHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/fhir+json",
    Accept: "application/fhir+json",
  };
}

function createObservation(
  fhirBase: string,
  headers: Record<string, string>,
  patientReference: string,
  status: "preliminary" | "final",
): Promise<Response> {
  return fetch(`${fhirBase}/Observation`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      resourceType: "Observation",
      status,
      code: { text: `OSOD live RBAC ${status} create gate` },
      subject: { reference: patientReference },
    }),
  });
}

function encounterResource(patientReference: string): Encounter {
  return {
    resourceType: "Encounter",
    status: "arrived",
    class: {
      system: "http://terminology.hl7.org/CodeSystem/v3-ActCode",
      code: "AMB",
    },
    subject: { reference: patientReference },
  };
}
