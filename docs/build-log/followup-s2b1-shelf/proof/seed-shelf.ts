import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import type { Encounter, Observation, Condition, Provenance } from '@medplum/fhirtypes';
import { loadVerifiedOperatorFhirClient } from '../../../../scripts/operator-identity.js';
import { FhirFindingDefinitionStore } from '../../../../mcp/src/clinical-graph/finding-definition-store.js';
import { FhirEncounterExamScopeStore } from '../../../../mcp/src/clinical-graph/exam-scope-store.js';
import { buildProvenance } from '../../../../mcp/src/fhir/ophthalmology/provenance.js';
import { ODOS_EXTENSION_URLS, lateralityExtension } from '../../../../mcp/src/fhir/ophthalmology/extensions.js';
import { DIAGNOSIS_FINDING_REASSERTION_CODE, ODOS_PROVENANCE_ACTIVITY_CODE_SYSTEM } from '../../../../mcp/src/clinical-graph/diagnosis-carry-provenance.js';

const runtime = resolve('.odos/s2b1-proof');
const read = (name: string) => JSON.parse(readFileSync(join(runtime, name), 'utf8'));
const manifest = read('manifest.json'), credentials = read('credentials.json'), fixture = read('fixture.json');
assert.equal(manifest.project, 'odos-s2b1-proof');
const save = () => writeFileSync(join(runtime, 'fixture.json'), JSON.stringify(fixture, null, 2) + '\n', { mode: 0o600 });
const { fhir } = await loadVerifiedOperatorFhirClient({ baseUrl: `http://127.0.0.1:${manifest.ports.medplum}`, projectId: credentials.projectId,
  postgresUrl: `postgresql://medplum:medplum@127.0.0.1:${manifest.ports.postgres}/medplum`,
  credentialPath: join(runtime, 'operator.env'), statePath: join(runtime, 'operator-state.json'),
});
if (process.argv.includes('--fresh-dry')) { delete fixture.shelfDry1440; delete fixture.shelfDry390; save(); }
for (const key of ['shelfComprehensive', 'shelfOffice', 'shelfData', 'shelfPrior', 'shelfDry1440', 'shelfDry390']) {
  if (fixture[key]) continue;
  const encounter = await fhir.create<Encounter>({ resourceType: 'Encounter', status: 'in-progress', class: { code: 'AMB' },
    subject: { reference: fixture.patientReference }, period: { start: key === 'shelfPrior' ? '2026-09-01T14:00:00Z' : '2026-09-19T14:00:00Z' },
    type: [{ text: 'Synthetic shelf visit' }], participant: [{ individual: { reference: credentials.provider.practitionerReference } }],
  });
  fixture[key] = `Encounter/${encounter.id}`; save();
  if (!['shelfComprehensive', 'shelfPrior'].includes(key)) await new FhirEncounterExamScopeStore(fhir).set(encounter.id!, 'office-visit', { reference: credentials.provider.practitionerReference }, null);
}
{
  const definitions = new FhirFindingDefinitionStore(fhir);
  const hpi = (await definitions.list()).find(d => d.stableKey === 'hpi_ros')!;
  assert.ok(hpi);
  await definitions.save({ ...hpi, id: 'shelf-unmapped', stableKey: 'shelf-unmapped', display: 'Synthetic unmatched finding', sectionKey: 'pretest:shelf-unmapped',
    fhirObservationCode: { coding: [{ code: 'shelf-unmapped' }], text: 'Synthetic unmatched finding' },
    valueSchema: { type: 'text', perEye: true },
  });
}
const scopeStore = new FhirEncounterExamScopeStore(fhir);
const dataScope = await scopeStore.get(fixture.shelfData.slice(10));
if (dataScope.examScope !== 'comprehensive') await scopeStore.set(fixture.shelfData.slice(10), 'comprehensive', { reference: credentials.provider.practitionerReference }, dataScope.versionId ?? null);
if (!fixture.shelfSeeded) {
  const observation = async (code: string, eye: 'OD' | 'OS', value: string | number) => fhir.create<Observation>({ resourceType: 'Observation', status: 'final',
    subject: { reference: fixture.patientReference }, encounter: { reference: fixture.shelfData },
    code: { coding: [{ code }] }, effectiveDateTime: '2026-09-19T14:00:00Z',
    extension: [lateralityExtension(eye)],
    ...(typeof value === 'number' ? { valueInteger: value } : { valueString: value }),
  });
  const unmatched = await observation('shelf-unmapped', 'OD', 'Visible synthetic detail');
  const confirmed = await observation('intraocular_pressure', 'OD', 15);
  const unconfirmed = await observation('intraocular_pressure', 'OS', 16);
  const source = await fhir.create<Condition>({ resourceType: 'Condition', subject: { reference: fixture.patientReference }, encounter: { reference: fixture.shelfPrior }, code: { text: 'Synthetic carry context' } });
  const current = await fhir.create<Condition>({ resourceType: 'Condition', subject: { reference: fixture.patientReference }, encounter: { reference: fixture.shelfData }, code: { text: 'Synthetic carry context' },
    evidence: [{ detail: [confirmed, unconfirmed].map(o => ({ reference: `Observation/${o.id}` })) }],
  });
  await fhir.create(buildProvenance({ targetReferences: [`Condition/${current.id}`, ...[confirmed, unconfirmed].map(o => `Observation/${o.id}`)],
    recorded: '2026-09-19T14:00:00Z', activityCode: 'CREATE', activityDisplay: 'Diagnosis pull-forward',
    agents: [{ typeCode: 'author', whoReference: credentials.provider.practitionerReference }], entityReferences: [`Condition/${source.id}`],
  }) as Provenance);
  await fhir.create<Provenance>({ resourceType: 'Provenance', target: [{ reference: `Observation/${confirmed.id}` }], recorded: '2026-09-19T14:01:00Z',
    activity: { coding: [{ system: ODOS_PROVENANCE_ACTIVITY_CODE_SYSTEM, code: DIAGNOSIS_FINDING_REASSERTION_CODE }], text: 'Diagnosis finding reassertion' },
    agent: [{ who: { reference: credentials.provider.practitionerReference } }],
  });
  fixture.shelfSeeded = { unmatched: `Observation/${unmatched.id}`, confirmed: `Observation/${confirmed.id}`, unconfirmed: `Observation/${unconfirmed.id}` }; save();
}
for (const [key, eye] of [['unmatched', 'OD'], ['confirmed', 'OD'], ['unconfirmed', 'OS']] as const) {
  const observation = await fhir.read<Observation>('Observation', fixture.shelfSeeded[key].slice(12));
  const expected = lateralityExtension(eye);
  if (JSON.stringify(observation.extension?.find(e => e.url === ODOS_EXTENSION_URLS.eyeLaterality)) !== JSON.stringify(expected)) {
    await fhir.update('Observation', observation.id!, { ...observation, extension: [...(observation.extension ?? []).filter(e => e.url !== ODOS_EXTENSION_URLS.eyeLaterality), expected] });
  }
}
console.log('Shelf synthetic encounters and persisted unmatched/carried findings ready.');
