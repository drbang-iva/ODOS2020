import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  Appointment,
  Bundle,
  Patient,
  PractitionerRole,
  ProjectMembership,
  Resource,
} from "@medplum/fhirtypes";
import {
  handleProviderAssignmentRequest,
  hasPatientCompartmentGrant,
} from "../src/clinical-graph/provider-assignment-endpoint.js";
import type { JsonPatchOperation } from "../src/fhir-client.js";

const AUTH = "Bearer clinician";

test("assign-provider appends self Practitioner + one complete access entry per patient and is idempotent", async () => {
  const fhir = new AssignmentFhir();
  const deps = {
    authenticate: async () => ({
      staffReference: "Practitioner/doc-1",
      actorRole: "provider" as const,
      fhir,
    }),
    serviceFhir: fhir,
  };

  const first = await handleProviderAssignmentRequest(deps, {
    authHeader: AUTH,
    patientId: "patient-1",
  });
  const second = await handleProviderAssignmentRequest(deps, {
    authHeader: AUTH,
    patientId: "patient-1",
  });
  const otherPatient = await handleProviderAssignmentRequest(deps, {
    authHeader: AUTH,
    patientId: "patient-2",
  });

  assert.equal(first.status, 200);
  assert.deepEqual(first.body, {
    assigned: true,
    patientReference: "Patient/patient-1",
    practitionerReference: "Practitioner/doc-1",
    patientUpdated: true,
    membershipUpdated: true,
  });
  assert.deepEqual(second.body, {
    assigned: false,
    patientReference: "Patient/patient-1",
    practitionerReference: "Practitioner/doc-1",
    patientUpdated: false,
    membershipUpdated: false,
  });
  assert.equal(otherPatient.status, 200);
  assert.equal(fhir.patches.length, 4);
  assert.deepEqual(
    fhir.patients.get("patient-1")?.generalPractitioner,
    [{ reference: "Practitioner/doc-1" }],
  );
  assert.deepEqual(
    fhir.patients.get("patient-2")?.generalPractitioner,
    [
      { reference: "Practitioner/doc-2" },
      { reference: "Practitioner/doc-1" },
    ],
  );
  assert.equal(hasPatientCompartmentGrant(fhir.membership, "Patient/patient-1"), true);
  assert.equal(hasPatientCompartmentGrant(fhir.membership, "Patient/patient-2"), true);
  assert.equal(fhir.membership.access?.length, 3);
  for (const patientReference of ["Patient/patient-1", "Patient/patient-2"]) {
    const entry = fhir.membership.access?.find((access) =>
      access.parameter?.some((parameter) => parameter.valueString === patientReference),
    );
    assert.deepEqual(entry?.parameter, [
      {
        name: "provider_profile",
        valueReference: { reference: "Practitioner/doc-1" },
      },
      { name: "patient_compartment", valueString: patientReference },
    ]);
  }
  assert.equal(
    fhir.patches.every((patch) => patch.headers["If-Match"] === 'W/"1"'),
    true,
  );
});

test("assign-provider resolves PractitionerRole to its Practitioner", async () => {
  const fhir = new AssignmentFhir();
  const result = await handleProviderAssignmentRequest(
    {
      authenticate: async () => ({
        staffReference: "PractitionerRole/role-1",
        actorRole: "provider" as const,
        fhir,
      }),
      serviceFhir: fhir,
    },
    { authHeader: AUTH, patientId: "patient-1" },
  );

  assert.equal(result.status, 200);
  assert.equal(
    (result.body as { practitionerReference: string }).practitionerReference,
    "Practitioner/doc-1",
  );
});

test("assign-provider fails closed for unauthenticated or read-only Admin", async () => {
  const fhir = new AssignmentFhir();
  const unauthenticated = await handleProviderAssignmentRequest(
    { authenticate: async () => null, serviceFhir: fhir },
    { authHeader: undefined, patientId: "patient-1" },
  );
  const forbidden = await handleProviderAssignmentRequest(
    {
      authenticate: async () => ({
        staffReference: "Practitioner/admin",
        actorRole: "admin" as const,
        fhir,
      }),
      serviceFhir: fhir,
    },
    { authHeader: AUTH, patientId: "patient-1" },
  );

  assert.equal(unauthenticated.status, 401);
  assert.equal(forbidden.status, 403);
  assert.equal(fhir.patches.length, 0);
});

