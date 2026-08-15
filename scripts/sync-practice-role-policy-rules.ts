#!/usr/bin/env tsx
import { pathToFileURL } from "node:url";
import type { AccessPolicy, ProjectMembership, ProjectMembershipAccess } from "@medplum/fhirtypes";
import { compileCompositeMembershipAccess } from "../mcp/src/authz/role-grants.js";
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
import { searchAll } from "../mcp/src/fhir-search.js";
import { diffCanonicalPolicyRules } from "./access-policy-rules.js";
import {
  assertAuthenticatedSessionProject,
  readAuthenticatedSessionProject,
  resolveThreeRoleMigrationCredentials,
  type ThreeRoleMigrationCredentialSource,
} from "./migrate-three-role-model.js";
import { loginForLocalRepair } from "./repair-practice-roles.js";
import { assertLocalMedplumBaseUrl } from "./reseed-practice-role-tags.js";

const DEFAULT_BASE_URL = "http://localhost:8103";

export interface PracticeRolePolicyRuleSyncAdapter {
  readPolicies(projectId: string): Promise<AccessPolicy[]>;
  readMemberships(projectId: string): Promise<ProjectMembership[]>;
  createPolicy(projectId: string, policy: AccessPolicy): Promise<AccessPolicy>;
  patchPolicy(
    id: string,
    operations: JsonPatchOperation[],
    versionId: string,
  ): Promise<AccessPolicy>;
  patchMembership(
    id: string,
    operations: JsonPatchOperation[],
    versionId: string,
  ): Promise<ProjectMembership>;
}

export interface PracticeRolePolicyRuleSyncPolicyResult {
  readonly role?: PracticeRoleId;
  readonly roles: readonly PracticeRoleId[];
  readonly status: "match" | "drift";
  readonly policyReference: string;
  readonly policyName?: string;
  readonly versionId: string;
  readonly missingRules: readonly unknown[];
  readonly unexpectedRules: readonly unknown[];
}

export interface PracticeRolePolicyRuleSyncResult {
  readonly mode: "dry-run" | "apply";
  readonly policiesCreated: number;
  readonly policiesUpdated: number;
  readonly compositesRequired: number;
  readonly membershipsDrifted: number;
  readonly membershipsUpdated: number;
  readonly policies: readonly PracticeRolePolicyRuleSyncPolicyResult[];
}

export class PracticeRolePolicyRuleSyncApplyError extends Error {
  constructor(
    readonly policyReference: string,
    readonly policiesUpdated: number,
    cause: unknown,
  ) {
    const updateLabel = policiesUpdated === 1 ? "policy update" : "policy updates";
    const detail = cause instanceof Error ? cause.message : String(cause);
    super(
      `${policyReference} update failed after ${policiesUpdated} ${updateLabel}. `
      + `Re-run the sync; already-updated policies will report MATCH. Cause: ${detail}`,
      { cause },
    );
    this.name = "PracticeRolePolicyRuleSyncApplyError";
  }
}

interface PlannedPolicyRuleSync {
  readonly policy: AccessPolicy & { id: string; meta: { versionId: string } };
  readonly expected: AccessPolicy;
  readonly result: PracticeRolePolicyRuleSyncPolicyResult;
}

interface PlannedMembershipSync {
  readonly membership: ProjectMembership & { id: string; meta: { versionId: string } };
  readonly roles: readonly PracticeRoleId[];
  readonly nextAccess?: readonly ProjectMembershipAccess[];
}

interface PracticeRolePolicySyncPlan {
  readonly policies: readonly PlannedPolicyRuleSync[];
  readonly missingComposites: readonly AccessPolicy[];
  readonly memberships: readonly PlannedMembershipSync[];
}

