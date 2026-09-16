import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import express from "express";
import { rateLimit } from "express-rate-limit";
import ts from "typescript";
import type { BusinessAction, PracticeRoleId } from "../src/authz/roles.js";
import { handleDiagnosisPickRequest } from "../src/clinical-graph/diagnosis-pick-endpoint.js";
import { handleDiagnosisOrderRequest, handleDiagnosisProblemStatusRequest } from "../src/clinical-graph/diagnosis-order-endpoint.js";
import { handleDiagnosisPullRequest } from "../src/clinical-graph/diagnosis-carry-forward-endpoint.js";
import { handleDiagnosisVisitStatusUpdateRequest } from "../src/clinical-graph/diagnosis-visit-status-endpoint.js";
import { handleDiagnosisNewnessUpdateRequest } from "../src/clinical-graph/diagnosis-newness-endpoint.js";

test("registered diagnosis write routes share a rate limit before service or staff authentication", async () => {
  const routes = new Map([
    ["/clinical-graph/encounters/:encounterId/diagnosis-picks", "POST"],
    ["/clinical-graph/encounters/:encounterId/diagnosis-order", "PUT"],
    ["/clinical-graph/encounters/:encounterId/diagnoses/:conditionId/problem-status", "PUT"],
    ["/clinical-graph/encounters/:encounterId/diagnoses/:conditionId/status", "PUT"],
    ["/clinical-graph/encounters/:encounterId/diagnoses/:conditionId/newness", "PUT"],
  ]);
  const source = ts.createSourceFile("index.ts", readFileSync(new URL("../src/index.ts", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true);
  const declarations: string[] = [];
  const registrations: string[] = [];
  const collect = (node: ts.Node): void => {
    if (ts.isVariableStatement(node) && node.declarationList.declarations.some((entry) => entry.name.getText(source) === "diagnosisWriteLimit")) {
      declarations.push(node.getText(source));
    }
    if (ts.isExpressionStatement(node) && ts.isCallExpression(node.expression)) {
      const call = node.expression;
      const path = call.arguments[0];
      if (ts.isPropertyAccessExpression(call.expression) && call.expression.expression.getText(source) === "app"
        && path && ts.isStringLiteral(path) && routes.has(path.text)) {
        assert.equal(call.expression.name.text.toUpperCase(), routes.get(path.text));
        registrations.push(node.getText(source));
      }
    }
    ts.forEachChild(node, collect);
  };
  collect(source);
  assert.equal(registrations.length, routes.size);
  const app = express();
  let serviceChecks = 0;
  let staffChecks = 0;
  runInNewContext(ts.transpileModule([...declarations, ...registrations].join("\n"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText, {
    app, rateLimit, console,
    authenticateWithMedplum: async () => { serviceChecks++; },
    authenticateStaffRouteForAction: () => async () => { staffChecks++; return null; },
    diagnosisVisitStatusStore: {},
    handleDiagnosisPickRequest, handleDiagnosisOrderRequest, handleDiagnosisProblemStatusRequest,
    handleDiagnosisVisitStatusUpdateRequest, handleDiagnosisNewnessUpdateRequest,
  });
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  try {
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const requests = [...routes].map(([path, method]) => ({ path: path.replace(/:encounterId|:conditionId/g, "synthetic"), method }));
    for (let i = 0; i < 120; i++) {
      const request = requests[i % requests.length];
      assert.equal((await fetch(`${base}${request.path}`, { method: request.method })).status, 401);
    }
    for (const request of requests) {
      const response = await fetch(`${base}${request.path}`, { method: request.method });
      assert.equal(response.status, 429, request.path);
      assert.ok(Number(response.headers.get("retry-after")) > 0);
      assert.equal(serviceChecks, 120);
      assert.equal(staffChecks, 120);
    }
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

for (const identity of [
  { actorRole: "staff" },
  { actorRole: "admin" },
  { actorRole: "provider", businessActions: ["chart.read", "chart.write"] },
  { actorRole: "staff", roles: ["staff", "provider"], businessActions: ["chart.read", "chart.write"] },
] satisfies Array<{ actorRole: PracticeRoleId; roles?: PracticeRoleId[]; businessActions?: BusinessAction[] }>) {
  test(`diagnosis entrypoints refuse ${identity.actorRole}${identity.businessActions ? " with diagnosis action revoked" : ""} before any dependency call`, async (t) => {
    let dependencyCalls = 0;
    const unexpected = async (): Promise<never> => {
      dependencyCalls += 1;
      throw new Error("The diagnosis action must be checked before reads or writes.");
    };
    const fhir = {
      baseUrl: "http://127.0.0.1/fhir/R4", read: unexpected, search: unexpected,
      searchUrl: unexpected, create: unexpected, update: unexpected, patch: unexpected,
      executeTransaction: unexpected,
    };
    const authenticate = async () => ({ staffReference: "Practitioner/synthetic", ...identity, fhir });
    const store = {
      listByEncounter: unexpected, upsert: unexpected,
      listNewnessOverrides: unexpected, upsertNewnessOverride: unexpected,
    };
    const input = { authHeader: "Bearer synthetic", params: { encounterId: "e1", conditionId: "c1" } };
    const requests = {
      pick: () => handleDiagnosisPickRequest({ authenticate, diagnosisVisitStatusStore: store }, {
        ...input, body: { action: "confirm", diagnosisKey: "presbyopia" },
      }),
      order: () => handleDiagnosisOrderRequest({ authenticate }, {
        ...input, body: { conditionReferences: ["Condition/c1"] },
      }),
      pull: () => handleDiagnosisPullRequest({ authenticate, fhirBaseUrl: fhir.baseUrl }, {
        ...input, body: { sourceEncounterReference: "Encounter/prior", sourceConditionReference: "Condition/prior" },
      }),
      status: () => handleDiagnosisVisitStatusUpdateRequest({ authenticate, store }, {
        ...input, body: { status: "stable" },
      }),
      newness: () => handleDiagnosisNewnessUpdateRequest({ authenticate, store }, {
        ...input, body: { value: "established" },
      }),
      complexity: () => handleDiagnosisProblemStatusRequest({ authenticate }, {
        ...input, body: { problemStatus: "stable-chronic", expectedEncounterVersion: "1" },
      }),
    };
    for (const [name, request] of Object.entries(requests)) {
      await t.test(name, async () => {
        const result = await request();
        assert.equal(result.status, 403, JSON.stringify(result.body));
        assert.equal(dependencyCalls, 0);
      });
    }
  });
}
