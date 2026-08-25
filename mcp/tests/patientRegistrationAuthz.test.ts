import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  AccessPolicy,
  AccessPolicyResource,
  Account,
  Bundle,
  Patient,
  Resource,
} from "@medplum/fhirtypes";
import fhirpath from "fhirpath";
import r4Model from "fhirpath/fhir-context/r4/index.js";
import {
  buildMedplumAccessPolicy,
  getRoleDeclaration,
  type PracticeRoleId,
} from "../src/authz/roles.js";
import {
  registerPatient,
  type PatientDemographicsDraft,
} from "../../ui/src/lib/patient-registration.js";
import {
  ODOS_MRN_SYSTEM,
  reserveOdosMrn,
} from "../../ui/src/lib/patient-identity.js";

const REGISTRATION_DRAFT: PatientDemographicsDraft = {
  firstName: "Synthetic",
  middleName: "",
  lastName: "Registration",
  preferredName: "",
  birthDate: "1980-01-02",
  gender: "female",
  phone: "864-555-0100",
  email: "",
  address: "",
  city: "",
  state: "",
  postalCode: "",
};

for (const [index, roleId] of (["provider", "staff", "admin"] as const).entries()) {
  test(`${roleId} completes patient registration without a patient-compartment binding`, async () => {
    const api = new PolicyEnforcedRegistrationApi(roleId);
    const result = await registerPatient(REGISTRATION_DRAFT, api as never, {
      today: "2026-08-25",
      nextMrnBase: () => 410_001 + index,
      nextUuid: sequentialUuid(roleId),
    });

    assert.equal(result.kind, "created");
    assert.equal(result.patient.resourceType, "Patient");
    assert.equal(api.accounts[0]?.status, "active");
  });
}

test("every practice role creates registration resources at practice scope and updates them at compartment scope", () => {
  for (const roleId of ["provider", "staff", "admin"] as const) {
    const policy = buildMedplumAccessPolicy(getRoleDeclaration(roleId));
    for (const resourceType of ["Patient", "RelatedPerson", "Coverage", "Account"]) {
      assert.equal(
        policyAllowsAtPracticeScope(policy, resourceType, "create"),
        true,
        `${roleId} must create ${resourceType} at practice scope during registration`,
      );
      assert.equal(
        policyAllowsWithCriteria(
          policy,
          resourceType,
          "update",
          `${resourceType}?_compartment=%patient_compartment`,
        ),
        true,
        `${roleId} must update ${resourceType} only through its patient compartment`,
      );
    }
  }
});

test("the practice-scoped Account exception finalizes only a fresh on-hold reservation", () => {
  for (const roleId of ["provider", "staff", "admin"] as const) {
    const policy = buildMedplumAccessPolicy(getRoleDeclaration(roleId));
    const reservation = account("on-hold");
    const finalized = account("active");

    assert.equal(
      practiceScopedAccountUpdateAllowed(policy, reservation, finalized),
      true,
      `${roleId} must finalize a fresh reservation`,
    );
    assert.equal(
      practiceScopedAccountUpdateAllowed(policy, account("active"), finalized),
      false,
      `${roleId} must not update an active Account through the registration exception`,
    );
    assert.equal(
      practiceScopedAccountUpdateAllowed(policy, undefined, finalized),
      false,
      `${roleId} must not use the update rule as a create path`,
    );
    assert.equal(
      practiceScopedAccountUpdateAllowed(policy, reservation, reservation),
      false,
      `${roleId} must transition the reservation to active`,
    );
  }
});

test("registration replaces a raw FHIR 403 with actionable permission guidance", async () => {
  await assert.rejects(
    reserveOdosMrn(
      {
        patientIdentifierExists: async () => false,
        createReservation: async () => {
          throw new Error("FHIR 403 : Forbidden");
        },
      },
      () => 420_001,
      () => "allocation-token",
    ),
    /Patient registration is not authorized.*practice administrator.*try again/i,
  );
});

class PolicyEnforcedRegistrationApi {
  readonly accounts: Account[] = [];
  private readonly patients = new Map<string, Patient>();
  private readonly policy: AccessPolicy;
  private accountSequence = 0;
  private patientSequence = 0;

  constructor(roleId: PracticeRoleId) {
    this.policy = buildMedplumAccessPolicy(getRoleDeclaration(roleId));
  }

  async search<T extends Resource>(): Promise<Bundle<T>> {
    return { resourceType: "Bundle", type: "searchset", entry: [] };
  }

