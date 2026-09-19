import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createAuthenticatedFhirClient } from '../../../../scripts/r10-served-route/login.js';

const runtime = resolve(process.argv[2]);
const read = (name: string) => JSON.parse(readFileSync(join(runtime, name), 'utf8'));
const { ports, project } = read('manifest.json');
assert.equal(project, 'odos-s1-proof');
const credentials = read('credentials.json');
const fixture = read('fixture.json');
const { accessToken, fhir } = await createAuthenticatedFhirClient({ baseUrl: `http://127.0.0.1:${ports.medplum}`, ...credentials.provider });
assert.equal(await fhir.getActiveProjectId(), credentials.projectId);
assert.equal(await fhir.getAuthenticatedProfileReference(), credentials.provider.practitionerReference);
const results = [];
for (const path of [`/clinical-graph/encounters/${fixture.current.slice('Encounter/'.length)}/findings`, '/clinical-graph/diagnosis-quick-list']) {
  const response = await fetch(`http://127.0.0.1:${ports.frontdoor}${path}`, { headers: { Authorization: `Bearer ${accessToken}` } });
  assert.equal(response.status, 200, `Actual provider served readiness: ${path}`);
  const body = await response.json() as { findings?: unknown; canWrite?: unknown };
  if (path.endsWith('/findings')) { assert.ok(Array.isArray(body.findings)); assert.equal(typeof body.canWrite, 'boolean'); }
  results.push({ path, status: response.status });
}
writeFileSync(join(runtime, 'provider-readiness.json'), JSON.stringify({ projectId: credentials.projectId, providerReference: credentials.provider.practitionerReference, verifiedAt: new Date().toISOString(), results }, null, 2) + '\n');
console.log('Actual provider served findings and quick-list GETs: 200.');
