import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import type {
  AccessPolicy,
  Account,
  Bundle,
  Patient,
  ProjectMembership,
  Resource,
} from "@medplum/fhirtypes";
import express from "express";
import { registerClinicRoutes } from "../src/clinic/clinic-routes.js";
import { registerPatientFromDemographics } from "../src/clinic/patient-registration-endpoint.js";
import {
  buildMedplumAccessPolicy,
  getRoleDeclaration,
  type PracticeRoleId,
} from "../src/authz/roles.js";

test("Provider, Staff, and Admin may register a patient", () => {
  const missing = (["provider", "staff", "admin"] as const).filter(
    (role) => !getRoleDeclaration(role).businessActions.includes("patients.register" as never),
  );
  assert.deepEqual(missing, [], `roles missing patients.register: ${missing.join(", ")}`);
});

test("no user AccessPolicy authorizes a compartment-less Account create", () => {
  for (const role of ["provider", "staff", "admin"] as const) {
    const policy = buildMedplumAccessPolicy(getRoleDeclaration(role));
    const compartmentlessCreate = policy.resource?.find((rule) =>
      rule.resourceType === "Account" && rule.interaction?.includes("create") && !rule.criteria
    );
    assert.equal(compartmentlessCreate, undefined, `${role} must not create an unbound Account`);
  }
});

for (const role of ["provider", "staff", "admin"] as const) {
  test(`${role} registers Patient, RelatedPerson, and Account through one service transaction`, async () => {
    const fhir = new RegistrationFhir(role);
    const response = await postRegistration(role, fhir);

    assert.equal(response.status, 201);
    const body = await response.json() as { patient: Patient; warning?: unknown };
    assert.equal(body.patient.resourceType, "Patient");
    assert.equal(body.patient.id, "patient-1");
    assert.equal(body.warning, undefined);
    assert.deepEqual(
      fhir.transaction?.entry?.map((entry) => entry.resource?.resourceType),
      ["Patient", "RelatedPerson", "Account"],
    );
    assert.equal(fhir.account?.status, "active");
    assert.equal(fhir.canRead("Patient/patient-1"), true);
  });
}

test("a role without patients.register is refused before any service FHIR call", async () => {
  const actions = getRoleDeclaration("staff").businessActions;
  const index = actions.indexOf("patients.register");
  assert.notEqual(index, -1);
  actions.splice(index, 1);
  let fhirCalls = 0;
  const serviceFhir = new Proxy({}, {
    get: () => async () => {
      fhirCalls += 1;
      throw new Error("service FHIR must not be reached");
    },
  });
  try {
    await assert.rejects(
      registerPatientFromDemographics(
        REGISTRATION_BODY as never,
        {
          staffReference: "Practitioner/staff-1",
          actorRole: "staff",
          roles: ["staff"],
          project: { reference: "Project/practice-1" },
        },
        { serviceFhir: serviceFhir as never, now: () => "2026-08-25T12:00:00.000Z" },
      ),
      /lacks business action patients\.register/,
    );
    assert.equal(fhirCalls, 0);
  } finally {
    actions.splice(index, 0, "patients.register");
  }
});

test("a failed identity transaction leaves no Patient and marks its MRN reservation entered-in-error", async () => {
  const fhir = new RegistrationFhir("staff");
  fhir.failTransaction = true;

  const response = await postRegistration("staff", fhir);

  assert.equal(response.status, 500);
  assert.equal(fhir.patientCreated, false);
  assert.equal(fhir.account?.status, "entered-in-error");
});

test("a membership version conflict is refetched and retried before registration returns", async () => {
  const fhir = new RegistrationFhir("provider");
  fhir.conflictGrantOnce = true;

  const response = await postRegistration("provider", fhir);
  const body = await response.json() as { warning?: unknown };

  assert.equal(response.status, 201);
  assert.equal(body.warning, undefined);
  assert.equal(fhir.grantPatchAttempts, 2);
  assert.equal(fhir.canRead("Patient/patient-1"), true);
});

