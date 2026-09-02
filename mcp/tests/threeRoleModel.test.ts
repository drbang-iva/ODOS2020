import assert from "node:assert/strict";
import { test } from "node:test";
import type { AccessPolicy, AccessPolicyResource, Encounter, MedicationRequest, Observation } from "@medplum/fhirtypes";
import fhirpath from "fhirpath";
import r4Model from "fhirpath/fhir-context/r4/index.js";
import {
  ODOS_PRACTICE_ROLE_SYSTEM,
  PRACTICE_ROLE_IDS,
  assertAestheticsProviderScope,
  assertBusinessActionAllowed,
  buildMedplumAccessPolicy,
  buildMedplumCompositeAccessPolicy,
  getRoleDeclaration,
} from "../src/authz/roles.js";

const DX_PICK_TALLY_CRITERIA =
  "Basic?code=https://odos2020.com/fhir/CodeSystem/odos-dx-pick-tally|odos-dx-pick-tally&identifier=https://odos2020.com/fhir/NamingSystem/dx-pick-tally-practitioner|%profile";

const CLINICAL_BASIC_CRITERIA = {
  complaintDefinition:
    "Basic?code=https://odos2020.com/fhir/CodeSystem/osod-complaint-definition|osod-complaint-definition",
  diagnosisDefinition:
    "Basic?code=https://odos2020.com/fhir/CodeSystem/odos-diagnosis-definition|odos-diagnosis-definition",
  encounterComplaint:
    "Basic?code=https://odos2020.com/fhir/CodeSystem/odos-encounter-complaint|odos-encounter-complaint",
  encounterSectionOverride:
    "Basic?code=https://odos2020.com/fhir/CodeSystem/odos-finding-section-group|odos-encounter-section-override",
  findingDefinition:
    "Basic?code=https://odos2020.com/fhir/CodeSystem/odos-finding-definition|odos-finding-definition",
  findingSectionGroup:
    "Basic?code=https://odos2020.com/fhir/CodeSystem/odos-finding-section-group|odos-finding-section-group",
  procedureDefinition:
    "Basic?code=https://odos2020.com/fhir/CodeSystem/odos-procedure-definition|odos-procedure-definition",
  procedureChargeRule:
    "Basic?code=https://odos2020.com/fhir/CodeSystem/odos-protocol-module|odos-procedure-charge-rule",
  planActionInstance:
    "Basic?code=https://odos2020.com/fhir/CodeSystem/odos-protocol-module|odos-plan-action-instance",
  protocolApplication:
    "Basic?code=https://odos2020.com/fhir/CodeSystem/odos-protocol-module|odos-protocol-application",
  chargeProposal:
    "Basic?code=https://odos2020.com/fhir/CodeSystem/odos-protocol-module|odos-charge-proposal",
  findingInstance:
    "Basic?code=https://odos2020.com/fhir/CodeSystem/odos-protocol-module|odos-finding-instance",
} as const;

const CHART_BASIC_CRITERIA = [
  CLINICAL_BASIC_CRITERIA.encounterComplaint,
  CLINICAL_BASIC_CRITERIA.encounterSectionOverride,
] as const;
const CONFIGURATION_BASIC_CRITERIA = [
  CLINICAL_BASIC_CRITERIA.complaintDefinition,
  CLINICAL_BASIC_CRITERIA.findingDefinition,
  CLINICAL_BASIC_CRITERIA.findingSectionGroup,
  CLINICAL_BASIC_CRITERIA.diagnosisDefinition,
  CLINICAL_BASIC_CRITERIA.procedureDefinition,
] as const;
const PROTOCOL_RUNTIME_BASIC_CRITERIA = [
  CLINICAL_BASIC_CRITERIA.planActionInstance,
  CLINICAL_BASIC_CRITERIA.protocolApplication,
  CLINICAL_BASIC_CRITERIA.chargeProposal,
  CLINICAL_BASIC_CRITERIA.findingInstance,
] as const;

