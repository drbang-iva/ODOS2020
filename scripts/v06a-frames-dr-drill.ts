#!/usr/bin/env tsx
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";

const postgresUrl = process.env.OSOD_POSTGRES_URL ?? "postgresql://medplum:medplum@127.0.0.1:15432/medplum";
const backupRoot = resolve(process.env.OSOD_V06A_DR_BACKUP_DIR ?? "backup-dr-drill-v06a");
const timestamp = process.env.OSOD_BACKUP_TIMESTAMP ?? new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
const dumpPath = resolve(backupRoot, `v06a-frames-${timestamp}`);

const v06aTables = [
  "osod_frames_catalog",
  "osod_practice_frames_inventory",
  "osod_catalog_sync_runs",
  "osod_catalog_overlays",
  "osod_terminology_hcpcs",
] as const;

const dumpedRelations = [
  ...v06aTables,
  "osod_practice_frames_inventory_active",
] as const;

resetDatabase();
applyMigration("data/migrations/2026-04-29-v05b-osod-audit-events.sql");
applyMigration("data/migrations/2026-05-09-v06a-frames-data.sql");
seedV06aFixtures();

const before = snapshotTables();
runCanonicalChecks("pre-backup");

mkdirSync(backupRoot, { recursive: true });
rmSync(dumpPath, { recursive: true, force: true });
run("pg_dump", [
  "--format=directory",
  "--jobs=4",
  `--file=${dumpPath}`,
  ...dumpedRelations.flatMap((table) => ["--table", table]),
  postgresUrl,
]);

dropV06aTables();
run("pg_restore", ["--jobs=4", `--dbname=${postgresUrl}`, dumpPath]);

const after = snapshotTables();
const integrity = verifyIntegrity(before, after);
const canonical = runCanonicalChecks("post-restore");

console.log(JSON.stringify({
  backupPath: dumpPath,
  canonicalChecks: `${canonical.passed}/${canonical.total}`,
  tableIntegrity: `${integrity.passed}/${integrity.total}`,
  tables: after,
}, null, 2));

function resetDatabase(): void {
  sql(`
    DROP VIEW IF EXISTS osod_practice_frames_inventory_active;
    DROP TABLE IF EXISTS
      osod_practice_frames_inventory,
      osod_frames_catalog,
      osod_catalog_overlays,
      osod_terminology_hcpcs,
      osod_catalog_sync_runs
    CASCADE;
    DROP TABLE IF EXISTS osod_audit_events CASCADE;
    DROP FUNCTION IF EXISTS osod_frames_catalog_retire(UUID, TIMESTAMPTZ, UUID, TEXT);
    DROP FUNCTION IF EXISTS osod_frames_catalog_block_payload_update();
    DROP FUNCTION IF EXISTS osod_catalog_sync_runs_block_update_after_close();
  `);
}

function dropV06aTables(): void {
  sql(`
    DROP VIEW IF EXISTS osod_practice_frames_inventory_active;
    DROP TABLE IF EXISTS
      osod_practice_frames_inventory,
      osod_frames_catalog,
      osod_catalog_overlays,
      osod_terminology_hcpcs,
      osod_catalog_sync_runs
    CASCADE;
  `);
}

function applyMigration(path: string): void {
  run("psql", ["-v", "ON_ERROR_STOP=1", postgresUrl, "-f", path]);
}

