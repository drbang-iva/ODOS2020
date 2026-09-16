import assert from 'node:assert/strict';
import { test } from 'node:test';
import React from 'react';
import { act, create } from 'react-test-renderer';
import { DiagnosisWorkspace } from '../src/components/charting/DiagnosisWorkspace';
import { OdosSearchPicker } from '../src/components/inputs/OdosSearchPicker';
import { DiagnosisRankActions } from '../src/components/charting/AssessmentSection';
import { DIAGNOSIS_KEY_IDENTIFIER_SYSTEM } from '../src/lib/clinical-actions';
const flush = () => new Promise(r => setTimeout(r,0));
const text = (n:any):string => typeof n === 'string' ? n : (n.children ?? []).map(text).join('');
async function mount(mode='normal', configure?: (payload:any,row:any)=>void) {
 const originalFetch=globalThis.fetch, originalWindow=globalThis.window;
 const events=new EventTarget(); Object.defineProperty(globalThis,'window',{configurable:true,value:events});
 const key={v:1,patientId:'p1',encounterId:'e1',stableKey:'synthetic',fieldCode:'field',optionCode:'option',eye:'OD'};
 const baseline={kind:'canonical',reference:'Observation/fact',versionId:'1'};
 const row={atomicFindingId:'synthetic::field::option',findingDefinitionId:'def',findingDefinitionKey:'synthetic',fieldCode:'field',optionCode:'option',display:'Synthetic finding',sectionKey:'lens',gradeScale:['1','2'],diagnosisKeys:['synthetic-dx'],origin:'custom',rowKey:'row-od',kind:'fact',eye:'OD',laterality:'OD',presence:'present',qualifiers:{},status:'live',editable:true,homes:['Condition/a'],homeSources:[{condition:'Condition/a',sources:[{kind:'finding-extension',contributor:{reference:'Observation/fact',versionId:'1'}}]}],key,baseline,contributors:[{reference:'Observation/fact',versionId:'1',kind:'canonical'}]};
 const payload={encounterEditable:true,canWrite:true,canWriteDiagnosis:mode!=='staff-existing',findings:[row],searchIndex:[row],catalog:[row],unassigned:[row],bySection:{lens:[row]},auditDebt:mode==='audit'?[row]:[],visitDiagnoses:[{conditionReference:'Condition/a',diagnosisKey:'synthetic-dx',display:'Diagnosis A',laterality:'OD'},{conditionReference:'Condition/new',diagnosisKey:'synthetic-dx',display:'New',laterality:'OD'}]};
 configure?.(payload,row);
 const condition={resourceType:'Condition',id:'a',meta:{versionId:'1'},code:{text:'Synthetic diagnosis'},category:[{coding:[{system:'http://terminology.hl7.org/CodeSystem/condition-category',code:'encounter-diagnosis'}]}],verificationStatus:{coding:[{code:'confirmed'}]},identifier:[{system:DIAGNOSIS_KEY_IDENTIFIER_SYSTEM,value:`e1::${['existing','staff-existing'].includes(mode)?'synthetic-dx':'other'}::none`}],evidence:[{detail:[{reference:'Observation/obsolete'}]}]};
 const calls:any[]=[];let reads=0,mutations=0;
 globalThis.fetch=async(input,init)=>{
  const url=String(input),method=init?.method??'GET';let body:any;
  if(method!=='GET'){body=JSON.parse(String(init?.body??'{}'));calls.push({url,method,body});}
  const complete=()=>Response.json({result:'command',complete:true,executionOrder:[0],outcomes:[{status:'applied',clinicalWrite:'confirmed'}]});
  if(url.includes('audit-repair'))return complete();
  if(url.includes('/findings')&&method==='PUT'){
   mutations++;
   if(mode==='lost-response'&&mutations===1)throw new Error('Synthetic lost response');
   if(mode==='confirmed-unconfirmed')return Response.json({result:'command',complete:false,executionOrder:[0],outcomes:[{status:'unconfirmed',clinicalWrite:'confirmed'}]},{status:502});
   if(mode.startsWith('eye-')&&mutations===1){
    row.baseline.versionId='2';row.qualifiers={grade:'2'} as any;
    const destination:any=payload.searchIndex[1];destination.baseline={...destination.baseline,versionId:'2'};
    if(mode==='eye-different'){destination.kind='fact';destination.status='live';destination.presence='absent';}
    return mode==='eye-invalid'?Response.json({result:'invalid',reason:'invalid',error:'Synthetic invalid'},{status:400}):Response.json({result:'invalid',reason:'destination-differs',error:'Synthetic destination differs'},{status:409});
   }
   if(mode==='conflict')return Response.json({result:'command',complete:false,executionOrder:[0,1],outcomes:[{status:'applied',clinicalWrite:'confirmed'},{status:'conflict',clinicalWrite:'none'}]},{status:409});
   if(['retry','partial'].includes(mode)&&mutations===1)return Response.json({result:'command',complete:false,executionOrder:[0],outcomes:[{status:'unconfirmed',clinicalWrite:'unknown'}]},{status:502});
   return complete();
  }
  if(url.includes('/findings')){reads++;return mode==='unavailable'?Response.json({result:'unavailable',kind:'upstream',error:'offline'},{status:502}):Response.json(payload);}
  if(url.includes('diagnosis-picks'))return mode==='unconfirmed'?Response.json({result:'pick',conditionStep:'unconfirmed',link:'pending',error:'lost'},{status:502}):Response.json({result:'pick',conditionStep:'applied',link:'pending',condition:{...condition,id:'new'},strandedCharges:[],unaffectedChargeCount:0,strandedChargesComputed:true});
  if(url.includes('diagnosis-candidates'))return mode==='unavailable'?Response.json({error:'offline'},{status:502}):Response.json({findings:[{findingInstanceId:'projection-od',contributors:row.contributors,candidates:[{diagnosisKey:'synthetic-dx',display:'Suggested diagnosis',source:'mapping',codingStatus:'provisional',supportingFacts:[{rowKey:row.rowKey,key,baseline}]}]}]});
  if(url.includes('diagnosis-quick-list'))return Response.json({canWrite:true,canWriteDiagnosis:mode!=='staff-existing',pinnedDiagnosisKeys:[],diagnoses:mode==='prebuild'?[{stableKey:'common',display:'Common synthetic',lateralityRequired:false,pinned:false,tallyCount:0}]:[],catalog:[{stableKey:'synthetic-dx',display:'Suggested diagnosis',lateralityRequired:mode.startsWith('scope'),icd10:{pattern:{right:'SYNTHETIC'}},pinned:false,tallyCount:0}]});
  if(url.includes('/fhir/R4/Encounter/e1'))return Response.json({resourceType:'Encounter',id:'e1',status:'in-progress',class:{code:'AMB'},diagnosis:[{condition:{reference:'Condition/a'},rank:1}]});
  if(url.includes('/fhir/R4/BodyStructure'))return Response.json({resourceType:'Bundle',entry:[{resource:{resourceType:'BodyStructure',id:'eye'}}]});
  if(url.includes('/fhir/R4/Condition/new')&&method==='PATCH')return mode==='scope-fail'?Response.json({error:'scope failed'},{status:500}):Response.json({...condition,id:'new',bodySite:[{text:'OD'}],meta:{versionId:'2'}});
  if(url.includes('/fhir/R4/Provenance'))return Response.json({resourceType:'Provenance',id:'audit'});
  if(url.includes('/fhir/R4/Condition'))return Response.json({resourceType:'Bundle',type:'searchset',entry:[{resource:condition}]});
  if(url.includes('previous-exams'))return Response.json({pageSize:4,encounters:[]});
  if(url.includes('procedure-charges'))return Response.json({options:[],diagnoses:[],proposals:[],attachedProcedures:[]});
  if(url.includes('diagnosis-newness'))return Response.json({rows:[]});
  if(url.includes('diagnosis-statuses'))return Response.json({statuses:[]});
  throw new Error(`Unexpected ${url}`);
 };
 let renderer:any;await act(async()=>{renderer=create(<DiagnosisWorkspace patientReference="Patient/p1" encounterReference="Encounter/e1" selectedReference="Condition/a" onSelectDiagnosis={()=>undefined}/>);await flush();});
 return {renderer,calls,events,payload,row,reads:()=>reads,click:async(label:string)=>{await act(async()=>{const b=renderer.root.findAllByType('button').find((n:any)=>text(n)===label||n.props['aria-label']===label);assert.ok(b,label);b.props.onClick();await flush();await flush();});},close:()=>{act(()=>renderer.unmount());globalThis.fetch=originalFetch;Object.defineProperty(globalThis,'window',{configurable:true,value:originalWindow});}};
}
test('W3 Retry resends identical command',async()=>{const m=await mount('retry');try{await m.click('Absent');assert.match(JSON.stringify(m.renderer.toJSON()),/Not confirmed/);await m.click('Retry');assert.equal(m.calls.length,2);assert.deepEqual(m.calls[1].body,m.calls[0].body);}finally{m.close();}});
test('W46 confirmed write on 409 emits event; W47 kept choice uses new command and baseline',async()=>{const m=await mount('conflict');let events=0;m.events.addEventListener('odos:encounter-findings-changed',()=>events++);try{const before=m.reads();m.row.baseline.versionId='2';await m.click('Absent');assert.equal(events,1);assert.ok(m.reads()>before);assert.match(JSON.stringify(m.renderer.toJSON()),/choice is kept/);await m.click('Apply kept choice');assert.notEqual(m.calls[1].body.commandId,m.calls[0].body.commandId);assert.equal(m.calls[1].body.targets[0].baseline.versionId,'2');assert.equal(m.calls[1].body.targets[0].state.presence,'absent');}finally{m.close();}});
test('W37 existing diagnosis suggestion links without pick',async()=>{const m=await mount('existing');try{await m.click('Add suggested diagnosis Suggested diagnosis');assert.equal(m.calls.filter(c=>c.url.includes('diagnosis-picks')).length,0);assert.equal(m.calls.filter(c=>c.body.operation==='link').length,1);assert.deepEqual(m.calls[0].body.targets[0].state.homes,['Condition/a']);}finally{m.close();}});
test('W36 Finish linking repeats only link',async()=>{const m=await mount('partial');try{await m.click('Add suggested diagnosis Suggested diagnosis');assert.match(JSON.stringify(m.renderer.toJSON()),/Linking incomplete/);await m.click('Finish linking');const picks=m.calls.filter(c=>c.url.includes('diagnosis-picks')),links=m.calls.filter(c=>c.body.operation==='link');assert.equal(picks.length,1);assert.equal(links.length,2);assert.deepEqual(links[0].body,links[1].body);assert.equal(links[0].body.commandId,picks[0].body.commandId);}finally{m.close();}});
test('unconfirmed pick never automatically repeats',async()=>{const m=await mount('unconfirmed');try{await m.click('Add suggested diagnosis Suggested diagnosis');assert.match(JSON.stringify(m.renderer.toJSON()),/Diagnosis not confirmed — reload/);assert.equal(m.calls.length,1);assert.equal(m.calls[0].body.supportingFacts.length,1);}finally{m.close();}});
test('W52 origin comes from homeSources despite obsolete Condition evidence',async()=>{const m=await mount();try{assert.equal(m.renderer.root.findAllByProps({className:'odos-diagnosis-provenance'}).length,1);assert.match(JSON.stringify(m.renderer.toJSON()),/Synthetic finding · OD/);}finally{m.close();}});
test('W53 Repair sends fresh UUID to audit repair',async()=>{const m=await mount('audit');try{await m.click('Repair');assert.equal(m.calls.length,1);assert.match(m.calls[0].url,/findings\/audit-repair$/);assert.equal(m.calls[0].method,'POST');assert.equal(m.calls[0].body.patientReference,'Patient/p1');assert.match(m.calls[0].body.commandId,/^[0-9a-f-]{36}$/);}finally{m.close();}});
test('W49 workspace renders both unavailable states',async()=>{const m=await mount('unavailable');try{assert.match(JSON.stringify(m.renderer.toJSON()),/Findings unavailable/);assert.match(JSON.stringify(m.renderer.toJSON()),/Suggestions unavailable/);}finally{m.close();}});

