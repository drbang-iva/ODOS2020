import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import type { Bundle, Resource } from "@medplum/fhirtypes";
import express from "express";
import { createPaymentDispatch } from "../src/payments/payment-config.js";
import { registerPatientPaymentRoutes } from "../src/payments/payment-routes.js";

test("all patient-payment HTTP routes reach their handlers", async () => {
  const fixture = await server();
  try {
    const cases: Array<["GET" | "POST", string, number, RegExp | undefined]> = [
      ["GET", "/payments/methods", 200, undefined],
      ["POST", "/payments/credit/apply", 400, /paymentReconciliationReference/],
      ["POST", "/payments/credit/transfer", 400, /fromInvoiceReference/],
      ["POST", "/payments/credit/void", 400, /payment method/],
      ["GET", "/payments/credit/unapplied?patientReference=Patient%2Fpatient-1", 200, undefined],
      ["GET", "/payments/reconciliations?patientReference=Patient%2Fpatient-1", 200, undefined],
      ["GET", "/payments/patient/Patient%2Fpatient-1/open-charges", 200, undefined],
      ["POST", "/payments/collect", 400, /requestId/],
    ];
    for (const [method, path, status, error] of cases) {
      const response = await call(fixture.baseUrl, method, path, "Bearer good");
      assert.equal(response.status, status, path);
      const body = await response.text();
      if (error) assert.match(body, error, path);
    }
    assert.equal(fixture.serviceAuthCalls(), cases.length);
  } finally {
    await fixture.close();
  }
});

test("GET /payments/methods returns configured methods for staff and 401 without authentication", async () => {
  const fixture = await server();
  try {
    const response = await call(fixture.baseUrl, "GET", "/payments/methods", "Bearer good");
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { methods: ["manual-cash"] });
    assert.equal((await call(fixture.baseUrl, "GET", "/payments/methods")).status, 401);
  } finally {
    await fixture.close();
  }
});

test("every patient-payment HTTP route preserves 401 and payment.charge 403 gates", async () => {
  const fixture = await server();
  try {
    const routes: Array<["GET" | "POST", string, string, RegExp]> = [
      ["POST", "/payments/credit/apply", "Bearer admin", /payment\.charge role required/],
      ["POST", "/payments/credit/transfer", "Bearer admin", /payment\.charge role required/],
      ["POST", "/payments/credit/void", "Bearer staff", /payment\.void role required/],
      ["GET", "/payments/credit/unapplied?patientReference=Patient%2Fpatient-1", "Bearer no-role", /billing-context\.read role required/],
      ["GET", "/payments/reconciliations?patientReference=Patient%2Fpatient-1", "Bearer no-role", /billing-context\.read role required/],
      ["GET", "/payments/patient/Patient%2Fpatient-1/open-charges", "Bearer admin", /payment\.charge role required/],
      ["POST", "/payments/collect", "Bearer admin", /payment\.charge role required/],
    ];
    for (const [method, path, authorization, error] of routes) {
      assert.equal((await call(fixture.baseUrl, method, path)).status, 401, `${path} 401`);
      const forbidden = await call(fixture.baseUrl, method, path, authorization);
      assert.equal(forbidden.status, 403, `${path} 403`);
      assert.match(await forbidden.text(), error, path);
    }
  } finally {
    await fixture.close();
  }
});

async function server() {
  let serviceAuthCalls = 0;
  const fhir = {
    read: async <T extends Resource>(): Promise<T> => { throw new Error("not reached"); },
    search: async <T extends Resource>(): Promise<Bundle<T>> => ({ resourceType: "Bundle", type: "searchset" }),
    update: async <T extends Resource>(_rt: T["resourceType"], _id: string, resource: T): Promise<T> => resource,
    create: async <T extends Resource>(resource: T): Promise<T> => resource,
  };
  const app = express();
  app.use(express.json());
  registerPatientPaymentRoutes(app, {
    authenticateService: async () => { serviceAuthCalls += 1; },
    handlers: {
      authenticate: async (header) => header === "Bearer good"
        ? { staffReference: "Practitioner/staff-1", actorRole: "staff", roles: ["staff", "admin"], fhir: fhir as never }
        : header === "Bearer staff"
          ? { staffReference: "Practitioner/staff-2", actorRole: "staff", roles: ["staff"], fhir: fhir as never }
          : header === "Bearer admin"
            ? { staffReference: "Practitioner/admin", actorRole: "admin", roles: ["admin"], fhir: fhir as never }
            : header === "Bearer no-role"
              ? { staffReference: "Practitioner/roleless", actorRole: "admin", roles: [], fhir: fhir as never }
          : null,
      lifecycleFhir: fhir,
      dispatch: createPaymentDispatch([{ method: "manual-cash" }]),
      recordAudit: async () => undefined,
      now: () => "2026-07-10T12:00:00.000Z",
    },
    collection: {
      authenticate: async (header) => header === "Bearer good"
        ? { staffReference: "Practitioner/staff-1", actorRole: "staff", roles: ["staff", "admin"], fhir: fhir as never }
        : header === "Bearer staff"
          ? { staffReference: "Practitioner/staff-2", actorRole: "staff", roles: ["staff"], fhir: fhir as never }
          : header === "Bearer admin"
            ? { staffReference: "Practitioner/admin", actorRole: "admin", roles: ["admin"], fhir: fhir as never }
            : header === "Bearer no-role"
              ? { staffReference: "Practitioner/roleless", actorRole: "admin", roles: [], fhir: fhir as never }
          : null,
      recordAudit: async () => undefined,
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

function call(baseUrl: string, method: "GET" | "POST", path: string, authorization?: string): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      ...(authorization ? { Authorization: authorization } : {}),
      ...(method === "POST" ? { "Content-Type": "application/json" } : {}),
    },
    ...(method === "POST" ? { body: "{}" } : {}),
  });
}
