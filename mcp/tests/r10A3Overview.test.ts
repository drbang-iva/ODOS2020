import assert from 'node:assert/strict';
import {test} from 'node:test';
import type {Observation,Provenance} from '@medplum/fhirtypes';
import {overviewFixture,missing} from './fixtures/r10/overview-harness.js';
import {canonicalFact,command,factTarget,keyFor,writerContext} from './fixtures/r10/writer-harness.js';
import {definitions,lens,lensField,comp,negative} from './fixtures/r10/factories.js';
import {pull,carried} from './fixtures/r10/carry-harness.js';
import {currentFindingIdentifier,findingPanelIdentifier,findingPanelComponents,SUPPORTS_DIAGNOSIS_URL} from '../src/clinical-graph/current-finding-identity.js';
import {executeFindingCommand} from '../src/clinical-graph/current-finding-writer.js';
import {buildFindingDefinitionResource} from '../src/clinical-graph/finding-definition-store.js';
import {odosConcept} from '../src/fhir/ophthalmology/extensions.js';
const tear=definitions.find(d=>d.stableKey.endsWith(':tear-film'))!;
function panel(values:Record<string,string|number>={},extra={}) {const key={v:1 as const,patientId:'p1',encounterId:'e1',stableKey:tear.stableKey,eye:'OD' as const};return {...canonicalFact('panel'),code:odosConcept(tear.stableKey),identifier:[findingPanelIdentifier(key)],component:[comp('R10_PANEL_META',JSON.stringify(key)),...findingPanelComponents({deferred:false,values,...extra},tear)],valueBoolean:undefined};}
for(const status of ['preliminary','final','amended'] as const)test(`V27 live canonical ${status} credits and overview displays`,async()=>{const c=overviewFixture();c.save({...canonicalFact('fact'),status});assert.deepEqual(await missing(c),[]);const r=await c.overview();assert.equal(r.status,200,JSON.stringify(r.body));assert.deepEqual((r.body as any).findings.map((f:any)=>f.observationReference),['Observation/fact']);});
test('W80 extension homes supply overview diagnosis',async()=>{const c=overviewFixture();c.save({...canonicalFact('fact'),extension:[...canonicalFact().extension!,{url:SUPPORTS_DIAGNOSIS_URL,valueReference:{reference:'Condition/current'}}]});const r=await c.overview();assert.equal(r.status,200);assert.equal((r.body as any).findings[0]?.diagnoses[0]?.display,'Synthetic current diagnosis');});
test('W81 cleared canonical cannot credit or display',async()=>{const c=overviewFixture();c.save({...canonicalFact('fact'),status:'entered-in-error'});assert.deepEqual(await missing(c),[lens.stableKey]);assert.deepEqual((await c.overview()).body && ((await c.overview()).body as any).findings,[]);});
test('W81 explicit absent canonical credits',async()=>{const c=overviewFixture();c.save({...canonicalFact(),valueBoolean:false});assert.deepEqual(await missing(c),[]);});
test('W81 explicit negative act credits',async()=>{const c=overviewFixture();c.save(negative());assert.deepEqual(await missing(c),[]);});
for(const values of [{CUSTOM_GRADE_TBUT:8},{CUSTOM_GRADE_TBUT:0}])test(`W118 present TBUT ${Object.values(values)[0]} credits`,async()=>{const c=overviewFixture(tear);c.save(panel(values));assert.deepEqual(await missing(c),[]);const r=await c.overview();assert.equal(r.status,200);assert.ok((r.body as any).findings.some((f:any)=>f.current.components.some((v:any)=>v.code.includes('CUSTOM_GRADE_TBUT'))));});
for(const extra of [{other:'other'},{remarks:'remark'},{deferred:true}])test(`W81 panel context ${Object.keys(extra)[0]} no credit`,async()=>{const c=overviewFixture(tear);c.save(panel({},extra));assert.deepEqual(await missing(c),[tear.stableKey]);});
test('W81 inactive canonical no credit',async()=>{const c=overviewFixture({...lens,active:false});c.save(canonicalFact());assert.deepEqual(await missing(c),[lens.stableKey]);});
test('W114 stored practice option resolves in both consumers',async()=>{const definition=structuredClone(lens);const field=(definition.valueSchema.fields as any)[lensField];field.options.push({code:'practice-option',display:'Practice option',active:true,origin:'practice'});const c=overviewFixture(definition);const key=keyFor('OD','practice-option');c.save({...canonicalFact('practice'),code:odosConcept(`${lens.stableKey}::${lensField}::practice-option`),identifier:[currentFindingIdentifier(key)],component:[comp('R10_CURRENT_META',JSON.stringify(key))]});assert.deepEqual(await missing(c),[]);assert.equal(((await c.overview()).body as any).findings[0]?.observationReference,'Observation/practice');});
for(const mode of ['unchanged','link-only','void-undo','reassert','clinical-edit'] as const)test(`V27 persisted carry ${mode} evidence`,async()=>{const c=overviewFixture();c.resources.delete('Condition/current');assert.equal((await pull(c as any)).status,200);let observation=carried(c as any)[0];if(mode==='link-only')observation=c.save({...observation,extension:[...(observation.extension??[]),{url:SUPPORTS_DIAGNOSIS_URL,valueReference:{reference:'Condition/other'}}]});if(mode==='void-undo'){c.save({...observation,status:'entered-in-error'});observation=c.save({...observation,status:'preliminary'});}if(mode==='clinical-edit')observation=c.save({...observation,component:observation.component!.map(v=>v.code.coding?.some(k=>k.code?.endsWith('::grade'))?{...v,valueCodeableConcept:odosConcept('3+')}:v)});if(mode==='reassert'){const key=keyFor();const r=await executeFindingCommand({...writerContext(c),now:()=> '2026-09-16T13:00:00Z'},command([{kind:'reassert',key,baseline:{kind:'canonical',reference:`Observation/${observation.id}`,versionId:observation.meta!.versionId}}]) as any);assert.equal(r.complete,true);}const expected=mode==='reassert'||mode==='clinical-edit'?[]:[lens.stableKey];assert.deepEqual(await missing(c),expected);});

