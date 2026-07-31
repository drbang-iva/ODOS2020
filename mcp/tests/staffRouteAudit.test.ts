import assert from "node:assert/strict";
import test from "node:test";
import type { Patient } from "@medplum/fhirtypes";
import type { OdosAuditEventRecord } from "../src/authz/odosAudit.js";
import {
  createMedplumClient,
  createStaffRouteFhirClient,
  type FhirAuditRecorder,
} from "../src/fhir-client.js";
import { TEST_FHIR_AUDIT_CONTEXT, TEST_FHIR_AUDIT_RECORDER } from "./fhirAuditTestStub.js";

test("authenticateStaffRoute client changes a previously unaudited operation into a real-staff audit row", async () => {
  const originalFetch = globalThis.fetch;
  const rows: OdosAuditEventRecord[] = [];
  const audit: FhirAuditRecorder = {
    async record(row, operation) {
      rows.push(row);
      return operation();
    },
    async recordDenied(row) {
      rows.push(row);
    },
  };
  globalThis.fetch = async () => new Response(JSON.stringify({
    resourceType: "Patient",
    id: "patient-1",
  }), {
    status: 200,
    headers: { "Content-Type": "application/fhir+json" },
  });

  try {
    const before = createMedplumClient({
      baseUrl: "http://synthetic-fhir.test",
      accessToken: "synthetic-token",
      audit: TEST_FHIR_AUDIT_RECORDER,
      auditContext: TEST_FHIR_AUDIT_CONTEXT,
    });
    await before.read<Patient>("Patient", "patient-1");
    assert.equal(rows.length, 0);

    const after = createStaffRouteFhirClient({
      baseUrl: "http://synthetic-fhir.test",
      accessToken: "synthetic-token",
      staffReference: "Practitioner/real-staff-1",
      actorRole: "clinician",
      audit,
    });
    await after.read<Patient>("Patient", "patient-1");
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.eventType, "read");
    assert.equal(rows[0]?.actorId, "real-staff-1");
    assert.equal(rows[0]?.actorRole, "clinician");
    assert.equal(rows[0]?.resourceType, "Patient");
    assert.equal(rows[0]?.resourceId, "patient-1");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
