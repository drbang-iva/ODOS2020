import type { AuditEvent, Basic, Binary, Bundle, DeviceDefinition, Provenance } from "@medplum/fhirtypes";
import { assertTransactionSuccess } from "./encounter-bundles";
import { clinicalGraphApiBase } from "./clinical-graph-client";
import { fhir } from "./fhir";
import type { RoleId } from "./roles";

const BASIC_KIND_SYSTEM = "https://odos2020.com/fhir/CodeSystem/basic-kind";
const FRAME_VARIANT_SETTINGS_IDENTIFIER_SYSTEM =
  "https://odos2020.com/fhir/NamingSystem/frame-variant-settings-canonical-url";
export const MAX_RECEIPT_QUANTITY = 200;
const EXTENSION_URLS = {
  catalogCanonicalUrl: "https://odos2020.com/fhir/StructureDefinition/catalog-canonical-url",
  catalogPublicityClass: "https://odos2020.com/fhir/StructureDefinition/catalog-publicity-class",
  costCents: "https://odos2020.com/fhir/StructureDefinition/cost-cents",
  dispensaryLocation: "https://odos2020.com/fhir/StructureDefinition/dispensary-location",
  framesDataLastIngestAt: "https://odos2020.com/fhir/StructureDefinition/frames-data-last-ingest-at",
  framesDataLastIngestSourceFile: "https://odos2020.com/fhir/StructureDefinition/frames-data-last-ingest-source-file",
  framesDataSubscriptionActive: "https://odos2020.com/fhir/StructureDefinition/frames-data-subscription-active",
  framesDataUsername: "https://odos2020.com/fhir/StructureDefinition/frames-data-username",
  receivedAt: "https://odos2020.com/fhir/StructureDefinition/received-at",
  salePriceCents: "https://odos2020.com/fhir/StructureDefinition/sale-price-cents",
  unitStatus: "https://odos2020.com/fhir/StructureDefinition/unit-status",
} as const;

export interface FrameCatalogItem {
  readonly canonicalUrl: string;
  readonly sku: string;
  readonly display: string;
  readonly manufacturer: string;
  readonly gtin14?: string;
  readonly properties: Record<string, string>;
  readonly publicityClass: "staff_only" | "no_public_price" | "open";
}

export const FRAME_INVENTORY_UNIT_STATUS_LABELS = {
  on_hand: "On hand",
  reserved: "In office — not sent",
  outbound: "Outbound",
  at_lab: "At Lab",
  inbound: "Inbound",
  hold: "Hold",
  dispensed: "Dispensed",
} as const;

export type FrameInventoryUnitStatus = keyof typeof FRAME_INVENTORY_UNIT_STATUS_LABELS;

export interface PracticeFrameInventoryUnit {
  readonly id: string;
  readonly canonicalUrl: string;
  readonly status: FrameInventoryUnitStatus;
  readonly location?: string;
  readonly receivedAt: string;
}

export interface PracticeFrameInventoryLoad {
  readonly units: readonly PracticeFrameInventoryUnit[];
  readonly skippedCount: number;
}

export interface PracticeFrameVariantSettings {
  readonly id: string;
  readonly canonicalUrl: string;
  readonly salePriceCents?: number;
  readonly costCents?: number;
}

export interface PracticeFrameInventorySummary {
  readonly canonicalUrl: string;
  readonly onHandCount: number;
  readonly reservedCount: number;
  readonly outboundCount: number;
  readonly atLabCount: number;
  readonly inboundCount: number;
  readonly committedCount: number;
  readonly holdCount: number;
  readonly dispensedCount: number;
  readonly salePriceCents?: number;
  readonly location?: string;
}

export interface ReceiveFrameInventoryInput {
  readonly quantity: number;
  readonly salePriceCents?: number;
  readonly costCents?: number;
  readonly location?: string;
}

export interface ReceivedFrameInventory {
  readonly units: readonly PracticeFrameInventoryUnit[];
  readonly variantSettings?: PracticeFrameVariantSettings;
}

export interface FramesDataSubscriptionSettings {
  readonly username: string;
  readonly active: boolean;
  readonly lastIngestAt?: string;
  readonly lastIngestSourceFile?: string;
}

export interface FramePosLookupMatch {
  readonly catalog: FrameCatalogItem;
  readonly inventory?: PracticeFrameInventorySummary;
  readonly score: number;
}