test("patient-id assignment returns the caller-scoped Patient 404 before any service patch", async () => {
  const serviceFhir = new AssignmentFhir();
  serviceFhir.patients.set("foreign-patient", patient("foreign-patient"));
  const callerReads: string[] = [];
  const result = await handleProviderAssignmentRequest(
    {
      authenticate: async () => ({
        staffReference: "Practitioner/doc-1",
        actorRole: "provider" as const,
        fhir: {
          read: async <T extends Resource>(resourceType: T["resourceType"], id: string): Promise<T> => {
            callerReads.push(`${resourceType}/${id}`);
            throw notFound();
          },
        },
      }),
      serviceFhir,
    },
    { authHeader: AUTH, patientId: "foreign-patient" },
  );

  assert.equal(result.status, 404);
  assert.deepEqual(result.body, { error: "Patient not found." });
  assert.deepEqual(callerReads, ["Patient/foreign-patient"]);
  assert.equal(serviceFhir.patches.length, 0);
});

test("appointment-id assignment returns the caller-scoped Appointment 404 before any service patch", async () => {
  const serviceFhir = new AssignmentFhir();
  const callerReads: string[] = [];
  const result = await handleProviderAssignmentRequest(
    {
      authenticate: async () => ({
        staffReference: "Practitioner/doc-1",
        actorRole: "provider" as const,
        fhir: {
          read: async <T extends Resource>(resourceType: T["resourceType"], id: string): Promise<T> => {
            callerReads.push(`${resourceType}/${id}`);
            throw notFound();
          },
        },
      }),
      serviceFhir,
    },
    { authHeader: AUTH, appointmentId: "foreign-appointment" },
  );

  assert.equal(result.status, 404);
  assert.deepEqual(result.body, { error: "Appointment not found." });
  assert.deepEqual(callerReads, ["Appointment/foreign-appointment"]);
  assert.equal(serviceFhir.patches.length, 0);
});

test("appointment-id assignment derives its Patient only after the caller can read the Appointment", async () => {
  const serviceFhir = new AssignmentFhir();
  const appointment: Appointment = {
    resourceType: "Appointment",
    id: "appointment-1",
    status: "arrived",
    participant: [
      { actor: { reference: "Patient/patient-1" } },
      { actor: { reference: "Practitioner/doc-1", display: "Doctor One" } },
    ],
  };
  const callerReads: string[] = [];
  const result = await handleProviderAssignmentRequest(
    {
      authenticate: async () => ({
        staffReference: "Practitioner/doc-1",
        actorRole: "provider" as const,
        fhir: {
          read: async <T extends Resource>(resourceType: T["resourceType"], id: string): Promise<T> => {
            callerReads.push(`${resourceType}/${id}`);
            assert.equal(resourceType, "Appointment");
            assert.equal(id, "appointment-1");
            return appointment as T;
          },
        },
      }),
      serviceFhir,
    },
    { authHeader: AUTH, appointmentId: "appointment-1" },
  );

  assert.equal(result.status, 200);
  assert.deepEqual(callerReads, ["Appointment/appointment-1"]);
  assert.deepEqual(
    serviceFhir.patients.get("patient-1")?.generalPractitioner,
    [{ reference: "Practitioner/doc-1" }],
  );
  assert.equal(hasPatientCompartmentGrant(serviceFhir.membership, "Patient/patient-1"), true);
});

test("appointment-id assignment refuses a provider absent from every practitioner actor before membership lookup or patches", async () => {
  const fhir = new AssignmentFhir();
  fhir.appointments.set("appointment-1", {
    resourceType: "Appointment",
    id: "appointment-1",
    status: "arrived",
    participant: [
      { actor: { reference: "Patient/patient-1" }, status: "accepted" },
      { actor: { reference: "Practitioner/doc-2", display: "Doctor Two" }, status: "accepted" },
      { actor: { reference: "Practitioner/doc-3", display: "Doctor Three" }, status: "accepted" },
    ],
  });

  const result = await handleProviderAssignmentRequest(
    {
      authenticate: async () => ({
        staffReference: "Practitioner/doc-1",
        actorRole: "provider" as const,
        fhir,
      }),
      serviceFhir: fhir,
    },
    { authHeader: AUTH, appointmentId: "appointment-1" },
  );

  assert.equal(result.status, 403);
  assert.deepEqual(result.body, {
    error: "This appointment is assigned to Doctor Two. Reassign it to chart from here.",
    assignedProviderReference: "Practitioner/doc-2",
    assignedProviderDisplay: "Doctor Two",
  });
  assert.deepEqual(fhir.searches, []);
  assert.deepEqual(fhir.patches, []);
});

