import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import type { Resource } from '@medplum/fhirtypes';
import { handleDiagnosisFindingsMutationRequest, handleDiagnosisFindingsAuditRepairRequest } from '../src/clinical-graph/diagnosis-findings-endpoint.js';
import { handleDiagnosisPickRequest } from '../src/clinical-graph/diagnosis-pick-endpoint.js';
import { fixture, AUTH } from './encounterVoidFixture.js';
import { definitions, nuclear } from './fixtures/r10/factories.js';
import { factTarget, memoryFhir } from './fixtures/r10/writer-harness.js';

for (const path of ['door-put','door-audit-repair'] as const) {
  test(`W90 ${path} refuses a closed encounter before clinical or audit writes`, async () => {
    const m = memoryFhir([{resourceType:'Encounter',id:'e1',status:'finished',class:{code:'synthetic'},subject:{reference:'Patient/p1'}} as any]);
    const deps = {fhirBaseUrl:m.fhir.baseUrl, authenticate:async()=>({staffReference:'Practitioner/synthetic',actorRole:'provider' as const,fhir:m.fhir as any}),findingDefinitions:()=>definitions};
    const request = {authHeader:AUTH,params:{encounterId:'e1'},body:{commandId:randomUUID(),patientReference:'Patient/p1',...(path==='door-put'?{operation:'assert',targets:[factTarget()]}:{})}};
    const response = await (path==='door-put'?handleDiagnosisFindingsMutationRequest:handleDiagnosisFindingsAuditRepairRequest)(deps,request);
    assert.equal(response.status,409,JSON.stringify(response.body));
    assert.equal((response.body as any).reason,'encounter-closed');
    assert.equal(m.writes.length,0);
  });
}
test('W90 pick refuses a closed encounter before Condition or Encounter writes', async()=>{
  const {fhir}=fixture({encounterStatus:'finished'});
  const creates:Resource[]=[];
  const clinical = {...fhir,baseUrl:'http://synthetic.local',read:fhir.read.bind(fhir),search:fhir.search.bind(fhir),executeTransaction:fhir.executeTransaction.bind(fhir),create:async(r:Resource)=>{creates.push(r);return fhir.add({...r,id:r.id??`created-${creates.length}`} as Resource);}};
  const response=await handleDiagnosisPickRequest({authenticate:async()=>({staffReference:'Practitioner/doc1',actorRole:'provider',fhir:clinical}),diagnosisVisitStatusStore:{listByEncounter:async()=>[],upsert:async(input:any)=>({...input,updatedAt:input.at,setAt:input.at})}} as any,
    {authHeader:AUTH,params:{encounterId:'e1'},body:{diagnosisKey:nuclear.diagnosisKeys[0],action:'confirm',source:'mapping',laterality:'right'}});
  assert.equal(response.status,409,JSON.stringify(response.body));
  assert.equal((response.body as any).reason,'encounter-closed');
  assert.equal(creates.length,0);assert.equal(fhir.transactions.length,0);
});

test('W111 door returns closure observed after a confirmed command',async()=>{
  const m=memoryFhir([{resourceType:'Encounter',id:'e1',status:'in-progress',class:{code:'synthetic'},subject:{reference:'Patient/p1'}} as any]);
  m.hooks.afterWrite=(_write,resource)=>{if(resource.resourceType==='Observation')m.save({...m.resources.get('Encounter/e1')!,status:'finished'} as any);};
  const response=await handleDiagnosisFindingsMutationRequest({fhirBaseUrl:m.fhir.baseUrl,authenticate:async()=>({staffReference:'Practitioner/synthetic',actorRole:'provider',fhir:m.fhir as any}),findingDefinitions:()=>definitions},
    {authHeader:AUTH,params:{encounterId:'e1'},body:{commandId:randomUUID(),patientReference:'Patient/p1',operation:'assert',targets:[factTarget()]}});
  assert.equal(response.status,200,JSON.stringify(response.body));assert.equal((response.body as any).complete,true);assert.equal((response.body as any).encounterClosedDuringCommand,true);assert.equal(m.all('Observation').length,1);
});