export async function searchFrameCatalog(query: string): Promise<FrameCatalogItem[]> {
  const bundle = await fhir.search<DeviceDefinition>("DeviceDefinition", {
    _count: "50",
    ...(query ? { _text: query } : {}),
  });
  return (bundle.entry ?? [])
    .map((entry) => entry.resource)
    .filter((resource): resource is DeviceDefinition => resource?.resourceType === "DeviceDefinition")
    .filter((resource) => resource.url?.startsWith("https://odos2020.com/catalog/frames/"))
    .map(deviceDefinitionToFrameCatalogItem);
}

export async function loadPracticeFrameInventoryUnits(): Promise<PracticeFrameInventoryLoad> {
  const rows = await searchAllBasics({
    code: `${BASIC_KIND_SYSTEM}|practice-frame-inventory-unit`,
    _count: "100",
  });
  const units: PracticeFrameInventoryUnit[] = [];
  let skippedCount = 0;
  for (const row of rows) {
    try {
      units.push(basicToInventoryUnit(row));
    } catch (cause) {
      skippedCount += 1;
      console.warn(`Skipping malformed frame inventory unit ${row.id ?? "(unknown)"}.`, cause);
    }
  }
  return { units, skippedCount };
}

export async function loadPracticeFrameVariantSettings(): Promise<PracticeFrameVariantSettings[]> {
  const rows = await searchAllBasics({
    code: `${BASIC_KIND_SYSTEM}|practice-frame-variant-settings`,
    _count: "100",
  });
  return rows.map(basicToVariantSettings);
}

export async function receiveFrameInventory(
  item: FrameCatalogItem,
  input: ReceiveFrameInventoryInput,
  actorId: string,
): Promise<ReceivedFrameInventory> {
  validateReceiveInput(input);
  const now = new Date().toISOString();
  const location = input.location?.trim() || undefined;
  const unitEntries = Array.from({ length: input.quantity }, () => {
    const fullUrl = `urn:uuid:${crypto.randomUUID()}`;
    const resource: Basic = {
      resourceType: "Basic",
      code: {
        coding: [{ system: BASIC_KIND_SYSTEM, code: "practice-frame-inventory-unit" }],
      },
      extension: [
        extension(EXTENSION_URLS.catalogCanonicalUrl, { valueString: item.canonicalUrl }),
        extension(EXTENSION_URLS.unitStatus, { valueString: "on_hand" }),
        extension(EXTENSION_URLS.receivedAt, { valueDateTime: now }),
        ...(location ? [extension(EXTENSION_URLS.dispensaryLocation, { valueString: location })] : []),
      ],
    };
    return {
      fullUrl,
      resource,
      request: { method: "POST" as const, url: "Basic" },
    };
  });

  const settingsUpsert = input.salePriceCents !== undefined || input.costCents !== undefined
    ? await variantSettingsUpsert(item.canonicalUrl, input)
    : undefined;
  const resourceEntries: NonNullable<Bundle["entry"]> = [
    ...unitEntries,
    ...(settingsUpsert ? [settingsUpsert.entry] : []),
  ];
  const targets = [
    ...unitEntries.map((entry) => ({ reference: entry.fullUrl, name: "practice-frame-inventory-unit" })),
    ...(settingsUpsert
      ? [{ reference: settingsUpsert.target, name: "practice-frame-variant-settings" }]
      : []),
  ];
  const response = await writeInventoryTransaction({
    resourceEntries,
    targets,
    actorId,
    eventCode: "practice.frame-inventory.received",
    action: "C",
  });
  const units = unitEntries.map((entry, index) => basicToInventoryUnit({
    ...entry.resource,
    id: responseEntryId(response, index, "Basic"),
  }));
  let variantSettings: PracticeFrameVariantSettings | undefined;
  if (settingsUpsert) {
    const responseIndex = unitEntries.length;
    const settingsId = settingsUpsert.resource.id
      ?? responseEntryId(response, responseIndex, "Basic");
    if (settingsUpsert.conditionalCreate && responseStatusCode(response, responseIndex) === 200) {
      variantSettings = basicToVariantSettings(await fhir.read<Basic>("Basic", settingsId));
    } else {
      variantSettings = basicToVariantSettings({
        ...settingsUpsert.resource,
        id: settingsId,
      });
    }
  }
  return { units, ...(variantSettings ? { variantSettings } : {}) };
}

