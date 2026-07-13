#!/usr/bin/env tsx
import { createHash, randomBytes } from "node:crypto";
import type { AccessPolicy, ProjectMembership, User } from "@medplum/fhirtypes";
import { createLiveOsodAuditRuntime } from "../mcp/src/authz/liveAudit.js";
import { buildOsodAuditEventRow } from "../mcp/src/authz/osodAudit.js";
import {
  grantPracticeRoles,
  type ResolvedRoleGrantTarget,
} from "../mcp/src/authz/role-grants.js";
import {
  buildMedplumAccessPolicy,
  getRoleDeclaration,
  PRACTICE_ROLE_IDS,
  type PracticeRoleId,
} from "../mcp/src/authz/roles.js";
import {
  createMedplumClient,
  type JsonPatchOperation,
  type MedplumClient,
} from "../mcp/src/fhir-client.js";
import { searchAll } from "../mcp/src/fhir-search.js";
import { assertLocalMedplumBaseUrl, decidePracticeRoleTag } from "./reseed-practice-role-tags.js";

const DEFAULT_BASE_URL = "http://localhost:8103";
const DEFAULT_POSTGRES_URL = "postgresql://medplum:medplum@127.0.0.1:5432/medplum";
export const DEV_ADMIN_ROLE: PracticeRoleId = "front-desk";
export const DEV_ADMIN_GRANT_ROLES = [DEV_ADMIN_ROLE, "practice-admin", "clinician"] as const;
export type DevAdminGrantRole = (typeof DEV_ADMIN_GRANT_ROLES)[number];
export type DevAdminPrimaryRole = Extract<DevAdminGrantRole, "front-desk" | "clinician">;

export interface PracticeRoleRepairAdapter {
  findPoliciesByName(name: string): Promise<AccessPolicy[]>;
  createPolicy(policy: AccessPolicy): Promise<AccessPolicy>;
  patchPolicy(id: string, operations: JsonPatchOperation[], versionId: string): Promise<AccessPolicy>;
  resolveTarget(target: string): Promise<ResolvedRoleGrantTarget>;
  patchMembership(id: string, operations: JsonPatchOperation[], versionId: string): Promise<ProjectMembership>;
  recordMembershipChange<T>(target: ResolvedRoleGrantTarget, operation: () => Promise<T>): Promise<T>;
}

export interface PracticeRoleRepairResult {
  readonly createdPolicies: PracticeRoleId[];
  readonly taggedPolicies: PracticeRoleId[];
  readonly existingPolicies: PracticeRoleId[];
  readonly membershipReference: string;
  readonly targetEmail: string;
  readonly membershipChanged: boolean;
  readonly primaryRole: DevAdminPrimaryRole;
}

export async function repairPracticeRoles(
  adapter: PracticeRoleRepairAdapter,
  target: string,
  primaryRole: DevAdminPrimaryRole = DEV_ADMIN_ROLE,
  serviceIdentityEmail?: string,
): Promise<PracticeRoleRepairResult> {
  const createdPolicies: PracticeRoleId[] = [];
  const taggedPolicies: PracticeRoleId[] = [];
  const existingPolicies: PracticeRoleId[] = [];
  const policies = new Map<PracticeRoleId, AccessPolicy>();

  for (const roleId of PRACTICE_ROLE_IDS) {
    const role = getRoleDeclaration(roleId);
    const expectedName = `OSOD ${role.display}`;
    const matches = (await adapter.findPoliciesByName(expectedName)).filter(
      (policy) => policy.name === expectedName,
    );
    if (matches.length > 1) {
      throw new Error(`${expectedName} has ${matches.length} exact matches; repair stopped without guessing.`);
    }

    let policy = matches[0];
    if (!policy) {
      policy = await adapter.createPolicy(buildMedplumAccessPolicy(role));
      if (!policy.id) throw new Error(`${expectedName} create returned no id.`);
      createdPolicies.push(roleId);
    } else {
      const decision = decidePracticeRoleTag(policy.meta?.tag, roleId);
      if (decision.kind === "CONFLICT") {
        throw new Error(
          `${expectedName} carries conflicting practice-role code(s): ${decision.conflictingCodes.join(", ")}.`,
        );
      }
      if (decision.kind === "ADD") {
        if (!policy.id || !policy.meta?.versionId) {
          throw new Error(`${expectedName} cannot be tagged safely because id or meta.versionId is missing.`);
        }
        policy = await adapter.patchPolicy(
          policy.id,
          practiceRoleTagPatch(policy, decision.tag),
          policy.meta.versionId,
        );
        taggedPolicies.push(roleId);
      } else {
        existingPolicies.push(roleId);
      }
    }
    policies.set(roleId, policy);
  }

  const grant = await grantPracticeRoles(
    { target, roles: DEV_ADMIN_GRANT_ROLES, primaryRole },
    {
      serviceIdentityEmail,
      resolveTarget: (requestedTarget) => adapter.resolveTarget(requestedTarget),
      resolvePolicy: async (role) => {
        const policy = policies.get(role);
        if (!policy) throw new Error(`${role} AccessPolicy was not resolved.`);
        return policy;
      },
      patchMembership: (id, operations, versionId) =>
        adapter.patchMembership(id, operations, versionId),
      recordMembershipChange: (resolvedTarget, operation) =>
        adapter.recordMembershipChange(resolvedTarget, operation),
    },
  );

  return {
    createdPolicies,
    taggedPolicies,
    existingPolicies,
    membershipReference: grant.membershipReference,
    targetEmail: grant.targetEmail,
    membershipChanged: grant.changed,
    primaryRole,
  };
}

