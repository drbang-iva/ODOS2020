import { buildAuditEventProjection, buildOsodAuditEventRow } from "../../authz/osodAudit.js";
import { streamTextLines } from "../frames/parsers/stream-lines.js";

export interface HcpcsTerminologyRow {
  readonly code: string;
  readonly display: string;
  readonly description: string | null;
  readonly category: string | null;
  readonly active: boolean;
  readonly effectiveFrom: string;
  readonly effectiveTo: string | null;
  readonly metadata: Record<string, unknown>;
  readonly version: string;
  readonly sourceVersion: string;
  readonly auditEventId: string;
}

export const FRAME_LATERALITY_EXEMPT_HCPCS = ["V2020", "V2025", "V2600"] as const;

export async function* parseHcpcsCsv(
  filePath: string,
  version: string,
  sourceVersion: string,
  effectiveFrom: string,
): AsyncGenerator<HcpcsTerminologyRow> {
  let headers: string[] | undefined;
  for await (const line of streamTextLines(filePath)) {
    if (!line.trim()) continue;
    const cells = line.split(",").map((cell) => cell.trim().replace(/^"|"$/g, ""));
    if (!headers) {
      headers = cells.map((cell) => cell.toLowerCase().replace(/[^a-z0-9]+(.)?/g, (_, char: string | undefined) => char?.toUpperCase() ?? ""));
      continue;
    }
    const row: Record<string, string> = {};
    headers.forEach((header, index) => {
      row[header] = cells[index] ?? "";
    });
    const code = row.code ?? row.hcpcs ?? row.hcpcsCode;
    if (!code) {
      throw new Error("HCPCS parser: missing code column");
    }
    const auditRow = buildOsodAuditEventRow({
      eventType: "catalog_sync.hcpcs.delta.upserted",
      actorRole: "system",
      resourceType: "osod_terminology_hcpcs",
      resourceId: code,
      actionReason: "HCPCS quarterly terminology sync",
    });
    yield {
      code,
      display: row.display ?? row.shortDescription ?? code,
      description: row.description || null,
      category: code.startsWith("V") ? "Vision Services" : null,
      active: row.active ? row.active.toLowerCase() !== "false" : true,
      effectiveFrom,
      effectiveTo: null,
      metadata: {
        laterality_exempt: FRAME_LATERALITY_EXEMPT_HCPCS.includes(code as typeof FRAME_LATERALITY_EXEMPT_HCPCS[number]),
      },
      version,
      sourceVersion,
      auditEventId: buildAuditEventProjection(auditRow).id ?? auditRow.id,
    };
  }
}

export function seedFrameHcpcsRows(version: string, sourceVersion: string, effectiveFrom: string): HcpcsTerminologyRow[] {
  return FRAME_LATERALITY_EXEMPT_HCPCS.map((code) => {
    const auditRow = buildOsodAuditEventRow({
      eventType: "catalog_sync.hcpcs.delta.upserted",
      actorRole: "system",
      resourceType: "osod_terminology_hcpcs",
      resourceId: code,
      actionReason: "Seed HCPCS laterality exemption metadata from v0.6 ledger row 8",
    });
    return {
      code,
      display: code,
      description: null,
      category: "Vision Services",
      active: true,
      effectiveFrom,
      effectiveTo: null,
      metadata: { laterality_exempt: true },
      version,
      sourceVersion,
      auditEventId: buildAuditEventProjection(auditRow).id ?? auditRow.id,
    };
  });
}
