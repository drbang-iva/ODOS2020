import assert from "node:assert/strict";
import { test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { MedicationRequest } from "@medplum/fhirtypes";
import {
  EMPTY_PRESCRIPTION_DRAFT,
  PrescriptionEditor,
  formatDate,
  isControlledSubstanceDrug,
  mergeMedicationRequestUpdate,
  withDrugText,
} from "../src/components/charting/PrescriptionSection";

const NOOP = () => undefined;

test("PrescriptionEditor exposes every prescription field as a directly typeable control", () => {
  const html = renderToStaticMarkup(
    <PrescriptionEditor
      draft={EMPTY_PRESCRIPTION_DRAFT}
      conditions={[]}
      onChange={NOOP}
      onSave={NOOP}
    />,
  );

  for (const label of [
    "Drug",
    "Sig",
    "Quantity",
    "Refills",
    "Days supply",
    "Route",
    "Assessment diagnosis",
    "Indication fallback",
    "Pharmacy name and phone",
  ]) {
    assert.match(html, new RegExp(`aria-label="${label}"`));
  }
  assert.match(html, /type="number" min="0"[^>]*aria-label="Refills"|aria-label="Refills"[^>]*type="number"/);
  assert.match(html, /type="number" min="1"[^>]*aria-label="Days supply"|aria-label="Days supply"[^>]*type="number"/);
  assert.match(html, /value="printed"/);
  assert.match(html, /value="phoned-in"/);
  assert.doesNotMatch(html, /Send electronically|electronically-sent/);
  assert.doesNotMatch(html, /role="alert"/);
});

test("a test-populated controlled match shows the banner and forces phoned-in transmission", () => {
  const terms = ["test-controlled"];
  const controlledDraft = withDrugText(EMPTY_PRESCRIPTION_DRAFT, "Test-Controlled 5 mg", terms);
  const html = renderToStaticMarkup(
    <PrescriptionEditor
      draft={controlledDraft}
      conditions={[]}
      controlledSubstanceTerms={terms}
      onChange={NOOP}
      onSave={NOOP}
    />,
  );

  assert.equal(isControlledSubstanceDrug("TEST-CONTROLLED 5 mg", terms), true);
  assert.equal(controlledDraft.transmissionMethod, "phoned-in");
  assert.match(html, /Controlled substance — WENO e-Rx not available for this drug\. Call it in to the pharmacy\./);
  assert.match(html, /value="printed"[^>]*disabled=""|disabled=""[^>]*value="printed"/);
  assert.match(html, /value="phoned-in"[^>]*checked=""|checked=""[^>]*value="phoned-in"/);
});

test("saving an edit preserves an on-hold prescription status and original requester", () => {
  const existing: MedicationRequest = {
    resourceType: "MedicationRequest",
    id: "rx-1",
    status: "on-hold",
    intent: "order",
    subject: { reference: "Patient/patient-1" },
    medicationCodeableConcept: { text: "Original medication" },
    requester: { reference: "Practitioner/original-prescriber" },
  };
  const edited: MedicationRequest = {
    resourceType: "MedicationRequest",
    status: "active",
    intent: "order",
    subject: { reference: "Patient/patient-1" },
    medicationCodeableConcept: { text: "Edited medication" },
    requester: { reference: "Practitioner/current-user" },
  };

  const update = mergeMedicationRequestUpdate(existing, edited);

  assert.equal(update.medicationCodeableConcept?.text, "Edited medication");
  assert.equal(update.status, "on-hold");
  assert.deepEqual(update.requester, { reference: "Practitioner/original-prescriber" });
});

test("formatDate safely renders malformed and absent authoredOn values", () => {
  assert.equal(formatDate("not-a-date"), "not-a-date");
  assert.equal(formatDate(undefined), "Date unknown");
});