test("appointment-id assignment permits the second of two practitioner actors", async () => {
  const fhir = new AssignmentFhir();
  fhir.appointments.set("appointment-1", {
    resourceType: "Appointment",
    id: "appointment-1",
    status: "arrived",
    participant: [
      { actor: { reference: "Patient/patient-1" }, status: "accepted" },
      { actor: { reference: "Practitioner/doc-2", display: "Doctor Two" }, status: "accepted" },
      { actor: { reference: "Practitioner/doc-1", display: "Doctor One" }, status: "accepted" },
    ],
  });

  const result = await handleProviderAssignmentRequest(
    {
      authenticate: async () => ({
        staffReference: "Practitioner/doc-1",
        actorRole: "provider" as const,
        fhir,
      }),
      serviceFhir: fhir,
    },
    { authHeader: AUTH, appointmentId: "appointment-1" },
  );

  assert.equal(result.status, 200);
  assert.equal(fhir.searches.length, 1);
  assert.equal(fhir.patches.length, 2);
});

test("appointment-id assignment resolves a PractitionerRole before comparing every practitioner actor", async () => {
  const fhir = new AssignmentFhir();
  fhir.appointments.set("appointment-1", {
    resourceType: "Appointment",
    id: "appointment-1",
    status: "arrived",
    participant: [
      { actor: { reference: "Patient/patient-1" }, status: "accepted" },
      { actor: { reference: "Practitioner/doc-1", display: "Doctor One" }, status: "accepted" },
    ],
  });

  const result = await handleProviderAssignmentRequest(
    {
      authenticate: async () => ({
        staffReference: "PractitionerRole/role-1",
        actorRole: "provider" as const,
        fhir,
      }),
      serviceFhir: fhir,
    },
    { authHeader: AUTH, appointmentId: "appointment-1" },
  );

  assert.equal(result.status, 200);
  assert.equal(
    (result.body as { practitionerReference: string }).practitionerReference,
    "Practitioner/doc-1",
  );
  assert.equal(fhir.patches.length, 2);
});

test("caller-scoped 403 remains 403 for patient-id and appointment-id assignment", async () => {
  for (const input of [
    { patientId: "patient-1" } as const,
    { appointmentId: "appointment-1" } as const,
  ]) {
    const serviceFhir = new AssignmentFhir();
    const result = await handleProviderAssignmentRequest(
      {
        authenticate: async () => ({
          staffReference: "Practitioner/doc-1",
          actorRole: "provider" as const,
          fhir: {
            read: async <T extends Resource>(): Promise<T> => {
              throw forbidden();
            },
          },
        }),
        serviceFhir,
      },
      { authHeader: AUTH, ...input },
    );

    assert.equal(result.status, 403);
    assert.deepEqual(result.body, {
      error: "patientId" in input
        ? "You do not have permission to access this patient."
        : "You do not have permission to access this appointment.",
    });
    assert.deepEqual(serviceFhir.patches, []);
  }
});

test("appointment-id assignment rejects an appointment without a practitioner actor before writes", async () => {
  const fhir = new AssignmentFhir();
  fhir.appointments.set("appointment-1", {
    resourceType: "Appointment",
    id: "appointment-1",
    status: "arrived",
    participant: [{ actor: { reference: "Patient/patient-1" }, status: "accepted" }],
  });

  const result = await handleProviderAssignmentRequest(
    {
      authenticate: async () => ({
        staffReference: "Practitioner/doc-1",
        actorRole: "provider" as const,
        fhir,
      }),
      serviceFhir: fhir,
    },
    { authHeader: AUTH, appointmentId: "appointment-1" },
  );

  assert.equal(result.status, 409);
  assert.deepEqual(result.body, { error: "This appointment has no assigned provider." });
  assert.deepEqual(fhir.searches, []);
  assert.deepEqual(fhir.patches, []);
});

