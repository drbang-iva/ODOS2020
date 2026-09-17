import { protocolFixture } from "./fixtures/r10/protocol-harness.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { FINDING_WRITE_PATH_IDS, checkFindingWriteRegistry, examPdfConsumerCensus } from "../scripts/check-r10-a3-release.mjs";
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
import { handleDiagnosisFindingsMutationRequest } from "../src/clinical-graph/diagnosis-findings-endpoint.js";
import { overviewFixture, missing as missingOverviewFindings } from "./fixtures/r10/overview-harness.js";

import { fixture as carryFixture, pull as carryPull, carried as carryFacts, conditions as carryConditions } from "./fixtures/r10/carry-harness.js";

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

test("T1 previous exams displays canonical finding linked by extension",async()=>{
  const c=carryFixture();
  const retiredRow=catalog.find(row=>row.findingDefinitionKey===lens.stableKey&&row.optionCode!==nuclear.optionCode)!;
  const retiredKey={...keyFor("OD",retiredRow.optionCode),encounterId:"past"};
  c.save({...fact("retired","past","OD",["Condition/source"]),status:"entered-in-error",code:odosConcept(retiredRow.atomicFindingId),identifier:[currentFindingIdentifier(retiredKey)],component:[comp("R10_CURRENT_META",JSON.stringify(retiredKey))]});
  const result=await handlePreviousExamsReadRequest(c.deps as any,{authHeader:AUTH,params:{encounterId:"e1"},query:{}});
  assert.equal(result.status,200,JSON.stringify(result.body));
  const facts=(result.body as any).encounters.flatMap((e:any)=>e.diagnoses.flatMap((d:any)=>d.findings));
  assert.ok(facts.some((f:any)=>f.observationReference==="Observation/source-OD"));
  assert.deepEqual(facts.map((f:any)=>f.laterality).sort(),["OD","OS"]);
  assert.deepEqual(facts.map((f:any)=>f.qualifiers),[{grade:"2+"},{grade:"2+"}]);
});
test("T2 carry pull preserves canonical identity typed qualifiers and destination home",async()=>{
  const c=carryFixture(["OD"]);const result=await carryPull(c);
  assert.equal(result.status,200,JSON.stringify(result.body));
  const copied=carryFacts(c);
  assert.equal(copied.length,1);assert.equal(parseCurrentFindingEnvelope(copied[0]).status,"valid");
  assert.equal(copied[0].component?.find(v=>v.code.coding?.some(k=>k.code?.endsWith("::grade")))?.valueCodeableConcept?.coding?.[0]?.code,"2+");
  assert.ok(copied[0].extension?.some(e=>e.url===SUPPORTS_DIAGNOSIS_URL&&e.valueReference?.reference===(result.body as any).conditionReference));
});
test("T3 later writer version after carry is read as edited",async()=>{
  const c=carryFixture(["OD"]);assert.equal((await carryPull(c)).status,200);
  const current=carryConditions(c)[0],carried=carryFacts(c)[0];
  const untouched=await readDiagnosisCarryState(c.fhir,current,[carried]);
  assert.equal(untouched.edited,false,untouched.integrityWarning);
  assert.equal(untouched.observationCarried[`Observation/${carried.id}`],true);
  c.hooks.beforeWrite=w=>{if(w.resource.resourceType==="Provenance")throw Object.assign(Error("pending"),{status:403});};
  const changed=await executeFindingCommand(writerContext(c),command([factTarget(keyFor(),{kind:"canonical",reference:`Observation/${carried.id}`,versionId:carried.meta!.versionId!},{status:"live",presence:"present",qualifiers:{grade:"3+"},homes:[`Condition/${current.id}`]})]) as any);
  assert.equal(changed.outcomes[0].auditPending,true);
  const state=await readDiagnosisCarryState(c.fhir,current,carryFacts(c));
  assert.equal(state.edited,true);assert.equal(state.observationCarried[`Observation/${carried.id}`],false);
});
test("T7 overview shows live canonical facts and excludes cleared facts",()=>{
  const result=buildExamOverviewProjection({encounterReference:"Encounter/e1",patientReference:"Patient/p1",definitions,currentObservations:[fact(),{...fact("retired","e1","OS"),status:"entered-in-error"}],priorObservationCandidates:[],assessmentRows:[]});
  assert.deepEqual(result.findings.map(f=>f.observationReference),["Observation/fact"]);
});
test("T8 overview evidence includes extension homes without Condition evidence",async()=>{
  const c=overviewFixture();c.save(fact("linked-fact","e1","OD",["Condition/current"]));
  const result=await c.overview();
  assert.equal(result.status,200,JSON.stringify(result.body));
  assert.ok((result.body as any).findings.find((f:any)=>f.observationReference==="Observation/linked-fact")?.diagnoses?.length);
});
test("T9 completeness credits live canonical facts but not cleared facts",async()=>{
  const c=overviewFixture();const saved=c.save(fact());
  assert.equal((await missingOverviewFindings(c)).length===0,true);
  c.save({...saved,status:"entered-in-error"});
  assert.equal((await missingOverviewFindings(c)).length===0,false);
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
  const undo=await handleEncounterUndoRequest(c.deps,input(scope==="encounter"?{scope,voidActionId:(result.body as any).voidActionId}:{scope:"section",sectionKey:lens.sectionKey,voidActionId:(result.body as any).voidActionId}));
  assert.equal(undo.status,200,JSON.stringify(undo.body));
  const restored=c.fhir.get<Observation>("Observation","fact");assert.equal(restored.status,"preliminary");
  assert.deepEqual(restored.identifier,before.identifier);assert.deepEqual(restored.component,before.component);assert.deepEqual(restored.extension,before.extension);
}
test("T10 section void selects canonical facts and undo restores exact records",()=>voidAndUndo("section"));
test("T11 finding void and undo preserve identity qualifiers homes and other eye",()=>voidAndUndo("finding"));
test("T12 encounter void and undo include canonical facts with exact counts",()=>voidAndUndo("encounter"));
test("T13 lifecycle mutation repairs owed audit before replacing clinical state",async()=>{
  const m=memoryFhir();m.hooks.beforeWrite=w=>{if(w.resource.resourceType==="Provenance")throw Object.assign(Error("pending"),{status:403});};
  await executeFindingCommand(writerContext(m),command([factTarget()]) as any);
  const c=context();for(const o of m.all<Observation>("Observation"))c.fhir.add(o);
  assert.equal((await findPendingAudits(c.clinical,c.fhir.all("Observation"))).size,1);
  const result=await handleEncounterVoidRequest(c.deps,input({scope:"encounter"}));
  assert.equal(result.status,200,JSON.stringify(result.body));assert.ok(c.fhir.all<Observation>("Observation").every(o=>o.status==="entered-in-error"));
  assert.equal((await findPendingAudits(c.clinical,c.fhir.all("Observation"))).size,0);
});
test("T14 lifecycle refuses signed canonical facts without downgrading them",async()=>{
  const c=context();c.fhir.add({...fact(),status:"final"});
  const result=await handleEncounterVoidRequest(c.deps,input({scope:"encounter"}));
  assert.equal(result.status,422);assert.equal(c.fhir.transactions.length,0);assert.equal(c.fhir.get<Observation>("Observation","fact").status,"final");
});
test("T17 supported Ocular Health pick links fact targets without Condition evidence",async()=>{
  const c=context();const o=fact();c.fhir.add(o);const commandId=command([]).commandId;
  c.clinical.executeTransaction=async(bundle)=>{
    const response=await c.fhir.executeTransaction(bundle);
    const references=new Map((bundle.entry??[]).map((entry,index)=>[entry.fullUrl,response.entry?.[index]?.response?.location?.split("/_history/")[0]]));
    for(const entry of response.entry??[]){
      const reference=entry.response!.location!.split("/_history/")[0];const [type,id]=reference.split("/");
      const resource=await c.fhir.read(type as any,id);
      const resolved=JSON.parse(JSON.stringify(resource),(_key,value)=>typeof value==="string"&&references.has(value)?references.get(value):value);
      c.fhir.replace(resolved);entry.resource=resolved;
    }
    return response;
  };
  const result=await handleDiagnosisPickRequest({authenticate:c.authenticate,diagnosisVisitStatusStore:{listByEncounter:async()=>[],upsert:async(input:any)=>({...input,updatedAt:input.at,setAt:input.at})}} as any,input({diagnosisKey:nuclear.diagnosisKeys[0],action:"confirm",source:"mapping",commandId,supportingFacts:[{key:keyFor(),baseline:{kind:"canonical",reference:"Observation/fact",versionId:"1"}}]}));
  assert.equal(result.status,200,JSON.stringify(result.body));
  assert.equal((result.body as any).conditionStep,"applied");assert.equal((result.body as any).link,"pending");
  assert.ok(c.fhir.all<Condition>("Condition").length);assert.ok(c.fhir.all<Condition>("Condition").every(d=>!d.evidence?.length));
  const reference=`Condition/${(result.body as any).condition.id}`;
  const m=memoryFhir([...c.fhir.all<Observation>("Observation"),...c.fhir.all<Condition>("Condition"),...c.fhir.all<Encounter>("Encounter")]);
  const linked=await handleDiagnosisFindingsMutationRequest({fhirBaseUrl:m.fhir.baseUrl,authenticate:async()=>({staffReference:"Practitioner/doc1",actorRole:"provider",fhir:m.fhir as any}),findingDefinitions:()=>definitions},input({commandId,patientReference:"Patient/p1",operation:"link",context:{selectedConditionReference:reference},targets:[factTarget(keyFor(),{kind:"canonical",reference:"Observation/fact",versionId:"1"},{status:"live",presence:"present",qualifiers:{grade:"2+"},homes:[reference]})]}));
  assert.equal(linked.status,200,JSON.stringify(linked.body));assert.equal((linked.body as any).complete,true);assert.ok(m.all<Observation>("Observation")[0].extension?.some(e=>e.url===SUPPORTS_DIAGNOSIS_URL&&e.valueReference?.reference===reference));
  assert.ok(m.all<Condition>("Condition").every(d=>!d.evidence?.length));
});
test("T19 protocol capture reads current canonical facts instead of raw exact-code rows",async()=>{
  const c=await protocolFixture();c.save(fact());c.save({...fact("cleared","e1","OS"),status:"entered-in-error"});
  const response=await c.capture();assert.equal(response.status,201,JSON.stringify(response.body));
  const result=(response.body as any).protocol;
  assert.equal(result.items.filter((i:any)=>i.itemType==="finding-seed").length,1);
  assert.equal(result.items[0].payload.mode,"promptOnly");
  assert.deepEqual(result.items[0].payload.expand.eyes,["OD"]);
});
test("T20 source census identifies any exam PDF consumer for canonical migration",()=>{
  const root=new URL("../../",import.meta.url).pathname;
  const census=examPdfConsumerCensus(root);
  assert.deepEqual(census,[],`Exam PDF consumer requires an executable canonical-data scenario: ${census.join("\n")}`);
});
test("T21 pre-rebuild Ocular Health history and capture remain read-only",async()=>{
  const c=context();c.fhir.add(atomic());const deps={authenticate:async()=>({...await c.authenticate(),fhir:{...c.clinical,createWithOutcome:c.fhir.createWithOutcome.bind(c.fhir),update:c.fhir.update.bind(c.fhir)}}),findingDefinitions:()=>definitions};
  const history=await handleCustomSectionHistoryRequest(deps,{authHeader:AUTH,params:{stableKey:lens.stableKey},query:{patient:"Patient/p1",encounter:"Encounter/e1"}});
  assert.equal(history.status,200);assert.equal((history.body as any).encounterEditable,false);
  const before=c.fhir.all("Observation").length;const writesBefore=c.fhir.writes.length;const key=keyFor();
  const result=await handleCustomSectionCaptureRequest(deps,{authHeader:AUTH,params:{stableKey:lens.stableKey},body:{commandId:command([]).commandId,patientReference:"Patient/p1",encounterReference:"Encounter/e1",eyes:{OD:{loaded:[],selected:[{key,baseline:{kind:"absent",key},presence:"present",qualifiers:{grade:"2+"},homes:[]}]}}}});
  assert.equal(result.status,409);assert.equal(c.fhir.all("Observation").length,before);
  assert.equal((result.body as any).reason,"pre-rebuild-test-encounter");assert.equal(c.fhir.writes.length,writesBefore);
});
test("T22 every registered finding write path uses real handlers and emits permitted Observations",async t=>{
  const root=fileURLToPath(new URL("../../",import.meta.url));
  const read=(name:string)=>JSON.parse(readFileSync(resolve(root,"mcp/tests/fixtures/r10",name+".json"),"utf8"));
  const census=checkFindingWriteRegistry(root,read("finding-write-paths"),read("finding-write-exclusions"));
  assert.deepEqual(census.failures,[],census.failures.join("\n"));
  const {runEndpointWritePaths}=await import("./fixtures/r10/endpoint-write-path-runtime.js");
  const {runProtocolWritePaths}=await import("./fixtures/r10/protocol-write-paths.js");
  const {runMcpWritePaths}=await import("./fixtures/r10/mcp-write-paths.js");
  const rows=[...await runEndpointWritePaths(),...await runProtocolWritePaths(),...await runMcpWritePaths()];
  assert.deepEqual(rows.map(row=>row.id).sort(),[...FINDING_WRITE_PATH_IDS].sort(),"T22 runtime path IDs must match the fixed registry exactly");
  for(const row of rows){
    assert.ok(row.attempted.length,`${row.id}: real handler attempted no writes`);
    assert.ok(row.persisted.length,`${row.id}: real handler persisted no writes`);
    assert.deepEqual(row.rejection.attempted,[],`${row.id}: rejected phase attempted writes`);
    assert.deepEqual(row.rejection.persisted,[],`${row.id}: rejected phase persisted writes`);
    assert.ok(row.observations.every(observation=>!observation.kind.startsWith("legacy-")&&!["unresolved-legacy","invalid"].includes(observation.kind)),`${row.id}: prohibited Observation output`);
    t.diagnostic(JSON.stringify({id:row.id,scenarioId:row.scenarioId,handler:row.handler,responseStatus:row.responseStatus,rejectionScope:(row as any).rejectionScope??"whole-request",attempted:row.attempted.length,persisted:row.persisted.length,observations:row.observations.map(observation=>({stage:observation.stage,reference:observation.reference,kind:observation.kind})),rejection:{scenarioId:row.rejection.scenarioId,status:row.rejection.responseStatus,reason:row.rejection.reason,attempted:0,persisted:0}}));
  }
  t.diagnostic(JSON.stringify({census:{paths:rows.length,sites:census.sites.length,mapped:census.mapped,excluded:census.excluded}}));
});
