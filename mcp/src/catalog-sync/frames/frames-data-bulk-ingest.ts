import { basename } from "node:path";
import type { AuditEvent, ChargeItemDefinition, DeviceDefinition, Provenance, Task } from "@medplum/fhirtypes";
import { buildAuditEventProjection, buildOsodAuditEventRow } from "../../authz/osodAudit.js";
import { buildFrameChargeItemDefinition } from "../../catalog/frame-charge-item-definition.js";
import { buildFrameDeviceDefinition } from "../../catalog/frame-device-definition.js";
import {
  OSOD_FHIR_SOURCE_HEADER,
  fhirAttachmentSha1Base64,
  frameCanonicalUrl,
  materialChange,
  type FrameCatalogRow,
  type FrameVendorRecord,
} from "../../catalog/frame-types.js";
import {
  parseFrameCatalogRowsFromFile,
  type FramesDataFileFormat,
} from "./parsers/frame-file-parser.js";
import { installFramesDataNoEgressGuard } from "./no-egress-guard.js";

export interface FramesBulkIngestInput {
  readonly practiceId: string;
  readonly uploadedFilePath: string;
  readonly fileFormat: FramesDataFileFormat;
}

export interface SyncRunRecord {
  readonly id: string;
  readonly syncRunTimestamp: string;
}

export interface FramesBulkIngestContext {
  readonly now?: () => Date;
  readonly openSyncRun: (input: {
    readonly practiceId: string;
    readonly catalogType: "frames";
    readonly sourceUrl: string;
    readonly accessDate: string;
    readonly syncMode: "bulk";
    readonly syncRunTimestamp: string;
  }) => Promise<SyncRunRecord>;
  readonly findActiveFrameBySku: (skuId: string) => Promise<FrameCatalogRow | null>;
  readonly retireFrameCatalogRow: (input: {
    readonly rowId: string;
    readonly retiredAt: string;
    readonly syncRunId: string;
    readonly auditEventId: string;
  }) => Promise<void>;
  readonly insertFrameCatalogRow: (row: FrameCatalogRow & {
    readonly syncRunId: string;
    readonly auditEventId: string;
    readonly effectiveFrom: string;
  }) => Promise<void>;
  readonly closeSyncRun: (input: {
    readonly syncRunId: string;
    readonly outcome: "success" | "failure" | "partial";
    readonly rowsInserted: number;
    readonly rowsRetired: number;
    readonly sourceVersion: string;
    readonly auditEventId: string;
    readonly errorSummary?: string;
  }) => Promise<void>;
  readonly writeFhirResource?: (
    resource: Task | DeviceDefinition | ChargeItemDefinition | AuditEvent | Provenance,
    headers: Record<string, string>,
  ) => Promise<void>;
}

export interface FramesBulkIngestResult {
  readonly syncRunId: string;
  readonly outcome: "success" | "failure" | "partial";
  readonly rowsInserted: number;
  readonly rowsRetired: number;
  readonly sqlMutations: number;
  readonly fhirResourcesCreated: number;
  readonly taskCreated: number;
  readonly auditEventsCreated: number;
  readonly provenanceCreated: number;
  readonly attributionArtifacts: number;
  readonly syncRunTimestamp: string;
  readonly sourceUrl: string;
  readonly sourceVersion: string;
  readonly cursorHighWater: null;
}

