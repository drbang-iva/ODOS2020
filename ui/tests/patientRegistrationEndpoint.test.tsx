import assert from "node:assert/strict";
import { test } from "node:test";
import type { Patient } from "@medplum/fhirtypes";
import {
  createPatient,
  registerPatient,
  type PatientDemographicsDraft,
} from "../src/lib/patient-registration";
import { emptySelfResponsibleParty } from "../src/lib/patient-identity";

const DEMOGRAPHICS: PatientDemographicsDraft = {
  firstName: "Jane",
  middleName: "Q",
  lastName: "Doe",
  preferredName: "Janie",
  birthDate: "1980-01-02",
  gender: "female",
  phone: "864-555-0100",
  email: "jane@example.test",
  address: "1 Main St",
  city: "Greenville",
  state: "SC",
  postalCode: "29601",
};

const CREATED_PATIENT: Patient = {
  resourceType: "Patient",
  id: "patient-1",
  name: [{ use: "official", given: ["Jane", "Q"], family: "Doe" }],
  birthDate: "1980-01-02",
};

test("registration posts only the typed form contract to the clinic orchestrator", async () => {
  const parties = [emptySelfResponsibleParty("self")];
  let requestInput: string | URL | Request | undefined;
  let requestInit: RequestInit | undefined;
  const fetchImpl: typeof fetch = async (input, init) => {
    requestInput = input;
    requestInit = init;
    return Response.json({ kind: "created", patient: CREATED_PATIENT }, { status: 201 });
  };

  const result = await registerPatient(
    DEMOGRAPHICS,
    { responsibleParties: parties, today: "2026-08-25" },
    fetchImpl,
  );

  assert.equal(result.kind, "created");
  assert.equal(requestInput, "/clinic/patients");
  assert.equal(requestInit?.method, "POST");
  assert.deepEqual(JSON.parse(String(requestInit?.body)), {
    demographics: DEMOGRAPHICS,
    responsibleParties: parties,
    confirmDuplicate: false,
  });
});

test("create anyway is a server-side duplicate override, not a browser FHIR write", async () => {
  let body: unknown;
  const fetchImpl: typeof fetch = async (_input, init) => {
    body = JSON.parse(String(init?.body));
    return Response.json({ kind: "created", patient: CREATED_PATIENT }, { status: 201 });
  };

  const result = await createPatient(DEMOGRAPHICS, {}, fetchImpl);

  assert.equal(result.patient.id, "patient-1");
  assert.deepEqual(body, {
    demographics: DEMOGRAPHICS,
    responsibleParties: [emptySelfResponsibleParty("self")],
    confirmDuplicate: true,
  });
});

test("create anyway preserves a successful registration access warning", async () => {
  const fetchImpl: typeof fetch = async () => Response.json({
    kind: "created",
    patient: CREATED_PATIENT,
    warning: {
      code: "access-grant-repair-required",
      message: "Ask a practice administrator to repair your patient access.",
      patientReference: "Patient/patient-1",
    },
  }, { status: 201 });

  const result = await createPatient(DEMOGRAPHICS, {}, fetchImpl);

  assert.equal(result.warning?.code, "access-grant-repair-required");
  assert.match(result.warning?.message ?? "", /repair your patient access/);
});

test("registration surfaces an actionable permission error without raw FHIR details", async () => {
  const fetchImpl: typeof fetch = async () => Response.json({
    error: "Your role cannot register patients. Ask an administrator to grant patient registration access.",
  }, { status: 403 });

  await assert.rejects(
    registerPatient(DEMOGRAPHICS, {}, fetchImpl),
    /Ask an administrator to grant patient registration access/,
  );
});
