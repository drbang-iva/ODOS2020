import assert from "node:assert/strict";
import { test } from "node:test";
import React from "react";
import { act, create } from "react-test-renderer";
import { DiagnosisFindingsTable, UnassignedFindingsTray } from "../src/components/charting/DiagnosisFindingsTable";
import { groupFindingRows, handleFindingOutcome, loadDiagnosisFindings, mutateDiagnosisFinding, repairFindingAudits, type DiagnosisFindingsPayload, type EncounterFindingRow, type DiagnosisFindingMutation } from "../src/lib/diagnosis-findings";
function row(eye:"OD"|"OS", overrides:Partial<EncounterFindingRow>={}):EncounterFindingRow {
  const key={v:1 as const,patientId:"p",encounterId:"e",stableKey:"lens",fieldCode:"finding",optionCode:"opacity",eye};
  return {atomicFindingId:"lens::finding::opacity",findingDefinitionId:"lens",findingDefinitionKey:"lens",fieldCode:"finding",optionCode:"opacity",display:"Opacity",sectionKey:"lens",gradeScale:["1","2"],diagnosisKeys:["cataract"],origin:"custom",rowKey:`opacity:${eye}`,kind:"fact",eye,laterality:eye,presence:"present",qualifiers:{grade:"1"},grade:"1",status:"live",editable:true,homes:["Condition/a"],homeSources:[],key,baseline:{kind:"canonical",reference:`Observation/${eye}`,versionId:"3"},contributors:[{reference:`Observation/${eye}`,kind:"canonical-fact"}],...overrides};
}
function payload(overrides:Partial<DiagnosisFindingsPayload>={}):DiagnosisFindingsPayload {
  const rows=[row("OD"),row("OS")];
  return {encounterEditable:true,canWrite:true,canWriteDiagnosis:false,findings:rows,catalog:[],searchIndex:rows,unassigned:[],bySection:{lens:rows},auditDebt:[],visitDiagnoses:[],...overrides};
}
function table(data=payload()) {
  const commands:DiagnosisFindingMutation[]=[];
  const view=create(<DiagnosisFindingsTable payload={data} patientReference="Patient/p" conditionReference="Condition/a" disabled={false} onMutate={command=>{commands.push(command);}}/>);
  return {commands,view};
}
test("W9 OU click sends one command with two independent canonical baselines",async()=>{
  const {view,commands}=table();
  await act(async()=>{view.root.findByProps({"aria-label":"Clear present Opacity"}).props.onClick();});
  assert.equal(commands.length,1);assert.equal(commands[0].operation,"clear");
  assert.deepEqual(commands[0].targets.map(t=>[t.key.eye,t.baseline]),[["OD",{kind:"canonical",reference:"Observation/OD",versionId:"3"}],["OS",{kind:"canonical",reference:"Observation/OS",versionId:"3"}]]);
  assert.ok(commands[0].targets.every(t=>t.kind === "fact" && t.state.status === "retired" && t.state.homes[0] === "Condition/a"));
  view.unmount();
});
test("W48 pre-rebuild table disables every control and shows the banner",()=>{
  const {view}=table(payload({encounterEditable:false,readOnlyReason:"pre-rebuild-test-encounter"}));
  assert.match(JSON.stringify(view.toJSON()),/Test data from before the rebuild/);
  assert.ok(view.root.findAll(node=>["button","input","select"].includes(String(node.type))).every(node=>node.props.disabled));view.unmount();
});
test("W50 grouped OU to OD retires only OS with explicit from and to",async()=>{
  const {view,commands}=table();
  await act(async()=>{view.root.findByProps({"aria-label":"Laterality Opacity"}).props.onChange({target:{value:"OD"}});});
  assert.deepEqual(commands[0].eyes,{from:["OD","OS"],to:["OD"]});assert.equal(commands[0].operation,"eye-change");
  assert.equal(commands[0].targets.length,1);assert.equal(commands[0].targets[0].key.eye,"OS");assert.equal(commands[0].targets[0].kind === "fact" && commands[0].targets[0].state.status,"retired");view.unmount();
});
test("grouping refuses differing presence qualifiers or homes",()=>{
  for (const difference of [{presence:"absent" as const},{qualifiers:{grade:"2"}},{homes:["Condition/b"]}]) assert.equal(groupFindingRows([row("OD"),row("OS",difference)]).length,2);
});
test("grade preserves all qualifiers and homes and does not require diagnosis write permission",async()=>{
  const {view,commands}=table();await act(async()=>{view.root.findByProps({"aria-label":"Grade Opacity"}).props.onChange({target:{value:"2"}});});
  assert.equal(commands[0].operation,"grade");assert.deepEqual(commands[0].targets.map(t=>t.kind === "fact" && t.state),["OD","OS"].map(()=>({status:"live",presence:"present",qualifiers:{grade:"2"},homes:["Condition/a"]})));view.unmount();
});
test("offered presence asserts both eyes using absent baselines and selected diagnosis",async()=>{
  const rows=(["OD","OS"] as const).map(eye=>{const value=row(eye);return {...value,kind:"offered" as const,status:"offered" as const,presence:undefined,homes:[],qualifiers:{},baseline:{kind:"absent" as const,key:value.key!}};});
  const {view,commands}=table(payload({findings:rows,searchIndex:rows}));await act(async()=>{view.root.findByProps({"aria-label":"Record Opacity absent"}).props.onClick();});
  assert.equal(commands[0].operation,"assert");assert.deepEqual(commands[0].targets.map(t=>t.kind === "fact" && t.state),["OD","OS"].map(()=>({status:"live",presence:"absent",qualifiers:{},homes:["Condition/a"]})));view.unmount();
});
test("search resolves carried current facts and reasserts instead of replacing homes",async()=>{
  const rows=[row("OD",{carried:true}),row("OS",{carried:true})];const {view,commands}=table(payload({searchIndex:rows}));
  await act(async()=>{view.root.findByProps({placeholder:"Search findings"}).props.onChange({target:{value:"Opacity"}});});
  await act(async()=>{view.root.findByProps({className:"odos-diagnosis-finding-search-results"}).findByType("button").props.onClick();});
  assert.equal(commands[0].operation,"reassert");assert.equal(commands[0].targets.length,2);assert.ok(commands[0].targets.every(t=>t.kind === "reassert"));view.unmount();
});
test("tray assigns with move and records standalone with per-eye targets",async()=>{
  const commands:DiagnosisFindingMutation[]=[];const view=create(<UnassignedFindingsTray rows={[row("OD",{homes:[]}),row("OS",{homes:[]})]} visitDiagnoses={[{conditionReference:"Condition/b",diagnosisKey:"b",display:"Diagnosis B",laterality:"OU"}]} patientReference="Patient/p" disabled={false} onMutate={command=>{commands.push(command);}}/>);
  await act(async()=>{view.root.findByProps({"aria-label":"Assign Opacity to Diagnosis B"}).props.onClick();view.root.findByProps({"aria-label":"Record Opacity standalone"}).props.onClick();});
  assert.deepEqual(commands.map(c=>c.operation),["move","standalone"]);assert.deepEqual(commands.map(c=>c.targets.map(t=>t.kind === "fact" && t.state.homes)),[[["Condition/b"],["Condition/b"]],[[],[]]]);view.unmount();
});
test("row conflict and signed status disable actions with plain-language reasons",()=>{
  for(const [reason,label] of [["conflict","Conflicting records"],["signed-or-cancelled","Signed — read only"],["home-outside-encounter","Linked to a diagnosis outside this visit"]]) {
    const {view}=table(payload({findings:[row("OD",{editable:false,readOnlyReason:reason})]}));assert.match(JSON.stringify(view.toJSON()),new RegExp(label));assert.ok(view.root.findAllByType("button").every(node=>node.props.disabled));view.unmount();
  }
});
test("transport preserves non-2xx result bodies and status; load failures stay unavailable",async()=>{
  const body={result:"invalid",error:"destination-differs",reason:"destination-differs"};const response=await mutateDiagnosisFinding("Encounter/e",{commandId:crypto.randomUUID(),patientReference:"Patient/p",operation:"clear",targets:[]},async()=>new Response(JSON.stringify(body),{status:409}));
  assert.deepEqual(response,{status:409,body});assert.equal((await loadDiagnosisFindings("Encounter/e",undefined,async()=>{throw Error("offline");})).result,"unavailable");
});
test("W53 repair calls audit-repair with fresh commandId and patientReference",async()=>{
  const request={commandId:crypto.randomUUID(),patientReference:"Patient/p"};let captured:any;
  await repairFindingAudits("Encounter/e",request,async(url,init)=>{captured={url,init};return new Response(JSON.stringify({result:"command",complete:true,outcomes:[],executionOrder:[],commandId:request.commandId}));});
  assert.match(String(captured.url),/\/findings\/audit-repair$/);assert.equal(captured.init.method,"POST");assert.deepEqual(JSON.parse(captured.init.body),request);
});
test("W46 confirmed partial 409 refreshes and dispatches; unconfirmed 502 retains exact retry",async()=>{
  const events=new EventTarget();let emitted=0,loads=0;events.addEventListener("odos:encounter-findings-changed",()=>{emitted++;});
  const result=await handleFindingOutcome({status:409,body:{result:"command",commandId:"id",complete:false,executionOrder:[0,1],outcomes:[{target:"OD",status:"applied",clinicalWrite:"confirmed"},{target:"OS",status:"conflict",clinicalWrite:"none"}]}},{encounterReference:"Encounter/e",refresh:()=>{loads++;},eventTarget:events});
  assert.equal(loads,1);assert.equal(emitted,1);assert.equal(result.reloadChoice,true);
  const retry=await handleFindingOutcome({status:502,body:{result:"command",commandId:"id",complete:false,executionOrder:[0],outcomes:[{target:"OD",status:"unconfirmed",clinicalWrite:"unknown"}]}},{encounterReference:"Encounter/e",refresh:()=>{loads++;},eventTarget:events});assert.equal(retry.retryIdentical,true);assert.equal(retry.message,"Not confirmed — Retry");
});
test("UNKNOWN offered finding requires explicit eye and resolves canonical search baseline",async()=>{
  const offered=row("OD",{rowKey:"offered:unknown",kind:"offered",status:"offered",eye:"UNKNOWN",laterality:"UNKNOWN",key:undefined,baseline:undefined,presence:undefined});
  const {view,commands}=table(payload({findings:[offered]}));
  assert.equal(view.root.findByProps({"aria-label":"Record Opacity present"}).props.disabled,true);
  await act(async()=>{view.root.findByProps({"aria-label":"Laterality Opacity"}).props.onChange({target:{value:"OS"}});});
  await act(async()=>{view.root.findByProps({"aria-label":"Record Opacity present"}).props.onClick();});
  assert.equal(commands[0].targets.length,1);assert.equal(commands[0].targets[0].key.eye,"OS");assert.deepEqual(commands[0].targets[0].baseline,{kind:"canonical",reference:"Observation/OS",versionId:"3"});view.unmount();
});
test("adding an eye revives its retired canonical owner without replacing its identity",async()=>{
  const source=row("OD"),destination=row("OS",{kind:"offered",status:"offered",presence:undefined,homes:[]});
  const {view,commands}=table(payload({findings:[source],searchIndex:[source,destination],visitDiagnoses:[{conditionReference:"Condition/a",diagnosisKey:"a",display:"A",laterality:"OU"}]}));
  await act(async()=>{view.root.findByProps({"aria-label":"Laterality Opacity"}).props.onChange({target:{value:"OU"}});});
  assert.deepEqual(commands[0].eyes,{from:["OD"],to:["OD","OS"]});assert.equal(commands[0].targets.length,1);assert.deepEqual(commands[0].targets[0].baseline,destination.baseline);assert.deepEqual(commands[0].targets[0].kind === "fact" && commands[0].targets[0].state,{status:"live",presence:"present",qualifiers:{grade:"1"},homes:["Condition/a"]});view.unmount();
});
test("assert retains only current live diagnosis homes and includes selected diagnosis",async()=>{
  const {view,commands}=table(payload({findings:[row("OD",{homes:["Condition/retired","Condition/b"]})],visitDiagnoses:[{conditionReference:"Condition/a",diagnosisKey:"a",display:"A",laterality:"OD"},{conditionReference:"Condition/b",diagnosisKey:"b",display:"B",laterality:"OD"}]}));
  await act(async()=>{view.root.findByProps({"aria-label":"Record Opacity absent"}).props.onClick();});
  assert.deepEqual(commands[0].targets[0].kind === "fact" && commands[0].targets[0].state.homes,["Condition/b","Condition/a"]);view.unmount();
});
test("shared outcomes distinguish complete, audit debt, unavailable, precondition, and refused",async()=>{
  let loads=0;const options={encounterReference:"Encounter/e",refresh:()=>{loads++;}};
  const complete=await handleFindingOutcome({status:200,body:{result:"command",commandId:"id",complete:true,executionOrder:[],outcomes:[]}},options);assert.equal(complete.message,undefined);
  const debt=await handleFindingOutcome({status:200,body:{result:"command",commandId:"id",complete:false,executionOrder:[0],outcomes:[{target:"OD",status:"applied",clinicalWrite:"none",auditPending:true}]}},options);assert.equal(debt.auditPending,true);
  const unavailable=await handleFindingOutcome({status:502,body:{result:"unavailable",kind:"upstream",error:"broken"}},options);assert.equal(unavailable.message,"Findings unavailable");
  const precondition=await handleFindingOutcome({status:428,body:{result:"precondition",error:"baseline",targetIndex:0}},options);assert.equal(precondition.reloadChoice,true);
  const refused=await handleFindingOutcome({status:422,body:{result:"command",commandId:"id",complete:false,executionOrder:[0],outcomes:[{target:"OD",status:"refused",clinicalWrite:"none"}]}},options);assert.equal(refused.reloadChoice,true);assert.equal(loads,4);
});
