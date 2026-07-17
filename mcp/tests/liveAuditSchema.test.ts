import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { Client } from "pg";
import { createLiveOdosAuditRuntime } from "../src/authz/liveAudit.js";
import { ODOS_AUDIT_EVENT_TYPES } from "../src/authz/odosAudit.js";

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
