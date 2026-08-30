import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import type { Bundle, Resource, Task } from "@medplum/fhirtypes";
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
      const forbiddenToken = path.startsWith("/payments/") ? "admin" : "forbidden";
      const forbidden = await fetch(`${fixture.baseUrl}${path}`, { headers: { Authorization: `Bearer ${forbiddenToken}` } });
      if (path.startsWith("/payments/")) {
        assert.equal(forbidden.status, 200, `${path} practice-wide read`);
        continue;
      }
      assert.equal(forbidden.status, 403, `${path} 403`);
      assert.match(
        await forbidden.text(),
        /claims\.manage role required/,
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
    assert.equal((await fetch(`${fixture.baseUrl}/statements`, { headers: { Authorization: "Bearer admin" } })).status, 403);
  } finally {
    await fixture.close();
  }
});

test("plan-profile route grants practice-admin and returns legible 403s to desk and clinician roles", async () => {
  const fixture = await server();
  try {
    assert.equal((await fetch(`${fixture.baseUrl}/practice/plan-profiles`)).status, 401);
    const admin = await fetch(`${fixture.baseUrl}/practice/plan-profiles`, {
      headers: { Authorization: "Bearer admin" },
    });
    assert.equal(admin.status, 200);
    assert.deepEqual(await admin.json(), { items: [] });
    for (const token of ["good", "forbidden"]) {
      const denied = await fetch(`${fixture.baseUrl}/practice/plan-profiles`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      assert.equal(denied.status, 403);
      assert.match(await denied.text(), /margin\.read role required/);
    }
  } finally {
    await fixture.close();
  }
});

test("margin-ledger route shares margin.read and returns the requested monthly period", async () => {
  const fixture = await server();
  try {
    assert.equal((await fetch(`${fixture.baseUrl}/practice/margin-ledger?period=2026-07`)).status, 401);
    const admin = await fetch(`${fixture.baseUrl}/practice/margin-ledger?period=2026-07`, {
      headers: { Authorization: "Bearer admin" },
    });
    assert.equal(admin.status, 200);
    assert.deepEqual(await admin.json(), {
      period: "2026-07",
      genesisDate: "2026-07-15",
      targetMultiplierMilli: 3000,
      realizedMarginCents: 0,
      inFlightCents: 0,
      driftCents: 0,
      settledLineCount: 0,
      inFlightLineCount: 0,
      lines: [],
    });
    const denied = await fetch(`${fixture.baseUrl}/practice/margin-ledger?period=2026-07`, {
      headers: { Authorization: "Bearer good" },
    });
    assert.equal(denied.status, 403);
    assert.match(await denied.text(), /margin\.read role required/);
  } finally {
    await fixture.close();
  }
});

async function server() {
  let serviceAuthCalls = 0;
  const tasks: Task[] = [];
  let taskCount = 0;
  const fhir = {
    create: async <T extends Resource>(resource: T): Promise<T> => resource,
    read: async <T extends Resource>(): Promise<T> => { throw new Error("not reached"); },
    update: async <T extends Resource>(_resourceType: T["resourceType"], _id: string, resource: T): Promise<T> => resource,
    search: async <T extends Resource>(resourceType: T["resourceType"], params: Record<string, string> = {}): Promise<Bundle<T>> => {
      if (resourceType !== "Task") return { resourceType: "Bundle", type: "searchset" };
      const resources = tasks.filter((task) => {
        if (params._id && !params._id.split(",").includes(task.id ?? "")) return false;
        if (params.status && task.status !== params.status) return false;
        if (params.code) {
          const [system, code] = params.code.split("|");
          if (!task.code?.coding?.some((coding) => coding.system === system && coding.code === code)) return false;
        }
        return true;
      });
      return {
        resourceType: "Bundle",
        type: "searchset",
        entry: resources.map((resource) => ({ resource: structuredClone(resource) as T })),
      };
    },
    executeTransaction: async (bundle: Bundle): Promise<Bundle> => ({
      resourceType: "Bundle",
      type: "transaction-response",
      entry: (bundle.entry ?? []).map((entry) => {
        if (entry.request?.method === "DELETE") {
          const id = entry.request.url.replace("Task/", "");
          const index = tasks.findIndex((task) => task.id === id);
          if (index >= 0) tasks.splice(index, 1);
          return { response: { status: "204" } };
        }
        const resource = entry.resource;
        if (!resource || resource.resourceType !== "Task") throw new Error("Unexpected statement transaction resource");
        const requestedId = entry.request?.method === "PUT" ? entry.request.url.replace("Task/", "") : undefined;
        const id = requestedId ?? `statement-${++taskCount}`;
        const existingIndex = tasks.findIndex((task) => task.id === id);
        const versionId = String(existingIndex >= 0 ? Number(tasks[existingIndex].meta?.versionId ?? "0") + 1 : 1);
        const saved: Task = { ...structuredClone(resource), id, meta: { ...resource.meta, versionId } };
        if (existingIndex >= 0) tasks[existingIndex] = saved;
        else tasks.push(saved);
        return { response: { status: requestedId ? "200" : "201", location: `Task/${id}/_history/${versionId}` } };
      }),
    }),
  };
  const authenticate = async (header: string | undefined) => header === "Bearer good"
    ? { staffReference: "Practitioner/staff-1", actorRole: "staff" as const, roles: ["staff"] as const, fhir }
    : header === "Bearer admin"
      ? { staffReference: "Practitioner/admin", actorRole: "admin" as const, roles: ["admin"] as const, fhir }
    : header === "Bearer forbidden"
      ? { staffReference: "Practitioner/staff-2", actorRole: "provider" as const, roles: ["provider"] as const, fhir }
      : null;
  const app = express();
  app.use(express.json());
  registerReportingRoutes(app, {
    authenticateService: async () => { serviceAuthCalls += 1; },
    claims: {
      authenticate,
      adapter: emptyAdapter(),
      claimReadModel: {
        search: async () => [],
      } as NonNullable<import("../src/claims/claimmd-handlers.js").ClaimsHandlerDeps["claimReadModel"]>,
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
    planProfiles: {
      authenticate,
    },
    marginLedger: {
      authenticate,
      now: () => "2026-07-17T12:00:00.000Z",
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
