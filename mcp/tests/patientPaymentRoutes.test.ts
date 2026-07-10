import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import type { Bundle, Resource } from "@medplum/fhirtypes";
import express from "express";
import { createPaymentDispatch } from "../src/payments/payment-config.js";
import { registerPatientPaymentRoutes } from "../src/payments/payment-routes.js";

test("all five patient-payment HTTP routes reach their handlers", async () => {
  const fixture = await server();
  try {
    const cases: Array<["GET" | "POST", string, number, RegExp | undefined]> = [
      ["POST", "/payments/credit/apply", 400, /paymentReconciliationReference/],
      ["POST", "/payments/credit/transfer", 400, /fromInvoiceReference/],
      ["POST", "/payments/credit/void", 400, /payment method/],
      ["GET", "/payments/credit/unapplied?patientReference=Patient%2Fpatient-1", 200, undefined],
      ["GET", "/payments/reconciliations?patientReference=Patient%2Fpatient-1", 200, undefined],
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

test("every patient-payment HTTP route preserves 401 and payment.charge 403 gates", async () => {
  const fixture = await server();
  try {
    const routes: Array<["GET" | "POST", string]> = [
      ["POST", "/payments/credit/apply"],
      ["POST", "/payments/credit/transfer"],
      ["POST", "/payments/credit/void"],
      ["GET", "/payments/credit/unapplied?patientReference=Patient%2Fpatient-1"],
      ["GET", "/payments/reconciliations?patientReference=Patient%2Fpatient-1"],
    ];
    for (const [method, path] of routes) {
      assert.equal((await call(fixture.baseUrl, method, path)).status, 401, `${path} 401`);
      const forbidden = await call(fixture.baseUrl, method, path, "Bearer forbidden");
      assert.equal(forbidden.status, 403, `${path} 403`);
      assert.match(await forbidden.text(), /payment\.charge role required/, path);
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
        ? { staffReference: "Practitioner/staff-1", actorRole: "front-desk", fhir: fhir as never }
        : header === "Bearer forbidden"
          ? { staffReference: "Practitioner/staff-2", actorRole: "clinician", fhir: fhir as never }
          : null,
      lifecycleFhir: fhir,
      dispatch: createPaymentDispatch([{ method: "manual-cash" }]),
      recordAudit: async () => undefined,
      now: () => "2026-07-10T12:00:00.000Z",
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