function practiceRoleTagPatch(
  policy: AccessPolicy,
  tag: { system?: string; code?: string },
): JsonPatchOperation[] {
  if (!policy.meta) return [{ op: "add", path: "/meta", value: { tag: [tag] } }];
  if (!policy.meta.tag) return [{ op: "add", path: "/meta/tag", value: [tag] }];
  return [{ op: "add", path: "/meta/tag/-", value: tag }];
}

export function membershipPolicyReferences(membership: ProjectMembership): string[] {
  return [
    membership.accessPolicy?.reference,
    ...(membership.access ?? []).map((access) => access.policy.reference),
  ].filter((reference): reference is string => Boolean(reference));
}

class LivePracticeRoleRepairAdapter implements PracticeRoleRepairAdapter {
  private readonly audit = createLiveOsodAuditRuntime({
    postgresUrl: process.env.OSOD_POSTGRES_URL ?? DEFAULT_POSTGRES_URL,
    disabled: process.env.OSOD_ROLE_REPAIR_AUDIT_DISABLED === "true",
  });

  constructor(private readonly fhir: MedplumClient) {}

  async findPoliciesByName(name: string): Promise<AccessPolicy[]> {
    return searchAll<AccessPolicy>(this.fhir, "AccessPolicy", { "name:exact": name });
  }

  async createPolicy(policy: AccessPolicy): Promise<AccessPolicy> {
    return this.fhir.create(policy);
  }

  async patchPolicy(
    id: string,
    operations: JsonPatchOperation[],
    versionId: string,
  ): Promise<AccessPolicy> {
    return this.fhir.patch("AccessPolicy", id, operations, { "If-Match": `W/\"${versionId}\"` });
  }

  async resolveTarget(target: string): Promise<ResolvedRoleGrantTarget> {
    const isPractitionerReference = /^Practitioner\/[^/]+$/.test(target);
    let email: string | undefined;
    let memberships: ProjectMembership[];
    if (isPractitionerReference) {
      memberships = await searchAll<ProjectMembership>(this.fhir, "ProjectMembership", {
        profile: target,
      });
    } else {
      const users = (await searchAll<User>(this.fhir, "User", { email: target })).filter(
        (user) => user.email?.toLowerCase() === target.toLowerCase(),
      );
      if (users.length === 0) throw new Error(`No User found for ${target}.`);
      email = target;
      memberships = (await Promise.all(users.flatMap((user) => user.id
        ? [searchAll<ProjectMembership>(this.fhir, "ProjectMembership", { user: `User/${user.id}` })]
        : []))).flat();
    }
    if (memberships.length !== 1) {
      throw new Error(`Expected one ProjectMembership for ${target}; found ${memberships.length}.`);
    }
    const membership = memberships[0]!;
    if (!email) {
      const userId = membership.user.reference?.match(/^User\/([^/]+)$/)?.[1];
      if (!userId) throw new Error(`ProjectMembership/${membership.id ?? "unknown"} has no human User reference.`);
      email = (await this.fhir.read<User>("User", userId)).email;
    }
    if (!email) throw new Error(`Could not resolve the target email for ${target}.`);
    return { email, membership };
  }