for(const mode of ['scope','scope-fail'])test(`pick then bodySite then link ordering: ${mode}`,async()=>{const m=await mount(mode);try{await m.click('Add suggested diagnosis Suggested diagnosis');await m.click('OD');const picks=m.calls.filter(c=>c.url.includes('diagnosis-picks')),links=m.calls.filter(c=>c.body.operation==='link'),scope=m.calls.filter(c=>c.method==='PATCH');assert.equal(picks.length,1);assert.equal(scope.length,1);assert.ok(m.calls.indexOf(picks[0])<m.calls.indexOf(scope[0]));if(mode==='scope-fail'){assert.equal(links.length,0);assert.match(JSON.stringify(m.renderer.toJSON()),/Scope not saved/);assert.equal(m.renderer.root.findAllByProps({'aria-label':'Resolve Suggested diagnosis'}).length,0);}else{assert.equal(links.length,1);assert.ok(m.calls.indexOf(scope[0])<m.calls.indexOf(links[0]));}}finally{m.close();}});

test('staff existing-diagnosis support suggestion links without Condition permission',async()=>{const m=await mount('staff-existing');try{await m.click('Add suggested diagnosis Suggested diagnosis');assert.equal(m.calls.length,1);assert.equal(m.calls[0].body.operation,'link');}finally{m.close();}});

