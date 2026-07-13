#!/usr/bin/env tsx
import type { AccessPolicy, ProjectMembership, User } from "@medplum/fhirtypes";
import { createLiveOsodAuditRuntime } from "../mcp/src/authz/liveAudit.js";
import { buildOsodAuditEventRow } from "../mcp/src/authz/osodAudit.js";
import { reconcileMembershipAccess } from "../mcp/src/authz/role-grants.js";
import {
  OSOD_PRACTICE_ROLE_SYSTEM,
  type PracticeRoleId,
} from "../mcp/src/authz/roles.js";
import { createMedplumClient, type JsonPatchOperation, type MedplumClient } from "../mcp/src/fhir-client.js";
import { searchAll } from "../mcp/src/fhir-search.js";
import { loginForLocalRepair } from "./repair-practice-roles.js";
import { assertLocalMedplumBaseUrl } from "./reseed-practice-role-tags.js";

const DEFAULT_BASE_URL = "http://localhost:8103";
const DEFAULT_POSTGRES_URL = "postgresql://medplum:medplum@127.0.0.1:5432/medplum";
const ADMIN_EMAIL = "admin@osod.local";
const CLINICIAN_EMAIL = "clinician@osod.local";
const ADMIN_ROLES_TO_STRIP = new Set<PracticeRoleId>(["front-desk", "practice-admin", "clinician"]);

export interface CleanupMembershipResult {
  membershipId: string;
  changed: boolean;
}

export function cleanupMembershipOperations(input: {
  membership: ProjectMembership;
  policyRoles: ReadonlyMap<string, PracticeRoleId>;
  stripRoles?: ReadonlySet<PracticeRoleId>;
}): JsonPatchOperation[] {
  const references = [
    ...(input.membership.access ?? []).map((access) => access.policy.reference),
    input.membership.accessPolicy?.reference,
  ].filter((reference): reference is string => Boolean(reference));
  const desired = references.filter((reference, index) =>
    references.indexOf(reference) === index &&
    !input.stripRoles?.has(input.policyRoles.get(reference) as PracticeRoleId),
  );
  return reconcileMembershipAccess(input.membership, desired);
}

async function runCleanup(fhir: MedplumClient): Promise<CleanupMembershipResult[]> {
  const policies = await searchAll<AccessPolicy>(fhir, "AccessPolicy", {});
  const policyRoles = new Map<string, PracticeRoleId>();
  for (const policy of policies) {
    const role = policy.meta?.tag?.find((tag) => tag.system === OSOD_PRACTICE_ROLE_SYSTEM)?.code as
      | PracticeRoleId
      | undefined;
    if (policy.id && role) policyRoles.set(`AccessPolicy/${policy.id}`, role);
  }

  const users = await searchAll<User>(fhir, "User", {});
  const userEmails = new Map(
    users.flatMap((user) => user.id && user.email ? [[`User/${user.id}`, user.email.toLowerCase()] as const] : []),
  );
  const memberships = await searchAll<ProjectMembership>(fhir, "ProjectMembership", {});
  const audit = createLiveOsodAuditRuntime({
    postgresUrl: process.env.OSOD_POSTGRES_URL ?? DEFAULT_POSTGRES_URL,
    disabled: process.env.OSOD_ROLE_CLEANUP_AUDIT_DISABLED === "true",
  });
  const results: CleanupMembershipResult[] = [];

  for (const membership of memberships) {
    if (!membership.id || !membership.meta?.versionId) {
      throw new Error("Every cleanup ProjectMembership must carry id and meta.versionId.");
    }
    const email = userEmails.get(membership.user.reference ?? "");
    const operations = cleanupMembershipOperations({
      membership,
      policyRoles,
      ...(email === ADMIN_EMAIL ? { stripRoles: ADMIN_ROLES_TO_STRIP } : {}),
    });
    if (operations.length > 0) {
      await audit.record(
        buildOsodAuditEventRow({
          eventType: "role-change",
          actorId: "cleanup-practice-role-memberships",
          actorRole: "system",
          resourceType: "ProjectMembership",
          resourceId: membership.id,
          actionOutcome: "granted",
          actionReason: email === ADMIN_EMAIL
            ? `strip human practice roles from service identity ${ADMIN_EMAIL}`
            : email === CLINICIAN_EMAIL
              ? `dedupe practice roles and migrate legacy access for ${CLINICIAN_EMAIL}`
              : "migrate legacy ProjectMembership accessPolicy into access[]",
        }),
        () => fhir.patch("ProjectMembership", membership.id!, operations, {
          "If-Match": `W/\"${membership.meta!.versionId}\"`,
        }),
      );
    }
    results.push({ membershipId: membership.id, changed: operations.length > 0 });
  }
  return results;
}

async function runCli(): Promise<void> {
  const baseUrl = (process.env.MEDPLUM_BASE_URL ?? DEFAULT_BASE_URL).replace(/\/$/, "");
  assertLocalMedplumBaseUrl(baseUrl);
  const email = requireEnv("MEDPLUM_ADMIN_EMAIL");
  const password = requireEnv("MEDPLUM_ADMIN_PASSWORD");
  const accessToken = await loginForLocalRepair({ baseUrl, email, password });
  const results = await runCleanup(createMedplumClient({ baseUrl, accessToken }));
  console.log(`Memberships inspected: ${results.length}`);
  console.log(`Memberships changed: ${results.filter((result) => result.changed).length}`);
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
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
