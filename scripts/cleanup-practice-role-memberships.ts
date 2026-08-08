#!/usr/bin/env tsx
import type { AccessPolicy, Practitioner, ProjectMembership } from "@medplum/fhirtypes";
import { createLiveOdosAuditRuntime } from "../mcp/src/authz/liveAudit.js";
import { buildOdosAuditEventRow } from "../mcp/src/authz/odosAudit.js";
import { reconcileMembershipAccess } from "../mcp/src/authz/role-grants.js";
import {
  ODOS_PRACTICE_ROLE_SYSTEM,
  type PracticeRoleId,
} from "../mcp/src/authz/roles.js";
import { createOperatorScriptFhirClient, type JsonPatchOperation, type MedplumClient } from "../mcp/src/fhir-client.js";
import { searchAll } from "../mcp/src/fhir-search.js";
import { loginForLocalRepair } from "./repair-practice-roles.js";
import { assertLocalMedplumBaseUrl } from "./reseed-practice-role-tags.js";

const DEFAULT_BASE_URL = "http://localhost:8103";
const DEFAULT_POSTGRES_URL = "postgresql://medplum:medplum@127.0.0.1:5433/medplum";
const ADMIN_EMAIL = "admin@odos.local";
const CLINICIAN_EMAIL = "clinician@odos.local";
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
  const membership = input.stripRoles
    ? {
        ...input.membership,
        access: input.membership.access?.filter((access) =>
          !input.stripRoles!.has(input.policyRoles.get(access.policy.reference ?? "") as PracticeRoleId),
        ),
        accessPolicy: input.stripRoles.has(
          input.policyRoles.get(input.membership.accessPolicy?.reference ?? "") as PracticeRoleId,
        )
          ? undefined
          : input.membership.accessPolicy,
      }
    : input.membership;
  const references = [
    ...(membership.access ?? []).map((access) => access.policy.reference),
    membership.accessPolicy?.reference,
  ].filter((reference): reference is string => Boolean(reference));
  const desired = references.filter((reference, index) =>
    references.indexOf(reference) === index,
  );
  const reconciled = reconcileMembershipAccess(membership, desired);
  if (!input.stripRoles) return reconciled;

  const accessOperation = reconciled.find((operation) => operation.path === "/access");
  const reconciledAccess = accessOperation && "value" in accessOperation
    ? accessOperation.value as ProjectMembership["access"]
    : undefined;
  const desiredAccess = reconciledAccess ?? membership.access ?? [];
  const operations: JsonPatchOperation[] = [];
  if (JSON.stringify(input.membership.access ?? []) !== JSON.stringify(desiredAccess)) {
    operations.push({
      op: input.membership.access ? "replace" : "add",
      path: "/access",
      value: desiredAccess,
    });
  }
  if (input.membership.accessPolicy) {
    operations.push({ op: "remove", path: "/accessPolicy" });
  }
  return operations;
}

async function runCleanup(fhir: MedplumClient): Promise<CleanupMembershipResult[]> {
  const policies = await searchAll<AccessPolicy>(fhir, "AccessPolicy", {});
  const policyRoles = new Map<string, PracticeRoleId>();
  for (const policy of policies) {
    const role = policy.meta?.tag?.find((tag) => tag.system === ODOS_PRACTICE_ROLE_SYSTEM)?.code as
      | PracticeRoleId
      | undefined;
    if (policy.id && role) policyRoles.set(`AccessPolicy/${policy.id}`, role);
  }

  const memberships = await searchAll<ProjectMembership>(fhir, "ProjectMembership", {});
  const audit = createLiveOdosAuditRuntime({
    postgresUrl: process.env.ODOS_POSTGRES_URL ?? DEFAULT_POSTGRES_URL,
    disabled: process.env.ODOS_ROLE_CLEANUP_AUDIT_DISABLED === "true",
  });
  const results: CleanupMembershipResult[] = [];

  for (const membership of memberships) {
    if (!membership.id || !membership.meta?.versionId) {
      throw new Error("Every cleanup ProjectMembership must carry id and meta.versionId.");
    }
    const email = (await resolveMembershipTargetEmail(fhir, membership))?.toLowerCase();
    const operations = cleanupMembershipOperations({
      membership,
      policyRoles,
      ...(email === ADMIN_EMAIL ? { stripRoles: ADMIN_ROLES_TO_STRIP } : {}),
    });
    if (operations.length > 0) {
      await audit.record(
        buildOdosAuditEventRow({
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

export async function resolveMembershipTargetEmail(
  fhir: Pick<MedplumClient, "read">,
  membership: ProjectMembership,
): Promise<string | undefined> {
  const practitionerId = membership.profile.reference?.match(/^Practitioner\/([^/]+)$/)?.[1];
  if (!practitionerId) return membership.user.display;
  const practitioner = await fhir.read<Practitioner>("Practitioner", practitionerId);
  return practitioner.telecom?.find((telecom) => telecom.system === "email" && telecom.value)?.value
    ?? membership.user.display;
}

async function runCli(): Promise<void> {
  const baseUrl = (process.env.MEDPLUM_BASE_URL ?? DEFAULT_BASE_URL).replace(/\/$/, "");
  assertLocalMedplumBaseUrl(baseUrl);
  const email = requireEnv("MEDPLUM_ADMIN_EMAIL");
  const password = requireEnv("MEDPLUM_ADMIN_PASSWORD");
  const accessToken = await loginForLocalRepair({ baseUrl, email, password });
  const results = await runCleanup(createOperatorScriptFhirClient({
    baseUrl,
    accessToken,
    reason: "Operator practice-role membership cleanup runs outside request handling.",
  }));
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
