import assert from "node:assert/strict";
import { test } from "node:test";
import type { AccessPolicyResource, Consent } from "@medplum/fhirtypes";
import { buildCommsConsent } from "../src/comms/comms-preferences.js";
import fhirpath from "fhirpath";
import r4Model from "fhirpath/fhir-context/r4/index.js";
import { BUSINESS_ACTIONS, GRANTABLE_BUSINESS_ACTIONS, PRACTICE_ROLE_IDS, buildMedplumAccessPolicy, buildMedplumCompositeAccessPolicy, getRoleDeclaration } from "../src/authz/roles.js";

function consent(): Consent {
  return { ...buildCommsConsent("Patient/example", [{ purpose: "education", channel: "email" }], "in-person", { actorReference: "Practitioner/staff", actorRole: "staff", recordedAt: "2026-09-11T00:00:00Z", surface: "staff-demographics" }), id: "evidence" };
}

function writable(rule: AccessPolicyResource, before: Consent | undefined, after: Consent): boolean {
  return (rule.writeConstraint ?? []).every(({ expression }) => {
    const result = fhirpath.evaluate(after, expression ?? "", { before, after }, r4Model);
    return result.length === 1 && result[0] === true;
  });
}

test("preference management is grantable and held by every practice role", () => {
  assert.ok((BUSINESS_ACTIONS as readonly string[]).includes("communications.preferences.manage"));
  assert.ok((GRANTABLE_BUSINESS_ACTIONS as readonly string[]).includes("communications.preferences.manage"));
  for (const role of PRACTICE_ROLE_IDS) assert.ok((getRoleDeclaration(role).businessActions as readonly string[]).includes("communications.preferences.manage"));
});

for (const role of PRACTICE_ROLE_IDS) {
  test(`${role} Consent access is scoped and permits only create, read, search and guarded update`, () => {
    const rules = buildMedplumAccessPolicy(getRoleDeclaration(role)).resource!.filter((rule) => rule.resourceType === "Consent");
    assert.ok(rules.length > 0);
    assert.deepEqual([...new Set(rules.flatMap((rule) => rule.interaction ?? []))].sort(), ["create", "read", "search", "update"]);
    for (const rule of rules) assert.equal(rule.criteria, "Consent?_compartment=%patient_compartment&category=https://odos2020.com/fhir/CodeSystem/consent-category|comms-consent&scope=http://terminology.hl7.org/CodeSystem/consentscope|patient-privacy");
    const rule = rules.find((entry) => entry.interaction?.includes("update"))!;
    assert.ok(rule.writeConstraint?.length);
    assert.equal(writable(rule, undefined, consent()), true);
    assert.equal(writable(rule, undefined, { ...consent(), category: [{ text: "Other consent" }] }), false);
    assert.equal(writable(rule, undefined, { ...consent(), scope: { text: "Other scope" } }), false);
    assert.equal(writable(rule, consent(), { ...consent(), status: "inactive" }), true);
    assert.equal(writable(rule, consent(), { ...consent(), meta: { versionId: "2", lastUpdated: "2026-09-11T00:00:00Z" } }), true);
    const changes: Record<string, unknown> = {
      id: "different", implicitRules: "urn:rules", language: "en", text: { status: "generated", div: "<div xmlns=\"http://www.w3.org/1999/xhtml\">Evidence</div>" },
      contained: [{ resourceType: "Patient", id: "contained" }], extension: [{ url: "urn:scope", valueString: "different" }], modifierExtension: [{ url: "urn:modifier", valueBoolean: true }], identifier: [{ value: "different" }],
      scope: { text: "different" }, category: [{ text: "different" }], patient: { reference: "Patient/other" }, dateTime: "2026-09-12T00:00:00Z", performer: [{ reference: "Practitioner/staff" }], organization: [{ reference: "Organization/practice" }],
      sourceAttachment: { title: "form" }, sourceReference: { reference: "DocumentReference/form" }, policy: [{ uri: "urn:policy" }], policyRule: { text: "different" }, verification: [{ verified: true }], provision: { type: "deny" },
    };
    for (const [field, value] of Object.entries(changes)) {
      const changed = { ...consent(), [field]: value } as Consent;
      assert.equal(writable(rule, consent(), changed), false, `${field} cannot be introduced or changed`);
      assert.equal(writable(rule, changed, consent()), false, `${field} cannot be removed or changed`);
      assert.equal(writable(rule, changed, { ...changed, status: "inactive" }), true, `${field} can remain unchanged`);
    }
    for (const field of ["profile", "security", "tag", "source", "extension", "id"]) {
      const meta = { [field]: field === "source" || field === "id" ? "changed" : [{ code: "changed" }] };
      assert.equal(writable(rule, consent(), { ...consent(), meta }), false, `meta.${field} cannot change`);
    }
    const nested = { ...consent(), extension: [{ url: "urn:scope", extension: [{ url: "purpose", valueString: "original" }] }] };
    const changedNested = structuredClone(nested);
    changedNested.extension[0].extension[0].valueString = "changed";
    assert.equal(writable(rule, nested, changedNested), false);
    const caseChange = { ...consent(), policy: [{ uri: consent().policy![0].uri!.toUpperCase() }] };
    assert.equal(writable(rule, consent(), caseChange), false);
  });
}

test("composite Consent update retains its write constraint", () => {
  const rules = buildMedplumCompositeAccessPolicy(["staff", "admin", "provider"]).resource!.filter((rule) => rule.resourceType === "Consent" && rule.interaction?.includes("update"));
  assert.ok(rules.length > 0);
  for (const rule of rules) {
    assert.ok(rule.writeConstraint?.length);
    assert.equal(writable(rule, consent(), { ...consent(), status: "inactive" }), true);
    assert.equal(writable(rule, consent(), { ...consent(), patient: { reference: "Patient/other" } }), false);
  }
});
