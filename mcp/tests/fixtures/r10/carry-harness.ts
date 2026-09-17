import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { Condition, Encounter, Observation, Provenance, Resource } from '@medplum/fhirtypes';
import { handleDiagnosisPullRequest, handlePreviousExamsReadRequest } from '../../../src/clinical-graph/diagnosis-carry-forward-endpoint.js';
import * as lineage from '../../../src/clinical-graph/diagnosis-carry-provenance.js';
import { currentFindingIdentifier, parseCurrentFindingEnvelope, SUPPORTS_DIAGNOSIS_URL } from '../../../src/clinical-graph/current-finding-identity.js';
import { buildEncounterDiagnosisCondition } from '../../../src/fhir/condition.js';
import { DIAGNOSIS_KEY_IDENTIFIER_SYSTEM } from '../../../src/clinical-graph/diagnosis-pick-endpoint.js';
import { canonicalFact, keyFor, memoryFhir, httpError } from './writer-harness.js';
import { comp, snapshot, nuclear } from './factories.js';
export const commandSystem = 'urn:odos:carry-command:v1';
export function fixture(eyes: Array<'OD' | 'OS'> = ['OD', 'OS']) {
    const encounter = (id: string, start: string, diagnosis?: string): Encounter => ({ resourceType: 'Encounter', id, meta: { versionId: '1' }, status: 'in-progress', class: { code: 'AMB' }, subject: { reference: 'Patient/p1' }, period: { start }, ...(diagnosis ? { diagnosis: [{ condition: { reference: diagnosis }, rank: 3 }] } : {}) });
    const source: Condition = { ...buildEncounterDiagnosisCondition({ patientReference: 'Patient/p1', encounterReference: 'Encounter/past', code: { text: 'Synthetic carry diagnosis' }, verificationStatus: 'confirmed', identifiers: [{ system: DIAGNOSIS_KEY_IDENTIFIER_SYSTEM, value: `past::${nuclear.diagnosisKeys[0]}::bilateral` }] }), id: 'source', meta: { versionId: '1' } };
    const observations = eyes.map(eye => { const key = { ...keyFor(eye), encounterId: 'past' }; const fact = canonicalFact(`source-${eye}`, eye); return { ...fact, encounter: { reference: 'Encounter/past' }, identifier: [currentFindingIdentifier(key)], component: [comp('R10_CURRENT_META', JSON.stringify(key)), comp('GRADE', '2+')], extension: [...fact.extension!, { url: SUPPORTS_DIAGNOSIS_URL, valueReference: { reference: 'Condition/source' } }] }; });
    const m = memoryFhir([{ resourceType: 'Patient', id: 'p1' }, encounter('e1', '2026-09-16T12:00:00Z'), encounter('past', '2026-08-16T12:00:00Z', 'Condition/source'), source, ...observations]);
    const original = m.fhir.search;
    m.fhir.search = async (type, params = {}) => {
        if (type === 'Basic' && params.code)
            return { resourceType: 'Bundle', type: 'searchset', entry: m.all('Basic').filter((r: any) => r.code?.coding?.some((c: any) => `${c.system}|${c.code}` === params.code)).map(resource => ({ resource: structuredClone(resource) })) } as any;
        if (type === 'Provenance' && params.target)
            return { resourceType: 'Bundle', type: 'searchset', entry: m.all<Provenance>('Provenance').filter(p => p.target.some(t => t.reference === params.target)).map(resource => ({ resource: structuredClone(resource) })) } as any;
        if (type === 'Encounter')
            return { resourceType: 'Bundle', type: 'searchset', entry: [{ resource: structuredClone(m.resources.get('Encounter/past')) }] } as any;
        return original(type, params);
    };
    const deps = { fhirBaseUrl: m.fhir.baseUrl, authenticate: async () => ({ staffReference: 'Practitioner/synthetic', actorRole: 'provider' as const, fhir: m.fhir }) };
    return { ...m, deps };
}
export const request = (commandId = randomUUID(), extra = {}) => ({ authHeader: 'synthetic', params: { encounterId: 'e1' }, body: { commandId, sourceEncounterReference: 'Encounter/past', sourceConditionReference: 'Condition/source', ...extra } });
export const pull = (m: ReturnType<typeof fixture>, r = request()) => handleDiagnosisPullRequest(m.deps as any, r);
export const carried = (m: ReturnType<typeof fixture>) => m.all<Observation>('Observation').filter(o => o.encounter?.reference === 'Encounter/e1');
export const conditions = (m: ReturnType<typeof fixture>) => m.all<Condition>('Condition').filter(c => c.encounter?.reference === 'Encounter/e1');
export const plans = (m: ReturnType<typeof fixture>) => m.all<Provenance>('Provenance').filter(p => p.meta?.tag?.some(t => t.system === commandSystem && t.code?.endsWith(':plan')));
export const witnesses = (m: ReturnType<typeof fixture>) => m.all<Provenance>('Provenance').filter(p => p.meta?.tag?.some(t => t.system === commandSystem && t.code?.endsWith(':findings')));
export const planValue = (p: Provenance) => JSON.parse(p.extension!.find(e => e.url.endsWith('/carry-plan'))!.valueString!);
export const versionValue = (p: Provenance) => JSON.parse(p.extension!.find(e => e.url.endsWith('/carry-versions'))!.valueString!);