const REPAIRED_WRITE_SURFACES = [
  { surface: "IOP Timeline target editor — Save an existing target", resourceType: "Goal", interaction: "update", roles: ["provider"] },
  { surface: "IOP Timeline target editor — Save a new target", resourceType: "Goal", interaction: "create", roles: ["provider"] },
  { surface: "Prescriptions — Send to pharmacy (reserve WENO message id)", resourceType: "MedicationRequest", interaction: "update", roles: ["provider", "staff"] },
  { surface: "Prescriptions — Send to pharmacy (record indeterminate outcome)", resourceType: "MedicationRequest", interaction: "update", roles: ["provider", "staff"] },
  { surface: "Prescriptions — Send to pharmacy (record successful transmission)", resourceType: "MedicationRequest", interaction: "update", roles: ["provider", "staff"] },
  { surface: "Prescriptions — Send to pharmacy (record WENO error)", resourceType: "MedicationRequest", interaction: "update", roles: ["provider", "staff"] },
  { surface: "Prescriptions — Pharmacy verified not received — clear reservation", resourceType: "MedicationRequest", interaction: "update", roles: ["provider", "staff"] },
  { surface: "Dry Eye > Adverse Event — Capture", resourceType: "AdverseEvent", interaction: "create", roles: ["provider"] },
  { surface: "Ortho-K > Adverse Event — Capture", resourceType: "AdverseEvent", interaction: "create", roles: ["provider"] },
  { surface: "Prescriptions — Add prescription", resourceType: "MedicationRequest", interaction: "create", roles: ["provider", "staff"] },
  { surface: "Chart sidebar > Allergies — Mark no known allergies", resourceType: "AllergyIntolerance", interaction: "create", roles: ["provider", "staff"] },
  { surface: "Chart sidebar > Allergies — Add allergy", resourceType: "AllergyIntolerance", interaction: "create", roles: ["provider", "staff"] },
  { surface: "Chart sidebar > Care Team — Add team member", resourceType: "CareTeam", interaction: "create", roles: ["provider", "staff"] },
  { surface: "Diagnosis workspace/assessment — add an eye-specific diagnosis or save diagnosis laterality", resourceType: "BodyStructure", interaction: "create", roles: ["provider"] },
] as const;

for (const expected of REPAIRED_WRITE_SURFACES) {
  test(`compiled policy and grant-removal mutation: ${expected.surface}`, () => {
    const criteria = `${expected.resourceType}?_compartment=%patient_compartment`;
    for (const roleId of PRACTICE_ROLE_IDS) {
      const policy = buildMedplumAccessPolicy(getRoleDeclaration(roleId));
      const shouldAllow = expected.roles.includes(roleId as never);
      const assertSurfaceGrant = (candidate: AccessPolicy) => assert.equal(
        accessPolicyAllows(candidate, expected.resourceType, expected.interaction, criteria),
        shouldAllow,
        `${expected.surface}: ${roleId} ${expected.interaction}`,
      );
      assertSurfaceGrant(policy);

      if (shouldAllow) {
        const mutated: AccessPolicy = {
          ...policy,
          resource: policy.resource?.filter((rule) => !(
            rule.resourceType === expected.resourceType
            && rule.interaction?.includes(expected.interaction)
            && rule.criteria === criteria
          )),
        };
        assert.throws(
          () => assertSurfaceGrant(mutated),
          /false !== true/,
          `${expected.surface}: removing the exact grant must turn the same surface assertion RED for ${roleId}`,
        );
      }
    }
  });
}

