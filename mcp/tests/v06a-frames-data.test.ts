import assert from "node:assert/strict";
import { createWriteStream, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { test } from "node:test";
import type { AuditEvent, ChargeItemDefinition, DeviceDefinition, Provenance, Resource, Task } from "@medplum/fhirtypes";
import {
  buildFrameChargeItemDefinition,
  emitFrameClaimLines,
  validateFrameClaimModifiers,
  validateLensClaimMutualExclusion,
} from "../src/catalog/frame-charge-item-definition.js";
import { buildFrameDeviceDefinition } from "../src/catalog/frame-device-definition.js";
import {
  fhirAttachmentSha1Base64,
  frameCanonicalUrl,
  normalizeGtin14,
  type FrameCatalogRow,
} from "../src/catalog/frame-types.js";
import { runFramesBulkIngest, type FramesBulkIngestContext } from "../src/catalog-sync/frames/frames-data-bulk-ingest.js";
import { assertNotFramesDataHost } from "../src/catalog-sync/frames/no-egress-guard.js";
import { parseFrameCatalogRowsFromFile } from "../src/catalog-sync/frames/parsers/frame-file-parser.js";
import { seedFrameHcpcsRows } from "../src/catalog-sync/hcpcs/hcpcs-sync.js";
import { assertLocalTerminologyUrl, validateFrameTerminologyLocally } from "../src/catalog/terminology-validation.js";
import { parseSmartResourceScope } from "../src/smart/scope.js";
import { evaluateSmartScopeIntersection } from "../src/smart/scope-intersection.js";
import { rankFramePosLookupRows, type FrameCatalogItem, type PracticeFrameInventoryItem } from "../../ui/src/lib/optical-frames.js";

const REPO_ROOT = resolve(process.cwd(), "..");
const V06A_DR_TABLES = [
  "osod_frames_catalog",
  "osod_practice_frames_inventory",
  "osod_catalog_sync_runs",
  "osod_catalog_overlays",
  "osod_terminology_hcpcs",
] as const;

test("v0.6a SQL migration creates closure-aligned Frames Data substrate", () => {
  const sql = readFileSync(resolve(REPO_ROOT, "data/migrations/2026-05-09-v06a-frames-data.sql"), "utf8");

  for (const table of [
    "osod_catalog_sync_runs",
    "osod_catalog_overlays",
    "osod_frames_catalog",
    "osod_practice_frames_inventory",
    "osod_terminology_hcpcs",
  ]) {
    assert.match(sql, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}`));
  }
  assert.match(sql, /sync_mode TEXT NOT NULL DEFAULT 'bulk'/);
  assert.match(sql, /catalog_type <> 'frames' OR sync_mode = 'bulk'/);
  assert.match(sql, /catalog_type <> 'frames' OR cursor_high_water IS NULL/);
  assert.match(sql, /ALTER TABLE osod_catalog_overlays FORCE ROW LEVEL SECURITY/);
  assert.match(sql, /ALTER TABLE osod_practice_frames_inventory FORCE ROW LEVEL SECURITY/);
  assert.match(sql, /osod_frames_catalog_retire\(/);
  assert.match(sql, /current_setting\('osod\.frames_catalog_retire', true\) <> 'on'/);
  assert.match(sql, /catalog_sync\.frames\.bulk\.upserted/);
  assert.match(sql, /catalog_sync\.frames\.bulk\.retired/);
  assert.doesNotMatch(sql, /catalog_sync\.frames\.delta/);
  assert.doesNotMatch(sql, /reconciliation\.orphan_retired/);
});

test("Frame FHIR builders keep physical identity and billing rules split", () => {
  const row = sampleRow("SKU-1", { gtin14: normalizeGtin14("123456789012"), eyesizeMm: 54 });
  const device = buildFrameDeviceDefinition({ catalogRow: row });
  const charge = buildFrameChargeItemDefinition({
    practiceId: "practice-a",
    catalogCanonicalUrl: frameCanonicalUrl(row.skuId),
    practiceSalePriceCents: 19900,
    hcpcsBaseCode: "V2020",
  });

  assert.equal(device.resourceType, "DeviceDefinition");
  assert.equal(device.url, "https://osod.dev/catalog/frames/SKU-1");
  assert.equal(device.identifier?.some((id) => id.system === "https://gs1.org/gtin" && id.value === "00123456789012"), true);
  assert.equal(device.property?.find((property) => property.type.coding?.[0]?.code === "eyesize")?.valueQuantity?.[0]?.code, "mm");
  assert.equal(charge.resourceType, "ChargeItemDefinition");
  assert.equal(charge.derivedFromUri?.[0], "https://osod.dev/catalog/frames/SKU-1");
  assert.equal(charge.code?.coding?.some((coding) => coding.system === "http://snomed.info/sct" && coding.code === "310105000"), true);
  assert.equal("useContext" in charge, false);
});

test("UCUM quantity builder rejects string-valued numeric inputs", () => {
  assert.throws(
    () => buildFrameDeviceDefinition({ catalogRow: sampleRow("SKU-Q", { eyesizeMm: "54" as unknown as number }) }),
    /FHIR Quantity source value must be a JavaScript finite number/,
  );
});

test("Frame claim validators enforce modifier, deluxe, GTIN, SHA-1, and LCD rules", () => {
  assert.equal(normalizeGtin14("123456789012"), "00123456789012");
  assert.equal(fhirAttachmentSha1Base64("abc"), "qZk+NkcGgWq6PiVxeFDCbJzQ2J0=");
  assert.deepEqual(emitFrameClaimLines({
    practiceId: "p",
    catalogCanonicalUrl: frameCanonicalUrl("SKU"),
    isDeluxe: false,
    standardFrameCostCents: 10000,
  }).map((line) => line.productOrService.coding[0]?.code), ["V2020"]);
  const deluxe = emitFrameClaimLines({
    practiceId: "p",
    catalogCanonicalUrl: frameCanonicalUrl("SKU"),
    isDeluxe: true,
    standardFrameCostCents: 10000,
    deluxeChargeCents: 13500,
  });
  assert.deepEqual(deluxe.map((line) => line.productOrService.coding[0]?.code), ["V2020", "V2025"]);
  assert.equal(deluxe[1]?.unitPrice.value, 35);
  assert.throws(() => validateFrameClaimModifiers({ hcpcsCode: "V2020", modifiers: ["RT"] }), /RT modifier prohibited/);
  assert.throws(() => validateFrameClaimModifiers({ hcpcsCode: "V2025", modifiers: ["LT"] }), /LT modifier prohibited/);
  assert.throws(() => validateFrameClaimModifiers({ hcpcsCode: "V2600", modifiers: ["AV"] }), /provisional/);
  assert.doesNotThrow(() => validateFrameClaimModifiers({ hcpcsCode: "V2200", modifiers: ["RT"] }));
  assert.throws(
    () => validateLensClaimMutualExclusion({
      lineItems: [
        { productOrService: { coding: [{ system: "x", code: "V2755" }] }, unitPrice: { value: 1, currency: "USD" }, quantity: { value: 1 } },
        { productOrService: { coding: [{ system: "x", code: "V2784" }] }, unitPrice: { value: 1, currency: "USD" }, quantity: { value: 1 } },
      ],
    }),
    /not as an NCCI PTP edit/,
  );
});

test("Bulk ingest parses operator file by stream and preserves v0.6a audit math", async () => {
  const dir = mkdtempSync(join(tmpdir(), "osod-v06a-"));
  const file = join(dir, "frames.csv");
  writeFileSync(
    file,
    [
      "skuId,brandName,modelName,colorName,sourceColorRaw,sourceMaterialRaw,eyesizeMm,dblMm,templeMm,gtin14,msrpCents",
      ...Array.from({ length: 5 }, (_, i) => `MOD-${i},Brand,Model ${i},Black,Black,Acetate,54,18,145,12345678901${i},19900`),
      ...Array.from({ length: 3 }, (_, i) => `NEW-${i},Brand,New ${i},Blue,Blue,Metal,52,17,140,22345678901${i},15900`),
    ].join("\n"),
  );

  const written: Resource[] = [];
  const inserted: FrameCatalogRow[] = [];
  const retired: string[] = [];
  const context: FramesBulkIngestContext = {
    now: () => new Date("2026-05-09T12:00:00.000Z"),
    openSyncRun: async (input) => ({
      id: "sync-run-1",
      syncRunTimestamp: input.syncRunTimestamp,
    }),
    findActiveFrameBySku: async (skuId) =>
      skuId.startsWith("MOD-") ? sampleRow(skuId, { id: `row-${skuId}`, msrpCents: 9900 }) : null,
    retireFrameCatalogRow: async (input) => {
      assert.equal(input.retiredAt, "2026-05-09T12:00:00.000Z");
      retired.push(input.rowId);
    },
    insertFrameCatalogRow: async (row) => {
      assert.equal(row.effectiveFrom, "2026-05-09T12:00:00.000Z");
      inserted.push(row);
    },
    closeSyncRun: async (input) => {
      assert.equal(input.syncRunId, "sync-run-1");
      assert.equal(input.outcome, "success");
      assert.equal(input.sourceVersion, "operator-upload:frames.csv");
    },
    writeFhirResource: async (resource) => {
      written.push(resource);
    },
  };

  try {
    const result = await runFramesBulkIngest(
      { practiceId: "practice-a", uploadedFilePath: file, fileFormat: "tracing-points" },
      context,
    );
    assert.equal(result.rowsInserted, 8);
    assert.equal(result.rowsRetired, 5);
    assert.equal(result.sqlMutations, 13);
    assert.equal(result.fhirResourcesCreated, 26);
    assert.equal(result.auditEventsCreated, 27);
    assert.equal(result.provenanceCreated, 27);
    assert.equal(result.attributionArtifacts, 55);
    assert.equal(result.sourceUrl, "operator-upload://frames.csv");
    assert.equal(result.cursorHighWater, null);
    assert.equal(inserted.length, 8);
    assert.equal(retired.length, 5);
    assert.equal(written.filter((resource) => resource.resourceType === "Task").length, 1);
    assert.equal(written.filter((resource) => resource.resourceType === "DeviceDefinition").length, 13);
    assert.equal(written.filter((resource) => resource.resourceType === "ChargeItemDefinition").length, 13);
    assert.equal(written.filter((resource) => resource.resourceType === "AuditEvent").length, 27);
    assert.equal(written.filter((resource) => resource.resourceType === "Provenance").length, 27);
    assert.equal(
      written
        .filter((resource): resource is Provenance => resource.resourceType === "Provenance")
        .flatMap((provenance) => provenance.target?.map((target) => target.reference ?? "") ?? [])
        .every((reference) => reference.startsWith("https://osod.dev/catalog/frames/") || reference.startsWith("https://osod.dev/practice/") || reference.startsWith("Task/")),
      true,
    );
    assert.equal((written.find((resource): resource is Task => resource.resourceType === "Task")?.input?.[0]?.valueAttachment?.hash), fhirAttachmentSha1Base64("operator-upload://frames.csv"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Bulk ingest N=100 emits 200 FHIR resources and 403 attribution artifacts", async () => {
  const dir = mkdtempSync(join(tmpdir(), "osod-v06a-100-"));
  const file = join(dir, "frames-100.csv");
  writeFileSync(
    file,
    [
      "skuId,brandName,modelName,colorName,sourceColorRaw,sourceMaterialRaw,eyesizeMm,dblMm,templeMm,gtin14,msrpCents",
      ...Array.from({ length: 100 }, (_, i) => `SKU-${i},Brand,Model ${i},Black,Black,Acetate,54,18,145,1234567890${String(i).padStart(2, "0")},19900`),
    ].join("\n"),
  );

  const context = ingestContext({ now: "2026-05-09T13:00:00.000Z", existing: () => null });

  try {
    const result = await runFramesBulkIngest(
      { practiceId: "practice-a", uploadedFilePath: file, fileFormat: "frames-data-365-export" },
      context,
    );
    assert.equal(result.rowsInserted, 100);
    assert.equal(result.rowsRetired, 0);
    assert.equal(result.sqlMutations, 100);
    assert.equal(result.fhirResourcesCreated, 200);
    assert.equal(result.attributionArtifacts, 403);
    assert.equal(result.cursorHighWater, null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Stream parser handles a 50MB NDJSON catalog drop without readFileSync or heap blowup", async () => {
  const dir = mkdtempSync(join(tmpdir(), "osod-v06a-50mb-"));
  const file = join(dir, "frames-large.ndjson");
  const stream = createWriteStream(file);
  const filler = "x".repeat(256 * 1024);

  try {
    for (let i = 0; i < 205; i += 1) {
      const ok = stream.write(JSON.stringify({
        skuId: `NDJSON-${i}`,
        brandName: "Stream Brand",
        modelName: `Stream Model ${i}`,
        colorName: "Black",
        sourceColorRaw: "Black",
        sourceMaterialRaw: "Acetate",
        eyesizeMm: 54,
        dblMm: 18,
        templeMm: 145,
        notes: filler,
      }) + "\n");
      if (!ok) {
        await once(stream, "drain");
      }
    }
    stream.end();
    await once(stream, "finish");
    assert.ok(statSync(file).size > 50 * 1024 * 1024);

    const heapBefore = process.memoryUsage().heapUsed;
    let rows = 0;
    for await (const row of parseFrameCatalogRowsFromFile({
      filePath: file,
      fileFormat: "unknown",
      sourceVersion: "operator-upload:frames-large.ndjson",
      sourceUrl: "operator-upload://frames-large.ndjson",
      accessDate: "2026-05-09",
    })) {
      assert.equal(row.sourceUrl, "operator-upload://frames-large.ndjson");
      rows += 1;
    }
    const heapDelta = process.memoryUsage().heapUsed - heapBefore;
    assert.equal(rows, 205);
    assert.ok(heapDelta < 200 * 1024 * 1024, `heap delta ${heapDelta} exceeded 200MB`);
  } finally {
    stream.destroy();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Pass 4 closure scans block Frames Data HTTP and sync readFileSync shapes", () => {
  assert.throws(() => assertNotFramesDataHost("api.framesdata.com"), /egress blocked/);
  const framesDir = resolve(process.cwd(), "src/catalog-sync/frames");
  const files = listFiles(framesDir).filter((file) => /\.(ts|tsx)$/.test(file));
  const source = files.map((file) => readFileSync(file, "utf8")).join("\n");
  assert.doesNotMatch(source, /fs\.readFileSync\s*\(/);
  assert.doesNotMatch(source, /https?:\/\/[^"'\s]*framesdata\.com/i);
  assert.doesNotMatch(source, /\bfetch\s*\([^)]*framesdata\.com/i);
  assert.match(readFileSync(resolve(REPO_ROOT, "docs/build-log/2026-05-09-v0.6a-frames-data.md"), "utf8"), /framesdata\.com/);
});

test("Pass 4 deep scans enforce local-only terminology and Medplum fhirtypes-only imports", async () => {
  assert.throws(() => assertLocalTerminologyUrl("https://tx.fhir.org/r4/ValueSet/$expand"), /external terminology host blocked/);
  assert.throws(() => assertLocalTerminologyUrl("https://terminology.hl7.org/CodeSystem/$lookup"), /external terminology host blocked/);
  await validateFrameTerminologyLocally({
    hasHcpcsCode: (code) => ["V2020", "V2025", "V2600"].includes(code),
    hasSnomedCode: (code) => code === "310105000",
  });

  const scanFiles = [
    ...listFiles(resolve(process.cwd(), "src/catalog")),
    ...listFiles(resolve(process.cwd(), "src/catalog-sync")),
    resolve(REPO_ROOT, "package.json"),
    resolve(REPO_ROOT, "mcp/package.json"),
    resolve(REPO_ROOT, "ui/package.json"),
  ].filter((file) => /\.(ts|tsx|json)$/.test(file));
  const source = scanFiles.map((file) => readFileSync(file, "utf8")).join("\n");
  assert.doesNotMatch(source, /@medplum\/(?:core|react)/);
  assert.doesNotMatch(source, /\$execute-bot/);
  assert.doesNotMatch(source, /createHash\(["']sha256["']\)/);
});

test("SMART DeviceDefinition catalog scopes require first-party OSOD core client", () => {
  const requestedScopes = [parseSmartResourceScope("system/DeviceDefinition.rs")];
  const thirdParty = evaluateSmartScopeIntersection({
    appClientId: "third-party-inventory",
    userId: "user-1",
    roleId: "practice-admin",
    clientAuthClass: "confidential-asymmetric",
    requestedScopes,
  });
  assert.equal(thirdParty.outcomeClass, "rejected");

  const firstParty = evaluateSmartScopeIntersection({
    appClientId: "osod-core",
    userId: "user-1",
    roleId: "practice-admin",
    clientAuthClass: "confidential-asymmetric",
    requestedScopes,
  });
  assert.equal(firstParty.outcomeClass, "granted");
  assert.deepEqual(firstParty.effectiveScopes, ["system/DeviceDefinition.rs"]);
});

test("HCPCS seed rows mark V-series frame codes laterality-exempt", () => {
  const rows = seedFrameHcpcsRows("2026-Q2", "CMS 2026-Q2", "2026-04-01");
  assert.deepEqual(rows.map((row) => row.code), ["V2020", "V2025", "V2600"]);
  assert.equal(rows.every((row) => row.metadata.laterality_exempt === true), true);
});

test("SQL substrate statically covers overlay isolation, FORCE RLS, SCD, and DR table manifest", () => {
  const sql = readFileSync(resolve(REPO_ROOT, "data/migrations/2026-05-09-v06a-frames-data.sql"), "utf8");
  assert.match(sql, /catalog_canonical_url TEXT NOT NULL/);
  assert.match(sql, /USING \(practice_id = current_setting\('osod\.practice_id', true\)\)/);
  assert.match(sql, /WITH CHECK \(practice_id = current_setting\('osod\.practice_id', true\)\)/);
  assert.match(sql, /CREATE UNIQUE INDEX IF NOT EXISTS idx_frames_catalog_sku_active_unique/);
  assert.match(sql, /WHERE effective_to IS NULL/);
  assert.match(sql, /gtin14 CHARACTER\(14\) CHECK \(gtin14 IS NULL OR gtin14 ~ '\^\[0-9\]\{14\}\$'\)/);
  for (const table of V06A_DR_TABLES) {
    assert.match(sql, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}`));
  }
});