export async function runFramesBulkIngest(
  input: FramesBulkIngestInput,
  context: FramesBulkIngestContext,
): Promise<FramesBulkIngestResult> {
  installFramesDataNoEgressGuard();
  const now = context.now?.() ?? new Date();
  const syncRunTimestamp = now.toISOString();
  const filename = basename(input.uploadedFilePath);
  const sourceUrl = `operator-upload://${filename}`;
  const sourceVersion = `operator-upload:${filename}`;
  const accessDate = syncRunTimestamp.slice(0, 10);
  const syncRun = await context.openSyncRun({
    practiceId: input.practiceId,
    catalogType: "frames",
    sourceUrl,
    accessDate,
    syncMode: "bulk",
    syncRunTimestamp,
  });
  const task = buildIngestTask(syncRun.id, input.practiceId, sourceUrl, syncRunTimestamp);
  await writeFhir(context, task);

  let rowsInserted = 0;
  let rowsRetired = 0;
  let sqlMutations = 0;
  let fhirResourcesCreated = 0;
  let auditEventsCreated = 0;
  let provenanceCreated = 0;

  try {
    for await (const vendorRecord of parseFrameCatalogRowsFromFile({
      filePath: input.uploadedFilePath,
      fileFormat: input.fileFormat,
      sourceVersion,
      sourceUrl,
      accessDate,
    })) {
      const nextRow = toCatalogRow(vendorRecord, sourceVersion, sourceUrl, accessDate);
      const existing = await context.findActiveFrameBySku(nextRow.skuId);

      if (existing && nextRow.status === "discontinued") {
        const auditEventId = syntheticAuditEventId("catalog_sync.frames.bulk.retired", existing.skuId, syncRunTimestamp);
        await context.retireFrameCatalogRow({
          rowId: requireRowId(existing),
          retiredAt: syncRun.syncRunTimestamp,
          syncRunId: syncRun.id,
          auditEventId,
        });
        rowsRetired += 1;
        sqlMutations += 1;
        const resources = buildPerMutationFhirArtifacts(existing, input.practiceId, syncRunTimestamp, "catalog_sync.frames.bulk.retired");
        fhirResourcesCreated += 2;
        auditEventsCreated += 2;
        provenanceCreated += 2;
        for (const resource of resources) {
          await writeFhir(context, resource);
        }
        continue;
      }

      const changed = existing ? materialChange(existing, nextRow) : true;
      if (!changed) {
        continue;
      }

      if (existing) {
        const auditEventId = syntheticAuditEventId("catalog_sync.frames.bulk.retired", existing.skuId, syncRunTimestamp);
        await context.retireFrameCatalogRow({
          rowId: requireRowId(existing),
          retiredAt: syncRun.syncRunTimestamp,
          syncRunId: syncRun.id,
          auditEventId,
        });
        rowsRetired += 1;
        sqlMutations += 1;
        const resources = buildPerMutationFhirArtifacts(existing, input.practiceId, syncRunTimestamp, "catalog_sync.frames.bulk.retired");
        fhirResourcesCreated += 2;
        auditEventsCreated += 2;
        provenanceCreated += 2;
        for (const resource of resources) {
          await writeFhir(context, resource);
        }
      }

      const insertAuditEventId = syntheticAuditEventId("catalog_sync.frames.bulk.upserted", nextRow.skuId, syncRunTimestamp);
      await context.insertFrameCatalogRow({
        ...nextRow,
        syncRunId: syncRun.id,
        auditEventId: insertAuditEventId,
        effectiveFrom: syncRun.syncRunTimestamp,
      });
      rowsInserted += 1;
      sqlMutations += 1;

      const resources = buildPerMutationFhirArtifacts(nextRow, input.practiceId, syncRunTimestamp, "catalog_sync.frames.bulk.upserted");
      fhirResourcesCreated += 2;
      auditEventsCreated += 2;
      provenanceCreated += 2;
      for (const resource of resources) {
        await writeFhir(context, resource);
      }
    }

    const runAuditEventId = await emitRunAudit(context, "catalog_sync.frames.run.success", syncRun.id, syncRunTimestamp);
    const runProvenance = buildRunProvenance(syncRun.id, syncRunTimestamp);
    await writeFhir(context, runProvenance);
    provenanceCreated += 1;
    auditEventsCreated += 1;
    await context.closeSyncRun({
      syncRunId: syncRun.id,
      outcome: "success",
      rowsInserted,
      rowsRetired,
      sourceVersion,
      auditEventId: runAuditEventId,
    });
    return {
      syncRunId: syncRun.id,
      outcome: "success",
      rowsInserted,
      rowsRetired,
      sqlMutations,
      fhirResourcesCreated,
      taskCreated: 1,
      auditEventsCreated,
      provenanceCreated,
      attributionArtifacts: 1 + fhirResourcesCreated + fhirResourcesCreated + 1 + 1,
      syncRunTimestamp,
      sourceUrl,
      sourceVersion,
      cursorHighWater: null,
    };
  } catch (error) {
    const runAuditEventId = await emitRunAudit(context, "catalog_sync.frames.run.failure", syncRun.id, syncRunTimestamp, String(error));
    await context.closeSyncRun({
      syncRunId: syncRun.id,
      outcome: "failure",
      rowsInserted,
      rowsRetired,
      sourceVersion,
      auditEventId: runAuditEventId,
      errorSummary: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

function toCatalogRow(
  vendorRecord: FrameVendorRecord,
  sourceVersion: string,
  sourceUrl: string,
  accessDate: string,
): FrameCatalogRow {
  return {
    id: vendorRecord.id,
    skuId: vendorRecord.skuId,
    brandId: vendorRecord.brandId ?? "unknown",
    brandName: vendorRecord.brandName ?? "Unknown brand",
    manufacturerId: vendorRecord.manufacturerId ?? "unknown",
    manufacturerName: vendorRecord.manufacturerName ?? "Unknown manufacturer",
    modelName: vendorRecord.modelName ?? "Unknown model",
    colorCode: vendorRecord.colorCode ?? "unknown",
    colorName: vendorRecord.colorName ?? "Unknown color",
    sourceColorRaw: vendorRecord.sourceColorRaw ?? vendorRecord.colorName ?? "Unknown color",
    sourceMaterialRaw: vendorRecord.sourceMaterialRaw ?? "Unknown material",
    frameShape: vendorRecord.frameShape ?? null,
    genderCategory: vendorRecord.genderCategory ?? null,
    ageGroup: vendorRecord.ageGroup ?? null,
    colorGroup: vendorRecord.colorGroup ?? null,
    finish: vendorRecord.finish ?? null,
    progressiveCompatible: vendorRecord.progressiveCompatible ?? null,
    minFittingHeightMm: vendorRecord.minFittingHeightMm ?? null,
    eyesizeMm: vendorRecord.eyesizeMm ?? null,
    dblMm: vendorRecord.dblMm ?? null,
    templeMm: vendorRecord.templeMm ?? null,
    bMm: vendorRecord.bMm ?? null,
    edMm: vendorRecord.edMm ?? null,
    weightGrams: vendorRecord.weightGrams ?? null,
    materialCode: vendorRecord.materialCode ?? null,
    countryOfOrigin: vendorRecord.countryOfOrigin ?? null,
    msrpCents: vendorRecord.msrpCents ?? null,
    labCostCents: vendorRecord.labCostCents ?? null,
    gtin14: vendorRecord.gtin14 ?? null,
    itemNumber: vendorRecord.itemNumber ?? null,
    publicityClass: vendorRecord.publicityClass ?? "staff_only",
    status: vendorRecord.status ?? "active",
    sourceVersion,
    sourceUrl,
    accessDate,
  };
}

function buildIngestTask(syncRunId: string, practiceId: string, sourceUrl: string, timestamp: string): Task {
  return {
    resourceType: "Task",
    id: `frames-bulk-ingest-${syncRunId}`,
    status: "in-progress",
    intent: "order",
    authoredOn: timestamp,
    description: `Frames catalog bulk ingest for practice ${practiceId}`,
    input: [
      {
        type: { text: "source" },
        valueAttachment: {
          url: sourceUrl,
          hash: fhirAttachmentSha1Base64(sourceUrl),
        },
      },
    ],
  };
}

function buildPerMutationFhirArtifacts(
  row: FrameCatalogRow,
  practiceId: string,
  timestamp: string,
  eventType: "catalog_sync.frames.bulk.upserted" | "catalog_sync.frames.bulk.retired",
): Array<DeviceDefinition | ChargeItemDefinition | AuditEvent | Provenance> {
  const deviceDefinition = buildFrameDeviceDefinition({ catalogRow: row });
  const chargeItemDefinition = buildFrameChargeItemDefinition({
    practiceId,
    catalogCanonicalUrl: frameCanonicalUrl(row.skuId),
    practiceSalePriceCents: row.msrpCents ?? 0,
    hcpcsBaseCode: "V2020",
  });
  if (eventType === "catalog_sync.frames.bulk.retired") {
    chargeItemDefinition.status = "retired";
  }
  return [
    deviceDefinition,
    buildFhirResourceAudit(eventType, deviceDefinition.url ?? frameCanonicalUrl(row.skuId), timestamp),
    buildProvenance(deviceDefinition.url ?? frameCanonicalUrl(row.skuId), timestamp),
    chargeItemDefinition,
    buildFhirResourceAudit(eventType, chargeItemDefinition.url, timestamp),
    buildProvenance(chargeItemDefinition.url, timestamp),
  ];
}

function buildFhirResourceAudit(
  eventType: "catalog_sync.frames.bulk.upserted" | "catalog_sync.frames.bulk.retired",
  canonicalUrl: string,
  timestamp: string,
): AuditEvent {
  return buildAuditEventProjection(
    buildOsodAuditEventRow({
      eventType,
      eventTime: timestamp,
      actorRole: "system",
      resourceType: "Canonical",
      resourceId: canonicalUrl,
      actionReason: OSOD_FHIR_SOURCE_HEADER,
    }),
  );
}

function buildProvenance(canonicalUrl: string, timestamp: string): Provenance {
  return {
    resourceType: "Provenance",
    recorded: timestamp,
    target: [{ reference: canonicalUrl }],
    agent: [{ who: { reference: "Device/osod-catalog-sync" } }],
  };
}

function buildRunProvenance(syncRunId: string, timestamp: string): Provenance {
  return {
    resourceType: "Provenance",
    recorded: timestamp,
    target: [{ reference: `Task/frames-bulk-ingest-${syncRunId}` }],
    agent: [{ who: { reference: "Device/osod-catalog-sync" } }],
  };
}

function syntheticAuditEventId(
  eventType: "catalog_sync.frames.bulk.upserted" | "catalog_sync.frames.bulk.retired",
  skuId: string,
  timestamp: string,
): string {
  const row = buildOsodAuditEventRow({
    eventType,
    eventTime: timestamp,
    actorRole: "system",
    resourceType: "DeviceDefinition",
    resourceId: frameCanonicalUrl(skuId),
    actionReason: OSOD_FHIR_SOURCE_HEADER,
  });
  return row.id;
}

async function emitRunAudit(
  context: FramesBulkIngestContext,
  eventType: "catalog_sync.frames.run.success" | "catalog_sync.frames.run.failure",
  syncRunId: string,
  timestamp: string,
  reason?: string,
): Promise<string> {
  const row = buildOsodAuditEventRow({
    eventType,
    eventTime: timestamp,
    actorRole: "system",
    resourceType: "osod_catalog_sync_runs",
    resourceId: syncRunId,
    actionReason: reason ?? OSOD_FHIR_SOURCE_HEADER,
  });
  await writeFhir(context, buildAuditEventProjection(row));
  return row.id;
}

async function writeFhir(
  context: FramesBulkIngestContext,
  resource: Task | DeviceDefinition | ChargeItemDefinition | AuditEvent | Provenance,
): Promise<void> {
  await context.writeFhirResource?.(resource, { "X-OSOD-Source": OSOD_FHIR_SOURCE_HEADER });
}

function requireRowId(row: FrameCatalogRow): string {
  if (!row.id) {
    throw new Error(`active frame row ${row.skuId} is missing id required for SCD retirement`);
  }
  return row.id;
}