test("Staff MedicationRequest edits stop after electronic transmission while requester and recorder stay pinned", () => {
  const staff = buildMedplumAccessPolicy(getRoleDeclaration("staff"));
  const updateRule = staff.resource?.find((candidate) =>
    candidate.resourceType === "MedicationRequest"
    && candidate.interaction?.includes("update")
    && candidate.criteria === "MedicationRequest?_compartment=%patient_compartment"
  );
  const createRule = staff.resource?.find((candidate) =>
    candidate.resourceType === "MedicationRequest"
    && candidate.interaction?.includes("create")
    && candidate.criteria === "MedicationRequest?_compartment=%patient_compartment"
  );
  assert.ok(updateRule?.writeConstraint?.length, "Staff MedicationRequest update needs a writeConstraint");
  assert.ok(createRule, "Staff must be able to create MedicationRequest");

  const before: MedicationRequest = {
    resourceType: "MedicationRequest",
    id: "rx-1",
    status: "active",
    intent: "order",
    medicationCodeableConcept: { coding: [{ system: "http://www.nlm.nih.gov/research/umls/rxnorm", code: "fixture-a" }] },
    subject: { reference: "Patient/p1" },
    requester: { reference: "Practitioner/provider-1" },
    recorder: { reference: "Practitioner/staff-1" },
    authoredOn: "2026-08-17",
    dosageInstruction: [{ text: "fixture dose" }],
    dispenseRequest: {
      quantity: { value: 1, unit: "bottle" },
      numberOfRepeatsAllowed: 1,
      expectedSupplyDuration: { value: 30, unit: "days" },
    },
    substitution: { allowedBoolean: false },
    extension: [{
      url: "https://odos2020.com/fhir/StructureDefinition/odos-transmission-method",
      valueCode: "printed",
    }],
  };
  const preTransmissionRepeatEdit: MedicationRequest = {
    ...structuredClone(before),
    dispenseRequest: { ...structuredClone(before.dispenseRequest), numberOfRepeatsAllowed: 2 },
  };
  assert.equal(
    ruleAllowsWrite(updateRule, before, preTransmissionRepeatEdit),
    true,
    "Staff may edit repeats before transmission",
  );

  for (const method of [undefined, "printed", "phoned-in"] as const) {
    const ordinary = structuredClone(before);
    ordinary.extension = method === undefined
      ? undefined
      : ordinary.extension?.map((entry) => ({ ...entry, valueCode: method }));
    const changed = structuredClone(ordinary);
    changed.dispenseRequest!.numberOfRepeatsAllowed = 3;
    assert.equal(
      ruleAllowsWrite(updateRule, ordinary, changed),
      true,
      `Staff may edit an ordinary ${method ?? "unmarked"} prescription`,
    );
  }

  const transmitted = structuredClone(before);
  transmitted.extension = transmitted.extension?.map((entry) => ({ ...entry, valueCode: "electronically-sent" }));
  const transmittedMutations: Array<readonly [string, (resource: MedicationRequest) => void]> = [
    ["numberOfRepeatsAllowed", (resource) => { resource.dispenseRequest!.numberOfRepeatsAllowed = 4; }],
    ["quantity", (resource) => { resource.dispenseRequest!.quantity = { value: 2, unit: "bottle" }; }],
    ["expectedSupplyDuration", (resource) => { resource.dispenseRequest!.expectedSupplyDuration = { value: 60, unit: "days" }; }],
    ["dosageInstruction", (resource) => { resource.dosageInstruction = [{ text: "changed" }]; }],
    ["substitution", (resource) => { resource.substitution = { allowedBoolean: true }; }],
  ];
  for (const [field, mutate] of transmittedMutations) {
    const changed = structuredClone(transmitted);
    mutate(changed);
    assert.equal(ruleAllowsWrite(updateRule, transmitted, changed), false, `Staff must not change transmitted ${field}`);

    const withoutTransmissionLock: AccessPolicyResource = {
      ...updateRule,
      writeConstraint: updateRule.writeConstraint?.filter((constraint) =>
        !constraint.description?.includes("electronically transmitted")
      ),
    };
    assert.equal(
      ruleAllowsWrite(withoutTransmissionLock, transmitted, changed),
      true,
      `mutation control: removing the transmission clause must turn ${field} denial RED`,
    );
  }

  const requesterChanged = structuredClone(before);
  requesterChanged.requester = { reference: "Practitioner/provider-2" };
  assert.equal(ruleAllowsWrite(updateRule, before, requesterChanged), false, "Staff must not change requester");
  const withoutRequesterPin: AccessPolicyResource = {
    ...updateRule,
    writeConstraint: updateRule.writeConstraint?.filter((constraint) =>
      !constraint.description?.includes("requester")
    ),
  };
  assert.equal(
    ruleAllowsWrite(withoutRequesterPin, before, requesterChanged),
    true,
    "mutation control: removing the requester clause must turn requester denial RED",
  );

  const recorderChanged = structuredClone(before);
  recorderChanged.recorder = { reference: "Practitioner/staff-2" };
  assert.equal(ruleAllowsWrite(updateRule, before, recorderChanged), false, "Staff must not change recorder");
});

test("no practice role can create AuditEvent or read AdverseEvent speculatively", () => {
  for (const roleId of PRACTICE_ROLE_IDS) {
    const policy = buildMedplumAccessPolicy(getRoleDeclaration(roleId));
    assert.equal(accessPolicyAllows(policy, "AuditEvent", "create"), false, `${roleId} AuditEvent create`);
    assert.equal(accessPolicyAllows(policy, "AdverseEvent", "read"), false, `${roleId} AdverseEvent read`);
    assert.equal(accessPolicyAllows(policy, "AdverseEvent", "search"), false, `${roleId} AdverseEvent search`);
  }
});

test("the active practice-role catalog contains only Provider, Staff, and Admin", () => {
  assert.deepEqual(PRACTICE_ROLE_IDS, ["provider", "staff", "admin"]);
  assert.equal(ODOS_PRACTICE_ROLE_SYSTEM, "https://odos2020.com/fhir/NamingSystem/practice-role");
  assert.deepEqual(
    PRACTICE_ROLE_IDS.map((roleId) => getRoleDeclaration(roleId).display),
    ["Provider", "Staff", "Admin / Manager"],
  );
});

test("correction authority stays clinical for Provider and financial or inventory for Admin", () => {
  for (const action of ["clinical.sign", "aesthetics.procedure.write"] as const) {
    assert.doesNotThrow(() => assertBusinessActionAllowed("provider", action));
    assert.throws(() => assertBusinessActionAllowed("staff", action), /lacks business action/);
    assert.throws(() => assertBusinessActionAllowed("admin", action), /lacks business action/);
  }

  for (const action of [
    "payment.void",
    "payment.seal-day",
    "margin.read",
    "inventory.adjust",
    "inventory.price",
  ] as const) {
    assert.doesNotThrow(() => assertBusinessActionAllowed("admin", action));
    assert.throws(() => assertBusinessActionAllowed("staff", action), /lacks business action/);
    assert.throws(() => assertBusinessActionAllowed("provider", action), /lacks business action/);
  }

  for (const roleId of PRACTICE_ROLE_IDS) {
    assert.doesNotThrow(() => assertBusinessActionAllowed(roleId, "chart.read"));
  }
  for (const roleId of ["staff", "provider"] as const) {
    assert.doesNotThrow(() => assertBusinessActionAllowed(roleId, "payment.charge"));
  }
});

