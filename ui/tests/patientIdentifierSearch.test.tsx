import assert from "node:assert/strict";
import { test } from "node:test";
import type { Bundle, Patient } from "@medplum/fhirtypes";
import {
  EYEFINITY_EHR_PATIENT_ID_SYSTEM,
  EYEFINITY_EPM_PATIENT_ID_SYSTEM,
  ODOS_MRN_SYSTEM,
  formatOdosMrn,
} from "../src/lib/patient-identity";
import { patientPickerOption, searchPatients } from "../src/scenes/PatientPicker";

const mrn = formatOdosMrn(410_001);
const patients: Patient[] = [
  patient("native", ODOS_MRN_SYSTEM, mrn),
  patient("ehr", EYEFINITY_EHR_PATIENT_ID_SYSTEM, "969"),
  patient("epm", EYEFINITY_EPM_PATIENT_ID_SYSTEM, "6499570"),
];

test("name-looking patient search preserves the existing name query", async () => {
  const calls: Record<string, string>[] = [];
  const result = await searchPatients("Alex Rivera", {
    search: async (_resourceType, params) => {
      calls.push(params as Record<string, string>);
      return bundle([patients[0]]);
    },
  } as never);
  assert.deepEqual(calls, [{ name: "Alex Rivera", _count: "50" }]);
  assert.deepEqual(result.map((patient) => patient.id), ["native"]);
});

for (const [label, query, expectedId, system] of [
  ["ODOS MRN", mrn, "native", ODOS_MRN_SYSTEM],
  ["legacy EHR ID", "969", "ehr", EYEFINITY_EHR_PATIENT_ID_SYSTEM],
  ["legacy EPM ID", "6499570", "epm", EYEFINITY_EPM_PATIENT_ID_SYSTEM],
] as const) {
  test(`number-looking patient search resolves ${label} with its exact identifier system`, async () => {
    const calls: Record<string, string>[] = [];
    const result = await searchPatients(query, {
      search: async (_resourceType, params) => {
        const typed = params as Record<string, string>;
        calls.push(typed);
        const row = patients.find((candidate) =>
          candidate.identifier?.some((identifier) => typed.identifier === `${identifier.system}|${identifier.value}`),
        );
        return bundle(row ? [row] : []);
      },
    } as never);
    assert.equal(calls.length, 3);
    assert.ok(calls.some((call) => call.identifier === `${system}|${query}`));
    assert.deepEqual(result.map((patient) => patient.id), [expectedId]);
    assert.match(
      patientPickerOption(result[0], "Open", query)[0].description ?? "",
      new RegExp(`Matched ${label.replace("legacy", "legacy")} ${query}`, "i"),
    );
  });
}

test("identifier result display identifies legacy matches and shows native MRN on name matches", () => {
  assert.match(patientPickerOption(patients[1], "Open", "969")[0].description ?? "", /Matched legacy EHR ID 969/);
  assert.match(patientPickerOption(patients[2], "Open", "6499570")[0].description ?? "", /Matched legacy EPM ID 6499570/);
  assert.match(patientPickerOption(patients[0], "Open", "Alex")[0].description ?? "", new RegExp(`MRN ${mrn}`));
});

function patient(id: string, system: string, value: string): Patient {
  return {
    resourceType: "Patient",
    id,
    name: [{ text: `Patient ${id}` }],
    birthDate: "1980-01-02",
    identifier: [{ system, value }],
  };
}

function bundle(rows: Patient[]): Bundle<Patient> {
  return {
    resourceType: "Bundle",
    type: "searchset",
    entry: rows.map((resource) => ({ resource })),
  };
}