  async create<T extends Resource>(
    resource: T,
    _sourceTag: string,
    headers: Record<string, string>,
  ): Promise<T> {
    assert.equal(resource.resourceType, "Account");
    assert.match(headers["If-None-Exist"] ?? "", /^identifier=/);
    this.assertAuthorized(resource, "create");
    const created = {
      ...structuredClone(resource as Account),
      id: `account-${++this.accountSequence}`,
      meta: { versionId: "1" },
    };
    this.accounts.push(created);
    return structuredClone(created) as T;
  }

  async executeTransaction(bundle: Bundle): Promise<Bundle> {
    const responseEntries = [];
    for (const entry of bundle.entry ?? []) {
      const resource = entry.resource;
      const method = entry.request?.method;
      assert.ok(resource && (method === "POST" || method === "PUT"));
      const before = method === "PUT" && resource.resourceType === "Account"
        ? this.accounts.find((candidate) => candidate.id === resource.id)
        : undefined;
      this.assertAuthorized(resource, method === "POST" ? "create" : "update", before);

      if (resource.resourceType === "Patient") {
        const id = `patient-${++this.patientSequence}`;
        this.patients.set(id, { ...structuredClone(resource), id, meta: { versionId: "1" } });
        responseEntries.push({ response: { status: "201 Created", location: `Patient/${id}/_history/1` } });
      } else if (resource.resourceType === "Account") {
        const index = this.accounts.findIndex((candidate) => candidate.id === resource.id);
        assert.notEqual(index, -1);
        this.accounts[index] = { ...structuredClone(resource), meta: { versionId: "2" } };
        responseEntries.push({ response: { status: "200 OK", location: `Account/${resource.id}/_history/2` } });
      } else {
        responseEntries.push({
          response: {
            status: "201 Created",
            location: `${resource.resourceType}/created/_history/1`,
          },
        });
      }
    }
    return { resourceType: "Bundle", type: "transaction-response", entry: responseEntries };
  }

  async read<T extends Resource>(resourceType: T["resourceType"], id: string): Promise<T> {
    assert.equal(resourceType, "Patient");
    const patient = this.patients.get(id);
    assert.ok(patient);
    return structuredClone(patient) as T;
  }

  private assertAuthorized(
    resource: Resource,
    interaction: "create" | "update",
    before?: Resource,
  ): void {
    const allowed = this.policy.resource?.some((rule) =>
      rule.resourceType === resource.resourceType
      && rule.interaction?.includes(interaction)
      && rule.criteria === undefined
      && writeConstraintsAllow(rule, before, resource)
    ) ?? false;
    if (!allowed) throw new Error(`FHIR 403 Forbidden: ${interaction} ${resource.resourceType}`);
  }
}

function practiceScopedAccountUpdateAllowed(
  policy: AccessPolicy,
  before: Account | undefined,
  after: Account,
): boolean {
  return policy.resource?.some((rule) =>
    rule.resourceType === "Account"
    && rule.interaction?.includes("update")
    && rule.criteria === undefined
    && writeConstraintsAllow(rule, before, after)
  ) ?? false;
}

function writeConstraintsAllow(
  rule: AccessPolicyResource,
  before: Resource | undefined,
  after: Resource,
): boolean {
  return (rule.writeConstraint ?? []).every((constraint) => {
    const result = fhirpath.evaluate(
      after,
      constraint.expression ?? "",
      { before: before ?? [], after },
      r4Model,
    );
    return result.length === 1 && result[0] === true;
  });
}

function policyAllowsAtPracticeScope(
  policy: AccessPolicy,
  resourceType: string,
  interaction: "create" | "update",
): boolean {
  return policy.resource?.some((rule) =>
    rule.resourceType === resourceType
    && rule.interaction?.includes(interaction)
    && rule.criteria === undefined
  ) ?? false;
}

function policyAllowsWithCriteria(
  policy: AccessPolicy,
  resourceType: string,
  interaction: "create" | "update",
  criteria: string,
): boolean {
  return policy.resource?.some((rule) =>
    rule.resourceType === resourceType
    && rule.interaction?.includes(interaction)
    && rule.criteria === criteria
  ) ?? false;
}

function account(status: Account["status"]): Account {
  return {
    resourceType: "Account",
    id: "account-1",
    identifier: [{ system: ODOS_MRN_SYSTEM, value: "4100014" }],
    status,
    name: "Synthetic registration account",
  };
}

function sequentialUuid(prefix: string): () => string {
  let sequence = 0;
  return () => `${prefix}-${++sequence}`;
}
