import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { Bundle, Condition, Encounter, Observation, Provenance, Resource } from '@medplum/fhirtypes';
import { fixture, AUTH, type MemoryFhir } from '../../encounterVoidFixture.js';
import { fixture as carryFixture, request as carryRequest } from './carry-harness.js';
import { keyFor } from './writer-harness.js';
import { lens, lensField, nuclear } from './factories.js';
import { createWriteRecorder, classifyWriteTrace, type WritePathEvidence, type WriteTrace } from './write-path-recorder.js';
import { FhirFindingDefinitionStore, buildFindingDefinitionResource, buildFindingDefinitionSeeds } from '../../../src/clinical-graph/finding-definition-store.js';
import { customFieldEntries } from '../../../src/clinical-graph/custom-fields.js';
import { findPendingAudits, parseCurrentFindingEnvelope, SUPPORTS_DIAGNOSIS_URL } from '../../../src/clinical-graph/current-finding-identity.js';
import { handleDiagnosisFindingsMutationRequest, handleDiagnosisFindingsAuditRepairRequest } from '../../../src/clinical-graph/diagnosis-findings-endpoint.js';
import { handleDiagnosisPickRequest } from '../../../src/clinical-graph/diagnosis-pick-endpoint.js';
import { handleCustomSectionCaptureRequest, handleCustomSectionHistoryRequest } from '../../../src/clinical-graph/custom-section-endpoint.js';
import { handleDiagnosisPullRequest } from '../../../src/clinical-graph/diagnosis-carry-forward-endpoint.js';
import { handleEncounterVoidRequest } from '../../../src/clinical-graph/encounter-void-endpoint.js';
import { handleEncounterUndoRequest } from '../../../src/clinical-graph/encounter-undo-endpoint.js';

const params={encounterId:'e1'},patientReference='Patient/p1',encounterReference='Encounter/e1';
const empty:WriteTrace={attempted:[],persisted:[]};
const input=(body:unknown)=>({authHeader:AUTH,params,body});
const snapshot=(fhir:MemoryFhir)=>['Patient','Encounter','Condition','Observation','Provenance','Basic','ChargeItem'].flatMap(type=>fhir.all(type as Resource['resourceType']));
const state=()=>({status:'live' as const,presence:'present' as const,qualifiers:{},homes:[] as string[]});
function assertCommand(result:any,id:string){assert.equal(result.status,200,`${id}: ${JSON.stringify(result.body)}`);assert.equal(result.body.complete,true,`${id}: incomplete`);}

