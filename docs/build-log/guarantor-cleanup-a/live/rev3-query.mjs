import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { refreshFixtureTokens, successfulHttp, writeEvidence } from './live-fixture.mjs';

const fixture = await refreshFixtureTokens();
const marker = `CleanupQuery${randomUUID().replaceAll('-', '')}`;
const make = resource => successfulHttp(fixture, 'POST', `/fhir/R4/${resource.resourceType}`, {
  body: { ...resource, meta: { project: fixture.projectA } }, scenario: 'rev3-query',
});
const patient = await make({ resourceType: 'Patient', name: [{ family: marker }] });
const child = await make({ resourceType: 'RelatedPerson', patient: { reference: `Patient/${patient.id}` } });
const seeds = [];
for (const [label, link] of [
  ['omitted', undefined], ['empty', []],
  ['related-person', [{ target: { reference: `RelatedPerson/${child.id}` } }]],
  ['patient', [{ target: { reference: `Patient/${patient.id}` } }]],
]) seeds.push({ label, resource: await make({ resourceType: 'Person', active: true, name: [{ family: marker, given: [label] }], ...(link ? { link } : {}) }) });
const query = `/fhir/R4/Person?${new URLSearchParams({ _id: seeds.map(s => s.resource.id).join(','), 'link:missing': 'true', _count: '100' })}`;
const result = await successfulHttp(fixture, 'GET', query, { scenario: 'rev3-query' });
const actual = (result.entry ?? []).map(e => e.resource.id).sort();
const expected = seeds.filter(s => !s.resource.link?.length).map(s => s.resource.id).sort();
const evidence = { query, medplum: fixture.baseUrl, seeds: seeds.map(s => ({ label: s.label, id: s.resource.id, links: s.resource.link ?? [] })), expected, actual, result };
writeEvidence('rev3-query.json', evidence);
console.log(JSON.stringify({ query, expected, actual }));
assert.deepEqual(actual, expected, 'Server-side link:missing query returns exactly zero-link Persons');
