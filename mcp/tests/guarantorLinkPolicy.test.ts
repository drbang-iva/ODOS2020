import assert from "node:assert/strict";
import { test } from "node:test";
import type { AccessPolicy, AccessPolicyResource, Person, Resource, Task } from "@medplum/fhirtypes";
import fhirpath from "fhirpath";
import r4Model from "fhirpath/fhir-context/r4/index.js";
import {
  buildMedplumAccessPolicy,
  buildMedplumCompositeAccessPolicy,
  effectiveBusinessActions,
  getRoleDeclaration,
  staffHasBusinessAction,
} from "../src/authz/roles.js";

const OPERATION_SYSTEM = "https://odos2020.com/fhir/CodeSystem/guarantor-link-operation";

function writeAllowed(policy: AccessPolicy, before: Resource | undefined, after: Resource): boolean {
  const interaction = before ? "update" : "create";
  return (policy.resource ?? []).some((rule: AccessPolicyResource) =>
    rule.resourceType === after.resourceType && rule.interaction?.includes(interaction) &&
    (rule.writeConstraint ?? []).every(({ expression }) => {
      const result = fhirpath.evaluate(after, expression ?? "", { before, after }, r4Model);
      return result.length === 1 && result[0] === true;
    }),
  );
}

for (const [name, policy] of [
  ["staff", buildMedplumAccessPolicy(getRoleDeclaration("staff"))],
  ["composite", buildMedplumCompositeAccessPolicy(["provider", "staff", "admin"])],
] as const) {
  test(`L17 ${name}: the Task fence refuses operation creation, mutation and code laundering`, () => {
    const operation: Task = {
      resourceType: "Task", id: "operation", intent: "order", status: "in-progress",
      code: { coding: [{ system: OPERATION_SYSTEM, code: "transfer" }] },
      input: [{ type: { text: "source" }, valueReference: { reference: "Person/source" } }],
    };
    const ordinary: Task = {
      resourceType: "Task", id: "ordinary", intent: "order", status: "in-progress",
      code: { coding: [{ system: "urn:odos:test:ordinary-task", code: "review" }] },
    };
    assert.equal(writeAllowed(policy, undefined, operation), false, "staff-authored operation");
    assert.equal(writeAllowed(policy, undefined, { ...operation, status: "completed" }), false, "forged completed history");
    assert.equal(writeAllowed(policy, operation, { ...operation, status: "failed" }), false, "terminal-state forgery");
    assert.equal(writeAllowed(policy, operation, { ...operation, input: [{ type: { text: "source" }, valueReference: { reference: "Person/other" } }] }), false, "plan laundering");
    assert.equal(writeAllowed(policy, operation, { ...operation, code: undefined }), false, "code removal");
    assert.equal(writeAllowed(policy, ordinary, { ...ordinary, code: operation.code }), false, "code introduction");
    assert.equal(writeAllowed(policy, undefined, ordinary), true, "ordinary Task create");
    assert.equal(writeAllowed(policy, ordinary, { ...ordinary, status: "completed" }), true, "ordinary Task update");
  });

  test(`L18 ${name}: the Person fence preserves name edits and refuses link mutations`, () => {
    const linked: Person = {
      resourceType: "Person", id: "party", name: [{ family: "Original" }],
      link: [{ target: { reference: "RelatedPerson/child" } }],
    };
    const empty: Person = { resourceType: "Person", id: "empty", name: [{ family: "Original" }] };
    assert.equal(writeAllowed(policy, linked, { ...linked, name: [{ family: "Updated" }] }), true, "linked name-only edit");
    assert.equal(writeAllowed(policy, empty, { ...empty, name: [{ family: "Updated" }] }), true, "empty-link name-only edit");
    assert.equal(writeAllowed(policy, linked, { ...linked, link: [{ target: { reference: "RelatedPerson/other" } }] }), false, "link replacement");
    assert.equal(writeAllowed(policy, linked, { ...linked, link: undefined }), false, "link removal");
    assert.equal(writeAllowed(policy, empty, { ...empty, link: linked.link }), false, "link introduction");
    assert.equal(writeAllowed(policy, undefined, linked), false, "create with links");
    assert.equal(writeAllowed(policy, undefined, empty), true, "create without links");
  });
}

test("Follow-up F4: staff cannot change Person active but can edit demographics while active is unchanged", () => {
  const policy = buildMedplumAccessPolicy(getRoleDeclaration("staff"));
  const before: Person = {
    resourceType: "Person",
    id: "party",
    active: true,
    name: [{ family: "Original" }],
    telecom: [{ system: "phone", value: "864-555-0102" }],
    address: [{ city: "Greenville" }],
  };
  assert.equal(writeAllowed(policy, before, { ...before, active: false }), false, "active-only edit");
  assert.equal(writeAllowed(policy, before, {
    ...before,
    name: [{ family: "Updated" }],
    telecom: [{ system: "phone", value: "864-555-0199" }],
    address: [{ city: "Travelers Rest" }],
  }), true, "demographics-only edit");
});

test("L19: each role grants guarantor.link and a membership revocation removes it", () => {
  for (const role of ["provider", "staff", "admin"] as const) {
    const enabled = effectiveBusinessActions([role], [], []);
    assert.equal(enabled.actions.includes("guarantor.link"), true, `${role} declares the action`);
    const revoked = effectiveBusinessActions([role], [], ["guarantor.link"]);
    assert.equal(revoked.malformed, false);
    assert.equal(revoked.actions.includes("guarantor.link"), false, `${role} revocation is effective`);
    assert.deepEqual(revoked.ignoredRevoked, []);
    assert.equal(staffHasBusinessAction({ actorRole: role, businessActions: revoked.actions }, "guarantor.link"), false);
  }
});
