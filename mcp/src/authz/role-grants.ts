import type {
  AccessPolicy,
  Bundle,
  Patient,
  Project,
  ProjectMembership,
  ProjectMembershipAccess,
  Reference,
  Resource,
} from "@medplum/fhirtypes";
import type { JsonPatchOperation } from "../fhir-client.js";
import type { MedplumClient } from "../fhir-client.js";
import {
  ODOS_PRACTICE_ROLE_SYSTEM,
  PRACTICE_ROLE_IDS,
  buildMedplumCompositeAccessPolicy,
  compositeRoleParameterName,
  type PracticeRoleId,
} from "./roles.js";

export interface GrantPracticeRolesInput {
  target: string;
  roles: readonly PracticeRoleId[];
  primaryRole: PracticeRoleId;
  allowServiceIdentity?: boolean;
}

export interface ResolvedRoleGrantTarget {
  email: string;
  membership: ProjectMembership;
}

export interface PracticeRoleGrantDependencies {
  serviceIdentityEmail?: string;
  resolveTarget(target: string): Promise<ResolvedRoleGrantTarget>;
  resolvePolicy(role: PracticeRoleId): Promise<AccessPolicy>;
  resolveBoundPolicy?(reference: string): Promise<AccessPolicy | undefined>;
  resolveCompositePolicy?(
    roles: readonly PracticeRoleId[],
    expected: AccessPolicy,
  ): Promise<AccessPolicy>;
  patchMembership(
    id: string,
    operations: JsonPatchOperation[],
    versionId: string,
  ): Promise<ProjectMembership>;
  recordMembershipChange<T>(
    target: ResolvedRoleGrantTarget,
    operation: () => Promise<T>,
  ): Promise<T>;
}

export interface ProjectCompositeAccessPolicyStore {
  findPoliciesByName(name: string): Promise<AccessPolicy[]>;
  createPolicy(policy: AccessPolicy): Promise<AccessPolicy>;
  patchPolicy(
    id: string,
    operations: JsonPatchOperation[],
    versionId: string,
  ): Promise<AccessPolicy>;
}

export interface GrantPracticeRolesResult {
  membershipReference: string;
  targetEmail: string;
  roles: readonly PracticeRoleId[];
  changed: boolean;
}

export interface GrantNewlyRegisteredPatientInput {
  staffReference: string;
  project: Reference<Project>;
  registrationRequest: Bundle;
  registrationResponse: Bundle;
}

export interface GrantNewlyRegisteredPatientDependencies {
  serviceFhir: Pick<MedplumClient, "searchProject" | "patch">;
}

export async function grantNewlyRegisteredPatientAccess(
  input: GrantNewlyRegisteredPatientInput,
  deps: GrantNewlyRegisteredPatientDependencies,
): Promise<{ patientReference: string; changed: boolean }> {
  const projectId = input.project.reference?.match(/^Project\/([A-Za-z0-9.-]{1,64})$/)?.[1];
  if (!projectId) throw new Error("Registration caller is missing a valid project reference.");
  const patientReference = createdPatientReference(input.registrationRequest, input.registrationResponse);
  const patientId = patientReference.slice("Patient/".length);
  const patientMatches = await deps.serviceFhir.searchProject<Patient>("Patient", projectId, {
    _id: patientId,
    _count: "2",
  });
  const patients = resources(patientMatches);
  if (patients.length !== 1 || patients[0]?.meta?.project?.replace(/^Project\//, "") !== projectId) {
    throw new Error("Newly registered Patient is not owned by the caller's project.");
  }

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const membership = await registrationMembership(deps.serviceFhir, projectId, input.staffReference);
    const additions = await registrationGrantEntries(
      deps.serviceFhir,
      projectId,
      membership,
      input.staffReference,
      patientReference,
    );
    if (additions.length === 0) return { patientReference, changed: false };
    if (!membership.id || !membership.meta?.versionId) {
      throw new Error("Registration membership is missing id or meta.versionId.");
    }
    try {
      await deps.serviceFhir.patch<ProjectMembership>(
        "ProjectMembership",
        membership.id,
        membership.access?.length
          ? additions.map((value) => ({ op: "add" as const, path: "/access/-", value }))
          : [{ op: "add", path: "/access", value: additions }],
        {
          "If-Match": `W/"${membership.meta.versionId}"`,
          "X-ODOS-Source": "mcp/patient-registration-grant",
        },
      );
      return { patientReference, changed: true };
    } catch (error) {
      if (attempt === 0 && isMembershipVersionConflict(error)) continue;
      throw error;
    }
  }
  throw new Error("Patient registration grant retry was exhausted.");
}

