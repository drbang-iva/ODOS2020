import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildMedicationRequest,
  NCPDP_PROVIDER_IDENTIFIER_SYSTEM,
  ODOS_CONTROLLED_SUBSTANCE_FLAG_EXTENSION_URL,
  ODOS_TRANSMISSION_METHOD_EXTENSION_URL,
  ODOS_WENO_DRUG_DB_CODE_QUALIFIER_EXTENSION_URL,
  ODOS_WENO_QUANTITY_UNIT_OF_MEASURE_CODE_EXTENSION_URL,
  RXNORM_CODE_SYSTEM,
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
    isControlledSubstance: false,
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
    request.extension?.find((extension) => extension.url === ODOS_TRANSMISSION_METHOD_EXTENSION_URL)?.valueCode,
    "printed",
  );
  assert.equal(
    request.extension?.find((extension) => extension.url === ODOS_CONTROLLED_SUBSTANCE_FLAG_EXTENSION_URL)?.valueBoolean,
    false,
  );
});

test("buildMedicationRequest omits an unknown controlled-substance flag", () => {
  const request = buildMedicationRequest({
    patientReference: "Patient/p1",
    medicationText: "Unknown WENO medication",
    transmissionMethod: "electronically-sent",
  });

  assert.equal(
    request.extension?.find((extension) => extension.url === ODOS_CONTROLLED_SUBSTANCE_FLAG_EXTENSION_URL),
    undefined,
  );
  assert.equal(
    request.extension?.find((extension) => extension.url === ODOS_TRANSMISSION_METHOD_EXTENSION_URL)?.valueCode,
    "electronically-sent",
  );
});

test("buildMedicationRequest adds RxNorm coding metadata and an NCPDP performer identifier without replacing display text", () => {
  const request = buildMedicationRequest({
    patientReference: "Patient/p1",
    medicationText: "Latanoprost 0.005% ophthalmic solution",
    drugDbCode: "196502",
    drugDbCodeQualifier: "SCD",
    quantityUnitOfMeasureCode: "C48542",
    pharmacyText: "Greenwood Pharmacy · 123 Main Street, Greenwood, SC 29646",
    pharmacyNcpdpId: "4222222",
    transmissionMethod: "printed",
    authoredOn: "2026-07-18T12:00:00.000Z",
  });

  assert.equal(request.medicationCodeableConcept?.text, "Latanoprost 0.005% ophthalmic solution");
  assert.deepEqual(request.medicationCodeableConcept?.coding, [{
    system: RXNORM_CODE_SYSTEM,
    code: "196502",
    display: "Latanoprost 0.005% ophthalmic solution",
    extension: [
      { url: ODOS_WENO_DRUG_DB_CODE_QUALIFIER_EXTENSION_URL, valueCode: "SCD" },
      { url: ODOS_WENO_QUANTITY_UNIT_OF_MEASURE_CODE_EXTENSION_URL, valueCode: "C48542" },
    ],
  }]);
  assert.deepEqual(request.dispenseRequest?.performer, {
    identifier: { system: NCPDP_PROVIDER_IDENTIFIER_SYSTEM, value: "4222222" },
    display: "Greenwood Pharmacy · 123 Main Street, Greenwood, SC 29646",
  });
});

test("buildMedicationRequest preserves the prior freeform-only output byte for byte", () => {
  const request = buildMedicationRequest({
    patientReference: "Patient/p1",
    medicationText: "Compounded ophthalmic medication",
    pharmacyText: "Independent Pharmacy · 555-0100",
    transmissionMethod: "printed",
    authoredOn: "2026-07-18T12:00:00.000Z",
  });

  assert.equal(JSON.stringify(request), JSON.stringify({
    resourceType: "MedicationRequest",
    status: "active",
    intent: "order",
    medicationCodeableConcept: { text: "Compounded ophthalmic medication" },
    subject: { reference: "Patient/p1" },
    authoredOn: "2026-07-18T12:00:00.000Z",
    dispenseRequest: { performer: { display: "Independent Pharmacy · 555-0100" } },
    extension: [{
      url: ODOS_TRANSMISSION_METHOD_EXTENSION_URL,
      valueCode: "printed",
    }],
  }));
});

test("buildMedicationRequest rejects partial coded-drug metadata", () => {
  assert.throws(
    () => buildMedicationRequest({
      patientReference: "Patient/p1",
      medicationText: "Latanoprost",
      drugDbCode: "196502",
      transmissionMethod: "printed",
    }),
    /requires drugDbCode, drugDbCodeQualifier, and quantityUnitOfMeasureCode together/,
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
    request.extension?.find((extension) => extension.url === ODOS_CONTROLLED_SUBSTANCE_FLAG_EXTENSION_URL)?.valueBoolean,
    true,
  );
});