export async function dispenseFrameInventoryUnit(
  unitId: string,
  actorId: string,
): Promise<PracticeFrameInventoryUnit> {
  return transitionFrameInventoryUnitStatus(
    unitId,
    ["on_hand", "reserved", "outbound", "at_lab", "inbound"],
    "dispensed",
    actorId,
  );
}

export async function adjustFrameInventoryUnit(
  unitId: string,
  status: FrameInventoryUnitStatus,
  reason: string,
  options: { fetchImpl?: typeof fetch; authorization?: string } = {},
): Promise<PracticeFrameInventoryUnit> {
  const authorization = options.authorization ?? fhir.authHeader();
  const response = await (options.fetchImpl ?? fetch)(
    `${clinicalGraphApiBase()}/inventory/frame-units/${encodeURIComponent(unitId)}/adjustments`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(authorization ? { Authorization: authorization } : {}),
      },
      body: JSON.stringify({ status, reason }),
    },
  );
  const body = await response.json().catch(() => ({})) as {
    error?: string;
    unit?: Partial<PracticeFrameInventoryUnit>;
  };
  if (!response.ok) {
    throw new Error(body.error ?? `Frame inventory adjustment failed (${response.status}).`);
  }
  const unit = body.unit;
  const unitStatus = unit?.status;
  if (!unit
    || typeof unit.id !== "string"
    || typeof unit.canonicalUrl !== "string"
    || typeof unit.receivedAt !== "string"
    || typeof unitStatus !== "string"
    || !isUnitStatus(unitStatus)) {
    throw new Error("Frame inventory adjustment returned an invalid unit.");
  }
  return {
    id: unit.id,
    canonicalUrl: unit.canonicalUrl,
    status: unitStatus,
    ...(typeof unit.location === "string" ? { location: unit.location } : {}),
    receivedAt: unit.receivedAt,
  };
}

export async function transitionFrameInventoryUnitStatus(
  unitId: string,
  fromStatuses: FrameInventoryUnitStatus | readonly FrameInventoryUnitStatus[],
  toStatus: FrameInventoryUnitStatus,
  actorId: string,
): Promise<PracticeFrameInventoryUnit> {
  if (!unitId) {
    throw new Error("Frame inventory unit is missing its FHIR Basic id.");
  }
  const current = await fhir.read<Basic>("Basic", unitId);
  if (basicKind(current) !== "practice-frame-inventory-unit") {
    throw new Error("The selected Basic is not a frame inventory unit.");
  }
  const statusIndex = current.extension?.findIndex((entry) => entry.url === EXTENSION_URLS.unitStatus) ?? -1;
  if (statusIndex < 0) {
    throw new Error("Frame inventory unit is missing unit status.");
  }
  const status = extensionString(current, EXTENSION_URLS.unitStatus);
  if (!isUnitStatus(status)) {
    throw new Error("Frame inventory unit has an invalid unit status.");
  }
  if (status === toStatus) {
    return basicToInventoryUnit(current);
  }
  const allowed = Array.isArray(fromStatuses) ? fromStatuses : [fromStatuses];
  if (!allowed.includes(status)) {
    throw new Error(
      `Frame inventory unit ${unitId} changed on another terminal: expected ${allowed.map(frameInventoryUnitStatusLabel).join(" or ")}, found ${frameInventoryUnitStatusLabel(status)}. Refresh inventory and retry.`,
    );
  }
  const target = `Basic/${unitId}`;
  await writeInventoryTransaction({
    resourceEntries: [{
      resource: jsonPatchBinary([
        { op: "test", path: `/extension/${statusIndex}/url`, value: EXTENSION_URLS.unitStatus },
        { op: "test", path: `/extension/${statusIndex}/valueString`, value: status },
        { op: "replace", path: `/extension/${statusIndex}/valueString`, value: toStatus },
      ]),
      request: {
        method: "PATCH",
        url: target,
        ...(current.meta?.versionId ? { ifMatch: `W/\"${current.meta.versionId}\"` } : {}),
      },
    }],
    targets: [{ reference: target, name: "practice-frame-inventory-unit" }],
    actorId,
    eventCode: `practice.frame-inventory.${toStatus.replace("_", "-")}`,
    action: "U",
  });
  return basicToInventoryUnit({
    ...current,
    extension: current.extension?.map((entry, index) =>
      index === statusIndex ? { ...entry, valueString: toStatus } : entry),
  });
}

