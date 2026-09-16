import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import type { Condition, Encounter, Observation, Provenance, Resource } from "@medplum/fhirtypes";
import { fixture, AUTH } from "./encounterVoidFixture.js";
import { canonicalFact, command, factTarget, keyFor, memoryFhir, writerContext } from "./fixtures/r10/writer-harness.js";
import { atomic, comp, definitions, lens, lensField, catalog, nuclear } from "./fixtures/r10/factories.js";
import { currentFindingIdentifier, parseCurrentFindingEnvelope, SUPPORTS_DIAGNOSIS_URL, findPendingAudits } from "../src/clinical-graph/current-finding-identity.js";
import { executeFindingCommand } from "../src/clinical-graph/current-finding-writer.js";
import { buildEncounterDiagnosisCondition } from "../src/fhir/condition.js";
import { odosConcept } from "../src/fhir/ophthalmology/extensions.js";
import { buildProvenance } from "../src/fhir/ophthalmology/provenance.js";
import { handlePreviousExamsReadRequest, handleDiagnosisPullRequest } from "../src/clinical-graph/diagnosis-carry-forward-endpoint.js";
import { readDiagnosisCarryState } from "../src/clinical-graph/diagnosis-carry-provenance.js";
import { buildExamOverviewProjection } from "../src/clinical-graph/exam-overview-projection.js";
import { handleExamOverviewRequest } from "../src/clinical-graph/exam-overview-endpoint.js";
import { handleEncounterVoidRequest } from "../src/clinical-graph/encounter-void-endpoint.js";
import { handleEncounterUndoRequest } from "../src/clinical-graph/encounter-undo-endpoint.js";
import { handleCustomSectionCaptureRequest, handleCustomSectionHistoryRequest } from "../src/clinical-graph/custom-section-endpoint.js";
import { handleDiagnosisPickRequest } from "../src/clinical-graph/diagnosis-pick-endpoint.js";
import { ProtocolService } from "../src/clinical-graph/protocol-service.js";
import { keyFindingSatisfied } from "./fixtures/r10/completeness-predicate.mjs";

const todo={todo:"R10 A3"};
function fact(id="fact",encounterId="e1",eye:"OD"|"OS"="OD",homes:string[]=[]):Observation {
  const key={...keyFor(eye),encounterId};
  const original=canonicalFact(id,eye);
  return {...original,meta:{versionId:"1"},encounter:{reference:`Encounter/${encounterId}`},
    identifier:[currentFindingIdentifier(key)],component:[comp("R10_CURRENT_META",JSON.stringify(key)),{code:odosConcept(`${lensField}::${nuclear.optionCode}::grade`),valueCodeableConcept:odosConcept("2+")}],
    extension:[...(original.extension??[]),...homes.map(reference=>({url:SUPPORTS_DIAGNOSIS_URL,valueReference:{reference}}))]};
}
function condition(id:string,encounterId:string):Condition {
  return {...buildEncounterDiagnosisCondition({patientReference:"Patient/p1",encounterReference:`Encounter/${encounterId}`,
    code:{text:"Synthetic diagnosis"},verificationStatus:"confirmed"}),id,meta:{versionId:"1"}};
}
function context() {
  const {deps,fhir}=fixture();deps.findingDefinitions=()=>definitions;
  const search=fhir.search.bind(fhir);
  fhir.search=async(type:any,params:any={})=>{
    const page=await search(type,params);
    return {...page,entry:page.entry?.filter(({resource:r}:any)=>
      (!params.encounter||r.encounter?.reference===params.encounter)&&
      (!params.target||r.target?.some((t:any)=>t.reference===params.target))&&
      (!params._tag||r.meta?.tag?.some((t:any)=>params._tag.split(',').includes(`${t.system}|${t.code}`)))&&
      (!params.date||new Date(r.period?.start).getTime()<new Date(params.date.slice(2)).getTime()))} as any;
  };
  const clinical={...fhir,baseUrl:"http://synthetic.local",read:fhir.read.bind(fhir),search:fhir.search.bind(fhir),executeTransaction:fhir.executeTransaction.bind(fhir),
    create:async(r:Resource)=>fhir.add({...r,id:r.id??`created-${fhir.all(r.resourceType).length}`} as Resource)};
  const authenticate=async()=>({staffReference:"Practitioner/doc1",actorRole:"provider" as const,fhir:clinical});
  return {deps,fhir,clinical,authenticate};
}
function carryContext() {
  const c=context();
  c.fhir.add({resourceType:"Patient",id:"p1"});
  c.fhir.replace({...c.fhir.get<Encounter>("Encounter","e1"),period:{start:"2026-09-16T12:00:00Z"}});
  c.fhir.add({...c.fhir.get<Encounter>("Encounter","e1"),id:"e0",status:"finished",period:{start:"2026-09-15T12:00:00Z"},diagnosis:[{condition:{reference:"Condition/source"}}]});
  c.fhir.add(condition("source","e0"));c.fhir.add(fact("source-fact","e0","OD",["Condition/source"]));
  return {...c,carryDeps:{fhirBaseUrl:clinicalBase,authenticate:c.authenticate}};
}
const clinicalBase="http://synthetic.local";
const input=(body:unknown)=>({authHeader:AUTH,params:{encounterId:"e1"},body});

