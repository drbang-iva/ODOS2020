import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import type { AddressInfo } from "node:net";
import { registerGuarantorRoutes } from "../src/clinic/guarantor-routes.js";
const person = (id: string, family = "Ann", extra = {}) => ({ resourceType: "Person", id, meta: { project: "practice", versionId: "1" }, active: true, name: [{ family, given: ["Beth"] }], telecom: [{ system: "phone", value: "864-555-0102" }], link: [{ target: { reference: "RelatedPerson/child" } }], ...extra });
async function route(rows: any[], run: (base: string, writes: any[]) => Promise<void>) {
 const writes: any[] = [];
 const app=express();app.use(express.json());
 registerGuarantorRoutes(app,{authenticateService:async()=>{},authenticate:async()=>({staffReference:"Practitioner/staff",actorRole:"staff",businessActions:["guarantor.link"],project:{reference:"Project/practice"}}),recordAudit:async()=>{},serviceFhir:{baseUrl:"http://synthetic.test",getAuthenticatedProfileReference:async()=>"ClientApplication/service",searchProject:async()=>({resourceType:"Bundle",type:"searchset",entry:rows.map(resource=>({resource}))}),executeTransactionAsActor:async(bundle:any,actor:any,_headers:any,options:any)=>{writes.push(...bundle.entry);assert.equal(actor.actorReference,"Practitioner/staff");const response={resourceType:"Bundle",type:"transaction-response",entry:[{resource:{...bundle.entry[0].resource,id:"new",meta:{project:"practice",versionId:"1"}},response:{status:"201",location:"Person/new/_history/1"}}]};options.validateResponse(response);return response;}} as never});
 const server=app.listen(0,"127.0.0.1");await new Promise<void>(r=>server.once("listening",r));
 try{await run(`http://127.0.0.1:${(server.address() as AddressInfo).port}`,writes);}finally{await new Promise<void>(r=>server.close(()=>r()));}
}
test("K1 search refuses a prefix-only family",async()=>route([person("ann"),person("anna","Anna")],async base=>{const r=await fetch(base+"/guarantors/search?lastName=Ann&firstName=Beth");assert.equal(r.status,200);assert.deepEqual((await r.json()).map((x:any)=>x.personId),["ann"]);}));
test("K2 phone compares digits and rejects a different digit",async()=>route([person("ann")],async base=>{for(const [phone,count] of [["(864) 555-0102",1],["8645550103",0]] as const){const r=await fetch(base+"/guarantors/search?lastName=Ann&phone="+encodeURIComponent(phone));assert.equal(r.status,200);assert.equal((await r.json()).length,count);}}));
test("Follow-up F2: US phone search matches country-code and ten-digit forms without trimming ten-digit leading 1",async()=>{
 await route([person("ann")],async base=>{
  for(const phone of ["+1 864 555 0102","18645550102","864 555 0102"]){
   const r=await fetch(base+"/guarantors/search?lastName=Ann&phone="+encodeURIComponent(phone));
   assert.equal(r.status,200);
   assert.deepEqual((await r.json()).map((x:any)=>x.personId),["ann"]);
  }
 });
 await route([person("leading-one","One",{telecom:[{system:"phone",value:"1234567890"}]})],async base=>{
  const r=await fetch(base+"/guarantors/search?lastName=One&phone=1234567890");
  assert.equal(r.status,200);
  assert.deepEqual((await r.json()).map((x:any)=>x.personId),["leading-one"]);
 });
});
test("K3 search card exposes exactly six keys",async()=>route([person("ann","Ann",{extension:[{url:"urn:sentinel",valueString:"private"}],address:[{line:["Private street"],city:"Town",postalCode:"00000"}]})],async base=>{const r=await fetch(base+"/guarantors/search?lastName=Ann&firstName=Beth");assert.equal(r.status,200);assert.deepEqual(Object.keys((await r.json())[0]).sort(),["personId","versionId","name","phones","city","postalCode"].sort());}));
for(const [kind,extra] of [["inactive",{active:false}],["zero-link",{link:[]}],["non-RelatedPerson",{link:[{target:{reference:"Patient/child"}}]}]] as const)test(`K4 ${kind} excluded`,async()=>route([person("ann","Ann",extra)],async base=>{const r=await fetch(base+"/guarantors/search?lastName=Ann&firstName=Beth");assert.equal(r.status,200);assert.deepEqual(await r.json(),[]);}));
for(const count of [21,201])test(`K5 ${count} matches return 422`,async()=>route(Array.from({length:count},(_,i)=>person("ann"+i)),async base=>{const r=await fetch(base+"/guarantors/search?lastName=Ann&firstName=Beth");assert.equal(r.status,422);assert.equal((await r.json()).error,"Too many matches; add a first name or phone.");}));
test("K7 create writes exactly one active unlinked Person; missing surname writes nothing",async()=>route([],async(base,writes)=>{let r=await fetch(base+"/guarantors",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({firstName:"Beth",lastName:"Ann"})});assert.equal(r.status,201);assert.deepEqual(await r.json(),{personId:"new",versionId:"1"});assert.equal(writes.length,1);assert.equal(writes[0].request.method,"POST");assert.equal(writes[0].resource.resourceType,"Person");assert.equal(writes[0].resource.active,true);assert.equal(writes[0].resource.link,undefined);r=await fetch(base+"/guarantors",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({firstName:"Beth"})});assert.equal(r.status,400);assert.equal(writes.length,1);}));

