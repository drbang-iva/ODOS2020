import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import type { Encounter, Condition, Basic } from '@medplum/fhirtypes';
import { loadVerifiedOperatorFhirClient } from '../../../../scripts/operator-identity.js';
import { DIAGNOSIS_KEY_IDENTIFIER_SYSTEM } from '../../../../mcp/src/clinical-graph/diagnosis-pick-endpoint.js';
const runtime = resolve('.odos/s3b1-proof');
const read = (name: string) => JSON.parse(readFileSync(join(runtime, name), 'utf8'));
const { project, ports } = read('manifest.json'); assert.equal(project, 'odos-s3b1-proof');
const credentials = read('credentials.json'), fixture = read('fixture.json');
const { fhir } = await loadVerifiedOperatorFhirClient({ baseUrl: `http://127.0.0.1:${ports.medplum}`, projectId: credentials.projectId,
  postgresUrl: `postgresql://medplum:medplum@127.0.0.1:${ports.postgres}/medplum`, credentialPath: join(runtime, 'operator.env'), statePath: join(runtime, 'operator-state.json') });
const visits: Record<string, string> = {};
for (const width of [1440, 390]) for (const kind of ['original', 'new', 'legacy']) {
  const visit = await fhir.create<Encounter>({ resourceType: 'Encounter', status: 'in-progress', class: { code: 'AMB' }, subject: { reference: fixture.patientReference },
    participant: [{ individual: { reference: credentials.provider.practitionerReference } }], period: { start: new Date().toISOString() } });
  assert.ok(visit.id);
  const diagnosis = await fhir.create<Condition>({ resourceType: 'Condition', subject: { reference: fixture.patientReference }, encounter: { reference: `Encounter/${visit.id}` },
    identifier: [{ system: DIAGNOSIS_KEY_IDENTIFIER_SYSTEM, value: `${visit.id}::ocular_hypertension::bilateral` }], code: { text: 'Synthetic glaucoma profile proof' } });
  await fhir.update('Encounter', visit.id, { ...visit, diagnosis: [{ condition: { reference: `Condition/${diagnosis.id}` } }] }, { 'If-Match': `W/"${visit.meta!.versionId}"` });
  visits[`${width}-${kind}`] = visit.id;
  if (kind === 'legacy') await fhir.create<Basic>({ resourceType: 'Basic',
    identifier: [{ system: 'urn:odos:encounter-exam-scope', value: visit.id }], code: { coding: [{ system: 'urn:odos:encounter-exam-scope', code: 'exam-scope' }] },
    subject: { reference: `Encounter/${visit.id}` }, author: { reference: credentials.provider.practitionerReference },
    extension: [{ url: 'urn:odos:encounter-exam-scope:value', valueString: JSON.stringify({ examScope: 'office-visit', setAt: '2026-09-19T12:00:00Z' }) }] });
}
writeFileSync(join(runtime, 'shape-visits.json'), JSON.stringify({ patientId: fixture.patientReference.slice(8), visits }, null, 2)+'\n', { mode: 0o600 });
console.log('Seeded 6 synthetic encounters with catalogue diagnosis identity; 2 carry legacy scope rows.');
