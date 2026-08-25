#!/usr/bin/env tsx
import { pathToFileURL } from "node:url";
import type { AccessPolicy, ProjectMembership } from "@medplum/fhirtypes";
import { createLiveOdosAuditRuntime } from "../mcp/src/authz/liveAudit.js";
import { buildOdosAuditEventRow } from "../mcp/src/authz/odosAudit.js";
import { createOperatorScriptFhirClient, type MedplumClient } from "../mcp/src/fhir-client.js";
import { searchAll } from "../mcp/src/fhir-search.js";
import {
  assertAuthenticatedSessionProject,
  readAuthenticatedSessionProject,
  resolveThreeRoleMigrationCredentials,
} from "./migrate-three-role-model.js";
import { assertLocalMedplumBaseUrl } from "./reseed-practice-role-tags.js";

const STRAY_POLICY_NAMES = new Set([
  "ODOS Provider",
  "ODOS Staff",
  "ODOS Admin / Manager",
]);

export interface ThreeRoleStrayPolicyCleanupAdapter {
  readProjectPolicies(projectId: string): Promise<AccessPolicy[]>;
  readAllMemberships(): Promise<ProjectMembership[]>;
  deletePolicy(id: string, versionId: string): Promise<void>;
}

export interface ThreeRoleStrayPolicyCleanupCandidate {
  readonly id: string;
  readonly name: string;
  readonly versionId: string;
  readonly membershipReferences: readonly string[];
}

export interface ThreeRoleStrayPolicyCleanupResult {
  readonly mode: "dry-run" | "apply";
  readonly candidates: readonly ThreeRoleStrayPolicyCleanupCandidate[];
  readonly policiesDeleted: number;
}

export async function executeThreeRoleStrayPolicyCleanup(
  adapter: ThreeRoleStrayPolicyCleanupAdapter,
  options: { projectId: string; policyIds?: readonly string[]; apply?: boolean },
): Promise<ThreeRoleStrayPolicyCleanupResult> {
  const policies = await adapter.readProjectPolicies(options.projectId);
  const memberships = await adapter.readAllMemberships();
  const requestedIds = [...new Set((options.policyIds ?? []).map((id) => id.trim()).filter(Boolean))];
  const policiesById = new Map(policies.flatMap((policy) => policy.id ? [[policy.id, policy] as const] : []));
  if (requestedIds.length > 0) {
    for (const id of requestedIds) {
      if (!policiesById.has(id)) {
        throw new Error(`AccessPolicy/${id} was not found in project ${options.projectId}.`);
      }
    }
  }
  const selected = requestedIds.length > 0
    ? requestedIds.map((id) => policiesById.get(id)!)
    : policies.filter((policy) => policy.name && STRAY_POLICY_NAMES.has(policy.name));
  const references = membershipReferences(memberships);
  const candidates = selected.map((policy): ThreeRoleStrayPolicyCleanupCandidate => {
    if (!policy.id || !policy.name || !policy.meta?.versionId) {
      throw new Error("Every stray-policy cleanup candidate must carry id, name, and meta.versionId.");
    }
    return {
      id: policy.id,
      name: policy.name,
      versionId: policy.meta.versionId,
      membershipReferences: [...(references.get(`AccessPolicy/${policy.id}`) ?? [])],
    };
  });
  if (!options.apply) {
    return { mode: "dry-run", candidates, policiesDeleted: 0 };
  }
  const blocked = candidates.filter((candidate) => candidate.membershipReferences.length > 0);
  if (blocked.length > 0) {
    const detail = blocked.map((candidate) =>
      `AccessPolicy/${candidate.id}: ${candidate.membershipReferences.join(", ")}`).join("; ");
    throw new Error(`Stray-policy cleanup refused because selected policies are referenced: ${detail}.`);
  }
  for (const candidate of candidates) {
    await adapter.deletePolicy(candidate.id, candidate.versionId);
  }
  return { mode: "apply", candidates, policiesDeleted: candidates.length };
}

