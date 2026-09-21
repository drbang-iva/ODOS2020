import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import type { Basic, Encounter } from '@medplum/fhirtypes';
import { loadVerifiedOperatorFhirClient } from '../../../../scripts/operator-identity.js';
import { FhirEncounterExamScopeStore } from '../../../../mcp/src/clinical-graph/exam-scope-store.js';
import { searchAll } from '../../../../mcp/src/fhir-search.js';
const runtime = resolve('.odos/s3b2-proof');
const read = (name: string) => JSON.parse(readFileSync(join(runtime, name), 'utf8'));
const { project, ports } = read('manifest.json'); assert.equal(project, 'odos-s3b2-proof');
const credentials = read('credentials.json'), { patientId, visits } = read('picker-visits.json');
const { fhir } = await loadVerifiedOperatorFhirClient({ baseUrl: `http://127.0.0.1:${ports.medplum}`, projectId: credentials.projectId,
  postgresUrl: `postgresql://medplum:medplum@127.0.0.1:${ports.postgres}/medplum`, credentialPath: join(runtime, 'operator.env'), statePath: join(runtime, 'operator-state.json') });
const browser = JSON.parse(readFileSync('docs/build-log/followup-s3b2-picker/browser-after.json', 'utf8'));
const records = [];
for (const [width, encounterId] of Object.entries(visits)) {
 const rows = await searchAll<Basic>(fhir, 'Basic', { identifier: `urn:odos:encounter-exam-scope|${encounterId}` });
 assert.equal(rows.length, 1);
 const evidence = browser.find((row: any) => row.width === Number(width));
 const versions: Record<string, unknown> = {};
 for (const label of ['before','after','afterNothing']) {
  const historical = await fhir.read<Basic>('Basic', `${rows[0].id}/_history/${evidence[label].versionId}`);
  const value = JSON.parse(historical.extension!.find(e => e.url === 'urn:odos:encounter-exam-scope:value')!.valueString!);
  if (label === 'before') assert.equal(value.source, undefined);
  else { assert.equal(value.source, 'explicit'); assert.equal(value.chosenBy.reference, credentials.provider.practitionerReference); }
  versions[label] = { versionId: historical.meta!.versionId, value };
 }
 const before = versions.before as any;
 const parsedOld = await new FhirEncounterExamScopeStore({ ...fhir, baseUrl: fhir.baseUrl, search: async () => ({ resourceType: 'Bundle', type: 'searchset', entry: [{ resource: { ...rows[0], meta: { ...rows[0].meta, versionId: before.versionId }, extension: [{ url: 'urn:odos:encounter-exam-scope:value', valueString: JSON.stringify(before.value) }] } }] }) } as any).get(String(encounterId));
 assert.equal(parsedOld.source, 'derived');
 records.push({ width: Number(width), encounterId, rowCount: rows.length, versions, parsedS3b1WithoutSource: parsedOld });
}
writeFileSync('docs/build-log/followup-s3b2-picker/stored-records.json', JSON.stringify(records,null,2)+'\n');
console.log('Read six historical stored scope revisions; two source-free S3b1 rows parse as derived.');
