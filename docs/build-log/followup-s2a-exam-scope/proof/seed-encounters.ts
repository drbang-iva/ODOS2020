import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { loadVerifiedOperatorFhirClient } from '../../../../scripts/operator-identity.js';
import { ODOS_VISIT_TYPE_SYSTEM } from '../../../../mcp/src/fhir/schedulingVisitType.js';
const runtime = resolve('.odos/s2a-proof');
const read = (name: string) => JSON.parse(readFileSync(join(runtime, name), 'utf8'));
const { ports } = read('manifest.json'), credentials = read('credentials.json'), fixture = read('fixture.json');
const { fhir } = await loadVerifiedOperatorFhirClient({ baseUrl: `http://127.0.0.1:${ports.medplum}`, projectId: credentials.projectId,
  postgresUrl: `postgresql://medplum:medplum@127.0.0.1:${ports.postgres}/medplum`, credentialPath: join(runtime, 'operator.env'), statePath: join(runtime, 'operator-state.json') });
for (const [key, category] of [['current','medical'],['prior','exams']]) {
  const encounter = await fhir.read<any>('Encounter', fixture[key].slice(10));
  await fhir.update('Encounter', encounter.id, { ...encounter, type: [{ coding: [{ system: ODOS_VISIT_TYPE_SYSTEM, code: category }] }] }, { 'If-Match': `W/"${encounter.meta.versionId}"` });
}
console.log('Two synthetic encounters use medical and exams scheduling categories.');
