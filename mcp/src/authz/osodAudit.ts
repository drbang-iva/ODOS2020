import { randomUUID } from "node:crypto";
import type { AuditEvent } from "@medplum/fhirtypes";
import type { PracticeRoleId } from "./roles.js";

export type OsodAuditOutcome = "success" | "denied" | "error";

export type OsodAuditEventType =
  | "membership.invited"
  | "membership.activated"
  | "membership.deactivated"
  | "membership.terminated"
  | "membership.role-review"
  | "break-glass.granted"
  | "break-glass.expired"
  | "access.denied";

export interface OsodAuditEventRow {
  id: string;
  eventType: OsodAuditEventType;
  occurredAt: string;
  actorReference?: string;
  actorDisplay?: string;
  actorRole?: PracticeRoleId;
  targetReference?: string;
  patientReference?: string;
  outcome: OsodAuditOutcome;
  outcomeDescription?: string;
  policyUrl?: string;
  reason?: string;
  adminReviewRequired?: boolean;
  details?: Record<string, string | number | boolean | undefined>;
}

export const OSOD_AUDIT_EVENTS_SCHEMA_STUB = {
  tableName: "osod_audit_events",
  appendOnly: true,
  columns: [
    "id",
    "event_type",
    "occurred_at",
    "actor_reference",
    "actor_display",
    "actor_role",
    "target_reference",
    "patient_reference",
    "outcome",
    "outcome_description",
    "policy_url",
    "reason",
    "admin_review_required",
    "details_json",
  ],
} as const;

export function buildOsodAuditEventRow(
  input: Omit<OsodAuditEventRow, "id" | "occurredAt"> & { occurredAt?: string },
): OsodAuditEventRow {
  return {
    id: randomUUID(),
    occurredAt: input.occurredAt ?? new Date().toISOString(),
    ...input,
  };
}

export function buildPlaceholderAuditEvent(row: OsodAuditEventRow): AuditEvent {
  return {
    resourceType: "AuditEvent",
    type: {
      code: row.eventType,
      display: `OSOD ${row.eventType}`,
    },
    action: auditAction(row.eventType),
    recorded: row.occurredAt,
    outcome: auditOutcome(row.outcome),
    ...(row.outcomeDescription ? { outcomeDesc: row.outcomeDescription } : {}),
    agent: [
      {
        role: row.actorRole
          ? [
              {
                text: row.actorRole,
                coding: [{ code: row.actorRole, display: row.actorRole }],
              },
            ]
          : undefined,
        ...(row.actorReference ? { who: { reference: row.actorReference } } : {}),
        ...(row.actorDisplay ? { name: row.actorDisplay } : {}),
        requestor: true,
        ...(row.policyUrl ? { policy: [row.policyUrl] } : {}),
      },
    ],
    source: {
      observer: { display: "OSOD v0.5a audit projector stub" },
    },
    entity: [
      ...(row.targetReference
        ? [{ what: { reference: row.targetReference }, name: "target" }]
        : []),
      ...(row.patientReference
        ? [{ what: { reference: row.patientReference }, name: "patient" }]
        : []),
      ...(row.reason
        ? [{ name: "reason", detail: [{ type: "reason", valueString: row.reason }] }]
        : []),
      ...(row.adminReviewRequired !== undefined
        ? [
            {
              name: "admin-review",
              detail: [
                { type: "adminReviewRequired", valueString: String(row.adminReviewRequired) },
              ],
            },
          ]
        : []),
    ],
  };
}

function auditAction(eventType: OsodAuditEventType): AuditEvent["action"] {
  if (eventType === "membership.invited") {
    return "C";
  }
  if (eventType === "membership.role-review") {
    return "R";
  }
  return "U";
}

function auditOutcome(outcome: OsodAuditOutcome): AuditEvent["outcome"] {
  if (outcome === "success") {
    return "0";
  }
  if (outcome === "denied") {
    return "4";
  }
  return "8";
}