test("all roles read operational records at practice scope while Staff writes stay constrained", () => {
  for (const roleId of PRACTICE_ROLE_IDS) {
    const policy = buildMedplumAccessPolicy(getRoleDeclaration(roleId));
    for (const resourceType of [
      "Patient",
      "Observation",
      "Coverage",
      "Schedule",
      "PaymentReconciliation",
    ]) {
      const readRule = policy.resource?.find((rule) =>
        rule.resourceType === resourceType &&
        rule.interaction?.includes("read") &&
        rule.interaction?.includes("search") &&
        !rule.interaction?.includes("create") &&
        !rule.interaction?.includes("update"));
      assert.ok(readRule, `${roleId} needs a read-only ${resourceType} rule`);
      assert.equal(readRule.criteria, undefined, `${roleId} ${resourceType} read must be practice-scoped`);
    }
  }

  const staff = buildMedplumAccessPolicy(getRoleDeclaration("staff"));
  const patientWrite = staff.resource?.find((rule) =>
    rule.resourceType === "Patient" && rule.interaction?.includes("update"));
  assert.equal(patientWrite?.criteria, "Patient?_compartment=%patient_compartment");

  const observationWrite = staff.resource?.find((rule) =>
    rule.resourceType === "Observation" && rule.interaction?.includes("update"));
  assert.equal(observationWrite?.criteria, "Observation?_compartment=%patient_compartment");
  assert.match(
    observationWrite?.writeConstraint?.map((constraint) => constraint.expression).join(" ") ?? "",
    /status = 'preliminary'/,
  );
  assert.doesNotMatch(
    observationWrite?.writeConstraint?.map((constraint) => constraint.expression).join(" ") ?? "",
    /status = 'amended'/,
  );
});

test("compiled three-role policies grant chart sidebar and protocol reads at practice scope", () => {
  for (const roleId of PRACTICE_ROLE_IDS) {
    const policy = buildMedplumAccessPolicy(getRoleDeclaration(roleId));
    for (const resourceType of [
      "AllergyIntolerance",
      "Goal",
      "MedicationRequest",
      "PlanDefinition",
    ]) {
      const readRule = policy.resource?.find((rule) =>
        rule.resourceType === resourceType &&
        !rule.interaction?.includes("create") &&
        !rule.interaction?.includes("update"));

      assert.deepEqual(readRule?.interaction, ["read", "search", "history", "vread"], `${roleId} ${resourceType}`);
      assert.equal(readRule?.criteria, undefined, `${roleId} ${resourceType} read must be practice-scoped`);
    }
  }
});

test("diagnosis pick tallies stay profile-fenced with read and write grants split by chart authority", () => {
  for (const roleId of PRACTICE_ROLE_IDS) {
    const policy = buildMedplumAccessPolicy(getRoleDeclaration(roleId));
    for (const interaction of ["read", "search"] as const) {
      assert.equal(
        accessPolicyAllows(policy, "Basic", interaction, DX_PICK_TALLY_CRITERIA),
        true,
        `${roleId} must ${interaction} only its own diagnosis pick tally`,
      );
    }
    for (const interaction of ["create", "update"] as const) {
      assert.equal(
        accessPolicyAllows(policy, "Basic", interaction, DX_PICK_TALLY_CRITERIA),
        roleId !== "admin",
        `${roleId} ${interaction} must follow chart.write authority`,
      );
    }
  }
});

test("Provider clinical Basic grants cover chart records and procedure charge authoring", () => {
  const policy = buildMedplumAccessPolicy(getRoleDeclaration("provider"));
  const criteria = [...CHART_BASIC_CRITERIA, CLINICAL_BASIC_CRITERIA.procedureChargeRule];
  assertBasicReadWriteCriteria(policy, criteria, "provider");
  assertBasicReadCriteria(policy, CONFIGURATION_BASIC_CRITERIA, "provider");
  assertDeletedBasicGrantTurnsRed(policy, CLINICAL_BASIC_CRITERIA.encounterComplaint, "provider");
});

test("Staff clinical Basic grants cover chart records and protocol runtime records", () => {
  const policy = buildMedplumAccessPolicy(getRoleDeclaration("staff"));
  const criteria = [...CHART_BASIC_CRITERIA, ...PROTOCOL_RUNTIME_BASIC_CRITERIA];
  assertBasicReadWriteCriteria(policy, criteria, "staff");
  assertBasicReadCriteria(policy, CONFIGURATION_BASIC_CRITERIA, "staff");
  assertDeletedBasicGrantTurnsRed(policy, CLINICAL_BASIC_CRITERIA.protocolApplication, "staff");
});

test("Admin clinical Basic grants cover configuration and procedure charge authoring", () => {
  const policy = buildMedplumAccessPolicy(getRoleDeclaration("admin"));
  const criteria = [...CONFIGURATION_BASIC_CRITERIA, CLINICAL_BASIC_CRITERIA.procedureChargeRule];
  assertBasicReadWriteCriteria(policy, criteria, "admin");
  assertDeletedBasicGrantTurnsRed(policy, CLINICAL_BASIC_CRITERIA.findingDefinition, "admin");
});