export function frameInventoryUnitStatusLabel(status: FrameInventoryUnitStatus): string {
  return FRAME_INVENTORY_UNIT_STATUS_LABELS[status];
}

export function frameSourceUsesPracticeInventory(
  frameSource: number,
  frameOwnership: string | undefined,
): boolean {
  return frameSource === 4 && frameOwnership === "in-house";
}

export function assertFrameInventoryAssignment(
  frameSource: number,
  frameOwnership: string | undefined,
  inventoryId: string | undefined,
): void {
  const usesPracticeInventory = frameSourceUsesPracticeInventory(frameSource, frameOwnership);
  if (usesPracticeInventory && !inventoryId) {
    throw new Error("A practice-stock frame must have a reserved inventory unit before it can be sent to the lab.");
  }
  if (!usesPracticeInventory && inventoryId) {
    throw new Error("A frame inventory unit may only be linked to FSRC 4 + in-house.");
  }
}

export function summarizeInventoryByVariant(
  units: readonly PracticeFrameInventoryUnit[],
  variantSettings: readonly PracticeFrameVariantSettings[],
  catalog: readonly FrameCatalogItem[],
): PracticeFrameInventorySummary[] {
  const settingsByUrl = new Map(variantSettings.map((settings) => [settings.canonicalUrl, settings]));
  const catalogOrder = new Map(catalog.map((item, index) => [item.canonicalUrl, index]));
  const grouped = new Map<string, PracticeFrameInventoryUnit[]>();
  for (const unit of units) {
    const group = grouped.get(unit.canonicalUrl);
    if (group) group.push(unit);
    else grouped.set(unit.canonicalUrl, [unit]);
  }
  return [...grouped.entries()]
    .map(([canonicalUrl, variantUnits]) => {
      const settings = settingsByUrl.get(canonicalUrl);
      const location = variantUnits.find((unit) => unit.status === "on_hand" && unit.location)?.location
        ?? variantUnits.find((unit) => unit.location)?.location;
      return {
        canonicalUrl,
        onHandCount: variantUnits.filter((unit) => unit.status === "on_hand").length,
        reservedCount: variantUnits.filter((unit) => unit.status === "reserved").length,
        outboundCount: variantUnits.filter((unit) => unit.status === "outbound").length,
        atLabCount: variantUnits.filter((unit) => unit.status === "at_lab").length,
        inboundCount: variantUnits.filter((unit) => unit.status === "inbound").length,
        committedCount: variantUnits.filter((unit) =>
          unit.status === "reserved"
          || unit.status === "outbound"
          || unit.status === "at_lab"
          || unit.status === "inbound").length,
        holdCount: variantUnits.filter((unit) => unit.status === "hold").length,
        dispensedCount: variantUnits.filter((unit) => unit.status === "dispensed").length,
        ...(settings?.salePriceCents !== undefined ? { salePriceCents: settings.salePriceCents } : {}),
        ...(location ? { location } : {}),
      };
    })
    .sort((left, right) => {
      const leftIndex = catalogOrder.get(left.canonicalUrl) ?? Number.MAX_SAFE_INTEGER;
      const rightIndex = catalogOrder.get(right.canonicalUrl) ?? Number.MAX_SAFE_INTEGER;
      return leftIndex - rightIndex || left.canonicalUrl.localeCompare(right.canonicalUrl);
    });
}

export function dollarsToCentsExact(value: string): number {
  const normalized = value.trim().replace(/^\$/, "");
  const match = normalized.match(/^(\d+)(?:\.(\d{1,2}))?$/);
  if (!match) {
    throw new Error("Dollar amounts must be nonnegative with at most two decimal places.");
  }
  const dollars = Number(match[1]);
  const cents = Number((match[2] ?? "").padEnd(2, "0"));
  const total = dollars * 100 + cents;
  if (!Number.isSafeInteger(total)) {
    throw new Error("Dollar amount is too large.");
  }
  return total;
}

