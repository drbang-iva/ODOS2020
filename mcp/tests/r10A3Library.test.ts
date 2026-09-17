import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Observation, Provenance } from '@medplum/fhirtypes';
import * as identity from '../src/clinical-graph/current-finding-identity.js';
import { executeFindingCommand, repairPendingAudits, classifyReplay, type FindingCommand } from '../src/clinical-graph/current-finding-writer.js';
import { loadEncounterFindingState, projectCurrentFindings } from '../src/clinical-graph/current-finding-reader.js';
import { materializeAtomicFindingCatalog } from '../src/clinical-graph/diagnosis-findings-endpoint.js';
import { lens, lensField, comp, state, snapshot, definitions } from './fixtures/r10/factories.js';
import { canonicalFact, command, factTarget, keyFor, memoryFhir, writerContext, httpError } from './fixtures/r10/writer-harness.js';
const panelKey = { v:1 as const, patientId:'p1', encounterId:'e1', stableKey:lens.stableKey, eye:'OD' as const };
const definition = {...lens, valueSchema:{...lens.valueSchema, fields:{...(lens.valueSchema.fields as object), CUSTOM_measure:{localCode:'CUSTOM_measure',display:'Measurement',origin:'practice',valueType:'number',min:0,max:20,step:0.5,active:true,order:20}, CUSTOM_method:{localCode:'CUSTOM_method',display:'Method',origin:'practice',valueType:'select',active:true,order:21,options:[{code:'a',display:'A',active:true},{code:'old',display:'Old',active:false}]},CUSTOM_note:{localCode:'CUSTOM_note',display:'Note',origin:'practice',valueType:'string',active:true,order:22}}}};
const defs=definitions.map(d=>d.stableKey===lens.stableKey?definition:d);
const context=(m:ReturnType<typeof memoryFhir>)=>({...writerContext(m),definitions:defs});
const run=(m:ReturnType<typeof memoryFhir>,c:ReturnType<typeof command>)=>executeFindingCommand(context(m),c as FindingCommand);
const target=(baseline:unknown={kind:'absent',key:panelKey}, values:Record<string,number|string>={CUSTOM_measure:2.5})=>({kind:'panel',key:panelKey,baseline,state:{deferred:true,other:' Other ',remarks:' Remarks ',values}});
const project=async(m:ReturnType<typeof memoryFhir>)=>projectCurrentFindings(await loadEncounterFindingState(m.fhir,{...state([]),definitions:defs,includeAuditState:true}));
function panel(id='panel'):Observation {return {...snapshot(id,[]), identifier:[identity.findingPanelIdentifier(panelKey)],component:[comp('R10_PANEL_META',JSON.stringify(panelKey)),comp('CUSTOM_measure',2.5)]};}