test("Dispensary POS lookup remains under 100ms p95 over a 100K-row fixture", () => {
  const rows: FrameCatalogItem[] = Array.from({ length: 100_000 }, (_, index) => ({
    canonicalUrl: `https://osod.dev/catalog/frames/SKU-${index}`,
    sku: `SKU-${index}`,
    display: `Brand Model ${index}`,
    manufacturer: "Manufacturer",
    gtin14: String(index).padStart(14, "0"),
    properties: {},
    publicityClass: "open",
  }));
  const inventory: PracticeFrameInventoryItem[] = rows.slice(99_990, 100_000).map((row, index) => ({
    id: `inv-${index}`,
    canonicalUrl: row.canonicalUrl,
    qtyOnHand: index + 1,
    status: "active",
  }));
  const durations = Array.from({ length: 7 }, () => {
    const started = performance.now();
    const matches = rankFramePosLookupRows(rows, inventory, "SKU-99999", 8);
    const duration = performance.now() - started;
    assert.equal(matches[0]?.catalog.sku, "SKU-99999");
    assert.equal(matches[0]?.inventory?.qtyOnHand, 10);
    return duration;
  }).sort((a, b) => a - b);
  const p95 = durations[Math.ceil(durations.length * 0.95) - 1] ?? Number.POSITIVE_INFINITY;
  assert.ok(p95 < 100, `POS lookup p95 ${p95.toFixed(2)}ms exceeded 100ms`);
});

