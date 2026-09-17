import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { test } from "node:test";
import ts from "typescript";

test("V18 custom capture route forwards 428 no-store command-precondition headers", async () => {
  const source = ts.createSourceFile("index.ts", readFileSync(new URL("../src/index.ts", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true);
  let registration: ts.ExpressionStatement | undefined;
  function visit(node: ts.Node): void {
    if (ts.isExpressionStatement(node) && ts.isCallExpression(node.expression)) {
      const call = node.expression;
      if (ts.isPropertyAccessExpression(call.expression) && call.expression.getText(source) === "app.post" && call.arguments[0]?.getText(source) === '"/clinical-graph/custom/:stableKey"') registration = node;
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  assert.ok(registration);
  let handler: (request: unknown, response: unknown) => Promise<void> = async () => assert.fail("route not registered");
  runInNewContext(ts.transpileModule(registration.getText(source), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, {
    app: { post: (_path: string, registered: typeof handler) => { handler = registered; } },
    authenticateWithMedplum: async () => undefined,
    clinicalGraphRouteDeps: async () => ({}),
    handleCustomSectionCaptureRequest: async () => ({ status: 428, body: { code: "finding-command-required" }, headers: { "Cache-Control": "no-store" } }),
    console,
  });
  const headers: Record<string,string> = {};
  let status: number | undefined; let body: unknown;
  const response = { headersSent: false, set(values: Record<string,string>) { Object.assign(headers, values); return this; }, status(value: number) { status = value; return this; }, json(value: unknown) { body = value; return this; } };
  await handler({ header: () => undefined, params: { stableKey: "synthetic" }, body: {} }, response);
  assert.equal(status, 428);
  assert.deepEqual(body, { code: "finding-command-required" });
  assert.equal(headers["Cache-Control"], "no-store");
});
