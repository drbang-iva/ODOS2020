import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { stripTypeScriptTypes } from 'node:module';

const expected = 'b217714c2f8963a3c87d537fd00910133257c2a8';
const ref = execFileSync('git', ['rev-parse', 'origin/main'], { encoding: 'utf8' }).trim();
assert.equal(ref, expected, 'The premise probe is bound to the kickoff base.');
const file = 'mcp/src/clinical-graph/finding-section-group-store.ts';
const source = execFileSync('git', ['show', `origin/main:${file}`], { encoding: 'utf8' });
const javascript = stripTypeScriptTypes(source, { mode: 'transform' });
const { FhirFindingSectionGroupStore, buildFindingSectionGroupResource } = await import(
  `data:text/javascript;base64,${Buffer.from(javascript).toString('base64')}`
);
const group = { id: 's3a-premise-group', groupKey: 's3a-premise-group', label: 'Synthetic group', sectionKeyPrefixes: ['synthetic:'], active: true };

const creations = [];
const emptyFhir = {
  async search() { return { resourceType: 'Bundle', entry: [] }; },
  async create(resource, headers) {
    creations.push({ resource, headers });
    return { ...resource, id: `synthetic-${creations.length}`, meta: { versionId: '1' } };
  },
};
const emptyStore = new FhirFindingSectionGroupStore(emptyFhir, []);
await Promise.all([emptyStore.create(group), emptyStore.create(group)]);
assert.equal(creations.length, 2);
assert.ok(creations.every(({ headers }) => !headers['If-None-Exist'] && !headers['If-Match']));

const firstOverlays = [];
const overlayStore = new FhirFindingSectionGroupStore({
  ...emptyFhir,
  async create(resource, headers) {
    firstOverlays.push({ resource, headers });
    return { ...resource, id: `overlay-${firstOverlays.length}`, meta: { versionId: '1' } };
  },
}, [group]);
await Promise.all([overlayStore.save(group), overlayStore.save(group)]);
assert.equal(firstOverlays.length, 2);
assert.ok(firstOverlays.every(({ headers }) => !headers['If-None-Exist'] && !headers['If-Match']));

let stored = { ...buildFindingSectionGroupResource(group), id: 'stored-group', meta: { versionId: '1' } };
const updates = [];
const store = new FhirFindingSectionGroupStore({
  async search() { return { resourceType: 'Bundle', entry: [{ resource: structuredClone(stored) }] }; },
  async update(_type, _id, resource, headers) {
    assert.equal(headers['If-Match'], `W/"${stored.meta.versionId}"`);
    updates.push(headers);
    stored = { ...resource, meta: { versionId: String(Number(stored.meta.versionId) + 1) } };
    return stored;
  },
}, []);
const staleClientCopy = (await store.list())[0];
assert.equal(Object.hasOwn(staleClientCopy, 'versionId'), false);
stored = { ...buildFindingSectionGroupResource({ ...group, label: 'Other editor saved' }), id: 'stored-group', meta: { versionId: '2' } };
const saved = await store.save({ ...staleClientCopy, label: 'Stale client overwrote' });
assert.equal(saved.label, 'Stale client overwrote');
assert.equal(updates[0]['If-Match'], 'W/"2"');

console.log(JSON.stringify({
  base: ref,
  source: file,
  sourceSha256: createHash('sha256').update(source).digest('hex'),
  scope: 'In-memory probe of the exact origin/main module; no server or practice data.',
  concurrentNewKey: { acceptedCreates: creations.length, conditionalHeaders: false },
  concurrentFirstSeedOverlay: { acceptedCreates: firstOverlays.length, conditionalHeaders: false },
  staleClientEdit: { accepted: true, versionExposedToClient: false, updateIfMatch: updates[0]['If-Match'] },
  conclusion: 'P1 guards an existing-resource update after the store read; it does not guard creates or a stale Settings client version.',
}, null, 2));