test('W65 W93 non-shared checkbox definition remains editable but its key is refused by the finding door',async()=>{
  const {lens,snapshot}=await import('./fixtures/r10/factories.js');
  const {keyFor}=await import('./fixtures/r10/writer-harness.js');
  const {materializeAtomicFindingCatalog,loadDiagnosisFindingContext}=await import('../src/clinical-graph/diagnosis-findings-endpoint.js');
  const definition={...lens,valueSchema:{...lens.valueSchema,type:'section'}};
  const m=memoryFhir([{resourceType:'Encounter',id:'e1',status:'in-progress',class:{code:'synthetic'},subject:{reference:'Patient/p1'}} as any,snapshot()]);
  assert.equal(materializeAtomicFindingCatalog([definition]).length,0);
  const context=await loadDiagnosisFindingContext(m.fhir as any,'e1',[definition]);assert.equal(context.incomplete,false);if(context.incomplete)throw Error('context');assert.equal(context.projection.preRebuild,false);
  const response=await handleDiagnosisFindingsMutationRequest({fhirBaseUrl:m.fhir.baseUrl,authenticate:async()=>({staffReference:'Practitioner/synthetic',actorRole:'provider',fhir:m.fhir as any}),findingDefinitions:()=>[definition]},
    {authHeader:AUTH,params:{encounterId:'e1'},body:{commandId:randomUUID(),patientReference:'Patient/p1',operation:'assert',targets:[factTarget(keyFor())]}});
  assert.equal(response.status,400);assert.equal((response.body as any).reason,'not-a-shared-finding');assert.equal(m.writes.length,0);
});

for (const scenario of ['select-panel-only','select-with-live-fact','numeric-TBUT-panel-only'] as const) test(`W94 W117 stored ${scenario} mapping produces a candidate without finding supports or evidence reference`,async()=>{
  const {lens,comp,snapshot}=await import('./fixtures/r10/factories.js');
  const {canonicalFact}=await import('./fixtures/r10/writer-harness.js');
  const {customFieldEntries}=await import('../src/clinical-graph/custom-fields.js');
  const {findingPanelIdentifier}=await import('../src/clinical-graph/current-finding-identity.js');
  const {buildFindingDefinitionResource}=await import('../src/clinical-graph/finding-definition-store.js');
  const {handleDiagnosisCandidatesRequest}=await import('../src/clinical-graph/diagnosis-candidates-endpoint.js');
  const numeric=scenario==='numeric-TBUT-panel-only';
  const base=numeric?definitions.find(d=>d.stableKey==='ocular-health:anterior:tear-film')!:lens;
  const field=numeric?customFieldEntries(base).find(f=>f.display==='TBUT')!.localCode:'CUSTOM_panel';
  const definition={...base,sourceStatus:'local-practice',valueSchema:{...base.valueSchema,fields:{...(base.valueSchema.fields as object),...(!numeric?{[field]:{localCode:field,display:'Synthetic selection',origin:'practice',valueType:'select',active:true,order:99,options:[{code:'chosen',display:'Chosen',active:true}]}}:{})}},diagnosisCandidates:[{id:'synthetic-map',origin:'practice',diagnosisKey:numeric?'kcs_not_sjogren':nuclear.diagnosisKeys[0],active:true,trigger:numeric?{kind:'numeric',field,op:'<=',value:5}:{kind:'option',field,anyOf:['chosen']}}]};
  const key={v:1 as const,patientId:'p1',encounterId:'e1',stableKey:base.stableKey,eye:'OD' as const};
  const panel={...snapshot('panel',[]),code:{coding:[{code:base.stableKey}]},identifier:[findingPanelIdentifier(key)],component:[comp('R10_PANEL_META',JSON.stringify(key)),comp(field,numeric?3:'chosen')]};
  const m=memoryFhir([{resourceType:'Encounter',id:'e1',status:'in-progress',class:{code:'synthetic'},subject:{reference:'Patient/p1'}} as any,{...buildFindingDefinitionResource(definition as any),id:'stored'},panel,...(scenario==='select-with-live-fact'?[canonicalFact()]:[])]);
  const search=m.fhir.search.bind(m.fhir);
  m.fhir.search=async(type:any,params:any={})=>type==='Basic'&&params.code?{resourceType:'Bundle',type:'searchset',entry:m.all('Basic').filter((r:any)=>r.code?.coding?.some((c:any)=>`${c.system}|${c.code}`===params.code)).map(resource=>({resource}))} as any:search(type,params);
  const response=await handleDiagnosisCandidatesRequest({authenticate:async()=>({staffReference:'Practitioner/synthetic',actorRole:'provider',fhir:m.fhir as any})},{authHeader:AUTH,params:{encounterId:'e1'}});
  assert.equal(response.status,200,JSON.stringify(response.body));const row=(response.body as any).findings.find((f:any)=>f.findingDefinitionKey===base.stableKey);assert.ok(row,JSON.stringify(response.body));assert.equal(row.observationReference,undefined);assert.equal(row.linkable,false);assert.equal(row.candidates.length,1);assert.equal(row.candidates[0].supportingFacts?.length??0,0);assert.equal(row.candidates[0].linkable,false);assert.equal(m.writes.length,0);
});