test('W65 ownership restricts catalog and section classification',()=>{
 const section={...definition,stableKey:'cvf',valueSchema:{...definition.valueSchema,type:'section'}};
 assert.equal(materializeAtomicFindingCatalog([section]).length,0);
 assert.equal(identity.classifyFindingObservation({...snapshot(),code:{coding:[{code:'cvf'}]}},[section],[],new Map()).kind,'unrelated');
 assert.ok(materializeAtomicFindingCatalog([definition]).every(r=>r.fieldCode!== 'CUSTOM_method'));
});
for(const inactive of ['definition','field','option'])test(`W92 inactive ${inactive} remains canonical read-only`,()=>{
 const d=structuredClone(lens); if(inactive==='definition')d.active=false; else {const f=(d.valueSchema.fields as any)[lensField];if(inactive==='field')f.active=false;else f.options.find((o:any)=>o.code===keyFor().optionCode).active=false;}
 const p=projectCurrentFindings(state([canonicalFact()],{definitions:[d],catalog:materializeAtomicFindingCatalog([d])}));
 assert.equal(p.preRebuild,false);assert.equal(p.currentFacts[0]?.editable,false);assert.equal(p.currentFacts[0]?.readOnlyReason,'inactive-definition');
});
test('W71 strict panel identity rejects hash envelope mixed markers and duplicate owners',()=>{
 const valid=panel();assert.equal(identity.classifyFindingObservation(valid,defs,[],new Map()).kind,'panel-context');
 for(const bad of [{...valid,identifier:[{system:identity.FINDING_PANEL_SYSTEM,value:'wrong'}]}, {...valid,component:[]},{...valid,component:[...valid.component!,comp('R10_CURRENT_META','{}')]},{...valid,identifier:[...valid.identifier!,identity.currentFindingIdentifier(keyFor())]}])assert.equal(identity.classifyFindingObservation(bad,defs,[],new Map()).kind,'invalid');
 const p=projectCurrentFindings(state([valid,{...panel('retired'),status:'entered-in-error'}],{definitions:defs}));assert.equal(p.panels[0].conflict,true);assert.equal(p.panels[0].panelBaseline,undefined);
});
test('W95 panel rejects unknown owned inactive select and invalid typed values without writes',async()=>{
 for(const values of [{unknown:3},{[lensField]:'x'},{CUSTOM_method:'old'},{CUSTOM_measure:2.3},{CUSTOM_measure:30},{CUSTOM_note:' '}]){const m=memoryFhir();await assert.rejects(run(m,command([target(undefined,values)])),{status:400});assert.equal(m.writes.length,0);}
});
test('W112 W117 panel writer roundtrip replay conflict and revive retain identity',async()=>{
 const m=memoryFhir();const c=command([target()]);assert.equal((await run(m,c)).complete,true);
 let p=await project(m);assert.equal(p.currentFacts.length,0);assert.deepEqual(p.panels[0].values,{CUSTOM_measure:2.5});assert.equal(p.panels[0].other,'Other');assert.equal(p.definitionViews.length,1);assert.equal(p.definitionViews[0].id,undefined);assert.equal(p.definitionViews[0].contributors[0].kind,'panel-context');
 assert.equal((await run(m,c)).outcomes[0].status,'already-applied');
 const o=m.all<Observation>('Observation')[0];m.save({...o,status:'entered-in-error'});p=await project(m);assert.deepEqual(p.panels[0].values,{});
 assert.equal((await run(m,command([target(p.panels[0].panelBaseline)]))).complete,true);assert.equal(m.all('Observation').length,1);assert.equal(m.all('Observation')[0].id,o.id);
});
for(const mutation of ['agent','activity','system','instant','targets','mixed'])test(`W83 W109 rejects audit ${mutation}`,async()=>{
 const m=memoryFhir();await run(m,command([factTarget()]));const audit=m.all<Provenance>('Provenance')[0];const bad=structuredClone(audit);
 if(mutation==='agent')bad.agent[0].who.reference='Practitioner/forged';if(mutation==='activity')bad.activity!.coding![0].code='DELETE';if(mutation==='system')bad.activity!.coding![0].system='wrong';if(mutation==='instant')bad.recorded='2026-09-16T12:00:00.001Z';if(mutation==='targets')bad.target.push({reference:'Observation/extra'});
 if(mutation==='mixed'){bad.id='forged';bad.agent[0].who.reference='Practitioner/forged';}m.resources.set(`Provenance/${bad.id}`,bad);
 const p=await project(m);assert.equal(p.currentFacts[0].auditPending,true);assert.equal(p.currentFacts[0].auditIntegrity,'mismatch');const before=m.writes.length;
 const repaired=await repairPendingAudits(context(m),command([]));assert.equal(repaired.outcomes[0].reason,'audit-mismatch');assert.equal(repaired.outcomes[0].status,'not-attempted');assert.equal(m.writes.length,before);
});
test('W83 equivalent recorded instants and duplicate targets accepted',async()=>{const m=memoryFhir();await run(m,command([factTarget()]));const a=m.all<Provenance>('Provenance')[0];a.recorded=a.recorded.replace('.000Z','Z');a.target.push(a.target[0]);m.resources.set(`Provenance/${a.id}`,a);assert.equal((await project(m)).currentFacts[0].auditPending,undefined);});
test('W84 actor-bound reassertion rejects changed actor',async()=>{const m=memoryFhir([canonicalFact()]);const c=command([{kind:'reassert',key:keyFor(),baseline:{kind:'canonical',reference:'Observation/canonical',versionId:'v1'}}]);assert.equal((await run(m,c)).complete,true);const result=await executeFindingCommand({...context(m),staffReference:'Practitioner/other'},c as FindingCommand);assert.equal(result.outcomes[0].reason,'command-reused');assert.equal(m.all('Provenance').length,1);});
test('W106 W110 selected panel audit repair leaves other debt unchanged',async()=>{const m=memoryFhir();m.hooks.beforeWrite=w=>{if(w.resource.resourceType==='Provenance')throw httpError(403);};await run(m,command([target()]));await run(m,command([factTarget()]));m.hooks.beforeWrite=undefined;const p=await project(m);assert.equal(p.panels[0].auditPending,true);const ref=p.panels[0].panelBaseline!.reference;await repairPendingAudits(context(m),command([]),{targets:[ref]});const after=await project(m);assert.equal(after.panels[0].auditPending,undefined);assert.equal(after.currentFacts[0].auditPending,true);});
for(const kind of ['fact','panel','reassert'])for(const deletion of ['empty','404','410'])test(`W85 W128 ${kind} ${deletion} deletion conflicts before write or replay`,async()=>{
 const m=memoryFhir(kind==='reassert'?[canonicalFact()]:[]);const c=command([kind==='panel'?target():kind==='fact'?factTarget():{kind:'reassert',key:keyFor(),baseline:{kind:'canonical',reference:'Observation/canonical',versionId:'v1'}}]);await run(m,c);const o=m.all<Observation>('Observation')[0];const before=m.writes.length;
 if(deletion==='empty')m.resources.delete(`Observation/${o.id}`);else m.hooks.beforeRead=()=>{throw httpError(Number(deletion));};
 const retry=await run(m,c);assert.equal(retry.outcomes[0].reason,'target-deleted');assert.equal(retry.outcomes[0].clinicalWrite,'none');assert.equal(m.writes.length,before);
});
for(const kind of ['fact','panel'])for(const status of [404,410,502])test(`W85 ${kind} baseline read ${status} and empty owner`,async()=>{
 const m=memoryFhir();await run(m,command([kind==='fact'?factTarget():target()]));const o=m.all<Observation>('Observation')[0];const baseline={kind:'canonical',reference:`Observation/${o.id}`,versionId:o.meta!.versionId};const c=command([kind==='fact'?factTarget(keyFor(),baseline,{status:'live',presence:'absent',qualifiers:{},homes:[]}):target(baseline,{CUSTOM_measure:3})]);const before=m.writes.length;
 m.hooks.beforeRead=()=>{throw httpError(status);};const r=await run(m,c);assert.equal(r.outcomes[0].status,status===502?'not-attempted':'conflict');assert.equal(r.outcomes[0].reason,status===502?'upstream':'target-deleted');assert.equal(r.outcomes[0].clinicalWrite,'none');assert.equal(m.writes.length,before);
 m.hooks.beforeRead=undefined;m.resources.delete(`Observation/${o.id}`);assert.equal((await run(m,c)).outcomes[0].reason,'target-deleted');assert.equal(m.writes.length,before);
});
for(const kind of ['fact','panel'])for(const confirmed of [true,false])test(`W85 ${kind} ${confirmed?'confirmed':'unknown'} write then deleted`,async()=>{
 const m=memoryFhir();m.hooks.afterWrite=(w,o)=>{if(o.resourceType==='Observation'){m.resources.delete(`Observation/${o.id}`);if(!confirmed)throw Error('lost response');}};
 const r=await run(m,command([kind==='fact'?factTarget():target()]));assert.equal(r.outcomes[0].status,confirmed?'conflict':'unconfirmed');assert.equal(r.outcomes[0].clinicalWrite,confirmed?'confirmed':'unknown');if(confirmed)assert.equal(r.outcomes[0].reason,'target-deleted-after-write');assert.equal(m.all('Provenance').length,0);
});
test('W83 initial mismatching audit result and lost response stay mismatch without overwrite',async()=>{
 for(const lost of [false,true]){const m=memoryFhir();m.hooks.afterWrite=(w,o)=>{if(o.resourceType==='Provenance'){(o as Provenance).agent[0].who.reference='Practitioner/forged';m.resources.set(`Provenance/${o.id}`,structuredClone(o));if(lost)throw Error('lost');}};
 const r=await run(m,command([factTarget()]));assert.equal(r.outcomes[0].reason,'audit-mismatch');assert.equal(r.outcomes[0].status,'not-attempted');assert.equal(r.outcomes[0].clinicalWrite,'confirmed');assert.equal(m.all('Provenance').length,1);}
});
test('W84 reassert initial forged audit and mixed response are command-reused',async()=>{
 const m=memoryFhir([canonicalFact()]);m.hooks.afterWrite=(w,o)=>{if(o.resourceType==='Provenance'){m.resources.set('Provenance/forged',{...structuredClone(o),id:'forged',agent:[{who:{reference:'Practitioner/forged'}}]});}};
 const c=command([{kind:'reassert',key:keyFor(),baseline:{kind:'canonical',reference:'Observation/canonical',versionId:'v1'}}]);const r=await run(m,c);assert.equal(r.outcomes[0].reason,'command-reused');assert.equal(r.outcomes[0].status,'conflict');
});
test('W92 direct writers reject inactive assertions even with historical catalog supplied',async()=>{
 for(const inactive of ['definition','field','option']){const d=structuredClone(lens);if(inactive==='definition')d.active=false;else {const f=(d.valueSchema.fields as any)[lensField];if(inactive==='field')f.active=false;else f.options.find((o:any)=>o.code===keyFor().optionCode).active=false;}
 const m=memoryFhir();const r=await executeFindingCommand({...context(m),definitions:[d]},command([factTarget()]) as FindingCommand);assert.equal(r.complete,false);assert.equal(m.writes.length,0);}
});
test('W71 panel scalar storage rejects alternate clinical data and wrong typed payload',()=>{
 for(const bad of [{...panel(),valueBoolean:false},{...panel(),component:[...panel().component!,comp('unknown',3)]},{...panel(),component:[...panel().component!,comp('CUSTOM_measure',3)]},{...panel(),component:[comp('R10_PANEL_META',JSON.stringify(panelKey)),comp('CUSTOM_measure','2.5')]}])assert.equal(identity.classifyFindingObservation(bad,defs,[],new Map()).kind,'invalid');
});
test('W95 panel missing effective definition is a 400 before any write',async()=>{const m=memoryFhir();await assert.rejects(executeFindingCommand({...context(m),definitions:[]},command([target()]) as FindingCommand),{status:400,code:'not-a-shared-finding',message:'not-a-shared-finding'});assert.equal(m.writes.length,0);});
for(const kind of ['fact','panel'])test(`W85 ${kind} lost write then recovery direct read 410 stays unknown`,async()=>{
 const m=memoryFhir();let lost=false;m.hooks.afterWrite=(w,o)=>{if(o.resourceType==='Observation'){lost=true;throw Error('lost response');}};m.hooks.beforeRead=()=>{if(lost)throw httpError(410);};
 const r=await run(m,command([kind==='fact'?factTarget():target()]));assert.equal(r.outcomes[0].status,'unconfirmed');assert.equal(r.outcomes[0].clinicalWrite,'unknown');assert.equal(m.all('Provenance').length,0);
});
test('W71 every panel identity dimension is checked',()=>{
 const original=panel();const key={...panelKey,patientId:'other'};
 for(const bad of [{...original,subject:{reference:'Patient/other'}},{...original,encounter:{reference:'Encounter/other'}},{...original,code:{coding:[{code:'wrong'}]}},{...original,extension:[]},{...original,component:[comp('R10_PANEL_META',JSON.stringify({...panelKey,extra:true}))]},{...original,component:[comp('R10_PANEL_META',JSON.stringify(key))]}])assert.equal(identity.classifyFindingObservation(bad,defs,[],new Map()).kind,'invalid');
});
test('W112 panel stale baseline conflicts; replays classify same state and reject different payload',async()=>{
 const m=memoryFhir();const c=command([target()]);await run(m,c);const before=m.writes.length;const load=()=>({...state(m.all<Observation>('Observation')),definitions:defs,fhir:m.fhir,staffReference:context(m).staffReference});
 assert.equal(await classifyReplay(load(),c as FindingCommand,c.targets[0] as any),'exact-replay');assert.equal(await classifyReplay(load(),c as FindingCommand,{...target(),state:{deferred:false,values:{CUSTOM_measure:3}}} as any),'reused-with-different-content');
 assert.equal((await run(m,command([target()]))).outcomes[0].status,'conflict');assert.equal(m.writes.length,before);
});
test('W84 classifyReplay actor binding includes both tags and target set',async()=>{
 const m=memoryFhir([canonicalFact()]);const c=command([{kind:'reassert',key:keyFor(),baseline:{kind:'canonical',reference:'Observation/canonical',versionId:'v1'}}]);await run(m,c);
 assert.equal(await classifyReplay({...state(m.all<Observation>('Observation')),fhir:m.fhir,staffReference:'Practitioner/other'},c as FindingCommand,c.targets[0] as any),'reused-with-different-content');
});
test('W109 panel mixed valid and forged audits remains pending',async()=>{
 const m=memoryFhir();const c=command([target()]);await run(m,c);const audit=m.all<Provenance>('Provenance')[0];m.resources.set('Provenance/forged',{...audit,id:'forged',recorded:'invalid'});
 assert.equal((await project(m)).panels[0].auditIntegrity,'mismatch');const before=m.writes.length;const r=await run(m,c);assert.equal(r.outcomes[0].reason,'audit-mismatch');assert.equal(m.writes.length,before);
});
test('W95 panel scalar select and string values roundtrip normalized without facts',async()=>{
 const m=memoryFhir();const r=await run(m,command([target(undefined,{CUSTOM_measure:0,CUSTOM_method:' a ',CUSTOM_note:'  retained text  '})]));assert.equal(r.complete,true);const p=await project(m);
 assert.deepEqual(p.panels[0].values,{CUSTOM_measure:0,CUSTOM_method:'a',CUSTOM_note:'retained text'});assert.equal(p.currentFacts.length,0);
});

