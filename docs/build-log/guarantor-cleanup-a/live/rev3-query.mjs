import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { refreshFixtureTokens, successfulHttp, http, writeEvidence } from './live-fixture.mjs';

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
const inactive = await make({ resourceType: 'Person', active: false, name: [{ family: marker, given: ['inactive'] }] });
const absent = await make({ resourceType: 'Person', name: [{ family: marker, given: ['active-absent'] }] });
const activeQuery = `/fhir/R4/Person?${new URLSearchParams({ _id: [...seeds.map(s => s.resource.id), inactive.id, absent.id].join(','), 'link:missing': 'true', 'active:not': 'false', _count: '100' })}`;
const activeExpected = [...expected, absent.id].sort();
const probes = [];
for (const query of [activeQuery, activeQuery.replace('active%3Anot=false', 'active=true')]) {
  const response = await http(fixture, 'GET', query, { scenario: 'rev3-active-query' });
  probes.push({ query, status: response.status, result: response.body });
  assert.equal(response.status, 400);
  assert.equal(response.body.issue[0].details.text, 'Unknown search parameter: active');
}
writeEvidence('rev3-active-query.json', { purpose: 'CodeRabbit active-filter proposal capability probe; no production filter change', inactive, absent, seeds: evidence.seeds, desiredIds: activeExpected, probes });
console.log(JSON.stringify({ probe: 'Person active filter', results: probes.map(p => ({ query: p.query, status: p.status, error: p.result.issue[0].details.text })) }));