async function base(scenarioId:string,practiceOption=false){
  const {fhir}=fixture();fhir.add({resourceType:'Patient',id:'p1'});
  if(practiceOption){const definition=buildFindingDefinitionSeeds().find(d=>d.stableKey===lens.stableKey)!,fields=structuredClone(definition.valueSchema.fields) as any;fields[lensField].options.push({code:'runtime-practice',display:'Synthetic practice option',active:true});fhir.add({...buildFindingDefinitionResource({...definition,sourceStatus:'local-practice',valueSchema:{...definition.valueSchema,fields}}),id:'runtime-definition'});}
  const recorder=createWriteRecorder({scenarioId,snapshot:()=>snapshot(fhir)});
  const client=recorder.wrap({baseUrl:fhir.baseUrl,read:fhir.read.bind(fhir),update:fhir.update.bind(fhir),createWithOutcome:fhir.createWithOutcome.bind(fhir),
    search:async(type:any,query:any={})=>{const page=await fhir.search(type,query);return query.target?{...page,entry:page.entry?.filter((e:any)=>e.resource.target?.some((t:any)=>t.reference===query.target))}:page;},
    create:async(resource:any,headers?:Record<string,string>)=>(await fhir.createWithOutcome(resource,headers)).resource,
    executeTransaction:async(bundle:Bundle)=>{
      const response=await fhir.executeTransaction(bundle);
      const references=new Map((bundle.entry??[]).map((entry,index)=>[entry.fullUrl,response.entry?.[index]?.response?.location?.split('/_history/')[0]]));
      for(const entry of response.entry??[]){const reference=entry.response!.location!.split('/_history/')[0], [type,id]=reference.split('/');const resource=await fhir.read(type as Resource['resourceType'],id);const resolved=JSON.parse(JSON.stringify(resource),(_key,value)=>typeof value==='string'&&references.has(value)?references.get(value):value);fhir.replace(resolved);entry.resource=resolved;}
      return response;
    }});
  const definitions=await new FhirFindingDefinitionStore(client as any).list();
  const deps={fhirBaseUrl:client.baseUrl,authenticate:async()=>({staffReference:'Practitioner/doc1',actorRole:'provider' as const,fhir:client}),findingDefinitions:()=>definitions};
  const close=()=>fhir.replace({...fhir.get<Encounter>('Encounter','e1'),status:'finished'});
  return {fhir,client,recorder,definitions,deps,close,scenarioId};
}
type Base=Awaited<ReturnType<typeof base>>;
const doorBody=(key=keyFor())=>({commandId:randomUUID(),patientReference,operation:'assert',targets:[{kind:'fact',key,baseline:{kind:'absent',key},state:state()}]});
const door=(b:Base,body=doorBody())=>handleDiagnosisFindingsMutationRequest(b.deps as any,input(body));
const ocular=(b:Base,eyes:any,stableKey=lens.stableKey)=>handleCustomSectionCaptureRequest(b.deps as any,{authHeader:AUTH,params:{stableKey},body:{commandId:randomUUID(),patientReference,encounterReference,eyes}});
const claim=(key=keyFor())=>({key,baseline:{kind:'absent',key},presence:'present',qualifiers:{},homes:[]});
const ocularFact=()=>({OD:{loaded:[],selected:[claim()]}});
const ocularPanel=(stableKey=lens.stableKey,values:Record<string,number|string>={})=>({OD:{loaded:[],selected:[],panel:{baseline:{kind:'absent',key:{v:1,patientId:'p1',encounterId:'e1',stableKey,eye:'OD'}},state:{deferred:false,values,remarks:'Synthetic panel'}}}});
async function reject(b:Base,call:()=>Promise<any>,status:number,reason:string):Promise<WritePathEvidence['rejection']>{
  const setup=b.recorder.since({attempted:0,persisted:0});classifyWriteTrace(setup,b.definitions,`${b.scenarioId}:rejection-setup`);
  const mark=b.recorder.mark(),before=JSON.stringify(snapshot(b.fhir)),result=await call(),trace=b.recorder.since(mark);
  assert.equal(result.status,status,`${b.scenarioId}: ${JSON.stringify(result.body)}`);assert.equal(result.body.reason??result.body.code,reason,b.scenarioId);
  assert.deepEqual(trace,empty,`${b.scenarioId}: refusal attempted/persisted writes`);assert.equal(JSON.stringify(snapshot(b.fhir)),before,`${b.scenarioId}: refusal changed state`);
  return {...trace,scenarioId:b.scenarioId,responseStatus:status,reason,setup};
}
function finish(b:Base,id:string,handler:string,result:any,trace:WriteTrace,rejection:WritePathEvidence['rejection'],setup=empty):WritePathEvidence{
  assert.equal(result.status,200,`${id}: ${JSON.stringify(result.body)}`);assert.ok(trace.attempted.length,`${id}: no handler write attempt`);assert.ok(trace.persisted.length,`${id}: no persisted handler write`);
  classifyWriteTrace(setup,b.definitions,`${id}:setup`);
  return {id,scenarioId:b.scenarioId,handler,responseStatus:result.status,...trace,observations:classifyWriteTrace(trace,b.definitions,id),rejection,setup};
}

