import assert from "node:assert/strict";
import { test } from "node:test";
import { buildAuditEventProjection, buildOdosAuditEventRow } from "../src/authz/odosAudit.js";

for (const eventType of [
  "guarantor.link.started", "guarantor.link.completed", "guarantor.link.pending",
  "guarantor.link.failed", "guarantor.link.interfered",
] as const) {
  test(`S9: ${eventType} produces a patient-attributed audit row and projection`, () => {
    const row = buildOdosAuditEventRow({
      eventType, actorId: "staff", actorRole: "staff", patientId: "patient",
      targetReference: "Task/operation", actionOutcome: "granted",
      actionReason: "transfer Task/operation Person/source Person/destination project RelatedPerson/child",
    });
    assert.equal(row.eventType, eventType);
    assert.equal(row.patientId, "patient");
    assert.equal(row.resourceType, "Task");
    assert.equal(row.resourceId, "operation");
    const projected = buildAuditEventProjection(row);
    assert.equal(projected.type.code, eventType);
    assert.equal(projected.entity?.some(({ what }) => what?.reference === "Patient/patient"), true);
  });
}
