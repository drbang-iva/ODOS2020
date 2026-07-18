import type { AccessPolicy } from "@medplum/fhirtypes";
import type { MedplumClient } from "../fhir-client.js";
import {
  getRoleDeclaration,
  ODOS_PRACTICE_ROLE_SYSTEM,
  PRACTICE_ROLE_IDS,
} from "./roles.js";

export async function missingPracticeRolePolicies(
  fhir: Pick<MedplumClient, "search">,
): Promise<string[]> {
  const missing: string[] = [];
  for (const roleId of PRACTICE_ROLE_IDS) {
    const expectedName = `ODOS ${getRoleDeclaration(roleId).display}`;
    const bundle = await fhir.search<AccessPolicy>("AccessPolicy", { "name:exact": expectedName });
    const policies = (bundle.entry ?? [])
      .map((entry) => entry.resource)
      .filter((policy): policy is AccessPolicy => policy?.name === expectedName);
    if (policies.length === 0) {
      missing.push(`${roleId}: AccessPolicy "${expectedName}" is missing`);
      continue;
    }
    if (policies.length > 1) {
      missing.push(`${roleId}: expected one AccessPolicy "${expectedName}", found ${policies.length}`);
      continue;
    }
    const tagged = policies[0]!.meta?.tag?.some(
      (tag) => tag.system === ODOS_PRACTICE_ROLE_SYSTEM && tag.code === roleId,
    );
    if (!tagged) {
      missing.push(`${roleId}: AccessPolicy "${expectedName}" lacks its practice-role meta.tag`);
    }
  }
  return missing;
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
  fhir: Pick<MedplumClient, "search">,
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