export async function runEndpointWritePaths():Promise<WritePathEvidence[]>{
  const results:WritePathEvidence[]=[];
  {
    const b=await base('door-put-success',true),key=keyFor('OD','runtime-practice'),mark=b.recorder.mark(),result=await door(b,doorBody(key));assertCommand(result,'door-put');
    const trace=b.recorder.since(mark);assert.equal(trace.persisted.filter(w=>w.resource.resourceType==='Observation').length,1);
    const negative=await base('door-put-closed',true);negative.close();const rejection=await reject(negative,()=>door(negative,doorBody(key)),409,'encounter-closed');
    const evidence=finish(b,'door-put','handleDiagnosisFindingsMutationRequest',result,trace,rejection);assert.ok(evidence.observations.every(o=>o.kind==='canonical-fact'));results.push(evidence);
  }
  {
    const b=await base('door-audit-repair-success'),start=b.recorder.mark();b.fhir.beforeWrite=r=>{if(r.resourceType==='Provenance')throw Error('synthetic audit unavailable');};const preparation:any=await door(b);assert.equal(preparation.body.complete,false);b.fhir.beforeWrite=undefined;
    assert.equal((await findPendingAudits(b.client as any,b.fhir.all('Observation'))).size,1);const setup=b.recorder.since(start),before=b.fhir.all('Observation'),mark=b.recorder.mark();
    const result=await handleDiagnosisFindingsAuditRepairRequest(b.deps as any,input({commandId:randomUUID(),patientReference}));assertCommand(result,'door-audit-repair');const trace=b.recorder.since(mark);assert.equal(trace.attempted.some(w=>w.resource.resourceType==='Observation'),false);assert.deepEqual(b.fhir.all('Observation'),before);assert.equal((await findPendingAudits(b.client as any,b.fhir.all('Observation'))).size,0);
    const negative=await base('door-repair-closed');negative.fhir.beforeWrite=r=>{if(r.resourceType==='Provenance')throw Error('synthetic pending audit');};await door(negative);negative.fhir.beforeWrite=undefined;negative.close();
    const rejection=await reject(negative,()=>handleDiagnosisFindingsAuditRepairRequest(negative.deps as any,input({commandId:randomUUID(),patientReference})),409,'encounter-closed');results.push(finish(b,'door-audit-repair','handleDiagnosisFindingsAuditRepairRequest',result,trace,rejection,setup));
  }
  {
    const b=await base('pick-condition-success'),start=b.recorder.mark();assertCommand(await door(b),'pick setup');const owner=b.fhir.all<Observation>('Observation')[0],body={commandId:randomUUID(),diagnosisKey:nuclear.diagnosisKeys[0],action:'confirm',source:'mapping',supportingFacts:[{key:keyFor(),baseline:{kind:'canonical',reference:`Observation/${owner.id}`,versionId:owner.meta!.versionId}}]};
    const deps={...b.deps,diagnosisVisitStatusStore:{listByEncounter:async()=>[],upsert:async()=>{throw Error('Unexpected status mutation');}}};const setup=b.recorder.since(start),mark=b.recorder.mark(),result:any=await handleDiagnosisPickRequest(deps as any,input(body)),trace=b.recorder.since(mark);
    assert.equal(result.body.conditionStep,'applied');assert.equal(result.body.link,'pending');const conditions=b.fhir.all<Condition>('Condition');assert.equal(conditions.length,1);assert.equal(conditions[0].evidence,undefined);assert.equal(trace.attempted.some(w=>w.resource.resourceType==='Observation'),false);assert.ok(b.fhir.get<Encounter>('Encounter','e1').diagnosis?.some(d=>d.condition.reference===`Condition/${conditions[0].id}`));
    b.close();const rejection=await reject(b,()=>handleDiagnosisPickRequest(deps as any,input({...body,commandId:randomUUID()})),409,'encounter-closed');results.push(finish(b,'pick-condition','handleDiagnosisPickRequest',result,trace,rejection,setup));
  }
  for(const kind of ['fact','panel','negative-act'] as const){
    const id=kind==='negative-act'?'oh-negative-act':`oh-save-${kind}`,b=await base(`${id}-success`);
    const definition=kind==='panel'?b.definitions.find(d=>d.stableKey.endsWith(':tear-film'))!:lens;
    const valueField=kind==='panel'?customFieldEntries(definition).find(f=>f.display==='TBUT')!:undefined;
    const negative={id:randomUUID(),scope:[keyFor().optionCode],exclusions:[]};
    const eyes=kind==='fact'?ocularFact():kind==='panel'?ocularPanel(definition.stableKey,{[valueField!.localCode]:5}):{OD:{loaded:[],selected:[],negativeAct:negative}};
    const mark=b.recorder.mark(),result=await ocular(b,eyes,definition.stableKey);assertCommand(result,id);const trace=b.recorder.since(mark);
    const history:any=await handleCustomSectionHistoryRequest(b.deps as any,{authHeader:AUTH,params:{stableKey:definition.stableKey},query:{patient:patientReference,encounter:encounterReference}});assert.equal(history.status,200);assert.deepEqual(b.recorder.since(mark),trace,`${id}: history wrote`);
    if(kind==='panel')assert.equal(history.body.eyes.OD.panel.values[valueField!.localCode],5);
    if(kind==='fact')assert.equal(history.body.eyes.OD.facts.filter((f:any)=>f.status==='live').length,1);
    const refusal=await base(`${id}-refusal`);let rejection:WritePathEvidence['rejection'];
    if(kind==='negative-act')rejection=await reject(refusal,()=>ocular(refusal,{OD:{loaded:[],selected:[claim()],negativeAct:negative}}),409,'positive-in-negative-scope');
    else {refusal.close();rejection=await reject(refusal,()=>ocular(refusal,eyes,definition.stableKey),409,'encounter-closed');}
    const evidence=finish(b,id,'handleCustomSectionCaptureRequest',result,trace,rejection);const expected=kind==='fact'?'canonical-fact':kind==='panel'?'panel-context':'negative-act';assert.ok(evidence.observations.length);assert.ok(evidence.observations.every(o=>o.kind===expected),id);if(kind==='negative-act')assert.equal(b.fhir.all<Observation>('Observation').some(o=>o.component?.some(c=>c.code.coding?.some(k=>k.code==='EXAM_STATE'))),false);results.push(evidence);
  }
  {
    const b=await base('lifecycle-success'),start=b.recorder.mark();assertCommand(await ocular(b,ocularFact()),'lifecycle fact setup');assertCommand(await ocular(b,ocularPanel()),'lifecycle panel setup');const originals=b.fhir.all<Observation>('Observation'),setup=b.recorder.since(start),voidMark=b.recorder.mark();
    const voidResult:any=await handleEncounterVoidRequest(b.deps as any,input({scope:'section',sectionKey:lens.sectionKey}));assert.equal(voidResult.status,200);assert.equal(voidResult.body.count,2);assert.equal(voidResult.body.voidActionId,voidResult.body.ledger.sections[lens.sectionKey!].voidActionId);const voidTrace=b.recorder.since(voidMark);assert.ok(b.fhir.all<Observation>('Observation').every(o=>o.status==='entered-in-error'));
    const bad=await base('void-signed');assertCommand(await ocular(bad,ocularFact()),'signed setup');const signed=bad.fhir.all<Observation>('Observation')[0];bad.fhir.replace({...signed,status:'final'});const voidRejection=await reject(bad,()=>handleEncounterVoidRequest(bad.deps as any,input({scope:'encounter'})),422,'signed-or-cancelled');results.push(finish(b,'void','handleEncounterVoidRequest',voidResult,voidTrace,voidRejection,setup));
    const undoMark=b.recorder.mark(),undoResult:any=await handleEncounterUndoRequest(b.deps as any,input({scope:'section',sectionKey:lens.sectionKey,voidActionId:voidResult.body.voidActionId})),undoTrace=b.recorder.since(undoMark);assert.equal(undoResult.status,200);assert.equal(undoResult.body.count,2);
    for(const prior of originals){const current=b.fhir.get<Observation>('Observation',prior.id!);assert.equal(current.status,prior.status);const {meta:_a,...a}=current,{meta:_b,...original}=prior;assert.deepEqual(a,original,'lifecycle preserves clinical content');}
    const v2:any=await handleEncounterVoidRequest(b.deps as any,input({scope:'section',sectionKey:lens.sectionKey}));assert.equal(v2.status,200);const undoRejection=await reject(b,()=>handleEncounterUndoRequest(b.deps as any,input({scope:'section',sectionKey:lens.sectionKey,voidActionId:voidResult.body.voidActionId})),409,'undo-superseded');results.push(finish(b,'undo','handleEncounterUndoRequest',undoResult,undoTrace,undoRejection,{attempted:[...setup.attempted,...voidTrace.attempted],persisted:[...setup.persisted,...voidTrace.persisted]}));
  }
  results.push(...await runCarryPaths());
  assert.equal(results.length,13);assert.equal(new Set(results.map(r=>r.id)).size,13);return results;
}

