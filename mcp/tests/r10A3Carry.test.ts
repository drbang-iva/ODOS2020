import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import type { Condition, Encounter, Observation, Provenance, Resource } from '@medplum/fhirtypes';
import { handleDiagnosisPullRequest, handlePreviousExamsReadRequest } from '../src/clinical-graph/diagnosis-carry-forward-endpoint.js';
import * as lineage from '../src/clinical-graph/diagnosis-carry-provenance.js';
import { currentFindingIdentifier, parseCurrentFindingEnvelope, SUPPORTS_DIAGNOSIS_URL } from '../src/clinical-graph/current-finding-identity.js';
import { buildEncounterDiagnosisCondition } from '../src/fhir/condition.js';
import { DIAGNOSIS_KEY_IDENTIFIER_SYSTEM } from '../src/clinical-graph/diagnosis-pick-endpoint.js';
import { canonicalFact, keyFor, memoryFhir, httpError } from './fixtures/r10/writer-harness.js';
import { comp, snapshot, nuclear, lens, lensField } from './fixtures/r10/factories.js';
import { buildFindingDefinitionResource } from '../src/clinical-graph/finding-definition-store.js';
import { executeFindingCommand } from '../src/clinical-graph/current-finding-writer.js';
import { fixture, request, pull, carried, conditions, plans, witnesses, planValue, versionValue } from './fixtures/r10/carry-harness.js';
test('W73 W113 previous exams uses extension homes for both eyes with typed qualifiers and hides cleared', async () => {
    const m = fixture();
    const retired = canonicalFact('retired');
    const retiredKey = { ...keyFor('OD', 'cortical-cataract'), encounterId: 'past' };
    retired.status = 'entered-in-error';
    retired.encounter = { reference: 'Encounter/past' };
    retired.identifier = [currentFindingIdentifier(retiredKey)];
    retired.code = { coding: [{ code: `${retiredKey.stableKey}::${retiredKey.fieldCode}::${retiredKey.optionCode}` }] };
    retired.component = [comp('R10_CURRENT_META', JSON.stringify(retiredKey))];
    retired.extension!.push({ url: SUPPORTS_DIAGNOSIS_URL, valueReference: { reference: 'Condition/source' } });
    m.save(retired);
    const result = await handlePreviousExamsReadRequest(m.deps as any, { authHeader: 'synthetic', params: { encounterId: 'e1' }, query: {} });
    assert.equal(result.status, 200, JSON.stringify(result.body));
    const facts = (result.body as any).encounters[0].diagnoses[0].findings;
    assert.equal(facts.length, 2);
    assert.deepEqual(facts.map((f: any) => f.laterality).sort(), ['OD', 'OS']);
    assert.deepEqual(facts.map((f: any) => f.qualifiers), [{ grade: '2+' }, { grade: '2+' }]);
    assert.equal(m.writes.length, 0);
});
test('W74 W101 W113 carry uses standalone conditional steps and preserves source with two canonical eyes', async () => {
    const m = fixture();
    const source = structuredClone(m.all('Observation'));
    const result = await pull(m);
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.equal(conditions(m).length, 1);
    assert.equal(carried(m).length, 2);
    assert.equal(plans(m).length, 1);
    assert.equal(witnesses(m).length, 1);
    assert.deepEqual(carried(m).map(o => { const e = parseCurrentFindingEnvelope(o); assert.equal(e.status, 'valid'); return e.status === 'valid' ? e.key.eye : ''; }).sort(), ['OD', 'OS']);
    assert.ok(m.writes.find(w => w.resource.resourceType === 'Condition')!.headers['If-None-Exist']?.startsWith('identifier=urn%3Aodos%3Acarry-diagnosis%3Av1') || m.writes.find(w => w.resource.resourceType === 'Condition')!.headers['If-None-Exist']?.startsWith('identifier=urn:odos:carry-diagnosis:v1'));
    for (const fact of carried(m)) {
        assert.deepEqual(fact.extension?.filter(e => e.url === SUPPORTS_DIAGNOSIS_URL).map(e => e.valueReference?.reference), [`Condition/${conditions(m)[0].id}`]);
        assert.equal(fact.component?.find(c => c.code.coding?.some(x => x.code?.endsWith('::grade')))?.valueCodeableConcept?.coding?.[0]?.code, '2+');
    }
    assert.deepEqual(m.all<Observation>('Observation').filter(o => o.encounter?.reference === 'Encounter/past'), source);
    assert.equal(conditions(m)[0].evidence, undefined);
    assert.equal((result.body as any).lineageStep, 'applied');
});
test('W101 lost Condition response resumes one conditional owner', async () => {
    const m = fixture();
    const r = request();
    let failed = false;
    m.hooks.afterWrite = w => { if (!failed && w.resource.resourceType === 'Condition') {
        failed = true;
        throw httpError(503);
    } };
    const first = await pull(m, r);
    m.hooks.afterWrite = undefined;
    const second = await pull(m, r);
    assert.equal(second.status, 200, JSON.stringify({ first, second }));
    assert.equal(conditions(m).length, 1);
    assert.equal(carried(m).length, 2);
    assert.equal(witnesses(m).length, 1);
});
test('W102 same command changed source fingerprint refuses zero further writes', async () => {
    const m = fixture();
    const r = request();
    assert.equal((await pull(m, r)).status, 200);
    const other = structuredClone(m.resources.get('Condition/source') as Condition);
    other.id = 'other';
    m.save(other);
    const past = m.resources.get('Encounter/past') as Encounter;
    past.diagnosis!.push({ condition: { reference: 'Condition/other' } });
    const before = m.writes.length;
    const result = await pull(m, { ...r, body: { ...r.body, sourceConditionReference: 'Condition/other' } });
    assert.equal(result.status, 409, JSON.stringify(result.body));
    assert.equal((result.body as any).reason, 'command-reused');
    assert.equal(m.writes.length, before);
});
test('W103 W104 frozen retry stays stale and partial carry has no findings witness', async () => {
    const m = fixture();
    const r = request();
    m.hooks.beforeWrite = w => { if (w.resource.resourceType === 'Observation' && parseCurrentFindingEnvelope(w.resource).status === 'valid' && w.resource.id === undefined && JSON.stringify(w.resource.component).includes('OS'))
        throw httpError(503); };
    const first = await pull(m, r);
    assert.notEqual(first.status, 200);
    assert.equal(carried(m).length, 1);
    assert.equal(witnesses(m).length, 0);
    assert.equal((first.body as any).lineageStep, 'not-attempted');
    const frozen = structuredClone(planValue(plans(m)[0]));
    m.hooks.beforeWrite = undefined;
    const foreign = canonicalFact('competing', 'OS');
    m.save(foreign);
    const result = await pull(m, r);
    assert.equal(result.status, 409, JSON.stringify(result.body));
    assert.equal((result.body as any).findings.outcomes[1].status, 'conflict');
    assert.deepEqual(planValue(plans(m)[0]), frozen);
    assert.equal(witnesses(m).length, 0);
});
test('W125 replan accepts unchanged already-completed target and records exact versions', async () => {
    const m = fixture();
    const r = request();
    m.hooks.beforeWrite = w => { if (w.resource.resourceType === 'Observation' && JSON.stringify(w.resource.component).includes('OS'))
        throw httpError(503); };
    const first = await pull(m, r);
    assert.notEqual(first.status, 200);
    m.hooks.beforeWrite = undefined;
    const second = await pull(m, request(randomUUID(), { replan: true }));
    assert.equal(second.status, 200, JSON.stringify(second.body));
    assert.deepEqual((second.body as any).findings.outcomes.map((o: any) => o.status), ['unchanged', 'applied']);
    assert.equal(conditions(m).length, 1);
    assert.equal(plans(m).length, 2);
    assert.equal(witnesses(m).length, 1);
    const versions = versionValue(witnesses(m)[0]);
    assert.deepEqual(versions, Object.fromEntries(carried(m).map(o => [`Observation/${o.id}`, o.meta!.versionId])));
    const state = await lineage.readDiagnosisCarryState(m.fhir, conditions(m)[0], carried(m));
    assert.equal(state.edited, false, JSON.stringify(state));
});
for (const failedStep of ['plan', 'link'] as const)
    test(`W124 resumes persisted Condition with failed ${failedStep}`, async () => {
        const m = fixture();
        const r = request();
        m.hooks.beforeWrite = w => { if (failedStep === 'plan' ? w.resource.resourceType === 'Provenance' : w.resource.resourceType === 'Encounter')
            throw httpError(503); };
        const first = await pull(m, r);
        assert.notEqual(first.status, 200);
        assert.equal(conditions(m).length, 1);
        assert.equal(carried(m).length, 0);
        m.hooks.beforeWrite = undefined;
        const second = await pull(m, r);
        assert.equal(second.status, 200, JSON.stringify(second.body));
        assert.equal(conditions(m).length, 1);
        assert.equal(plans(m).length, 1);
        assert.equal(witnesses(m).length, 1);
        assert.equal((m.resources.get('Encounter/e1') as Encounter).diagnosis?.length, 1);
    });
