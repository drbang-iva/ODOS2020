import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { buildAgeOfMajorityConfigResource, resolveAgeOfMajorityYears, isMinorAtAge, ODOS_AGE_OF_MAJORITY_CONFIG_EXTENSION_URL } from "../src/clinic/age-of-majority-config.js";
import { seedAgeOfMajority } from "../../scripts/seed-age-of-majority.js";
import type { Basic, Bundle } from "@medplum/fhirtypes";
const roundTrip = <T>(value: T): T => JSON.parse(JSON.stringify(value));
test("age-of-majority writer round trips, preserves version, rejects invalid values and has no fallback", () => {
  for (const age of [16, 18, 21]) {
    const basic = roundTrip(buildAgeOfMajorityConfigResource({ ageOfMajorityYears: age }, { resourceType: "Basic", id: "config", code: {}, meta: { versionId: "2" } }));
    assert.equal(resolveAgeOfMajorityYears(basic), age);
    assert.equal(basic.meta?.versionId, "2");
  }
  for (const age of [15, 22, 18.5, NaN, "18", null]) assert.throws(() => buildAgeOfMajorityConfigResource({ ageOfMajorityYears: age as number }), /not configured/);
  assert.throws(() => resolveAgeOfMajorityYears(), /not configured/);
  const bad = roundTrip(buildAgeOfMajorityConfigResource({ ageOfMajorityYears: 18 }));
  bad.extension![0]!.valueString = '{"ageOfMajorityYears":"18"}';
  assert.throws(() => resolveAgeOfMajorityYears(bad), /not configured/);
  assert.equal(isMinorAtAge("2007-09-15", "2026-09-15", 21), true);
  assert.equal(isMinorAtAge("2007-09-15", "2026-09-15", 18), false);
  assert.equal(isMinorAtAge("2005-09-15", "2026-09-14", 21), true);
  assert.equal(isMinorAtAge("2005-09-15", "2026-09-15", 21), false);
});
test("D8 age-of-majority canonical extension is registered", () => {
  const registry = JSON.parse(readFileSync(new URL("../../data/canonical-extensions/registry.json", import.meta.url), "utf8"));
  assert.equal(registry.extensions.filter((entry: { url: string; status: string }) => entry.url === ODOS_AGE_OF_MAJORITY_CONFIG_EXTENSION_URL && entry.status === "active").length, 1);
});
test("D9 seed defaults to dry-run and preserves an existing configured project", async () => {
  const records: Basic[] = [];
  const fhir = {
    search: async () => roundTrip({ resourceType: "Bundle", entry: records.map((resource) => ({ resource })) }) as Bundle,
    create: async <T>(resource: T) => { records.push(roundTrip(resource) as Basic); return resource; },
  };
  assert.equal((await seedAgeOfMajority(fhir as never, { projectId: "synthetic" })).action, "would-seed");
  assert.deepEqual(records, []);
  assert.equal((await seedAgeOfMajority(fhir as never, { projectId: "synthetic", apply: true })).action, "seeded");
  assert.equal(resolveAgeOfMajorityYears(records[0]), 18);
  await seedAgeOfMajority(fhir as never, { projectId: "synthetic", apply: true });
  assert.equal(records.length, 1);
  records[0] = roundTrip(buildAgeOfMajorityConfigResource({ ageOfMajorityYears: 21 }));
  await seedAgeOfMajority(fhir as never, { projectId: "synthetic", apply: true });
  assert.equal(resolveAgeOfMajorityYears(records[0]), 21);
});

test("age-of-majority policy allows all roles to read, but only Admin to write", async () => {
  const { buildMedplumAccessPolicy, buildMedplumCompositeAccessPolicy, getRoleDeclaration } = await import("../src/authz/roles.js");
  const criteria = "Basic?code=https://odos2020.com/fhir/CodeSystem/age-of-majority-config|odos-age-of-majority-config";
  for (const role of ["provider", "staff", "admin"] as const) {
    const rules = buildMedplumAccessPolicy(getRoleDeclaration(role)).resource!.filter((rule) => rule.resourceType === "Basic" && rule.criteria === criteria);
    const interactions = rules.flatMap((rule) => rule.interaction ?? []);
    assert.ok(interactions.includes("read"), `${role} read`);
    assert.ok(interactions.includes("search"), `${role} search`);
    assert.equal(interactions.includes("create"), role === "admin", `${role} create`);
    assert.equal(interactions.includes("update"), role === "admin", `${role} update`);
    assert.equal(interactions.includes("delete"), false);
  }
  for (const roles of [["provider", "staff"], ["provider", "admin"], ["staff", "admin"]] as const) {
    const policy = buildMedplumCompositeAccessPolicy(roles);
    const interactions = policy.resource!
      .filter((rule) => rule.resourceType === "Basic" && rule.criteria === criteria)
      .flatMap((rule) => rule.interaction ?? []);
    const canWrite = roles.some((role) => role === "admin");
    assert.ok(interactions.includes("read"), `${roles.join("+")} read`);
    assert.equal(interactions.includes("create"), canWrite, `${roles.join("+")} create`);
    assert.equal(interactions.includes("update"), canWrite, `${roles.join("+")} update`);
  }
});


test("statement age query requires its exact scope grant", async () => {
  const { collectFhirOperations, findMissingFhirOperationGrants } = await import("../../scripts/fhir-read-grant-check.js");
  const { buildMedplumAccessPolicy, getRoleDeclaration } = await import("../src/authz/roles.js");
  const criteria = "Basic?code=https://odos2020.com/fhir/CodeSystem/age-of-majority-config|odos-age-of-majority-config";
  const operations = collectFhirOperations([{
    path: "mcp/src/statements/statements.ts",
    text: readFileSync(new URL("../src/statements/statements.ts", import.meta.url), "utf8"),
  }, {
    path: "mcp/src/fhir-search.ts",
    text: readFileSync(new URL("../src/fhir-search.ts", import.meta.url), "utf8"),
  }]).filter(operation => operation.scopeContract === criteria);
  assert.equal(operations.length, 1, "the real statements query must carry its exact scope contract");
  for (const role of ["provider", "staff", "admin"] as const) {
    const rules = buildMedplumAccessPolicy(getRoleDeclaration(role)).resource!;
    assert.deepEqual(findMissingFhirOperationGrants(operations, rules), []);
    assert.deepEqual(findMissingFhirOperationGrants(operations, rules.filter(rule => rule.criteria !== criteria)), operations,
      "other Basic grants must not mask a missing age-of-majority grant");
  }
});