import { fixture, run } from "./guarantorScreensFixture.js";
test("K8 draft includes every source link, writes nothing, refuses consolidate subset",async()=>{const f=fixture();const input={kind:"consolidate",sourcePersonId:"S",destinationPersonId:"D"};const result=await run(f,"draft",input);assert.equal(result.status,200);assert.deepEqual(result.body.relatedPersonIds,["r1","r2"]);assert.equal(result.body.patients.length,2);assert.equal(f.writes.length,0);assert.equal((await run(f,"draft",{...input,relatedPersonIds:["r1"]})).status,422);assert.equal(f.writes.length,0);});
test("K9 draft versions reject changed child at create",async()=>{const f=fixture();const input={kind:"transfer",sourcePersonId:"S",destinationPersonId:"D",relatedPersonIds:["r1"]};const draft=await run(f,"draft",input);assert.equal(draft.status,200);f.compete("RelatedPerson/r1",r=>({...r,active:!r.active}));assert.equal((await run(f,"create",{...f.input("transfer",["r1"]),expected:draft.body.expected})).status,409);assert.equal(f.writes.length,0);});

test("K13 history filters trusted child plans and queries newest 50 once",async()=>{const f=fixture();const a=await run(f,"create",f.input("transfer",["r1"]));assert.equal(a.status,200);const b=await run(f,"create",f.input("transfer",["r2"]));assert.equal(b.status,200);const t1={...a.body.task,meta:{...a.body.task.meta,lastUpdated:"2026-09-14T10:00:00Z"}};const forged={...t1,id:"forged",meta:{...t1.meta,author:{reference:"Practitioner/forger"}}};let searches=0;const original=f.deps.serviceFhir.searchProject;f.deps.serviceFhir.searchProject=async(type:any,project:any,params:any)=>{if(type!=="Task")return original(type,project,params);searches++;assert.equal(params._count,"50");assert.equal(params._sort,"-_lastUpdated");assert.match(params.code,/guarantor-link-operation\|$/);return {resourceType:"Bundle",type:"searchset",entry:[b.body.task,forged,t1].map(resource=>({resource})),link:[{relation:"next",url:"http://synthetic.test/do-not-follow"}]};};const result=await run(f,"history",{relatedPersonId:"r1"});assert.equal(result.status,200);assert.deepEqual(result.body.map((x:any)=>x.task.id),[t1.id]);assert.equal(searches,1);});

test("K8 empty consolidation draft refuses with zero writes",async()=>{const f=fixture(0);const result=await run(f,"draft",{kind:"consolidate",sourcePersonId:"S",destinationPersonId:"D"});assert.equal(result.status,422);assert.equal(f.writes.length,0);});

for (const [label,path,body] of [
 ["search","/guarantors/search?lastName=Source&firstName=Beth",undefined],
 ["create","/guarantors",{firstName:"Beth",lastName:"Ann"}],
 ["draft","/guarantors/link-operations/draft",{kind:"transfer",sourcePersonId:"S",destinationPersonId:"D",relatedPersonIds:["r1"]}],
 ["history","/guarantors/link-operations?relatedPersonId=r1",undefined],
] as const) test(`K6 ${label} denies staff without guarantor.link before FHIR searches or writes`,async()=>{
 const f=fixture();let searches=0;const original=f.deps.serviceFhir.searchProject;
 const app=express();app.use(express.json());registerGuarantorRoutes(app,{authenticateService:async()=>{},authenticate:async()=>({staffReference:"Practitioner/staff",actorRole:"staff",businessActions:[],project:{reference:`Project/${f.S.meta!.project}`}}),serviceFhir:{...f.deps.serviceFhir,getAuthenticatedProfileReference:async()=>f.deps.serviceReference,searchProject:async(...args:Parameters<typeof original>)=>{searches++;return original(...args);}},recordAudit:f.deps.recordAudit} as never);
 const server=app.listen(0,"127.0.0.1");await new Promise<void>(r=>server.once("listening",r));
 try {const result=await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}${path}`,body?{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)}:undefined);assert.deepEqual({status:result.status,searches,writes:f.writes.length},{status:403,searches:0,writes:0});}
 finally {await new Promise<void>(r=>server.close(()=>r()));}
});
