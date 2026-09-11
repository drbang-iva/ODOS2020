import assert from "node:assert/strict";
import { test } from "node:test";
import type { Bundle, ProjectMembership, ProjectMembershipAccess } from "@medplum/fhirtypes";
import { grantNewlyRegisteredPatientAccess } from "../src/authz/role-grants.js";
import { buildMedplumAccessPolicy, buildMedplumCompositeAccessPolicy, getRoleDeclaration } from "../src/authz/roles.js";

for (const composite of [false, true]) {
  test(`registration binds only the newly created Patient for ${composite ? "composite" : "standalone"} admin Consent`, async () => {
    const generated = composite ? buildMedplumCompositeAccessPolicy(["staff", "admin"]) : buildMedplumAccessPolicy(getRoleDeclaration("admin"));
    const policy = { ...generated, id: "role", meta: { ...generated.meta, project: "practice" } };
    const membership: ProjectMembership = { resourceType: "ProjectMembership", id: "member", meta: { versionId: "1" }, project: { reference: "Project/practice" }, profile: { reference: "Practitioner/admin" }, user: { reference: "User/admin" }, access: [{ policy: { reference: "AccessPolicy/role" } }] };
    const appended: ProjectMembershipAccess[] = [];
    const serviceFhir = {
      searchProject: async (type: string) => ({ resourceType: "Bundle", type: "searchset", entry: [{ resource: type === "Patient" ? { resourceType: "Patient", id: "new-patient", meta: { project: "practice" } } : type === "ProjectMembership" ? membership : policy }] }),
      patch: async (_type: string, _id: string, operations: Array<{ value: ProjectMembershipAccess }>) => { appended.push(...operations.map(op => op.value)); return membership; },
    } as unknown as Parameters<typeof grantNewlyRegisteredPatientAccess>[1]["serviceFhir"];
    const registrationRequest: Bundle = { resourceType: "Bundle", type: "transaction", entry: [{ resource: { resourceType: "Patient" }, request: { method: "POST", url: "Patient" } }] };
    const registrationResponse: Bundle = { resourceType: "Bundle", type: "transaction-response", entry: [{ response: { status: "201 Created", location: "Patient/new-patient/_history/1" } }] };
    const result = await grantNewlyRegisteredPatientAccess({ staffReference: "Practitioner/admin", project: { reference: "Project/practice" }, registrationRequest, registrationResponse }, { serviceFhir });
    assert.equal(result.changed, true);
    assert.equal(appended.length, 1);
    assert.deepEqual(appended[0]!.parameter?.filter(parameter => parameter.name.endsWith("patient_compartment")), composite ? [
      { name: "admin_patient_compartment", valueString: "Patient/new-patient" },
      { name: "staff_patient_compartment", valueString: "Patient/new-patient" },
    ] : [{ name: "patient_compartment", valueString: "Patient/new-patient" }]);
    assert.deepEqual(membership.access, [{ policy: { reference: "AccessPolicy/role" } }]);
  });
}
