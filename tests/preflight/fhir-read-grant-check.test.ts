import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { unlinkSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

type SourceFile = { readonly path: string; readonly text: string };
type GrantCheckResult = {
  readonly readResourceTypes: readonly string[];
  readonly excludedServiceIdentityResourceTypes: readonly string[];
  readonly excludedNonFhirCallSites: readonly string[];
  readonly grantedResourceTypes: readonly string[];
  readonly missingResourceTypes: readonly string[];
  readonly sourceRoots: readonly string[];
  readonly includedExtensions: readonly string[];
  readonly excludedDirectoryNames: readonly string[];
  readonly limitations: readonly string[];
};
type NonFhirLiteralCallSite = {
  readonly path: string;
  readonly callee: string;
  readonly literal: string;
  readonly reason: string;
};
type GrantCheckModule = {
  readonly collectLiteralFhirReadResourceTypes: (
    files: readonly SourceFile[],
    nonFhirCallSites?: readonly NonFhirLiteralCallSite[],
  ) => readonly string[];
  readonly findMissingFhirReadGrants: (
    readResourceTypes: readonly string[],
    grantedResourceTypes: readonly string[],
  ) => readonly string[];
  readonly runFhirReadGrantCheck: () => GrantCheckResult;
};

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const SERVICE_FHIR_PROBE_PATH = resolve(REPO_ROOT, "mcp/src/.fhir-read-grant-check-probe.ts");
const UI_FHIR_PROBE_PATH = resolve(REPO_ROOT, "ui/src/.fhir-read-grant-check-probe.tsx");

async function loadGrantCheck(): Promise<GrantCheckModule> {
  try {
    return await import("../../scripts/fhir-read-grant-check.ts") as GrantCheckModule;
  } catch (error) {
    assert.fail(`FHIR read grant preflight is not implemented: ${String(error)}`);
  }
}

test("FHIR read grant scan collects every literal FHIR receiver and requires the search-contract marker for computed searches", async () => {
  const { collectLiteralFhirReadResourceTypes } = await loadGrantCheck();
  const files = [{
    path: "mcp/src/fixture.ts",
    text: [
      "async function searchResource(fhir, resourceType, params) {",
      "  // search-contract: fixture.computed-search",
      "  return fhir.search(resourceType, params);",
      "}",
      "async function optionalSearchResource(fhir, resourceType, params) {",
      "  return searchResource(fhir, resourceType, params);",
      "}",
      'await fhir.read("PlanDefinition", "plan-1");',
      'await this.fhir.search("AllergyIntolerance", { patient });',
      'await staff.fhir.search("Goal", { subject: patient });',
      'await searchResource(fhir, "CarePlan", { patient });',
      'await optionalSearchResource(fhir, "Coverage", { patient });',
      'await optionalSearchResource(fhir, "CoverageEligibilityResponse", { patient });',
      'await fhir.read(computedResourceType, id);',
      'await serviceFhir.search("ProjectMembership", { profile });',
      'await deps.serviceFhir.read("RiskAssessment", "risk-1");',
      'await serviceClient.read("User", "user-1");',
    ].join("\n"),
  }];

  assert.deepEqual(
    collectLiteralFhirReadResourceTypes(files),
    [
      "AllergyIntolerance",
      "CarePlan",
      "Coverage",
      "CoverageEligibilityResponse",
      "Goal",
      "PlanDefinition",
      "ProjectMembership",
      "RiskAssessment",
      "User",
    ],
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

test("an explicitly reasoned non-FHIR literal call site does not manufacture a grant demand", async () => {
  const { collectLiteralFhirReadResourceTypes } = await loadGrantCheck();
  const files = [{
    path: "ui/src/cache.ts",
    text: 'await cache.search("recent-patients");\nawait fhir.search("Patient", { active: "true" });\n',
  }];
  const allowlist = [{
    path: "ui/src/cache.ts",
    callee: "cache.search",
    literal: "recent-patients",
    reason: "Local cache lookup, not a FHIR search.",
  }];

  assert.deepEqual(collectLiteralFhirReadResourceTypes(files, allowlist), ["Patient"]);
});

test("live FHIR read grant check covers all four chart resources through compiled role policies", async () => {
  const { runFhirReadGrantCheck } = await loadGrantCheck();
  const result = runFhirReadGrantCheck();

  assert.deepEqual(result.missingResourceTypes, []);
  assert.deepEqual(result.excludedServiceIdentityResourceTypes, ["ProjectMembership", "User"]);
  assert.deepEqual(result.excludedNonFhirCallSites, []);
  assert.deepEqual(result.sourceRoots, ["mcp/src", "ui/src"]);
  assert.deepEqual(result.includedExtensions, [".ts", ".tsx"]);
  assert.deepEqual(result.excludedDirectoryNames, ["__tests__"]);
  for (const resourceType of ["AllergyIntolerance", "Goal", "MedicationRequest", "PlanDefinition"]) {
    assert.equal(result.readResourceTypes.includes(resourceType), true, `${resourceType} must be scanned`);
    assert.equal(result.grantedResourceTypes.includes(resourceType), true, `${resourceType} must be granted`);
  }
  assert.deepEqual(result.limitations, [
    "Computed read resourceTypes escape this scan.",
    "A computed search is marker-checked only when its argument is named resourceType, resource_type, or .resourceType; other names escape because receiver-independent matching would misclassify non-FHIR search APIs.",
    "Marked helper propagation follows named parameters; destructured or object-property resourceType forwarding escapes this scan.",
    "Marked helper propagation is function-name based across scanned roots; same-named non-FHIR helpers require the explicit call-site allowlist.",
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
  assert.match(result.stdout, /FHIR read grant check: PASS \(\d+ literal\/marked resourceTypes under mcp\/src \+ ui\/src\)/);
  assert.match(result.stdout, /Included source extensions: \.ts, \.tsx/);
  assert.match(result.stdout, /Excluded source directories: __tests__/);
  assert.match(result.stdout, /Excluded source extensions: all except \.ts, \.tsx/);
  assert.match(result.stdout, /ProjectMembership — service identity authorization context/);
  assert.match(result.stdout, /User — service identity account resolution/);
  assert.match(result.stdout, /Non-FHIR literal call sites excluded:\n- none/);
  assert.match(result.stdout, /other names escape because receiver-independent matching would misclassify non-FHIR search APIs/);
  assert.match(result.stdout, /proves a grant exists, not that its scope is correct/);
});

test("serviceFhir read of an ungranted non-plumbing resource makes the CLI fail with its name", () => {
  writeFileSync(
    SERVICE_FHIR_PROBE_PATH,
    [
      "export async function probe(deps: { serviceFhir: { read(t: string, i: string): Promise<unknown> } }) {",
      '  await deps.serviceFhir.read("RiskAssessment", "probe");',
      "}",
      "",
    ].join("\n"),
  );

  let result: ReturnType<typeof spawnSync>;
  try {
    result = spawnSync(
      process.execPath,
      ["--import", "tsx", "scripts/fhir-read-grant-check.ts"],
      { cwd: REPO_ROOT, encoding: "utf8" },
    );
  } finally {
    unlinkSync(SERVICE_FHIR_PROBE_PATH);
  }

  assert.equal(result.status, 1, result.stderr || result.stdout);
  assert.match(result.stdout, /FHIR read grant check: FAIL/);
  assert.match(result.stdout, /Missing resourceType grants: RiskAssessment/);
});

test("an ungranted FHIR read in ui/src makes the CLI fail with its name", () => {
  writeFileSync(
    UI_FHIR_PROBE_PATH,
    [
      "export async function probe(fhir: { read(t: string, i: string): Promise<unknown> }) {",
      '  await fhir.read("RiskAssessment", "probe");',
      "}",
      "",
    ].join("\n"),
  );

  let result: ReturnType<typeof spawnSync>;
  try {
    result = spawnSync(
      process.execPath,
      ["--import", "tsx", "scripts/fhir-read-grant-check.ts"],
      { cwd: REPO_ROOT, encoding: "utf8" },
    );
  } finally {
    unlinkSync(UI_FHIR_PROBE_PATH);
  }

  assert.equal(result.status, 1, result.stderr || result.stdout);
  assert.match(result.stdout, /FHIR read grant check: FAIL/);
  assert.match(result.stdout, /Missing resourceType grants: RiskAssessment/);
});

test("a marked computed search helper carries literal resource types across source files", async () => {
  const { collectLiteralFhirReadResourceTypes } = await loadGrantCheck();
  const files = [
    {
      path: "ui/src/lib/fhir-search.ts",
      text: [
        "export async function searchAll(fhir, resourceType, params) {",
        "  // search-contract: ui.fhir-search.all",
        "  return fhir.search(resourceType, params);",
        "}",
      ].join("\n"),
    },
    {
      path: "ui/src/scene.tsx",
      text: [
        'import { searchAll } from "./lib/fhir-search";',
        'await searchAll(fhir, "RiskAssessment", { patient });',
      ].join("\n"),
    },
  ];

  assert.deepEqual(collectLiteralFhirReadResourceTypes(files), ["RiskAssessment"]);
});
