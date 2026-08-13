#!/usr/bin/env tsx
import { pathToFileURL } from "node:url";
import type { AccessPolicy, ProjectMembership, ProjectMembershipAccess } from "@medplum/fhirtypes";
import { createLiveOdosAuditRuntime } from "../mcp/src/authz/liveAudit.js";
import { buildOdosAuditEventRow } from "../mcp/src/authz/odosAudit.js";
import {
  buildMedplumAccessPolicy,
  getRoleDeclaration,
  ODOS_PRACTICE_ROLE_SYSTEM,
  PRACTICE_ROLE_IDS,
  type PracticeRoleId,
} from "../mcp/src/authz/roles.js";
import { createOperatorScriptFhirClient, type MedplumClient } from "../mcp/src/fhir-client.js";
import { searchAll } from "../mcp/src/fhir-search.js";
import { loginForLocalRepair } from "./repair-practice-roles.js";
import { assertLocalMedplumBaseUrl } from "./reseed-practice-role-tags.js";

const LEGACY_ROLE_FOLD = {
  "practice-admin": "admin",
  auditor: "admin",
  clinician: "provider",
  "aesthetics-provider": "provider",
  "front-desk": "staff",
} as const satisfies Record<string, PracticeRoleId>;

type LegacyRoleId = keyof typeof LEGACY_ROLE_FOLD;

export type PlannedMembershipAccess =
  | { readonly kind: "canonical"; readonly role: PracticeRoleId; readonly parameter?: ProjectMembershipAccess["parameter"] }
  | { readonly kind: "preserve"; readonly access: ProjectMembershipAccess };

export interface ThreeRoleMigrationPlan {
  readonly canonicalRolesToCreate: readonly PracticeRoleId[];
  readonly canonicalPolicyReferences: Readonly<Partial<Record<PracticeRoleId, string>>>;
  readonly memberships: readonly {
    readonly id: string;
    readonly versionId: string;
    readonly currentAccess: readonly ProjectMembershipAccess[];
    readonly access: readonly PlannedMembershipAccess[];
  }[];
}

export interface ThreeRoleMigrationAdapter {
  readPolicies(): Promise<AccessPolicy[]>;
  readMemberships(): Promise<ProjectMembership[]>;
  createPolicy(role: PracticeRoleId, policy: AccessPolicy): Promise<AccessPolicy>;
  patchMembership(
    id: string,
    access: ProjectMembershipAccess[],
    ifMatch: string,
  ): Promise<ProjectMembership>;
  recordMutation<T>(target: string, operation: () => Promise<T>): Promise<T>;
}

export interface ThreeRoleMigrationResult {
  readonly mode: "dry-run" | "apply";
  readonly policiesCreated: number;
  readonly membershipsChanged: number;
  readonly plan: ThreeRoleMigrationPlan;
}

export type ThreeRoleMigrationCredentialSource = "access-token" | "admin-login";

export async function resolveThreeRoleMigrationCredentials(input: {
  readonly baseUrl: string;
  readonly accessToken?: string;
  readonly adminEmail?: string;
  readonly adminPassword?: string;
  readonly login?: typeof loginForLocalRepair;
}): Promise<{ readonly accessToken: string; readonly source: ThreeRoleMigrationCredentialSource }> {
  const accessToken = input.accessToken?.trim();
  if (accessToken) return { accessToken, source: "access-token" };

  const email = input.adminEmail?.trim();
  const password = input.adminPassword?.trim();
  if (!email || !password) {
    throw new Error(
      "Provide MEDPLUM_ACCESS_TOKEN, or both MEDPLUM_ADMIN_EMAIL and MEDPLUM_ADMIN_PASSWORD.",
    );
  }
  return {
    accessToken: await (input.login ?? loginForLocalRepair)({
      baseUrl: input.baseUrl,
      email,
      password,
    }),
    source: "admin-login",
  };
}

export async function resolveThreeRoleMigrationProjectId(input: {
  readonly explicitProjectId?: string;
  readonly environmentProjectId?: string;
  readonly resolveSessionProjectId: () => Promise<string>;
}): Promise<string> {
  const explicitProjectId = input.explicitProjectId?.trim();
  if (explicitProjectId) return explicitProjectId;
  const environmentProjectId = input.environmentProjectId?.trim();
  if (environmentProjectId) return environmentProjectId;
  return input.resolveSessionProjectId();
}