export async function loadFramesDataSubscriptionSettings(): Promise<FramesDataSubscriptionSettings> {
  const bundle = await fhir.search<Basic>("Basic", {
    code: `${BASIC_KIND_SYSTEM}|frames-data-subscription`,
    _count: "1",
  });
  const basic = basicEntries(bundle)[0];
  return {
    username: extensionString(basic, EXTENSION_URLS.framesDataUsername) ?? "",
    active: extensionBoolean(basic, EXTENSION_URLS.framesDataSubscriptionActive) ?? false,
    lastIngestAt: extensionString(basic, EXTENSION_URLS.framesDataLastIngestAt) ?? undefined,
    lastIngestSourceFile: extensionString(basic, EXTENSION_URLS.framesDataLastIngestSourceFile) ?? undefined,
  };
}

export async function saveFramesDataSubscriptionSettings(input: {
  readonly practiceId: string;
  readonly actorId: string;
  readonly settings: FramesDataSubscriptionSettings;
}): Promise<void> {
  const now = new Date().toISOString();
  const username = input.settings.username.trim();
  if (input.settings.active && !username) {
    throw new Error("Frames Data username is required when the subscription is active.");
  }
  const settingsBasic: Basic = {
    resourceType: "Basic",
    code: {
      coding: [{ system: BASIC_KIND_SYSTEM, code: "frames-data-subscription" }],
    },
    subject: { reference: `Organization/${input.practiceId}` },
    extension: [
      ...(username
        ? [extension(EXTENSION_URLS.framesDataUsername, { valueString: username })]
        : []),
      extension(EXTENSION_URLS.framesDataSubscriptionActive, { valueBoolean: input.settings.active }),
      ...(input.settings.lastIngestAt
        ? [extension(EXTENSION_URLS.framesDataLastIngestAt, { valueDateTime: input.settings.lastIngestAt })]
        : []),
      ...(input.settings.lastIngestSourceFile
        ? [extension(EXTENSION_URLS.framesDataLastIngestSourceFile, { valueString: input.settings.lastIngestSourceFile })]
        : []),
    ],
  };
  const auditEvent: AuditEvent = {
    resourceType: "AuditEvent",
    type: {
      system: "https://odos2020.com/fhir/CodeSystem/audit-event-type",
      code: "practice.frames-data-subscription.toggled",
    },
    recorded: now,
    outcome: "0",
    agent: [{ who: { reference: `Practitioner/${input.actorId}` }, requestor: true }],
    source: { observer: { reference: "Device/odos-ui" } },
    entity: [{ what: { reference: `Organization/${input.practiceId}` }, name: "frames-data-subscription" }],
  };
  const provenance: Provenance = {
    resourceType: "Provenance",
    recorded: now,
    target: [{ reference: `Organization/${input.practiceId}` }],
    agent: [{ who: { reference: `Practitioner/${input.actorId}` } }],
  };
  const response = await fhir.executeTransaction(
    {
      resourceType: "Bundle",
      type: "transaction",
      entry: [
        { resource: settingsBasic, request: { method: "POST", url: "Basic" } },
        { resource: auditEvent, request: { method: "POST", url: "AuditEvent" } },
        { resource: provenance, request: { method: "POST", url: "Provenance" } },
      ],
    },
    "practice.frames-data-subscription",
  );
  assertTransactionSuccess(response);
}

export function canExportFrameCatalogCsv(role: RoleId): boolean {
  return role === "practice-admin";
}

export function exportableFrameRows(rows: readonly FrameCatalogItem[]): readonly FrameCatalogItem[] {
  return rows.filter((row) => row.publicityClass === "open" || row.publicityClass === "no_public_price");
}

export function rankFramePosLookupRows(
  rows: readonly FrameCatalogItem[],
  inventory: readonly PracticeFrameInventorySummary[],
  query: string,
  limit = 8,
): readonly FramePosLookupMatch[] {
  const normalizedQuery = query.trim().toLowerCase();
  const inventoryByUrl = new Map(inventory.map((row) => [row.canonicalUrl, row]));
  const matches: FramePosLookupMatch[] = [];

  for (const row of rows) {
    const score = frameLookupScore(row, normalizedQuery);
    if (score === 0) {
      continue;
    }
    insertLookupMatch(matches, { catalog: row, inventory: inventoryByUrl.get(row.canonicalUrl), score }, limit);
  }

  return matches;
}