async function runCarryPaths():Promise<WritePathEvidence[]>{
  const memory=carryFixture(),recorder=createWriteRecorder({scenarioId:'carry-success',snapshot:()=>[...memory.resources.values()]}),client=recorder.wrap(memory.fhir),definitions=await new FhirFindingDefinitionStore(client as any).list();
  const deps={...memory.deps,authenticate:async()=>({...await memory.deps.authenticate(),fhir:client})};
  const request=carryRequest(),mark=recorder.mark(),source=structuredClone(memory.all<Observation>('Observation')),result:any=await handleDiagnosisPullRequest(deps as any,request),trace=recorder.since(mark);assert.equal(result.status,200,JSON.stringify(result.body));for(const field of ['conditionStep','planStep','linkStep','lineageStep'])assert.equal(result.body[field],'applied');
  const destination=memory.all<Observation>('Observation').filter(o=>o.encounter?.reference===encounterReference),conditions=memory.all<Condition>('Condition').filter(c=>c.encounter?.reference===encounterReference);assert.equal(conditions.length,1);assert.equal(destination.length,2);assert.deepEqual(destination.map(o=>{const p=parseCurrentFindingEnvelope(o);assert.equal(p.status,'valid');return p.status==='valid'?p.key.eye:'';}).sort(),['OD','OS']);assert.deepEqual(memory.all<Observation>('Observation').filter(o=>o.encounter?.reference==='Encounter/past'),source);
  for(const owner of destination){assert.ok(owner.extension?.some(e=>e.url===SUPPORTS_DIAGNOSIS_URL&&e.valueReference?.reference===`Condition/${conditions[0].id}`));assert.equal(owner.component?.find(c=>c.code.coding?.some(k=>k.code?.endsWith('::grade')))?.valueCodeableConcept?.coding?.[0]?.code,'2+');}
  assert.equal(conditions[0].evidence,undefined);
  assert.ok((memory.resources.get(encounterReference) as Encounter).diagnosis?.some(row=>row.condition.reference===`Condition/${conditions[0].id}`));
  const conditionWrite=trace.attempted.find(w=>w.resource.resourceType==='Condition')!;
  assert.ok(decodeURIComponent(conditionWrite.headers?.['If-None-Exist']??'').includes('urn:odos:carry-diagnosis:v1'));
  const lineage=memory.all<Provenance>('Provenance').find(p=>p.meta?.tag?.some(t=>t.system==='urn:odos:carry-command:v1'&&t.code?.endsWith(':findings')))!;
  const versions=JSON.parse(lineage.extension!.find(e=>e.url.endsWith('/carry-versions'))!.valueString!);
  for(const owner of destination)assert.equal(versions[`Observation/${owner.id}`],owner.meta?.versionId);
  const refused=carryFixture(),rejectRecorder=createWriteRecorder({scenarioId:'carry-closed',snapshot:()=>[...refused.resources.values()]}),rejectClient=rejectRecorder.wrap(refused.fhir);refused.save({...refused.resources.get(encounterReference) as Encounter,status:'finished'});const before=JSON.stringify([...refused.resources.values()]),negative:any=await handleDiagnosisPullRequest({...refused.deps,authenticate:async()=>({...await refused.deps.authenticate(),fhir:rejectClient})} as any,carryRequest());assert.equal(negative.status,409);assert.equal(negative.body.reason,'encounter-closed');const rejection={...rejectRecorder.since({attempted:0,persisted:0}),scenarioId:'carry-closed',responseStatus:negative.status,reason:negative.body.reason};assert.deepEqual(rejection.attempted,[]);assert.deepEqual(rejection.persisted,[]);assert.equal(JSON.stringify([...refused.resources.values()]),before);
  function phase(resource:Resource):string{if(resource.resourceType==='Condition')return 'carry-condition';if(resource.resourceType==='Encounter')return 'carry-link';if(resource.resourceType==='Observation')return 'carry-facts';assert.equal(resource.resourceType,'Provenance');const suffix=resource.meta?.tag?.find(t=>t.system==='urn:odos:carry-command:v1')?.code;if(suffix?.endsWith(':plan'))return 'carry-plan';if(suffix?.endsWith(':findings'))return 'carry-lineage';assert.ok(resource.meta?.tag?.some(t=>t.system==='urn:odos:finding-operation:v1'),'unattributed carry Provenance');return 'carry-facts';}
  const ids=['carry-condition','carry-plan','carry-link','carry-facts','carry-lineage'];const evidence=ids.map(id=>{const own={attempted:trace.attempted.filter(w=>phase(w.resource)===id),persisted:trace.persisted.filter(w=>phase(w.resource)===id)};assert.ok(own.attempted.length,`${id}: missing attempted phase`);assert.ok(own.persisted.length,`${id}: missing persisted phase`);return {id,scenarioId:'carry-success',handler:'handleDiagnosisPullRequest',responseStatus:result.status,...own,observations:classifyWriteTrace(own,definitions,id),rejection,setup:empty};});
  assert.equal(evidence.reduce((n,r)=>n+r.attempted.length,0),trace.attempted.length);assert.equal(evidence.reduce((n,r)=>n+r.persisted.length,0),trace.persisted.length);
  return evidence;
}

export { base as endpointWriteFixture };