function membershipReferences(memberships: readonly ProjectMembership[]): Map<string, Set<string>> {
  const references = new Map<string, Set<string>>();
  for (const membership of memberships) {
    const policies = [
      ...(membership.access ?? []).map((entry) => entry.policy.reference),
      membership.accessPolicy?.reference,
    ].filter((reference): reference is string => Boolean(reference));
    if (policies.length === 0) continue;
    if (!membership.id) {
      throw new Error("Every policy-referencing ProjectMembership must carry an id.");
    }
    for (const reference of policies) {
      const membershipsForPolicy = references.get(reference) ?? new Set<string>();
      membershipsForPolicy.add(`ProjectMembership/${membership.id}`);
      references.set(reference, membershipsForPolicy);
    }
  }
  return references;
}

class LiveThreeRoleStrayPolicyCleanupAdapter implements ThreeRoleStrayPolicyCleanupAdapter {
  private readonly audit = createLiveOdosAuditRuntime({
    postgresUrl: process.env.ODOS_POSTGRES_URL ?? "postgresql://medplum:medplum@127.0.0.1:5433/medplum",
  });

  constructor(
    private readonly fhir: Pick<MedplumClient, "baseUrl" | "search" | "searchUrl">,
    private readonly baseUrl: string,
    private readonly accessToken: string,
  ) {}

  readProjectPolicies(projectId: string): Promise<AccessPolicy[]> {
    return searchAll(this.fhir, "AccessPolicy", { _project: projectId });
  }

  readAllMemberships(): Promise<ProjectMembership[]> {
    return searchAll(this.fhir, "ProjectMembership", {});
  }

  deletePolicy(id: string, versionId: string): Promise<void> {
    return this.audit.record(buildOdosAuditEventRow({
      eventType: "role-change",
      actorId: "cleanup-three-role-stray-policies",
      actorRole: "system",
      resourceType: "AccessPolicy",
      resourceId: id,
      actionOutcome: "granted",
      actionReason: "remove unreferenced canonical role policy created in the wrong project",
    }), async () => {
      const response = await fetch(`${this.baseUrl}/fhir/R4/AccessPolicy/${encodeURIComponent(id)}`, {
        method: "DELETE",
        headers: {
          Authorization: `Bearer ${this.accessToken}`,
          "If-Match": `W/"${versionId}"`,
        },
        signal: AbortSignal.timeout(30_000),
      });
      if (!response.ok) {
        throw new Error(`AccessPolicy/${id} delete failed: ${response.status} ${await response.text()}`);
      }
    });
  }
}

async function runCli(): Promise<void> {
  const args = new Set(process.argv.slice(2));
  const apply = args.has("--apply");
  const baseUrl = (process.env.MEDPLUM_BASE_URL ?? "http://localhost:8103").replace(/\/$/, "");
  assertLocalMedplumBaseUrl(baseUrl);
  const projectId = argumentValue("--project")?.trim()
    || process.env.MEDPLUM_PROJECT_ID?.trim();
  if (!projectId) {
    throw new Error("Supply --project <project-id> or MEDPLUM_PROJECT_ID for stray-policy cleanup.");
  }
  const credentials = await resolveThreeRoleMigrationCredentials({
    baseUrl,
    projectId,
    accessToken: process.env.MEDPLUM_ACCESS_TOKEN,
    adminEmail: process.env.MEDPLUM_ADMIN_EMAIL,
    adminPassword: process.env.MEDPLUM_ADMIN_PASSWORD,
  });
  const fhir = createOperatorScriptFhirClient({
    baseUrl,
    accessToken: credentials.accessToken,
    reason: "Operator wrong-project role-policy cleanup runs outside request handling.",
    extendedMode: true,
  });
  const session = await readAuthenticatedSessionProject({
    baseUrl,
    accessToken: credentials.accessToken,
  });
  await assertAuthenticatedSessionProject({
    session,
    targetProjectId: projectId,
    fhir,
    credentialSource: credentials.source,
  });
  const result = await executeThreeRoleStrayPolicyCleanup(
    new LiveThreeRoleStrayPolicyCleanupAdapter(fhir, baseUrl, credentials.accessToken),
    { projectId, policyIds: argumentValues("--policy"), apply },
  );
  console.log(JSON.stringify(result, null, 2));
  if (!apply) {
    console.log("Dry run only. Re-run with --apply after reviewing every candidate and membership reference.");
  }
}

function argumentValue(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function argumentValues(name: string): string[] {
  return process.argv.flatMap((value, index) => value === name && process.argv[index + 1]
    ? [process.argv[index + 1]!]
    : []);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCli().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