test('W123 two different commands race one conditional Condition owner', async () => {
    const m = fixture();
    let release!: () => void;
    const barrier = new Promise<void>(r => release = r);
    let count = 0;
    m.hooks.beforeWrite = async (w) => { if (w.resource.resourceType === 'Condition') {
        if (++count === 2)
            release();
        await barrier;
    } };
    const results = await Promise.all([pull(m), pull(m)]);
    assert.equal(conditions(m).length, 1);
    assert.equal(carried(m).length, 2);
    assert.equal(witnesses(m).length, 1);
    assert.ok(results.some(r => r.status === 200));
    assert.ok(results.some(r => r.status === 409), JSON.stringify(results));
});
for (const changed of ['void', 'void-undo'] as const)
    test(`W75 W126 ${changed} between facts and witness remains edited`, async () => {
        const m = fixture(['OD']);
        const deps = {...m.deps, writeFindings: async (...args: Parameters<typeof executeFindingCommand>) => {
            const result = await executeFindingCommand(...args);
            const fact = carried(m)[0];
            m.save({...fact, status: 'entered-in-error'});
            if (changed === 'void-undo') m.save({...fact, status: 'preliminary'});
            return result;
        }};
        const result = await handleDiagnosisPullRequest(deps as any, request());
        assert.equal(result.status, 200, JSON.stringify(result.body));
        const state = await lineage.readDiagnosisCarryState(m.fhir, conditions(m)[0], carried(m));
        assert.equal(state.edited, true);
        assert.notEqual(versionValue(witnesses(m)[0])[`Observation/${carried(m)[0].id}`], carried(m)[0].meta!.versionId);
    });