test("Inventory UI has no password field and no raw SQL route", () => {
  const uiFiles = [
    resolve(REPO_ROOT, "ui/src/lib/optical-frames.ts"),
    resolve(REPO_ROOT, "ui/src/scenes/OpticalFrames.tsx"),
  ].map((file) => readFileSync(file, "utf8")).join("\n");
  assert.doesNotMatch(uiFiles, /type=["']password["']/i);
  assert.doesNotMatch(uiFiles, /passwordSecret|framesDataPassword|bearer token|api key/i);
  assert.doesNotMatch(uiFiles, /\bSELECT\b|\bosod_frames_catalog\b|\bosod_practice_frames_inventory\b/i);
  assert.match(uiFiles, /DeviceDefinition/);
  assert.match(uiFiles, /Basic/);
  assert.match(uiFiles, /Username/);
  assert.match(uiFiles, /Active subscription/);
  assert.match(uiFiles, /Upload latest catalog file/);
  assert.match(uiFiles, /practice\.frames-data-subscription\.toggled/);
});

function sampleRow(skuId: string, overrides: Partial<FrameCatalogRow> = {}): FrameCatalogRow {
  return {
    skuId,
    brandId: "brand",
    brandName: "Brand",
    manufacturerId: "mfg",
    manufacturerName: "Manufacturer",
    modelName: "Model",
    colorCode: "black",
    colorName: "Black",
    sourceColorRaw: "Black",
    sourceMaterialRaw: "Acetate",
    frameShape: "rectangular",
    genderCategory: "unisex",
    ageGroup: "adult",
    colorGroup: "Black",
    finish: "gloss",
    progressiveCompatible: true,
    minFittingHeightMm: 18,
    eyesizeMm: 54,
    dblMm: 18,
    templeMm: 145,
    bMm: 38,
    edMm: 56,
    weightGrams: 22.5,
    materialCode: "acetate",
    countryOfOrigin: "US",
    msrpCents: 19900,
    labCostCents: 8900,
    gtin14: "00123456789012",
    itemNumber: "ITEM",
    publicityClass: "staff_only",
    status: "active",
    sourceVersion: "operator-upload:fixture.csv",
    sourceUrl: "operator-upload://fixture.csv",
    accessDate: "2026-05-09",
    ...overrides,
  };
}

function ingestContext(input: {
  readonly now: string;
  readonly existing: (skuId: string) => FrameCatalogRow | null;
}): FramesBulkIngestContext {
  return {
    now: () => new Date(input.now),
    openSyncRun: async (run) => ({
      id: "sync-run-fixture",
      syncRunTimestamp: run.syncRunTimestamp,
    }),
    findActiveFrameBySku: async (skuId) => input.existing(skuId),
    retireFrameCatalogRow: async () => undefined,
    insertFrameCatalogRow: async () => undefined,
    closeSyncRun: async (run) => {
      assert.equal(run.sourceVersion.startsWith("operator-upload:"), true);
      assert.equal(run.outcome, "success");
    },
    writeFhirResource: async () => undefined,
  };
}

function listFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? listFiles(path) : [path];
  });
}