export async function syncPracticeRolePolicyRules(
  adapter: PracticeRolePolicyRuleSyncAdapter,
  options: {
    readonly projectId: string;
    readonly apply?: boolean;
    readonly bootstrapServiceIdentity?: boolean;
    readonly assertProjectScope: () => Promise<void>;
  },
): Promise<PracticeRolePolicyRuleSyncResult> {
  if (!options.bootstrapServiceIdentity) await options.assertProjectScope();
  let policies = await adapter.readPolicies(options.projectId);
  let memberships = await adapter.readMemberships(options.projectId);
  if (options.bootstrapServiceIdentity) {
    assertBootstrapResourceProjectScope(policies, memberships, options.projectId);
  }
  let plan = planPracticeRolePolicySync(policies, memberships, options.projectId);
  if (!options.apply) {
    return {
      mode: "dry-run",
      policiesCreated: 0,
      policiesUpdated: 0,
      compositesRequired: plan.missingComposites.length,
      membershipsDrifted: plan.memberships.length,
      membershipsUpdated: 0,
      policies: plan.policies.map(({ result }) => result),
    };
  }

  let policiesCreated = 0;
  for (const expected of plan.missingComposites) {
    await adapter.createPolicy(options.projectId, {
      ...structuredClone(expected),
      meta: { ...expected.meta, project: options.projectId },
    });
    policiesCreated += 1;
  }
  if (policiesCreated > 0) {
    policies = await adapter.readPolicies(options.projectId);
    memberships = await adapter.readMemberships(options.projectId);
    if (options.bootstrapServiceIdentity) {
      assertBootstrapResourceProjectScope(policies, memberships, options.projectId);
    }
    plan = planPracticeRolePolicySync(policies, memberships, options.projectId);
    if (plan.missingComposites.length > 0) {
      throw new Error("Composite policy creation did not resolve every required role set.");
    }
  }

  let policiesUpdated = 0;
  for (const item of plan.policies) {
    if (item.result.status === "match") continue;
    try {
      await adapter.patchPolicy(
        item.policy.id,
        [{
          op: item.policy.resource === undefined ? "add" : "replace",
          path: "/resource",
          value: structuredClone(item.expected.resource ?? []),
        }],
        item.policy.meta.versionId,
      );
    } catch (error) {
      throw new PracticeRolePolicyRuleSyncApplyError(
        item.result.policyReference,
        policiesUpdated,
        error,
      );
    }
    policiesUpdated += 1;
  }
  let membershipsUpdated = 0;
  for (const item of plan.memberships) {
    if (!item.nextAccess) {
      throw new Error(`ProjectMembership/${item.membership.id} has no materialized composite AccessPolicy.`);
    }
    await adapter.patchMembership(
      item.membership.id,
      [
        {
          op: item.membership.access === undefined ? "add" : "replace",
          path: "/access",
          value: [...structuredClone(item.nextAccess)],
        },
        ...(item.membership.accessPolicy
          ? [{ op: "remove" as const, path: "/accessPolicy" }]
          : []),
      ],
      item.membership.meta.versionId,
    );
    membershipsUpdated += 1;
  }
  return {
    mode: "apply",
    policiesCreated,
    policiesUpdated,
    compositesRequired: policiesCreated,
    membershipsDrifted: plan.memberships.length,
    membershipsUpdated,
    policies: plan.policies.map(({ result }) => result),
  };
}