function seedV06aFixtures(): void {
  sql(`
    INSERT INTO osod_catalog_sync_runs (
      id, catalog_type, started_at, completed_at, outcome, source_url, access_date,
      source_version, rows_inserted, rows_retired, audit_event_id, cursor_high_water,
      sync_mode, sync_run_timestamp
    ) VALUES
      ('11111111-1111-1111-1111-111111111111', 'frames', '2026-05-09T12:00:00Z', '2026-05-09T12:02:00Z', 'success',
       'operator-upload://frames.csv', '2026-05-09', 'operator-upload:frames.csv', 3, 1, 'audit-sync-frames', NULL, 'bulk', '2026-05-09T12:00:00Z'),
      ('22222222-2222-2222-2222-222222222222', 'hcpcs', '2026-05-09T13:00:00Z', '2026-05-09T13:01:00Z', 'success',
       'cms-hcpcs://2026-Q2', '2026-05-09', '2026-Q2', 3, 0, 'audit-sync-hcpcs', NULL, 'delta', '2026-05-09T13:00:00Z');

    INSERT INTO osod_catalog_overlays (
      id, practice_id, catalog_type, catalog_canonical_url, overlay_kind, overlay_value,
      created_by, audit_event_id
    ) VALUES (
      '33333333-3333-3333-3333-333333333333', 'practice-a', 'frames',
      'https://osod.dev/catalog/frames/SKU-1', 'price_override', '{"salePriceCents": 18900}',
      'practice-admin', 'audit-overlay'
    );

    INSERT INTO osod_frames_catalog (
      id, sku_id, brand_id, brand_name, manufacturer_id, manufacturer_name, model_name,
      color_code, color_name, source_color_raw, source_material_raw, frame_shape,
      gender_category, age_group, color_group, finish, progressive_compatible,
      min_fitting_height_mm, eyesize_mm, dbl_mm, temple_mm, b_mm, ed_mm, weight_grams,
      material_code, country_of_origin, msrp_cents, lab_cost_cents, gtin14, item_number,
      publicity_class, status, effective_from, source_version, source_url, access_date,
      sync_run_id, audit_event_id
    ) VALUES
      ('44444444-4444-4444-4444-444444444441', 'SKU-1', 'brand-a', 'Brand A', 'mfg-a', 'Mfg A', 'Model 1',
       'black', 'Black', 'Black', 'Acetate', 'rectangular', 'unisex', 'adult', 'Black', 'gloss', true,
       18, 54, 18, 145, 38, 56, 22.50, 'acetate', 'US', 19900, 8900, '00123456789012', 'ITEM-1',
       'open', 'active', '2026-05-09T12:00:00Z', 'operator-upload:frames.csv', 'operator-upload://frames.csv',
       '2026-05-09', '11111111-1111-1111-1111-111111111111', 'audit-frame-1'),
      ('44444444-4444-4444-4444-444444444442', 'SKU-2', 'brand-a', 'Brand A', 'mfg-a', 'Mfg A', 'Model 2',
       'blue', 'Blue', 'Blue', 'Metal', 'round', 'women', 'adult', 'Blue', 'matte', true,
       17, 52, 17, 140, 36, 54, 20.00, 'metal', 'US', 15900, 7900, '00123456789013', 'ITEM-2',
       'no_public_price', 'active', '2026-05-09T12:00:00Z', 'operator-upload:frames.csv', 'operator-upload://frames.csv',
       '2026-05-09', '11111111-1111-1111-1111-111111111111', 'audit-frame-2');

    SELECT osod_frames_catalog_retire(
      '44444444-4444-4444-4444-444444444442',
      '2026-05-09T12:00:00Z',
      '11111111-1111-1111-1111-111111111111',
      'audit-retire-2'
    );

    INSERT INTO osod_frames_catalog (
      id, sku_id, brand_id, brand_name, manufacturer_id, manufacturer_name, model_name,
      color_code, color_name, source_color_raw, source_material_raw, frame_shape,
      gender_category, age_group, color_group, finish, progressive_compatible,
      min_fitting_height_mm, eyesize_mm, dbl_mm, temple_mm, b_mm, ed_mm, weight_grams,
      material_code, country_of_origin, msrp_cents, lab_cost_cents, gtin14, item_number,
      publicity_class, status, effective_from, source_version, source_url, access_date,
      sync_run_id, audit_event_id
    ) VALUES (
      '44444444-4444-4444-4444-444444444443', 'SKU-2', 'brand-a', 'Brand A', 'mfg-a', 'Mfg A', 'Model 2',
      'blue', 'Blue', 'Blue', 'Metal', 'round', 'women', 'adult', 'Blue', 'matte', true,
      17, 52, 17, 140, 36, 54, 20.00, 'metal', 'US', 16900, 7900, '00123456789013', 'ITEM-2',
      'no_public_price', 'active', '2026-05-09T12:00:01Z', 'operator-upload:frames.csv', 'operator-upload://frames.csv',
      '2026-05-09', '11111111-1111-1111-1111-111111111111', 'audit-frame-2b'
    );

    INSERT INTO osod_practice_frames_inventory (
      id, practice_id, catalog_canonical_url, qty_on_hand, dispensary_location,
      inventory_status, practice_sale_price_cents, practice_lab_cost_cents,
      reorder_threshold, created_by, audit_event_id
    ) VALUES
      ('55555555-5555-5555-5555-555555555551', 'practice-a', 'https://osod.dev/catalog/frames/SKU-1',
       4, 'Board A', 'active', 18900, 8900, 1, 'practice-admin', 'audit-inv-1'),
      ('55555555-5555-5555-5555-555555555552', 'practice-a', 'https://osod.dev/catalog/frames/SKU-2',
       2, 'Board B', 'active', 16900, 7900, 1, 'practice-admin', 'audit-inv-2');

    INSERT INTO osod_terminology_hcpcs (
      code, display, description, category, active, effective_from, metadata,
      version, source_version, audit_event_id
    ) VALUES
      ('V2020', 'Frames, purchases', 'Frame base allowance', 'frames', true, '2026-04-01', '{"laterality_exempt": true}', '2026-Q2', 'CMS 2026-Q2', 'audit-hcpcs-v2020'),
      ('V2025', 'Deluxe frame', 'Deluxe frame delta', 'frames', true, '2026-04-01', '{"laterality_exempt": true}', '2026-Q2', 'CMS 2026-Q2', 'audit-hcpcs-v2025'),
      ('V2600', 'Hand-held low vision aid', 'Frame-adjacent laterality exemption fixture', 'frames', true, '2026-04-01', '{"laterality_exempt": true}', '2026-Q2', 'CMS 2026-Q2', 'audit-hcpcs-v2600');
  `);
}

