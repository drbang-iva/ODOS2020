import type { AccessPolicy, ProjectMembership, ProjectMembershipAccess } from "@medplum/fhirtypes";
import type { JsonPatchOperation } from "../fhir-client.js";
import { PRACTICE_ROLE_IDS, type PracticeRoleId } from "./roles.js";

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

  const operations = reconcileMembershipAccess(
    membership,
    roles.map((role) => policyReferences.get(role)!),
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
  const uniqueExisting = [...existingByGrant.values()];
  const desiredAccess: ProjectMembershipAccess[] = [];
  const included = new Set<string>();
  for (const reference of orderedPolicyReferences) {
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
