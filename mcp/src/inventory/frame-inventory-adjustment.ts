import type { AuditEvent, Basic, Binary, Bundle, Provenance } from "@medplum/fhirtypes";
import { resolveBusinessActionRole } from "../authz/roles.js";
import type { MedplumClient } from "../fhir-client.js";
import type { AuthenticatedStaff, ChargeHandlerResult } from "../payments/payment-charge-handler.js";
import { StaffRoleServiceUnavailableError } from "../payments/payment-endpoint.js";

const BASIC_KIND_SYSTEM = "https://odos2020.com/fhir/CodeSystem/basic-kind";
const AUDIT_EVENT_TYPE_SYSTEM = "https://odos2020.com/fhir/CodeSystem/audit-event-type";
const EXTENSION_URLS = {
  canonicalUrl: "https://odos2020.com/fhir/StructureDefinition/catalog-canonical-url",
  location: "https://odos2020.com/fhir/StructureDefinition/dispensary-location",
  receivedAt: "https://odos2020.com/fhir/StructureDefinition/received-at",
  status: "https://odos2020.com/fhir/StructureDefinition/unit-status",
} as const;
const FRAME_INVENTORY_UNIT_STATUSES = [
  "on_hand",
  "reserved",
  "outbound",
  "at_lab",
  "inbound",
  "hold",
  "dispensed",
] as const;

type FrameInventoryUnitStatus = (typeof FRAME_INVENTORY_UNIT_STATUSES)[number];

export interface FrameInventoryAdjustmentDeps {
  authenticate(authHeader: string | undefined): Promise<AuthenticatedStaff | null>;
  serviceFhir: Pick<MedplumClient, "read" | "executeTransaction">;
  now?: () => string;
}

export async function handleFrameInventoryAdjustmentRequest(
  deps: FrameInventoryAdjustmentDeps,
  input: { authHeader: string | undefined; unitId: string | undefined; body: unknown },
): Promise<ChargeHandlerResult> {
  let staff: AuthenticatedStaff | null;
  try {
    staff = await deps.authenticate(input.authHeader);
  } catch (error) {
    if (error instanceof StaffRoleServiceUnavailableError) {
      return { status: 503, body: { error: "Inventory service temporarily unavailable." } };
    }
    throw error;
  }
  if (!staff) {
    return { status: 401, body: { error: "Authentication required to adjust inventory." } };
  }
  const actorRole = resolveBusinessActionRole(staff.roles ?? [], "inventory.adjust");
  if (!actorRole) {
    return { status: 403, body: { error: "inventory.adjust role required" } };
  }
  staff = { ...staff, actorRole };

  const parsed = adjustmentInput(input.unitId, input.body);
  if ("error" in parsed) {
    return { status: 400, body: { error: parsed.error } };
  }

  try {
    const current = await deps.serviceFhir.read<Basic>("Basic", parsed.unitId);
    const currentStatus = inventoryUnitStatus(current);
    const canonicalUrl = requiredExtension(current, EXTENSION_URLS.canonicalUrl, "catalog URL");
    const receivedAt = requiredExtension(current, EXTENSION_URLS.receivedAt, "received-at");
    const location = optionalExtension(current, EXTENSION_URLS.location);
    const statusIndex = current.extension?.findIndex((entry) => entry.url === EXTENSION_URLS.status) ?? -1;
    if (statusIndex < 0) throw new Error("Frame inventory unit is missing unit status.");
    const now = deps.now?.() ?? new Date().toISOString();
    const target = `Basic/${parsed.unitId}`;
    const auditEvent: AuditEvent = {
      resourceType: "AuditEvent",
      type: { system: AUDIT_EVENT_TYPE_SYSTEM, code: "practice.frame-inventory.adjusted" },
      action: "U",
      recorded: now,
      outcome: "0",
      outcomeDesc: parsed.reason,
      agent: [{ who: { reference: staff.staffReference }, requestor: true }],
      source: { observer: { reference: "Device/odos-core" } },
      entity: [{
        what: { reference: target },
        name: "practice-frame-inventory-unit",
        detail: [
          { type: "prior-status", valueString: currentStatus },
          { type: "corrected-status", valueString: parsed.status },
          { type: "reason", valueString: parsed.reason },
        ],
      }],
    };
    const provenance: Provenance = {
      resourceType: "Provenance",
      recorded: now,
      target: [{ reference: target }],
      agent: [{ who: { reference: staff.staffReference } }],
      reason: [{ text: parsed.reason }],
    };
    const response = await deps.serviceFhir.executeTransaction({
      resourceType: "Bundle",
      type: "transaction",
      entry: [
        {
          resource: jsonPatchBinary(statusIndex, currentStatus, parsed.status),
          request: {
            method: "PATCH",
            url: target,
            ...(current.meta?.versionId ? { ifMatch: `W/\"${current.meta.versionId}\"` } : {}),
          },
        },
        { resource: auditEvent, request: { method: "POST", url: "AuditEvent" } },
        { resource: provenance, request: { method: "POST", url: "Provenance" } },
      ],
    });
    assertTransactionSucceeded(response);
    return {
      status: 200,
      body: {
        unit: {
          id: parsed.unitId,
          canonicalUrl,
          status: parsed.status,
          ...(location ? { location } : {}),
          receivedAt,
        },
      },
    };
  } catch (error) {
    return { status: 400, body: { error: messageOf(error) } };
  }
}