export async function resolveAuthenticatedSessionProjectId(input: {
  readonly baseUrl: string;
  readonly accessToken: string;
  readonly fhir: Pick<MedplumClient, "search" | "searchUrl">;
  readonly request?: typeof fetch;
}): Promise<string> {
  const response = await (input.request ?? fetch)(`${input.baseUrl.replace(/\/$/, "")}/auth/me`, {
    headers: { Authorization: `Bearer ${input.accessToken}` },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) {
    throw new Error(
      `Three-role migration /auth/me failed: ${response.status}. ` +
      "Supply --project <project-id> or MEDPLUM_PROJECT_ID.",
    );
  }
  const body = (await response.json()) as {
    profile?: { resourceType?: string; id?: string; reference?: string };
    profileReference?: string;
  };
  const profileReference = body.profile?.reference
    ?? (body.profile?.resourceType && body.profile.id
      ? `${body.profile.resourceType}/${body.profile.id}`
      : undefined)
    ?? body.profileReference;
  if (!profileReference) {
    throw new Error(
      "Authenticated session has no profile reference. " +
      "Supply --project <project-id> or MEDPLUM_PROJECT_ID.",
    );
  }

  const memberships = (await searchAll<ProjectMembership>(
    input.fhir,
    "ProjectMembership",
    { profile: profileReference, _count: "100" },
  )).filter((membership) =>
    membership.active !== false && membership.profile.reference === profileReference
  );
  const candidates = memberships.flatMap((membership) => {
    const match = membership.project.reference?.match(/^Project\/([^/]+)$/);
    return match ? [match[1]!] : [];
  });
  if (candidates.length !== 1) {
    throw new Error(
      `Authenticated session profile ${profileReference} found ${candidates.length} active project memberships; ` +
      "supply --project <project-id> or MEDPLUM_PROJECT_ID.",
    );
  }
  return candidates[0]!;
}

export function planThreeRoleMigration(input: {
  projectId: string;
  policies: readonly AccessPolicy[];
  memberships: readonly ProjectMembership[];
}): ThreeRoleMigrationPlan {
  const projectReference = `Project/${input.projectId}`;
  const policiesByReference = new Map<string, AccessPolicy>();
  const canonical = new Map<PracticeRoleId, AccessPolicy>();

  for (const policy of input.policies) {
    if (!policy.id) throw new Error("Every migration AccessPolicy must carry an id.");
    policiesByReference.set(`AccessPolicy/${policy.id}`, policy);
    const tags = practiceRoleTags(policy);
    if (tags.length > 1) {
      throw new Error(`AccessPolicy/${policy.id} has ambiguous practice-role tags: ${tags.join(", ")}.`);
    }
    const role = tags[0];
    if (role && isCanonicalRole(role)) {
      if (canonical.has(role)) throw new Error(`Canonical ${role} AccessPolicy is not unique.`);
      assertPolicySafe(policy, projectReference);
      canonical.set(role, policy);
    }
  }

  const canonicalRolesToCreate = PRACTICE_ROLE_IDS.filter((role) => !canonical.has(role));
  const canonicalPolicyReferences: Partial<Record<PracticeRoleId, string>> = {};
  for (const role of PRACTICE_ROLE_IDS) {
    const policy = canonical.get(role);
    if (policy?.id) canonicalPolicyReferences[role] = `AccessPolicy/${policy.id}`;
  }

  const memberships = input.memberships.flatMap((membership) => {
    const currentAccess = membership.access ?? [];
    const referencesRolePolicy = currentAccess.some((entry) => {
      const policy = policiesByReference.get(entry.policy.reference ?? "");
      return policy ? practiceRoleTags(policy).length > 0 : true;
    }) || Boolean(membership.accessPolicy?.reference);
    if (!referencesRolePolicy) return [];
    if (!membership.id || !membership.meta?.versionId) {
      throw new Error("Every changed ProjectMembership must carry id and meta.versionId.");
    }
    if (membership.project?.reference !== projectReference) {
      throw new Error(`ProjectMembership/${membership.id} ownership mismatch.`);
    }
    if (membership.accessPolicy?.reference) {
      throw new Error(`ProjectMembership/${membership.id} has unmappable legacy accessPolicy; normalize access[] first.`);
    }

    const planned: PlannedMembershipAccess[] = [];
    const canonicalKeys = new Set<string>();
    for (const entry of currentAccess) {
      const reference = entry.policy.reference;
      const policy = reference ? policiesByReference.get(reference) : undefined;
      if (!policy) {
        throw new Error(`ProjectMembership/${membership.id} has unmappable access ${reference ?? "(missing reference)"}.`);
      }
      const tags = practiceRoleTags(policy);
      if (tags.length > 1) {
        throw new Error(`AccessPolicy/${policy.id} has ambiguous practice-role tags: ${tags.join(", ")}.`);
      }
      if (tags.length === 0) {
        planned.push({ kind: "preserve", access: structuredClone(entry) });
        continue;
      }
      assertPolicySafe(policy, projectReference);
      const sourceRole = tags[0]!;
      const role = isCanonicalRole(sourceRole)
        ? sourceRole
        : LEGACY_ROLE_FOLD[sourceRole as LegacyRoleId];
      if (!role) {
        throw new Error(`ProjectMembership/${membership.id} has unmappable access role ${sourceRole}.`);
      }
      const parameter = entry.parameter ? structuredClone(entry.parameter) : undefined;
      const key = `${role}:${JSON.stringify(parameter ?? null)}`;
      if (canonicalKeys.has(key)) continue;
      canonicalKeys.add(key);
      planned.push({ kind: "canonical", role, ...(parameter ? { parameter } : {}) });
    }
    return [{
      id: membership.id,
      versionId: membership.meta.versionId,
      currentAccess: structuredClone(currentAccess),
      access: planned,
    }];
  });

  return { canonicalRolesToCreate, canonicalPolicyReferences, memberships };
}

export async function executeThreeRoleMigration(
  adapter: ThreeRoleMigrationAdapter,
  options: { projectId: string; apply?: boolean },
): Promise<ThreeRoleMigrationResult> {
  let policies = await adapter.readPolicies();
  let memberships = await adapter.readMemberships();
  let plan = planThreeRoleMigration({ projectId: options.projectId, policies, memberships });
  if (!options.apply) {
    return { mode: "dry-run", policiesCreated: 0, membershipsChanged: changedMembershipCount(plan), plan };
  }

  let policiesCreated = 0;
  for (const role of plan.canonicalRolesToCreate) {
    await adapter.recordMutation(`AccessPolicy/${role}`, () =>
      adapter.createPolicy(role, buildMedplumAccessPolicy(getRoleDeclaration(role))));
    policiesCreated += 1;
  }

  if (policiesCreated > 0) {
    policies = await adapter.readPolicies();
    memberships = await adapter.readMemberships();
    plan = planThreeRoleMigration({ projectId: options.projectId, policies, memberships });
  }
  if (plan.canonicalRolesToCreate.length > 0) {
    throw new Error(`Canonical policy creation did not resolve: ${plan.canonicalRolesToCreate.join(", ")}.`);
  }

  let membershipsChanged = 0;
  for (const membership of plan.memberships) {
    const nextAccess = materializeAccess(membership.access, plan.canonicalPolicyReferences);
    if (JSON.stringify(nextAccess) === JSON.stringify(membership.currentAccess)) continue;
    await adapter.recordMutation(`ProjectMembership/${membership.id}`, () =>
      adapter.patchMembership(membership.id, nextAccess, `W/"${membership.versionId}"`));
    membershipsChanged += 1;
  }

  return { mode: "apply", policiesCreated, membershipsChanged, plan };
}

function changedMembershipCount(plan: ThreeRoleMigrationPlan): number {
  return plan.memberships.filter((membership) => {
    if (plan.canonicalRolesToCreate.length > 0) return true;
    return JSON.stringify(materializeAccess(membership.access, plan.canonicalPolicyReferences)) !==
      JSON.stringify(membership.currentAccess);
  }).length;
}

function materializeAccess(
  access: readonly PlannedMembershipAccess[],
  references: Readonly<Partial<Record<PracticeRoleId, string>>>,
): ProjectMembershipAccess[] {
  return access.map((entry) => {
    if (entry.kind === "preserve") return structuredClone(entry.access);
    const reference = references[entry.role];
    if (!reference) throw new Error(`Canonical ${entry.role} AccessPolicy reference is unavailable.`);
    return {
      policy: { reference },
      ...(entry.parameter ? { parameter: structuredClone(entry.parameter) } : {}),
    };
  });
}

function practiceRoleTags(policy: AccessPolicy): string[] {
  return (policy.meta?.tag ?? []).flatMap((tag) =>
    tag.system === ODOS_PRACTICE_ROLE_SYSTEM && tag.code ? [tag.code] : []);
}

function isCanonicalRole(value: string): value is PracticeRoleId {
  return PRACTICE_ROLE_IDS.includes(value as PracticeRoleId);
}

function assertPolicySafe(policy: AccessPolicy, projectReference: string): void {
  if (!policy.meta?.versionId) throw new Error(`AccessPolicy/${policy.id} is missing meta.versionId.`);
  const policyProject = policy.meta.project?.replace(/^Project\//, "");
  if (policyProject !== projectReference.replace(/^Project\//, "")) {
    throw new Error(`AccessPolicy/${policy.id} ownership mismatch.`);
  }
}

class LiveThreeRoleMigrationAdapter implements ThreeRoleMigrationAdapter {
  private readonly audit = createLiveOdosAuditRuntime({
    postgresUrl: process.env.ODOS_POSTGRES_URL ?? "postgresql://medplum:medplum@127.0.0.1:5433/medplum",
  });

  constructor(private readonly fhir: MedplumClient) {}

  readPolicies(): Promise<AccessPolicy[]> {
    return searchAll(this.fhir, "AccessPolicy", {});
  }

  readMemberships(): Promise<ProjectMembership[]> {
    return searchAll(this.fhir, "ProjectMembership", {});
  }

  createPolicy(_role: PracticeRoleId, policy: AccessPolicy): Promise<AccessPolicy> {
    return this.fhir.create(policy);
  }

  patchMembership(id: string, access: ProjectMembershipAccess[], ifMatch: string): Promise<ProjectMembership> {
    return this.fhir.patch("ProjectMembership", id, [{ op: "replace", path: "/access", value: access }], { "If-Match": ifMatch });
  }

  recordMutation<T>(target: string, operation: () => Promise<T>): Promise<T> {
    const [resourceType, resourceId] = target.split("/");
    return this.audit.record(buildOdosAuditEventRow({
      eventType: "role-change",
      actorId: "migrate-three-role-model",
      actorRole: "system",
      resourceType,
      resourceId,
      actionOutcome: "granted",
      actionReason: "fold legacy practice-role access into the canonical three-role model",
    }), operation);
  }
}

async function runCli(): Promise<void> {
  const args = new Set(process.argv.slice(2));
  const apply = args.has("--apply");
  const baseUrl = (process.env.MEDPLUM_BASE_URL ?? "http://localhost:8103").replace(/\/$/, "");
  assertLocalMedplumBaseUrl(baseUrl);
  const credentials = await resolveThreeRoleMigrationCredentials({
    baseUrl,
    accessToken: process.env.MEDPLUM_ACCESS_TOKEN,
    adminEmail: process.env.MEDPLUM_ADMIN_EMAIL,
    adminPassword: process.env.MEDPLUM_ADMIN_PASSWORD,
  });
  const fhir = createOperatorScriptFhirClient({
    baseUrl,
    accessToken: credentials.accessToken,
    reason: "Operator three-role migration runs outside request handling.",
  });
  const projectId = await resolveThreeRoleMigrationProjectId({
    explicitProjectId: argumentValue("--project"),
    environmentProjectId: process.env.MEDPLUM_PROJECT_ID,
    resolveSessionProjectId: () => resolveAuthenticatedSessionProjectId({
      baseUrl,
      accessToken: credentials.accessToken,
      fhir,
    }),
  });
  const result = await executeThreeRoleMigration(new LiveThreeRoleMigrationAdapter(fhir), { projectId, apply });
  console.log(JSON.stringify({
    mode: result.mode,
    policiesToCreate: result.plan.canonicalRolesToCreate,
    policiesCreated: result.policiesCreated,
    membershipsPlanned: result.plan.memberships.length,
    membershipsChanged: result.membershipsChanged,
  }, null, 2));
  if (!apply) console.log("Dry run only. Re-run with --apply after reviewing this plan.");
}

function argumentValue(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCli().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