function deviceDefinitionToFrameCatalogItem(resource: DeviceDefinition): FrameCatalogItem {
  const properties: Record<string, string> = {};
  for (const property of resource.property ?? []) {
    const key = property.type.coding?.[0]?.code ?? property.type.text ?? "property";
    const quantity = property.valueQuantity?.[0];
    const code = property.valueCode?.[0];
    properties[key] = quantity
      ? `${quantity.value ?? ""}${quantity.unit ? ` ${quantity.unit}` : ""}`.trim()
      : (code?.text ?? code?.coding?.[0]?.code ?? "");
  }
  const canonicalUrl = resource.url ?? "";
  return {
    canonicalUrl,
    sku: decodeURIComponent(canonicalUrl.split("/").pop() ?? ""),
    display: resource.deviceName?.[0]?.name ?? canonicalUrl,
    manufacturer: resource.manufacturerString ?? "",
    gtin14: resource.identifier?.find((id) => id.system === "https://gs1.org/gtin")?.value,
    properties,
    publicityClass: extensionString(resource, EXTENSION_URLS.catalogPublicityClass) as FrameCatalogItem["publicityClass"] ?? "staff_only",
  };
}

function basicEntries(bundle: Bundle<Basic>): Basic[] {
  return (bundle.entry ?? [])
    .map((entry) => entry.resource)
    .filter((resource): resource is Basic => resource?.resourceType === "Basic");
}

function basicToInventoryUnit(resource: Basic): PracticeFrameInventoryUnit {
  const status = extensionString(resource, EXTENSION_URLS.unitStatus);
  if (!isUnitStatus(status)) {
    throw new Error(`Frame inventory unit ${resource.id ?? "(unknown)"} has an invalid unit status.`);
  }
  const receivedAt = extensionString(resource, EXTENSION_URLS.receivedAt);
  if (!receivedAt) {
    throw new Error(`Frame inventory unit ${resource.id ?? "(unknown)"} is missing received-at.`);
  }
  return {
    id: resource.id ?? "",
    canonicalUrl: extensionString(resource, EXTENSION_URLS.catalogCanonicalUrl) ?? "",
    status,
    location: extensionString(resource, EXTENSION_URLS.dispensaryLocation) ?? undefined,
    receivedAt,
  };
}

function basicToVariantSettings(resource: Basic): PracticeFrameVariantSettings {
  return {
    id: resource.id ?? "",
    canonicalUrl: extensionString(resource, EXTENSION_URLS.catalogCanonicalUrl) ?? "",
    salePriceCents: extensionNumber(resource, EXTENSION_URLS.salePriceCents) ?? undefined,
    costCents: extensionNumber(resource, EXTENSION_URLS.costCents) ?? undefined,
  };
}

function validateReceiveInput(input: ReceiveFrameInventoryInput): void {
  if (!Number.isSafeInteger(input.quantity) || input.quantity < 1) {
    throw new Error("Receipt quantity must be an integer of at least 1.");
  }
  if (input.quantity > MAX_RECEIPT_QUANTITY) {
    throw new Error(`Receipt quantity cannot exceed ${MAX_RECEIPT_QUANTITY} units.`);
  }
  for (const [label, value] of [["Sale price", input.salePriceCents], ["Cost", input.costCents]] as const) {
    if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) {
      throw new Error(`${label} must be a nonnegative integer number of cents.`);
    }
  }
}

