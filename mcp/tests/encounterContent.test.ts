import assert from "node:assert/strict";
import { test } from "node:test";
import { encounterContentByEncounter } from "../src/clinical-graph/encounter-content.js";
import { encounterAbandonContent } from "../src/clinical-graph/encounter-abandon-endpoint.js";
import { buildProtocolBasic, PROTOCOL_BASIC_CODES } from "../src/clinical-graph/protocol-store.js";
test("O25 shared content agrees with abandonment and groups mixed references",async()=>{
 const rows:any[]=[{resourceType:"Media",id:"m",status:"completed",encounter:{reference:"Encounter/a"}},{resourceType:"Observation",id:"live",status:"final",encounter:{reference:"Encounter/a"}},{resourceType:"Observation",id:"retracted",status:"entered-in-error",encounter:{reference:"Encounter/a"}},{resourceType:"MedicationStatement",id:"med",status:"active",context:{reference:"Encounter/b"}},{resourceType:"DocumentReference",id:"doc",status:"current",context:{encounter:[{reference:"Encounter/a"},{reference:"Encounter/b"}]}},buildProtocolBasic({id:"p",encounterId:"b",state:"accepted"},PROTOCOL_BASIC_CODES.chargeProposal),buildProtocolBasic({id:"p-removed",encounterId:"a",state:"removed"},PROTOCOL_BASIC_CODES.chargeProposal),buildProtocolBasic({id:"action",encounterId:"a",state:"selected"},PROTOCOL_BASIC_CODES.planActionInstance)];
 const searches:string[]=[];
 const fhir:any={baseUrl:"http://localhost:18103/",search:async(type:string,params:any)=>{searches.push(type);return {resourceType:"Bundle",type:"searchset",entry:rows.filter(r=>r.resourceType===type&&(type==="Basic"?r.code.coding.some((c:any)=>params.code.endsWith(`|${c.code}`)):(Array.isArray(r.context?.encounter)?r.context.encounter:[r.encounter??r.context]).some((ref:any)=>(params.encounter??params.context).split(",").includes(ref?.reference)))).map(resource=>({resource}))};}};
 const batched=await encounterContentByEncounter(fhir,["a","b"]);
 assert.equal(searches.filter(t=>t==="Basic").length,2);
 assert.deepEqual(batched.contentByEncounter.get("a"),[{kind:"Observation",count:1},{kind:"DocumentReference",count:1},{kind:"Media",count:1},{kind:"PlanActionInstance",count:1}]);
 assert.deepEqual(batched.contentByEncounter.get("b"),[{kind:"DocumentReference",count:1},{kind:"MedicationStatement",count:1},{kind:"ChargeProposal",count:1}]);
 assert.deepEqual(await encounterAbandonContent(fhir,"a"),batched.contentByEncounter.get("a"));
 assert.deepEqual(await encounterAbandonContent(fhir,"b"),batched.contentByEncounter.get("b"));
});
test("F1 projected content retains liveness and encounter references",async()=>{
 const rows:any[]=[
  {resourceType:"Observation",id:"live",status:"final",encounter:{reference:"Encounter/a"}},
  {resourceType:"Observation",id:"void",status:"entered-in-error",encounter:{reference:"Encounter/a"}},
  {resourceType:"Condition",id:"void-condition",verificationStatus:{coding:[{code:"entered-in-error"}]},encounter:{reference:"Encounter/a"}},
  {resourceType:"Condition",id:"live-condition",verificationStatus:{coding:[{code:"confirmed"}]},encounter:{reference:"Encounter/b"}},
  {resourceType:"DocumentReference",id:"doc",status:"current",context:{encounter:[{reference:"Encounter/a"},{reference:"Encounter/b"}]}},
 ];
 const paramsByType=new Map<string,Record<string,string>>();
 const fhir:any={baseUrl:"http://localhost:18103/",search:async(type:string,params:Record<string,string>)=>{
  paramsByType.set(type,params);
  const selected=rows.filter(row=>row.resourceType===type);
  const elements=params?._elements?.split(",");
  return {resourceType:"Bundle",type:"searchset",entry:selected.map(row=>({resource:elements?Object.fromEntries(Object.entries(row).filter(([key])=>key==="resourceType"||elements.includes(key))):row}))};
 }};
 const content=await encounterContentByEncounter(fhir,["a","b"]);
 assert.deepEqual(content.contentByEncounter.get("a"),[{kind:"Observation",count:1},{kind:"DocumentReference",count:1}]);
 assert.deepEqual(content.contentByEncounter.get("b"),[{kind:"Condition",count:1},{kind:"DocumentReference",count:1}]);
 assert.equal(paramsByType.get("Condition")?._elements,"id,status,verificationStatus,encounter");
 assert.equal(paramsByType.get("DocumentReference")?._elements,"id,status,context");
 assert.equal(paramsByType.get("Media")?._elements,undefined);
 assert.equal(paramsByType.get("DiagnosticReport")?._elements,undefined);
});