test("clinical Basic grants remain criteria-fenced to their approved role tier", () => {
  const provider = buildMedplumAccessPolicy(getRoleDeclaration("provider"));
  const staff = buildMedplumAccessPolicy(getRoleDeclaration("staff"));
  const admin = buildMedplumAccessPolicy(getRoleDeclaration("admin"));

  for (const criteria of CONFIGURATION_BASIC_CRITERIA) {
    assert.equal(basicPolicyAllows(provider, "create", criteria), false, `provider must not create ${criteria}`);
    assert.equal(basicPolicyAllows(staff, "create", criteria), false, `staff must not create ${criteria}`);
  }
  assert.equal(
    basicPolicyAllows(staff, "create", CLINICAL_BASIC_CRITERIA.procedureChargeRule),
    false,
    "staff must not create procedure charge rules",
  );
  for (const criteria of CHART_BASIC_CRITERIA) {
    assert.equal(basicPolicyAllows(admin, "create", criteria), false, `admin must not create ${criteria}`);
  }
});

test("Door 1 actor gating leaves Provider, Staff, and Admin Appointment reads practice-wide", () => {
  for (const roleId of ["provider", "staff", "admin"] as const) {
    const policy = buildMedplumAccessPolicy(getRoleDeclaration(roleId));
    const appointmentReads = policy.resource?.filter((rule) =>
      rule.resourceType === "Appointment" && rule.interaction?.includes("read")) ?? [];
    assert.equal(
      appointmentReads.some((rule) => rule.criteria === undefined),
      true,
      `${roleId} keeps its existing practice-wide scheduling read`,
    );
  }
});

test("three-role policies allow only Admin to write HealthcareService without wildcard or delete", () => {
  const adminPolicy = buildMedplumAccessPolicy(getRoleDeclaration("admin"));
  assert.equal(
    adminPolicy.resource?.some((rule) => rule.resourceType === "*"),
    false,
    "the retired practice-admin wildcard must not return",
  );

  for (const interaction of ["create", "update"] as const) {
    assert.equal(
      accessPolicyAllows(adminPolicy, "HealthcareService", interaction),
      true,
      `Admin must be permitted to ${interaction} HealthcareService`,
    );
    for (const roleId of ["staff", "provider"] as const) {
      const policy = buildMedplumAccessPolicy(getRoleDeclaration(roleId));
      assert.equal(
        accessPolicyAllows(policy, "HealthcareService", interaction),
        false,
        `${roleId} must be rejected from ${interaction} HealthcareService`,
      );
    }
  }

  for (const roleId of PRACTICE_ROLE_IDS) {
    const policy = buildMedplumAccessPolicy(getRoleDeclaration(roleId));
    assert.equal(
      accessPolicyAllows(policy, "HealthcareService", "delete"),
      false,
      `${roleId} must be rejected from deleting HealthcareService`,
    );
  }
});

test("three-role policies allow only Admin to write the visit-type category singleton", () => {
  const criteria =
    "Basic?code=https://odos2020.com/fhir/CodeSystem/visit-type-config|odos-visit-type-config";
  const adminPolicy = buildMedplumAccessPolicy(getRoleDeclaration("admin"));

  assert.equal(
    adminPolicy.resource?.some((rule) => rule.resourceType === "*"),
    false,
    "the retired practice-admin wildcard must not return",
  );

  for (const interaction of ["create", "update"] as const) {
    assert.equal(
      accessPolicyAllows(adminPolicy, "Basic", interaction, criteria),
      true,
      `Admin must be permitted to ${interaction} the visit-type category singleton`,
    );
    for (const roleId of ["provider", "staff"] as const) {
      const policy = buildMedplumAccessPolicy(getRoleDeclaration(roleId));
      assert.equal(
        accessPolicyAllows(policy, "Basic", interaction, criteria),
        false,
        `${roleId} must be rejected from ${interaction} of the visit-type category singleton`,
      );
    }
  }
});

test("compiled three-role policies grant ChargeItemDefinition reads and reserve writes for Admin", () => {
  for (const roleId of PRACTICE_ROLE_IDS) {
    const policy = buildMedplumAccessPolicy(getRoleDeclaration(roleId));
    for (const interaction of ["read", "search"] as const) {
      assert.equal(
        accessPolicyAllows(policy, "ChargeItemDefinition", interaction),
        true,
        `${roleId} must be permitted to ${interaction} ChargeItemDefinition`,
      );
    }
  }

  const adminPolicy = buildMedplumAccessPolicy(getRoleDeclaration("admin"));
  for (const interaction of ["create", "update"] as const) {
    assert.equal(
      accessPolicyAllows(adminPolicy, "ChargeItemDefinition", interaction),
      true,
      `admin must be permitted to ${interaction} ChargeItemDefinition`,
    );
    for (const roleId of ["provider", "staff"] as const) {
      const policy = buildMedplumAccessPolicy(getRoleDeclaration(roleId));
      assert.equal(
        accessPolicyAllows(policy, "ChargeItemDefinition", interaction),
        false,
        `${roleId} must be refused ${interaction} ChargeItemDefinition`,
      );
    }
  }
});

