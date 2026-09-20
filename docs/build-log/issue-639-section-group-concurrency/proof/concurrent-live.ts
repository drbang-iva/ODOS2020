import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Basic } from '@medplum/fhirtypes';
import { loadVerifiedOperatorFhirClient } from '../../../../scripts/operator-identity.js';
import {
  FhirFindingSectionGroupStore, FhirEncounterSectionOverrideStore,
  FINDING_SECTION_GROUP_CODE_SYSTEM, ENCOUNTER_SECTION_OVERRIDE_CODE,
  FINDING_SECTION_GROUP_IDENTIFIER_SYSTEM,
} from '../../../../mcp/src/clinical-graph/finding-section-group-store.js';
const runtime = resolve('.odos/639-proof');
const read = (name: string) => JSON.parse(readFileSync(join(runtime, name), 'utf8'));
const manifest = read('manifest.json'), credentials = read('credentials.json');
assert.equal(manifest.project, 'odos-639-proof');
const baseUrl = `http://127.0.0.1:${manifest.ports.medplum}`;
const deadline = Date.now() + 60_000;
while (true) {
  try { if ((await fetch(`${baseUrl}/healthcheck`)).ok) break; } catch {}
  if (Date.now() >= deadline) throw new Error('Disposable Medplum health timeout');
  await new Promise(resolve => setTimeout(resolve, 1000));
}
const seeder = await loadVerifiedOperatorFhirClient({ baseUrl, projectId: credentials.projectId,
  postgresUrl: `postgresql://medplum:medplum@127.0.0.1:${manifest.ports.postgres}/medplum`,
  credentialPath: join(runtime, 'operator.env'), statePath: join(runtime, 'operator-state.json'),
});
const results = [];
for (const mode of ['create', 'seed'] as const) {
  const key = `synthetic-${randomUUID()}`;
  const group = { id: key, groupKey: key, label: 'Synthetic concurrent create', sectionKeyPrefixes: ['synthetic:'], active: true };
  const store = new FhirFindingSectionGroupStore(seeder.fhir, mode === 'seed' ? [group] : []);
  const write = () => mode === 'seed' ? store.save(group, null) : store.create(group, null);
  const pair = await Promise.allSettled([write(), write()]);
  const accepted = pair.filter(r => r.status === 'fulfilled').length;
  const bundle = await seeder.fhir.search<Basic>('Basic', { identifier: `${FINDING_SECTION_GROUP_IDENTIFIER_SYSTEM}|${key}` });
  const rows = bundle.entry?.filter(e => e.resource).length ?? 0;
  results.push({ mode, accepted, rows, rejectionStatuses: pair.flatMap(r => r.status === 'rejected' ? [(r.reason as {status?:number}).status ?? null] : []) });
  assert.equal(accepted, 1); assert.equal(rows, 1);
}
const encounterId = read('fixture.json').preRebuild.slice('Encounter/'.length);
const before = await seeder.fhir.search<Basic>('Basic', { code: `${FINDING_SECTION_GROUP_CODE_SYSTEM}|${ENCOUNTER_SECTION_OVERRIDE_CODE}`, subject: `Encounter/${encounterId}` });
assert.equal(before.entry?.filter(e => e.resource).length ?? 0, 0, 'Use the untouched synthetic encounter');
const overrides = new FhirEncounterSectionOverrideStore(seeder.fhir);
await Promise.all([overrides.setGroupKeys(encounterId, ['first']), overrides.setGroupKeys(encounterId, ['second'])]);
const after = await seeder.fhir.search<Basic>('Basic', { code: `${FINDING_SECTION_GROUP_CODE_SYSTEM}|${ENCOUNTER_SECTION_OVERRIDE_CODE}`, subject: `Encounter/${encounterId}` });
const rows = after.entry?.filter(e => e.resource).length ?? 0;
assert.equal(rows, 1);
results.push({ mode: 'override', rows });
writeFileSync('docs/build-log/issue-639-section-group-concurrency/concurrent-live.json', JSON.stringify(results, null, 2)+'\n');
console.log(JSON.stringify(results));
