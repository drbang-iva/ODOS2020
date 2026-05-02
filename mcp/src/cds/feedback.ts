import { randomUUID } from "node:crypto";
import { buildOsodAuditEventRow, type OsodAuditEventRow } from "../authz/osodAudit.js";
import { CDS_SERVICE_REGISTRY_POLICY_URL, type CdsFeedbackItem, type CdsFeedbackRequest } from "./types.js";

export interface PersistedCdsFeedback {
  readonly feedbackId: string;
  readonly serviceId: string;
  readonly cardInstanceUuid: string;
  readonly userId: string;
  readonly patientId?: string;
  readonly encounterId?: string;
  readonly outcome: "accepted" | "overridden";
  readonly acceptedSuggestionUuids: readonly string[];
  readonly overrideReasonCode?: string;
  readonly overrideReasonSystem?: string;
  readonly overrideUserComment?: string;
  readonly outcomeTimestamp: string;
  readonly createdAt: string;
}

export interface CdsFeedbackRepository {
  save(record: PersistedCdsFeedback): Promise<PersistedCdsFeedback>;
  list(): Promise<readonly PersistedCdsFeedback[]>;
}

export class InMemoryCdsFeedbackRepository implements CdsFeedbackRepository {
  readonly rows: PersistedCdsFeedback[] = [];

  async save(record: PersistedCdsFeedback): Promise<PersistedCdsFeedback> {
    this.rows.push(record);
    return record;
  }

  async list(): Promise<readonly PersistedCdsFeedback[]> {
    return this.rows;
  }
}

export function parseCdsFeedbackRequest(input: unknown): CdsFeedbackRequest {
  if (!isRecord(input) || !Array.isArray(input.feedback)) {
    throw new Error("invalid_request: feedback array is required");
  }
  return {
    feedback: input.feedback.map(parseFeedbackItem),
  };
}

export async function persistCdsFeedback(input: {
  readonly request: CdsFeedbackRequest;
  readonly repository: CdsFeedbackRepository;
  readonly serviceId: string;
  readonly userId: string;
  readonly patientId?: string;
  readonly encounterId?: string;
  readonly now?: Date;
}): Promise<{ readonly rows: readonly PersistedCdsFeedback[]; readonly auditEvents: readonly OsodAuditEventRow[] }> {
  const now = input.now ?? new Date();
  const rows: PersistedCdsFeedback[] = [];
  const auditEvents: OsodAuditEventRow[] = [];
  for (const item of input.request.feedback) {
    const reason = reasonCoding(item);
    const row: PersistedCdsFeedback = {
      feedbackId: randomUUID(),
      serviceId: input.serviceId,
      cardInstanceUuid: item.card,
      userId: input.userId,
      patientId: input.patientId,
      encounterId: input.encounterId,
      outcome: item.outcome,
      acceptedSuggestionUuids: item.acceptedSuggestions ?? [],
      overrideReasonCode: reason?.code,
      overrideReasonSystem: reason?.system,
      overrideUserComment: item.overrideReason?.userComment,
      outcomeTimestamp: item.outcomeTimestamp,
      createdAt: now.toISOString(),
    };
    rows.push(await input.repository.save(row));
    auditEvents.push(
      buildOsodAuditEventRow({
        eventType: item.outcome === "accepted" ? "cds.feedback.accepted" : "cds.feedback.overridden",
        eventTime: now.toISOString(),
        actorId: input.userId,
        actorRole: "clinician",
        patientId: input.patientId,
        resourceType: "osod_cds_feedback",
        resourceId: row.feedbackId,
        policyUrl: CDS_SERVICE_REGISTRY_POLICY_URL,
        actionReason: `CDS feedback ${item.outcome} for card ${item.card}.`,
      }),
    );
  }
  return { rows, auditEvents };
}

function parseFeedbackItem(input: unknown): CdsFeedbackItem {
  if (!isRecord(input)) {
    throw new Error("invalid_request: feedback item must be an object");
  }
  const card = requiredString(input.card, "card");
  const outcome = requiredString(input.outcome, "outcome");
  if (outcome !== "accepted" && outcome !== "overridden") {
    throw new Error("invalid_request: outcome must be accepted or overridden");
  }
  const outcomeTimestamp = requiredString(input.outcomeTimestamp, "outcomeTimestamp");
  return {
    card,
    outcome,
    acceptedSuggestions: Array.isArray(input.acceptedSuggestions)
      ? input.acceptedSuggestions.filter((value): value is string => typeof value === "string")
      : undefined,
    overrideReason: isRecord(input.overrideReason) ? input.overrideReason : undefined,
    outcomeTimestamp,
  };
}

function reasonCoding(item: CdsFeedbackItem): { readonly code?: string; readonly system?: string } | undefined {
  const reason = item.overrideReason?.reason;
  if (!reason) {
    return undefined;
  }
  if ("coding" in reason && Array.isArray(reason.coding)) {
    const coding = reason.coding.find((candidate) => candidate.code || candidate.system);
    return { code: coding?.code, system: coding?.system };
  }
  if ("code" in reason || "system" in reason) {
    return { code: reason.code, system: reason.system };
  }
  return undefined;
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`invalid_request: ${field} is required`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
