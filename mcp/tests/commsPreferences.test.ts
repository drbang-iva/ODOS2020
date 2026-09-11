import assert from "node:assert/strict";
import { test } from "node:test";
import type { Patient } from "@medplum/fhirtypes";
import * as gate from "../src/comms/suppression-gate.js";
const metadata = { recordedAt: "2026-09-11T15:00:00Z", setBy: { reference: "Practitioner/staff" }, surface: "staff-demographics" as const };
const patient: Patient = { resourceType: "Patient", id: "synthetic" };
test("preference defaults remain implicit and explicit cells retain attribution", () => {
  assert.equal(gate.effectiveCommsPreferences(patient, {}).education.sms.value, true);
  assert.equal(gate.effectiveCommsPreferences(patient, {})["marketing-promo"].sms.value, false);
  const updated = gate.replaceCommsPreferenceCells(patient, [{ purpose: "education", channel: "sms", allowed: false }], metadata);
  assert.deepEqual(gate.effectiveCommsPreferences(updated, {}).education.sms, { value: false, source: "explicit", ...metadata });
  assert.equal(patient.extension, undefined);
});
test("malformed and duplicate preference extensions refuse resolution", () => {
  const updated = gate.replaceCommsPreferenceCells(patient, [{ purpose: "education", channel: "sms", allowed: false }], metadata);
  const duplicate = { ...updated, extension: [...updated.extension!, ...updated.extension!] };
  assert.throws(() => gate.effectiveCommsPreferences(duplicate, {}), /preference/);
  updated.extension![0].extension = updated.extension![0].extension!.filter(e => e.url !== "allowed");
  assert.throws(() => gate.effectiveCommsPreferences(updated, {}), /preference/);
});
