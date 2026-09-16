import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { privateDirectory, sourceRoot, refreshFixtureTokens, successfulHttp, createLiveClients, writeEvidence } from './live-fixture.mjs';

const fixture = await refreshFixtureTokens();
const fromSource = path => import(pathToFileURL(resolve(sourceRoot, path)).href);
const { listUnusedGuarantors, createGuarantor } = await fromSource('mcp/src/clinic/guarantor-search.ts');
const { audit, serviceFhir } = await createLiveClients(fixture);
const queries = [];
const deps = { serviceReference: fixture.serviceReference, recordAudit: row => audit.record(row, () => undefined), serviceFhir: {
  ...serviceFhir,
  searchProject: async (...args) => { const response = await serviceFhir.searchProject(...args); queries.push({ resourceType: args[0], params: args[2], ids: response.entry?.map(e => e.resource.id) ?? [], next: response.link?.find(l => l.relation === 'next')?.url }); return response; },
  searchProjectUrl: async (...args) => { const response = await serviceFhir.searchProjectUrl(...args); queries.push({ url: args[0], ids: response.entry?.map(e => e.resource.id) ?? [], next: response.link?.find(l => l.relation === 'next')?.url }); return response; },
} };
const staff = { staffReference: fixture.principals.composite.profileReference, actorRole: 'staff', businessActions: ['guarantor.link'], project: { reference: `Project/${fixture.projectA}` } };
const seedPath = resolve(privateDirectory, 'rev3-scale-seeds.json');
let seeds;
try {
  if (existsSync(seedPath)) seeds = JSON.parse(readFileSync(seedPath, 'utf8'));
  else {
    const linked = [];
    for (let offset = 0; offset < 1001; offset += 100) {
      const result = await successfulHttp(fixture, 'POST', '/fhir/R4', { body: { resourceType: 'Bundle', type: 'transaction', entry: Array.from({ length: Math.min(100, 1001 - offset) }, (_, i) => ({ request: { method: 'POST', url: 'Person' }, resource: { resourceType: 'Person', meta: { project: fixture.projectA }, active: true, name: [{ family: 'CleanupScaleSynthetic', given: [String(offset + i)] }], link: [{ target: { reference: `Patient/${fixture.patientId}` } }] } })) } });
      assert.ok(result.entry.every(e => /^201/.test(e.response.status)));
      linked.push(...result.entry.map(e => e.resource?.id ?? e.response.location.split('/')[1]));
    }
    const orphan = await createGuarantor(deps, staff, { firstName: 'ScaleOrphan', lastName: 'CleanupSynthetic', birthDate: '1980-01-02' });
    assert.equal(orphan.status, 201);
    seeds = { linked, orphan: orphan.body };
    writeFileSync(seedPath, JSON.stringify(seeds), { mode: 0o600 });
  }
  assert.equal(seeds.linked.length, 1001);
  const result = await listUnusedGuarantors(deps, staff);
  writeEvidence(`O13-${process.env.PROOF_STAGE ?? 'run'}.json`, { origin: fixture.baseUrl, linkedCount: seeds.linked.length, orphan: seeds.orphan, queries, result });
  console.log(JSON.stringify({ guard: 'O13', linked: seeds.linked.length, resultStatus: result.status, listed: Array.isArray(result.body) ? result.body.map(p => p.personId) : result.body, orphan: seeds.orphan.personId }));
  assert.equal(result.status, 200, 'O13 list succeeds with 1001 linked guarantors');
  assert.ok(result.body.some(p => p.personId === seeds.orphan.personId));
  assert.ok(result.body.every(p => !seeds.linked.includes(p.personId)));
} finally { await audit.close(); }