test("compiled Provider and Staff policies create Provenance at practice scope without widening clinical writes", () => {
  const compartmentCriteria = {
    Condition: "Condition?_compartment=%patient_compartment",
    Encounter: "Encounter?_compartment=%patient_compartment",
    Observation: "Observation?_compartment=%patient_compartment",
  } as const;

  for (const roleId of ["provider", "staff"] as const) {
    const policy = buildMedplumAccessPolicy(getRoleDeclaration(roleId));
    assert.equal(
      accessPolicyAllows(policy, "Provenance", "create"),
      true,
      `${roleId} must be permitted to create Provenance`,
    );
    const provenanceCreate = policy.resource?.find((rule) =>
      rule.resourceType === "Provenance" && rule.interaction?.includes("create"));
    assert.equal(
      provenanceCreate?.criteria,
      undefined,
      `${roleId} Provenance create must be practice-scoped`,
    );

    const clinicalResourceTypes = roleId === "provider"
      ? (["Condition", "Encounter", "Observation"] as const)
      : (["Encounter", "Observation"] as const);
    for (const resourceType of clinicalResourceTypes) {
      const clinicalWrite = policy.resource?.find((rule) =>
        rule.resourceType === resourceType &&
        (rule.interaction?.includes("create") || rule.interaction?.includes("update")));
      assert.equal(
        clinicalWrite?.criteria,
        compartmentCriteria[resourceType],
        `${roleId} ${resourceType} writes must remain patient-compartment-scoped`,
      );
    }
  }
});

test("three-role policies allow only Admin to read AccessPolicy at practice scope without write access or wildcard", () => {
  const adminPolicy = buildMedplumAccessPolicy(getRoleDeclaration("admin"));
  const adminRule = adminPolicy.resource?.find((rule) => rule.resourceType === "AccessPolicy");
  assert.ok(adminRule, "Admin needs an explicit AccessPolicy rule");
  assert.equal(adminRule.criteria, undefined, "Admin AccessPolicy reads must be practice-scoped");
  assert.equal(
    adminPolicy.resource?.some((rule) => rule.resourceType === "*"),
    false,
    "the retired practice-admin wildcard must not return",
  );

  for (const interaction of ["read", "search", "history", "vread"] as const) {
    assert.equal(
      accessPolicyAllows(adminPolicy, "AccessPolicy", interaction),
      true,
      `Admin must be permitted to ${interaction} AccessPolicy`,
    );
    for (const roleId of ["provider", "staff"] as const) {
      const policy = buildMedplumAccessPolicy(getRoleDeclaration(roleId));
      assert.equal(
        accessPolicyAllows(policy, "AccessPolicy", interaction),
        false,
        `${roleId} must be rejected from ${interaction} AccessPolicy`,
      );
      assert.equal(
        policy.resource?.some((rule) => rule.resourceType === "*"),
        false,
        `${roleId} must not regain a wildcard`,
      );
    }
  }

  for (const interaction of ["create", "update", "delete"] as const) {
    assert.equal(
      accessPolicyAllows(adminPolicy, "AccessPolicy", interaction),
      false,
      `Admin must be rejected from ${interaction} AccessPolicy`,
    );
  }
});

test("Staff Encounter writes allow unfinished work but reject finalization and reopening", () => {
  const staff = buildMedplumAccessPolicy(getRoleDeclaration("staff"));
  const encounterWrite = staff.resource?.find((rule) =>
    rule.resourceType === "Encounter" && rule.interaction?.includes("update"));
  assert.ok(encounterWrite?.writeConstraint?.length);

  assert.equal(staffEncounterWriteAllowed(encounterWrite.writeConstraint, undefined, "in-progress"), true);
  assert.equal(staffEncounterWriteAllowed(encounterWrite.writeConstraint, "planned", "in-progress"), true);
  assert.equal(staffEncounterWriteAllowed(encounterWrite.writeConstraint, "in-progress", "finished"), false);
  assert.equal(staffEncounterWriteAllowed(encounterWrite.writeConstraint, "finished", "in-progress"), false);
});

test("real Provider and Staff Observation writeConstraints permit voiding a preliminary finding", () => {
  const before: Observation = { resourceType: "Observation", status: "preliminary", code: { text: "Synthetic draft" } };
  const after: Observation = { ...before, status: "entered-in-error" };

  for (const roleId of ["provider", "staff"] as const) {
    const policy = buildMedplumAccessPolicy(getRoleDeclaration(roleId));
    const observationWrite = policy.resource?.find((rule) =>
      rule.resourceType === "Observation" && rule.interaction?.includes("update"));
    assert.ok(observationWrite?.writeConstraint?.length, `${roleId} Observation update needs writeConstraints`);
    assert.equal(
      observationWrite.writeConstraint.every((constraint) => {
        const result = fhirpath.evaluate(after, constraint.expression ?? "", { before, after }, r4Model);
        return result.length === 1 && result[0] === true;
      }),
      true,
      `${roleId} writeConstraints must accept preliminary -> entered-in-error`,
    );
  }
});

