import type { AccessPolicy, ProjectMembership } from "@medplum/fhirtypes";
import { searchAll, type FhirSearchClient } from "../fhir-search.js";
import { diffCanonicalPolicyRules } from "../../../scripts/access-policy-rules.js";
import {
  buildMedplumAccessPolicy,
  getRoleDeclaration,
  ODOS_PRACTICE_ROLE_SYSTEM,
  PRACTICE_ROLE_IDS,
  effectiveBusinessActions,
  type BusinessAction,
  type PracticeRoleId,
} from "./roles.js";
import { readMembershipBusinessActionDeltas } from "./membership-business-actions.js";
import {
  assertObservedProjectMatchesTarget,
  formatInstallationProjectTarget,
  type InstallationProjectSource,
} from "../../../scripts/installation-project.js";

export interface PracticeRolePolicyStatus {
  readonly role: PracticeRoleId;
  readonly policyName: string;
  readonly policyReference?: string;
  readonly status: "match" | "drift" | "missing" | "duplicate";
  readonly issues: readonly string[];
  readonly missingRules: readonly unknown[];
  readonly unexpectedRules: readonly unknown[];
}

export interface PracticeRolePolicySyncStatus {
  readonly inSync: boolean;
  readonly policies: readonly PracticeRolePolicyStatus[];
  readonly membershipActions: readonly PracticeMembershipBusinessActionStatus[];
}

export interface PracticeMembershipBusinessActionStatus {
  readonly membershipReference: string;
  readonly malformed: boolean;
  readonly ignoredGranted: readonly BusinessAction[];
  readonly ignoredRevoked: readonly BusinessAction[];
}

export type PracticeRolePolicySyncStatusReport =
  | (PracticeRolePolicySyncStatus & { readonly availability: "available" })
  | {
      readonly availability: "unavailable";
      readonly inSync: null;
      readonly error: string;
    };

export async function readPracticeRolePolicySyncStatus(
  fhir: FhirSearchClient,
  projectId: string,
): Promise<PracticeRolePolicySyncStatus> {
  const policies: PracticeRolePolicyStatus[] = [];
  const roleByPolicyReference = new Map<string, PracticeRoleId>();
  for (const role of PRACTICE_ROLE_IDS) {
    const expected = buildMedplumAccessPolicy(getRoleDeclaration(role));
    const expectedName = expected.name!;
    const matches = (await searchAll<AccessPolicy>(
      fhir,
      "AccessPolicy",
      { "name:exact": expectedName, _project: projectId },
    )).filter((policy) => policy.name === expectedName);
    if (matches.length === 0) {
      policies.push({
        role,
        policyName: expectedName,
        status: "missing",
        issues: [`AccessPolicy "${expectedName}" is missing`],
        missingRules: expected.resource ?? [],
        unexpectedRules: [],
      });
      continue;
    }
    if (matches.length > 1) {
      policies.push({
        role,
        policyName: expectedName,
        status: "duplicate",
        issues: [`expected one AccessPolicy "${expectedName}", found ${matches.length}`],
        missingRules: [],
        unexpectedRules: [],
      });
      continue;
    }
    const deployed = matches[0]!;
    if (deployed.id) roleByPolicyReference.set(`AccessPolicy/${deployed.id}`, role);
    const issues: string[] = [];
    const tagged = deployed.meta?.tag?.some(
      (tag) => tag.system === ODOS_PRACTICE_ROLE_SYSTEM && tag.code === role,
    );
    if (!tagged) issues.push(`AccessPolicy "${expectedName}" lacks its practice-role meta.tag`);
    const diff = diffCanonicalPolicyRules(deployed, expected);
    const policyReference = deployed.id ? `AccessPolicy/${deployed.id}` : undefined;
    if (!diff.matches) {
      issues.push(`AccessPolicy "${expectedName}"${policyReference ? ` (${policyReference})` : ""} resource[] drift`);
      issues.push(...diff.missingRules.map((rule) => `missing rule ${JSON.stringify(rule)}`));
      issues.push(...diff.unexpectedRules.map((rule) => `unexpected rule ${JSON.stringify(rule)}`));
    }
    policies.push({
      role,
      policyName: expectedName,
      ...(policyReference ? { policyReference } : {}),
      status: issues.length === 0 ? "match" : "drift",
      issues,
      missingRules: diff.missingRules,
      unexpectedRules: diff.unexpectedRules,
    });
  }
  const memberships = await searchAll<ProjectMembership>(
    fhir,
    "ProjectMembership",
    { _project: projectId, "active:not": "false" },
  );
  const membershipActions = memberships
    .filter((membership) => membership.active !== false)
    .map((membership): PracticeMembershipBusinessActionStatus => {
      const references = new Set([
        ...(membership.access ?? []).flatMap((access) => access.policy.reference ?? []),
        ...(membership.accessPolicy?.reference ? [membership.accessPolicy.reference] : []),
      ]);
      const roles = PRACTICE_ROLE_IDS.filter((role) =>
        [...references].some((reference) => roleByPolicyReference.get(reference) === role)
      );
      const deltas = readMembershipBusinessActionDeltas(membership);
      const resolution = effectiveBusinessActions(
        roles,
        deltas.malformed ? undefined : deltas.granted,
        deltas.malformed ? undefined : deltas.revoked,
      );
      return {
        membershipReference: membership.id ? `ProjectMembership/${membership.id}` : "ProjectMembership/unknown",
        malformed: deltas.malformed || resolution.malformed,
        ignoredGranted: resolution.ignoredGranted,
        ignoredRevoked: resolution.ignoredRevoked,
      };
    });
  return {
    inSync: policies.every((policy) => policy.status === "match") &&
      membershipActions.every((membership) =>
        !membership.malformed && membership.ignoredGranted.length === 0 && membership.ignoredRevoked.length === 0
      ),
    policies,
    membershipActions,
  };
}

