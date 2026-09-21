import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Basic, Condition, Encounter } from '@medplum/fhirtypes';
import { loadVerifiedOperatorFhirClient } from '../../../../scripts/operator-identity.js';
import { createAuthenticatedFhirClient } from '../../../../scripts/r10-served-route/login.js';
import { FhirEncounterExamScopeStore } from '../../../../mcp/src/clinical-graph/exam-scope-store.js';
import { FhirFollowUpProfileStore } from '../../../../mcp/src/clinical-graph/follow-up-profile-store.js';
import { resolveProfileTests } from '../../../../mcp/src/clinical-graph/exam-overview-endpoint.js';
import { GLAUCOMA_SUSPECT_PROTOCOL } from '../../../../mcp/src/clinical-graph/protocol-fixtures.js';

const runtime = join(process.cwd(), '.odos/s3c2a-proof');
const read = (name: string) => JSON.parse(readFileSync(join(runtime, name), 'utf8'));
const { ports, project } = read('manifest.json'); assert.equal(project, 'odos-s3c2a-proof');
const credentials = read('credentials.json'), fixture = read('fixture.json');
const baseUrl = `http://127.0.0.1:${ports.medplum}`;
const { fhir } = await loadVerifiedOperatorFhirClient({ baseUrl, projectId: credentials.projectId,
  postgresUrl: `postgresql://medplum:medplum@127.0.0.1:${ports.postgres}/medplum`,
  credentialPath: join(runtime, 'operator.env'), statePath: join(runtime, 'operator-state.json'),
});
const { accessToken } = await createAuthenticatedFhirClient({ baseUrl, ...credentials.provider });
const actor = { reference: credentials.provider.practitionerReference };
const patientId = fixture.patientReference.slice(8);
const scopes = new FhirEncounterExamScopeStore(fhir), profiles = await new FhirFollowUpProfileStore(fhir).list();
async function visit() {
  const value = await fhir.create<Encounter>({ resourceType: 'Encounter', status: 'in-progress', class: { code: 'AMB' }, subject: { reference: fixture.patientReference }, period: { start: '2026-09-21T14:00:00Z' }, participant: [{ individual: actor }] });
  return value.id!;
}
async function api(path: string, body?: unknown) {
  const response = await fetch(`http://127.0.0.1:${ports.frontdoor}${path}`, { method: body ? 'POST' : 'GET', headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const result = { status: response.status, body: await response.json() };
  assert.equal(result.status, 200, JSON.stringify(result)); return result;
}
const visits = { glaucoma: await visit(), macula: await visit(), absent: await visit(), empty: await visit() };
for (const [key, profileKey] of [['glaucoma', 'glaucoma'], ['macula', 'macula-retina']] as const) {
  const profile = profiles.find(p => p.profileKey === profileKey)!;
  await scopes.shapeIfAbsent(visits[key], actor, async () => ({ profiles: [profile], testsProposed: resolveProfileTests([profile]) }));
}
await scopes.shapeIfAbsent(visits.empty, actor, async () => ({ profiles: [], testsProposed: [] }));
await fhir.create<Basic>({ resourceType: 'Basic', identifier: [{ system: 'urn:odos:encounter-exam-scope', value: visits.absent }],
  code: { coding: [{ system: 'urn:odos:encounter-exam-scope', code: 'exam-scope' }] }, subject: { reference: `Encounter/${visits.absent}` }, author: actor,
  extension: [{ url: 'urn:odos:encounter-exam-scope:value', valueString: JSON.stringify({ examScope: 'office-visit', setAt: '2026-09-21T14:00:00Z', profilesApplied: [], sectionsOpen: ['hpi', 'assessment'], shapedAt: '2026-09-21T14:00:00Z' }) }],
});
assert.equal(GLAUCOMA_SUSPECT_PROTOCOL.trigger.kind, 'diagnosis');
const code = GLAUCOMA_SUSPECT_PROTOCOL.trigger.kind === 'diagnosis' ? GLAUCOMA_SUSPECT_PROTOCOL.trigger.dxKeys[0] : '';
const diagnosis = await fhir.create<Condition>({ resourceType: 'Condition', subject: { reference: fixture.patientReference }, encounter: { reference: `Encounter/${visits.glaucoma}` }, verificationStatus: { coding: [{ code: 'confirmed' }] }, code: { coding: [{ code }], text: 'Synthetic seeded glaucoma plan diagnosis' } });
const added = await api('/clinical-graph/protocols/items/add', { protocolId: GLAUCOMA_SUSPECT_PROTOCOL.id, patientId, encounterId: visits.glaucoma, diagnosis: { reference: `Condition/${diagnosis.id}`, code, confirmed: true }, itemKey: 'order-fundus-photography' });
const responses: Record<string, any> = {}, stored: Record<string, unknown> = {};
for (const [name,id] of Object.entries(visits)) {
  responses[name] = await api(`/clinical-graph/encounters/${id}/follow-up-queue`);
  const result = await fhir.search<Basic>('Basic', { identifier: `urn:odos:encounter-exam-scope|${id}` });
  assert.equal(result.entry?.length, 1);
  stored[name] = JSON.parse(result.entry![0].resource!.extension!.find(e => e.url === 'urn:odos:encounter-exam-scope:value')!.valueString!);
}
assert.deepEqual(responses.glaucoma.body.rows.map((row: any) => row.state), ['for-review', 'for-review', 'already-ordered']);
assert.deepEqual(responses.macula.body.rows.map((row: any) => row.state), ['unavailable', 'for-review', 'unavailable']);
assert.deepEqual(responses.absent.body, { recorded: false });
assert.deepEqual(responses.empty.body, { recorded: true, rows: [] });
const evidence = { syntheticOnly: true, project, patientId, visits, orderRoute: '/clinical-graph/protocols/items/add', orderStatus: added.status, stored, responses };
writeFileSync('docs/build-log/followup-s3c2a-queue-view/live-proof.json', JSON.stringify(evidence, null, 2)+'\n');
writeFileSync(join(runtime, 'queue-visits.json'), JSON.stringify({ patientId, visits }, null, 2)+'\n');
console.log('Live queue: glaucoma 2 for-review + 1 already-ordered; macula 2 unavailable + 1 for-review; absent and empty distinct.');
