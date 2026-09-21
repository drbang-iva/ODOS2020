import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Basic, Condition, Encounter } from '@medplum/fhirtypes';
import { loadVerifiedOperatorFhirClient } from '../../../../scripts/operator-identity.js';
import { createAuthenticatedFhirClient } from '../../../../scripts/r10-served-route/login.js';
import { FhirFollowUpProfileStore } from '../../../../mcp/src/clinical-graph/follow-up-profile-store.js';
import { DIAGNOSIS_KEY_IDENTIFIER_SYSTEM } from '../../../../mcp/src/clinical-graph/diagnosis-pick-endpoint.js';

const runtime = join(process.cwd(), '.odos/s3c2b-proof');
const read = (name: string) => JSON.parse(readFileSync(join(runtime, name), 'utf8'));
const { ports, project } = read('manifest.json'); assert.equal(project, 'odos-s3c2b-proof');
const credentials = read('credentials.json'), fixture = read('fixture.json');
const baseUrl = `http://127.0.0.1:${ports.medplum}`;
const { fhir } = await loadVerifiedOperatorFhirClient({ baseUrl, projectId: credentials.projectId,
  postgresUrl: `postgresql://medplum:medplum@127.0.0.1:${ports.postgres}/medplum`, credentialPath: join(runtime, 'operator.env'), statePath: join(runtime, 'operator-state.json') });
const sessions = Object.fromEntries(await Promise.all(['provider','staff','admin'].map(async role => [role, await createAuthenticatedFhirClient({ baseUrl, ...credentials[role] })])));
const responses: Record<string, unknown> = {};
async function api(name: string, role: string, path: string, body?: unknown, expected = 200) {
  const response = await fetch(`http://127.0.0.1:${ports.frontdoor}${path}`, { method: body ? 'PUT' : 'GET', headers: { Authorization: `Bearer ${sessions[role].accessToken}`, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const result = { status: response.status, body: await response.json() };
  responses[name] = result; assert.equal(result.status, expected, JSON.stringify(result)); return result.body;
}
const actor = { reference: credentials.provider.practitionerReference };
async function visit(status: Encounter['status'], start: string) {
  return await fhir.create<Encounter>({ resourceType: 'Encounter', status, class: { code: 'AMB' }, subject: { reference: fixture.patientReference }, period: { start }, participant: [{ individual: actor }] });
}
const prior = await visit('finished', '2026-09-20T14:00:00Z');
const condition = await fhir.create<Condition>({ resourceType: 'Condition', subject: { reference: fixture.patientReference }, encounter: { reference: `Encounter/${prior.id}` }, identifier: [{ system: DIAGNOSIS_KEY_IDENTIFIER_SYSTEM, value: `${prior.id}::ocular_hypertension::bilateral` }], code: { text: 'Synthetic glaucoma follow-up' } });
await fhir.update('Encounter', prior.id!, { ...prior, diagnosis: [{ condition: { reference: `Condition/${condition.id}` } }] }, { 'If-Match': `W/"${prior.meta!.versionId}"` });
const current = await visit('in-progress', '2026-09-21T14:00:00Z');
const closed = await visit('finished', '2026-09-21T13:00:00Z');
const path = `/clinical-graph/encounters/${current.id}`;
const following = { sourceEncounterReference: `Encounter/${prior.id}`, sourceConditionReference: `Condition/${condition.id}` };
let shape = await api('initialPick','provider',`${path}/exam-scope`,{ examScope: 'office-visit', expectedVersion: null, following });
const before = await api('before','staff',`${path}/follow-up-queue`);
const photos = before.rows.find((row: any) => row.label === 'Optic nerve photos'); assert.ok(photos); assert.equal(photos.state,'for-review');
const mark = { orderable: photos.orderable, focus: photos.focus, decision: 'not-today' };
const marked = await api('staffNotToday','staff',`${path}/follow-up-queue/decisions`,mark);
const row = (queue: any) => queue.rows.find((r: any) => r.orderable === photos.orderable && r.focus === photos.focus);
assert.equal(row(marked).state,'not-today'); assert.equal(marked.canDecide,true);
const saved = await fhir.search<Basic>('Basic',{identifier:`urn:odos:encounter-follow-up-decisions|${current.id}`});
assert.equal(saved.entry?.length,1);
const record = JSON.parse(saved.entry![0].resource!.extension![0].valueString!);
assert.equal(record.decisions[`${photos.orderable}|${photos.focus ?? ''}`].by.reference,credentials.staff.practitionerReference);
assert.equal(row(await api('reload','staff',`${path}/follow-up-queue`)).state,'not-today');
const profiles = new FhirFollowUpProfileStore(fhir), profile = (await profiles.list()).find(p=>p.profileKey==='glaucoma')!;
const { versionId, ...editable } = profile;
await profiles.save({ ...editable, version:profile.version+1, testsQueuedByDefault: profile.testsQueuedByDefault.map(t=>({...t,label:t.label==='Optic nerve photos'?t.label:`${t.label} edited`})) },versionId);
assert.equal(row(await api('profileEdited','staff',`${path}/follow-up-queue`)).state,'not-today');
shape = await api('repick','provider',`${path}/exam-scope`,{ examScope:'office-visit',expectedVersion:shape.versionId,following });
assert.equal(row(await api('afterRepick','staff',`${path}/follow-up-queue`)).state,'not-today');
const readOnly = await api('readOnlyGet','admin',`${path}/follow-up-queue`); assert.equal(readOnly.canDecide,false);
await api('readOnlyPut','admin',`${path}/follow-up-queue/decisions`,mark,403);
await api('signedPut','provider',`/clinical-graph/encounters/${closed.id}/follow-up-queue/decisions`,mark,409);
assert.equal(row(await api('providerPutBack','provider',`${path}/follow-up-queue/decisions`,{...mark,decision:'put-back'})).state,'for-review');
const final = await fhir.search<Basic>('Basic',{identifier:`urn:odos:encounter-follow-up-decisions|${current.id}`});
assert.deepEqual(JSON.parse(final.entry![0].resource!.extension![0].valueString!).decisions,{});
writeFileSync('docs/build-log/followup-s3c2b-not-today/live-proof.json',JSON.stringify({syntheticOnly:true,project,decisionRecord:record,finalDecisionRecord:JSON.parse(final.entry![0].resource!.extension![0].valueString!),responses},null,2)+'\n');
writeFileSync(join(runtime,'queue-visits.json'),JSON.stringify({patientId:fixture.patientReference.slice(8),encounterId:current.id,mark},null,2)+'\n',{mode:0o600});
console.log('Live proof passed: staff decision, reload, profile edit, explicit re-pick, read-only denial, signed denial, provider Put back.');