for(const status of ['final','amended','corrected'] as const)test(`W115 signed ${status} panels and facts retain identity with zero ordinary writes`,async()=>{
 for(const kind of ['fact','panel']){const m=memoryFhir();await run(m,command([kind==='fact'?factTarget():target()]));const o=m.all<Observation>('Observation')[0];m.save({...o,status});const signed=m.all<Observation>('Observation')[0];const p=await project(m);
 assert.equal(p.preRebuild,false);if(kind==='panel'){assert.equal(p.panels[0].editable,false);assert.equal(p.panels[0].readOnlyReason,'signed-observation');assert.deepEqual(p.panels[0].values,{CUSTOM_measure:2.5});}else assert.equal(p.currentFacts[0].editable,false);
 const baseline={kind:'canonical',reference:`Observation/${o.id}`,versionId:signed.meta!.versionId};const before=m.writes.length;const r=await run(m,command([kind==='fact'?factTarget(keyFor(),baseline):target(baseline)]));assert.equal(r.outcomes[0].status,'refused');assert.equal(m.writes.length,before);
 }
});

test('W95 review non-shared panel definition returns not-a-shared-finding before writes',async()=>{
 const m=memoryFhir();
 await assert.rejects(executeFindingCommand({...context(m),definitions:defs.map(d=>({...d,valueSchema:{...d.valueSchema,type:'section'}}))},command([target()]) as FindingCommand),{status:400,code:'not-a-shared-finding',message:'not-a-shared-finding'});
 assert.equal(m.writes.length,0);
});
