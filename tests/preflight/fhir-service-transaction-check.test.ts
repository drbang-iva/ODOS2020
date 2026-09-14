import assert from "node:assert/strict";
import { test } from "node:test";
import {
  collectFhirOperations,
  findMissingFhirOperationGrants,
  matchExactWriteInventory,
  type ExactFhirWriteCallSite,
} from "../../scripts/fhir-read-grant-check.js";
import { buildMedplumAccessPolicy, getRoleDeclaration } from "../../mcp/src/authz/roles.js";

const path = "mcp/src/clinic/guarantor-link-operation.ts";
const callee = "this.deps.serviceFhir.executeTransactionAsActor";
const text = [
  "class Operation {",
  "  async transaction(bundle, actor) {",
  "    // fhir-service-write: Task, Person, RelatedPerson",
  `    const response = await ${callee}(bundle, actor);`,
  "    return response;",
  "  }",
  "}",
].join("\n");
const inventory: readonly ExactFhirWriteCallSite[] = [
  { path, line: 4, callee, resourceType: "Task", reason: "Service transaction fixture." },
  { path, line: 4, callee, resourceType: "Person", reason: "Service transaction fixture." },
  { path, line: 4, callee, resourceType: "RelatedPerson", reason: "Service transaction fixture." },
];
const inventoryName = "Service-identity FHIR write exclusion";

test("a service-write annotation scans the actual attributed transaction once per resource type", () => {
  assert.deepEqual(collectFhirOperations([{ path, text }]), [
    { path, line: 4, callee, interaction: "transaction", requiredInteraction: "transaction", resourceType: "Task" },
    { path, line: 4, callee, interaction: "transaction", requiredInteraction: "transaction", resourceType: "Person" },
    { path, line: 4, callee, interaction: "transaction", requiredInteraction: "transaction", resourceType: "RelatedPerson" },
  ]);
});

test("annotated transactions need exact service registry entries despite existing staff write grants", () => {
  const operations = collectFhirOperations([{ path, text }]);
  assert.equal(operations.length, 3);
  const staffRules = buildMedplumAccessPolicy(getRoleDeclaration("staff")).resource ?? [];
  for (const resourceType of ["Task", "Person", "RelatedPerson"]) {
    assert.equal(staffRules.some(rule => rule.resourceType === resourceType && rule.interaction?.includes("update")), true);
  }
  assert.deepEqual(findMissingFhirOperationGrants(operations, staffRules), operations);
  assert.deepEqual(matchExactWriteInventory(operations, inventory, inventoryName), operations);
  for (const resourceType of ["Task", "Person", "RelatedPerson"]) {
    assert.throws(
      () => matchExactWriteInventory(operations, inventory.filter(entry => entry.resourceType !== resourceType), inventoryName),
      new RegExp(`Annotated service transaction requires an exact registry entry: ${path}:4 ${callee.replaceAll(".", "\\.")} ${resourceType}`),
    );
  }
});

test("an annotated transaction registry entry remains bound to path, line, callee and resource type", () => {
  const operations = collectFhirOperations([{ path, text }]);
  assert.equal(operations.length, 3);
  for (const mutation of [
    { path: "mcp/src/clinic/other.ts" }, { line: 5 },
    { callee: "other.executeTransactionAsActor" }, { resourceType: "Account" },
  ]) {
    assert.throws(
      () => matchExactWriteInventory(operations, [{ ...inventory[0], ...mutation }, ...inventory.slice(1)], inventoryName),
      /no longer matches a real ungranted call site/,
    );
  }
});

test("unannotated transactions retain their previous scan behavior", () => {
  assert.deepEqual(collectFhirOperations([{ path, text: [
    "// fhir-service-write: Task",
    "function unrelated() {}",
    "await serviceFhir.executeTransactionAsActor(bundle, actor);",
    "await serviceFhir.executeTransaction(bundle);",
    "const note = '// fhir-service-write: Task';",
    "await other.executeTransactionAsActor(bundle, actor);",
  ].join("\n") }]), []);
});

test("a service-write annotation stays on its statement and does not annotate later calls", () => {
  const source = [
    "// fhir-service-write: Task",
    "await serviceFhir.executeTransactionAsActor(bundle, actor);",
    "await serviceFhir.executeTransactionAsActor(otherBundle, actor);",
  ].join("\n");
  assert.deepEqual(collectFhirOperations([{ path, text: source }]), [{
    path, line: 2, callee: "serviceFhir.executeTransactionAsActor",
    interaction: "transaction", requiredInteraction: "transaction", resourceType: "Task",
  }]);
});

test("malformed service transaction annotations fail instead of dropping declared resource types", () => {
  for (const declaration of ["", "Task,,Person", "Task, Task", "task", "Task Person"]) {
    assert.throws(
      () => collectFhirOperations([{ path, text: `// fhir-service-write: ${declaration}\nawait serviceFhir.executeTransactionAsActor(bundle, actor);` }]),
      /Invalid fhir-service-write annotation/,
    );
  }
});

test("the non-FHIR allowlist cannot suppress an explicitly annotated service transaction", () => {
  assert.throws(() => collectFhirOperations([{ path, text }], [{
    path, callee, literal: "Task", reason: "Incorrect attempted waiver.",
  }]), /Non-FHIR call-site allowlist entry no longer matches source/);
});
