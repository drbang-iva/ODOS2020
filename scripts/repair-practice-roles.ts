#!/usr/bin/env tsx
import { createHash, randomBytes } from "node:crypto";
import type { AccessPolicy, Practitioner, ProjectMembership } from "@medplum/fhirtypes";
import { createLiveOdosAuditRuntime } from "../mcp/src/authz/liveAudit.js";
import { buildOdosAuditEventRow } from "../mcp/src/authz/odosAudit.js";
import {
  grantPracticeRoles,
  type ResolvedRoleGrantTarget,
} from "../mcp/src/authz/role-grants.js";
import {
  buildMedplumAccessPolicy,
  buildMedplumCompositeAccessPolicy,
  getRoleDeclaration,
  ODOS_PRACTICE_ROLE_SYSTEM,
  PRACTICE_ROLE_IDS,
  type PracticeRoleId,
} from "../mcp/src/authz/roles.js";
import {
  createOperatorScriptFhirClient,
  type JsonPatchOperation,
  type MedplumClient,
} from "../mcp/src/fhir-client.js";
import { searchAll, searchProjectAll } from "../mcp/src/fhir-search.js";
import { readMembershipUserEmail } from "./reconcile-membership-display.js";
import { assertLocalMedplumBaseUrl, decidePracticeRoleTag } from "./reseed-practice-role-tags.js";
import {
  assertObservedProjectMatchesTarget,
  formatInstallationProjectTarget,
  resolveInstallationProject,
} from "./installation-project.js";

const DEFAULT_BASE_URL = "http://localhost:8103";
const DEFAULT_POSTGRES_URL = "postgresql://medplum:medplum@127.0.0.1:5433/medplum";
export const DEV_ADMIN_ROLE = "staff" as const satisfies PracticeRoleId;
export const DEV_ADMIN_GRANT_ROLES = [DEV_ADMIN_ROLE, "admin", "provider"] as const;
export type DevAdminGrantRole = (typeof DEV_ADMIN_GRANT_ROLES)[number];
export type DevAdminPrimaryRole = Extract<DevAdminGrantRole, "staff" | "provider">;

export interface PracticeRoleRepairAdapter {
  findPoliciesByName(name: string, projectId: string): Promise<AccessPolicy[]>;
  readPolicy(reference: string): Promise<AccessPolicy | undefined>;
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
  readonly grantedRoles: readonly PracticeRoleId[];
  readonly policyBindings: readonly string[];
}

