import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import type { Encounter } from '@medplum/fhirtypes';
import { loadVerifiedOperatorFhirClient } from '../../../../scripts/operator-identity.js';
const runtime = resolve('.odos/s3b3-proof');
const read = (name: string) => JSON.parse(readFileSync(join(runtime, name), 'utf8'));
const { project, ports } = read('manifest.json'); assert.equal(project, 'odos-s3b3-proof');
const credentials = read('credentials.json'), fixture = read('fixture.json');
const { fhir } = await loadVerifiedOperatorFhirClient({ baseUrl: `http://127.0.0.1:${ports.medplum}`, projectId: credentials.projectId,
  postgresUrl: `postgresql://medplum:medplum@127.0.0.1:${ports.postgres}/medplum`, credentialPath: join(runtime, 'operator.env'), statePath: join(runtime, 'operator-state.json') });
const visits: Record<string, string> = {};
for (const width of [1440, 390]) {
 const visit = await fhir.create<Encounter>({ resourceType: 'Encounter', status: 'in-progress', class: { code: 'AMB' }, subject: { reference: fixture.patientReference }, participant: [{ individual: { reference: credentials.provider.practitionerReference } }], period: { start: new Date().toISOString() } });
 visits[String(width)] = visit.id!;
}
writeFileSync(join(runtime, 'view-visits.json'), JSON.stringify({ patientId: fixture.patientReference.slice(8), visits }, null, 2)+'\n', { mode: 0o600 });
console.log('Seeded two synthetic view-state encounters.');
