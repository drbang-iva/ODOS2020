import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import type { Bundle, Resource } from "@medplum/fhirtypes";
import express from "express";
import type { ClaimMdAdapter } from "../src/claims/claimmd-adapter.js";
import { registerReportingRoutes } from "../src/reporting/reporting-routes.js";

const ROUTES = [
  "/reports/accounts-receivable",
  "/claims/search/export?outstanding=true&minDays=31&maxDays=60",
  "/claims/era/export?lane=new",
  "/claims/worklist/export?status=open",
  "/payments/reconciliations/export?patientReference=Patient%2Fpatient-1&startDate=2026-07-01&endDate=2026-07-10",
] as const;

test("AR dashboard and all four table-export HTTP routes reach their authenticated handlers", async () => {
  const fixture = await server();
  try {
    for (const path of ROUTES) {
      const response = await fetch(`${fixture.baseUrl}${path}`, { headers: { Authorization: "Bearer good" } });
      assert.equal(response.status, 200, path);
      if (path.includes("/export")) {
        assert.match(response.headers.get("Content-Type") ?? "", /^text\/csv/);
        assert.match(response.headers.get("Content-Disposition") ?? "", /^attachment; filename=/);
      } else {
        assert.match(response.headers.get("Content-Type") ?? "", /^application\/json/);
      }
    }
    assert.equal(fixture.serviceAuthCalls(), ROUTES.length);
  } finally {
    await fixture.close();
  }
});

test("AR dashboard and every export route preserve their underlying 401 and 403 gates", async () => {
  const fixture = await server();
  try {
    for (const path of ROUTES) {
      assert.equal((await fetch(`${fixture.baseUrl}${path}`)).status, 401, `${path} 401`);
      const forbidden = await fetch(`${fixture.baseUrl}${path}`, { headers: { Authorization: "Bearer forbidden" } });
      assert.equal(forbidden.status, 403, `${path} 403`);
      assert.match(
        await forbidden.text(),
        path.startsWith("/payments/") ? /payment\.charge role required/ : /claims\.manage role required/,
        path,
      );
    }
  } finally {
    await fixture.close();
  }
});

test("statement list, generate-one, and batch routes use the same authenticated reporting boundary", async () => {
  const fixture = await server();
  try {
    const list = await fetch(`${fixture.baseUrl}/statements`, { headers: { Authorization: "Bearer good" } });
    assert.equal(list.status, 200);
    assert.deepEqual(await list.json(), { items: [] });
    const generate = await fetch(`${fixture.baseUrl}/statements/generate`, {
      method: "POST",
      headers: { Authorization: "Bearer good", "Content-Type": "application/json" },
      body: JSON.stringify({ patientReference: "Patient/patient-1" }),
    });
    assert.equal(generate.status, 200);
    const run = await fetch(`${fixture.baseUrl}/statements/run`, { method: "POST", headers: { Authorization: "Bearer good" } });
    assert.equal(run.status, 200);
    assert.equal((await fetch(`${fixture.baseUrl}/statements`)).status, 401);
    assert.equal((await fetch(`${fixture.baseUrl}/statements`, { headers: { Authorization: "Bearer forbidden" } })).status, 403);
  } finally {
    await fixture.close();
  }
});

async function server() {
  let serviceAuthCalls = 0;
  const fhir = {
    create: async <T extends Resource>(resource: T): Promise<T> => resource,
    read: async <T extends Resource>(): Promise<T> => { throw new Error("not reached"); },
    update: async <T extends Resource>(_resourceType: T["resourceType"], _id: string, resource: T): Promise<T> => resource,
    search: async <T extends Resource>(): Promise<Bundle<T>> => ({ resourceType: "Bundle", type: "searchset" }),
    executeTransaction: async (bundle: Bundle): Promise<Bundle> => ({
      resourceType: "Bundle",
      type: "transaction-response",
      entry: (bundle.entry ?? []).map((_, index) => ({ response: { status: "201", location: `Task/statement-${index + 1}/_history/1` } })),
    }),
  };
  const authenticate = async (header: string | undefined) => header === "Bearer good"
    ? { staffReference: "Practitioner/staff-1", actorRole: "front-desk" as const, fhir }
    : header === "Bearer forbidden"
      ? { staffReference: "Practitioner/staff-2", actorRole: "clinician" as const, fhir }
      : null;
  const app = express();
  app.use(express.json());
  registerReportingRoutes(app, {
    authenticateService: async () => { serviceAuthCalls += 1; },
    claims: {
      authenticate,
      adapter: emptyAdapter(),
      recordAudit: async () => undefined,
      now: () => "2026-07-10T12:00:00.000Z",
    },
    payments: {
      authenticate,
      now: () => "2026-07-10T12:00:00.000Z",
    },
    statements: {
      authenticate,
      now: () => "2026-07-10T12:00:00.000Z",
      generateId: (() => { let id = 0; return () => `statement-${++id}`; })(),
    },
  });
  const listener = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve, reject) => {
    listener.once("listening", resolve);
    listener.once("error", reject);
  });
  const { port } = listener.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    serviceAuthCalls: () => serviceAuthCalls,
    close: () => new Promise<void>((resolve, reject) => listener.close((error) => error ? reject(error) : resolve())),
  };
}

function emptyAdapter(): ClaimMdAdapter {
  return {
    submitProfessionalClaim: async () => ({ claims: [], raw: {} }),
    checkEligibility: async () => ({}),
    checkClaimStatus: async () => ({}),
    listEras: async () => ({ result: { era: [] } }),
    retrieveEraData: async () => ({}),
  };
}