test("appointment-id assignment is Provider-only even when Staff can read the schedule", async () => {
  const serviceFhir = new AssignmentFhir();
  let callerReads = 0;
  const result = await handleProviderAssignmentRequest(
    {
      authenticate: async () => ({
        staffReference: "Practitioner/staff-1",
        actorRole: "staff" as const,
        fhir: {
          read: async <T extends Resource>(): Promise<T> => {
            callerReads += 1;
            return {
              resourceType: "Appointment",
              id: "appointment-1",
              status: "arrived",
              participant: [{ actor: { reference: "Patient/patient-1" } }],
            } as T;
          },
        },
      }),
      serviceFhir,
    },
    { authHeader: AUTH, appointmentId: "appointment-1" },
  );

  assert.equal(result.status, 403);
  assert.deepEqual(result.body, { error: "Provider role required for appointment assignment." });
  assert.equal(callerReads, 0);
  assert.equal(serviceFhir.patches.length, 0);
});

class AssignmentFhir {
  readonly appointments = new Map<string, Appointment>([[
    "foreign-appointment",
    {
      resourceType: "Appointment",
      id: "foreign-appointment",
      status: "arrived",
      participant: [{ actor: { reference: "Patient/patient-1" } }],
    },
  ]]);
  readonly patients = new Map<string, Patient>([
    ["patient-1", patient("patient-1")],
    [
      "patient-2",
      {
        ...patient("patient-2"),
        generalPractitioner: [{ reference: "Practitioner/doc-2" }],
      },
    ],
  ]);
  readonly practitionerRole: PractitionerRole = {
    resourceType: "PractitionerRole",
    id: "role-1",
    practitioner: { reference: "Practitioner/doc-1" },
  };
  membership: ProjectMembership = {
    resourceType: "ProjectMembership",
    id: "membership-1",
    meta: { versionId: "1" },
    project: { reference: "Project/project-1" },
    profile: { reference: "Practitioner/doc-1" },
    access: [{
      policy: { reference: "AccessPolicy/clinician" },
      parameter: [{
        name: "provider_profile",
        valueReference: { reference: "Practitioner/doc-1" },
      }],
    }],
  };
  readonly patches: Array<{
    resourceType: string;
    id: string;
    operations: JsonPatchOperation[];
    headers: Record<string, string>;
  }> = [];
  readonly searches: string[] = [];

  async read<T extends Resource>(resourceType: T["resourceType"], id: string): Promise<T> {
    if (resourceType === "Appointment") return this.appointments.get(id) as T;
    if (resourceType === "Patient") return this.patients.get(id) as T;
    if (resourceType === "PractitionerRole") return this.practitionerRole as T;
    throw new Error(`Unexpected read ${resourceType}/${id}`);
  }

  async search<T extends Resource>(resourceType: T["resourceType"]): Promise<Bundle<T>> {
    assert.equal(resourceType, "ProjectMembership");
    this.searches.push(resourceType);
    return { resourceType: "Bundle", type: "searchset", entry: [{ resource: this.membership as T }] };
  }

  async patch<T extends Resource>(
    resourceType: T["resourceType"],
    id: string,
    operations: JsonPatchOperation[],
    headers: Record<string, string> = {},
  ): Promise<T> {
    this.patches.push({ resourceType, id, operations, headers });
    const value = operations[0] && "value" in operations[0] ? operations[0].value : undefined;
    if (resourceType === "Patient") {
      const target = this.patients.get(id)!;
      target.generalPractitioner = operations[0]?.path.endsWith("/-")
        ? [...(target.generalPractitioner ?? []), value as never]
        : value as never;
      return target as T;
    }
    if (resourceType === "ProjectMembership") {
      this.membership.access = operations[0]?.path.endsWith("/-")
        ? [...(this.membership.access ?? []), value as never]
        : value as never;
      return this.membership as T;
    }
    throw new Error(`Unexpected patch ${resourceType}/${id}`);
  }
}

function patient(id: string): Patient {
  return {
    resourceType: "Patient",
    id,
    meta: { versionId: "1" },
    active: true,
  };
}

function notFound(): Error & { status: number } {
  return Object.assign(new Error("FHIR 404 Not Found"), { status: 404 });
}

function forbidden(): Error & { status: number } {
  return Object.assign(new Error("FHIR 403 Forbidden"), { status: 403 });
}