export async function grantPracticeRoles(
  input: GrantPracticeRolesInput,
  deps: PracticeRoleGrantDependencies,
): Promise<GrantPracticeRolesResult> {
  const roles = normalizeRoles(input.roles, input.primaryRole);
  const target = await deps.resolveTarget(input.target);
  const membership = target.membership;
  if (!membership.id || !membership.meta?.versionId) {
    throw new Error("Target ProjectMembership is missing id or meta.versionId; no safe conditional grant is possible.");
  }
  const membershipProjectId = membership.project.reference?.match(/^Project\/([^/]+)$/)?.[1];
  if (!membershipProjectId) {
    throw new Error(`ProjectMembership/${membership.id} is missing a valid project reference.`);
  }
  if (membership.active === false) {
    throw new Error(`ProjectMembership/${membership.id} is inactive; role grant stopped.`);
  }
  if (
    roles.length > 0 &&
    deps.serviceIdentityEmail &&
    target.email.trim().toLowerCase() === deps.serviceIdentityEmail.trim().toLowerCase() &&
    !input.allowServiceIdentity
  ) {
    throw new Error(
      `Refusing practice-role grants to configured service identity ${target.email}; set allowServiceIdentity only for an explicit exceptional operation.`,
    );
  }

  const policyReferences = new Map<PracticeRoleId, string>();
  for (const role of roles) {
    const policy = await deps.resolvePolicy(role);
    if (!policy.id) throw new Error(`${role} AccessPolicy is missing its id.`);
    const policyProjectId = policy.meta?.project?.replace(/^Project\//, "");
    if (policyProjectId && policyProjectId !== membershipProjectId) {
      throw new Error(
        `${role} AccessPolicy/${policy.id} belongs to Project/${policyProjectId}, ` +
        `not Project/${membershipProjectId}.`,
      );
    }
    policyReferences.set(role, `AccessPolicy/${policy.id}`);
  }

  const orderedPolicyReferences = roles.map((role) => policyReferences.get(role)!);
  const sourcePolicyRoles = new Map<string, readonly PracticeRoleId[]>(
    roles.map((role) => [policyReferences.get(role)!, [role]]),
  );
  const existingReferences = [...new Set([
    ...(membership.access ?? []).flatMap((access) => access.policy.reference ?? []),
    ...(membership.accessPolicy?.reference ? [membership.accessPolicy.reference] : []),
  ])];
  if (deps.resolveBoundPolicy) {
    for (const reference of existingReferences) {
      if (sourcePolicyRoles.has(reference)) continue;
      const policy = await deps.resolveBoundPolicy(reference);
      const policyRoles = practiceRoles(policy);
      if (policyRoles.length > 0) sourcePolicyRoles.set(reference, policyRoles);
    }
  }
  const effectiveRoles = PRACTICE_ROLE_IDS.filter((role) =>
    roles.includes(role) || [...sourcePolicyRoles.values()].some((boundRoles) => boundRoles.includes(role))
  );
  let compositePolicyReference: string | undefined;
  if (effectiveRoles.length > 1) {
    if (!deps.resolveCompositePolicy) {
      throw new Error("Multi-role grant requires a composite AccessPolicy resolver.");
    }
    const composite = await deps.resolveCompositePolicy(
      effectiveRoles,
      buildMedplumCompositeAccessPolicy(effectiveRoles),
    );
    if (!composite.id) throw new Error("Composite AccessPolicy is missing its id.");
    const compositeProjectId = composite.meta?.project?.replace(/^Project\//, "");
    if (!compositeProjectId) {
      throw new Error(
        `Composite AccessPolicy/${composite.id} is missing Project/${membershipProjectId} ownership.`,
      );
    }
    if (compositeProjectId !== membershipProjectId) {
      throw new Error(
        `Composite AccessPolicy/${composite.id} belongs to Project/${compositeProjectId}, ` +
        `not Project/${membershipProjectId}.`,
      );
    }
    compositePolicyReference = `AccessPolicy/${composite.id}`;
    sourcePolicyRoles.set(compositePolicyReference, effectiveRoles);
  }

  const operations = reconcileMembershipAccess(
    membership,
    orderedPolicyReferences,
    compositePolicyReference,
    sourcePolicyRoles,
  );
  if (operations.length > 0) {
    await deps.recordMembershipChange(target, () =>
      deps.patchMembership(membership.id!, operations, membership.meta!.versionId!),
    );
  }

  return {
    membershipReference: `ProjectMembership/${membership.id}`,
    targetEmail: target.email,
    roles,
    changed: operations.length > 0,
  };
}

export async function resolveProjectCompositeAccessPolicy(
  store: ProjectCompositeAccessPolicyStore,
  projectId: string,
  roles: readonly PracticeRoleId[],
  expected: AccessPolicy,
): Promise<AccessPolicy> {
  if (!expected.name) throw new Error("Composite AccessPolicy is missing its canonical name.");
  const matches = (await store.findPoliciesByName(expected.name)).filter((policy) =>
    policy.name === expected.name && policy.meta?.project?.replace(/^Project\//, "") === projectId
  );
  if (matches.length > 1) {
    throw new Error(`Expected at most one ${expected.name} in Project/${projectId}; found ${matches.length}.`);
  }
  const existing = matches[0];
  if (!existing) {
    return store.createPolicy({
      ...structuredClone(expected),
      meta: { ...expected.meta, project: projectId },
    });
  }
  const expectedRoles = PRACTICE_ROLE_IDS.filter((role) => roles.includes(role));
  if (JSON.stringify(practiceRoles(existing)) !== JSON.stringify(expectedRoles)) {
    throw new Error(`${expected.name} has conflicting practice-role tags.`);
  }
  if (JSON.stringify(existing.resource ?? []) === JSON.stringify(expected.resource ?? [])) {
    return existing;
  }
  if (!existing.id || !existing.meta?.versionId) {
    throw new Error(`${expected.name} cannot be reconciled safely because id or meta.versionId is missing.`);
  }
  return store.patchPolicy(
    existing.id,
    [{
      op: existing.resource === undefined ? "add" : "replace",
      path: "/resource",
      value: structuredClone(expected.resource ?? []),
    }],
    existing.meta.versionId,
  );
}

export function reconcileMembershipAccess(
  membership: ProjectMembership,
  orderedPolicyReferences: readonly string[],
  compositePolicyReference?: string,
  sourcePolicyRoles: ReadonlyMap<string, readonly PracticeRoleId[]> = new Map(),
): JsonPatchOperation[] {
  const existing = [
    ...(membership.access ?? []),
    ...(membership.accessPolicy?.reference
      ? [{ policy: { reference: membership.accessPolicy.reference } }]
      : []),
  ];
  const existingByGrant = new Map<string, ProjectMembershipAccess>();
  for (const access of existing) {
    const key = accessGrantKey(access);
    if (!existingByGrant.has(key)) {
      existingByGrant.set(key, access);
    }
  }
  const uniqueExisting = compositePolicyReference
    ? compileCompositeMembershipAccess(
        [...existingByGrant.values()],
        sourcePolicyRoles,
        compositePolicyReference,
      )
    : [...existingByGrant.values()];
  const desiredAccess: ProjectMembershipAccess[] = [];
  const included = new Set<string>();
  const desiredPolicyReferences = compositePolicyReference
    ? [compositePolicyReference]
    : orderedPolicyReferences;
  for (const reference of desiredPolicyReferences) {
    const access = uniqueExisting.find(
      (candidate) => candidate.policy.reference === reference && !candidate.parameter?.length,
    ) ?? { policy: { reference } };
    const key = accessGrantKey(access);
    if (!included.has(key)) {
      desiredAccess.push(access);
      included.add(key);
    }
  }
  for (const access of uniqueExisting) {
    const key = accessGrantKey(access);
    if (!included.has(key)) {
      desiredAccess.push(access);
      included.add(key);
    }
  }
  const operations: JsonPatchOperation[] = [];
  if (JSON.stringify(membership.access ?? []) !== JSON.stringify(desiredAccess)) {
    operations.push({
      op: membership.access ? "replace" : "add",
      path: "/access",
      value: desiredAccess,
    });
  }
  if (membership.accessPolicy) {
    operations.push({ op: "remove", path: "/accessPolicy" });
  }
  return operations;
}

export function compileCompositeMembershipAccess(
  access: readonly ProjectMembershipAccess[],
  sourcePolicyRoles: ReadonlyMap<string, readonly PracticeRoleId[]>,
  targetReference: string,
): ProjectMembershipAccess[] {
  const compiled: ProjectMembershipAccess[] = [];
  for (const entry of access) {
    const reference = entry.policy.reference ?? "";
    const roles = sourcePolicyRoles.get(reference);
    if (!roles?.length) {
      appendUniqueAccess(compiled, structuredClone(entry));
      continue;
    }
    const parameter = (entry.parameter ?? []).map((value) => {
      if (roles.length !== 1 || isCompositeParameterName(value.name)) {
        return structuredClone(value);
      }
      return { ...structuredClone(value), name: compositeRoleParameterName(roles[0]!, value.name) };
    });
    const next: ProjectMembershipAccess = {
      policy: { reference: targetReference },
      ...(parameter.length ? { parameter: sortAccessParameters(parameter) } : {}),
    };
    const patientReferences = compositePatientReferences(next);
    const mergeTarget = patientReferences.length > 0
      ? compiled.find((candidate) =>
          candidate.policy.reference === targetReference
          && compositePatientReferences(candidate).some((patient) => patientReferences.includes(patient))
        )
      : undefined;
    if (mergeTarget) {
      mergeTarget.parameter = sortAccessParameters([
        ...(mergeTarget.parameter ?? []),
        ...(next.parameter ?? []),
      ].filter((value, index, values) => values.findIndex((candidate) =>
        JSON.stringify(candidate) === JSON.stringify(value)
      ) === index));
    } else {
      appendUniqueAccess(compiled, next);
    }
  }
  const targetIndexes = compiled.flatMap((entry, index) =>
    entry.policy.reference === targetReference ? [index] : []
  );
  const orderedTargets = targetIndexes.map((index) => compiled[index]!).sort((left, right) => {
    const leftBare = left.parameter?.length ? 1 : 0;
    const rightBare = right.parameter?.length ? 1 : 0;
    return leftBare - rightBare || accessGrantKey(left).localeCompare(accessGrantKey(right));
  });
  targetIndexes.forEach((index, targetIndex) => {
    compiled[index] = orderedTargets[targetIndex]!;
  });
  return compiled;
}

function isCompositeParameterName(name: string): boolean {
  return PRACTICE_ROLE_IDS.some((role) => [
    "provider_profile",
    "patient_compartment",
    "license_state",
    "procedure_scope",
  ].some((parameter) => name === compositeRoleParameterName(role, parameter)));
}

function practiceRoles(policy: AccessPolicy | undefined): PracticeRoleId[] {
  if (!policy) return [];
  return PRACTICE_ROLE_IDS.filter((role) => policy.meta?.tag?.some((tag) =>
    tag.system === ODOS_PRACTICE_ROLE_SYSTEM && tag.code === role
  ));
}

function compositePatientReferences(access: ProjectMembershipAccess): string[] {
  return access.parameter?.flatMap((parameter) =>
    parameter.name.endsWith("_patient_compartment") && parameter.valueString
      ? [parameter.valueString]
      : []
  ) ?? [];
}

function sortAccessParameters(
  parameters: NonNullable<ProjectMembershipAccess["parameter"]>,
): NonNullable<ProjectMembershipAccess["parameter"]> {
  return [...parameters].sort((left, right) => {
    const leftValue = left.valueString ?? left.valueReference?.reference ?? "";
    const rightValue = right.valueString ?? right.valueReference?.reference ?? "";
    return left.name.localeCompare(right.name) || leftValue.localeCompare(rightValue);
  });
}

function appendUniqueAccess(
  access: ProjectMembershipAccess[],
  candidate: ProjectMembershipAccess,
): void {
  if (!access.some((entry) => accessGrantKey(entry) === accessGrantKey(candidate))) {
    access.push(candidate);
  }
}

function accessGrantKey(access: ProjectMembershipAccess): string {
  return JSON.stringify([access.policy.reference ?? null, access.parameter ?? []]);
}

function normalizeRoles(
  requested: readonly PracticeRoleId[],
  primaryRole: PracticeRoleId,
): PracticeRoleId[] {
  if (!requested.includes(primaryRole)) {
    throw new Error(`primaryRole ${primaryRole} must be included in roles.`);
  }
  for (const role of requested) {
    if (!PRACTICE_ROLE_IDS.includes(role)) {
      throw new Error(`Unknown practice role ${role}.`);
    }
  }
  return [primaryRole, ...requested.filter((role) => role !== primaryRole)].filter(
    (role, index, roles) => roles.indexOf(role) === index,
  );
}

function createdPatientReference(request: Bundle, response: Bundle): string {
  const requestEntry = request.entry?.[0];
  if (
    request.type !== "transaction" ||
    requestEntry?.request?.method !== "POST" ||
    requestEntry.request.url !== "Patient" ||
    requestEntry.resource?.resourceType !== "Patient"
  ) {
    throw new Error("Registration grant requires the server-built Patient transaction entry.");
  }
  const responseEntry = response.entry?.[0]?.response;
  if (!responseEntry?.status?.startsWith("201")) {
    throw new Error("Registration grant requires a newly created Patient response.");
  }
  const patientId = responseEntry.location?.match(/^Patient\/([A-Za-z0-9.-]{1,64})(?:\/|$)/)?.[1];
  if (!patientId) throw new Error("Registration response did not identify the newly created Patient.");
  return `Patient/${patientId}`;
}

async function registrationMembership(
  fhir: Pick<MedplumClient, "searchProject">,
  projectId: string,
  staffReference: string,
): Promise<ProjectMembership> {
  const matches = await fhir.searchProject<ProjectMembership>("ProjectMembership", projectId, {
    profile: staffReference,
    active: "true",
    _count: "2",
  });
  const memberships = resources(matches).filter((membership) => membership.active !== false);
  if (memberships.length !== 1) {
    throw new Error(`Registration caller has ${memberships.length} active project memberships; exactly one is required.`);
  }
  const membership = memberships[0]!;
  if (membership.project.reference !== `Project/${projectId}`) {
    throw new Error("Registration membership does not belong to the caller's project.");
  }
  return membership;
}

async function registrationGrantEntries(
  fhir: Pick<MedplumClient, "searchProject">,
  projectId: string,
  membership: ProjectMembership,
  staffReference: string,
  patientReference: string,
): Promise<ProjectMembershipAccess[]> {
  const policyReferences = [...new Set([
    ...(membership.access ?? []).flatMap((access) => access.policy.reference ?? []),
    ...(membership.accessPolicy?.reference ? [membership.accessPolicy.reference] : []),
  ])].filter((reference) => /^AccessPolicy\/[A-Za-z0-9.-]{1,64}$/.test(reference));
  const additions: ProjectMembershipAccess[] = [];
  for (const policyReference of policyReferences) {
    const policyId = policyReference.slice("AccessPolicy/".length);
    const matches = await fhir.searchProject<AccessPolicy>("AccessPolicy", projectId, {
      _id: policyId,
      _count: "2",
    });
    const policies = resources(matches);
    if (policies.length !== 1 || policies[0]?.meta?.project?.replace(/^Project\//, "") !== projectId) {
      throw new Error(`${policyReference} is not uniquely owned by the caller's project.`);
    }
    const expressions = (policies[0]?.resource ?? []).flatMap((rule) => [
      rule.criteria,
      ...(rule.writeConstraint ?? []).map((constraint) => constraint.expression),
    ]).filter((value): value is string => Boolean(value));
    const patientParameterNames = [...new Set(expressions.flatMap((expression) =>
      [...expression.matchAll(/%((?:(?:admin|provider|staff)_)?patient_compartment)(?![A-Za-z0-9_])/g)]
        .map((match) => match[1]!)
    ))];
    if (patientParameterNames.length === 0) continue;
    if (membership.access?.some((access) =>
      access.policy.reference === policyReference && patientParameterNames.every((parameterName) =>
        access.parameter?.some((parameter) =>
          parameter.name === parameterName && parameter.valueString === patientReference
        )
      )
    )) continue;
    const parameters = patientParameterNames.flatMap((patientParameterName) => {
      const prefix = patientParameterName.slice(0, -"patient_compartment".length);
      const providerParameterName = `${prefix}provider_profile`;
      const needsProviderProfile = expressions.some((expression) =>
        expression.includes(`%${providerParameterName}`)
      );
      return [
        ...(needsProviderProfile
          ? [{ name: providerParameterName, valueReference: { reference: staffReference } }]
          : []),
        { name: patientParameterName, valueString: patientReference },
      ];
    });
    additions.push({ policy: { reference: policyReference }, parameter: sortAccessParameters(parameters) });
  }
  return additions;
}

function resources<T extends Resource>(bundle: Bundle<T>): T[] {
  return (bundle.entry ?? []).flatMap((entry) => entry.resource ? [entry.resource] : []);
}

function isMembershipVersionConflict(error: unknown): boolean {
  return typeof error === "object" && error !== null && "status" in error &&
    (error.status === 409 || error.status === 412);
}