function assertBootstrapResourceProjectScope(
  policies: readonly AccessPolicy[],
  memberships: readonly ProjectMembership[],
  projectId: string,
): void {
  for (const policy of policies) {
    if (policy.meta?.project === projectId) continue;
    const reference = policy.id ? `AccessPolicy/${policy.id}` : "AccessPolicy without id";
    throw new Error(
      `${reference} belongs to project ${policy.meta?.project ?? "<missing>"}, not --project ${projectId}; `
      + "bootstrap service identity refused before composing any patch.",
    );
  }
  for (const membership of memberships) {
    const reference = membership.id
      ? `ProjectMembership/${membership.id}`
      : "ProjectMembership without id";
    const owner = membership.meta?.project?.replace(/^Project\//, "")
      ?? membership.project.reference?.replace(/^Project\//, "");
    if (owner === projectId && membership.project.reference === `Project/${projectId}`) continue;
    throw new Error(
      `${reference} belongs to project ${owner ?? "<missing>"}, not --project ${projectId}; `
      + "bootstrap service identity refused before composing any patch.",
    );
  }
}

function planPracticeRolePolicySync(
  policies: readonly AccessPolicy[],
  memberships: readonly ProjectMembership[],
  projectId: string,
): PracticeRolePolicySyncPlan {
  assertRecognizedPracticeRolePolicies(policies);
  const canonical = PRACTICE_ROLE_IDS.map((role) => planPolicyRuleSync(policies, role));
  const compositePolicies = policies
    .filter((policy) => practiceRoles(policy).length > 1)
    .map((policy) => planCompositePolicyRuleSync(policy));
  const byReference = new Map<string, AccessPolicy>(policies.flatMap((policy) =>
    policy.id ? [[`AccessPolicy/${policy.id}`, policy] as const] : []
  ));
  const missingByKey = new Map<string, AccessPolicy>();
  const membershipPlan = memberships.flatMap((membership): PlannedMembershipSync[] => {
    const currentAccess = [
      ...(membership.access ?? []),
      ...(membership.accessPolicy?.reference
        ? [{ policy: { reference: membership.accessPolicy.reference } }]
        : []),
    ];
    const boundPolicies = currentAccess.map((access) => {
      const reference = access.policy.reference;
      const policy = reference ? byReference.get(reference) : undefined;
      if (!policy) {
        throw new Error(
          `ProjectMembership/${membership.id ?? "<missing>"} references unavailable ${reference ?? "AccessPolicy"}.`,
        );
      }
      return { access, reference: reference!, policy };
    });
    const roles = canonicalRoleOrder(boundPolicies.flatMap(({ policy }) => practiceRoles(policy)));
    if (roles.length < 2) return [];
    if (!membership.id || !membership.meta?.versionId) {
      throw new Error("Every changed ProjectMembership must carry id and meta.versionId.");
    }
    if (membership.project.reference !== `Project/${projectId}`) {
      throw new Error(`ProjectMembership/${membership.id} ownership mismatch.`);
    }
    const expected = buildMedplumCompositeAccessPolicy(roles);
    const candidates = compositePolicies.filter(({ result }) => sameRoles(result.roles, roles));
    if (candidates.length > 1) {
      throw new Error(`Expected at most one ${expected.name}; found ${candidates.length}.`);
    }
    const targetReference = candidates[0]?.result.policyReference;
    if (!targetReference) missingByKey.set(roleSetKey(roles), expected);
    const sourcePolicyRoles = new Map<string, readonly PracticeRoleId[]>(boundPolicies
      .flatMap(({ policy, reference }) => {
        const roles = practiceRoles(policy);
        return roles.length > 0 ? [[reference, roles] as const] : [];
      }));
    const nextAccess = targetReference
      ? compileCompositeMembershipAccess(currentAccess, sourcePolicyRoles, targetReference)
      : undefined;
    if (
      nextAccess
      && !membership.accessPolicy
      && JSON.stringify(nextAccess) === JSON.stringify(membership.access ?? [])
    ) return [];
    return [{
      membership: membership as ProjectMembership & { id: string; meta: { versionId: string } },
      roles,
      ...(nextAccess ? { nextAccess } : {}),
    }];
  });
  return {
    policies: [...canonical, ...compositePolicies],
    missingComposites: [...missingByKey.values()],
    memberships: membershipPlan,
  };
}

function planCompositePolicyRuleSync(policy: AccessPolicy): PlannedPolicyRuleSync {
  if (!policy.id) throw new Error("Composite AccessPolicy is missing id.");
  if (!policy.meta?.versionId) throw new Error(`AccessPolicy/${policy.id} is missing meta.versionId.`);
  const roles = practiceRoles(policy);
  const expected = buildMedplumCompositeAccessPolicy(roles);
  if (policy.name !== expected.name) {
    throw new Error(`AccessPolicy/${policy.id} has multi-role tags but is not named ${expected.name}.`);
  }
  const diff = diffCanonicalPolicyRules(policy, expected);
  return {
    policy: policy as AccessPolicy & { id: string; meta: { versionId: string } },
    expected,
    result: {
      roles,
      status: diff.matches ? "match" : "drift",
      policyReference: `AccessPolicy/${policy.id}`,
      policyName: policy.name,
      versionId: policy.meta.versionId,
      missingRules: diff.missingRules,
      unexpectedRules: diff.unexpectedRules,
    },
  };
}

function planPolicyRuleSync(
  policies: readonly AccessPolicy[],
  role: PracticeRoleId,
): PlannedPolicyRuleSync {
  const matches = policies.filter((policy) => {
    const roles = practiceRoles(policy);
    return roles.length === 1 && roles[0] === role;
  });
  if (matches.length !== 1) {
    throw new Error(`Expected exactly one tagged ${role} AccessPolicy; found ${matches.length}.`);
  }
  const policy = matches[0]!;
  if (!policy.id) throw new Error(`Tagged ${role} AccessPolicy is missing id.`);
  if (!policy.meta?.versionId) {
    throw new Error(`AccessPolicy/${policy.id} is missing meta.versionId.`);
  }
  const expected = buildMedplumAccessPolicy(getRoleDeclaration(role));
  const diff = diffCanonicalPolicyRules(policy, expected);
  return {
    policy: policy as AccessPolicy & { id: string; meta: { versionId: string } },
    expected,
    result: {
      role,
      roles: [role],
      status: diff.matches ? "match" : "drift",
      policyReference: `AccessPolicy/${policy.id}`,
      ...(policy.name ? { policyName: policy.name } : {}),
      versionId: policy.meta.versionId,
      missingRules: diff.missingRules,
      unexpectedRules: diff.unexpectedRules,
    },
  };
}

function assertRecognizedPracticeRolePolicies(policies: readonly AccessPolicy[]): void {
  for (const policy of policies) {
    const roles = practiceRoles(policy);
    if (roles.length > 1) {
      const reference = policy.id ? `AccessPolicy/${policy.id}` : "Tagged AccessPolicy";
      const expected = buildMedplumCompositeAccessPolicy(roles);
      if (policy.name !== expected.name) {
        throw new Error(`${reference} has ambiguous practice-role tags: ${roles.join(", ")}.`);
      }
    }
  }
}

function practiceRoles(policy: AccessPolicy): PracticeRoleId[] {
  return canonicalRoleOrder((policy.meta?.tag ?? []).flatMap((tag) =>
    tag.system === ODOS_PRACTICE_ROLE_SYSTEM
    && PRACTICE_ROLE_IDS.includes(tag.code as PracticeRoleId)
      ? [tag.code as PracticeRoleId]
      : []
  ));
}

function canonicalRoleOrder(roles: readonly PracticeRoleId[]): PracticeRoleId[] {
  return PRACTICE_ROLE_IDS.filter((role) => roles.includes(role));
}

function sameRoles(left: readonly PracticeRoleId[], right: readonly PracticeRoleId[]): boolean {
  return roleSetKey(left) === roleSetKey(right);
}

function roleSetKey(roles: readonly PracticeRoleId[]): string {
  return canonicalRoleOrder(roles).join("+");
}

export class LivePracticeRolePolicyRuleSyncAdapter
implements PracticeRolePolicyRuleSyncAdapter {
  constructor(private readonly fhir: MedplumClient) {}

  readPolicies(projectId: string): Promise<AccessPolicy[]> {
    return searchAll(this.fhir, "AccessPolicy", { _project: projectId });
  }

  readMemberships(projectId: string): Promise<ProjectMembership[]> {
    return searchAll(this.fhir, "ProjectMembership", { _project: projectId });
  }

  createPolicy(projectId: string, policy: AccessPolicy): Promise<AccessPolicy> {
    return this.fhir.create({
      ...structuredClone(policy),
      meta: { ...policy.meta, project: projectId },
    });
  }

  patchPolicy(
    id: string,
    operations: JsonPatchOperation[],
    versionId: string,
  ): Promise<AccessPolicy> {
    return this.fhir.patch(
      "AccessPolicy",
      id,
      operations,
      { "If-Match": `W/"${versionId}"` },
    );
  }

  patchMembership(
    id: string,
    operations: JsonPatchOperation[],
    versionId: string,
  ): Promise<ProjectMembership> {
    return this.fhir.patch(
      "ProjectMembership",
      id,
      operations,
      { "If-Match": `W/"${versionId}"` },
    );
  }
}

export function formatPracticeRolePolicyRuleSync(
  result: PracticeRolePolicyRuleSyncResult,
): string {
  const lines = [`Mode: ${result.mode}`];
  for (const policy of result.policies) {
    const name = policy.policyName ? ` "${policy.policyName}"` : "";
    lines.push(
      `${policy.roles.join("+")}: ${policy.status.toUpperCase()} ${policy.policyReference}${name}`,
    );
    for (const rule of policy.missingRules) {
      lines.push(`  missing ${JSON.stringify(rule)}`);
    }
    for (const rule of policy.unexpectedRules) {
      lines.push(`  unexpected ${JSON.stringify(rule)}`);
    }
  }
  lines.push(`Composite policies required: ${result.compositesRequired}`);
  lines.push(`Composite policies created: ${result.policiesCreated}`);
  lines.push(`Policies updated: ${result.policiesUpdated}`);
  lines.push(`Memberships requiring compilation: ${result.membershipsDrifted}`);
  lines.push(`Memberships updated: ${result.membershipsUpdated}`);
  if (result.mode === "dry-run") {
    lines.push("Dry run only. Re-run with --apply after reviewing every rule difference.");
  }
  return lines.join("\n");
}

export function requiredPracticeRolePolicyRuleSyncProjectId(
  args: readonly string[],
  environmentProjectId: string | undefined,
  bootstrapServiceIdentity = false,
): string {
  const projectIndex = args.indexOf("--project");
  const explicitProjectId = projectIndex >= 0 ? args[projectIndex + 1]?.trim() : undefined;
  if (bootstrapServiceIdentity && (!explicitProjectId || explicitProjectId.startsWith("--"))) {
    throw new Error(
      "--bootstrap-service-identity requires explicit --project <project-id>; "
      + "MEDPLUM_PROJECT_ID is not accepted for this break-glass path.",
    );
  }
  const projectId = explicitProjectId || environmentProjectId?.trim();
  if (!projectId) {
    throw new Error(
      "Supply --project <project-id> or MEDPLUM_PROJECT_ID for practice-role policy rule sync.",
    );
  }
  return projectId;
}

export async function resolvePracticeRolePolicyRuleSyncCredentials(input: {
  readonly baseUrl: string;
  readonly projectId: string;
  readonly bootstrapServiceIdentity: boolean;
  readonly accessToken?: string;
  readonly adminEmail?: string;
  readonly adminPassword?: string;
  readonly login?: typeof loginForLocalRepair;
}): Promise<{
  readonly accessToken: string;
  readonly source: ThreeRoleMigrationCredentialSource | "bootstrap-service-identity";
}> {
  if (!input.bootstrapServiceIdentity) {
    return resolveThreeRoleMigrationCredentials({
      baseUrl: input.baseUrl,
      projectId: input.projectId,
      accessToken: input.accessToken,
      adminEmail: input.adminEmail,
      adminPassword: input.adminPassword,
      login: input.login,
    });
  }
  if (input.accessToken?.trim()) {
    throw new Error(
      "--bootstrap-service-identity refuses MEDPLUM_ACCESS_TOKEN; "
      + "authenticate explicitly with the configured service identity credentials.",
    );
  }
  const email = input.adminEmail?.trim();
  const password = input.adminPassword;
  if (!email || !password?.trim()) {
    throw new Error(
      "--bootstrap-service-identity requires MEDPLUM_ADMIN_EMAIL and MEDPLUM_ADMIN_PASSWORD.",
    );
  }
  return {
    accessToken: await (input.login ?? loginForLocalRepair)({
      baseUrl: input.baseUrl,
      email,
      password,
    }),
    source: "bootstrap-service-identity",
  };
}

async function runCli(): Promise<void> {
  const args = process.argv.slice(2);
  const apply = args.includes("--apply");
  const bootstrapServiceIdentity = args.includes("--bootstrap-service-identity");
  const projectId = requiredPracticeRolePolicyRuleSyncProjectId(
    args,
    process.env.MEDPLUM_PROJECT_ID,
    bootstrapServiceIdentity,
  );
  const baseUrl = (process.env.MEDPLUM_BASE_URL ?? DEFAULT_BASE_URL).replace(/\/$/, "");
  assertLocalMedplumBaseUrl(baseUrl);
  if (bootstrapServiceIdentity) {
    console.warn(
      "BREAK-GLASS: BOOTSTRAP SERVICE IDENTITY ACTIVE. "
      + `Target is restricted to AccessPolicy and ProjectMembership resources in --project ${projectId}.`,
    );
  }
  const credentials = await resolvePracticeRolePolicyRuleSyncCredentials({
    baseUrl,
    projectId,
    bootstrapServiceIdentity,
    accessToken: process.env.MEDPLUM_ACCESS_TOKEN,
    adminEmail: process.env.MEDPLUM_ADMIN_EMAIL,
    adminPassword: process.env.MEDPLUM_ADMIN_PASSWORD,
  });
  const fhir = createOperatorScriptFhirClient({
    baseUrl,
    accessToken: credentials.accessToken,
    reason: "Operator practice-role policy rule sync runs outside request handling.",
    extendedMode: true,
  });
  const credentialSource = credentials.source;
  const assertProjectScope = credentialSource === "bootstrap-service-identity"
    ? async (): Promise<void> => {
        throw new Error(
          "Bootstrap service identity must use the target-project resource guard, not the session-project guard.",
        );
      }
    : async (): Promise<void> => {
        const session = await readAuthenticatedSessionProject({
          baseUrl,
          accessToken: credentials.accessToken,
        });
        await assertAuthenticatedSessionProject({
          session,
          targetProjectId: projectId,
          fhir,
          credentialSource,
        });
      };
  const result = await syncPracticeRolePolicyRules(
    new LivePracticeRolePolicyRuleSyncAdapter(fhir),
    {
      projectId,
      apply,
      bootstrapServiceIdentity,
      assertProjectScope,
    },
  );
  console.log(formatPracticeRolePolicyRuleSync(result));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCli().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
