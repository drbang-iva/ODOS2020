import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import type { Bundle, Coverage, CoverageEligibilityRequest, CoverageEligibilityResponse, Resource } from "@medplum/fhirtypes";
import express from "express";
import type { OdosAuditEventRecord } from "../src/authz/odosAudit.js";
import { registerPatientInsuranceRoutes } from "../src/insurance/patient-insurance-routes.js";

test("all four patient-insurance HTTP routes reach their handlers", async () => {
  const fixture = await server();
  try {
    const cases: Array<["GET" | "POST", string, unknown, number]> = [
      ["GET", "/insurance/coverages?patientReference=Patient%2Fpatient-1", undefined, 200],
      ["POST", "/insurance/coverages", { bundle: coverageBundle() }, 200],
      ["GET", "/insurance/vision-benefits?patientReference=Patient%2Fpatient-1", undefined, 200],
      ["POST", "/insurance/vision-benefits", { bundle: benefitsBundle() }, 200],
    ];
    for (const [method, path, body, status] of cases) {
      const response = await call(fixture.baseUrl, method, path, "Bearer good", body);
      assert.equal(response.status, status, path);
    }
    assert.equal(fixture.serviceAuthCalls(), cases.length);
    assert.equal(fixture.transactions(), 2);
    assert.deepEqual(fixture.audits().map((row) => ({
      eventType: row.eventType,
      actorId: row.actorId,
      actorRole: row.actorRole,
      patientId: row.patientId,
      resourceType: row.resourceType,
      resourceId: row.resourceId,
      actionOutcome: row.actionOutcome,
    })), [
      { eventType: "coverage.write", actorId: "staff-1", actorRole: "staff", patientId: "patient-1", resourceType: "Coverage", resourceId: "coverage-created", actionOutcome: "granted" },
      { eventType: "benefits.manual-entry", actorId: "staff-1", actorRole: "staff", patientId: "patient-1", resourceType: "CoverageEligibilityResponse", resourceId: "benefits-created", actionOutcome: "granted" },
    ]);
  } finally {
    await fixture.close();
  }
});

test("every patient-insurance HTTP route preserves 401 and claims.manage 403 gates", async () => {
  const fixture = await server();
  try {
    const routes: Array<["GET" | "POST", string, unknown]> = [
      ["GET", "/insurance/coverages?patientReference=Patient%2Fpatient-1", undefined],
      ["POST", "/insurance/coverages", { bundle: coverageBundle() }],
      ["GET", "/insurance/vision-benefits?patientReference=Patient%2Fpatient-1", undefined],
      ["POST", "/insurance/vision-benefits", { bundle: benefitsBundle() }],
    ];
    for (const [method, path, body] of routes) {
      assert.equal((await call(fixture.baseUrl, method, path, undefined, body)).status, 401, `${path} 401`);
      const forbidden = await call(fixture.baseUrl, method, path, "Bearer forbidden", body);
      assert.equal(forbidden.status, 403, `${path} 403`);
      assert.match(await forbidden.text(), /claims\.manage role required/, path);
    }
  } finally {
    await fixture.close();
  }
});

test("patient-insurance uses a granting role from a clinician-primary multi-role caller", async () => {
  const fixture = await server();
  try {
    const response = await call(
      fixture.baseUrl,
      "POST",
      "/insurance/coverages",
      "Bearer owner",
      { bundle: coverageBundle() },
    );
    assert.equal(response.status, 200);
    assert.equal(fixture.audits()[0].actorRole, "staff");
  } finally {
    await fixture.close();
  }
});

test("Coverage transactions reject dangling subscriber URNs and map concurrent edits to 409", async () => {
  const invalid = await server();
  try {
    const bundle = coverageBundle();
    const coverage = bundle.entry?.[0]?.resource as Coverage;
    coverage.subscriber = { reference: "urn:uuid:missing-related-person" };
    const response = await call(invalid.baseUrl, "POST", "/insurance/coverages", "Bearer good", { bundle });
    assert.equal(response.status, 400);
    assert.match(await response.text(), /missing transaction RelatedPerson/);
  } finally {
    await invalid.close();
  }

  const conflict = await server(true);
  try {
    const coverageResponse = await call(conflict.baseUrl, "POST", "/insurance/coverages", "Bearer good", { bundle: coverageBundle() });
    assert.equal(coverageResponse.status, 409);
    assert.match(await coverageResponse.text(), /changed while you were editing/);
    const benefitsResponse = await call(conflict.baseUrl, "POST", "/insurance/vision-benefits", "Bearer good", { bundle: benefitsBundle() });
    assert.equal(benefitsResponse.status, 409);
    assert.match(await benefitsResponse.text(), /changed while you were editing/);
    assert.deepEqual(conflict.audits().map((row) => ({
      eventType: row.eventType,
      patientId: row.patientId,
      resourceType: row.resourceType,
      resourceId: row.resourceId,
      actionOutcome: row.actionOutcome,
    })), [
      { eventType: "coverage.write", patientId: "patient-1", resourceType: "Coverage", resourceId: "uncreated", actionOutcome: "denied" },
      { eventType: "benefits.manual-entry", patientId: "patient-1", resourceType: "CoverageEligibilityResponse", resourceId: "uncreated", actionOutcome: "denied" },
    ]);
  } finally {
    await conflict.close();
  }
});

