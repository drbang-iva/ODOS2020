import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { Client } from "pg";
import { createLiveOdosAuditRuntime } from "../src/authz/liveAudit.js";
import { ODOS_AUDIT_EVENT_TYPES } from "../src/authz/odosAudit.js";

const AUDIT_MIGRATION_FILENAMES = [
  "2026-04-29-v05b-odos-audit-events.sql",
  "2026-05-01-v055a-smart-events.sql",
  "2026-05-01-v055a-smart-clients.sql",
  "2026-05-01-v055a-smart-scope-decisions.sql",
  "2026-05-01-v055b-smart-events.sql",
  "2026-05-01-v055b-smart-app-installations.sql",
  "2026-05-02-v055c-cds-events.sql",
  "2026-05-02-v055c-cds-feedback.sql",
  "2026-05-02-v055c-cds-service-keys.sql",
  "2026-05-04-v055d-agentops-records.sql",
  "2026-05-04-v055d-agentops-events.sql",
  "2026-05-05-v055e-bulk-data-events.sql",
  "2026-05-09-v06a-frames-data.sql",
  "2026-07-09-era-worklist-events.sql",
  "2026-07-09-claim-rejected-event.sql",
  "2026-07-10-manual-eob-event.sql",
  "2026-07-10-payment-credit-event.sql",
  "2026-07-10-phase7a-insurance-audit-events.sql",
  "2026-07-12-staff-invite-event.sql",
  "2026-07-15-era-line-linkage-event.sql",
  "2026-07-17-weno-pharmacy-directory.sql",
  "2026-07-17-weno-drug-database.sql",
  "2026-07-15-era-line-linkage-event.validate.sql",
  "2026-07-18-commercial-engine-schema.sql",
  "2026-07-18-commercial-engine-redemption-recovery.sql",
  "2026-07-18-commercial-engine-credit-bank.sql",
] as const;
const VALIDATE_MIGRATION_FILENAME = "2026-07-15-era-line-linkage-event.validate.sql";
const COMMERCIAL_MIGRATION_FILENAMES = AUDIT_MIGRATION_FILENAMES.slice(-3);

async function installMigrationTrace(probe: Client): Promise<void> {
  const ledgerDdlPath = fileURLToPath(
    new URL("../../data/migrations/2026-07-17-odos-schema-migrations.sql", import.meta.url),
  );
  await probe.query(await readFile(ledgerDdlPath, "utf8"));
  await probe.query(`
    CREATE TABLE odos_schema_migration_test_trace (
      filename TEXT NOT NULL,
      transaction_id BIGINT NOT NULL
    );

    CREATE FUNCTION odos_trace_schema_migration_insert()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $$
    BEGIN
      INSERT INTO odos_schema_migration_test_trace (filename, transaction_id)
      VALUES (NEW.filename, txid_current());
      RETURN NEW;
    END;
    $$;

    CREATE TRIGGER odos_trace_schema_migration_insert_trigger
      AFTER INSERT ON odos_schema_migrations
      FOR EACH ROW
      EXECUTE FUNCTION odos_trace_schema_migration_insert();
  `);
}

