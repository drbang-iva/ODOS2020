#!/usr/bin/env tsx
import { createHash, randomBytes } from "node:crypto";
import type { AccessPolicy, ProjectMembership } from "@medplum/fhirtypes";
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
export const DEV_ADMIN_ROLE: PracticeRoleId = "front-desk";
export const DEV_ADMIN_GRANT_ROLES = [DEV_ADMIN_ROLE, "practice-admin", "clinician"] as const;
export type DevAdminGrantRole = (typeof DEV_ADMIN_GRANT_ROLES)[number];
export type DevAdminPrimaryRole = Extract<DevAdminGrantRole, "front-desk" | "clinician">;

export interface AuthenticatedProjectIdentity {
  readonly profileReference: string;
  readonly projectReference: string;
  readonly membershipReference?: string;
}

export interface PracticeRoleRepairAdapter {
  findPoliciesByName(name: string): Promise<AccessPolicy[]>;
  createPolicy(policy: AccessPolicy): Promise<AccessPolicy>;
  patchPolicy(id: string, operations: JsonPatchOperation[], versionId: string): Promise<AccessPolicy>;
  currentIdentity(): Promise<AuthenticatedProjectIdentity>;
  findMemberships(profileReference: string, projectReference: string): Promise<ProjectMembership[]>;
  readMembership(id: string): Promise<ProjectMembership>;
  patchMembership(id: string, operations: JsonPatchOperation[], versionId: string): Promise<ProjectMembership>;
}

export interface PracticeRoleRepairResult {
  readonly createdPolicies: PracticeRoleId[];
  readonly taggedPolicies: PracticeRoleId[];
  readonly existingPolicies: PracticeRoleId[];
  readonly membershipReference: string;
  readonly membershipGrants: Readonly<Record<DevAdminGrantRole, "ADDED" | "EXISTING">>;
  readonly primaryRole: DevAdminPrimaryRole;
}

