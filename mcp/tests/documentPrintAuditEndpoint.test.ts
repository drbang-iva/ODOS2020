import assert from "node:assert/strict";
import test from "node:test";
import type { DocumentReference, Resource } from "@medplum/fhirtypes";
import type { OdosAuditEventRecord } from "../src/authz/odosAudit.js";
import {
  handleDocumentPrintAuditRequest,
  type DocumentPrintAuditEndpointDeps,
} from "../src/authz/documentPrintAuditEndpoint.js";

const AUTH = "Bearer staff-token";

test("document print audit rejects a cross-patient target without recording", async () => {
  const harness = endpointHarness({
    target: documentReference("document-1", "Patient/other"),
  });
  const result = await handleDocumentPrintAuditRequest(harness.deps, request());

  assert.equal(result.status, 403);
  assert.equal(harness.readCalls, 1);
  assert.equal(harness.auditRows.length, 0);
});

test("document print audit rejects a role without the required business action before reading", async () => {
  const harness = endpointHarness({
    actorRole: "admin",
    roles: [],
  });
  const result = await handleDocumentPrintAuditRequest(harness.deps, request());

  assert.equal(result.status, 403);
  assert.equal(harness.readCalls, 0);
  assert.equal(harness.auditRows.length, 0);
});

test("document print audit resolves the target and records exactly one token-attributed row", async () => {
  const harness = endpointHarness();
  const result = await handleDocumentPrintAuditRequest(harness.deps, request());

  assert.equal(result.status, 201);
  assert.equal(harness.readCalls, 1);
  assert.equal(harness.auditRows.length, 1);
  assert.equal(harness.auditRows[0]?.eventType, "document.print.requested");
  assert.equal(harness.auditRows[0]?.actorId, "real-staff");
  assert.equal(harness.auditRows[0]?.actorRole, "provider");
  assert.equal(harness.auditRows[0]?.patientId, "patient-1");
  assert.equal(harness.auditRows[0]?.resourceType, "DocumentReference");
  assert.equal(harness.auditRows[0]?.resourceId, "document-1");
});

function request() {
  return {
    authHeader: AUTH,
    body: {
      eventType: "document.print.requested",
      documentKind: "letter",
      documentReference: "DocumentReference/document-1",
      patientReference: "Patient/patient-1",
    },
  };
}

function endpointHarness(options: {
  actorRole?: "provider" | "admin";
  roles?: Array<"provider" | "admin">;
  target?: DocumentReference;
} = {}): {
  deps: DocumentPrintAuditEndpointDeps;
  auditRows: OdosAuditEventRecord[];
  readonly readCalls: number;
} {
  const auditRows: OdosAuditEventRecord[] = [];
  let readCalls = 0;
  const target = options.target ?? documentReference("document-1", "Patient/patient-1");
  return {
    deps: {
      authenticate: async (header) => header === AUTH
        ? {
            staffReference: "Practitioner/real-staff",
            actorRole: options.actorRole ?? "provider",
            roles: options.roles ?? ["provider"],
            fhir: {
              read: async <T extends Resource>() => {
                readCalls += 1;
                return structuredClone(target) as T;
              },
            },
          }
        : null,
      recordAudit: async (row) => {
        auditRows.push(row);
      },
    },
    auditRows,
    get readCalls() {
      return readCalls;
    },
  };
}

function documentReference(id: string, patientReference: string): DocumentReference {
  return {
    resourceType: "DocumentReference",
    id,
    status: "current",
    type: { text: "Referral letter" },
    subject: { reference: patientReference },
    content: [{
      attachment: {
        contentType: "application/pdf",
        url: `Binary/${id}`,
      },
    }],
  };
}
