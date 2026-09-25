import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

test("WENO search storages in the registered server use ODOS_POSTGRES_URL", () => {
  const source = ts.createSourceFile("index.ts", readFileSync(new URL("../src/index.ts", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true);
  const constructors = new Map<string, ts.NewExpression>();
  const visit = (node: ts.Node): void => {
    if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && ["PostgresWenoDrugDatabaseStorage", "PostgresWenoPharmacyDirectoryStorage"].includes(node.expression.text)) {
      constructors.set(node.expression.text, node);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  for (const name of ["PostgresWenoDrugDatabaseStorage", "PostgresWenoPharmacyDirectoryStorage"]) {
    const instance = constructors.get(name);
    assert.ok(instance, `${name} is registered`);
    assert.equal(instance.arguments?.length, 1, `${name} receives configuration`);
    assert.equal(instance.arguments[0]?.getText(source), "{ postgresUrl: process.env.ODOS_POSTGRES_URL }", `${name} uses the configured Postgres URL`);
  }
});
