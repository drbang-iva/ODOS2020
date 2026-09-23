import assert from "node:assert/strict";
import { test } from "node:test";
import React from "react";
import { act, create } from "react-test-renderer";
import { fhir } from "../src/lib/fhir";
import { buildPracticeTimeZoneConfigResource } from "../../mcp/src/clinic/practice-time-zone-config";

test("practice time zone loads, creates canonically, and updates with the read version", async()=>{
 const module=await import("../src/scenes/settings/PracticeTimeZoneSettings").catch(()=>undefined);
 assert.ok(module,"practice time-zone settings component exists");
 const original={search:fhir.search,create:fhir.create,update:fhir.update};
 const writes:any[]=[];
 fhir.search=async()=>({resourceType:"Bundle",type:"searchset",entry:[]}) as any;
 fhir.create=async(resource:any,...args:any[])=>{writes.push({kind:"create",resource,args});return {...resource,id:"zone",meta:{versionId:"1"}};};
 fhir.update=async(resource:any,...args:any[])=>{writes.push({kind:"update",resource,args});return {...resource,meta:{versionId:"2"}};};
 let renderer:any;
 try {
  await act(async()=>{renderer=create(<module.PracticeTimeZoneSettings canWrite />);});
  assert.match(JSON.stringify(renderer.toJSON()),/Not set — the server default is used until you save one\./);
  const select=renderer.root.findByType("select");
  await act(async()=>select.props.onChange({target:{value:"America/Chicago"}}));
  await act(async()=>renderer.root.findByType("form").props.onSubmit({preventDefault(){}}));
  assert.equal(writes.length,1);assert.equal(writes[0].kind,"create");assert.ok(writes[0].args[1]["If-None-Exist"]);
  assert.deepEqual(writes[0].resource,buildPracticeTimeZoneConfigResource({timeZone:"America/Chicago"}));
  await act(async()=>select.props.onChange({target:{value:"America/Denver"}}));
  await act(async()=>renderer.root.findByType("form").props.onSubmit({preventDefault(){}}));
  assert.equal(writes[1].kind,"update");assert.equal(writes[1].args[1],"1");
  assert.match(JSON.stringify(renderer.toJSON()),/Practice time zone saved/);
 } finally {if(renderer)await act(async()=>renderer.unmount());Object.assign(fhir,original);}
});
test("practice time-zone page makes no reads or writes for non-admin",async()=>{
 const module=await import("../src/scenes/settings/PracticeTimeZoneSettings").catch(()=>undefined);assert.ok(module);
 const original=fhir.search;let reads=0;fhir.search=async()=>{reads++;throw Error("no access");};let renderer:any;
 try{await act(async()=>{renderer=create(<module.PracticeTimeZoneSettings canWrite={false}/>);});assert.equal(reads,0);assert.equal(renderer.root.findAllByType("button").length,0);}finally{if(renderer)await act(async()=>renderer.unmount());fhir.search=original;}
});