test('W93 finding GET searchIndex excludes shared select number and non-shared checkbox fields',async()=>{
  const {lens}=await import('./fixtures/r10/factories.js');
  const {handleDiagnosisFindingsReadRequest}=await import('../src/clinical-graph/diagnosis-findings-endpoint.js');
  const shared={...lens,valueSchema:{...lens.valueSchema,fields:{...(lens.valueSchema.fields as object),CUSTOM_panel:{localCode:'CUSTOM_panel',display:'Synthetic select',origin:'practice',valueType:'select',active:true,order:98,options:[{code:'choice',display:'Choice',active:true}]},CUSTOM_measure:{localCode:'CUSTOM_measure',display:'Synthetic measure',origin:'practice',valueType:'number',active:true,order:99,min:0,max:10,step:1}}}};
  const section={...lens,id:'section-cvf',stableKey:'entrance:synthetic-cvf',valueSchema:{...lens.valueSchema,type:'section'}};
  const m=memoryFhir([{resourceType:'Encounter',id:'e1',status:'in-progress',class:{code:'synthetic'},subject:{reference:'Patient/p1'}} as any]);
  const response=await handleDiagnosisFindingsReadRequest({fhirBaseUrl:m.fhir.baseUrl,authenticate:async()=>({staffReference:'Practitioner/synthetic',actorRole:'provider',fhir:m.fhir as any}),findingDefinitions:()=>[shared,section]},
    {authHeader:AUTH,params:{encounterId:'e1'},query:{}});
  assert.equal(response.status,200,JSON.stringify(response.body));const index=(response.body as any).searchIndex;
  assert.ok(index.some((r:any)=>r.atomicFindingId===nuclear.atomicFindingId && r.eye==='OD'));
  assert.ok(index.some((r:any)=>r.atomicFindingId===nuclear.atomicFindingId && r.eye==='OS'));
  assert.ok(index.every((r:any)=>r.findingDefinitionKey===lens.stableKey && !['CUSTOM_panel','CUSTOM_measure'].includes(r.fieldCode)),JSON.stringify(index));
  assert.equal(m.writes.length,0);
});

test('W92 inactive historical fact remains a labelled read-only row through actual GET',async()=>{
  const {lens}=await import('./fixtures/r10/factories.js');
  const {canonicalFact}=await import('./fixtures/r10/writer-harness.js');
  const {handleDiagnosisFindingsReadRequest}=await import('../src/clinical-graph/diagnosis-findings-endpoint.js');
  const m=memoryFhir([{resourceType:'Encounter',id:'e1',status:'in-progress',class:{code:'synthetic'},subject:{reference:'Patient/p1'}} as any,canonicalFact()]);
  const result=await handleDiagnosisFindingsReadRequest({fhirBaseUrl:m.fhir.baseUrl,authenticate:async()=>({staffReference:'Practitioner/synthetic',actorRole:'provider',fhir:m.fhir as any}),findingDefinitions:()=>[{...lens,active:false}],diagnosisCatalog:()=>[]},{authHeader:AUTH,params:{encounterId:'e1'},query:{}});
  assert.equal(result.status,200);const body=result.body as any;assert.equal(body.encounterEditable,true);assert.equal(body.searchIndex.length,0);const row=body.bySection[lens.sectionKey][0];assert.equal(row.display,nuclear.display);assert.equal(row.editable,false);assert.equal(row.readOnlyReason,'inactive-definition');assert.equal(m.writes.length,0);
});

for (const path of ['door-put', 'door-audit-repair'] as const) {
  test(`W111 review closure read failure preserves ${path} command response`, async () => {
    const m = memoryFhir([{resourceType:'Encounter',id:'e1',status:'in-progress',class:{code:'synthetic'},subject:{reference:'Patient/p1'}} as any]);
    const deps = {fhirBaseUrl:m.fhir.baseUrl, authenticate:async()=>({staffReference:'Practitioner/synthetic',actorRole:'provider' as const,fhir:m.fhir as any}),findingDefinitions:()=>definitions};
    const request = {authHeader:AUTH,params:{encounterId:'e1'},body:{commandId:randomUUID(),patientReference:'Patient/p1',...(path==='door-put'?{operation:'assert',targets:[factTarget()]}:{})}};
    const handler = path === 'door-put' ? handleDiagnosisFindingsMutationRequest : handleDiagnosisFindingsAuditRepairRequest;
    assert.equal((await handler(deps,request)).status,200);
    const expected = await handler(deps,request);
    let reads = 0;
    m.hooks.beforeRead = type => { if(type==='Encounter') reads++; };
    assert.deepEqual(await handler(deps,request),expected);
    const finalRead = reads;
    reads = 0;
    let faults = 0;
    m.hooks.beforeRead = type => { if(type==='Encounter' && ++reads===finalRead) { faults++; throw Error('post-command Encounter unavailable'); } };
    assert.deepEqual(await handler(deps,request),expected);
    assert.equal(faults,1);
    assert.equal((expected.body as any).encounterClosedDuringCommand,undefined);
  });
}