test("registration appends every named compartment parameter on a stacked composite membership", async () => {
  const fhir = new RegistrationFhir("staff");
  fhir.policy.id = "provider-staff-admin";
  fhir.policy.resource = ["provider", "staff", "admin"].flatMap((role) => [
    {
      resourceType: "Patient",
      criteria: `Patient?_compartment=%${role}_patient_compartment`,
    },
    {
      resourceType: "Encounter",
      criteria: `Encounter?_compartment=%${role}_patient_compartment&participant=%${role}_provider_profile`,
    },
  ]);
  fhir.membership.access = [{ policy: { reference: "AccessPolicy/provider-staff-admin" } }];

  const response = await postRegistration("staff", fhir);

  assert.equal(response.status, 201);
  assert.deepEqual(fhir.membership.access?.[1]?.parameter, [
    { name: "admin_patient_compartment", valueString: "Patient/patient-1" },
    { name: "admin_provider_profile", valueReference: { reference: "Practitioner/staff-1" } },
    { name: "provider_patient_compartment", valueString: "Patient/patient-1" },
    { name: "provider_provider_profile", valueReference: { reference: "Practitioner/staff-1" } },
    { name: "staff_patient_compartment", valueString: "Patient/patient-1" },
    { name: "staff_provider_profile", valueReference: { reference: "Practitioner/staff-1" } },
  ]);
});

test("persistent grant failure preserves the active registration and returns asserted repair guidance", async () => {
  const fhir = new RegistrationFhir("staff");
  fhir.failGrantAlways = true;
  const logs: string[] = [];

  const response = await postRegistration("staff", fhir, (message) => logs.push(message));
  const body = await response.json() as {
    patient: Patient;
    warning: { code: string; message: string; patientReference: string };
  };

  assert.equal(response.status, 201);
  assert.equal(body.patient.active, true);
  assert.equal(fhir.patientCreated, true);
  assert.equal(fhir.account?.status, "active");
  assert.equal(body.warning.code, "access-grant-repair-required");
  assert.match(body.warning.message, /practice administrator.*repair.*patient access/i);
  assert.equal(body.warning.patientReference, "Patient/patient-1");
  assert.deepEqual(logs, [
    "odos-mcp: patient registration access grant failed for Patient/patient-1; registration preserved.",
  ]);
});

test("an exact pre-existing Patient is returned as a duplicate and never receives a registration grant", async () => {
  const fhir = new RegistrationFhir("staff");
  fhir.exactDuplicate = true;

  const response = await postRegistration("staff", fhir);
  const body = await response.json() as { patients: Patient[] };

  assert.equal(response.status, 409);
  assert.deepEqual(body.patients.map((patient) => patient.id), ["preexisting-1"]);
  assert.equal(fhir.transaction, undefined);
  assert.equal(fhir.grantPatchAttempts, 0);
  assert.equal(fhir.canRead("Patient/preexisting-1"), false);
});

test("duplicate detection never returns a Patient owned by another project", async () => {
  const fhir = new RegistrationFhir("staff");
  fhir.exactDuplicate = true;
  fhir.duplicateProjectId = "other-practice";

  const response = await postRegistration("staff", fhir);
  const body = await response.json() as { patients?: Patient[] };

  assert.equal(response.status, 500);
  assert.equal(body.patients, undefined);
  assert.equal(fhir.transaction, undefined);
});

test("confirmDuplicate creates a distinct server-owned Patient after the duplicate warning", async () => {
  const fhir = new RegistrationFhir("staff");
  fhir.exactDuplicate = true;

  const response = await postRegistration("staff", fhir, undefined, {
    ...REGISTRATION_BODY,
    confirmDuplicate: true,
  });
  const body = await response.json() as { patient: Patient };

  assert.equal(response.status, 201);
  assert.equal(body.patient.id, "patient-1");
  assert.equal(fhir.patientCreated, true);
  assert.equal(fhir.canRead("Patient/patient-1"), true);
  assert.equal(fhir.canRead("Patient/preexisting-1"), false);
});

test("a caller-supplied Patient id is rejected before registration FHIR calls", async () => {
  const fhir = new RegistrationFhir("staff");
  const response = await postRegistration("staff", fhir, undefined, {
    ...REGISTRATION_BODY,
    patientId: "preexisting-1",
  });

  assert.equal(response.status, 400);
  assert.equal(fhir.searchCalls, 0);
  assert.equal(fhir.grantPatchAttempts, 0);
});