for (const mode of ['eye-conflict','eye-invalid','eye-different']) test(`W55 kept eye choice uses current live rows and handles builder errors: ${mode}`, async () => {
 const unhandled:unknown[]=[];const onUnhandled=(reason:unknown)=>unhandled.push(reason);process.on('unhandledRejection',onUnhandled);
 const m=await mount(mode,(payload,row)=>{
  const destination={...row,rowKey:'row-os',kind:'offered',status:'offered',presence:undefined,qualifiers:{},homes:[],eye:'OS',laterality:'OS',key:{...row.key,eye:'OS'},baseline:{kind:'canonical',reference:'Observation/left',versionId:'1'}};
  payload.searchIndex=[row,destination];
 });
 try {
  await act(async()=>{m.renderer.root.findByProps({'aria-label':'Laterality Synthetic finding'}).props.onChange({target:{value:'OU'}});await flush();await flush();});
  assert.equal(m.calls.length,1);assert.deepEqual(m.calls[0].body.eyes,{from:['OD'],to:['OD','OS']});
  await m.click('Apply kept choice');
  if(mode==='eye-different'){
   assert.equal(m.calls.length,1);assert.match(JSON.stringify(m.renderer.toJSON()),/The eyes have different findings/);
  }else{
   assert.equal(m.calls.length,2);const next=m.calls[1].body;
   assert.equal(next.operation,'eye-change');assert.notEqual(next.commandId,m.calls[0].body.commandId);
   assert.deepEqual(next.eyes,{from:['OD'],to:['OD','OS']});
   assert.deepEqual(next.targets.map((t:any)=>[t.key.eye,t.baseline,t.state.qualifiers]),[['OS',{kind:'canonical',reference:'Observation/left',versionId:'2'},{grade:'2'}]]);
  }
  assert.deepEqual(unhandled,[]);
 }finally{m.close();process.off('unhandledRejection',onUnhandled);}
});
test('W56 unconfirmed outcome with confirmed clinical write on 502 refreshes and dispatches',async()=>{
 const m=await mount('confirmed-unconfirmed');let events=0;m.events.addEventListener('odos:encounter-findings-changed',()=>events++);
 try{const before=m.reads();await m.click('Absent');assert.ok(m.reads()>before);assert.equal(events,1);}finally{m.close();}
});
test('W57 thrown PUT fetch offers Retry with the identical body',async()=>{
 const m=await mount('lost-response');try{await m.click('Absent');assert.match(JSON.stringify(m.renderer.toJSON()),/Not confirmed — Retry/);await m.click('Retry');assert.equal(m.calls.length,2);assert.deepEqual(m.calls[1].body,m.calls[0].body);}finally{m.close();}
});
test('W59 pre-rebuild workspace disables diagnosis additions scope and rank',async()=>{
 const m=await mount('prebuild',p=>{p.encounterEditable=false;p.readOnlyReason='pre-rebuild-test-encounter';});
 try{
  const picker=m.renderer.root.findAllByType(OdosSearchPicker).find((n:any)=>n.props.label==='Find diagnosis');assert.ok(picker);assert.equal(picker.props.disabled,true);
  await act(async()=>{picker.props.onSelect({value:'new',label:'New synthetic',item:{stableKey:'new',display:'New synthetic',lateralityRequired:false}});});
  const add=m.renderer.root.findAllByType('button').find((n:any)=>text(n)==='Add to this visit');assert.ok(add);assert.equal(add.props.disabled,true);
  const common=m.renderer.root.findAllByType('button').find((n:any)=>text(n).includes('Common synthetic'));assert.ok(common);assert.equal(common.props.disabled,true);
  assert.ok(m.renderer.root.findByProps({'aria-label':'Diagnosis scope'}).findAllByType('button').every((n:any)=>n.props.disabled));
  const rank=m.renderer.root.findByType(DiagnosisRankActions);assert.equal(rank.props.busy,true);assert.ok(rank.findAllByType('button').every((n:any)=>n.props.disabled));
  await act(async()=>{add.props.onClick();common.props.onClick();await flush();});assert.equal(m.calls.filter(c=>c.url.includes('diagnosis-picks')).length,0);
 }finally{m.close();}
});
test('W60 linking a finding homed to B preserves B and adds A',async()=>{
 const m=await mount('existing',(p,row)=>{row.homes=['Condition/b'];p.visitDiagnoses.push({conditionReference:'Condition/b',diagnosisKey:'b',display:'B',laterality:'OD'});});
 try{await m.click('Add suggested diagnosis Suggested diagnosis');assert.equal(m.calls.length,1);assert.equal(m.calls[0].body.operation,'link');assert.deepEqual(m.calls[0].body.targets[0].state.homes,['Condition/b','Condition/a']);}finally{m.close();}
});
test('W63 applied pick dispatches findings changed without a subsequent link',async()=>{
 const m=await mount('prebuild');let events=0;m.events.addEventListener('odos:encounter-findings-changed',()=>events++);
 try{await act(async()=>{m.renderer.root.findAllByType('button').find((n:any)=>text(n).includes('Common synthetic')).props.onClick();await flush();await flush();});assert.equal(m.calls.filter(c=>c.url.includes('diagnosis-picks')).length,1);assert.equal(m.calls.filter(c=>c.body.operation==='link').length,0);assert.equal(events,1);}finally{m.close();}
});