export async function repairPracticeRoles(
  adapter: PracticeRoleRepairAdapter,
  primaryRole: DevAdminPrimaryRole = DEV_ADMIN_ROLE,
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

  const identity = await adapter.currentIdentity();
  const membership = await resolveCurrentMembership(adapter, identity);
  if (!membership.id || !membership.meta?.versionId) {
    throw new Error("Current ProjectMembership is missing id or meta.versionId; no safe conditional grant is possible.");
  }
  if (membership.active === false) {
    throw new Error(`ProjectMembership/${membership.id} is inactive; repair stopped.`);
  }
  if (membership.profile.reference !== identity.profileReference) {
    throw new Error(`ProjectMembership/${membership.id} does not belong to ${identity.profileReference}.`);
  }
  if (membership.project.reference !== identity.projectReference) {
    throw new Error(`ProjectMembership/${membership.id} does not belong to ${identity.projectReference}.`);
  }

  const grantReferences = Object.fromEntries(DEV_ADMIN_GRANT_ROLES.map((roleId) => {
    const policy = policies.get(roleId);
    if (!policy?.id) throw new Error(`${roleId} AccessPolicy is missing its id.`);
    return [roleId, `AccessPolicy/${policy.id}`];
  })) as Record<DevAdminGrantRole, string>;
  const existingReferences = membershipPolicyReferences(membership);
  const membershipGrants = {
    "front-desk": existingReferences.includes(grantReferences["front-desk"]) ? "EXISTING" : "ADDED",
    "practice-admin": existingReferences.includes(grantReferences["practice-admin"]) ? "EXISTING" : "ADDED",
    clinician: existingReferences.includes(grantReferences.clinician) ? "EXISTING" : "ADDED",
  } as const;
  const membershipPatch = devMembershipAccessPatch(membership, grantReferences, primaryRole);
  if (membershipPatch.length > 0) {
    await adapter.patchMembership(
      membership.id,
      membershipPatch,
      membership.meta.versionId,
    );
  }

  return {
    createdPolicies,
    taggedPolicies,
    existingPolicies,
    membershipReference: `ProjectMembership/${membership.id}`,
    membershipGrants,
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

export function devMembershipAccessPatch(
  membership: ProjectMembership,
  policyReferences: Readonly<Record<DevAdminGrantRole, string>>,
  primaryRole: DevAdminPrimaryRole = DEV_ADMIN_ROLE,
): JsonPatchOperation[] {
  const roleOrder = [primaryRole, ...DEV_ADMIN_GRANT_ROLES.filter((roleId) => roleId !== primaryRole)];
  const requiredReferences = new Set(DEV_ADMIN_GRANT_ROLES.map((roleId) => policyReferences[roleId]));
  // A repeated grant resolves to its last access entry before the ordered list removes duplicates.
  const existingByReference = new Map(
    (membership.access ?? []).map((access) => [access.policy.reference, access]),
  );
  const desiredAccess = [
    ...roleOrder.map((roleId) => existingByReference.get(policyReferences[roleId]) ?? {
      policy: { reference: policyReferences[roleId] },
    }),
    ...(membership.access ?? []).filter((access) => !requiredReferences.has(access.policy.reference ?? "")),
  ];
  if (!membership.access) {
    return [{ op: "add", path: "/access", value: desiredAccess }];
  }
  return JSON.stringify(membership.access) === JSON.stringify(desiredAccess)
    ? []
    : [{ op: "replace", path: "/access", value: desiredAccess }];
}

export function membershipPolicyReferences(membership: ProjectMembership): string[] {
  return [
    membership.accessPolicy?.reference,
    ...(membership.access ?? []).map((access) => access.policy.reference),
  ].filter((reference): reference is string => Boolean(reference));
}

async function resolveCurrentMembership(
  adapter: PracticeRoleRepairAdapter,
  identity: AuthenticatedProjectIdentity,
): Promise<ProjectMembership> {
  if (identity.membershipReference) {
    const id = identity.membershipReference.match(/^ProjectMembership\/([^/]+)$/)?.[1];
    if (!id) throw new Error(`Invalid current membership reference ${identity.membershipReference}.`);
    return adapter.readMembership(id);
  }
  const matches = await adapter.findMemberships(identity.profileReference, identity.projectReference);
  if (matches.length !== 1) {
    throw new Error(
      `Expected one current ProjectMembership for ${identity.profileReference}; found ${matches.length}.`,
    );
  }
  return matches[0]!;
}

class LivePracticeRoleRepairAdapter implements PracticeRoleRepairAdapter {
  constructor(
    private readonly baseUrl: string,
    private readonly accessToken: string,
    private readonly fhir: MedplumClient,
  ) {}

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
    return this.fhir.patch("AccessPolicy", id, operations, { "If-Match": `W/"${versionId}"` });
  }

  async currentIdentity(): Promise<AuthenticatedProjectIdentity> {
    const response = await fetch(`${this.baseUrl}/auth/me`, {
      headers: { Authorization: `Bearer ${this.accessToken}` },
    });
    if (!response.ok) throw new Error(`GET /auth/me failed: ${response.status} ${await response.text()}`);
    const body = (await response.json()) as {
      profile?: { resourceType?: string; id?: string };
      project?: { resourceType?: string; id?: string };
      membership?: { reference?: string; resourceType?: string; id?: string };
    };
    if (!body.profile?.resourceType || !body.profile.id || !body.project?.id) {
      throw new Error("Authenticated login has no project Practitioner profile.");
    }
    const membershipReference = body.membership?.reference ??
      (body.membership?.id ? `ProjectMembership/${body.membership.id}` : undefined);
    return {
      profileReference: `${body.profile.resourceType}/${body.profile.id}`,
      projectReference: `Project/${body.project.id}`,
      ...(membershipReference ? { membershipReference } : {}),
    };
  }

  async findMemberships(
    profileReference: string,
    projectReference: string,
  ): Promise<ProjectMembership[]> {
    return searchAll<ProjectMembership>(this.fhir, "ProjectMembership", {
      profile: profileReference,
      project: projectReference,
    });
  }

  async readMembership(id: string): Promise<ProjectMembership> {
    return this.fhir.read("ProjectMembership", id);
  }

  async patchMembership(
    id: string,
    operations: JsonPatchOperation[],
    versionId: string,
  ): Promise<ProjectMembership> {
    return this.fhir.patch("ProjectMembership", id, operations, { "If-Match": `W/"${versionId}"` });
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
  const email = requireEnv("OSOD_ADMIN_EMAIL", "MEDPLUM_ADMIN_EMAIL");
  const password = requireEnv("OSOD_ADMIN_PASSWORD", "MEDPLUM_ADMIN_PASSWORD");
  const accessToken = await loginForLocalRepair({ baseUrl, email, password });
  const fhir = createMedplumClient({ baseUrl, accessToken });
  const primaryRole = devPrimaryRole(process.env.OSOD_DEV_PRIMARY_ROLE);
  const result = await repairPracticeRoles(
    new LivePracticeRoleRepairAdapter(baseUrl, accessToken, fhir),
    primaryRole,
  );
  console.log(`Role policies created: ${result.createdPolicies.length} [${result.createdPolicies.join(", ")}]`);
  console.log(`Role policies tagged: ${result.taggedPolicies.length} [${result.taggedPolicies.join(", ")}]`);
  console.log(`Role policies already correct: ${result.existingPolicies.length} [${result.existingPolicies.join(", ")}]`);
  console.log(`${result.membershipReference} ${DEV_ADMIN_ROLE} grant: ${result.membershipGrants[DEV_ADMIN_ROLE]}`);
  console.log(`${result.membershipReference} practice-admin grant: ${result.membershipGrants["practice-admin"]}`);
  console.log(`${result.membershipReference} clinician grant: ${result.membershipGrants.clinician}`);
  console.log(`Dev login primary role: ${result.primaryRole}`);
}

export function devPrimaryRole(value: string | undefined): DevAdminPrimaryRole {
  const role = value?.trim() || DEV_ADMIN_ROLE;
  if (role !== "front-desk" && role !== "clinician") {
    throw new Error("OSOD_DEV_PRIMARY_ROLE must be front-desk or clinician.");
  }
  return role;
}

function requireEnv(primary: string, fallback: string): string {
  const value = process.env[primary]?.trim() || process.env[fallback]?.trim();
  if (!value) throw new Error(`${primary} or ${fallback} is required.`);
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