test("T1 previous exams displays canonical finding linked by extension",todo,async()=>{
  const c=carryContext();const result=await handlePreviousExamsReadRequest(c.carryDeps as any,{authHeader:AUTH,params:{encounterId:"e1"},query:{}});
  assert.equal(result.status,200,JSON.stringify(result.body));
  assert.ok((result.body as any).encounters.some((e:any)=>e.diagnoses.some((d:any)=>d.findings.some((f:any)=>f.observationReference==="Observation/source-fact"))));
});
test("T2 carry pull preserves canonical identity typed qualifiers and destination home",todo,async()=>{
  const c=carryContext();const result=await handleDiagnosisPullRequest(c.carryDeps as any,input({sourceEncounterReference:"Encounter/e0",sourceConditionReference:"Condition/source"}));
  assert.equal(result.status,200,JSON.stringify(result.body));
  const copied=c.fhir.all<Observation>("Observation").filter(o=>o.encounter?.reference==="Encounter/e1");
  assert.equal(copied.length,1);assert.equal(parseCurrentFindingEnvelope(copied[0]).status,"valid");
  assert.equal(copied[0].component?.find(v=>v.code.coding?.some(k=>k.code?.endsWith("::grade")))?.valueCodeableConcept?.coding?.[0]?.code,"2+");
  assert.ok(copied[0].extension?.some(e=>e.url===SUPPORTS_DIAGNOSIS_URL&&e.valueReference?.reference===(result.body as any).conditionReference));
});
test("T3 pending mutation marker postdating carry is read as edited",todo,async()=>{
  const c=carryContext();const current=condition("current","e1");c.fhir.add(current);
  const m=memoryFhir();m.hooks.beforeWrite=w=>{if(w.resource.resourceType==="Provenance")throw Object.assign(Error("pending"),{status:403});};
  await executeFindingCommand(writerContext(m),command([factTarget()]) as any);
  const carried=m.all<Observation>("Observation")[0];c.fhir.add(carried);
  c.fhir.add({...buildProvenance({targetReferences:["Condition/current",`Observation/${carried.id}`],recorded:"2026-09-16T10:00:00Z",activityCode:"CREATE",activityDisplay:"Diagnosis pull-forward",agents:[{whoReference:"Practitioner/doc1",typeCode:"author"}]}),id:"carry",
    activity:{...buildProvenance({targetReferences:["Condition/current"],recorded:"2026-09-16T10:00:00Z",activityCode:"CREATE",agents:[{whoReference:"Practitioner/doc1",typeCode:"author"}]}).activity,text:"Diagnosis pull-forward"},
    entity:[{role:"source",what:{reference:"Condition/source"}},{role:"source",what:{reference:"Observation/source-fact"}}]} as Provenance);
  const state=await readDiagnosisCarryState(c.clinical,current,[carried]);
  assert.equal(state.edited,true);assert.equal(state.observationCarried[`Observation/${carried.id}`],false);
});
test("T7 overview shows live canonical facts and excludes cleared facts",todo,()=>{
  const result=buildExamOverviewProjection({encounterReference:"Encounter/e1",patientReference:"Patient/p1",definitions,currentObservations:[fact(),{...fact("retired","e1","OS"),status:"entered-in-error"}],priorObservationCandidates:[],assessmentRows:[]});
  assert.deepEqual(result.findings.map(f=>f.observationReference),["Observation/fact"]);
});
test("T8 overview evidence includes extension homes without Condition evidence",todo,async()=>{
  const c=context();c.fhir.add(condition("linked","e1"));c.fhir.add(fact("linked-fact","e1","OD",["Condition/linked"]));
  const result=await handleExamOverviewRequest({authenticate:c.authenticate,findingDefinitions:async()=>definitions} as any,{authHeader:AUTH,params:{encounterId:"e1"}});
  assert.equal(result.status,200,JSON.stringify(result.body));
  assert.ok((result.body as any).findings.find((f:any)=>f.observationReference==="Observation/linked-fact")?.diagnoses?.length);
});
test("T9 completeness credits live canonical facts but not cleared facts",todo,()=>{
  const entry={satisfiedBy:"this-encounter",findingDefinitionKey:lens.stableKey};
  assert.equal(keyFindingSatisfied(entry,lens,[fact()],[],new Date("2026-09-16T12:00:00Z")),true);
  assert.equal(keyFindingSatisfied(entry,lens,[{...fact(),status:"entered-in-error"}],[],new Date("2026-09-16T12:00:00Z")),false);
});
async function voidAndUndo(scope:"section"|"finding"|"encounter") {
  const c=context();const before=fact("fact","e1","OD",["Condition/linked"]);c.fhir.add(condition("linked","e1"));c.fhir.add(before);c.fhir.add(fact("other-eye","e1","OS"));c.fhir.add(fact("prior","e0"));
  const siblingRow=catalog.find(row=>row.findingDefinitionKey!==lens.stableKey)!;
  const siblingKey={...keyFor(),stableKey:siblingRow.findingDefinitionKey,fieldCode:siblingRow.fieldCode,optionCode:siblingRow.optionCode};
  c.fhir.add({...fact("sibling"),code:odosConcept(siblingRow.atomicFindingId),identifier:[currentFindingIdentifier(siblingKey)],component:[comp("R10_CURRENT_META",JSON.stringify(siblingKey))]});
  const body=scope==="finding"?{scope,findingKey:lens.stableKey,laterality:"OD",sectionKey:lens.sectionKey}:scope==="section"?{scope,sectionKey:lens.sectionKey}:{scope};
  const result=await handleEncounterVoidRequest(c.deps,input(body));assert.equal(result.status,200,JSON.stringify(result.body));
  assert.equal((result.body as any).count,scope==="finding"?1:scope==="section"?2:4);
  assert.equal(c.fhir.get<Observation>("Observation","fact").status,"entered-in-error");
  assert.equal(c.fhir.get<Observation>("Observation","other-eye").status,scope==="finding"?"preliminary":"entered-in-error");
  assert.equal(c.fhir.get<Observation>("Observation","prior").status,"preliminary");
  assert.equal(c.fhir.get<Observation>("Observation","sibling").status,scope==="encounter"?"entered-in-error":"preliminary");
  const undo=await handleEncounterUndoRequest(c.deps,input(scope==="encounter"?{scope}:{scope:"section",sectionKey:lens.sectionKey}));
  assert.equal(undo.status,200,JSON.stringify(undo.body));
  const restored=c.fhir.get<Observation>("Observation","fact");assert.equal(restored.status,"preliminary");
  assert.deepEqual(restored.identifier,before.identifier);assert.deepEqual(restored.component,before.component);assert.deepEqual(restored.extension,before.extension);
}
test("T10 section void selects canonical facts and undo restores exact records",todo,()=>voidAndUndo("section"));
test("T11 finding void and undo preserve identity qualifiers homes and other eye",todo,()=>voidAndUndo("finding"));
test("T12 encounter void and undo include canonical facts with exact counts",todo,()=>voidAndUndo("encounter"));
test("T13 lifecycle mutation repairs owed audit before replacing clinical state",todo,async()=>{
  const m=memoryFhir();m.hooks.beforeWrite=w=>{if(w.resource.resourceType==="Provenance")throw Object.assign(Error("pending"),{status:403});};
  await executeFindingCommand(writerContext(m),command([factTarget()]) as any);
  const c=context();for(const o of m.all<Observation>("Observation"))c.fhir.add(o);
  assert.equal((await findPendingAudits(c.clinical,c.fhir.all("Observation"))).size,1);
  await handleEncounterVoidRequest(c.deps,input({scope:"encounter"}));
  assert.equal((await findPendingAudits(c.clinical,c.fhir.all("Observation"))).size,0);
});
test("T14 lifecycle refuses signed canonical facts without downgrading them",todo,async()=>{
  const c=context();c.fhir.add({...fact(),status:"final"});
  const result=await handleEncounterVoidRequest(c.deps,input({scope:"encounter"}));
  assert.ok([409,422].includes(result.status));assert.equal(c.fhir.transactions.length,0);assert.equal(c.fhir.get<Observation>("Observation","fact").status,"final");
});
test("T17 supported Ocular Health pick links fact targets without Condition evidence",todo,async()=>{
  const c=context();const o=fact();c.fhir.add(o);
  const result=await handleDiagnosisPickRequest({authenticate:c.authenticate,diagnosisVisitStatusStore:{listByEncounter:async()=>[],upsert:async(input:any)=>({...input,updatedAt:input.at,setAt:input.at})}} as any,input({diagnosisKey:nuclear.diagnosisKeys[0],action:"confirm",source:"mapping",commandId:command([]).commandId,supportingFacts:[{key:keyFor(),baseline:{kind:"canonical",reference:"Observation/fact",versionId:"1"}}]}));
  assert.equal(result.status,200,JSON.stringify(result.body));
  assert.equal((result.body as any).conditionStep,"applied");
  assert.ok(c.fhir.all<Condition>("Condition").length);assert.ok(c.fhir.all<Condition>("Condition").every(d=>!d.evidence?.length));
  const reference=(result.body as any).conditionReference;
  const m=memoryFhir([...c.fhir.all<Observation>("Observation"),...c.fhir.all<Condition>("Condition")]);
  const linked=await executeFindingCommand(writerContext(m),command([factTarget(keyFor(),{kind:"canonical",reference:"Observation/fact",versionId:"1"},{status:"live",presence:"present",qualifiers:{grade:"2+"},homes:[reference]})]) as any);
  assert.equal(linked.complete,true);assert.ok(m.all<Observation>("Observation")[0].extension?.some(e=>e.url===SUPPORTS_DIAGNOSIS_URL&&e.valueReference?.reference===reference));
  assert.ok(m.all<Condition>("Condition").every(d=>!d.evidence?.length));
});
test("T19 protocol capture reads current canonical facts instead of raw exact-code rows",todo,async()=>{
  const c=context();const service=new ProtocolService({...c.clinical,update:async(_type:any,_id:any,r:any)=>{c.fhir.replace(r);return r;}} as any,{commitFinding:async()=>undefined,materializeAction:async()=>undefined});
  const result=await service.captureDraft({encounterId:"e1",name:"Canonical capture",actor:"Practitioner/doc1",confirmedDiagnoses:[],observations:[fact(),{...fact("cleared","e1","OS"),status:"entered-in-error"}],findingKeys:new Set([lens.stableKey])});
  assert.equal(result.items.filter(i=>i.itemType==="finding-seed").length,1);
});
test("T20 source census identifies any exam PDF consumer for canonical migration",todo,()=>{
  const root=new URL("../../",import.meta.url).pathname;
  const census=spawnSync("rg",["-n","-i","exam.{0,30}pdf|pdf.{0,30}exam","mcp/src","ui/src","src"],{cwd:root,encoding:"utf8"});
  assert.ok(census.status===0||census.status===1,census.stderr);
  assert.equal(census.stdout.trim(),"",`Exam PDF consumer requires an executable canonical-data scenario: ${census.stdout}`);
});
test("T21 pre-rebuild Ocular Health history and capture remain read-only",todo,async()=>{
  const c=context();c.fhir.add(atomic());const deps={authenticate:c.authenticate,findingDefinitions:()=>definitions};
  const history=await handleCustomSectionHistoryRequest(deps,{authHeader:AUTH,params:{stableKey:lens.stableKey},query:{patient:"Patient/p1",encounter:"Encounter/e1"}});
  assert.equal(history.status,200);assert.equal((history.body as any).encounterEditable,false);
  const before=c.fhir.all("Observation").length;
  const result=await handleCustomSectionCaptureRequest(deps,{authHeader:AUTH,params:{stableKey:lens.stableKey},body:{patientReference:"Patient/p1",encounterReference:"Encounter/e1",eyes:{OD:{state:"abnormal",customFields:[{code:lensField,value:[nuclear.optionCode]}]}}}});
  assert.equal(result.status,409);assert.equal(c.fhir.all("Observation").length,before);
});
test("T22 section finding writes emit canonical Observations for every option",todo,async()=>{
  const c=context();const result=await handleCustomSectionCaptureRequest({authenticate:c.authenticate,findingDefinitions:()=>definitions},{authHeader:AUTH,params:{stableKey:lens.stableKey},body:{patientReference:"Patient/p1",encounterReference:"Encounter/e1",eyes:{OD:{state:"abnormal",customFields:[{code:lensField,value:[nuclear.optionCode]}]}}}});
  assert.equal(result.status,200,JSON.stringify(result.body));const rows=c.fhir.all<Observation>("Observation");assert.ok(rows.length);
  assert.ok(rows.every(o=>parseCurrentFindingEnvelope(o).status==="valid"));
});