async function variantSettingsUpsert(
  canonicalUrl: string,
  input: Pick<ReceiveFrameInventoryInput, "salePriceCents" | "costCents">,
): Promise<{
  entry: NonNullable<Bundle["entry"]>[number];
  target: string;
  resource: Basic;
  conditionalCreate: boolean;
}> {
  const identifierBundle = await fhir.search<Basic>("Basic", {
    code: `${BASIC_KIND_SYSTEM}|practice-frame-variant-settings`,
    identifier: `${FRAME_VARIANT_SETTINGS_IDENTIFIER_SYSTEM}|${canonicalUrl}`,
    _count: "2",
  });
  const identifierMatch = basicEntries(identifierBundle).find(
    (candidate) => extensionString(candidate, EXTENSION_URLS.catalogCanonicalUrl) === canonicalUrl,
  );
  const fallbackBundle = identifierMatch
    ? undefined
    : await fhir.search<Basic>("Basic", {
        code: `${BASIC_KIND_SYSTEM}|practice-frame-variant-settings`,
        _count: "100",
      });
  const existing = identifierMatch ?? (fallbackBundle ? basicEntries(fallbackBundle) : []).find(
    (candidate) => extensionString(candidate, EXTENSION_URLS.catalogCanonicalUrl) === canonicalUrl,
  );
  if (existing?.id) {
    const current = await fhir.read<Basic>("Basic", existing.id);
    const resource: Basic = {
      ...current,
      extension: variantSettingsExtensions(current.extension, canonicalUrl, input),
    };
    const target = `Basic/${existing.id}`;
    return {
      resource,
      target,
      conditionalCreate: false,
      entry: {
        resource,
        request: {
          method: "PUT",
          url: target,
          ...(current.meta?.versionId ? { ifMatch: `W/\"${current.meta.versionId}\"` } : {}),
        },
      },
    };
  }

  const fullUrl = `urn:uuid:${crypto.randomUUID()}`;
  const resource: Basic = {
    resourceType: "Basic",
    identifier: [{ system: FRAME_VARIANT_SETTINGS_IDENTIFIER_SYSTEM, value: canonicalUrl }],
    code: {
      coding: [{ system: BASIC_KIND_SYSTEM, code: "practice-frame-variant-settings" }],
    },
    extension: variantSettingsExtensions(undefined, canonicalUrl, input),
  };
  return {
    resource,
    target: fullUrl,
    conditionalCreate: true,
    entry: {
      fullUrl,
      resource,
      request: {
        method: "POST",
        url: "Basic",
        ifNoneExist: new URLSearchParams({
          identifier: `${FRAME_VARIANT_SETTINGS_IDENTIFIER_SYSTEM}|${canonicalUrl}`,
        }).toString(),
      },
    },
  };
}

function variantSettingsExtensions(
  existing: Basic["extension"],
  canonicalUrl: string,
  input: Pick<ReceiveFrameInventoryInput, "salePriceCents" | "costCents">,
): NonNullable<Basic["extension"]> {
  const managedUrls = new Set<string>([
    EXTENSION_URLS.catalogCanonicalUrl,
    ...(input.salePriceCents !== undefined ? [EXTENSION_URLS.salePriceCents] : []),
    ...(input.costCents !== undefined ? [EXTENSION_URLS.costCents] : []),
  ]);
  return [
    ...(existing ?? []).filter((entry) => !entry.url || !managedUrls.has(entry.url)),
    extension(EXTENSION_URLS.catalogCanonicalUrl, { valueString: canonicalUrl }),
    ...(input.salePriceCents !== undefined
      ? [extension(EXTENSION_URLS.salePriceCents, { valueInteger: input.salePriceCents })]
      : []),
    ...(input.costCents !== undefined
      ? [extension(EXTENSION_URLS.costCents, { valueInteger: input.costCents })]
      : []),
  ];
}

async function writeInventoryTransaction(input: {
  resourceEntries: NonNullable<Bundle["entry"]>;
  targets: readonly { reference: string; name: string }[];
  actorId: string;
  eventCode: string;
  action: NonNullable<AuditEvent["action"]>;
}): Promise<Bundle> {
  const now = new Date().toISOString();
  const auditEvent: AuditEvent = {
    resourceType: "AuditEvent",
    type: {
      system: "https://odos2020.com/fhir/CodeSystem/audit-event-type",
      code: input.eventCode,
    },
    action: input.action,
    recorded: now,
    outcome: "0",
    agent: [{ who: { reference: `Practitioner/${input.actorId}` }, requestor: true }],
    source: { observer: { reference: "Device/odos-ui" } },
    entity: input.targets.map((target) => ({
      what: { reference: target.reference },
      name: target.name,
    })),
  };
  const provenance: Provenance = {
    resourceType: "Provenance",
    recorded: now,
    target: input.targets.map((target) => ({ reference: target.reference })),
    agent: [{ who: { reference: `Practitioner/${input.actorId}` } }],
  };
  const response = await fhir.executeTransaction(
    {
      resourceType: "Bundle",
      type: "transaction",
      entry: [
        ...input.resourceEntries,
        { resource: auditEvent, request: { method: "POST", url: "AuditEvent" } },
        { resource: provenance, request: { method: "POST", url: "Provenance" } },
      ],
    },
    input.eventCode,
  );
  assertTransactionSuccess(response);
  return response;
}

