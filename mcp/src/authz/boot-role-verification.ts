import type { AccessPolicy } from "@medplum/fhirtypes";
import { searchAll, type FhirSearchClient } from "../fhir-search.js";
import { diffCanonicalPolicyRules } from "../../../scripts/access-policy-rules.js";
import {
  buildMedplumAccessPolicy,
  getRoleDeclaration,
  ODOS_PRACTICE_ROLE_SYSTEM,
  PRACTICE_ROLE_IDS,
  type PracticeRoleId,
} from "./roles.js";

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
): Promise<PracticeRolePolicySyncStatus> {
  const policies: PracticeRolePolicyStatus[] = [];
  for (const role of PRACTICE_ROLE_IDS) {
    const expected = buildMedplumAccessPolicy(getRoleDeclaration(role));
    const expectedName = expected.name!;
    const matches = (await searchAll<AccessPolicy>(
      fhir,
      "AccessPolicy",
      { "name:exact": expectedName },
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
  return {
    inSync: policies.every((policy) => policy.status === "match"),
    policies,
  };
}

export async function readPracticeRolePolicySyncStatusReport(
  fhir: FhirSearchClient,
): Promise<PracticeRolePolicySyncStatusReport> {
  try {
    return {
      availability: "available",
      ...await readPracticeRolePolicySyncStatus(fhir),
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
): Promise<string[]> {
  const status = await readPracticeRolePolicySyncStatus(fhir);
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
  log: (message: string) => void = console.error,
): Promise<void> {
  try {
    const missing = await missingPracticeRolePolicies(fhir);
    if (missing.length > 0) log(formatPracticeRoleBootFailure(missing));
  } catch (error) {
    log(formatPracticeRoleBootFailure([
      `verification unavailable: ${error instanceof Error ? error.message : String(error)}`,
    ]));
  }
}