import {buildExamOverviewProjection} from '../src/clinical-graph/exam-overview-projection.js';
for(const kind of ['fact','panel-value','panel-context','cleared','inactive'] as const)test(`W81 overview completeness ${kind}`,()=>{
  const observation=kind.startsWith('panel')?panel(kind==='panel-value'?{CUSTOM_GRADE_TBUT:4}:{},{remarks:'note'}):{...canonicalFact(),...(kind==='cleared'?{status:'entered-in-error' as const}:{})};
  const definition=kind.startsWith('panel')?tear:{...lens,active:kind!=='inactive'};
  const r=buildExamOverviewProjection({encounterReference:'Encounter/e1',patientReference:'Patient/p1',visitTypeCategoryId:'synthetic',definitions:[definition],currentObservations:[observation],priorObservationCandidates:[],assessmentRows:[],applicabilityRegistry:{synthetic:{required:[{sectionKey:'eye',label:'Eye',evidence:{kind:'finding',sectionKeyPrefixes:['ocular-health:']}}],notIndicated:[]}}});
  assert.equal(r.completeness.status,kind==='fact'||kind==='panel-value'?'complete':'incomplete');
});
test('W118 retired panel value does not credit or display',async()=>{const c=overviewFixture(tear);c.save({...panel({CUSTOM_GRADE_TBUT:4}),status:'entered-in-error'});assert.deepEqual(await missing(c),[tear.stableKey]);assert.deepEqual(((await c.overview()).body as any).findings,[]);});
import {atomic,snapshot} from './fixtures/r10/factories.js';
test('V27 pre-rebuild legacy atomic is displayed through reader view without credit',async()=>{const c=overviewFixture();c.save(atomic('legacy'));const r=await c.overview();assert.equal(r.status,200);assert.ok((r.body as any).findings.some((f:any)=>f.observationReference==='Observation/legacy'));assert.deepEqual(await missing(c),[lens.stableKey]);});

