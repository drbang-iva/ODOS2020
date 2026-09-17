import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { DiagnosisPicker } from "../src/components/charting/DiagnosisPicker";
import { DIAGNOSIS_KEY_IDENTIFIER_SYSTEM } from "../src/lib/clinical-actions";
const stableKey="ocular-health:anterior:lens";
async function mount(proposed=false, failScope=false, deferPick=false) {
 let releasePick: (()=>void) | undefined;
 const previousFetch=globalThis.fetch, previousWindow=globalThis.window;
 Object.defineProperty(globalThis,"window",{configurable:true,value:new EventTarget()});
 const rows=["OD","OS"].map(eye=>({rowKey:eye,key:{v:1,patientId:"p",encounterId:"e",stableKey,fieldCode:"F",optionCode:"opacity",eye},baseline:{kind:"canonical",reference:`Observation/${eye}`,versionId:"1"},kind:"fact",status:"live",presence:"present",editable:true,qualifiers:{},homes:proposed&&eye==="OD"?["Condition/c"]:[]}));
 const condition={resourceType:"Condition",id:"c",meta:{versionId:"1"},subject:{reference:"Patient/p"},identifier:[{system:DIAGNOSIS_KEY_IDENTIFIER_SYSTEM,value:"Encounter/e::dx::OD"}],verificationStatus:{coding:[{code:"provisional"}]},evidence:[{detail:[{reference:"Observation/OS"}]}]};
 const calls:Array<{url:string;method:string;body:any}>=[];
 globalThis.fetch=async(input,init)=>{const url=String(input),method=init?.method??"GET",body=init?.body?JSON.parse(String(init.body)):undefined;if(method!=="GET")calls.push({url,method,body});
 if(url.includes("diagnosis-candidates"))return Response.json({findings:rows.map(row=>({findingInstanceId:row.rowKey,findingDefinitionKey:stableKey,candidates:[{diagnosisKey:"dx",display:`Diagnosis ${row.key.eye}`,codingStatus:"provisional",priority:true,source:"mapping",supportingFacts:[{rowKey:row.rowKey,key:row.key,baseline:row.baseline}]}]}))});
 if(url.includes("diagnosis-catalog"))return Response.json({canWriteDiagnosis:true,diagnoses:[]});
 if(url.includes("/findings"))return Response.json(method==="GET"?{encounterEditable:true,canWrite:true,canWriteDiagnosis:true,findings:rows,searchIndex:rows,visitDiagnoses:proposed?[{conditionReference:"Condition/c",diagnosisKey:"dx",laterality:"OD"}]:[],catalog:[],unassigned:rows,auditDebt:[],bySection:{}}:{result:"command",complete:true,executionOrder:[0],outcomes:[{status:"applied",clinicalWrite:"confirmed"}]});
 if(url.includes("diagnosis-picks")){if(deferPick)await new Promise<void>(resolve=>{releasePick=resolve;});return Response.json({result:"pick",conditionStep:"applied",link:"pending",condition});}
 if(url.includes("BodyStructure"))return Response.json({resourceType:"Bundle",entry:[{resource:{resourceType:"BodyStructure",id:"eye"}}]});
 if(url.includes("Condition"))return method==="PATCH"?(failScope?Response.json({error:"scope refused"},{status:409}):Response.json({...condition,bodySite:[{text:"OU"}]})):Response.json({resourceType:"Bundle",entry:proposed?[{resource:condition}]:[]});
 if(url.includes("Provenance"))return Response.json({resourceType:"Provenance",id:"proof"});
 throw new Error(`Unexpected ${method} ${url}`);
 };
 let renderer!:ReactTestRenderer;
 await act(async()=>{renderer=create(<DiagnosisPicker encounterReference="Encounter/e" patientReference="Patient/p" findingDefinitionKey={stableKey} mode="proposal" linkMode="facts"/>);});
 return {renderer,calls,releasePick:()=>releasePick?.(),close(){act(()=>renderer.unmount());globalThis.fetch=previousFetch;Object.defineProperty(globalThis,"window",{configurable:true,value:previousWindow});}};
}
test("W139 T16 fact homes determine proposed status despite contradictory Condition evidence",async()=>{const m=await mount(true);try{assert.equal(m.renderer.root.findAllByProps({"aria-label":"Retract proposed Diagnosis OD"}).length,1);assert.equal(m.renderer.root.findAllByProps({"aria-label":"Propose Diagnosis OS"}).length,1);}finally{m.close();}});
for(const failScope of [false,true])test(`W140 T17 shared pick scope link merges OD/OS supports: scope failure=${failScope}`,async()=>{const m=await mount(false,failScope);try{await act(async()=>m.renderer.root.findByProps({"aria-label":"Propose Diagnosis OD"}).props.onClick());const pick=m.calls.find(c=>c.url.includes("diagnosis-picks")),scope=m.calls.find(c=>c.method==="PATCH"),link=m.calls.find(c=>c.body?.operation==="link");assert.ok(pick);assert.equal(pick.body.supportingFacts.length,2);assert.equal(pick.body.laterality,"OU");assert.ok(scope);assert.ok(m.calls.indexOf(pick)<m.calls.indexOf(scope));if(failScope){assert.equal(link,undefined);assert.match(JSON.stringify(m.renderer.toJSON()),/Scope not saved/);}else{assert.ok(link);assert.ok(m.calls.indexOf(scope)<m.calls.indexOf(link));assert.equal(link.body.targets.length,2);assert.equal(link.body.commandId,pick.body.commandId);assert.deepEqual(link.body.targets.map((target:any)=>target.state.homes),[["Condition/c"],["Condition/c"]]);}}finally{m.close();}});
for (const definition of ["cvf", "refraction"]) test(`W51 ${definition} remains on the legacy picker path`, async () => {
 const previousFetch=globalThis.fetch,previousWindow=globalThis.window;
 Object.defineProperty(globalThis,"window",{configurable:true,value:new EventTarget()});
 const requests:any[]=[];let renderer!:ReactTestRenderer;
 globalThis.fetch=async(input,init)=>{
  const url=String(input);
  if(url.includes("diagnosis-candidates"))return Response.json({findings:[{findingInstanceId:"legacy",findingDefinitionKey:definition,observationReference:"Observation/legacy",candidates:[{diagnosisKey:"legacy-dx",display:"Legacy diagnosis",source:"mapping",codingStatus:"provisional",priority:true}]}]});
  if(url.includes("diagnosis-catalog"))return Response.json({canWriteDiagnosis:true,diagnoses:[]});
  if(url.includes("diagnosis-picks")){requests.push(JSON.parse(String(init?.body)));return Response.json({condition:{resourceType:"Condition",id:"c"}});}
  throw new Error(`Unexpected legacy request ${url}`);
 };
 const text=(node:any):string=>typeof node==="string"?node:(node.children??[]).map(text).join("");
 try {
  await act(async()=>{renderer=create(<DiagnosisPicker encounterReference="Encounter/e" findingDefinitionKey={definition} observationReferences={["Observation/legacy"]}/>);});
  act(()=>renderer.root.findAllByType("button").find(node=>text(node).includes("dx ▾"))!.props.onClick());
  await act(async()=>renderer.root.findAllByType("button").find(node=>text(node)==="Possible")!.props.onClick());
  assert.equal(requests.length,1);assert.equal("commandId" in requests[0],false);assert.equal("supportingFacts" in requests[0],false);
 } finally {act(()=>renderer?.unmount());globalThis.fetch=previousFetch;Object.defineProperty(globalThis,"window",{configurable:true,value:previousWindow});}
});

test("W140 a late pick response cannot continue scope or link after changing visits",async()=>{
 const m=await mount(false,false,true);
 try {
   let pending!:Promise<void>;
   act(()=>{pending=m.renderer.root.findByProps({"aria-label":"Propose Diagnosis OD"}).props.onClick();});
   await act(async()=>{m.renderer.update(<DiagnosisPicker encounterReference="Encounter/other" patientReference="Patient/other" findingDefinitionKey={stableKey} mode="proposal" linkMode="facts"/>);});
   await act(async()=>{m.releasePick();await pending;});
   assert.equal(m.calls.filter(call=>call.url.includes("diagnosis-picks")).length,1);
   assert.equal(m.calls.filter(call=>call.method==="PATCH"||call.body?.operation==="link").length,0);
 }finally{m.close();}
});