function jsonPatchBinary(
  ops: Array<{ op: "test" | "replace"; path: string; value: string }>,
): Binary {
  return {
    resourceType: "Binary",
    contentType: "application/json-patch+json",
    data: btoa(JSON.stringify(ops)),
  };
}

function responseEntryId(bundle: Bundle, index: number, resourceType: string): string {
  const location = bundle.entry?.[index]?.response?.location;
  const segments = location?.split("/").filter(Boolean) ?? [];
  const resourceTypeIndex = segments.lastIndexOf(resourceType);
  const id = resourceTypeIndex >= 0
    ? segments[resourceTypeIndex + 1]?.split(/[?#]/, 1)[0]
    : undefined;
  if (!id) {
    throw new Error(`FHIR transaction did not return the created ${resourceType} id.`);
  }
  return id;
}

function responseStatusCode(bundle: Bundle, index: number): number | undefined {
  const status = bundle.entry?.[index]?.response?.status;
  const code = status ? Number.parseInt(status, 10) : Number.NaN;
  return Number.isFinite(code) ? code : undefined;
}

function basicKind(resource: Basic): string | undefined {
  return resource.code.coding?.find((coding) => coding.system === BASIC_KIND_SYSTEM)?.code;
}

function isUnitStatus(value: string | null): value is FrameInventoryUnitStatus {
  return value !== null
    && Object.prototype.hasOwnProperty.call(FRAME_INVENTORY_UNIT_STATUS_LABELS, value);
}

type ExtensionValue =
  | { valueString: string }
  | { valueDateTime: string }
  | { valueInteger: number }
  | { valueBoolean: boolean };

function extension(url: string, value: ExtensionValue): NonNullable<Basic["extension"]>[number] {
  return { url, ...value };
}

async function searchAllBasics(params: Record<string, string>): Promise<Basic[]> {
  const rows: Basic[] = [];
  let bundle = await fhir.search<Basic>("Basic", params);
  while (true) {
    rows.push(...basicEntries(bundle));
    const next = bundle.link?.find((link) => link.relation === "next")?.url;
    if (!next) return rows;
    bundle = await fhir.searchUrl<Basic>(next);
  }
}

function extensionString(
  resource: { extension?: readonly { url?: string; valueString?: string; valueDateTime?: string }[] } | undefined,
  url: string,
): string | null {
  const entry = resource?.extension?.find((candidate) => candidate.url === url);
  return entry?.valueString ?? entry?.valueDateTime ?? null;
}

function extensionBoolean(
  resource: { extension?: readonly { url?: string; valueBoolean?: boolean }[] } | undefined,
  url: string,
): boolean | null {
  return resource?.extension?.find((candidate) => candidate.url === url)?.valueBoolean ?? null;
}

function extensionNumber(
  resource: { extension?: readonly { url?: string; valueInteger?: number }[] } | undefined,
  url: string,
): number | null {
  return resource?.extension?.find((candidate) => candidate.url === url)?.valueInteger ?? null;
}

function frameLookupScore(row: FrameCatalogItem, normalizedQuery: string): number {
  if (!normalizedQuery) {
    return 1;
  }
  const sku = row.sku.toLowerCase();
  const gtin = row.gtin14 ?? "";
  const display = row.display.toLowerCase();
  const manufacturer = row.manufacturer.toLowerCase();

  if (sku === normalizedQuery || gtin === normalizedQuery) return 100;
  if (sku.startsWith(normalizedQuery) || display.startsWith(normalizedQuery)) return 75;
  if (display.includes(normalizedQuery) || manufacturer.includes(normalizedQuery) || gtin.includes(normalizedQuery)) return 50;
  return 0;
}

function insertLookupMatch(matches: FramePosLookupMatch[], match: FramePosLookupMatch, limit: number): void {
  if (matches.length < limit) {
    matches.push(match);
    matches.sort((a, b) => b.score - a.score);
    return;
  }
  const last = matches[matches.length - 1];
  if (!last || match.score <= last.score) {
    return;
  }
  matches[matches.length - 1] = match;
  matches.sort((a, b) => b.score - a.score);
}
