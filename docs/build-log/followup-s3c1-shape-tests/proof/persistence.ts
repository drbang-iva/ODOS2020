import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Basic, Encounter, Patient, Practitioner } from '@medplum/fhirtypes';
import { createAuthenticatedFhirClient } from '../../../../scripts/r10-served-route/login.js';
import { FhirFollowUpProfileStore } from '../../../../mcp/src/clinical-graph/follow-up-profile-store.js';
import { FhirEncounterExamScopeStore } from '../../../../mcp/src/clinical-graph/exam-scope-store.js';
import { resolveProfileTests } from '../../../../mcp/src/clinical-graph/exam-overview-endpoint.js';

const runtime = join(process.cwd(), '.odos/s3c1-proof');
const manifest = JSON.parse(readFileSync(join(runtime, 'manifest.json'), 'utf8'));
assert.equal(manifest.project, 'odos-s3c1-proof');
const service = JSON.parse(readFileSync(join(runtime, 'service.json'), 'utf8'));
const { fhir } = await createAuthenticatedFhirClient({ baseUrl: `http://127.0.0.1:${manifest.ports.medplum}`, ...service });
const practitioner = await fhir.create<Practitioner>({ resourceType: 'Practitioner', name: [{ family: 'S3c1 Synthetic' }] });
const patient = await fhir.create<Patient>({ resourceType: 'Patient', name: [{ family: 'S3c1 Synthetic' }] });
const actor = { reference: `Practitioner/${practitioner.id}` };
async function encounter() {
  return (await fhir.create<Encounter>({ resourceType: 'Encounter', status: 'in-progress', class: { code: 'AMB' }, subject: { reference: `Patient/${patient.id}` } })).id!;
}
const oldId = await encounter(), newId = await encounter(), explicitId = await encounter(), legacyId = await encounter();
const profiles = new FhirFollowUpProfileStore(fhir), scopes = new FhirEncounterExamScopeStore(fhir);
const resolve = async () => {
  const selected = (await profiles.list()).filter(profile => profile.profileKey === 'glaucoma' && profile.active);
  return { profiles: selected, testsProposed: resolveProfileTests(selected) };
};
async function stored(id: string) {
  const result = await fhir.search<Basic>('Basic', { identifier: `urn:odos:encounter-exam-scope|${id}` });
  assert.equal(result.entry?.length, 1);
  return JSON.parse(result.entry![0].resource!.extension!.find(row => row.url === 'urn:odos:encounter-exam-scope:value')!.valueString!);
}
const original = await resolve();
assert.equal(original.profiles.length, 1);
const first = await scopes.shapeIfAbsent(oldId, actor, resolve);
const before = await stored(oldId);
const explicit = await scopes.pick(explicitId, 'office-visit', actor, null, original.profiles, original.testsProposed);
assert.deepEqual(explicit.testsProposed, first.testsProposed);
const { versionId, ...profile } = original.profiles[0];
const edited = await profiles.save({ ...profile, version: profile.version + 1, testsQueuedByDefault: profile.testsQueuedByDefault.slice(0, 1) }, versionId);
assert.deepEqual(await scopes.shapeIfAbsent(oldId, actor, resolve), first);
const afterEdit = await stored(oldId);
assert.deepEqual(afterEdit, before);
const next = await scopes.shapeIfAbsent(newId, actor, resolve);
assert.deepEqual(next.testsProposed, first.testsProposed!.slice(0, 1));
await profiles.save({ ...edited.profile, active: false, version: edited.profile.version + 1 }, edited.versionId);
assert.deepEqual(await scopes.shapeIfAbsent(oldId, actor, resolve), first);
assert.deepEqual(await scopes.get(explicitId), explicit);
const afterRetirement = await stored(oldId);
assert.deepEqual(afterRetirement, before);
const legacyValue = { ...before };
delete legacyValue.testsProposed;
delete legacyValue.source;
await fhir.create<Basic>({ resourceType: 'Basic',
  identifier: [{ system: 'urn:odos:encounter-exam-scope', value: legacyId }],
  code: { coding: [{ system: 'urn:odos:encounter-exam-scope', code: 'exam-scope' }] },
  subject: { reference: `Encounter/${legacyId}` }, author: actor,
  extension: [{ url: 'urn:odos:encounter-exam-scope:value', valueString: JSON.stringify(legacyValue) }],
});
const legacyParsed = await scopes.get(legacyId);
assert.equal(Object.hasOwn(legacyParsed, 'testsProposed'), false);
assert.deepEqual(legacyParsed.testsProposed ?? [], []);
assert.deepEqual(await scopes.shapeIfAbsent(legacyId, actor, async () => { throw new Error('must not retro-shape'); }), legacyParsed);
assert.deepEqual(await stored(legacyId), legacyValue);
const evidence = { syntheticOnly: true, project: manifest.project, before, afterEdit, afterRetirement,
  newVisit: await stored(newId), explicitVisit: await stored(explicitId), legacyStored: legacyValue, legacyParsed,
  checks: ['old visit unchanged after edit', 'new visit has edited tests', 'old and explicit visits unchanged after retirement', 'legacy tests absent and no retro-shape'] };
writeFileSync('docs/build-log/followup-s3c1-shape-tests/persistence.json', JSON.stringify(evidence, null, 2) + '\n');
console.log(JSON.stringify({ oldVisitTests: first.testsProposed!.length, newVisitTests: next.testsProposed!.length, explicitVisitTests: explicit.testsProposed!.length, legacyRecordedTests: legacyParsed.testsProposed ?? [], checksPassed: evidence.checks.length }));