function adjustmentInput(
  unitId: string | undefined,
  body: unknown,
): { unitId: string; status: FrameInventoryUnitStatus; reason: string } | { error: string } {
  if (!unitId || !/^[A-Za-z0-9.-]+$/.test(unitId)) {
    return { error: "A valid frame inventory unit id is required." };
  }
  if (typeof body !== "object" || body === null) {
    return { error: "Request body must be a JSON object." };
  }
  const value = body as Record<string, unknown>;
  const reason = typeof value.reason === "string" ? value.reason.trim() : "";
  if (!reason) return { error: "A correction reason is required." };
  if (!isInventoryUnitStatus(value.status)) {
    return { error: "A valid corrected frame inventory status is required." };
  }
  return { unitId, status: value.status, reason };
}

function inventoryUnitStatus(resource: Basic): FrameInventoryUnitStatus {
  const kind = resource.code.coding?.find((coding) => coding.system === BASIC_KIND_SYSTEM)?.code;
  if (kind !== "practice-frame-inventory-unit") {
    throw new Error("The selected Basic is not a frame inventory unit.");
  }
  const status = optionalExtension(resource, EXTENSION_URLS.status);
  if (!isInventoryUnitStatus(status)) {
    throw new Error("Frame inventory unit has an invalid unit status.");
  }
  return status;
}

function jsonPatchBinary(
  statusIndex: number,
  priorStatus: FrameInventoryUnitStatus,
  correctedStatus: FrameInventoryUnitStatus,
): Binary {
  return {
    resourceType: "Binary",
    contentType: "application/json-patch+json",
    data: Buffer.from(JSON.stringify([
      { op: "test", path: `/extension/${statusIndex}/url`, value: EXTENSION_URLS.status },
      { op: "test", path: `/extension/${statusIndex}/valueString`, value: priorStatus },
      { op: "replace", path: `/extension/${statusIndex}/valueString`, value: correctedStatus },
    ]), "utf8").toString("base64"),
  };
}

function assertTransactionSucceeded(bundle: Bundle): void {
  if (bundle.resourceType !== "Bundle" || bundle.type !== "transaction-response") {
    throw new Error("Frame inventory adjustment did not return a transaction-response Bundle.");
  }
  const failed = bundle.entry?.find((entry) => {
    const status = Number.parseInt(entry.response?.status ?? "", 10);
    return !Number.isFinite(status) || status < 200 || status >= 300;
  });
  if (failed) throw new Error(`Frame inventory adjustment failed with status ${failed.response?.status ?? "unknown"}.`);
}

function requiredExtension(resource: Basic, url: string, label: string): string {
  const value = optionalExtension(resource, url);
  if (!value) throw new Error(`Frame inventory unit is missing ${label}.`);
  return value;
}

function optionalExtension(resource: Basic, url: string): string | undefined {
  const extension = resource.extension?.find((entry) => entry.url === url);
  return extension?.valueString ?? extension?.valueDateTime;
}

function isInventoryUnitStatus(value: unknown): value is FrameInventoryUnitStatus {
  return typeof value === "string" && FRAME_INVENTORY_UNIT_STATUSES.includes(value as FrameInventoryUnitStatus);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