test("authoritative registration validation rejects form-invalid input before service FHIR", async () => {
  const invalidBodies = [
    {
      ...REGISTRATION_BODY,
      demographics: { ...REGISTRATION_BODY.demographics, phone: "1" },
    },
    {
      ...REGISTRATION_BODY,
      demographics: { ...REGISTRATION_BODY.demographics, birthDate: "1980-01-02" },
      responsibleParties: [
        { ...REGISTRATION_BODY.responsibleParties[0], kind: "self", localId: "self-1" },
        { ...REGISTRATION_BODY.responsibleParties[0], kind: "self", localId: "self-2" },
      ],
    },
    {
      ...REGISTRATION_BODY,
      demographics: { ...REGISTRATION_BODY.demographics, birthDate: "1980-01-02" },
      responsibleParties: [{
        ...REGISTRATION_BODY.responsibleParties[0],
        endDate: "2026-02-30",
      }],
    },
    {
      ...REGISTRATION_BODY,
      demographics: { ...REGISTRATION_BODY.demographics, birthDate: "1980-01-02" },
      responsibleParties: [
        REGISTRATION_BODY.responsibleParties[0],
        { ...REGISTRATION_BODY.responsibleParties[0], primary: false },
      ],
    },
  ];

  for (const body of invalidBodies) {
    const fhir = new RegistrationFhir("staff");
    const response = await postRegistration("staff", fhir, undefined, body);
    assert.equal(response.status, 400);
    assert.equal(fhir.searchCalls, 0);
  }
});

const REGISTRATION_BODY = {
  demographics: {
    firstName: "Synthetic",
    middleName: "",
    lastName: "Registration",
    preferredName: "",
    birthDate: "2010-01-02",
    gender: "female",
    phone: "864-555-0100",
    email: "",
    address: "1 Synthetic Way",
    city: "Greenville",
    state: "SC",
    postalCode: "29601",
  },
  responsibleParties: [{
    localId: "guardian",
    kind: "person",
    relationship: "legal-guardian",
    firstName: "Responsible",
    middleName: "",
    lastName: "Person",
    phone: "864-555-0101",
    address: "1 Synthetic Way",
    city: "Greenville",
    state: "SC",
    postalCode: "29601",
    financialResponsible: true,
    consentAuthority: true,
    primary: true,
    courtOrderNotes: "",
    effectiveDate: "2026-08-25",
    endDate: "",
  }],
  confirmDuplicate: false,
} as const;

