import type { AccessPolicy } from "@medplum/fhirtypes";
import {
  buildMedplumAccessPolicy,
  getRoleDeclaration,
  type PracticeRoleId,
} from "../mcp/src/authz/roles.js";

export class PolicyDriftError extends Error {
  constructor(
    readonly role: PracticeRoleId,
    readonly policyReference: string,
  ) {
    super(`${policyReference} rules diverge from the canonical ${role} AccessPolicy.`);
    this.name = "PolicyDriftError";
  }
}

export function assertCanonicalPolicyRules(
  policy: AccessPolicy,
  role: PracticeRoleId,
): void {
  const expected = buildMedplumAccessPolicy(getRoleDeclaration(role));
  if (canonicalPolicyRules(policy) !== canonicalPolicyRules(expected)) {
    throw new PolicyDriftError(
      role,
      policy.id ? `AccessPolicy/${policy.id}` : `AccessPolicy/${role}`,
    );
  }
}

export function canonicalPolicyRules(policy: AccessPolicy): string {
  return JSON.stringify(
    (policy.resource ?? [])
      .map((rule) => canonicalPolicyValue(rule))
      .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right))),
  );
}

export function canonicalPolicyValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value
      .map(canonicalPolicyValue)
      .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, nested]) => nested !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, canonicalPolicyValue(nested)]),
    );
  }
  return value;
}

export interface CanonicalPolicyRuleDiff {
  readonly matches: boolean;
  readonly missingRules: readonly unknown[];
  readonly unexpectedRules: readonly unknown[];
}

export function diffCanonicalPolicyRules(
  deployed: AccessPolicy,
  expected: AccessPolicy,
): CanonicalPolicyRuleDiff {
  const deployedRules = JSON.parse(canonicalPolicyRules(deployed)) as unknown[];
  const expectedRules = JSON.parse(canonicalPolicyRules(expected)) as unknown[];
  const missingRules = multisetDifference(expectedRules, deployedRules);
  const unexpectedRules = multisetDifference(deployedRules, expectedRules);
  return {
    matches: missingRules.length === 0 && unexpectedRules.length === 0,
    missingRules,
    unexpectedRules,
  };
}

function multisetDifference(source: readonly unknown[], comparedWith: readonly unknown[]): unknown[] {
  const remaining = new Map<string, number>();
  for (const value of comparedWith) {
    const key = JSON.stringify(value);
    remaining.set(key, (remaining.get(key) ?? 0) + 1);
  }
  return source.filter((value) => {
    const key = JSON.stringify(value);
    const count = remaining.get(key) ?? 0;
    if (count === 0) return true;
    remaining.set(key, count - 1);
    return false;
  });
}
