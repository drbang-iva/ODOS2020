import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { Client } from "pg";
import { createLiveOsodAuditRuntime } from "../src/authz/liveAudit.js";
import { OSOD_AUDIT_EVENT_TYPES } from "../src/authz/osodAudit.js";

test("live audit boot schema matches every supported audit event type", async (t) => {
  const adminUrl = process.env.OSOD_POSTGRES_URL;
  if (!adminUrl) {
    t.skip("OSOD_POSTGRES_URL is required for the live Postgres audit schema fixture.");
    return;
  }

  const databaseName = `osod_audit_manifest_${randomUUID().replaceAll("-", "")}`;
  const testUrl = new URL(adminUrl);
  testUrl.pathname = `/${databaseName}`;
  const admin = new Client({ connectionString: adminUrl });
  const probe = new Client({ connectionString: testUrl.toString() });
  const audit = createLiveOsodAuditRuntime({ postgresUrl: testUrl.toString() });
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
      WHERE conrelid = 'osod_audit_events'::regclass
        AND conname = 'osod_audit_events_event_type_check'
    `);
    assert.equal(result.rowCount, 1);

    const eventTypes = [
      ...result.rows[0].definition.matchAll(/'((?:''|[^'])*)'::text/g),
    ].map((match) => match[1].replaceAll("''", "'"));
    assert.deepEqual(eventTypes, [...OSOD_AUDIT_EVENT_TYPES]);
  } finally {
    if (probeConnected) {
      await probe.end();
    }
    await audit.close();
    await admin.query(`DROP DATABASE IF EXISTS ${databaseName} WITH (FORCE)`);
    await admin.end();
  }
});