for (const side of ['source', 'destination', 'closed'] as const)
    test(`W79 W91 refuses ${side} before all writes`, async () => {
        const m = fixture();
        if (side === 'closed')
            (m.resources.get('Encounter/e1') as Encounter).status = 'finished';
        else {
            const old = snapshot();
            if (side === 'source')
                old.encounter = { reference: 'Encounter/past' };
            m.save(old);
        }
        const result = await pull(m);
        assert.equal(result.status, 409, JSON.stringify(result.body));
        assert.equal((result.body as any).reason, side === 'closed' ? 'encounter-closed' : 'pre-rebuild-test-encounter');
        assert.equal(m.writes.length, 0);
    });
test('W125 identical interrupted replan resend resumes its stored plan with replan true', async () => {
    const m = fixture();
    m.hooks.beforeWrite = w => { if (w.resource.resourceType === 'Observation' && JSON.stringify(w.resource.component).includes('OS'))
        throw httpError(503); };
    assert.notEqual((await pull(m)).status, 200);
    const replan = request(randomUUID(), { replan: true });
    assert.notEqual((await pull(m, replan)).status, 200);
    const frozen = structuredClone(plans(m).map(planValue));
    m.hooks.beforeWrite = undefined;
    const result = await pull(m, replan);
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.deepEqual(plans(m).map(planValue), frozen);
    assert.equal(conditions(m).length, 1);
    assert.equal(witnesses(m).length, 1);
});
test('W75 completed command resend preserves original witness after a later edit', async () => {
    const m = fixture();
    const r = request();
    assert.equal((await pull(m, r)).status, 200);
    const witness = structuredClone(witnesses(m)[0]);
    m.save({ ...carried(m)[0], status: 'entered-in-error' });
    const before = m.writes.length;
    const result = await pull(m, r);
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.equal((result.body as any).alreadyPresent, true);
    assert.equal(m.writes.length, before);
    assert.deepEqual(witnesses(m), [witness]);
    assert.equal((await lineage.readDiagnosisCarryState(m.fhir, conditions(m)[0], carried(m))).edited, true);
});
test('W104 findings witness lost response is recovered once', async () => {
    const m = fixture();
    const r = request();
    m.hooks.afterWrite = w => { if (w.resource.resourceType === 'Provenance' && w.resource.meta?.tag?.some(t => t.code?.endsWith(':findings')))
        throw httpError(503); };
    const first = await pull(m, r);
    assert.equal(first.status, 200, JSON.stringify(first.body));
    const witness = structuredClone(witnesses(m)[0]);
    m.hooks.afterWrite = undefined;
    const second = await pull(m, r);
    assert.equal(second.status, 200);
    assert.equal(witnesses(m).length, 1);
    assert.deepEqual(witnesses(m)[0], witness);
});
for (const defect of ['auditPending', 'missing-version'] as const)
    test(`W125 unchanged ${defect} refuses witness at the real route`, async () => {
        const m = fixture();
        m.hooks.beforeWrite = w => { if (w.resource.resourceType === 'Observation' && JSON.stringify(w.resource.component).includes('OS'))
            throw httpError(503); };
        assert.notEqual((await pull(m)).status, 200);
        m.hooks.beforeWrite = undefined;
        const deps = { ...m.deps, writeFindings: async (...args: Parameters<typeof executeFindingCommand>) => {
                const result = await executeFindingCommand(...args);
                assert.equal(result.outcomes[0].status, 'unchanged');
                if (defect === 'auditPending')
                    result.outcomes[0].auditPending = true;
                else
                    delete result.outcomes[0].versionId;
                return result;
            } };
        const result = await handleDiagnosisPullRequest(deps as any, request(randomUUID(), { replan: true }));
        assert.notEqual(result.status, 200);
        assert.equal((result.body as any).lineageStep, 'not-attempted');
        assert.equal(witnesses(m).length, 0);
        assert.equal(carried(m).length, 2);
        assert.equal(conditions(m).length, 1);
    });
