import assert from "node:assert/strict";
import { test } from "node:test";
import type {
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
      }),
      serviceFhir: fhir,
    },
    { authHeader: AUTH, patientId: "patient-1" },
  );

  assert.equal(unauthenticated.status, 401);
  assert.equal(forbidden.status, 403);
  assert.equal(fhir.patches.length, 0);
});

class AssignmentFhir {
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

  async read<T extends Resource>(resourceType: T["resourceType"], id: string): Promise<T> {
    if (resourceType === "Patient") return this.patients.get(id) as T;
    if (resourceType === "PractitionerRole") return this.practitionerRole as T;
    throw new Error(`Unexpected read ${resourceType}/${id}`);
  }

  async search<T extends Resource>(resourceType: T["resourceType"]): Promise<Bundle<T>> {
    assert.equal(resourceType, "ProjectMembership");
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