test("live audit boot schema matches every supported audit event type", async (t) => {
  const adminUrl = process.env.ODOS_POSTGRES_URL;
  if (!adminUrl) {
    t.skip("ODOS_POSTGRES_URL is required for the live Postgres audit schema fixture.");
    return;
  }

  const databaseName = `odos_audit_manifest_${randomUUID().replaceAll("-", "")}`;
  const testUrl = new URL(adminUrl);
  testUrl.pathname = `/${databaseName}`;
  const admin = new Client({ connectionString: adminUrl });
  const probe = new Client({ connectionString: testUrl.toString() });
  const audit = createLiveOdosAuditRuntime({ postgresUrl: testUrl.toString() });
  let probeConnected = false;

  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE ${databaseName} TEMPLATE template0`);
    await audit.queryRows({ limit: 1 });
    await probe.connect();
    probeConnected = true;

    const result = await probe.query<{ definition: string }>(`
      SELECT pg_get_constraintdef(oid) AS definition
      FROM pg_constraint
      WHERE conrelid = 'odos_audit_events'::regclass
        AND conname = 'odos_audit_events_event_type_check'
    `);
    assert.equal(result.rowCount, 1);

    const eventTypes = [
      ...result.rows[0].definition.matchAll(/'((?:''|[^'])*)'::text/g),
    ].map((match) => match[1].replaceAll("''", "'"));
    assert.equal(eventTypes.length, ODOS_AUDIT_EVENT_TYPES.length);
    assert.deepEqual(eventTypes, [...ODOS_AUDIT_EVENT_TYPES]);
  } finally {
    if (probeConnected) {
      await probe.end();
    }
    await audit.close();
    await admin.query(`DROP DATABASE IF EXISTS ${databaseName} WITH (FORCE)`);
    await admin.end();
  }
});

test("live audit boot backfills a restored pre-ledger schema without replaying it", async (t) => {
  const adminUrl = process.env.ODOS_POSTGRES_URL;
  if (!adminUrl) {
    t.skip("ODOS_POSTGRES_URL is required for the live Postgres audit schema fixture.");
    return;
  }

  const databaseName = `odos_audit_restore_${randomUUID().replaceAll("-", "")}`;
  const testUrl = new URL(adminUrl);
  testUrl.pathname = `/${databaseName}`;
  const admin = new Client({ connectionString: adminUrl });
  const probe = new Client({ connectionString: testUrl.toString() });
  let audit = createLiveOdosAuditRuntime({ postgresUrl: testUrl.toString() });
  let probeConnected = false;

  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE ${databaseName} TEMPLATE template0`);
    await probe.connect();
    probeConnected = true;

    for (const filename of AUDIT_MIGRATION_FILENAMES.filter(
      (candidate) => candidate !== VALIDATE_MIGRATION_FILENAME,
    )) {
      const path = fileURLToPath(new URL(`../../data/migrations/${filename}`, import.meta.url));
      await probe.query(await readFile(path, "utf8"));
    }
    await probe.query(`
      INSERT INTO odos_audit_events (event_type, action_outcome)
      VALUES ('era.line-linkage.flagged', 'granted')
    `);

    const rows = await audit.queryRows({ limit: 1 });
    assert.equal(rows[0].eventType, "era.line-linkage.flagged");

    const ledger = await probe.query<{ filename: string }>(`
      SELECT filename
      FROM odos_schema_migrations
      ORDER BY filename
    `);
    assert.deepEqual(
      ledger.rows.map((row) => row.filename),
      [...AUDIT_MIGRATION_FILENAMES].sort(),
    );

    const validation = await probe.query<{ convalidated: boolean }>(`
      SELECT convalidated
      FROM pg_constraint
      WHERE conrelid = 'odos_audit_events'::regclass
        AND conname = 'odos_audit_events_event_type_check'
    `);
    assert.equal(validation.rows[0].convalidated, true);

    await audit.close();
    audit = createLiveOdosAuditRuntime({ postgresUrl: testUrl.toString() });
    const restartedRows = await audit.queryRows({ limit: 1 });
    assert.equal(restartedRows[0].eventType, "era.line-linkage.flagged");
  } finally {
    if (probeConnected) {
      await probe.end();
    }
    await audit.close();
    await admin.query(`DROP DATABASE IF EXISTS ${databaseName} WITH (FORCE)`);
    await admin.end();
  }
});