  async patchMembership(
    id: string,
    operations: JsonPatchOperation[],
    versionId: string,
  ): Promise<ProjectMembership> {
    return this.fhir.patch("ProjectMembership", id, operations, { "If-Match": `W/\"${versionId}\"` });
  }

  async recordMembershipChange<T>(
    target: ResolvedRoleGrantTarget,
    operation: () => Promise<T>,
  ): Promise<T> {
    return this.audit.record(
      buildOsodAuditEventRow({
        eventType: "role-change",
        actorId: "repair-practice-roles",
        actorRole: "system",
        resourceType: "ProjectMembership",
        resourceId: target.membership.id,
        actionOutcome: "granted",
        actionReason: `reconcile practice roles for ${target.email}`,
      }),
      operation,
    );
  }
}

export async function loginForLocalRepair(input: {
  baseUrl: string;
  email: string;
  password: string;
}): Promise<string> {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const loginResponse = await fetch(`${input.baseUrl}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      email: input.email,
      password: input.password,
      codeChallenge: challenge,
      codeChallengeMethod: "S256",
    }),
  });
  if (!loginResponse.ok) {
    throw new Error(`Medplum login failed: ${loginResponse.status} ${await loginResponse.text()}`);
  }
  const { code } = (await loginResponse.json()) as { code: string };
  const tokenResponse = await fetch(`${input.baseUrl}/oauth2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "authorization_code", code, code_verifier: verifier }),
  });
  if (!tokenResponse.ok) {
    throw new Error(`Medplum token exchange failed: ${tokenResponse.status} ${await tokenResponse.text()}`);
  }
  const { access_token: accessToken } = (await tokenResponse.json()) as { access_token: string };
  return accessToken;
}

async function runCli(): Promise<void> {
  const baseUrl = (process.env.MEDPLUM_BASE_URL ?? DEFAULT_BASE_URL).replace(/\/$/, "");
  assertLocalMedplumBaseUrl(baseUrl);
  const target = requiredEmailArgument(process.argv.slice(2));
  const email = requireEnv("MEDPLUM_ADMIN_EMAIL");
  const password = requireEnv("MEDPLUM_ADMIN_PASSWORD");
  const accessToken = await loginForLocalRepair({ baseUrl, email, password });
  const fhir = createMedplumClient({ baseUrl, accessToken });
  const primaryRole = devPrimaryRole(process.env.OSOD_DEV_PRIMARY_ROLE);
  const result = await repairPracticeRoles(
    new LivePracticeRoleRepairAdapter(fhir),
    target,
    primaryRole,
    email,
  );
  console.log(`Role policies created: ${result.createdPolicies.length} [${result.createdPolicies.join(", ")}]`);
  console.log(`Role policies tagged: ${result.taggedPolicies.length} [${result.taggedPolicies.join(", ")}]`);
  console.log(`Role policies already correct: ${result.existingPolicies.length} [${result.existingPolicies.join(", ")}]`);
  console.log(`${result.membershipReference} target: ${result.targetEmail}`);
  console.log(`Membership reconciliation: ${result.membershipChanged ? "CHANGED" : "ALREADY EXACT"}`);
  console.log(`Dev login primary role: ${result.primaryRole}`);
}

export function devPrimaryRole(value: string | undefined): DevAdminPrimaryRole {
  const role = value?.trim() || DEV_ADMIN_ROLE;
  if (role !== "front-desk" && role !== "clinician") {
    throw new Error("OSOD_DEV_PRIMARY_ROLE must be front-desk or clinician.");
  }
  return role;
}

export function requiredEmailArgument(args: readonly string[]): string {
  const index = args.indexOf("--email");
  const value = index >= 0 ? args[index + 1]?.trim() : undefined;
  if (!value || value.startsWith("--")) {
    throw new Error("repair-practice-roles requires --email <target>.");
  }
  return value;
}

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    await runCli();
  } catch (error) {
    const status = (error as { status?: number }).status;
    const suffix = status === 412 ? " The resource changed during repair; rerun to re-evaluate current state." : "";
    console.error(`${error instanceof Error ? error.message : String(error)}${suffix}`);
    process.exitCode = 1;
  }
}