test('W114 overview stored definition dependency resolves practice option label and clinical credit',async()=>{
  const definition=structuredClone(lens);
  (definition.valueSchema.fields as any)[lensField].options.push({code:'practice-option',display:'Practice option',active:true,origin:'practice'});
  const c=overviewFixture(definition),key=keyFor('OD','practice-option');
  c.save({...canonicalFact('practice-overview'),code:odosConcept(`${lens.stableKey}::${lensField}::practice-option`),identifier:[currentFindingIdentifier(key)],component:[comp('R10_CURRENT_META',JSON.stringify(key))]});
  const response=await c.overview();
  assert.equal(response.status,200);
  const finding=(response.body as any).findings.find((row:any)=>row.observationReference==='Observation/practice-overview');
  assert.deepEqual(finding?.sheetFindings,[{display:'Practice option',qualifiers:[]}]);
  assert.equal(finding?.creditsCompleteness,true);
});

for(const kind of ['canonical','panel','negative'] as const)test(`W81 review completeness loads only candidate encounters and retains ${kind} credit`,async()=>{
 const c=overviewFixture(kind==='panel'?tear:lens);
 for(const resource of c.all('Basic'))c.save(JSON.parse(JSON.stringify(resource).replaceAll('this-encounter','any-on-file')));
 for(const resource of c.all('Observation'))c.resources.delete(`Observation/${resource.id}`);
 const original=kind==='panel'?panel({CUSTOM_GRADE_TBUT:4}):kind==='negative'?negative():canonicalFact();
 const prior={...original,encounter:{reference:'Encounter/prior-evidence'}};
 if(kind==='canonical'){const key={...keyFor(),encounterId:'prior-evidence'};prior.identifier=[currentFindingIdentifier(key)];prior.component=[comp('R10_CURRENT_META',JSON.stringify(key))];}
 if(kind==='panel'){const key={v:1 as const,patientId:'p1',encounterId:'prior-evidence',stableKey:tear.stableKey,eye:'OD' as const};prior.identifier=[findingPanelIdentifier(key)];prior.component=prior.component!.map(component=>component.code.coding?.some(code=>code.code==='R10_PANEL_META')?comp('R10_PANEL_META',JSON.stringify(key)):component);}
 c.save(prior);
 c.save({...canonicalFact('irrelevant'),identifier:undefined,component:undefined,code:{text:'Synthetic unrelated result'},encounter:{reference:'Encounter/irrelevant'}});
 const loaded:string[]=[];const search=c.fhir.search;
 c.fhir.search=async(type:any,params:any={})=>{if(type==='Observation'&&params.encounter)loaded.push(params.encounter);return search(type,params);};
 assert.deepEqual(await missing(c),[]);
 assert.ok(loaded.includes('Encounter/e1'));assert.ok(loaded.includes('Encounter/prior-evidence'));assert.equal(loaded.includes('Encounter/irrelevant'),false);
});

test('W81 review completeness bounds concurrent history evidence loads at four',async()=>{
 const c=overviewFixture();
 for(const resource of c.all('Basic'))c.save(JSON.parse(JSON.stringify(resource).replaceAll('this-encounter','any-on-file')));
 for(let i=0;i<9;i++){const key={...keyFor(),encounterId:`prior-${i}`};c.save({...canonicalFact(`prior-${i}`),encounter:{reference:`Encounter/prior-${i}`},identifier:[currentFindingIdentifier(key)],component:[comp('R10_CURRENT_META',JSON.stringify(key))]});}
 let active=0,peak=0;const search=c.fhir.search;
 c.fhir.search=async(type:any,params:any={})=>{if(type!=='Observation'||!params.encounter)return search(type,params);active++;peak=Math.max(peak,active);try{await new Promise(resolve=>setImmediate(resolve));return await search(type,params);}finally{active--;}};
 assert.deepEqual(await missing(c),[]);assert.equal(peak,4);assert.equal(active,0);
});
