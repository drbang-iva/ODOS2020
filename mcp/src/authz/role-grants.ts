import type { AccessPolicy, ProjectMembership, ProjectMembershipAccess } from "@medplum/fhirtypes";
import type { JsonPatchOperation } from "../fhir-client.js";
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

export interface GrantPracticeRolesResult {
  membershipReference: string;
  targetEmail: string;
  roles: readonly PracticeRoleId[];
  changed: boolean;
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