test("Provider and Staff compile to one order-independent policy without changing clinical compartment criteria", () => {
  const providerThenStaff = buildMedplumCompositeAccessPolicy(["provider", "staff"]);
  const staffThenProvider = buildMedplumCompositeAccessPolicy(["staff", "provider"]);

  assert.deepEqual(staffThenProvider, providerThenStaff);
  assert.deepEqual(
    providerThenStaff.meta?.tag,
    [
      { system: ODOS_PRACTICE_ROLE_SYSTEM, code: "provider" },
      { system: ODOS_PRACTICE_ROLE_SYSTEM, code: "staff" },
    ],
  );
  const tallyRules = providerThenStaff.resource?.filter((rule) =>
    rule.resourceType === "Basic" && rule.criteria === DX_PICK_TALLY_CRITERIA
  ) ?? [];
  assert.deepEqual(
    tallyRules.map((rule) => rule.interaction).sort(),
    [["create"], ["history"], ["read"], ["search"], ["update"], ["vread"]],
    "the built-in %profile variable must survive composite compilation without role namespacing",
  );

  const compositeEncounterWrite = providerThenStaff.resource?.find((rule) =>
    rule.resourceType === "Encounter" && rule.interaction?.includes("update"));
  assert.ok(compositeEncounterWrite);
  assert.equal(
    compositeEncounterWrite.criteria,
    "Encounter?_compartment=%provider_patient_compartment",
  );
  assert.equal(
    staffEncounterWriteAllowed(compositeEncounterWrite.writeConstraint ?? [], "finished", "finished"),
    true,
  );

  const compositeObservationWrites = providerThenStaff.resource?.filter((rule) =>
    rule.resourceType === "Observation" && rule.interaction?.includes("update")
  ) ?? [];
  assert.deepEqual(
    compositeObservationWrites.map((rule) => rule.criteria),
    [
      "Observation?_compartment=%provider_patient_compartment",
      "Observation?_compartment=%staff_patient_compartment",
    ],
  );
  for (const rule of compositeObservationWrites) {
    for (const constraint of rule.writeConstraint ?? []) {
      assert.doesNotThrow(() => fhirpath.evaluate(
        { resourceType: "Observation", status: "final", code: { text: "synthetic" } },
        constraint.expression ?? "",
        { before: [], after: { resourceType: "Observation", status: "final" } },
      ));
    }
  }

  const clinicalCriteria = {
    provider: {
      Condition: "Condition?_compartment=%patient_compartment",
      Encounter: "Encounter?_compartment=%patient_compartment",
      Observation: "Observation?_compartment=%patient_compartment",
    },
    staff: {
      Condition: undefined,
      Encounter: "Encounter?_compartment=%patient_compartment",
      Observation: "Observation?_compartment=%patient_compartment",
    },
  } as const;
  for (const roleId of ["provider", "staff"] as const) {
    const policy = buildMedplumAccessPolicy(getRoleDeclaration(roleId));
    for (const resourceType of ["Condition", "Encounter", "Observation"] as const) {
      const rule = policy.resource?.find((candidate) =>
        candidate.resourceType === resourceType && candidate.interaction?.includes("update")
      );
      assert.equal(rule?.criteria, clinicalCriteria[roleId][resourceType]);
    }
  }
});

test("Admin and Provider composites preserve Provider amendment and Admin-only capabilities", () => {
  const composite = buildMedplumCompositeAccessPolicy(["staff", "provider", "admin"]);
  const encounterUpdate = composite.resource?.find((rule) =>
    rule.resourceType === "Encounter" && rule.interaction?.includes("update")
  );
  const accessPolicyRead = composite.resource?.find((rule) =>
    rule.resourceType === "AccessPolicy" && rule.interaction?.includes("read")
  );

  assert.ok(encounterUpdate);
  assert.equal(
    encounterUpdate.criteria,
    "Encounter?_compartment=%provider_patient_compartment",
    "Provider finished-Encounter amendment must survive an Admin role",
  );
  assert.equal(encounterUpdate.writeConstraint, undefined);
  assert.ok(accessPolicyRead, "Admin-only AccessPolicy read must survive composite compilation");
});

