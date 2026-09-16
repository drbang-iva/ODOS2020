import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import test from "node:test";
import express from "express";
import type { Person, RelatedPerson, Task } from "@medplum/fhirtypes";
import { registerGuarantorRoutes } from "../src/clinic/guarantor-routes.js";
import { fixture, run } from "./guarantorScreensFixture.js";
import { FhirSearchLimitError } from "../src/fhir-search.js";

const staff = { staffReference: "Practitioner/g2b1-staff", actorRole: "staff" as const, businessActions: ["guarantor.link" as const], project: { reference: "Project/g2b1-synthetic" } };
const json = <T>(value: T): T => JSON.parse(JSON.stringify(value));
function invariant(f: ReturnType<typeof fixture>) { for (const r of f.data.values()) if (r.resourceType === "Person") assert.ok(r.active !== false || !r.link?.length, `X6 G1: Person/${r.id} is inactive with links`); }
async function harness(fn: (f: ReturnType<typeof fixture>, request: (path: string, body?: unknown) => Promise<{status:number;body:any}>) => Promise<void>, permitted = true) {
 const f = fixture(1);
 const read = f.deps.serviceFhir.readExtended, search = f.deps.serviceFhir.searchProject, write = f.deps.serviceFhir.executeTransactionAsActor;
 f.deps.serviceFhir.readExtended = async (...args) => json(await read(...args));
 f.deps.serviceFhir.searchProject = async (...args) => json(await search(...args));
 f.deps.serviceFhir.executeTransactionAsActor = async (bundle,...args) => json(await write(json(bundle),...args));
 for (const [key,value] of f.data) f.data.set(key,json(value));
 const app=express();app.use(express.json());registerGuarantorRoutes(app,{...f.deps,recordAudit:(row:any)=>f.deps.recordAudit(row),authenticateService:async()=>{},authenticate:async()=>({...staff,businessActions:permitted?staff.businessActions:[]}),serviceFhir:{...f.deps.serviceFhir,getAuthenticatedProfileReference:async()=>f.deps.serviceReference}} as never);
 const server=app.listen(0,"127.0.0.1");await new Promise<void>(r=>server.once("listening",r));
 const request=async(path:string,body?:unknown)=>{const r=await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/guarantors${path}`,body===undefined?{}:{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)});return {status:r.status,body:await r.json().catch(()=>undefined)};};
 try { await fn(f,request); invariant(f); } finally { await new Promise<void>(r=>server.close(()=>r())); }
}
async function create(request:any) { const r=await request("",{firstName:"Synthetic",lastName:"Unused",birthDate:"1980-01-01"});assert.equal(r.status,201);return r.body as {personId:string;versionId:string}; }
const discard=(request:any,p:{personId:string;versionId:string})=>request(`/${p.personId}/discard`,{expectedVersion:p.versionId,reason:"Synthetic unused record"});

for (const kind of ['attach','transfer','consolidate'] as const) for (const terminal of ['completed','undone-completed','undone-before-link','failed'] as const) test(`O15 ${kind} ${terminal}: real terminal writers cannot act on an active zero-link Person`, async()=>harness(async(f,request)=>{
 const p=await create(request);
 if(kind==='attach')f.compete('Person/S',r=>({...r,active:false,link:[]}));
 const input={operationId:randomUUID(),kind,...kind==='attach'?{}:{sourcePersonId:'S'},destinationPersonId:p.personId,relatedPersonIds:['r1'],expected:{...kind==='attach'?{}:{'Person/S':f.get<Person>('Person/S').meta!.versionId},[`Person/${p.personId}`]:p.versionId,'RelatedPerson/r1':'1'},reason:'O15 terminal matrix'};
 if(terminal==='failed')f.beforeWrite=async w=>{if(w.resource.resourceType==='RelatedPerson'){f.beforeWrite=undefined;f.compete('RelatedPerson/r1',r=>({...r}));}};
 if(terminal==='undone-before-link')f.beforeWrite=async w=>{if(w.resource.resourceType==='Person'&&w.resource.id===p.personId)throw new Error('O15 stop before attaching');};
 const original:any=await run(f,'create',input);f.beforeWrite=undefined;
 assert.equal(original.status,terminal==='failed'||terminal==='undone-before-link'?409:200);
 if(terminal.startsWith('undone')){const correction:any=await run(f,'correct',{operationId:randomUUID(),reason:'O15 Undo'},original.body.task.id);assert.equal(correction.status,200);assert.equal(correction.body.task.status,'completed');}
 const tasks=[...f.data.values()].filter((r):r is Task=>r.resourceType==='Task');
 assert.equal(f.get<Task>(`Task/${original.body.task.id}`).status,terminal==='failed'?'failed':terminal.startsWith('undone')?'cancelled':'completed');
 assert.ok(tasks.every(t=>t.status!=='in-progress'));
 const persons=[...new Set(tasks.flatMap(t=>(t.input??[]).filter(i=>['source','destination'].includes(i.type.text??'')).map(i=>i.valueReference!.reference!)))].map(ref=>f.get<Person>(ref));
 const unused=persons.filter(p=>p.active!==false&&!p.link?.length);
 for(const person of unused)for(const task of tasks.filter(t=>t.input?.some(i=>['source','destination'].includes(i.type.text??'')&&i.valueReference?.reference===`Person/${person.id}`))){
  const before=f.writes.length;
  assert.equal((await run(f,'complete',undefined,task.id)).status,409);
  assert.ok([409,422].includes((await run(f,'correct',{operationId:randomUUID(),reason:'O15 terminal refusal'},task.id)).status));
  assert.equal(f.writes.length,before,'terminal Complete/Correct cannot act on an orphan');
 }
 console.log(JSON.stringify({guard:'O15',kind,terminal,tasks:tasks.map(t=>({kind:t.input?.find(i=>i.type.text==='kind')?.valueCode,status:t.status})),persons:persons.map(p=>({id:p.id,active:p.active,links:p.link?.length??0})),activeZeroLink:unused.length}));
 for(const person of unused){
  const listed=await request('/unused');assert.equal(listed.status,200);assert.ok(listed.body.some((row:any)=>row.personId===person.id),'O11 terminal history does not hide an orphan');
  assert.equal((await discard(request,{personId:person.id!,versionId:person.meta!.versionId!})).status,200,'O11 terminal orphan is discardable');
 }
}));

test('O12 1001 real terminal Tasks do not block discarding a fresh orphan',async()=>harness(async(f,request)=>{
 const p=await create(request);f.compete('Person/S',r=>({...r,active:false,link:[]}));
 for(let i=0;i<1001;i++){
  f.beforeWrite=async w=>{if(w.resource.resourceType==='RelatedPerson'){f.beforeWrite=undefined;f.compete('RelatedPerson/r1',r=>({...r}));}};
  const result:any=await run(f,'create',{operationId:randomUUID(),kind:'attach',destinationPersonId:p.personId,relatedPersonIds:['r1'],expected:{[`Person/${p.personId}`]:p.versionId,'RelatedPerson/r1':f.get<RelatedPerson>('RelatedPerson/r1').meta!.versionId},reason:'O12 real failed operation'});
  assert.equal(result.body.task.status,'failed');
 }
 assert.equal([...f.data.values()].filter(r=>r.resourceType==='Task').length,1001);
 const fresh=await create(request);assert.equal((await discard(request,fresh)).status,200);
}));

test('O14 secondary audit failure returns landed discard and logs it',async()=>harness(async(f,request)=>{
 const p=await create(request);const logs:unknown[][]=[];const warn=console.warn;
 f.deps.recordAudit=async()=>{throw new Error('Synthetic secondary audit unavailable');};
 console.warn=(...args)=>{logs.push(args);};
 try{
  const result=await discard(request,p);assert.equal(result.status,200);assert.equal(f.get<Person>(`Person/${p.personId}`).active,false);
  assert.ok(logs.some(args=>String(args[0]).includes('secondary audit')));
  assert.match(JSON.stringify(f.writes.at(-1)!.actor),/Synthetic unused record/);
 }finally{console.warn=warn;}
}));

test("O1 linked Person cannot be listed or discarded",async()=>harness(async(f,request)=>{
 assert.equal((await request('/unused')).status,200);assert.deepEqual((await request('/unused')).body,[]);
 const n=f.writes.length;assert.equal((await discard(request,{personId:'S',versionId:'1'})).status,409);assert.equal(f.writes.length,n);
}));
test("O2 real create then discard stays hidden and second discard refuses without write",async()=>harness(async(f,request)=>{
 const p=await create(request);assert.equal((await request('/unused')).body[0].personId,p.personId);const result=await discard(request,p);assert.equal(result.status,200);
 assert.equal(f.get<Person>(`Person/${p.personId}`).active,false);assert.deepEqual((await request('/unused')).body,[]);
 const n=f.writes.length;assert.equal((await discard(request,{...p,versionId:result.body.versionId})).status,409);assert.equal(f.writes.length,n);
}));
test("O2b real Move retained source is excluded and Undo restores links",async()=>harness(async(f,request)=>{
 const moved:any=await run(f,'create',f.input());assert.equal(moved.status,200);assert.equal(f.get<Person>('Person/S').active,false);invariant(f);
 assert.deepEqual((await request('/unused')).body,[]);const n=f.writes.length;assert.equal((await discard(request,{personId:'S',versionId:f.get<Person>('Person/S').meta!.versionId!})).status,409);assert.equal(f.writes.length,n);
 const undo:any=await run(f,'correct',{operationId:randomUUID(),reason:'Synthetic Undo'},moved.body.task.id);assert.equal(undo.status,200);assert.equal(undo.body.task.status,'completed');assert.equal(f.get<Person>('Person/S').active,true);assert.deepEqual(f.owners('r1'),['S']);
}));
test("O3 active zero-link destination of real in-progress attach Task is excluded",async()=>harness(async(f,request)=>{
 const p=await create(request);f.compete('Person/S',r=>({...r,active:false,link:[]}));f.beforeWrite=async w=>{if(w.resource.resourceType==='RelatedPerson')throw new Error('Synthetic pause before claim');};
 const started:any=await run(f,'create',{operationId:randomUUID(),kind:'attach',destinationPersonId:p.personId,relatedPersonIds:['r1'],expected:{[`Person/${p.personId}`]:p.versionId,'RelatedPerson/r1':'1'},reason:'Synthetic attach'});f.beforeWrite=undefined;
 assert.equal(started.body.task.status,'in-progress');assert.equal(f.get<Person>(`Person/${p.personId}`).active,true);assert.equal(f.get<Person>(`Person/${p.personId}`).link?.length??0,0);
 assert.deepEqual((await request('/unused')).body,[]);const n=f.writes.length;assert.equal((await discard(request,p)).status,409);assert.equal(f.writes.length,n);
}));
test("O4 list then link change refuses discard without write",async()=>harness(async(f,request)=>{
 const p=await create(request);assert.equal((await request('/unused')).body.length,1);f.compete(`Person/${p.personId}`,r=>({...r,link:[{target:{reference:'RelatedPerson/new'}}]}));
 const n=f.writes.length;assert.equal((await discard(request,{...p,versionId:f.get<Person>(`Person/${p.personId}`).meta!.versionId!})).status,409);assert.equal(f.writes.length,n);
}));
test("O5 discard changes only active, uses fresh version, and audits staff and reason",async()=>harness(async(f,request)=>{
 const p=await create(request);const before=f.get<Person>(`Person/${p.personId}`);const result=await discard(request,p);assert.equal(result.status,200);
 const w=f.writes.at(-1)!;assert.deepEqual(w.resource,{...before,active:false});assert.equal(w.method,'PUT');assert.equal(w.expected,before.meta!.versionId);
 assert.deepEqual(w.actor,{actorReference:staff.staffReference,actorRole:'staff',actionReason:'guarantor.link discard Person; Synthetic unused record'});
 assert.equal(f.audits.length,1);assert.match(JSON.stringify(f.audits[0]),/Synthetic unused record/);assert.match(JSON.stringify(f.audits[0]),/g2b1-staff/);assert.match(JSON.stringify(f.audits[0]),new RegExp(p.personId));
}));
test("O6 search limits refuse both list and discard without writes",async()=>harness(async(f,request)=>{
 const p=await create(request);f.beforeSearch=async()=>{throw new FhirSearchLimitError('Task',1000);};const n=f.writes.length;
 assert.equal((await request('/unused')).status,409);assert.equal((await discard(request,p)).status,409);assert.equal(f.writes.length,n);
}));
test("O7 no guarantor.link refuses both endpoints before reads or writes",async()=>harness(async(f,request)=>{
 f.beforeSearch=async()=>{assert.fail('permission checked before search');};f.afterRead=async()=>{assert.fail('permission checked before read');};
 assert.equal((await request('/unused')).status,403);assert.equal((await discard(request,{personId:'S',versionId:'1'})).status,403);assert.equal(f.writes.length,0);
},false));

for (const kind of ['attach','transfer','consolidate'] as const) test(`X1 X3 X6 ${kind}: discard wins after Task recording; Complete refuses; existing Undo resolves`,async()=>harness(async(f,request)=>{
 const p=await create(request);if(kind==='attach')f.compete('Person/S',r=>({...r,active:false,link:[]}));
 let recorded!:()=>void, resume!:()=>void;const taskRecorded=new Promise<void>(r=>{recorded=r;});const resumeAttach=new Promise<void>(r=>{resume=r;});let attach:Promise<any>|undefined;
 f.afterWrite=async w=>{if(w.resource.resourceType==='Task'&&w.method==='POST'){recorded();await resumeAttach;}};
 f.beforeWrite=async w=>{if(w.resource.resourceType==='Person'&&(w.resource as Person).active===false&&w.resource.id===p.personId){
   f.beforeWrite=undefined;
   attach=run(f,'create',{operationId:randomUUID(),kind,...kind==='attach'?{}:{sourcePersonId:'S'},destinationPersonId:p.personId,relatedPersonIds:['r1'],expected:{...kind==='attach'?{}:{'Person/S':f.get<Person>('Person/S').meta!.versionId},[`Person/${p.personId}`]:p.versionId,'RelatedPerson/r1':'1'},reason:'Synthetic race'});
   await taskRecorded;
 }};
 const discarded=await discard(request,p);assert.equal(discarded.status,200);resume();const started=await attach!;f.afterWrite=undefined;
 assert.equal(started.status,409);assert.equal(started.body.phase,'attach-pending');invariant(f);
 const n=f.writes.length;const audits=f.audits.length;const completed:any=await run(f,'complete',undefined,started.body.task.id);invariant(f);
 assert.equal(completed.status,409);assert.equal(completed.body.phase,'destination-inactive');assert.equal(completed.body.target,`Person/${p.personId}`);assert.equal(completed.body.error,'The guarantor chosen for this change was discarded. Undo this change, then choose a guarantor.');
 assert.equal(f.get<Task>(`Task/${started.body.task.id}`).businessStatus?.text,'destination-inactive','X1+ stored Task phase');
 const status:any=await run(f,'status',undefined,started.body.task.id);assert.equal(status.body.phase,'destination-inactive','X1+ status endpoint');
 assert.equal(f.audits.length,audits+1,'X1+ one pending audit');assert.match(JSON.stringify(f.audits.at(-1)),/guarantor.link.pending/);assert.match(JSON.stringify(f.audits.at(-1)),/phase=destination-inactive/);
 assert.equal(f.writes.length,n+1,'inactive Complete writes only its Task checkpoint');assert.equal(f.writes.at(-1)!.resource.resourceType,'Task');assert.equal(f.get<Person>(`Person/${p.personId}`).active,false);assert.equal(f.get<Person>(`Person/${p.personId}`).link?.length??0,0);assert.deepEqual(f.owners('r1'),[]);invariant(f);
 const undone:any=await run(f,'correct',{operationId:randomUUID(),reason:'Undo discarded destination'},started.body.task.id);assert.equal(undone.status,200);assert.equal(undone.body.task.status,'completed');
 assert.equal(f.get<RelatedPerson>('RelatedPerson/r1').extension?.filter(e=>e.url.endsWith('/guarantor-link-claim')).length??0,0);
 assert.deepEqual(f.owners('r1'),kind==='attach'?[]:['S']);assert.equal(f.get<Person>(`Person/${p.personId}`).active,false);assert.equal(f.get<Person>(`Person/${p.personId}`).link?.length??0,0);
}));

test("X2 attaching write wins; discard If-Match refuses with no inactive write",async()=>harness(async(f,request)=>{
 const p=await create(request);f.compete('Person/S',r=>({...r,active:false,link:[]}));let attached=false;
 f.beforeWrite=async w=>{if(w.resource.resourceType==='Person'&&(w.resource as Person).active===false){f.beforeWrite=undefined;const started:any=await run(f,'create',{operationId:randomUUID(),kind:'attach',destinationPersonId:p.personId,relatedPersonIds:['r1'],expected:{[`Person/${p.personId}`]:p.versionId,'RelatedPerson/r1':'1'},reason:'Attach wins'});assert.equal(started.status,200);attached=true;}};
 const result=await discard(request,p);assert.equal(attached,true);assert.equal(result.status,409);assert.equal(f.get<Person>(`Person/${p.personId}`).active,true);assert.deepEqual(f.owners('r1'),[p.personId]);assert.equal(f.writes.filter(w=>w.resource.resourceType==='Person'&&(w.resource as Person).active===false&&w.status===200).length,0);
}));

test('X7 attach rebuild directly refuses a service-level inactivation after fencing',async()=>harness(async(f,request)=>{
 const p=await create(request);f.compete('Person/S',r=>({...r,active:false,link:[]}));
 f.beforeWrite=async w=>{if(w.resource.resourceType==='Person'&&w.resource.id===p.personId)throw new Error('Pause initial attaching write');};
 const started:any=await run(f,'create',{operationId:randomUUID(),kind:'attach',destinationPersonId:p.personId,relatedPersonIds:['r1'],expected:{[`Person/${p.personId}`]:p.versionId,'RelatedPerson/r1':'1'},reason:'X7 rebuild boundary'});
 assert.equal(started.body.phase,'attach-pending');let fenced=false,inactivated=false;
 f.afterWrite=async w=>{if(w.resource.resourceType==='Person'&&w.resource.id===p.personId&&w.status===200&&(w.actor as any).actionReason.startsWith('guarantor.link fence-destination '))fenced=true;};
 f.beforeWrite=async w=>{
  if(fenced&&w.resource.resourceType==='Person'&&w.resource.id===p.personId&&(w.resource as Person).link?.length){
   f.beforeWrite=undefined;f.compete(`Person/${p.personId}`,r=>({...r,active:false}),f.deps.serviceReference);inactivated=true;
  }
 };
 const result:any=await run(f,'complete',undefined,started.body.task.id);invariant(f);
 assert.equal(fenced,true);assert.equal(inactivated,true);assert.equal(result.status,409);assert.equal(result.body.phase,'destination-inactive');
 assert.equal(f.get<Task>(`Task/${started.body.task.id}`).businessStatus?.text,'destination-inactive');assert.equal(f.get<Person>(`Person/${p.personId}`).link?.length??0,0);
 assert.deepEqual(f.owners('r1'),[]);
}));
for(const kind of ['attach','transfer','consolidate'] as const)for(const action of ['draft','preview','create'])test(`O9 ${action} ${kind} refuses real discarded Person before writes`,async()=>harness(async(f,request)=>{
 const p=await create(request);const discarded=await discard(request,p);assert.equal(discarded.status,200);if(kind==='attach')f.compete('Person/S',r=>({...r,active:false,link:[]}));
 const body={kind,...kind==='attach'?{}:{sourcePersonId:'S'},destinationPersonId:p.personId,...action==='draft'&&kind==='consolidate'?{}:{relatedPersonIds:['r1']},...action==='draft'?{}:{operationId:randomUUID(),expected:{...kind==='attach'?{}:{'Person/S':f.get<Person>('Person/S').meta!.versionId},[`Person/${p.personId}`]:discarded.body.versionId,'RelatedPerson/r1':'1'},reason:'Should refuse'}};
 const n=f.writes.length;const result:any=await run(f,action,body);assert.equal(result.status,422);assert.match(result.body.error,/inactive/);assert.equal(f.writes.length,n);
}));
