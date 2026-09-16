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
 const app=express();app.use(express.json());registerGuarantorRoutes(app,{...f.deps,authenticateService:async()=>{},authenticate:async()=>({...staff,businessActions:permitted?staff.businessActions:[]}),serviceFhir:{...f.deps.serviceFhir,getAuthenticatedProfileReference:async()=>f.deps.serviceReference}} as never);
 const server=app.listen(0,"127.0.0.1");await new Promise<void>(r=>server.once("listening",r));
 const request=async(path:string,body?:unknown)=>{const r=await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/guarantors${path}`,body===undefined?{}:{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)});return {status:r.status,body:await r.json().catch(()=>undefined)};};
 try { await fn(f,request); invariant(f); } finally { await new Promise<void>(r=>server.close(()=>r())); }
}
async function create(request:any) { const r=await request("",{firstName:"Synthetic",lastName:"Unused",birthDate:"1980-01-01"});assert.equal(r.status,201);return r.body as {personId:string;versionId:string}; }
const discard=(request:any,p:{personId:string;versionId:string})=>request(`/${p.personId}/discard`,{expectedVersion:p.versionId,reason:"Synthetic unused record"});

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
 const n=f.writes.length;const completed:any=await run(f,'complete',undefined,started.body.task.id);invariant(f);
 assert.equal(completed.status,409);assert.equal(completed.body.phase,'destination-inactive');assert.equal(completed.body.target,`Person/${p.personId}`);assert.equal(completed.body.error,'The guarantor chosen for this change was discarded. Undo this change, then choose a guarantor.');
 assert.equal(f.writes.length,n,'inactive Complete writes nothing');assert.equal(f.get<Person>(`Person/${p.personId}`).active,false);assert.equal(f.get<Person>(`Person/${p.personId}`).link?.length??0,0);assert.deepEqual(f.owners('r1'),[]);invariant(f);
 const undone:any=await run(f,'correct',{operationId:randomUUID(),reason:'Undo discarded destination'},started.body.task.id);assert.equal(undone.status,200);assert.equal(undone.body.task.status,'completed');
 assert.equal(f.get<RelatedPerson>('RelatedPerson/r1').extension?.filter(e=>e.url.endsWith('/guarantor-link-claim')).length??0,0);
 assert.deepEqual(f.owners('r1'),kind==='attach'?[]:['S']);assert.equal(f.get<Person>(`Person/${p.personId}`).active,false);assert.equal(f.get<Person>(`Person/${p.personId}`).link?.length??0,0);
}));

test("X2 attaching write wins; discard If-Match refuses with no inactive write",async()=>harness(async(f,request)=>{
 const p=await create(request);f.compete('Person/S',r=>({...r,active:false,link:[]}));let attached=false;
 f.beforeWrite=async w=>{if(w.resource.resourceType==='Person'&&(w.resource as Person).active===false){f.beforeWrite=undefined;const started:any=await run(f,'create',{operationId:randomUUID(),kind:'attach',destinationPersonId:p.personId,relatedPersonIds:['r1'],expected:{[`Person/${p.personId}`]:p.versionId,'RelatedPerson/r1':'1'},reason:'Attach wins'});assert.equal(started.status,200);attached=true;}};
 const result=await discard(request,p);assert.equal(attached,true);assert.equal(result.status,409);assert.equal(f.get<Person>(`Person/${p.personId}`).active,true);assert.deepEqual(f.owners('r1'),[p.personId]);assert.equal(f.writes.filter(w=>w.resource.resourceType==='Person'&&(w.resource as Person).active===false&&w.status===200).length,0);
}));
for(const kind of ['attach','transfer','consolidate'] as const)for(const action of ['draft','preview','create'])test(`O9 ${action} ${kind} refuses real discarded Person before writes`,async()=>harness(async(f,request)=>{
 const p=await create(request);const discarded=await discard(request,p);assert.equal(discarded.status,200);if(kind==='attach')f.compete('Person/S',r=>({...r,active:false,link:[]}));
 const body={kind,...kind==='attach'?{}:{sourcePersonId:'S'},destinationPersonId:p.personId,...action==='draft'&&kind==='consolidate'?{}:{relatedPersonIds:['r1']},...action==='draft'?{}:{operationId:randomUUID(),expected:{...kind==='attach'?{}:{'Person/S':f.get<Person>('Person/S').meta!.versionId},[`Person/${p.personId}`]:discarded.body.versionId,'RelatedPerson/r1':'1'},reason:'Should refuse'}};
 const n=f.writes.length;const result:any=await run(f,action,body);assert.equal(result.status,422);assert.match(result.body.error,/inactive/);assert.equal(f.writes.length,n);
}));