test("Admin has no wildcard write bypass and Staff inventory writes cannot correct counts or prices", () => {
  const admin = buildMedplumAccessPolicy(getRoleDeclaration("admin"));
  assert.equal(
    admin.resource?.some((rule) =>
      rule.resourceType === "*" &&
      (rule.interaction?.includes("create") || rule.interaction?.includes("update") || rule.interaction?.includes("delete"))),
    false,
  );

  const staff = buildMedplumAccessPolicy(getRoleDeclaration("staff"));
  const unitRules = staff.resource?.filter((rule) =>
    rule.resourceType === "Basic" && rule.criteria?.endsWith("|practice-frame-inventory-unit")) ?? [];
  assert.equal(unitRules.some((rule) => rule.interaction?.includes("delete")), false);
  assert.equal(unitRules.some((rule) => rule.interaction?.includes("create")), true);
  assert.equal(unitRules.some((rule) => rule.interaction?.includes("update")), true);
  assert.match(
    unitRules.flatMap((rule) => rule.writeConstraint ?? []).map((constraint) => constraint.expression).join(" "),
    /received-at/,
  );

  const settingsRules = staff.resource?.filter((rule) =>
    rule.resourceType === "Basic" && rule.criteria?.endsWith("|practice-frame-variant-settings")) ?? [];
  assert.equal(settingsRules.some((rule) => rule.interaction?.includes("create")), false);
  assert.equal(settingsRules.some((rule) => rule.interaction?.includes("update")), false);
  assert.equal(settingsRules.some((rule) => rule.interaction?.includes("read")), true);
});

test("aesthetics license and procedure scope is a Provider membership parameter", () => {
  const provider = getRoleDeclaration("provider");
  assert.deepEqual(
    provider.membershipParameters?.map((parameter) => parameter.name),
    ["provider_profile", "patient_compartment", "license_state", "procedure_scope"],
  );
  assert.doesNotThrow(() => assertAestheticsProviderScope({
    roleId: "provider",
    licensedStates: ["TX"],
    requestedState: "TX",
    procedureType: "injectables",
    allowedProcedureTypesByState: { TX: ["injectables"] },
  }));
});

function staffEncounterWriteAllowed(
  constraints: NonNullable<AccessPolicyResource["writeConstraint"]>,
  beforeStatus: Encounter["status"] | undefined,
  afterStatus: Encounter["status"],
): boolean {
  const before = beforeStatus ? { resourceType: "Encounter" as const, status: beforeStatus } : undefined;
  const after: Encounter = { resourceType: "Encounter", status: afterStatus, class: { code: "AMB" } };

  return constraints.every((constraint) => {
    const result = fhirpath.evaluate(after, constraint.expression ?? "", {
      before: before ?? [],
      after,
    });
    return result.length === 1 && result[0] === true;
  });
}

function accessPolicyAllows(
  policy: AccessPolicy,
  resourceType: string,
  interaction: NonNullable<AccessPolicyResource["interaction"]>[number],
  criteria?: string,
): boolean {
  return policy.resource?.some(
    (rule) =>
      (rule.resourceType === resourceType || rule.resourceType === "*") &&
      rule.interaction?.includes(interaction) &&
      (criteria === undefined || rule.criteria === criteria),
  ) ?? false;
}

function basicPolicyAllows(
  policy: AccessPolicy,
  interaction: "create" | "read" | "search" | "update",
  criteria: string,
): boolean {
  return policy.resource?.some((rule) =>
    (rule.resourceType === "Basic" || rule.resourceType === "*")
    && rule.interaction?.includes(interaction)
    && (rule.criteria === undefined || rule.criteria === criteria)
  ) ?? false;
}

function assertBasicReadWriteCriteria(
  policy: AccessPolicy,
  criteriaList: readonly string[],
  roleId: string,
): void {
  for (const criteria of criteriaList) {
    for (const interaction of ["read", "search", "create", "update"] as const) {
      assert.equal(
        basicPolicyAllows(policy, interaction, criteria),
        true,
        `${roleId} must ${interaction} ${criteria}`,
      );
    }
  }
}

function assertBasicReadCriteria(
  policy: AccessPolicy,
  criteriaList: readonly string[],
  roleId: string,
): void {
  for (const criteria of criteriaList) {
    for (const interaction of ["read", "search"] as const) {
      assert.equal(
        basicPolicyAllows(policy, interaction, criteria),
        true,
        `${roleId} must ${interaction} ${criteria}`,
      );
    }
  }
}

function assertDeletedBasicGrantTurnsRed(
  policy: AccessPolicy,
  criteria: string,
  roleId: string,
): void {
  const mutated: AccessPolicy = {
    ...policy,
    resource: policy.resource?.filter((rule) => !(
      rule.resourceType === "Basic"
      && rule.criteria === criteria
      && rule.interaction?.some((interaction) => interaction === "create" || interaction === "update")
    )),
  };
  assert.equal(basicPolicyAllows(policy, "create", criteria), true, `${roleId} control grant`);
  assert.equal(
    basicPolicyAllows(mutated, "create", criteria),
    false,
    `${roleId} removing the exact Basic grant must turn the positive assertion RED`,
  );
}

function ruleAllowsWrite(
  rule: AccessPolicyResource,
  before: MedicationRequest,
  after: MedicationRequest,
): boolean {
  return (rule.writeConstraint ?? []).every((constraint) => {
    const result = fhirpath.evaluate(after, constraint.expression ?? "", { before, after }, r4Model);
    return result.length === 1 && result[0] === true;
  });
}
