import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";
import {
  AuditEventProjectionQueue,
  InMemoryOsodAuditRepository,
  OSOD_AUDIT_EVENT_TYPES,
  assertAuditMutationAllowed,
  buildAuditEventProjection,
  buildOsodAuditEventRow,
  executePhiOperationWithAudit,
  ocrStyleAuditQuery,
} from "../src/authz/osodAudit.js";
import { verifyRestoreIntegrity } from "../src/authz/restoreIntegrity.js";
import { informationBlockingExceptionForDenial } from "../src/policy/ib-exception-map.js";
import {
  canReviewAuditLog,
  exportAuditRowsAsCsv,
  exportAuditRowsAsJson,
  filterAuditLogRows,
  sampleAuditRows,
} from "../../ui/src/lib/audit-log.ts";

test("v0.5b audit event type ValueSet covers the required read, write, security, IB, and DR events", () => {
  assert.deepEqual(OSOD_AUDIT_EVENT_TYPES, [
    "read",
    "search",
    "history",
    "vread",
    "create",
    "update",
    "patch",
    "transaction",
    "nullify-attempt",
    "delete-attempt",
    "denied",
    "break-glass-invoked",
    "break-glass-expired",
    "login",
    "logout",
    "login-failed",
    "role-change",
    "policy-change",
    "projectmembership-lifecycle",
    "backup-started",
    "backup-completed",
    "restore-started",
    "restore-completed",
    "external-api-call",
  ]);
});

test("v0.5b SQL migration creates append-only osod_audit_events table with required indexes and guards", () => {
  const sql = readFileSync(
    resolve(process.cwd(), "../data/migrations/2026-04-29-v05b-osod-audit-events.sql"),
    "utf8",
  );

  assert.match(sql, /CREATE TABLE IF NOT EXISTS osod_audit_events/);
  assert.match(sql, /event_time TIMESTAMPTZ NOT NULL DEFAULT now\(\)/);
  assert.match(sql, /ib_actor_classification TEXT NOT NULL DEFAULT 'health-care-provider'/);
  assert.match(sql, /CREATE INDEX IF NOT EXISTS osod_audit_events_patient_time_idx/);
  assert.match(sql, /CREATE INDEX IF NOT EXISTS osod_audit_events_actor_time_idx/);
  assert.match(sql, /BEFORE UPDATE OR DELETE ON osod_audit_events/);
  assert.match(sql, /BEFORE TRUNCATE ON osod_audit_events/);
  assert.match(sql, /REVOKE UPDATE, DELETE, TRUNCATE ON TABLE osod_audit_events FROM PUBLIC/);
  assert.match(sql, /WHERE NOT rolsuper/);
});

test("OCR-style 90-day audit query returns structured role, outcome, and IB context without enrichment", () => {
  const patientId = "patient-x";
  const rows = seedNinetyDays(patientId);
  const result = ocrStyleAuditQuery(rows, {
    patientId,
    from: "2026-01-30T00:00:00.000Z",
    to: "2026-04-29T23:59:59.999Z",
  });

  assert.equal(result.length, 5);
  assert.ok(result.every((row) => row.actorRole));
  assert.ok(result.every((row) => row.actionOutcome === "granted" || row.ibException));
  assert.equal(result.find((row) => row.actionOutcome === "denied")?.ibException, "privacy");
  assert.equal(result.find((row) => row.breakGlass)?.breakGlassReason, "Emergency care.");
});

test("denied AccessPolicy compartment isolation writes privacy IB exception and FHIR AuditEvent outcome=8", () => {
  const row = buildOsodAuditEventRow({
    eventType: "denied",
    actorId: "clinician-1",
    actorRole: "clinician",
    patientId: "patient-outside-compartment",
    resourceType: "Patient",
    resourceId: "patient-outside-compartment",
    actionOutcome: "denied",
    actionReason: "access-policy-compartment-isolation",
    policyUrl: "AccessPolicy/osod-clinician",
  });
  const auditEvent = buildAuditEventProjection(row);

  assert.equal(row.ibActorClassification, "health-care-provider");
  assert.equal(row.ibException, "privacy");
  assert.equal(auditEvent.outcome, "8");
  assert.equal(auditEvent.outcomeDesc, "access-policy-compartment-isolation");
  assert.equal(auditEvent.entity?.some((entity) => entity.detail?.[0]?.valueString === "privacy"), true);
});

