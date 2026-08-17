import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

type SourceFile = { readonly path: string; readonly text: string };
type GrantCheckResult = {
  readonly readResourceTypes: readonly string[];
  readonly grantedResourceTypes: readonly string[];
  readonly missingResourceTypes: readonly string[];
  readonly limitations: readonly string[];
};
type GrantCheckModule = {
  readonly collectLiteralFhirReadResourceTypes: (files: readonly SourceFile[]) => readonly string[];
  readonly findMissingFhirReadGrants: (
    readResourceTypes: readonly string[],
    grantedResourceTypes: readonly string[],
  ) => readonly string[];
  readonly runFhirReadGrantCheck: () => GrantCheckResult;
};

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

async function loadGrantCheck(): Promise<GrantCheckModule> {
  try {
    return await import("../../scripts/fhir-read-grant-check.ts") as GrantCheckModule;
  } catch (error) {
    assert.fail(`FHIR read grant preflight is not implemented: ${String(error)}`);
  }
}

test("FHIR read grant scan collects literal ordinary-role reads and requires the search-contract marker for computed searches", async () => {
  const { collectLiteralFhirReadResourceTypes } = await loadGrantCheck();
  const files = [{
    path: "mcp/src/fixture.ts",
    text: [
      "async function searchResource(fhir, resourceType, params) {",
      "  // search-contract: fixture.computed-search",
      "  return fhir.search(resourceType, params);",
      "}",
      'await fhir.read("PlanDefinition", "plan-1");',
      'await this.fhir.search("AllergyIntolerance", { patient });',
      'await staff.fhir.search("Goal", { subject: patient });',
      'await searchResource(fhir, "CarePlan", { patient });',
      'await fhir.read(computedResourceType, id);',
      'await serviceFhir.search("ProjectMembership", { profile });',
    ].join("\n"),
  }];

  assert.deepEqual(
    collectLiteralFhirReadResourceTypes(files),
    ["AllergyIntolerance", "CarePlan", "Goal", "PlanDefinition"],
  );
  assert.throws(
    () => collectLiteralFhirReadResourceTypes([{
      path: "mcp/src/unmarked.ts",
      text: "await fhir.search(resourceType, params);\n",
    }]),
    /search-contract/,
  );
});

test("FHIR read grant comparison reports the exact sorted subset gap", async () => {
  const { findMissingFhirReadGrants } = await loadGrantCheck();
  assert.deepEqual(
    findMissingFhirReadGrants(
      ["PlanDefinition", "MedicationRequest", "Goal", "AllergyIntolerance"],
      ["MedicationRequest", "Patient"],
    ),
    ["AllergyIntolerance", "Goal", "PlanDefinition"],
  );
});

test("live FHIR read grant check covers all four chart resources through compiled role policies", async () => {
  const { runFhirReadGrantCheck } = await loadGrantCheck();
  const result = runFhirReadGrantCheck();

  assert.deepEqual(result.missingResourceTypes, []);
  for (const resourceType of ["AllergyIntolerance", "Goal", "MedicationRequest", "PlanDefinition"]) {
    assert.equal(result.readResourceTypes.includes(resourceType), true, `${resourceType} must be scanned`);
    assert.equal(result.grantedResourceTypes.includes(resourceType), true, `${resourceType} must be granted`);
  }
  assert.deepEqual(result.limitations, [
    "Literal resourceTypes only; a computed resourceType escapes this scan.",
    "This proves a grant exists, not that its scope is correct; a wrong-compartment grant can still 403 at runtime.",
  ]);
});

test("FHIR read grant CLI passes only with full coverage and always prints its limits", () => {
  const result = spawnSync(
    process.execPath,
    ["--import", "tsx", "scripts/fhir-read-grant-check.ts"],
    { cwd: REPO_ROOT, encoding: "utf8" },
  );

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /FHIR read grant check: PASS/);
  assert.match(result.stdout, /Literal resourceTypes only; a computed resourceType escapes this scan\./);
  assert.match(result.stdout, /proves a grant exists, not that its scope is correct/);
});