export async function repairPracticeRoles(
  adapter: PracticeRoleRepairAdapter,
  target: string,
  primaryRole: DevAdminPrimaryRole = DEV_ADMIN_ROLE,
  serviceIdentityEmail?: string,
  allowServiceIdentity = false,
): Promise<PracticeRoleRepairResult> {
  const resolvedTarget = await adapter.resolveTarget(target);
  const targetProjectId = resolvedTarget.membership.project.reference?.match(/^Project\/([^/]+)$/)?.[1];
  if (!targetProjectId) {
    throw new Error("Target ProjectMembership is missing a valid project reference.");
  }
  const createdPolicies: PracticeRoleId[] = [];
  const taggedPolicies: PracticeRoleId[] = [];
  const existingPolicies: PracticeRoleId[] = [];
  const policies = new Map<PracticeRoleId, AccessPolicy>();

  for (const roleId of PRACTICE_ROLE_IDS) {
    const role = getRoleDeclaration(roleId);
    const expectedName = `ODOS ${role.display}`;
    const matches = (await adapter.findPoliciesByName(expectedName, targetProjectId)).filter(
      (policy) => policy.name === expectedName
        && policy.meta?.project?.replace(/^Project\//, "") === targetProjectId,
    );
    if (matches.length > 1) {
      throw new Error(`${expectedName} has ${matches.length} exact matches; repair stopped without guessing.`);
    }

    let policy = matches[0];
    if (!policy) {
      const expected = buildMedplumAccessPolicy(role);
      policy = await adapter.createPolicy({
        ...expected,
        meta: { ...expected.meta, project: targetProjectId },
      });
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
    { target, roles: DEV_ADMIN_GRANT_ROLES, primaryRole, allowServiceIdentity },
    {
      serviceIdentityEmail,
      resolveTarget: async () => resolvedTarget,
      resolvePolicy: async (role) => {
        const policy = policies.get(role);
        if (!policy) throw new Error(`${role} AccessPolicy was not resolved.`);
        return policy;
      },
      resolveBoundPolicy: (reference) => adapter.readPolicy(reference),
      resolveCompositePolicy: async (roles) => {
        const expected = buildMedplumCompositeAccessPolicy(roles);
        const matches = (await adapter.findPoliciesByName(expected.name!, targetProjectId)).filter(
          (policy) => policy.name === expected.name
            && policy.meta?.project?.replace(/^Project\//, "") === targetProjectId,
        );
        if (matches.length > 1) {
          throw new Error(
            `${expected.name} has ${matches.length} exact matches; repair stopped without guessing.`,
          );
        }
        const existing = matches[0];
        if (!existing) {
          return adapter.createPolicy({
            ...expected,
            meta: { ...expected.meta, project: targetProjectId },
          });
        }
        assertCompositePolicyRoles(existing, roles);
        if (JSON.stringify(existing.resource ?? []) !== JSON.stringify(expected.resource ?? [])) {
          if (!existing.id || !existing.meta?.versionId) {
            throw new Error(`${expected.name} cannot be reconciled safely because id or meta.versionId is missing.`);
          }
          return adapter.patchPolicy(
            existing.id,
            [{
              op: existing.resource === undefined ? "add" : "replace",
              path: "/resource",
              value: structuredClone(expected.resource ?? []),
            }],
            existing.meta.versionId,
          );
        }
        return existing;
      },
      patchMembership: (id, operations, versionId) =>
        adapter.patchMembership(id, operations, versionId),
      recordMembershipChange: (resolvedTarget, operation) =>
        adapter.recordMembershipChange(resolvedTarget, operation),
    },
  );
  const repairedTarget = await adapter.resolveTarget(target);

  return {
    createdPolicies,
    taggedPolicies,
    existingPolicies,
    membershipReference: grant.membershipReference,
    targetEmail: grant.targetEmail,
    membershipChanged: grant.changed,
    primaryRole,
    grantedRoles: grant.roles,
    policyBindings: membershipPolicyReferences(repairedTarget.membership),
  };
}

function assertCompositePolicyRoles(
  policy: AccessPolicy,
  roles: readonly PracticeRoleId[],
): void {
  const actual = PRACTICE_ROLE_IDS.filter((role) =>
    policy.meta?.tag?.some((tag) =>
      tag.system === ODOS_PRACTICE_ROLE_SYSTEM && tag.code === role
    )
  );
  const expected = PRACTICE_ROLE_IDS.filter((role) => roles.includes(role));
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${policy.name ?? "Composite AccessPolicy"} has conflicting practice-role tags.`);
  }
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
  private readonly audit = createLiveOdosAuditRuntime({
    postgresUrl: process.env.ODOS_POSTGRES_URL ?? DEFAULT_POSTGRES_URL,
    disabled: process.env.ODOS_ROLE_REPAIR_AUDIT_DISABLED === "true",
  });

  constructor(
    private readonly fhir: MedplumClient,
    private readonly allowProjectInvisibleUser = false,
  ) {}

  async findPoliciesByName(name: string, projectId: string): Promise<AccessPolicy[]> {
    return searchProjectAll<AccessPolicy>(this.fhir, "AccessPolicy", projectId, {
      "name:exact": name,
    });
  }

  async createPolicy(policy: AccessPolicy): Promise<AccessPolicy> {
    return this.fhir.create(policy);
  }

  async readPolicy(reference: string): Promise<AccessPolicy | undefined> {
    const id = reference.match(/^AccessPolicy\/([^/]+)$/)?.[1];
    return id ? this.fhir.read<AccessPolicy>("AccessPolicy", id) : undefined;
  }

  async patchPolicy(
    id: string,
    operations: JsonPatchOperation[],
    versionId: string,
  ): Promise<AccessPolicy> {
    return this.fhir.patch("AccessPolicy", id, operations, { "If-Match": `W/\"${versionId}\"` });
  }

  async resolveTarget(target: string): Promise<ResolvedRoleGrantTarget> {
    return resolvePracticeRoleTarget(this.fhir, target, this.allowProjectInvisibleUser);
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
      buildOdosAuditEventRow({
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

export async function resolvePracticeRoleTarget(
  fhir: Pick<MedplumClient, "baseUrl" | "read" | "search" | "searchUrl">,
  target: string,
  allowProjectInvisibleUser = false,
): Promise<ResolvedRoleGrantTarget> {
  const practitionerReference = target.match(/^Practitioner\/([^/]+)$/);
  let practitioners: Practitioner[];
  if (practitionerReference) {
    practitioners = [await fhir.read<Practitioner>("Practitioner", practitionerReference[1])];
  } else {
    practitioners = (await searchAll<Practitioner>(fhir, "Practitioner", { email: target })).filter(
      (practitioner) => practitionerEmail(practitioner)?.toLowerCase() === target.toLowerCase(),
    );
  }
  const candidates = (await Promise.all(practitioners.flatMap((practitioner) => practitioner.id
    ? [searchAll<ProjectMembership>(fhir, "ProjectMembership", { profile: `Practitioner/${practitioner.id}` })
        .then((memberships) => memberships.map((membership) => ({ practitioner, membership })))]
    : []))).flat();
  if (candidates.length !== 1) {
    throw new Error(`Expected one Practitioner-backed ProjectMembership for ${target}; found ${candidates.length}.`);
  }
  const { practitioner, membership } = candidates[0]!;
  // Medplum $update-email does not sync ProjectMembership.user.display; manual renames must patch it too.
  let userEmail: string | undefined;
  try {
    userEmail = await readMembershipUserEmail(fhir, membership);
  } catch (error) {
    if (!allowProjectInvisibleUser || (error as { status?: number }).status !== 404) throw error;
  }
  const email = userEmail ?? practitionerEmail(practitioner);
  if (!email) {
    throw new Error(`Could not resolve the target email from ${membership.profile.reference ?? target}.`);
  }
  return { email, membership };
}

function practitionerEmail(practitioner: Practitioner): string | undefined {
  return practitioner.telecom?.find((telecom) => telecom.system === "email" && telecom.value)?.value;
}

export async function loginForLocalRepair(input: {
  baseUrl: string;
  email: string;
  password: string;
  projectId?: string;
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
      ...(input.projectId ? { projectId: input.projectId } : {}),
    }),
  });
  if (!loginResponse.ok) {
    throw new Error(`Medplum login failed: ${loginResponse.status} ${await loginResponse.text()}`);
  }
  const loginResult = (await loginResponse.json()) as {
    code?: string;
    memberships?: Array<{ id?: string; project?: { reference?: string } }>;
  };
  const code = loginResult.code;
  if (!code) {
    if (loginResult.memberships) {
      throw new Error(
        `Medplum login found ${loginResult.memberships.length} project memberships; ` +
        "supply --project <project-id> or MEDPLUM_PROJECT_ID.",
      );
    }
    throw new Error("Medplum login returned neither an authorization code nor project memberships.");
  }
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
  const project = resolveInstallationProject({ args: process.argv.slice(2) });
  console.log(formatInstallationProjectTarget(project));
  const email = requireEnv("MEDPLUM_ADMIN_EMAIL");
  const password = requireEnv("MEDPLUM_ADMIN_PASSWORD");
  const accessToken = await loginForLocalRepair({ baseUrl, email, password, projectId: project.projectId });
  const fhir = createOperatorScriptFhirClient({
    baseUrl,
    accessToken,
    reason: "Operator practice-role repair runs outside request handling.",
  });
  assertObservedProjectMatchesTarget(
    project.projectId,
    await fhir.getActiveProjectId(),
    "authenticated repair project",
  );
  const contractBootstrap = process.env.MEDPLUM_CONTRACT_BOOTSTRAP === "1";
  const primaryRole = devPrimaryRole(process.env.ODOS_DEV_PRIMARY_ROLE);
  const result = await repairPracticeRoles(
    new LivePracticeRoleRepairAdapter(fhir, contractBootstrap),
    target,
    primaryRole,
    email,
    contractBootstrap,
  );
  console.log(`Role policies created: ${result.createdPolicies.length} [${result.createdPolicies.join(", ")}]`);
  console.log(`Role policies tagged: ${result.taggedPolicies.length} [${result.taggedPolicies.join(", ")}]`);
  console.log(`Role policies already correct: ${result.existingPolicies.length} [${result.existingPolicies.join(", ")}]`);
  console.log(`${result.membershipReference} target: ${result.targetEmail}`);
  console.log(`Membership reconciliation: ${result.membershipChanged ? "CHANGED" : "ALREADY EXACT"}`);
  console.log(`Roles granted: [${result.grantedRoles.join(", ")}]`);
  console.log(`Membership policy bindings: [${result.policyBindings.join(", ")}]`);
  console.log(`Dev login primary role: ${result.primaryRole}`);
}

export function devPrimaryRole(value: string | undefined): DevAdminPrimaryRole {
  const role = value?.trim() || DEV_ADMIN_ROLE;
  if (role !== "staff" && role !== "provider") {
    throw new Error("ODOS_DEV_PRIMARY_ROLE must be staff or provider.");
  }
  return role;
}

export function requiredEmailArgument(args: readonly string[]): string {
  const index = args.indexOf("--email");
  const value = index >= 0 ? args[index + 1]?.trim() : undefined;
  if (!value || value.startsWith("--")) {
    throw new Error("repair-practice-roles requires --email <email-or-Practitioner-reference>.");
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
