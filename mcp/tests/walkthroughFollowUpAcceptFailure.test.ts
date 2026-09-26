import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { runInNewContext } from "node:vm";
import express from "express";
import { rateLimit } from "express-rate-limit";
import ts from "typescript";
import type { Basic, Bundle, Resource } from "@medplum/fhirtypes";
import { FhirEncounterExamScopeStore } from "../src/clinical-graph/exam-scope-store.js";
import { buildProcedureFeeDefinition } from "../src/clinical-graph/procedure-fee-schedule.js";
import { handleFollowUpAcceptRequest } from "../src/clinical-graph/protocol-endpoint.js";

class FollowUpFhir {
  readonly baseUrl = "http://localhost:8103/";
  resources: Resource[] = [];
  next = 1;
  failOrder = false;
  failRead = false;

  async read<T extends Resource>(type: T["resourceType"], id: string): Promise<T> {
    const resource = this.resources.find(row => row.resourceType === type && row.id === id);
    if (!resource) throw Object.assign(new Error("synthetic missing resource"), { status: 404 });
    return structuredClone(resource) as T;
  }

  async search<T extends Resource>(type: T["resourceType"], params: Record<string, string> = {}): Promise<Bundle<T>> {
    if (this.failRead) throw Object.assign(new Error("synthetic queue read failure"), { status: 503 });
    const [codeSystem, codeValue] = params.code?.split("|") ?? [];
    const [identifierSystem, identifierValue] = params.identifier?.split("|") ?? [];
    const resources = this.resources.filter(row => row.resourceType === type &&
      (!codeValue || ((row as Basic).code?.coding ?? []).some(code => code.system === codeSystem && code.code === codeValue)) &&
      (!identifierValue || ((row as Basic).identifier ?? []).some(identifier => identifier.system === identifierSystem && identifier.value === identifierValue)));
    return { resourceType: "Bundle", type: "searchset", entry: resources.map(resource => ({ resource: structuredClone(resource) as T })) };
  }

  async create<T extends Resource>(resource: T): Promise<T> {
    if (resource.resourceType === "ServiceRequest" && this.failOrder) {
      throw Object.assign(new Error("synthetic order denied"), { status: 403 });
    }
    const saved = { ...structuredClone(resource), id: resource.id ?? `synthetic-${this.next++}`, meta: { versionId: "1" } } as T;
    this.resources.push(saved);
    return structuredClone(saved);
  }

  async update<T extends Resource>(_type: T["resourceType"], id: string, resource: T): Promise<T> {
    const index = this.resources.findIndex(row => row.resourceType === resource.resourceType && row.id === id);
    if (index < 0) throw new Error("synthetic update target missing");
    const saved = { ...structuredClone(resource), id, meta: { versionId: "2" } } as T;
    this.resources[index] = saved;
    return structuredClone(saved);
  }
}

async function fixture() {
  const staff = new FollowUpFhir();
  const service = new FollowUpFhir();
  staff.resources.push({ resourceType: "Encounter", id: "synthetic-encounter", status: "in-progress", class: { code: "AMB" }, subject: { reference: "Patient/synthetic-patient" } });
  await new FhirEncounterExamScopeStore(service).pick("synthetic-encounter", "office-visit", { reference: "Practitioner/synthetic" }, null, [], [
    { orderable: "fundus-photography", focus: "optic nerve", label: "Optic nerve photos", sources: [{ kind: "profile", profileKey: "glaucoma" }] },
  ]);
  service.resources.push({ ...buildProcedureFeeDefinition({ procedureConceptKey: "fundus-photography", display: "Fundus photography", category: "procedure", priceCents: 6000, billingCode: "SYNTHETIC" }), id: "synthetic-fee" });
  const accept = async () => {
    const source = ts.createSourceFile("index.ts", readFileSync(new URL("../src/index.ts", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true);
    const pieces: string[] = [];
    const collect = (node: ts.Node): void => {
      if (ts.isVariableStatement(node) && node.declarationList.declarations.some(entry => entry.name.getText(source) === "followUpAcceptLimit")) pieces.push(node.getText(source));
      if (ts.isExpressionStatement(node) && ts.isCallExpression(node.expression)) {
        const call = node.expression;
        const path = call.arguments[0];
        if (ts.isPropertyAccessExpression(call.expression) && call.expression.getText(source) === "app.post"
          && path && ts.isStringLiteral(path) && path.text === "/clinical-graph/encounters/:encounterId/follow-up-queue/accept") pieces.push(node.getText(source));
      }
      ts.forEachChild(node, collect);
    };
    collect(source);
    assert.equal(pieces.length, 2, "production limiter and Accept route");
    const app = express();
    app.use(express.json());
    runInNewContext(ts.transpileModule(pieces.join("\n"), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, {
      app, rateLimit, handleFollowUpAcceptRequest, fhir: service,
      authenticateWithMedplum: async () => undefined,
      authenticateStaffRouteForAction: (action: string) => {
        assert.equal(action, "chart.write");
        return async () => ({ staffReference: "Practitioner/synthetic", actorRole: "provider", fhir: staff });
      },
    });
    const listener = app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve, reject) => { listener.once("listening", resolve); listener.once("error", reject); });
    try {
      const response = await fetch(`http://127.0.0.1:${(listener.address() as AddressInfo).port}/clinical-graph/encounters/synthetic-encounter/follow-up-queue/accept`, {
        method: "POST", headers: { Authorization: "Bearer synthetic", "Content-Type": "application/json" },
        body: JSON.stringify({ orderable: "fundus-photography", focus: "optic nerve" }),
      });
      return { status: response.status, body: await response.json() };
    } finally {
      await new Promise<void>((resolve, reject) => listener.close(error => error ? reject(error) : resolve()));
    }
  };
  return { staff, service, accept };
}

test("Accept write failure says acceptance failed and logs one safe step", async () => {
  const h = await fixture();
  h.staff.failOrder = true;
  const original = console.error;
  const lines: string[] = [];
  console.error = (...args: unknown[]) => { lines.push(args.map(String).join(" ")); };
  try {
    const result = await h.accept();
    assert.equal(result.status, 502);
    assert.deepEqual(result.body, { code: "accept-failed", error: "The test could not be accepted." });
    assert.deepEqual(lines, ["follow-up accept failed: encounter=synthetic-encounter orderable=fundus-photography step=order status=403 message=synthetic order denied"]);
  } finally {
    console.error = original;
  }
});

test("Accept queue read failure retains the established load body", async () => {
  const h = await fixture();
  h.service.failRead = true;
  const result = await h.accept();
  assert.equal(result.status, 502);
  assert.deepEqual(result.body, { error: "The tests for this visit could not be loaded." });
});
