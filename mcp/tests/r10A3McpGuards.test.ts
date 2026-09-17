import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { test } from "node:test";
import ts from "typescript";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { Bundle, Encounter, Observation, Resource } from "@medplum/fhirtypes";
import * as attestation from "../src/fhir/scribeAttestation.js";
import * as policy from "../../policy/attestation-policy-urls.js";
import { definitions, catalog, snapshot, negative, comp, lens } from "./fixtures/r10/factories.js";
import { canonicalFact, memoryFhir, writerContext, command, factTarget } from "./fixtures/r10/writer-harness.js";
import { executeFindingCommand } from "../src/clinical-graph/current-finding-writer.js";
import { findingPanelIdentifier, findingPanelComponents } from "../src/clinical-graph/current-finding-identity.js";

import * as guards from "../src/clinical-graph/shared-finding-write-guard.js";
const source = ts.createSourceFile("index.ts", readFileSync(new URL("../src/index.ts", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true);
const functions = ["createServer", "toolJson", "stripReference"];
const dispatchSource = source.statements.filter(n => ts.isFunctionDeclaration(n) && functions.includes(n.name?.text ?? "")).map(n => n.getText(source)).join("\n");
assert.equal(source.statements.filter(n => ts.isFunctionDeclaration(n) && functions.includes(n.name?.text ?? "")).length, functions.length);
const input = { clinician_id: "synthetic", signature_data_base64: "c3ludGhldGlj", observation_id: "canonical", target_status: "amended", amendment_text: "Synthetic amendment" };
const encounter = (status: Encounter["status"] = "finished"): Encounter => ({resourceType:"Encounter",id:"e1",status,class:{},subject:{reference:"Patient/p1"}});
function panel(): Observation {
  const key = {v:1 as const,patientId:"p1",encounterId:"e1",stableKey:lens.stableKey,eye:"OD" as const};
  return {...snapshot("canonical",[]),identifier:[findingPanelIdentifier(key)],component:[comp("R10_PANEL_META",JSON.stringify(key)),...findingPanelComponents({deferred:false,other:"Synthetic context",values:{}},lens)]};
}
async function harness(body: Observation, options: { rows?: Resource[]; session?: string; result?: Observation; appendSource?: Observation; memory?: ReturnType<typeof memoryFhir> } = {}) {
  const memory = options.memory ?? memoryFhir([body, encounter(), ...(options.rows ?? [])]);
  const denied: any[] = [];
  const attempted: Resource[] = []; const transactions: Bundle[] = []; const repairWritesBeforeTransaction: number[] = [];
  const fhir = {...memory.fhir,
    async create(resource: Resource) {attempted.push(resource);return memory.save(resource);},
    async update(_type: string,_id: string,resource: Resource) {attempted.push(resource);return memory.save(resource);},
    async executeTransaction(bundle: Bundle) {
      repairWritesBeforeTransaction.push(memory.writes.length);
      transactions.push(bundle);
      for(const entry of bundle.entry ?? []) {
        if(entry.request?.method === "PATCH") {
          const original = structuredClone(memory.resources.get(entry.request.url!)) as Observation;
          const ops = JSON.parse(Buffer.from((entry.resource as any).data,"base64").toString());
          for(const op of ops) {if(op.op === "test") assert.equal((original as any)[op.path.slice(1)],op.value); else if(op.path === "/status") original.status=op.value; else if(op.path === "/note") original.note=op.value; else if(op.path === "/note/-") original.note!.push(op.value);}
          attempted.push(original);memory.save(original);
        } else if(entry.resource) {attempted.push(entry.resource);memory.save(entry.resource);}
      }
      return {resourceType:"Bundle",type:"transaction-response",entry:(bundle.entry??[]).map(()=>({response:{status:"200 OK"}}))};
    }
  };
  const parse = {parse:(value: unknown)=>value};
  const context:any = {Server,CallToolRequestSchema,ListToolsRequestSchema,tools:[],console,Error,Buffer,
    ...attestation,...policy,...guards,fhir,findingDefinitionStore:{list:async()=>definitions},
    sessionPractitionerId:()=>options.session??"synthetic",
    auditRuntime:{record:async (_row:unknown,action:()=>unknown)=>action(),recordDenied:async(row:unknown)=>{denied.push(row);}},
    patientReference:(id:string)=>`Patient/${id}`,encounterReference:(id:string)=>`Encounter/${id}`,
    auditHeaders:()=>({}),getStringArray:()=>[],normalizeSourceType:()=>"manual",normalizeToolReference:(id:string,type:string)=>`${type}/${id}`,
    buildCreateObservationResource:()=>({resource:body,warnings:[]}),
    persistObservationBodyStructures:async (observation:Observation)=>{attempted.push({resourceType:"BodyStructure"} as Resource);return {observation,bodyStructures:[]};},
    buildSectionSaveBundle:()=>({resourceType:"Bundle",type:"transaction",entry:[{resource:body,request:{method:"POST",url:"Observation"}}]}),buildSectionSaveEntries:()=>[],
    buildSmokingStatusObservation:()=>body,buildDryEyeQuestionnaireResponse:()=>({resourceType:"QuestionnaireResponse"}),buildDryEyeQuestionnaireScoreObservation:()=>body,
    buildDocumentReference:()=>({resourceType:"DocumentReference"}),buildMeibographyObservation:()=>body,buildOrthoKFitObservation:()=>body,
    resolveMyopiaDefinitions:()=>definitions,buildMyopiaEyeCapture:()=>({axialLength:{observation:body,provenance:{resourceType:"Provenance"}},cornealRadius:{observation:options.result??body,provenance:{resourceType:"Provenance"}}}),
    createV035Provenance:async()=>{attempted.push({resourceType:"Provenance"} as Resource);return {};},createV04Provenance:async()=>{attempted.push({resourceType:"Provenance"} as Resource);return {};},
    patientScopedProvenanceTargets:()=>[],
    buildScribeDraftObservation:()=>body,
  };
  for(const name of ["createObservationSchema","scribeWriteObservationSchema","saveSectionObservationsSchema","createSmokingStatusObservationSchema","createDryEyeQuestionnaireResponseSchema","createMeibographyObservationSchema","recordOrthoKFitObservationSchema","recordEyeGrowthAxialLengthMeasurementSchema"])context[name]=parse;
  for(const name of ["CREATE_OBSERVATION_AUDIT_HEADERS","SCRIBE_WRITE_OBSERVATION_AUDIT_HEADERS","CREATE_SECTION_OBSERVATIONS_AUDIT_HEADERS","CLINICIAN_ATTEST_OBSERVATION_AUDIT_HEADERS","AMEND_OBSERVATION_AUDIT_HEADERS","APPEND_OBSERVATION_CONTEXT_AUDIT_HEADERS"])context[name]={};
  if(options.appendSource) {memory.resources.set("Observation/source",options.appendSource);context.buildAppendObservationTransaction=()=>({observation:options.result??body,provenance:{id:"append-audit"},bundle:{resourceType:"Bundle",type:"transaction",entry:[{resource:options.result??body,request:{method:"POST",url:"Observation"}}]}});}
  const server:Server=runInNewContext(ts.transpileModule(dispatchSource+"\ncreateServer();",{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,context);
  const client=new Client({name:"r10-a3-mcp-guard-proof",version:"1"});const [a,b]=InMemoryTransport.createLinkedPair();await server.connect(a);await client.connect(b);
  return {memory,denied,attempted,transactions,repairWritesBeforeTransaction,call:(name:string,args:Record<string,unknown>)=>client.callTool({name,arguments:args}),close:async()=>{await client.close();await server.close();}};
}
// Inject builder outputs to exercise the real dispatch write boundary, including fixed-shape specialty builders.
const generic = ["create_observation","scribe_write_observation","save_section_observations","create_smoking_status_observation","create_dry_eye_questionnaire_response","create_meibography_observation","record_ortho_k_fit_observation","record_eye_growth_axial_length_measurement"];
for(const tool of generic) for(const [shape,body] of [["canonical",canonicalFact()],["panel",panel()],["negative",negative()],["legacy-shared",snapshot()]] as const) {
  test(`W116 ${tool} refuses ${shape} before associated writes through MCP dispatch`,async()=>{
    const h=await harness(body);try {const result=await h.call(tool,{...input,patient_id:"p1",encounter_id:"e1",scribe_id:"synthetic",eye:"OD",content_type:"image/png",url:"https://example.test/synthetic",create_provenance:false});assert.equal(result.isError,true,JSON.stringify(result));assert.match(JSON.stringify(result),/Shared findings are charted in the finding doors/);assert.equal(h.attempted.length,0);assert.equal(h.transactions.length,0);assert.equal(h.memory.writes.length,0);} finally {await h.close();}
  });
}
for(const mode of ["target","result"] as const) test(`W116 append guards ${mode} through MCP dispatch`,async()=>{
 const unrelated={...canonicalFact("source"),identifier:undefined,component:[],code:{text:"Synthetic unrelated"},status:"final" as const};
 const h=await harness(canonicalFact(),{appendSource:mode==="target"?{...canonicalFact("source"),status:"final"}:unrelated,result:canonicalFact()});
 try {const result=await h.call("append_observation_context",{source_observation_id:"source",patient_id:"p1",encounter_id:"e1",intended_observation_type:"Synthetic",text:"Synthetic",clinician_id:"synthetic",signature_data_base64:"c3ludGhldGlj"});assert.equal(result.isError,true);assert.match(JSON.stringify(result),/Shared findings are charted in the finding doors/);assert.equal(h.attempted.length,0);}finally{await h.close();}
});
for(const tool of ["clinician_attest_observation","amend_observation"]) for(const kind of ["fact","panel"]) {
 test(`W115 ${tool} allows closed ${kind}, preserves identities and refuses pre-rebuild`,async()=>{
  for(const legacy of [false,true]) {
   const body=kind==="fact"?canonicalFact():panel();body.status=tool==="amend_observation"?"final":"preliminary";
   const h=await harness(body,{rows:legacy?[snapshot("legacy")]:[]});try {
    const args=tool==="amend_observation"?input:{observation_id:"canonical",clinician_id:"synthetic",signature_data_base64:"c3ludGhldGlj"};
    const result=await h.call(tool,args);
    if(legacy){assert.equal(result.isError,true,JSON.stringify(result));assert.match(JSON.stringify(result),/pre-rebuild/);assert.equal(h.attempted.length,0);}else{assert.equal(result.isError,undefined,JSON.stringify(result));const saved=h.memory.resources.get("Observation/canonical") as Observation;assert.equal(saved.status,tool==="amend_observation"?"amended":"final");assert.deepEqual(saved.identifier,body.identifier);assert.deepEqual(saved.component,body.component);assert.deepEqual(saved.extension,body.extension);assert.equal(h.transactions.length,1);}
   }finally{await h.close();}
  }
 });
}
test("W115 mismatching session practitioner refuses before audit repair or lifecycle writes",async()=>{
 const h=await harness({...canonicalFact(),status:"final"},{session:"someone-else"});try{const result=await h.call("amend_observation",input);assert.equal(result.isError,true);assert.match(JSON.stringify(result),/match/i);assert.equal(h.attempted.length,0);assert.equal(h.memory.writes.length,0);}finally{await h.close();}
});

for(const tool of generic) test(`W116 ${tool} retains unrelated Observation writes`,async()=>{
 const body={...canonicalFact(),identifier:undefined,component:[],code:{text:"Synthetic section-owned finding"}};
 const h=await harness(body);try{const result=await h.call(tool,{...input,patient_id:"p1",encounter_id:"e1",scribe_id:"synthetic",eye:"OD",content_type:"image/png",url:"https://example.test/synthetic",create_provenance:false});assert.equal(result.isError,undefined,JSON.stringify(result));assert.ok(h.attempted.some(r=>r.resourceType==="Observation"));
 if(tool==="create_dry_eye_questionnaire_response"||tool==="create_meibography_observation") {const dependency=tool==="create_meibography_observation"?"DocumentReference":"QuestionnaireResponse";const saved=[...h.memory.resources.values()].find(r=>r.resourceType===dependency)!;assert.deepEqual((h.memory.resources.get("Observation/canonical") as Observation).derivedFrom,[{reference:`${dependency}/${saved.id}`}]);}
 }finally{await h.close();}
});

test("W116 eye growth validates optional corneal Observation before axial writes",async()=>{
 const unrelated={...canonicalFact(),identifier:undefined,component:[],code:{text:"Synthetic axial"}};
 const h=await harness(unrelated,{result:canonicalFact("corneal")});try{const result=await h.call("record_eye_growth_axial_length_measurement",{patient_id:"p1",encounter_id:"e1",eye:"OD"});assert.equal(result.isError,true);assert.match(JSON.stringify(result),/Shared findings are charted/);assert.equal(h.attempted.length,0);}finally{await h.close();}
});

for(const tool of ["clinician_attest_observation","amend_observation"]) test(`W115 ${tool} rejects legacy targets even without other findings`,async()=>{
 const body=snapshot("canonical");body.status=tool==="amend_observation"?"final":"preliminary";
 const h=await harness(body);try{const result=await h.call(tool,tool==="amend_observation"?input:{observation_id:"canonical",clinician_id:"synthetic",signature_data_base64:"c3ludGhldGlj"});assert.equal(result.isError,true);assert.match(JSON.stringify(result),/legacy targets/);assert.equal(h.attempted.length,0);}finally{await h.close();}
});

for(const tool of ["clinician_attest_observation","amend_observation"]) for(const mismatch of [false,true]) test(`W115 ${tool} ${mismatch?"refuses mismatched audit":"repairs only selected debt before lifecycle"}`,async()=>{
 const memory=memoryFhir([encounter()]);
 for(const eye of ["OD","OS"] as const) {const target=factTarget();target.key.eye=eye;(target.baseline as any).key.eye=eye;const result=await executeFindingCommand(writerContext(memory),command([target]) as any);assert.equal(result.complete,true,JSON.stringify(result));}
 const facts=memory.all<Observation>("Observation");const target=facts.find(o=>o.extension?.some(e=>e.valueCodeableConcept?.coding?.some(c=>c.code==="OD")))!;
 assert.ok(target);target.status=tool==="amend_observation"?"final":"preliminary";memory.resources.set(`Observation/${target.id}`,target);
 for(const row of memory.all<any>("Provenance")) {
  if(mismatch && row.target.some((t:any)=>t.reference===`Observation/${target.id}`)){row.agent[0].who.reference="Practitioner/forged";memory.resources.set(`Provenance/${row.id}`,row);}
  else memory.resources.delete(`Provenance/${row.id}`);
 }
 memory.writes.length=0;
 const h=await harness(target,{memory});try{
 const args=tool==="amend_observation"?{...input,observation_id:target.id}:{observation_id:target.id,clinician_id:"synthetic",signature_data_base64:"c3ludGhldGlj"};
 const result=await h.call(tool,args);
 if(mismatch){assert.equal(result.isError,true,JSON.stringify(result));assert.match(JSON.stringify(result),/audit repair failed/);assert.equal(h.transactions.length,0);assert.equal(memory.writes.length,0);assert.equal(h.attempted.length,0);assert.equal(h.denied.length,1);assert.match(JSON.stringify(h.denied[0]),/audit repair failed/);}
 else {assert.equal(result.isError,undefined,JSON.stringify(result));assert.equal(memory.writes.length,1,"only selected debt is repaired");assert.equal(memory.writes[0].resource.resourceType,"Provenance");assert.ok((memory.writes[0].resource as any).target.some((t:any)=>t.reference===`Observation/${target.id}`));assert.equal(h.transactions.length,1);assert.deepEqual(h.repairWritesBeforeTransaction,[1]);const saved=memory.resources.get(`Observation/${target.id}`) as Observation;assert.deepEqual(saved.identifier,target.identifier);assert.deepEqual(saved.component,target.component);assert.deepEqual(saved.extension,target.extension);}
 }finally{await h.close();}
});

for(const tool of ['clinician_attest_observation','amend_observation','append_observation_context'])test(`W115 W116 F2 ${tool} session refusal is audited once`,async()=>{
 const body={...canonicalFact(),identifier:undefined,component:[],code:{text:'Synthetic unrelated'},status:'final' as const};
 const h=await harness(body,{session:'another-practitioner'});try{
 const args=tool==='amend_observation'?input:tool==='clinician_attest_observation'?{observation_id:'canonical',clinician_id:'synthetic',signature_data_base64:input.signature_data_base64}:{source_observation_id:'canonical',patient_id:'p1',encounter_id:'e1',intended_observation_type:'Synthetic',text:'Synthetic',clinician_id:'synthetic',signature_data_base64:input.signature_data_base64};
 const result=await h.call(tool,args);
 assert.equal(result.isError,true);assert.match(JSON.stringify(result),/match/i);assert.equal(h.attempted.length,0);assert.equal(h.memory.writes.length,0);assert.equal(h.denied.length,1);assert.match(JSON.stringify(h.denied[0]),/match/i);
 }finally{await h.close();}
});
for(const tool of ['clinician_attest_observation','amend_observation'])for(const kind of ['pre-rebuild','legacy'])test(`W115 F2 ${tool} ${kind} refusal is audited once`,async()=>{
 const body=kind==='legacy'?snapshot('canonical'):canonicalFact();body.status=tool==='amend_observation'?'final':'preliminary';
 const h=await harness(body,{rows:kind==='pre-rebuild'?[snapshot('legacy')]:[]});try{
 const result=await h.call(tool,tool==='amend_observation'?input:{observation_id:'canonical',clinician_id:'synthetic',signature_data_base64:input.signature_data_base64});assert.equal(result.isError,true);const reason=kind==='legacy'?/legacy targets/:/pre-rebuild/;assert.match(JSON.stringify(result),reason);assert.equal(h.attempted.length,0);assert.equal(h.memory.writes.length,0);assert.equal(h.denied.length,1);assert.match(JSON.stringify(h.denied[0]),reason);
 }finally{await h.close();}
});
for(const mode of ['target','result'] as const)test(`W116 F2 append ${mode} shared refusal is audited once`,async()=>{
 const unrelated={...canonicalFact('source'),identifier:undefined,component:[],code:{text:'Synthetic unrelated'},status:'final' as const};
 const h=await harness(canonicalFact(),{appendSource:mode==='target'?{...canonicalFact('source'),status:'final'}:unrelated,result:canonicalFact()});try{
 const result=await h.call('append_observation_context',{source_observation_id:'source',patient_id:'p1',encounter_id:'e1',intended_observation_type:'Synthetic',text:'Synthetic',clinician_id:'synthetic',signature_data_base64:'c3ludGhldGlj'});
 assert.equal(result.isError,true);assert.equal(h.attempted.length,0);assert.equal(h.memory.writes.length,0);assert.equal(h.denied.length,1);assert.match(JSON.stringify(h.denied[0]),/Shared findings are charted/);
 }finally{await h.close();}
});
