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
  "2026-07-15-era-line-linkage-event-validate.sql",
] as const;

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

    for (const filename of AUDIT_MIGRATION_FILENAMES.slice(0, -1)) {
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

    const beforeValidation = await probe.query<{ convalidated: boolean }>(`
      SELECT convalidated
      FROM pg_constraint
      WHERE conrelid = 'odos_audit_events'::regclass
        AND conname = 'odos_audit_events_event_type_check'
    `);
    assert.equal(beforeValidation.rows[0].convalidated, false);

    await audit.close();
    await probe.query(
      "DELETE FROM odos_schema_migrations WHERE filename = $1",
      [AUDIT_MIGRATION_FILENAMES.at(-1)],
    );
    audit = createLiveOdosAuditRuntime({ postgresUrl: testUrl.toString() });
    await audit.queryRows({ limit: 1 });

    const afterValidation = await probe.query<{ convalidated: boolean }>(`
      SELECT convalidated
      FROM pg_constraint
      WHERE conrelid = 'odos_audit_events'::regclass
        AND conname = 'odos_audit_events_event_type_check'
    `);
    assert.equal(afterValidation.rows[0].convalidated, true);
    const addedMigration = await probe.query<{ applied: boolean }>(
      "SELECT EXISTS (SELECT 1 FROM odos_schema_migrations WHERE filename = $1) AS applied",
      [AUDIT_MIGRATION_FILENAMES.at(-1)],
    );
    assert.equal(addedMigration.rows[0].applied, true);
  } finally {
    if (probeConnected) {
      await probe.end();
    }
    await audit.close();
    await admin.query(`DROP DATABASE IF EXISTS ${databaseName} WITH (FORCE)`);
    await admin.end();
  }
});

test("live audit boot rejects a restored schema older than the current migration set", async (t) => {
  const adminUrl = process.env.ODOS_POSTGRES_URL;
  if (!adminUrl) {
    t.skip("ODOS_POSTGRES_URL is required for the live Postgres audit schema fixture.");
    return;
  }

  const databaseName = `odos_audit_stale_restore_${randomUUID().replaceAll("-", "")}`;
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

    for (const filename of AUDIT_MIGRATION_FILENAMES.slice(0, -2)) {
      const path = fileURLToPath(new URL(`../../data/migrations/${filename}`, import.meta.url));
      await probe.query(await readFile(path, "utf8"));
    }

    await assert.rejects(
      audit.queryRows({ limit: 1 }),
      new Error(
        "restored database predates this code's migration set; the ledger backfill cannot be trusted — restore a newer backup or apply migrations manually",
      ),
    );
    const ledger = await probe.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM odos_schema_migrations",
    );
    assert.equal(ledger.rows[0].count, "0");
  } finally {
    if (probeConnected) {
      await probe.end();
    }
    await audit.close();
    await admin.query(`DROP DATABASE IF EXISTS ${databaseName} WITH (FORCE)`);
    await admin.end();
  }
});
