import type { AuditEvent, Basic, Binary, Bundle, DeviceDefinition, Provenance } from "@medplum/fhirtypes";
import { fhir } from "./fhir";
import type { RoleId } from "./roles";

const BASIC_KIND_SYSTEM = "https://osod.dev/fhir/CodeSystem/basic-kind";
const EXTENSION_URLS = {
  catalogCanonicalUrl: "https://osod.dev/fhir/StructureDefinition/catalog-canonical-url",
  catalogPublicityClass: "https://osod.dev/fhir/StructureDefinition/catalog-publicity-class",
  dispensaryLocation: "https://osod.dev/fhir/StructureDefinition/dispensary-location",
  framesDataLastIngestAt: "https://osod.dev/fhir/StructureDefinition/frames-data-last-ingest-at",
  framesDataLastIngestSourceFile: "https://osod.dev/fhir/StructureDefinition/frames-data-last-ingest-source-file",
  framesDataSubscriptionActive: "https://osod.dev/fhir/StructureDefinition/frames-data-subscription-active",
  framesDataUsername: "https://osod.dev/fhir/StructureDefinition/frames-data-username",
  inventoryStatus: "https://osod.dev/fhir/StructureDefinition/inventory-status",
  qtyOnHand: "https://osod.dev/fhir/StructureDefinition/qty-on-hand",
  salePriceCents: "https://osod.dev/fhir/StructureDefinition/sale-price-cents",
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

export interface PracticeFrameInventoryItem {
  readonly id: string;
  readonly canonicalUrl: string;
  readonly qtyOnHand: number;
  readonly status: "active" | "clearance" | "hold" | "discontinued_local";
  readonly location?: string;
  readonly salePriceCents?: number;
}

export interface FramesDataSubscriptionSettings {
  readonly username: string;
  readonly active: boolean;
  readonly lastIngestAt?: string;
  readonly lastIngestSourceFile?: string;
}

export interface FramePosLookupMatch {
  readonly catalog: FrameCatalogItem;
  readonly inventory?: PracticeFrameInventoryItem;
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
    .filter((resource) => resource.url?.startsWith("https://osod.dev/catalog/frames/"))
    .map(deviceDefinitionToFrameCatalogItem);
}

export async function loadPracticeFrameInventory(): Promise<PracticeFrameInventoryItem[]> {
  const bundle = await fhir.search<Basic>("Basic", {
    code: `${BASIC_KIND_SYSTEM}|practice-frame-inventory`,
    _count: "100",
  });
  return basicEntries(bundle).map(basicToInventoryItem);
}

export async function addFrameToInventory(item: FrameCatalogItem): Promise<PracticeFrameInventoryItem> {
  const bundle = await fhir.search<Basic>("Basic", {
    code: `${BASIC_KIND_SYSTEM}|practice-frame-inventory`,
    _count: "100",
  });
  const existing = basicEntries(bundle).find(
    (candidate) => extensionString(candidate, EXTENSION_URLS.catalogCanonicalUrl) === item.canonicalUrl,
  );

  if (existing?.id) {
    const current = await fhir.read<Basic>("Basic", existing.id);
    const qtyIndex = current.extension?.findIndex((candidate) => candidate.url === EXTENSION_URLS.qtyOnHand) ?? -1;
    if (qtyIndex < 0) {
      throw new Error("Practice frame inventory item is missing qty-on-hand.");
    }
    const qtyOnHand = extensionNumber(current, EXTENSION_URLS.qtyOnHand) ?? 0;
    const target = `Basic/${existing.id}`;
    await writeInventoryTransaction({
      resourceEntry: {
        resource: jsonPatchBinary([
          { op: "replace", path: `/extension/${qtyIndex}/valueInteger`, value: qtyOnHand + 1 },
        ]),
        request: {
          method: "PATCH",
          url: target,
          ...(current.meta?.versionId ? { ifMatch: `W/\"${current.meta.versionId}\"` } : {}),
        },
      },
      target,
    });
    return { ...basicToInventoryItem(current), qtyOnHand: qtyOnHand + 1 };
  }

  const fullUrl = `urn:uuid:frame-inventory-${crypto.randomUUID()}`;
  const inventory: Basic = {
    resourceType: "Basic",
    code: {
      coding: [
        {
          system: BASIC_KIND_SYSTEM,
          code: "practice-frame-inventory",
        },
      ],
    },
    extension: [
      extension(EXTENSION_URLS.catalogCanonicalUrl, { valueString: item.canonicalUrl }),
      extension(EXTENSION_URLS.qtyOnHand, { valueInteger: 1 }),
      extension(EXTENSION_URLS.inventoryStatus, { valueString: "active" }),
    ],
  };
  const response = await writeInventoryTransaction({
    resourceEntry: {
      fullUrl,
      resource: inventory,
      request: { method: "POST", url: "Basic" },
    },
    target: fullUrl,
  });
  const id = createdId(response, "Basic");
  return basicToInventoryItem({ ...inventory, id });
}

export async function decrementPracticeFrameInventory(
  item: PracticeFrameInventoryItem,
): Promise<PracticeFrameInventoryItem> {
  if (!item.id) {
    throw new Error("Practice frame inventory item is missing its FHIR Basic id.");
  }
  if (item.qtyOnHand <= 0) {
    throw new Error("Practice frame inventory quantity is already zero.");
  }
  const current = await fhir.read<Basic>("Basic", item.id);
  const qtyIndex = current.extension?.findIndex((extension) => extension.url === EXTENSION_URLS.qtyOnHand) ?? -1;
  if (qtyIndex < 0) {
    throw new Error("Practice frame inventory item is missing qty-on-hand.");
  }
  const updated = await fhir.patch<Basic>(
    "Basic",
    item.id,
    [{ op: "replace", path: `/extension/${qtyIndex}/valueInteger`, value: item.qtyOnHand - 1 }],
    "practice.frame-inventory.dispense",
    current.meta?.versionId,
  );
  return basicToInventoryItem(updated);
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
  const settingsBasic: Basic = {
    resourceType: "Basic",
    code: {
      coding: [
        {
          system: BASIC_KIND_SYSTEM,
          code: "frames-data-subscription",
        },
      ],
    },
    subject: { reference: `Organization/${input.practiceId}` },
    extension: [
      extension(EXTENSION_URLS.framesDataUsername, { valueString: input.settings.username }),
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
      system: "https://osod.dev/fhir/CodeSystem/audit-event-type",
      code: "practice.frames-data-subscription.toggled",
    },
    recorded: now,
    outcome: "0",
    agent: [{ who: { reference: `Practitioner/${input.actorId}` }, requestor: true }],
    source: { observer: { reference: "Device/osod-ui" } },
    entity: [{ what: { reference: `Organization/${input.practiceId}` }, name: "frames-data-subscription" }],
  };
  const provenance: Provenance = {
    resourceType: "Provenance",
    recorded: now,
    target: [{ reference: `Organization/${input.practiceId}` }],
    agent: [{ who: { reference: `Practitioner/${input.actorId}` } }],
  };
  await fhir.executeTransaction(
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
}

export function canExportFrameCatalogCsv(role: RoleId): boolean {
  return role === "practice-admin";
}

export function exportableFrameRows(rows: readonly FrameCatalogItem[]): readonly FrameCatalogItem[] {
  return rows.filter((row) => row.publicityClass === "open" || row.publicityClass === "no_public_price");
}

export function rankFramePosLookupRows(
  rows: readonly FrameCatalogItem[],
  inventory: readonly PracticeFrameInventoryItem[],
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

function basicToInventoryItem(resource: Basic): PracticeFrameInventoryItem {
  return {
    id: resource.id ?? "",
    canonicalUrl: extensionString(resource, EXTENSION_URLS.catalogCanonicalUrl) ?? "",
    qtyOnHand: extensionNumber(resource, EXTENSION_URLS.qtyOnHand) ?? 0,
    status: (extensionString(resource, EXTENSION_URLS.inventoryStatus) as PracticeFrameInventoryItem["status"]) ?? "active",
    location: extensionString(resource, EXTENSION_URLS.dispensaryLocation) ?? undefined,
    salePriceCents: extensionNumber(resource, EXTENSION_URLS.salePriceCents) ?? undefined,
  };
}

async function writeInventoryTransaction(input: {
  resourceEntry: NonNullable<Bundle["entry"]>[number];
  target: string;
}): Promise<Bundle> {
  const now = new Date().toISOString();
  const auditEvent: AuditEvent = {
    resourceType: "AuditEvent",
    type: {
      system: "https://osod.dev/fhir/CodeSystem/audit-event-type",
      code: "practice.frame-inventory.incremented",
    },
    action: input.resourceEntry.request?.method === "POST" ? "C" : "U",
    recorded: now,
    outcome: "0",
    agent: [{ who: { reference: "Device/osod-ui" }, requestor: true }],
    source: { observer: { reference: "Device/osod-ui" } },
    entity: [{ what: { reference: input.target }, name: "practice-frame-inventory" }],
  };
  const provenance: Provenance = {
    resourceType: "Provenance",
    recorded: now,
    target: [{ reference: input.target }],
    agent: [{ who: { reference: "Device/osod-ui" } }],
  };
  const response = await fhir.executeTransaction(
    {
      resourceType: "Bundle",
      type: "transaction",
      entry: [
        input.resourceEntry,
        { resource: auditEvent, request: { method: "POST", url: "AuditEvent" } },
        { resource: provenance, request: { method: "POST", url: "Provenance" } },
      ],
    },
    "practice.frame-inventory.increment",
  );
  const failed = response.entry?.find((entry) => !entry.response?.status || !/^2\d\d/.test(entry.response.status));
  if (failed) {
    throw new Error(`Frame inventory transaction failed: ${failed.response?.status ?? "missing response status"}.`);
  }
  return response;
}

function jsonPatchBinary(ops: Array<{ op: "replace"; path: string; value: number }>): Binary {
  return {
    resourceType: "Binary",
    contentType: "application/json-patch+json",
    data: btoa(JSON.stringify(ops)),
  };
}

function createdId(bundle: Bundle, resourceType: string): string {
  const location = bundle.entry?.find((entry) => entry.response?.location?.startsWith(`${resourceType}/`))?.response?.location;
  const id = location?.match(new RegExp(`^${resourceType}/([^/]+)`))?.[1];
  if (!id) {
    throw new Error(`FHIR transaction did not return the created ${resourceType} id.`);
  }
  return id;
}

function extension(url: string, value: Record<string, string | boolean | number>): NonNullable<Basic["extension"]>[number] {
  return { url, ...value };
}

function extensionString(resource: { extension?: readonly { url?: string; valueString?: string; valueDateTime?: string }[] } | undefined, url: string): string | null {
  const entry = resource?.extension?.find((candidate) => candidate.url === url);
  return entry?.valueString ?? entry?.valueDateTime ?? null;
}

function extensionBoolean(resource: { extension?: readonly { url?: string; valueBoolean?: boolean }[] } | undefined, url: string): boolean | null {
  return resource?.extension?.find((candidate) => candidate.url === url)?.valueBoolean ?? null;
}

function extensionNumber(resource: { extension?: readonly { url?: string; valueInteger?: number }[] } | undefined, url: string): number | null {
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