async function server(conflict = false) {
  let serviceAuthCalls = 0;
  let transactions = 0;
  const audits: OdosAuditEventRecord[] = [];
  const fhir = {
    search: async <T extends Resource>(): Promise<Bundle<T>> => ({ resourceType: "Bundle", type: "searchset" }),
    executeTransaction: async (bundle: Bundle): Promise<Bundle> => {
      transactions += 1;
      if (conflict) throw Object.assign(new Error("FHIR 409 Conflict"), { status: 409 });
      return {
        resourceType: "Bundle",
        type: "transaction-response",
        entry: (bundle.entry ?? []).map((entry) => ({ response: {
          status: "201 Created",
          location: entry.resource?.resourceType === "Coverage"
            ? "Coverage/coverage-created/_history/1"
            : entry.resource?.resourceType === "CoverageEligibilityResponse"
              ? "CoverageEligibilityResponse/benefits-created/_history/1"
              : `${entry.resource?.resourceType}/request-created/_history/1`,
        } })),
      };
    },
  };
  const app = express();
  app.use(express.json());
  registerPatientInsuranceRoutes(app, async () => { serviceAuthCalls += 1; }, {
    authenticate: async (header) => header === "Bearer good"
      ? { staffReference: "Practitioner/staff-1", actorRole: "staff", roles: ["staff"], fhir }
      : header === "Bearer forbidden"
        ? { staffReference: "Practitioner/staff-2", actorRole: "provider", roles: ["provider"], fhir }
        : header === "Bearer owner"
          ? {
              staffReference: "Practitioner/owner",
              actorRole: "provider",
              roles: ["provider", "staff", "admin"],
              fhir,
            }
        : null,
    recordAudit: async (row) => { audits.push(row); },
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
    transactions: () => transactions,
    audits: () => audits,
    close: () => new Promise<void>((resolve, reject) => listener.close((error) => error ? reject(error) : resolve())),
  };
}

function coverageBundle(): Bundle {
  const coverage: Coverage = {
    resourceType: "Coverage",
    status: "active",
    beneficiary: { reference: "Patient/patient-1" },
    payor: [{ reference: "Organization/payer-1" }],
  };
  return { resourceType: "Bundle", type: "transaction", entry: [{ fullUrl: "urn:uuid:coverage-1", resource: coverage, request: { method: "POST", url: "Coverage" } }] };
}

function benefitsBundle(): Bundle {
  const request: CoverageEligibilityRequest = {
    resourceType: "CoverageEligibilityRequest",
    status: "active",
    purpose: ["benefits"],
    patient: { reference: "Patient/patient-1" },
    created: "2026-07-10T12:00:00Z",
    insurer: { reference: "Organization/payer-1" },
    insurance: [{ coverage: { reference: "Coverage/coverage-1" } }],
  };
  const response: CoverageEligibilityResponse = {
    resourceType: "CoverageEligibilityResponse",
    status: "active",
    purpose: ["benefits"],
    patient: { reference: "Patient/patient-1" },
    created: "2026-07-10T12:00:00Z",
    request: { reference: "urn:uuid:request-1" },
    outcome: "complete",
    insurer: { reference: "Organization/payer-1" },
    insurance: [{ coverage: { reference: "Coverage/coverage-1" } }],
  };
  return { resourceType: "Bundle", type: "transaction", entry: [
    { fullUrl: "urn:uuid:request-1", resource: request, request: { method: "POST", url: "CoverageEligibilityRequest" } },
    { fullUrl: "urn:uuid:response-1", resource: response, request: { method: "POST", url: "CoverageEligibilityResponse" } },
  ] };
}

function call(baseUrl: string, method: "GET" | "POST", path: string, authorization?: string, body?: unknown): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      ...(authorization ? { Authorization: authorization } : {}),
      ...(method === "POST" ? { "Content-Type": "application/json" } : {}),
    },
    ...(method === "POST" ? { body: JSON.stringify(body ?? {}) } : {}),
  });
}