test("live audit boot backfills a partially populated ledger without replaying legacy migrations", async (t) => {
  const adminUrl = process.env.ODOS_POSTGRES_URL;
  if (!adminUrl) {
    t.skip("ODOS_POSTGRES_URL is required for the live Postgres audit schema fixture.");
    return;
  }

  const databaseName = `odos_audit_partial_ledger_${randomUUID().replaceAll("-", "")}`;
  const testUrl = new URL(adminUrl);
  testUrl.pathname = `/${databaseName}`;
  const admin = new Client({ connectionString: adminUrl });
  const probe = new Client({ connectionString: testUrl.toString() });
  const audit = createLiveOdosAuditRuntime({ postgresUrl: testUrl.toString() });
  let probeConnected = false;

  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE ${databaseName} TEMPLATE template0`);
    await probe.connect();
    probeConnected = true;

    for (const filename of AUDIT_MIGRATION_FILENAMES) {
      const path = fileURLToPath(new URL(`../../data/migrations/${filename}`, import.meta.url));
      await probe.query(await readFile(path, "utf8"));
    }
    await probe.query(`
      INSERT INTO odos_audit_events (event_type, action_outcome)
      VALUES ('payment.charge.completed', 'granted')
    `);
    await installMigrationTrace(probe);
    for (const filename of COMMERCIAL_MIGRATION_FILENAMES) {
      await probe.query("INSERT INTO odos_schema_migrations (filename) VALUES ($1)", [filename]);
    }
    await probe.query("TRUNCATE odos_schema_migration_test_trace");

    const constraintBefore = await probe.query<{
      oid: string;
      definition: string;
      convalidated: boolean;
    }>(`
      SELECT oid::text, pg_get_constraintdef(oid) AS definition, convalidated
      FROM pg_constraint
      WHERE conrelid = 'odos_audit_events'::regclass
        AND conname = 'odos_audit_events_event_type_check'
    `);

    const rows = await audit.queryRows({ limit: 1 });
    assert.equal(rows[0].eventType, "payment.charge.completed");

    const ledger = await probe.query<{ filename: string }>(`
      SELECT filename
      FROM odos_schema_migrations
      ORDER BY filename
    `);
    assert.deepEqual(
      ledger.rows.map((row) => row.filename),
      [...AUDIT_MIGRATION_FILENAMES].sort(),
    );
    const constraintAfter = await probe.query<{
      oid: string;
      definition: string;
      convalidated: boolean;
    }>(`
      SELECT oid::text, pg_get_constraintdef(oid) AS definition, convalidated
      FROM pg_constraint
      WHERE conrelid = 'odos_audit_events'::regclass
        AND conname = 'odos_audit_events_event_type_check'
    `);
    assert.deepEqual(constraintAfter.rows, constraintBefore.rows);
    assert.equal(constraintAfter.rows[0].convalidated, true);

    const trace = await probe.query<{ filename: string }>(`
      SELECT filename
      FROM odos_schema_migration_test_trace
      ORDER BY filename
    `);
    assert.deepEqual(
      trace.rows.map((row) => row.filename),
      AUDIT_MIGRATION_FILENAMES.filter(
        (filename) => !COMMERCIAL_MIGRATION_FILENAMES.includes(filename),
      ).sort(),
    );
  } finally {
    if (probeConnected) {
      await probe.end();
    }
    await audit.close();
    await admin.query(`DROP DATABASE IF EXISTS ${databaseName} WITH (FORCE)`);
    await admin.end();
  }
});

test("live audit boot applies a genuinely absent migration instead of marking it applied", async (t) => {
  const adminUrl = process.env.ODOS_POSTGRES_URL;
  if (!adminUrl) {
    t.skip("ODOS_POSTGRES_URL is required for the live Postgres audit schema fixture.");
    return;
  }

  const databaseName = `odos_audit_missing_migration_${randomUUID().replaceAll("-", "")}`;
  const testUrl = new URL(adminUrl);
  testUrl.pathname = `/${databaseName}`;
  const admin = new Client({ connectionString: adminUrl });
  const probe = new Client({ connectionString: testUrl.toString() });
  const audit = createLiveOdosAuditRuntime({ postgresUrl: testUrl.toString() });
  let probeConnected = false;

  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE ${databaseName} TEMPLATE template0`);
    await probe.connect();
    probeConnected = true;

    const missingMigration = "2026-07-17-weno-drug-database.sql";
    for (const filename of AUDIT_MIGRATION_FILENAMES.filter(
      (candidate) => candidate !== missingMigration,
    )) {
      const path = fileURLToPath(new URL(`../../data/migrations/${filename}`, import.meta.url));
      await probe.query(await readFile(path, "utf8"));
    }
    await installMigrationTrace(probe);
    for (const filename of COMMERCIAL_MIGRATION_FILENAMES) {
      await probe.query("INSERT INTO odos_schema_migrations (filename) VALUES ($1)", [filename]);
    }
    await probe.query("TRUNCATE odos_schema_migration_test_trace");

    const before = await probe.query<{ exists: boolean }>(
      "SELECT to_regclass('odos_weno_drug_database') IS NOT NULL AS exists",
    );
    assert.equal(before.rows[0].exists, false);

    await audit.queryRows({ limit: 1 });

    const after = await probe.query<{ exists: boolean }>(
      "SELECT to_regclass('odos_weno_drug_database') IS NOT NULL AS exists",
    );
    assert.equal(after.rows[0].exists, true);
    const ledger = await probe.query<{ filename: string }>(
      "SELECT filename FROM odos_schema_migrations ORDER BY filename",
    );
    assert.deepEqual(
      ledger.rows.map((row) => row.filename),
      [...AUDIT_MIGRATION_FILENAMES].sort(),
    );
    const trace = await probe.query<{ filename: string }>(
      "SELECT filename FROM odos_schema_migration_test_trace",
    );
    assert.equal(trace.rows.some((row) => row.filename === missingMigration), true);
  } finally {
    if (probeConnected) {
      await probe.end();
    }
    await audit.close();
    await admin.query(`DROP DATABASE IF EXISTS ${databaseName} WITH (FORCE)`);
    await admin.end();
  }
});

