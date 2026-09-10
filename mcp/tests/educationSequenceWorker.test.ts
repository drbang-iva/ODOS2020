import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import ts from "typescript";
import type { Basic, Bundle, Resource } from "@medplum/fhirtypes";
import { createFhirEducationEnrollmentStore, type NewEducationEnrollment } from "../src/comms/education-enrollment.js";
import { runOnce, type EducationSequenceWorkerDeps } from "../src/comms/education-sequence-worker.js";
const at="2026-09-10T14:00:00.000Z";
async function fixture(patients=["one","two"]) {
 const data=new Map<string,Basic>();const calls:string[]=[];const items:unknown[]=[];const preparations:string[]=[];const evidence=new Map<string,any>();let beforePrepare:(()=>Promise<void>)|undefined;
 const fhir={baseUrl:"http://synthetic.invalid",
 async search<T extends Resource>():Promise<Bundle<T>>{return {resourceType:"Bundle",type:"searchset",entry:[]};},
 async searchProject<T extends Resource>(type:string,project:string):Promise<Bundle<T>>{assert.equal(project,"practice");return {resourceType:"Bundle",type:"searchset",entry:type==="Basic"?[...data.values()].map(resource=>({resource:structuredClone(resource) as T})):[]};},
 async create<T extends Resource>(resource:T):Promise<T>{const basic={...structuredClone(resource) as Basic,id:randomUUID(),meta:{versionId:randomUUID(),project:"practice"}};data.set(basic.id!,basic);return structuredClone(basic) as T;},
 async read<T extends Resource>(_type:string,id:string):Promise<T>{return structuredClone(data.get(id)) as T;},
 async update<T extends Resource>(_type:string,id:string,resource:T,headers?:Record<string,string>):Promise<T>{if(headers?.["If-Match"]!==`W/"${data.get(id)!.meta!.versionId}"`)throw Object.assign(new Error("stale"),{status:412});const saved={...structuredClone(resource) as Basic,meta:{versionId:randomUUID(),project:"practice"}};data.set(id,saved);return structuredClone(saved) as T;}};
 const store=createFhirEducationEnrollmentStore(fhir);
 for(const patient of patients) {const input:NewEducationEnrollment={patientReference:`Patient/${patient}`,journey:{id:"journey",version:1},currentStageId:"start",stageEnteredAt:"2026-09-07T14:00:00.000Z",enteredFromEncounterReference:`Encounter/${patient}`,enrolledBy:"Practitioner/synthetic",status:"active",stageHistory:[{stageId:"start",enteredAt:"2026-09-07T14:00:00.000Z",enteredBy:"Practitioner/synthetic",reason:"enrollment-recorded"}],immediateSends:[],requestId:patient,sequence:{id:"sequence",version:1,steps:[0,1].map(stepIndex=>({stepIndex,channel:"sms",lane:"clinical",content:{id:"content",version:1},recipientReference:`Patient/${patient}`,plannedAt:"2026-09-08T14:00:00.000Z",notBefore:"2026-09-08T14:00:00.000Z",latestUsefulTime:"2026-09-15T14:00:00.000Z",anchor:"stage-entry",offsetDays:1,dayInterpretation:"calendar",timezone:"America/New_York"}))}};await store.create(input);}
 const deps:EducationSequenceWorkerDeps={fhir,projectId:"practice",authenticate:async()=>{},now:()=>at,store,
 prepare:async(_e,row)=>{preparations.push(row.id);await beforePrepare?.();return {kind:"ready",prepared:{}};},
 execute:async(enrollment,row,key)=>{calls.push(row.id);const outcome={outcome:"sent" as const,providerMessageId:key};evidence.set(key,{outcome,acceptedAt:at,providerInvoked:true});return outcome;},
 reconcile:async(_e,_r,key)=>evidence.get(key)?.outcome,
 evidence:async(_e,_r,key)=>evidence.get(key),
 staffItem:async item=>{items.push(item);},log:()=>{},spacingEnabled:false};
 return {deps,data,calls,items,preparations,store,setBeforePrepare(fn:()=>Promise<void>){beforePrepare=fn;}};
}
test("worker groups due rows by patient so downtime never bursts",async()=>{const f=await fixture();await runOnce(f.deps);assert.equal(f.calls.length,2);await runOnce(f.deps);assert.equal(f.calls.length,4);});
test("malformed mid-page enrollment does not stall other patients",async()=>{const f=await fixture();const entries=[...f.data.entries()];f.data.clear();f.data.set(...entries[0]);f.data.set("broken",{resourceType:"Basic",id:"broken",meta:{project:"practice",versionId:randomUUID()}});f.data.set(...entries[1]);await runOnce(f.deps);assert.equal(f.calls.length,2);assert.equal(f.items.length,1);});
test("stop after worker preflight read wins with no provider call",async()=>{const f=await fixture(["one"]);let stopped=false;f.setBeforePrepare(async()=>{if(stopped)return;stopped=true;const [id]=f.data.keys();const e=(await f.store.read(id))!;await f.store.stopSequence(id,{activationId:e.activations![0].id,actor:e.enrolledBy,at,reason:"clinician-stop"});});await runOnce(f.deps);assert.equal(f.calls.length,0);const e=(await f.store.read([...f.data.keys()][0]))!;assert.equal(e.scheduledSends![0].disposition,"cancelled");});
function editRows(f:Awaited<ReturnType<typeof fixture>>,edit:(row:any)=>void){for(const basic of f.data.values())for(const extension of basic.extension??[])if(extension.url.endsWith("education-enrollment-scheduled-send")){const row=JSON.parse(extension.valueString!);edit(row);extension.valueString=JSON.stringify(row);}}
test("expired work is held without attempt and is not released by an unrelated lifecycle pass",async()=>{const f=await fixture(["one"]);editRows(f,row=>{row.latestUsefulTime="2026-09-09T14:00:00.000Z";});await runOnce(f.deps);const id=[...f.data.keys()][0];let e=(await f.store.read(id))!;assert.equal(f.calls.length,0);assert.equal(f.items.length,2);assert.equal(e.immediateSends.length,0);assert.ok(e.scheduledSends!.every(r=>r.disposition==="held"));e=await f.store.applyLifecycle(id,{actor:e.enrolledBy,at,reason:"unrelated-review"});assert.ok(e.scheduledSends!.every(r=>r.disposition==="held"));});
for(const reason of ["patient-opt-out","patient-seen","content-unavailable","no-recipient-channel","needs-acknowledgement"] as const)test(`held ${reason} rows never dispatch`,async()=>{const f=await fixture(["one"]);editRows(f,row=>{row.disposition="held";row.holdReason=reason;});await runOnce(f.deps);assert.equal(f.calls.length,0);assert.equal(f.preparations.length,0);assert.equal((await f.store.read([...f.data.keys()][0]))!.immediateSends.length,0);});
test("cancelled rows never dispatch",async()=>{const f=await fixture(["one"]);const id=[...f.data.keys()][0];const e=(await f.store.read(id))!;await f.store.stopSequence(id,{activationId:e.activations![0].id,actor:e.enrolledBy,at,reason:"stop"});await runOnce(f.deps);assert.equal(f.calls.length,0);assert.equal((await f.store.read(id))!.immediateSends.length,0);});
test("claim before stop records possibly delivered attempt without any successor send",async()=>{const f=await fixture(["one"]);const execute=f.deps.execute;let observed=false;f.deps.execute=async(e,row,key,prepared)=>{const stopped=await f.store.stopSequence(e.id,{activationId:row.activationId,actor:e.enrolledBy,at,reason:"stop-after-claim"});assert.equal(stopped.immediateSends[0].state,"in-flight");assert.equal(stopped.scheduledSends![0].disposition,"cancelled");observed=true;return execute(e,row,key,prepared);};await runOnce(f.deps);await runOnce(f.deps);assert.equal(observed,true);assert.equal(f.calls.length,1);const e=(await f.store.read([...f.data.keys()][0]))!;assert.equal(e.immediateSends[0].state,"resolved");assert.equal(e.scheduledSends![0].disposition,"cancelled");});
test("later page is visited and foreign practice resources are excluded even if returned",async()=>{const f=await fixture();const search=f.deps.fhir.searchProject;let pages=0;f.deps.fhir.searchProject=async(type,project,params)=>{const result=await search(type,project,params);if(type==="Basic"&&!params?._id&&!params?.subject){return {...result,entry:result.entry?.slice(0,1),link:[{relation:"next",url:"http://synthetic.invalid/fhir/R4/Basic?_project=practice&page=2"}]};}return result;};f.deps.fhir.searchProjectUrl=async()=>{pages++;const other=structuredClone([...f.data.values()][0]);other.meta!.project="foreign";return {resourceType:"Bundle",type:"searchset",entry:[{resource:[...f.data.values()][1] as any},{resource:other as any}]};};await runOnce(f.deps);assert.equal(pages,1);assert.equal(f.calls.length,2);});
test("recorded acceptance enforces same-day spacing across sweeps",async()=>{const f=await fixture(["one"]);f.deps.spacingEnabled=true;await runOnce(f.deps);await runOnce(f.deps);assert.equal(f.calls.length,1);});
test("unknown provider outcome holds the attempt and never invokes another send",async()=>{const f=await fixture(["one"]);f.deps.execute=async()=>{f.calls.push("unknown");throw new Error("Connection lost");};await runOnce(f.deps);await runOnce(f.deps);await runOnce(f.deps);assert.equal(f.calls.length,1);const e=(await f.store.read([...f.data.keys()][0]))!;assert.equal(e.immediateSends[0].state,"in-flight");assert.equal(e.scheduledSends![0].holdReason,"needs-acknowledgement");});