function snapshotTables(): Record<string, { count: number; hash: string }> {
  return Object.fromEntries(v06aTables.map((table) => {
    const [count, hash] = psql(`
      SELECT count(*)::text || '|' || COALESCE(
        md5(string_agg(row_to_json(t)::text, E'\\n' ORDER BY row_to_json(t)::text)),
        md5('')
      )
      FROM (SELECT * FROM ${table}) t;
    `).split("|");
    return [table, { count: Number(count), hash: hash ?? "" }];
  }));
}

function verifyIntegrity(
  before: Record<string, { count: number; hash: string }>,
  after: Record<string, { count: number; hash: string }>,
): { passed: number; total: number } {
  let passed = 0;
  for (const table of v06aTables) {
    if (before[table]?.count === after[table]?.count && before[table]?.hash === after[table]?.hash) {
      passed += 1;
      continue;
    }
    throw new Error(`v0.6a DR integrity failed for ${table}: before=${JSON.stringify(before[table])} after=${JSON.stringify(after[table])}`);
  }
  return { passed, total: v06aTables.length };
}

function runCanonicalChecks(label: string): { passed: number; total: number } {
  const checks: Array<[string, string]> = [
    ["sync_runs table exists", "SELECT to_regclass('public.osod_catalog_sync_runs') IS NOT NULL"],
    ["overlays table exists", "SELECT to_regclass('public.osod_catalog_overlays') IS NOT NULL"],
    ["frames table exists", "SELECT to_regclass('public.osod_frames_catalog') IS NOT NULL"],
    ["inventory table exists", "SELECT to_regclass('public.osod_practice_frames_inventory') IS NOT NULL"],
    ["hcpcs table exists", "SELECT to_regclass('public.osod_terminology_hcpcs') IS NOT NULL"],
    ["active inventory view exists", "SELECT to_regclass('public.osod_practice_frames_inventory_active') IS NOT NULL"],
    ["frames sync mode bulk", "SELECT bool_and(sync_mode = 'bulk') FROM osod_catalog_sync_runs WHERE catalog_type = 'frames'"],
    ["frames cursor null", "SELECT bool_and(cursor_high_water IS NULL) FROM osod_catalog_sync_runs WHERE catalog_type = 'frames'"],
    ["closed runs have source_version", "SELECT bool_and(source_version IS NOT NULL) FROM osod_catalog_sync_runs WHERE completed_at IS NOT NULL"],
    ["overlay rls enabled", "SELECT relrowsecurity FROM pg_class WHERE relname = 'osod_catalog_overlays'"],
    ["overlay force rls", "SELECT relforcerowsecurity FROM pg_class WHERE relname = 'osod_catalog_overlays'"],
    ["inventory rls enabled", "SELECT relrowsecurity FROM pg_class WHERE relname = 'osod_practice_frames_inventory'"],
    ["inventory force rls", "SELECT relforcerowsecurity FROM pg_class WHERE relname = 'osod_practice_frames_inventory'"],
    ["overlay practice policy", "SELECT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'osod_catalog_overlays' AND qual LIKE '%osod.practice_id%')"],
    ["inventory practice policy", "SELECT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'osod_practice_frames_inventory' AND qual LIKE '%osod.practice_id%')"],
    ["frames payload trigger", "SELECT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'osod_frames_catalog_block_payload_update_trigger')"],
    ["sync close trigger", "SELECT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'osod_catalog_sync_runs_block_update_trigger')"],
    ["retire function exists", "SELECT to_regprocedure('public.osod_frames_catalog_retire(uuid,timestamp with time zone,uuid,text)') IS NOT NULL"],
    ["active unique index exists", "SELECT EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'idx_frames_catalog_sku_active_unique')"],
    ["one retired version exists", "SELECT count(*) = 1 FROM osod_frames_catalog WHERE effective_to IS NOT NULL"],
    ["two active versions exist", "SELECT count(*) = 2 FROM osod_frames_catalog WHERE effective_to IS NULL"],
    ["active view joins inventory", "SELECT count(*) = 2 FROM osod_practice_frames_inventory_active"],
    ["gtin14 zero padded", "SELECT bool_and(gtin14 ~ '^[0-9]{14}$') FROM osod_frames_catalog WHERE gtin14 IS NOT NULL"],
    ["publicity class surfaced", "SELECT bool_and(publicity_class IN ('staff_only','no_public_price','open')) FROM osod_frames_catalog"],
    ["inventory nonnegative", "SELECT bool_and(qty_on_hand >= 0 AND COALESCE(practice_sale_price_cents,0) >= 0) FROM osod_practice_frames_inventory"],
    ["overlay canonical join key", "SELECT bool_and(catalog_canonical_url LIKE 'https://osod.dev/catalog/frames/%') FROM osod_catalog_overlays"],
    ["hcpcs three rows", "SELECT count(*) = 3 FROM osod_terminology_hcpcs WHERE code IN ('V2020','V2025','V2600')"],
    ["hcpcs laterality exempt", "SELECT bool_and((metadata->>'laterality_exempt')::boolean) FROM osod_terminology_hcpcs WHERE code IN ('V2020','V2025','V2600')"],
    ["event type frames bulk", "SELECT pg_get_constraintdef(oid) LIKE '%catalog_sync.frames.bulk.upserted%' FROM pg_constraint WHERE conname = 'osod_audit_events_event_type_check'"],
    ["event type hcpcs", "SELECT pg_get_constraintdef(oid) LIKE '%catalog_sync.hcpcs.delta.upserted%' FROM pg_constraint WHERE conname = 'osod_audit_events_event_type_check'"],
    ["event type csv export", "SELECT pg_get_constraintdef(oid) LIKE '%catalog.frames.export.csv%' FROM pg_constraint WHERE conname = 'osod_audit_events_event_type_check'"],
    ["event type subscription toggled", "SELECT pg_get_constraintdef(oid) LIKE '%practice.frames-data-subscription.toggled%' FROM pg_constraint WHERE conname = 'osod_audit_events_event_type_check'"],
  ];

  let passed = 0;
  for (const [name, query] of checks) {
    const result = psql(query).trim();
    if (result !== "t") {
      throw new Error(`v0.6a DR canonical check failed (${label}): ${name} -> ${result}`);
    }
    passed += 1;
  }
  return { passed, total: checks.length };
}

function sql(statement: string): void {
  run("psql", ["-v", "ON_ERROR_STOP=1", postgresUrl, "-c", statement]);
}

function psql(statement: string): string {
  return run("psql", ["-v", "ON_ERROR_STOP=1", "-At", postgresUrl, "-c", statement]).trim();
}

function run(command: string, args: readonly string[]): string {
  return execFileSync(command, [...args], {
    cwd: resolve(process.cwd()),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}
