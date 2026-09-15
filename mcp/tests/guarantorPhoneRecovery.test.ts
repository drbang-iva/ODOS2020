import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { world, input, run, get, store, refused, setRefusal, journal, registerExisting } from './helpers/guarantor-phone-fixture.js';
for (const kind of ['attach', 'transfer', 'consolidate']) for (const toRefusal of [true, false]) test(`T5 ${kind} projects refusal=${toRefusal} and correction restores the required snapshot`, async () => {
  const f = await world(!toRefusal, toRefusal);
  if (kind === 'attach') store(f, { ...get(f, 'Person/S'), link: [{ target: { reference: 'RelatedPerson/r2' } }] });
  const ids = kind === 'consolidate' ? ['r1', 'r2'] : ['r1'];
  const result: any = await run(f, 'create', input(f, kind, ids));
  assert.equal(result.status, 200); assert.equal(result.body.task.status, 'completed');
  for (const id of ids) assert.equal(refused(get(f, `RelatedPerson/${id}`)), toRefusal);
  const lastTelecom = get(f, 'RelatedPerson/r1').telecom;
  const correction: any = await run(f, 'correct', { operationId: randomUUID(), reason: 'Synthetic correction' }, result.body.task.id);
  assert.equal(correction.status, 200); assert.equal(correction.body.task.status, 'completed');
  for (const id of ids) {
    assert.equal(refused(get(f, `RelatedPerson/${id}`)), kind === 'attach' ? toRefusal : !toRefusal);
    assert.deepEqual(f.owners(id), kind === 'attach' ? [] : ['S']);
  }
  if (kind === 'attach') assert.deepEqual(get(f, 'RelatedPerson/r1').telecom, lastTelecom);
});
test('T6 lost projecting reply plus competing refusal pauses interfered without domain writes', async () => {
  const f = await world(false, true); let lost = 0;
  f.afterWrite = async (w: any) => { if (!lost && w.actor.actionReason === 'guarantor.link projecting RelatedPerson/r1' && w.status === 200) { lost++; throw new Error('Committed reply lost'); } };
  const result: any = await run(f, 'create', input(f)); f.afterWrite = undefined;
  assert.equal(lost, 1);
  const pending = journal(f, result.body.task.id).find(i => !i.disposition);
  assert.equal(pending.phase, 'projecting');
  f.compete(pending.target, r => setRefusal(r, false));
  const offset = f.writes.length;
  const resumed: any = await run(f, 'complete', undefined, result.body.task.id);
  assert.equal(resumed.status, 409); assert.equal(resumed.body.phase, 'interfered');
  assert.equal(f.writes.slice(offset).filter(w => w.resource.resourceType !== 'Task').length, 0);
  assert.equal(refused(get(f, 'RelatedPerson/r1')), false);
});
test('T12 exact pre-C2 projecting journal resumes with no-refusal child', async () => {
  const fixture = JSON.parse(readFileSync(new URL('./fixtures/guarantor-pre-c2-journal.json', import.meta.url), 'utf8'));
  assert.equal(fixture.head, '02cdf89e0b964cb442bd42287c86435102fcccc9');
  const f = await world(false, false); f.data.clear();
  for (const resource of fixture.resources) store(f, resource);
  assert.equal(journal(f, fixture.taskId).find(i => !i.disposition).phase, 'projecting');
  const result: any = await run(f, 'complete', undefined, fixture.taskId);
  assert.equal(result.status, 200); assert.equal(result.body.task.status, 'completed');
  assert.deepEqual(f.owners('r1'), ['D']);
  assert.equal(refused(get(f, 'RelatedPerson/r1')), false);
});
for (const loss of ['none', 'registration'] as const) test(`T13 existing-guarantor initial child refusal before attach with ${loss} reply`, async () => {
  const result = await registerExisting(loss);
  assert.equal(result.status, 201); assert.equal(result.initialRefusal, true);
  assert.equal(result.finalRefusal, true); assert.equal(result.initialRoles.length, 3);
  assert.equal(result.linkStatus, 'linked'); assert.deepEqual(result.owners, ['D']);
});
test('T7 lost registration reply refuses to match a child whose refusal changed', async () => {
  const result = await registerExisting('registration', 'refusal');
  assert.equal(result.status, 201); assert.equal(result.linkStatus, 'unconfirmed');
  assert.equal(result.relatedIdRecovered, false); assert.deepEqual(result.owners, []);
});