test("worker and scheduling storage contain no transition import or invocation",()=>{
 for(const file of ["education-sequence-worker.ts","education-sequence-store.ts"]){
  const source=ts.createSourceFile(file,readFileSync(new URL(`../src/comms/${file}`,import.meta.url),"utf8"),ts.ScriptTarget.Latest,true,ts.ScriptKind.TS);
  function visit(node:ts.Node):void{
   if(ts.isCallExpression(node)&&ts.isPropertyAccessExpression(node.expression))assert.notEqual(node.expression.name.text,"transition",`${file} has a stage transition call`);
   if(ts.isImportSpecifier(node))assert.notEqual(node.propertyName?.text??node.name.text,"transition",`${file} imports transition`);
   ts.forEachChild(node,visit);
  }
  visit(source);
 }
});
test("real final gate deferral creates one successor across repeated sweeps and restart",async()=>{
 const api=await import("../src/comms/comms-api.js");const {createSuppressedCommsProvider}=await import("../src/comms/suppression-gate.js");
 const f=await fixture(["one"]);const extra=new Map<string,any>();const fhir=f.deps.fhir as any;
 const read=fhir.read,create=fhir.create,update=fhir.update;
 fhir.read=async(type:string,id:string)=>type==="Basic"?read(type,id):type==="Patient"?{resourceType:"Patient",id,telecom:[{system:"phone",value:"+15555550100"}]}:structuredClone(extra.get(id));
 fhir.create=async(resource:any,headers:any)=>{if(resource.resourceType==="Basic")return create(resource,headers);const saved={...structuredClone(resource),id:randomUUID(),meta:{versionId:randomUUID()}};extra.set(saved.id,saved);return structuredClone(saved);};
 fhir.update=async(type:string,id:string,resource:any,headers:any)=>{if(type==="Basic")return update(type,id,resource,headers);assert.equal(headers?.["If-Match"],`W/"${extra.get(id).meta.versionId}"`);const saved={...structuredClone(resource),meta:{versionId:randomUUID()}};extra.set(id,saved);return structuredClone(saved);};
 fhir.search=async(type:string,params:any)=>({resourceType:"Bundle",type:"searchset",entry:[...extra.values()].filter(resource=>resource.resourceType===type&&resource.identifier?.some((id:any)=>`${id.system}|${id.value}`===params.identifier)).map(resource=>({resource:structuredClone(resource)}))});
 let now=new Date(at);const providerCalls:string[]=[];
 const provider=createSuppressedCommsProvider({name:"synthetic",capabilities:{sms:true,email:false,calls:false,contacts:false,conversations:false,reviews:false},sendSms:async request=>{providerCalls.push(request.messageId!);return {outcome:"sent",providerMessageId:request.messageId!};}},{fhir,practiceTimeZone:"America/New_York",now:()=>now});
 const deps:any={fhir,educationCatalog:{get:()=>({id:"content",version:1,title:"Education",kind:"page",audience:"patient",channels:["sms"],consentClass:"transactional",laneHint:"clinical",dxCodes:[],urls:{web:"https://example.invalid/education"}})},dispatch:{providerFor:()=>"synthetic",senderNumberFor:()=>"+15555550100",getAdapterForRole:()=>provider},now:()=>now.toISOString(),publicBaseUrl:"https://example.invalid",practiceName:"Synthetic",trackedLinkStore:{create:async()=>{}}};
 const body=(e:any,row:any,key:string)=>({patientReference:e.patientReference,educationId:row.content.id,version:row.content.version,channel:row.channel,lane:row.lane,alsoUpdateChart:false,recipientOverride:{reference:row.recipientReference},idempotencyKey:key});
 const actor=(e:any)=>({kind:"system" as const,reference:"Device/education-sequence-worker",onBehalfOf:e.enrolledBy,fhir});
 f.deps.now=()=>now.toISOString();
 f.deps.prepare=async(e,row)=>api.prepareEducationSequenceDispatch(deps,fhir,await fhir.read("Patient","one"),body(e,row,"preflight"));
 f.deps.execute=async(e,row,key,prepared)=>{now=new Date("2026-09-11T02:00:00.000Z");return api.dispatchEducationAs(actor(e),deps,await fhir.read("Patient","one"),body(e,row,key),{prepared:prepared as any});};
 f.deps.reconcile=async(e,row,key)=>{const proof=await api.readEducationDispatchEvidence(fhir,body(e,row,key),e.enrolledBy);return proof?api.dispatchEducationAs(actor(e),deps,undefined,body(e,row,key),{reconcileOnly:true}):undefined;};
 f.deps.evidence=(e,row,key)=>api.readEducationDispatchEvidence(fhir,body(e,row,key),e.enrolledBy);
 await runOnce(f.deps);const id=[...f.data.keys()][0];let e=(await f.store.read(id))!;
 assert.equal(e.scheduledSends![0].attempts.length,2);assert.equal(providerCalls.length,0);const original=structuredClone(e.immediateSends[0]);
 for(let i=0;i<4;i++)await runOnce({...f.deps});
 e=(await f.store.read(id))!;assert.equal(e.scheduledSends![0].attempts.length,2);assert.deepEqual(e.immediateSends[0],original);assert.equal(providerCalls.length,0);
});