export async function readPracticeRolePolicySyncStatusReport(
  fhir: FhirSearchClient,
  projectId: string,
): Promise<PracticeRolePolicySyncStatusReport> {
  try {
    return {
      availability: "available",
      ...await readPracticeRolePolicySyncStatus(fhir, projectId),
    };
  } catch (error) {
    return {
      availability: "unavailable",
      inSync: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function missingPracticeRolePolicies(
  fhir: FhirSearchClient,
  projectId: string,
): Promise<string[]> {
  const status = await readPracticeRolePolicySyncStatus(fhir, projectId);
  return status.policies.flatMap((policy) =>
    policy.issues.map((issue) => `${policy.role}: ${issue}`)
  );
}

export function formatPracticeRoleBootFailure(missing: readonly string[]): string {
  return [
    "\u001b[31m",
    "============================================================",
    "ODOS PRACTICE ROLE BOOT VERIFICATION FAILED",
    ...missing.map((item) => `- ${item}`),
    "The server will continue, but role-gated workflows are not ready.",
    "============================================================",
    "\u001b[0m",
  ].join("\n");
}

export async function logProtocolSeedBootFailure(input: {
  seed(): Promise<void>;
  log?: (message: string) => void;
}): Promise<void> {
  try {
    await input.seed();
  } catch (error) {
    (input.log ?? console.error)([
      "\u001b[31m",
      "============================================================",
      "ODOS PROTOCOL SEED FAILED",
      `- ${error instanceof Error ? error.message : String(error)}`,
      "The server will continue, but the built-in protocol may be unavailable.",
      "============================================================",
      "\u001b[0m",
    ].join("\n"));
  }
}

export async function logSsePracticeRoleBootVerification(input: {
  authenticate(): Promise<void>;
  verify(): Promise<void>;
  log?: (message: string) => void;
}): Promise<void> {
  try {
    await input.authenticate();
    await input.verify();
  } catch (error) {
    (input.log ?? console.error)(formatPracticeRoleBootFailure([
      `verification unavailable: ${error instanceof Error ? error.message : String(error)}`,
    ]));
  }
}

export async function logPracticeRoleBootVerification(
  fhir: FhirSearchClient,
  projectId: string,
  log: (message: string) => void = console.error,
): Promise<void> {
  try {
    const missing = await missingPracticeRolePolicies(fhir, projectId);
    if (missing.length > 0) log(formatPracticeRoleBootFailure(missing));
  } catch (error) {
    log(formatPracticeRoleBootFailure([
      `verification unavailable: ${error instanceof Error ? error.message : String(error)}`,
    ]));
  }
}

export async function verifyMcpProjectBootBoundary(input: {
  readonly configuredProjectId: string;
  readonly configuredSource: InstallationProjectSource;
  readonly authenticate: () => Promise<void>;
  readonly getActiveProjectId: () => Promise<string>;
  readonly verifyPolicies: () => Promise<void>;
  readonly serve: () => Promise<void>;
  readonly log?: (message: string) => void;
}): Promise<void> {
  const log = input.log ?? console.error;
  log(formatInstallationProjectTarget({
    projectId: input.configuredProjectId,
    source: input.configuredSource,
  }));
  await input.authenticate();
  const observedProjectId = await input.getActiveProjectId();
  log(`Observed authenticated MCP service project: Project/${observedProjectId}`);
  assertObservedProjectMatchesTarget(
    input.configuredProjectId,
    observedProjectId,
    "authenticated MCP service project",
  );
  await input.verifyPolicies();
  await input.serve();
}