test("AuditEvent projection field placement uses agent.role, agent.who, agent.policy, outcome, and entity", () => {
  const row = buildOsodAuditEventRow({
    eventType: "read",
    actorId: "doctor-1",
    actorRole: "clinician",
    patientId: "patient-x",
    resourceType: "Observation",
    resourceId: "obs-1",
    actionOutcome: "granted",
    policyUrl: "AccessPolicy/osod-clinician",
  });
  const auditEvent = buildAuditEventProjection(row);

  assert.equal(auditEvent.type.system, "http://terminology.hl7.org/CodeSystem/audit-event-type");
  assert.equal(auditEvent.subtype?.[0]?.code, "read");
  assert.equal(auditEvent.agent[0].role?.[0]?.coding?.[0]?.code, "clinician");
  assert.equal(auditEvent.agent[0].who?.reference, "Practitioner/doctor-1");
  assert.equal(auditEvent.agent[0].policy?.[0], "AccessPolicy/osod-clinician");
  assert.equal(auditEvent.source.observer?.reference, "Device/osod-instance");
  assert.equal(auditEvent.entity?.some((entity) => entity.what?.reference === "Patient/patient-x"), true);
  assert.equal(auditEvent.entity?.some((entity) => entity.what?.reference === "Observation/obs-1"), true);
});

test("originating PHI operation rolls back when osod_audit_events insert fails", async () => {
  let operationCalled = false;
  await assert.rejects(
    () =>
      executePhiOperationWithAudit({
        auditRow: buildOsodAuditEventRow({
          eventType: "read",
          patientId: "patient-x",
          actionOutcome: "granted",
        }),
        insertAuditRow: () => {
          throw new Error("database unreachable");
        },
        operation: () => {
          operationCalled = true;
        },
      }),
    /audit substrate unavailable/,
  );
  assert.equal(operationCalled, false);
});

test("FHIR AuditEvent projection failure leaves DB row and queues retry without rolling back PHI operation", async () => {
  const repository = new InMemoryOsodAuditRepository();
  const queue = new AuditEventProjectionQueue();
  let operationCalled = false;
  const row = buildOsodAuditEventRow({
    eventType: "read",
    patientId: "patient-x",
    actionOutcome: "granted",
  });

  await executePhiOperationWithAudit({
    auditRow: row,
    insertAuditRow: (auditRow) => repository.insert(auditRow),
    operation: () => {
      operationCalled = true;
      return "ok";
    },
    projectionQueue: queue,
    projectAuditEvent: () => {
      throw new Error("Medplum unreachable");
    },
  });

  assert.equal(operationCalled, true);
  assert.equal(repository.rows.length, 1);
  assert.equal(queue.pending.length, 1);
  assert.equal(queue.pending[0].attempts, 1);
  assert.match(queue.pending[0].lastError ?? "", /Medplum unreachable/);
});

test("append-only defenses reject UPDATE, DELETE, and TRUNCATE via permission and trigger guard", () => {
  assert.throws(
    () => assertAuditMutationAllowed({ operation: "UPDATE", dbRole: "app" }),
    /permission denied/,
  );
  assert.throws(
    () => assertAuditMutationAllowed({ operation: "DELETE", dbRole: "backup" }),
    /permission denied/,
  );
  assert.throws(
    () => assertAuditMutationAllowed({ operation: "UPDATE", dbRole: "superuser" }),
    /trigger guard/,
  );
  assert.throws(
    () => assertAuditMutationAllowed({ operation: "TRUNCATE", dbRole: "superuser" }),
    /trigger guard/,
  );
});

test("Information Blocking denial map classifies v0.5b denial reasons", () => {
  assert.equal(informationBlockingExceptionForDenial("access-policy-compartment-isolation"), "privacy");
  assert.equal(informationBlockingExceptionForDenial("break-glass-expired"), "security");
  assert.equal(informationBlockingExceptionForDenial("rate-limit"), "health-IT-performance");
});

