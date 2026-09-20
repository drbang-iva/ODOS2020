import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import type { Basic, Encounter } from '@medplum/fhirtypes';
import { loadVerifiedOperatorFhirClient } from '../../../../scripts/operator-identity.js';
import { FhirEncounterExamScopeStore } from '../../../../mcp/src/clinical-graph/exam-scope-store.js';
import { searchAll } from '../../../../mcp/src/fhir-search.js';
const runtime = resolve('.odos/s3b1-proof');
const read = (name: string) => JSON.parse(readFileSync(join(runtime, name), 'utf8'));
const { project, ports } = read('manifest.json'); assert.equal(project, 'odos-s3b1-proof');
const credentials = read('credentials.json'), { patientId, visits } = read('shape-visits.json');
const { fhir } = await loadVerifiedOperatorFhirClient({ baseUrl: `http://127.0.0.1:${ports.medplum}`, projectId: credentials.projectId,
  postgresUrl: `postgresql://medplum:medplum@127.0.0.1:${ports.postgres}/medplum`, credentialPath: join(runtime, 'operator.env'), statePath: join(runtime, 'operator-state.json') });
const records = [];
for (const [label, id] of Object.entries(visits)) {
 const rows = await searchAll<Basic>(fhir, 'Basic', { identifier: `urn:odos:encounter-exam-scope|${id}` });
 assert.equal(rows.length, 1);
 const value = JSON.parse(rows[0].extension!.find(e => e.url === 'urn:odos:encounter-exam-scope:value')!.valueString!);
 if (label.endsWith('legacy')) assert.equal(value.shapedAt, undefined);
 else assert.equal(value.profilesApplied[0].profileKey, 'glaucoma');
 records.push({ label, rowCount: rows.length, versionId: rows[0].meta!.versionId, value });
}
const encounter = await fhir.create<Encounter>({ resourceType: 'Encounter', status: 'in-progress', class: { code: 'AMB' }, subject: { reference: `Patient/${patientId}` } });
const store = new FhirEncounterExamScopeStore(fhir);
const outcomes = await Promise.allSettled([store.set(encounter.id!, 'office-visit', { reference: credentials.provider.practitionerReference }, null), store.set(encounter.id!, 'office-visit', { reference: credentials.provider.practitionerReference }, null)]);
const rows = await searchAll<Basic>(fhir, 'Basic', { identifier: `urn:odos:encounter-exam-scope|${encounter.id}` });
assert.equal(rows.length, 1);
assert.equal(outcomes.filter(r => r.status === 'fulfilled').length, 1);
assert.equal(outcomes.filter(r => r.status === 'rejected').length, 1);
writeFileSync('docs/build-log/followup-s3b1-shape-record/stored-records.json', JSON.stringify({ records, concurrentCreate: { rowCount: rows.length, fulfilled: 1, rejected: 1 } }, null, 2)+'\n');
console.log('6 stored records inspected; real concurrent creates: 1 persisted row, 1 success, 1 refusal.');