async function postRegistration(
  role: PracticeRoleId,
  serviceFhir: RegistrationFhir,
  logRegistrationGrantFailure?: (message: string, error: unknown) => void,
  body: unknown = REGISTRATION_BODY,
): Promise<Response> {
  const app = express();
  app.use(express.json());
  registerClinicRoutes(app, {
    authenticateService: async () => undefined,
    authenticate: async () => ({
      staffReference: `Practitioner/${role}-1`,
      actorRole: role,
      roles: [role],
      project: { reference: "Project/practice-1" },
      fhir: {} as never,
    }),
    serviceFhir,
    logRegistrationGrantFailure,
    now: () => "2026-08-25T12:00:00.000Z",
  } as never);
  const listener = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve, reject) => {
    listener.once("listening", resolve);
    listener.once("error", reject);
  });
  const { port } = listener.address() as AddressInfo;
  try {
    return await fetch(`http://127.0.0.1:${port}/clinic/patients`, {
      method: "POST",
      headers: { Authorization: "Bearer good", "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } finally {
    await new Promise<void>((resolve, reject) =>
      listener.close((error) => error ? reject(error) : resolve())
    );
  }
}

class RegistrationFhir {
  account?: Account;
  transaction?: Bundle;
  failTransaction = false;
  patientCreated = false;
  conflictGrantOnce = false;
  failGrantAlways = false;
  exactDuplicate = false;
  duplicateProjectId = "practice-1";
  searchCalls = 0;
  grantPatchAttempts = 0;
  readonly membership: ProjectMembership;
  readonly patient: Patient = {
    resourceType: "Patient",
    id: "patient-1",
    meta: { versionId: "1", project: "Project/practice-1" },
    active: true,
    name: [{ use: "official", given: ["Synthetic"], family: "Registration" }],
    birthDate: "2010-01-02",
  };
  readonly policy: AccessPolicy;

  constructor(role: PracticeRoleId) {
    this.membership = {
      resourceType: "ProjectMembership",
      id: `${role}-membership`,
      meta: { versionId: "1", project: "Project/practice-1" },
      project: { reference: "Project/practice-1" },
      profile: { reference: `Practitioner/${role}-1` },
      active: true,
      access: [{ policy: { reference: `AccessPolicy/${role}` } }],
    };
    this.policy = {
      resourceType: "AccessPolicy",
      id: role,
      meta: { project: "Project/practice-1" },
      resource: [{
        resourceType: "Patient",
        criteria: "Patient?_compartment=%patient_compartment",
      }],
    };
  }

  async search<T extends Resource>(
    resourceType: T["resourceType"],
    params: Record<string, string> = {},
  ): Promise<Bundle<T>> {
    this.searchCalls += 1;
    if (resourceType === "Patient") {
      const duplicate = this.exactDuplicate && params.given
        ? {
            ...this.patient,
            id: "preexisting-1",
            meta: { versionId: "1", project: `Project/${this.duplicateProjectId}` },
          }
        : undefined;
      return {
        resourceType: "Bundle",
        type: "searchset",
        entry: duplicate ? [{ resource: duplicate as T }] : [],
      };
    }
    throw new Error(`unexpected search ${resourceType}`);
  }

  async searchProject<T extends Resource>(
    resourceType: T["resourceType"],
    projectId: string,
    params: Record<string, string> = {},
  ): Promise<Bundle<T>> {
    assert.equal(projectId, "practice-1");
    const resource = resourceType === "ProjectMembership"
      ? this.membership
      : resourceType === "AccessPolicy"
      ? this.policy
      : resourceType === "Patient"
      ? params.given
        ? this.exactDuplicate
          ? {
              ...this.patient,
              id: "preexisting-1",
              meta: { versionId: "1", project: `Project/${this.duplicateProjectId}` },
            }
          : undefined
        : this.patient
      : undefined;
    return {
      resourceType: "Bundle",
      type: "searchset",
      entry: resource ? [{ resource: resource as T }] : [],
    };
  }

  async create<T extends Resource>(resource: T): Promise<T> {
    assert.equal(resource.resourceType, "Account");
    this.account = {
      ...(resource as Account),
      id: "reservation-1",
      meta: { versionId: "1", project: "Project/practice-1" },
    };
    return structuredClone(this.account) as T;
  }

  async executeTransaction(bundle: Bundle): Promise<Bundle> {
    this.transaction = structuredClone(bundle);
    if (this.failTransaction) throw new Error("synthetic transaction failure");
    this.patientCreated = true;
    this.account = {
      ...(bundle.entry?.at(-1)?.resource as Account),
      id: "reservation-1",
      status: "active",
      meta: { versionId: "2", project: "Project/practice-1" },
    };
    return {
      resourceType: "Bundle",
      type: "transaction-response",
      entry: [
        { response: { status: "201 Created", location: "Patient/patient-1/_history/1" } },
        { response: { status: "201 Created", location: "RelatedPerson/related-1/_history/1" } },
        { response: { status: "200 OK", location: "Account/reservation-1/_history/2" } },
      ],
    };
  }

  async update<T extends Resource>(resourceType: T["resourceType"], id: string, resource: T): Promise<T> {
    assert.equal(resourceType, "Account");
    assert.equal(id, "reservation-1");
    this.account = structuredClone(resource as Account);
    return structuredClone(resource);
  }

  async read<T extends Resource>(resourceType: T["resourceType"], id: string): Promise<T> {
    if (resourceType === "Patient" && id === "patient-1") return structuredClone(this.patient) as T;
    throw new Error(`unexpected read ${resourceType}/${id}`);
  }

  async patch<T extends Resource>(
    resourceType: T["resourceType"],
    id: string,
    operations: Array<{ op: string; path: string; value?: unknown }>,
  ): Promise<T> {
    assert.equal(resourceType, "ProjectMembership");
    assert.equal(id, this.membership.id);
    this.grantPatchAttempts += 1;
    if (this.conflictGrantOnce && this.grantPatchAttempts === 1) {
      throw Object.assign(new Error("synthetic version conflict"), { status: 412 });
    }
    if (this.failGrantAlways) throw new Error("synthetic grant persistence failure");
    for (const operation of operations) {
      if (operation.path === "/access/-") {
        this.membership.access?.push(operation.value as NonNullable<ProjectMembership["access"]>[number]);
      } else if (operation.path === "/access") {
        this.membership.access = operation.value as ProjectMembership["access"];
      }
    }
    this.membership.meta = { ...this.membership.meta, versionId: "2" };
    return structuredClone(this.membership) as T;
  }

  canRead(patientReference: string): boolean {
    return this.membership.access?.some((access) => access.parameter?.some(
      (parameter) => parameter.valueString === patientReference,
    )) ?? false;
  }
}
