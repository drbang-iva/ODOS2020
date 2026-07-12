import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildMedicationRequest,
  OSOD_CONTROLLED_SUBSTANCE_FLAG_EXTENSION_URL,
  OSOD_TRANSMISSION_METHOD_EXTENSION_URL,
} from "../src/fhir/medicationOrder.js";

test("buildMedicationRequest captures the prescription, linked diagnosis, and dispensing details", () => {
  const request = buildMedicationRequest({
    patientReference: "Patient/p1",
    practitionerReference: "Practitioner/dr1",
    encounterReference: "Encounter/e1",
    medicationText: "Prednisolone acetate 1%",
    dosageText: "1 drop OU four times daily",
    quantity: "5 mL",
    refills: 1,
    daysSupply: 30,
    routeText: "Ophthalmic",
    reasonReference: "Condition/c1",
    pharmacyText: "Main Street Pharmacy · 555-0100",
    transmissionMethod: "printed",
    authoredOn: "2026-07-11T14:00:00.000Z",
  });

  assert.equal(request.resourceType, "MedicationRequest");
  assert.equal(request.status, "active");
  assert.equal(request.intent, "order");
  assert.deepEqual(request.medicationCodeableConcept, { text: "Prednisolone acetate 1%" });
  assert.equal(request.medicationCodeableConcept.coding, undefined);
  assert.equal(request.subject.reference, "Patient/p1");
  assert.equal(request.requester?.reference, "Practitioner/dr1");
  assert.equal(request.encounter?.reference, "Encounter/e1");
  assert.equal(request.dosageInstruction?.[0]?.text, "1 drop OU four times daily");
  assert.equal(request.dosageInstruction?.[0]?.route?.text, "Ophthalmic");
  assert.equal(request.dispenseRequest?.quantity?.unit, "5 mL");
  assert.equal(request.dispenseRequest?.numberOfRepeatsAllowed, 1);
  assert.deepEqual(request.dispenseRequest?.expectedSupplyDuration, { value: 30, unit: "days" });
  assert.equal(request.dispenseRequest?.performer?.display, "Main Street Pharmacy · 555-0100");
  assert.equal(request.reasonReference?.[0]?.reference, "Condition/c1");
  assert.equal(request.reasonCode, undefined);
  assert.equal(
    request.extension?.find((extension) => extension.url === OSOD_TRANSMISSION_METHOD_EXTENSION_URL)?.valueCode,
    "printed",
  );
  assert.equal(
    request.extension?.find((extension) => extension.url === OSOD_CONTROLLED_SUBSTANCE_FLAG_EXTENSION_URL)?.valueBoolean,
    false,
  );
});

test("buildMedicationRequest uses free-text indication and records a controlled phoned-in order", () => {
  const request = buildMedicationRequest({
    patientReference: "Patient/p1",
    practitionerReference: "Practitioner/dr1",
    encounterReference: "Encounter/e1",
    medicationText: "Test controlled medicine",
    dosageText: "Take as directed",
    indicationText: "Postoperative pain",
    isControlledSubstance: true,
    transmissionMethod: "phoned-in",
  });

  assert.deepEqual(request.reasonCode, [{ text: "Postoperative pain" }]);
  assert.equal(request.reasonReference, undefined);
  assert.equal(
    request.extension?.find((extension) => extension.url === OSOD_CONTROLLED_SUBSTANCE_FLAG_EXTENSION_URL)?.valueBoolean,
    true,
  );
});
