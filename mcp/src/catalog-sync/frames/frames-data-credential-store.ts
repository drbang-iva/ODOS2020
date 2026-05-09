import type { Provenance } from "@medplum/fhirtypes";
import { buildAuditEventProjection, buildOsodAuditEventRow, type OsodAuditEventRecord } from "../../authz/osodAudit.js";

export interface FramesDataSubscriptionConfig {
  readonly practiceId: string;
  readonly framesDataUsername: string;
  readonly subscriptionActive: boolean;
  readonly lastIngestAt: string | null;
  readonly lastIngestSourceFile: string | null;
}

export interface SaveFramesDataSubscriptionInput {
  readonly practiceId: string;
  readonly framesDataUsername: string;
  readonly subscriptionActive: boolean;
  readonly actorId: string;
  readonly now?: string;
}

export interface FramesDataSubscriptionSaveResult {
  readonly config: FramesDataSubscriptionConfig;
  readonly auditRow: OsodAuditEventRecord;
  readonly auditEvent: ReturnType<typeof buildAuditEventProjection>;
  readonly provenance: Provenance;
}

export class InMemoryFramesDataSubscriptionStore {
  private readonly configs = new Map<string, FramesDataSubscriptionConfig>();

  get(practiceId: string): FramesDataSubscriptionConfig | undefined {
    return this.configs.get(practiceId);
  }

  save(input: SaveFramesDataSubscriptionInput): FramesDataSubscriptionSaveResult {
    const previous = this.configs.get(input.practiceId);
    const now = input.now ?? new Date().toISOString();
    const config: FramesDataSubscriptionConfig = {
      practiceId: input.practiceId,
      framesDataUsername: input.framesDataUsername,
      subscriptionActive: input.subscriptionActive,
      lastIngestAt: previous?.lastIngestAt ?? null,
      lastIngestSourceFile: previous?.lastIngestSourceFile ?? null,
    };
    this.configs.set(input.practiceId, config);
    const auditRow = buildOsodAuditEventRow({
      eventType: "practice.frames-data-subscription.toggled",
      eventTime: now,
      actorId: input.actorId,
      actorRole: "practice-admin",
      resourceType: "FramesDataSubscriptionConfig",
      resourceId: input.practiceId,
      actionReason: `Frames Data subscription ${input.subscriptionActive ? "active" : "inactive"}`,
    });
    return {
      config,
      auditRow,
      auditEvent: buildAuditEventProjection(auditRow),
      provenance: {
        resourceType: "Provenance",
        recorded: now,
        target: [{ reference: `Basic/frames-data-subscription-${input.practiceId}` }],
        agent: [{ who: { reference: `Practitioner/${input.actorId}` } }],
      },
    };
  }

  markIngest(practiceId: string, lastIngestAt: string, lastIngestSourceFile: string): void {
    const previous = this.configs.get(practiceId);
    if (!previous) {
      throw new Error(`Frames Data subscription config not found for practice ${practiceId}`);
    }
    this.configs.set(practiceId, { ...previous, lastIngestAt, lastIngestSourceFile });
  }
}