test('W114 stored practice option carries through effective definitions and historical read', async () => {
    const m = fixture(['OD']);
    const definition = structuredClone(lens);
    definition.sourceStatus = 'local-practice';
    const field = (definition.valueSchema.fields as any)[lensField];
    field.options.push({ code: 'synthetic-practice-option', display: 'Synthetic practice option', active: true });
    m.save(buildFindingDefinitionResource(definition));
    const source = m.resources.get('Observation/source-OD') as Observation;
    const key = { ...keyFor('OD', 'synthetic-practice-option'), encounterId: 'past' };
    source.identifier = [currentFindingIdentifier(key)];
    source.code = { coding: [{ code: `${key.stableKey}::${key.fieldCode}::${key.optionCode}` }] };
    source.component = [comp('R10_CURRENT_META', JSON.stringify(key))];
    const previous = await handlePreviousExamsReadRequest(m.deps as any, { authHeader: 'synthetic', params: { encounterId: 'e1' }, query: {} });
    assert.equal(previous.status, 200, JSON.stringify(previous.body));
    assert.equal((previous.body as any).encounters[0].diagnoses[0].findings[0].display, 'Synthetic practice option');
    const result = await pull(m);
    assert.equal(result.status, 200, JSON.stringify(result.body));
    const parsed = parseCurrentFindingEnvelope(carried(m)[0]);
    assert.equal(parsed.status, 'valid');
    assert.equal(parsed.status === 'valid' && parsed.key.optionCode, 'synthetic-practice-option');
});
test('plan target refusal reports its already persisted Condition and failed plan step', async () => {
    const m = fixture(['OD']);
    const definition = { ...structuredClone(lens), sourceStatus: 'local-practice' as const, active: false };
    m.save(buildFindingDefinitionResource(definition));
    const result = await pull(m);
    assert.equal(result.status, 409, JSON.stringify(result.body));
    assert.equal(conditions(m).length, 1);
    assert.equal((result.body as any).conditionReference, `Condition/${conditions(m)[0].id}`);
    assert.equal((result.body as any).conditionStep, 'applied');
    assert.equal((result.body as any).planStep, 'failed');
    assert.equal((result.body as any).reason, 'inactive-definition');
    assert.equal(plans(m).length, 0);
    assert.equal(carried(m).length, 0);
});
test('completed own command restores a missing Encounter link without changing its findings witness', async () => {
    const m = fixture();
    const r = request();
    assert.equal((await pull(m, r)).status, 200);
    const witness = structuredClone(witnesses(m)[0]);
    (m.resources.get('Encounter/e1') as Encounter).diagnosis = [];
    const result = await pull(m, r);
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.deepEqual((m.resources.get('Encounter/e1') as Encounter).diagnosis?.map(d => d.condition.reference), [`Condition/${conditions(m)[0].id}`]);
    assert.deepEqual(witnesses(m), [witness]);
});
for (const mutation of ['duplicate', 'wrong-target'] as const)
    test(`W75 ${mutation} findings witness produces integrity warning`, async () => {
        const m = fixture();
        assert.equal((await pull(m)).status, 200);
        const witness = structuredClone(witnesses(m)[0]);
        if (mutation === 'duplicate')
            m.save({ ...witness, id: 'duplicate-witness' });
        else {
            witness.target = [witness.target[0]];
            m.save(witness);
        }
        const state = await lineage.readDiagnosisCarryState(m.fhir, conditions(m)[0], carried(m));
        assert.equal(state.edited, true);
        assert.ok(state.integrityWarning);
    });
