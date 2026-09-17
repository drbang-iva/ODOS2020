import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { PgEducationCatalogSnapshotStore } from '../src/comms/education-catalog-snapshot-store.js';

const postgresUrl = process.env.ODOS_POSTGRES_URL
  ?? 'postgresql://medplum:medplum@127.0.0.1:5433/medplum';

test('snapshot persistence keeps accepted evidence and local copy unchanged on refusal and 304', async () => {
  const store = new PgEducationCatalogSnapshotStore({ postgresUrl });
  const practiceId = `store-${randomUUID()}`;
  const envelope = JSON.parse(readFileSync(new URL('./fixtures/visionforge-education-catalog/catalog.body', import.meta.url), 'utf8'));
  const localCopy = envelope.entries.map((entry: object) => ({ ...entry, absentUpstream: false, asOf: envelope.asOf }));
  try {
    assert.equal(await store.load(practiceId), undefined);
    await store.recordAttempt(practiceId, { at: '2026-09-17T10:00:00.000Z', outcome: 'refused', refusalCode: 'practice-mismatch' });
    assert.equal(await store.load(practiceId), undefined);
    await store.accept({ practiceId, envelope, localCopy, etag: '"snapshot"', asOf: envelope.asOf, acceptedAt: '2026-09-17T10:01:00.000Z' });
    const accepted = await store.load(practiceId);
    assert.ok(accepted);
    assert.deepEqual(accepted.localCopy, localCopy);
    assert.deepEqual(accepted.envelope, envelope);
    for (const [outcome, refusalCode] of [['refused', 'meaning-changed'], ['not-modified', null]] as const) {
      await store.recordAttempt(practiceId, { at: '2026-09-17T10:02:00.000Z', outcome, refusalCode });
      const next = await store.load(practiceId);
      assert.deepEqual(next?.envelope, accepted.envelope);
      assert.deepEqual(next?.localCopy, accepted.localCopy);
      assert.equal(next?.etag, accepted.etag);
      assert.equal(next?.acceptedAt, accepted.acceptedAt);
      assert.equal(next?.lastAttemptOutcome, outcome);
      assert.equal(next?.lastRefusalCode, refusalCode);
    }
    const restarted = new PgEducationCatalogSnapshotStore({ postgresUrl });
    try { assert.deepEqual((await restarted.load(practiceId))?.localCopy, localCopy); }
    finally { await restarted.close(); }
  } finally { await store.close(); }
});