test('W94 review candidate dedupe preserves input objects and unions support',async()=>{
 const {deduplicateDiagnosisCandidates}=await import('../src/clinical-graph/diagnosis-candidates-endpoint.js');
 const key=factTarget().key;
 const first={diagnosisKey:'synthetic',source:'rule',priority:2,order:0};
 const support={rowKey:'synthetic-row',key,baseline:{kind:'canonical',reference:'Observation/fact',versionId:'1'}};
 const second={diagnosisKey:'synthetic',source:'mapping',priority:1,order:1,supportingFacts:[support]};
 const candidates=[first,second],before=structuredClone(candidates);
 const rows=deduplicateDiagnosisCandidates(candidates as any);
 assert.deepEqual(candidates,before);assert.equal(rows.length,1);assert.deepEqual(rows[0].supportingFacts,[support]);assert.notEqual(rows[0],first);
});

function pickClosureFixture() {
  const {deps,fhir}=fixture();deps.findingDefinitions=()=>definitions;
  const search=fhir.search.bind(fhir);
  fhir.search=async(type:any,params:any={})=>{
    const page=await search(type,params);
    return {...page,entry:page.entry?.filter(({resource:r}:any)=>
      (!params.encounter||r.encounter?.reference===params.encounter)&&
      (!params.target||r.target?.some((t:any)=>t.reference===params.target))&&
      (!params._tag||r.meta?.tag?.some((t:any)=>params._tag.split(',').includes(`${t.system}|${t.code}`)))&&
      (!params.date||new Date(r.period?.start).getTime()<new Date(params.date.slice(2)).getTime()))} as any;
  };
  const clinical={...fhir,baseUrl:"http://synthetic.local",read:fhir.read.bind(fhir),search:fhir.search.bind(fhir),executeTransaction:fhir.executeTransaction.bind(fhir),
    create:async(r:Resource)=>fhir.add({...r,id:r.id??`created-${fhir.all(r.resourceType).length}`} as Resource)};
  const authenticate=async()=>({staffReference:"Practitioner/doc1",actorRole:"provider" as const,fhir:clinical});
  return {deps,fhir,clinical,authenticate};
}

test('W111 review closure read failure preserves pick command response',async()=>{
 const request={authHeader:AUTH,params:{encounterId:'e1'},body:{diagnosisKey:nuclear.diagnosisKeys[0],action:'confirm',source:'mapping',laterality:'right'}};
 const run=async(faultAt?:number)=>{
  const c=pickClosureFixture();let reads=0,faults=0;
  const read=c.clinical.read;
  c.clinical.read=async(type:any,id:any)=>{if(type==='Encounter'&&++reads===faultAt){faults++;throw Error('post-command Encounter unavailable');}return read(type,id);};
  const execute=c.clinical.executeTransaction;
  c.clinical.executeTransaction=async(bundle)=>{
   const response=await execute(bundle);
   const refs=new Map((bundle.entry??[]).map((entry,index)=>[entry.fullUrl,response.entry?.[index]?.response?.location?.split('/_history/')[0]]));
   for(const entry of response.entry??[]){const [type,id]=entry.response!.location!.split('/_history/')[0].split('/');const resource=await c.fhir.read(type as any,id);const resolved=JSON.parse(JSON.stringify(resource),(_key,value)=>typeof value==='string'&&refs.has(value)?refs.get(value):value);c.fhir.replace(resolved);entry.resource=resolved;}
   return response;
  };
  const result=await handleDiagnosisPickRequest({authenticate:c.authenticate,now:()=> '2026-09-16T12:00:00Z',diagnosisVisitStatusStore:{listByEncounter:async()=>[],upsert:async(input:any)=>({...input,updatedAt:input.at,setAt:input.at})}} as any,request);
  return {result,reads,faults};
 };
 const expected=await run();assert.equal(expected.result.status,200,JSON.stringify(expected.result.body));assert.equal((expected.result.body as any).conditionStep,'applied');
 const failed=await run(expected.reads);assert.deepEqual(failed.result,expected.result);assert.equal(failed.faults,1);assert.equal((failed.result.body as any).encounterClosedDuringCommand,undefined);
});