test("live audit backfill leaves a NOT VALID migration for the normal loop", async (t) => {
  const adminUrl = process.env.ODOS_POSTGRES_URL;
  if (!adminUrl) {
    t.skip("ODOS_POSTGRES_URL is required for the live Postgres audit schema fixture.");
    return;
  }

  const databaseName = `odos_audit_not_valid_${randomUUID().replaceAll("-", "")}`;
  const testUrl = new URL(adminUrl);
  testUrl.pathname = `/${databaseName}`;
  const admin = new Client({ connectionString: adminUrl });
  const probe = new Client({ connectionString: testUrl.toString() });
  const audit = createLiveOdosAuditRuntime({ postgresUrl: testUrl.toString() });
  let probeConnected = false;

  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE ${databaseName} TEMPLATE template0`);
    await probe.connect();
    probeConnected = true;

    for (const filename of AUDIT_MIGRATION_FILENAMES) {
      const path = fileURLToPath(new URL(`../../data/migrations/${filename}`, import.meta.url));
      await probe.query(await readFile(path, "utf8"));
    }
    const constraint = await probe.query<{ definition: string }>(`
      SELECT pg_get_constraintdef(oid) AS definition
      FROM pg_constraint
      WHERE conrelid = 'odos_audit_events'::regclass
        AND conname = 'odos_audit_events_event_type_check'
    `);
    await probe.query(`
      ALTER TABLE odos_audit_events
        DROP CONSTRAINT odos_audit_events_event_type_check;
      ALTER TABLE odos_audit_events
        ADD CONSTRAINT odos_audit_events_event_type_check
        ${constraint.rows[0].definition} NOT VALID;
    `);
    await installMigrationTrace(probe);

    await audit.queryRows({ limit: 1 });

    const ledger = await probe.query<{ filename: string }>(`
      SELECT filename
      FROM odos_schema_migrations
      ORDER BY filename
    `);
    assert.deepEqual(
      ledger.rows.map((row) => row.filename),
      [...AUDIT_MIGRATION_FILENAMES].sort(),
    );
    const validation = await probe.query<{ convalidated: boolean }>(`
      SELECT convalidated
      FROM pg_constraint
      WHERE conrelid = 'odos_audit_events'::regclass
        AND conname = 'odos_audit_events_event_type_check'
    `);
    assert.equal(validation.rows[0].convalidated, true);

    const trace = await probe.query<{ filename: string; transaction_id: string }>(`
      SELECT filename, transaction_id::text
      FROM odos_schema_migration_test_trace
    `);
    const validateTrace = trace.rows.find((row) => row.filename === VALIDATE_MIGRATION_FILENAME);
    assert.ok(validateTrace);
    assert.equal(
      new Set(trace.rows.map((row) => row.transaction_id)).size,
      AUDIT_MIGRATION_FILENAMES.length,
    );
  } finally {
    if (probeConnected) {
      await probe.end();
    }
    await audit.close();
    await admin.query(`DROP DATABASE IF EXISTS ${databaseName} WITH (FORCE)`);
    await admin.end();
  }
});