test('canonical frozen plan scope is checked before relinking or writing facts', async () => {
    const m = fixture();
    const r = request();
    m.hooks.beforeWrite = w => { if (w.resource.resourceType === 'Encounter')
        throw httpError(503); };
    assert.notEqual((await pull(m, r)).status, 200);
    m.hooks.beforeWrite = undefined;
    const provenance = plans(m)[0];
    const plan = planValue(provenance);
    plan.targets[0].key.patientId = 'foreign';
    plan.targets[0].destinationBaseline.key.patientId = 'foreign';
    provenance.extension![0].valueString = JSON.stringify(plan);
    m.save(provenance);
    const before = m.writes.length;
    const result = await pull(m, r);
    assert.equal(result.status, 409, JSON.stringify(result.body));
    assert.equal(m.writes.length, before);
    assert.equal(carried(m).length, 0);
});
test('unconfirmed no-op Encounter link never permits fact writes', async () => {
    const m = fixture();
    const update = m.fhir.update;
    m.fhir.update = async (type, id, resource, headers) => type === 'Encounter' ? structuredClone(resource) : update(type, id, resource, headers);
    const result = await pull(m);
    assert.notEqual(result.status, 200);
    assert.equal((result.body as any).linkStep, 'unconfirmed');
    assert.equal(carried(m).length, 0);
    assert.equal(witnesses(m).length, 0);
    assert.equal(conditions(m).length, 1);
    assert.equal(plans(m).length, 1);
});
for (const commandId of [undefined, 'not-uuid', '11111111-1111-1111-8111-111111111111'])
    test(`carry requires UUIDv4 command ${commandId ?? 'missing'}`, async () => {
        const m = fixture();
        const r = request();
        (r.body as any).commandId = commandId;
        const result = await pull(m, r);
        assert.equal(result.status, 400);
        assert.equal(m.writes.length, 0);
    });
test('empty carry plan completes Condition plan link and skips findings witness', async () => {
    const m = fixture([]);
    const r = request();
    const result = await pull(m, r);
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.equal(plans(m).length, 1);
    assert.equal(planValue(plans(m)[0]).targets.length, 0);
    assert.equal(carried(m).length, 0);
    assert.equal(witnesses(m).length, 0);
    assert.equal((result.body as any).lineageStep, 'not-attempted');
    const before = m.writes.length;
    assert.equal((await pull(m, r)).status, 200);
    assert.equal(m.writes.length, before);
});

test('W111 review closure read failure preserves carry pull command response',async()=>{
 const r=request();
 const run=async(faultAt?:number)=>{
  const m=fixture();let sequence=0,reads=0,faults=0;
  const stabilize=(resource:Resource,keepId=false)=>{
   const old=`${resource.resourceType}/${resource.id}`;
   const stable={...resource,id:keepId||resource.id?.startsWith('stable-')?resource.id:`stable-${++sequence}`,meta:{...resource.meta,versionId:`v${++sequence}`}};
   m.resources.delete(old);m.resources.set(`${stable.resourceType}/${stable.id}`,structuredClone(stable));return stable;
  };
  const create=m.fhir.createWithOutcome.bind(m.fhir),update=m.fhir.update.bind(m.fhir);
  m.fhir.createWithOutcome=async(resource:any,headers:any)=>{const result=await create(resource,headers);return {...result,resource:result.created?stabilize(result.resource):result.resource} as any;};
  m.fhir.update=async(type:any,id:any,resource:any,headers:any)=>stabilize(await update(type,id,resource,headers),true) as any;
  m.hooks.beforeRead=type=>{if(type==='Encounter'&&++reads===faultAt){faults++;throw Error('post-command Encounter unavailable');}};
  const result=await pull(m,r);return {result,reads,faults};
 };
 const expected=await run();assert.equal(expected.result.status,200,JSON.stringify(expected.result.body));assert.equal((expected.result.body as any).lineageStep,'applied');
 const failed=await run(expected.reads);
 assert.deepEqual(failed.result,expected.result);assert.equal(failed.faults,1);
 assert.equal((failed.result.body as any).encounterClosedDuringCommand,undefined);
});
