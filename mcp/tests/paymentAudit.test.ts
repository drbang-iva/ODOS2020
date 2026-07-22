import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";
import { ODOS_AUDIT_EVENT_TYPES, buildAuditEventProjection } from "../src/authz/odosAudit.js";
import {
  PAYMENT_AUDIT_EVENT_TYPES,
  buildPaymentAuditRecord,
} from "../src/payments/payment-audit.js";

test("the 10 payment.* audit event types are registered — count and enumeration match (v0.55c Lesson 10)", () => {
  const expected = [
    "payment.charge.attempted",
    "payment.charge.completed",
    "payment.charge.failed",
    "payment.refund.attempted",
    "payment.refund.completed",
    "payment.void.attempted",
    "payment.credit.applied",
    "payment.settle.batch",
    "payment.financing.preauthorized",
    "payment.financing.declined",
  ];
  assert.equal(PAYMENT_AUDIT_EVENT_TYPES.length, 10);
  assert.deepEqual([...PAYMENT_AUDIT_EVENT_TYPES], expected);
  // and the registry carries exactly this payment.* family — no drift in either direction
  assert.deepEqual(
    ODOS_AUDIT_EVENT_TYPES.filter((t) => t.startsWith("payment.")),
    expected,
  );
});

test("the latest audit migration pair matches the TypeScript union and separates validation", () => {
  const migrationFile = "2026-07-22-era-integrity-event.sql";
  const validationFile = "2026-07-22-era-integrity-event.validate.sql";
  const sql = readFileSync(
    resolve(process.cwd(), "../data/migrations", migrationFile),
    "utf8",
  );
  const validationSql = readFileSync(
    resolve(process.cwd(), "../data/migrations", validationFile),
    "utf8",
  );
  const dropIndex = sql.indexOf("DROP CONSTRAINT IF EXISTS odos_audit_events_event_type_check");
  const addIndex = sql.indexOf("ADD CONSTRAINT odos_audit_events_event_type_check CHECK");
  assert.ok(dropIndex >= 0);
  assert.ok(addIndex > dropIndex);
  const sqlTypes = [...sql.matchAll(/'([^']+)'/g)].map((match) => match[1]);
  assert.deepEqual(sqlTypes, [...ODOS_AUDIT_EVENT_TYPES]);
  assert.doesNotMatch(sql, /VALIDATE CONSTRAINT/);
  assert.match(validationSql, /VALIDATE CONSTRAINT odos_audit_events_event_type_check/);
  const liveAuditSource = readFileSync(resolve(process.cwd(), "src/authz/liveAudit.ts"), "utf8");
  assert.match(liveAuditSource, new RegExp(`AUDIT_DDL_FILES[\\s\\S]*${migrationFile.replaceAll(".", "\\.")}`));
  assert.match(liveAuditSource, new RegExp(`${migrationFile.replaceAll(".", "\\.")}[\\s\\S]*${validationFile.replaceAll(".", "\\.")}`));
  assert.ok(migrationFile.localeCompare(validationFile) < 0, "base migration must sort before validation");
});

test("buildPaymentAuditRecord attributes a completed charge to the staff member and the payment record", () => {
  const row = buildPaymentAuditRecord({
    eventType: "payment.charge.completed",
    staffReference: "Practitioner/staff1",
    actorRole: "front-desk",
    patientReference: "Patient/p1",
    paymentRecordReference: "PaymentReconciliation/pr1",
    purpose: "PATIENT_PAYMENT",
    adapterName: "stripe",
    outcome: "success",
    timestamp: "2026-07-05T15:00:00.000Z",
  });

  assert.equal(row.eventType, "payment.charge.completed");
  assert.equal(row.actorId, "staff1");
  assert.equal(row.actorRole, "front-desk");
  assert.equal(row.patientId, "p1");
  assert.equal(row.resourceType, "PaymentReconciliation");
  assert.equal(row.resourceId, "pr1");
  assert.equal(row.actionOutcome, "granted");
  assert.match(row.actionReason ?? "", /PATIENT_PAYMENT/);
  assert.match(row.actionReason ?? "", /stripe/);

  // the FHIR AuditEvent projection points at the payment record
  const auditEvent = buildAuditEventProjection(row);
  assert.equal(auditEvent.resourceType, "AuditEvent");
  assert.ok(
    auditEvent.entity?.some((e) => e.what?.reference === "PaymentReconciliation/pr1"),
    "expected the AuditEvent to reference the PaymentReconciliation",
  );
});

test("a failed charge audits as denied against the Invoice it attempted to settle (no PaymentReconciliation exists)", () => {
  const row = buildPaymentAuditRecord({
    eventType: "payment.charge.failed",
    staffReference: "Practitioner/staff1",
    actorRole: "front-desk",
    patientReference: "Patient/p1",
    paymentRecordReference: "Invoice/inv1",
    purpose: "PATIENT_PAYMENT",
    adapterName: "stripe",
    outcome: "failure",
    declineReason: "card_declined",
    timestamp: "2026-07-05T15:00:00.000Z",
  });

  assert.equal(row.actionOutcome, "denied");
  assert.equal(row.resourceType, "Invoice");
  assert.match(row.actionReason ?? "", /card_declined/);
});

test("a manual cash charge audits against the tendered Invoice (the manual path's payment record)", () => {
  const row = buildPaymentAuditRecord({
    eventType: "payment.charge.completed",
    staffReference: "Practitioner/staff1",
    actorRole: "front-desk",
    patientReference: "Patient/p1",
    paymentRecordReference: "Invoice/inv-cash",
    purpose: "PATIENT_PAYMENT",
    adapterName: "manual-cash",
    outcome: "success",
  });
  assert.equal(row.resourceType, "Invoice");
  assert.equal(row.resourceId, "inv-cash");
  assert.equal(row.actionOutcome, "granted");
});
