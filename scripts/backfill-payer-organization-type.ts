#!/usr/bin/env tsx
import type { CodeableConcept, Coverage, Organization } from "@medplum/fhirtypes";
import {
  createOperatorScriptFhirClient,
  type JsonPatchOperation,
  type MedplumClient,
} from "../mcp/src/fhir-client.js";
import { searchAll } from "../mcp/src/fhir-search.js";
import { assertLocalMedplumBaseUrl } from "./reseed-practice-role-tags.js";

const DEFAULT_BASE_URL = "http://localhost:8103";
const ORGANIZATION_TYPE_SYSTEM = "http://terminology.hl7.org/CodeSystem/organization-type";
const PAYER_TYPE = {
  system: ORGANIZATION_TYPE_SYSTEM,
  code: "pay",
  display: "Payer",
} as const;
const STEDI_TEST_IDENTIFIER = "STEDITEST";

interface PayerOrganizationPlan {
  readonly organization: Organization;
  readonly action: "ADD" | "SKIP";
}

interface PayerOrganizationBackfillResult {
  readonly coveragesInspected: number;
  readonly coveragePayorReferences: number;
  readonly stediTestMatches: number;
  readonly plans: readonly PayerOrganizationPlan[];
  readonly applied: number;
}

export async function backfillPayerOrganizationType(
  fhir: Pick<MedplumClient, "baseUrl" | "search" | "searchUrl" | "read" | "patch">,
  apply: boolean,
): Promise<PayerOrganizationBackfillResult> {
  const coverages = await searchAll<Coverage>(fhir, "Coverage");
  const coveragePayorIds = collectCoveragePayorOrganizationIds(coverages);
  const stediTestOrganizations = (await searchAll<Organization>(fhir, "Organization", {
    identifier: STEDI_TEST_IDENTIFIER,
  })).filter((organization) =>
    organization.identifier?.some((identifier) => identifier.value === STEDI_TEST_IDENTIFIER)
  );
  const payerOrganizationIds = new Set(coveragePayorIds);
  for (const organization of stediTestOrganizations) {
    if (!organization.id) {
      throw new Error("A STEDITEST Organization search result has no id.");
    }
    payerOrganizationIds.add(organization.id);
  }

  const plans: PayerOrganizationPlan[] = [];
  for (const id of [...payerOrganizationIds].sort()) {
    const organization = await fhir.read<Organization>("Organization", id);
    const action = hasPayerType(organization) ? "SKIP" : "ADD";
    if (action === "ADD" && !organization.meta?.versionId) {
      throw new Error(`Organization/${id} cannot be patched safely because meta.versionId is missing.`);
    }
    plans.push({ organization, action });
  }

  let applied = 0;
  if (apply) {
    for (const plan of plans) {
      if (plan.action === "SKIP") continue;
      await fhir.patch<Organization>(
        "Organization",
        plan.organization.id!,
        payerTypePatch(plan.organization),
        { "If-Match": `W/"${plan.organization.meta!.versionId}"` },
      );
      applied += 1;
    }
  }

  return {
    coveragesInspected: coverages.length,
    coveragePayorReferences: coveragePayorIds.size,
    stediTestMatches: stediTestOrganizations.length,
    plans,
    applied,
  };
}

export function collectCoveragePayorOrganizationIds(
  coverages: readonly Coverage[],
): ReadonlySet<string> {
  const ids = new Set<string>();
  for (const coverage of coverages) {
    for (const payor of coverage.payor) {
      const id = payor.reference?.match(/^Organization\/([A-Za-z0-9.-]{1,64})$/)?.[1];
      if (id) ids.add(id);
    }
  }
  return ids;
}

export function hasPayerType(organization: Organization): boolean {
  return organization.type?.some((type) =>
    type.coding?.some((coding) =>
      coding.system === ORGANIZATION_TYPE_SYSTEM && coding.code === PAYER_TYPE.code
    )
  ) ?? false;
}

export function payerTypePatch(organization: Organization): JsonPatchOperation[] {
  const payerType: CodeableConcept = { coding: [{ ...PAYER_TYPE }] };
  if (!organization.type) {
    return [{ op: "add", path: "/type", value: [payerType] }];
  }
  return [{ op: "add", path: "/type/-", value: payerType }];
}

function printResult(result: PayerOrganizationBackfillResult, apply: boolean): void {
  console.log(`Mode: ${apply ? "APPLY" : "DRY RUN"}`);
  console.log(`Coverages inspected: ${result.coveragesInspected}`);
  console.log(`Distinct Coverage.payor Organizations: ${result.coveragePayorReferences}`);
  console.log(`STEDITEST Organizations matched: ${result.stediTestMatches}`);
  console.log(`Payer Organizations inspected: ${result.plans.length}`);
  for (const plan of result.plans) {
    const id = plan.organization.id ?? "unknown";
    const name = plan.organization.name ?? "(unnamed)";
    if (plan.action === "SKIP") {
      console.log(`SKIP Organization/${id} "${name}" already has payer type`);
    } else {
      const verb = apply ? "APPLIED" : "PLAN";
      console.log(
        `${verb} Organization/${id} "${name}" current type: ${formatTypes(plan.organization.type)}; add payer type`,
      );
    }
  }
  console.log(`Planned changes: ${result.plans.filter((plan) => plan.action === "ADD").length}`);
  console.log(`Applied changes: ${result.applied}`);
  console.log(`Already typed: ${result.plans.filter((plan) => plan.action === "SKIP").length}`);
}

function formatTypes(types: readonly CodeableConcept[] | undefined): string {
  if (!types?.length) return "(none)";
  return types.map((type) => {
    const codings = type.coding?.map((coding) =>
      `${coding.system ?? "(no system)"}|${coding.code ?? "(no code)"}`
    );
    return codings?.length ? codings.join(",") : type.text ?? "(empty)";
  }).join("; ");
}

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function parseApplyFlag(args: readonly string[]): boolean {
  const unknown = args.filter((arg) => arg !== "--apply");
  if (unknown.length > 0) {
    throw new Error(`Unknown argument(s): ${unknown.join(", ")}. Use --apply to write changes.`);
  }
  return args.includes("--apply");
}

async function runCli(): Promise<void> {
  const baseUrl = (process.env.MEDPLUM_BASE_URL ?? DEFAULT_BASE_URL).replace(/\/$/, "");
  assertLocalMedplumBaseUrl(baseUrl);
  const apply = parseApplyFlag(process.argv.slice(2));
  const fhir = createOperatorScriptFhirClient({
    baseUrl,
    reason: "Operator payer-organization backfill runs outside request handling.",
  });
  await fhir.login(
    requireEnv("MEDPLUM_ADMIN_EMAIL"),
    requireEnv("MEDPLUM_ADMIN_PASSWORD"),
  );
  printResult(await backfillPayerOrganizationType(fhir, apply), apply);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    await runCli();
  } catch (error) {
    const status = (error as { status?: number }).status;
    const suffix = status === 412
      ? " An Organization changed during repair; rerun to re-evaluate the current type."
      : "";
    console.error(`${error instanceof Error ? error.message : String(error)}${suffix}`);
    process.exitCode = 1;
  }
}
