import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import type { Encounter } from '@medplum/fhirtypes';
import { loadVerifiedOperatorFhirClient } from '../../../../scripts/operator-identity.js';

const runtime = resolve('.odos/s2b2a-proof');
const read = (name: string) => JSON.parse(readFileSync(join(runtime, name), 'utf8'));
const manifest = read('manifest.json'), credentials = read('credentials.json'), fixture = read('fixture.json');
assert.equal(manifest.project, 'odos-s2b2a-proof');
const { fhir } = await loadVerifiedOperatorFhirClient({ baseUrl: `http://127.0.0.1:${manifest.ports.medplum}`, projectId: credentials.projectId,
  postgresUrl: `postgresql://medplum:medplum@127.0.0.1:${manifest.ports.postgres}/medplum`,
  credentialPath: join(runtime, 'operator.env'), statePath: join(runtime, 'operator-state.json'),
});
for (const key of ['collapse1440', 'collapse390', 'baselineRefresh']) {
  if (process.argv.includes('--fresh')) delete fixture[key];
  if (fixture[key]) continue;
  const encounter = await fhir.create<Encounter>({ resourceType: 'Encounter', status: 'in-progress', class: { code: 'AMB' },
    subject: { reference: fixture.patientReference }, period: { start: '2026-09-20T14:00:00Z' },
    type: [{ text: 'Synthetic collapse visit' }], participant: [{ individual: { reference: credentials.provider.practitionerReference } }],
  });
  fixture[key] = `Encounter/${encounter.id}`;
  writeFileSync(join(runtime, 'fixture.json'), JSON.stringify(fixture, null, 2) + '\n', { mode: 0o600 });
}
console.log('Synthetic comprehensive encounters ready.');