test("audit UI model is auditor/practice-admin gated and exports OCR query rows as CSV and JSON", () => {
  const rows = sampleAuditRows();
  const filtered = filterAuditLogRows(rows, {
    patientId: "patient-x",
    from: "2026-01-30T00:00:00.000Z",
    to: "2026-04-29T23:59:59.999Z",
    eventTypes: [],
    breakGlassOnly: false,
  });

  assert.equal(canReviewAuditLog("auditor"), true);
  assert.equal(canReviewAuditLog("practice-admin"), true);
  assert.equal(canReviewAuditLog("clinician"), false);
  assert.equal(canReviewAuditLog("aesthetics-provider"), false);
  assert.equal(canReviewAuditLog("unknown"), false);
  assert.match(exportAuditRowsAsCsv(filtered), /eventTime,eventType,actorId/);
  assert.match(exportAuditRowsAsCsv(filtered), /denied/);
  assert.match(exportAuditRowsAsJson(filtered), /"ibException": "privacy"/);
});

test("restore integrity suite passes all five v0.5b post-restore checks", () => {
  const row = buildOsodAuditEventRow({
    eventType: "read",
    eventTime: "2026-04-29T12:00:00.000Z",
    patientId: "patient-x",
    actionOutcome: "granted",
  });
  const result = verifyRestoreIntegrity({
    manifestAuditSnapshot: {
      count: 1,
      latestEventTime: "2026-04-29T12:00:00.000Z",
      projectionQueueDrained: true,
    },
    restoredAuditRows: [row],
    provenanceSamples: [
      {
        resourceType: "Provenance",
        target: [{ reference: "Observation/obs-1" }],
        recorded: "2026-04-29T12:00:00.000Z",
        agent: [{ who: { display: "OSOD" } }],
        signature: [{ type: [{ system: "urn:iso-astm:E1762-95:2013", code: "1.2.840.10065.1.12.1.5" }], when: "2026-04-29T12:00:00.000Z", who: { reference: "Practitioner/doctor-1" }, data: "c2ln" }],
      },
    ],
    restoredBinaries: [
      { resourceType: "Binary", contentType: "image/jpeg", securityContext: { reference: "Patient/patient-x" } },
    ],
    auditEvents: [buildAuditEventProjection(row)],
    accessPolicyRoundTripPassed: true,
  });

  assert.equal(result.passed, true);
  assert.equal(result.checks.length, 5);
});

function seedNinetyDays(patientId: string) {
  return [
    buildOsodAuditEventRow({
      eventType: "read",
      eventTime: "2026-04-28T12:00:00.000Z",
      actorId: "doctor-1",
      actorRole: "clinician",
      patientId,
      resourceType: "Patient",
      resourceId: patientId,
      actionOutcome: "granted",
      policyUrl: "AccessPolicy/osod-clinician",
    }),
    buildOsodAuditEventRow({
      eventType: "search",
      eventTime: "2026-04-20T12:00:00.000Z",
      actorId: "front-1",
      actorRole: "front-desk",
      patientId,
      resourceType: "Encounter",
      actionOutcome: "granted",
      policyUrl: "AccessPolicy/osod-front-desk",
    }),
    buildOsodAuditEventRow({
      eventType: "update",
      eventTime: "2026-04-05T12:00:00.000Z",
      actorId: "doctor-1",
      actorRole: "clinician",
      patientId,
      resourceType: "Observation",
      resourceId: "obs-1",
      actionOutcome: "granted",
      provenanceId: "Provenance/prov-1",
    }),
    buildOsodAuditEventRow({
      eventType: "denied",
      eventTime: "2026-03-15T12:00:00.000Z",
      actorId: "doctor-2",
      actorRole: "clinician",
      patientId,
      resourceType: "Patient",
      resourceId: patientId,
      actionOutcome: "denied",
      actionReason: "access-policy-compartment-isolation",
    }),
    buildOsodAuditEventRow({
      eventType: "break-glass-invoked",
      eventTime: "2026-02-10T12:00:00.000Z",
      actorId: "doctor-3",
      actorRole: "clinician",
      patientId,
      resourceType: "Encounter",
      resourceId: "enc-emergency",
      actionOutcome: "granted",
      breakGlass: true,
      breakGlassReason: "Emergency care.",
    }),
    buildOsodAuditEventRow({
      eventType: "read",
      eventTime: "2025-12-01T12:00:00.000Z",
      actorId: "doctor-1",
      actorRole: "clinician",
      patientId,
      actionOutcome: "granted",
    }),
  ];
}
