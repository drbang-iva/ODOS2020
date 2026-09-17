import assert from "node:assert/strict";
import { test, before, after } from "node:test";
import React from "react";
// The release checker runs from the repository root, whose TSX loader uses classic JSX.
const previousReact = (globalThis as any).React;
before(() => { (globalThis as any).React = React; });
after(() => { (globalThis as any).React = previousReact; });
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { OcularHealthSection } from "../src/components/charting/OcularHealthSection";
import { DiagnosisPicker } from "../src/components/charting/DiagnosisPicker";
import { AssessmentSection } from "../src/components/charting/AssessmentSection";
import { RoleProvider } from "../src/lib/role-context";
import { FHIR_CONDITION_CATEGORY_CODE_SYSTEM, FHIR_CONDITION_CLINICAL_STATUS_CODE_SYSTEM, FHIR_CONDITION_VERIFICATION_STATUS_CODE_SYSTEM } from "../src/lib/fhir-clinical/condition";
import { DIAGNOSIS_KEY_IDENTIFIER_SYSTEM } from "../src/lib/clinical-actions";

const stableKey = "ocular-health:anterior:lens";
const definition = {
  id: "synthetic-lens", stableKey, display: "Synthetic lens", active: true, perEye: true,
  normalTemplate: "Synthetic normal lens", customFields: [{ localCode: "CUSTOM_ABNORMAL", display: "Findings", valueType: "multi-select" as const,
    options: [{ code: "opacity", display: "Synthetic opacity", active: true }], order: 0, active: true }],
};
const key = (eye: "OD" | "OS") => ({ v: 1 as const, patientId: "p1", encounterId: "e1", stableKey, fieldCode: "CUSTOM_ABNORMAL", optionCode: "opacity", eye });
const support = (eye: "OD" | "OS") => ({ rowKey: `lens:${eye}`, key: key(eye), baseline: { kind: "canonical" as const, reference: `Observation/fact-${eye}`, versionId: "2" } });
const finding = (eye: "OD" | "OS", homes: string[]) => ({
  atomicFindingId: `${stableKey}::CUSTOM_ABNORMAL::opacity`, findingDefinitionId: definition.id, findingDefinitionKey: stableKey,
  fieldCode: "CUSTOM_ABNORMAL", optionCode: "opacity", display: "Synthetic opacity", sectionKey: "lens", gradeScale: [], diagnosisKeys: ["synthetic-diagnosis"], origin: "custom",
  ...support(eye), kind: "fact", eye, laterality: eye, status: "live", presence: "present", qualifiers: {}, editable: true, homes,
  homeSources: homes.map(condition => ({ condition, sources: [{ kind: "finding-extension", contributor: { reference: `Observation/fact-${eye}`, versionId: "2" } }] })),
  contributors: [{ reference: `Observation/fact-${eye}`, versionId: "2", kind: "canonical-fact" }],
});
function condition() {
  return { resourceType: "Condition", id: "c1", meta: { versionId: "1" }, subject: { reference: "Patient/p1" }, encounter: { reference: "Encounter/e1" },
    identifier: [{ system: DIAGNOSIS_KEY_IDENTIFIER_SYSTEM, value: "Encounter/e1::synthetic-diagnosis::OD" }],
    category: [{ coding: [{ system: FHIR_CONDITION_CATEGORY_CODE_SYSTEM, code: "encounter-diagnosis" }] }], code: { text: "Synthetic diagnosis" },
    verificationStatus: { coding: [{ system: FHIR_CONDITION_VERIFICATION_STATUS_CODE_SYSTEM, code: "provisional" }] }, clinicalStatus: { coding: [{ system: FHIR_CONDITION_CLINICAL_STATUS_CODE_SYSTEM, code: "active" }] } };
}
function candidate(eye: "OD" | "OS") {
  return { findingInstanceId: `definition:${stableKey}:${eye}`, findingDefinitionKey: stableKey,
    contributors: [{ reference: `Observation/fact-${eye}`, versionId: "2", kind: "canonical-fact" }],
    candidates: [{ diagnosisKey: "synthetic-diagnosis", display: `Synthetic diagnosis ${eye}`, codingStatus: "provisional", priority: true, source: "mapping", supportingFacts: [support(eye)] }] };
}
const flush = () => new Promise(resolve => setTimeout(resolve,0));
async function withTransport(run: (requests: Array<{url:string;method:string;body:any}>) => Promise<void>, options: { historyReference?: boolean; twoCandidates?: boolean; proposed?: boolean } = {}) {
  const originalFetch=globalThis.fetch, originalWindow=globalThis.window;
  const requests: Array<{url:string;method:string;body:any}>=[];
  Object.defineProperty(globalThis,"window",{configurable:true,value:new EventTarget()});
  const rows=[finding("OD",["Condition/c1"]),finding("OS",[])];
  globalThis.fetch=async(input,init)=>{
    const url=String(input),method=init?.method ?? "GET",body=init?.body ? JSON.parse(String(init.body)) : undefined;
    requests.push({url,method,body});
    if(url.includes("/custom/") && url.includes("/history")) return Response.json({rows:[], eyes:Object.fromEntries(["OD","OS"].map(eye=>[eye,{encounterEditable:true,facts:rows.filter(row=>row.eye===eye),negativeActs:[],panel:{editable:true,deferred:false,values:{},baseline:{kind:"absent",key:{v:1,patientId:"p1",encounterId:"e1",stableKey,eye}}}}]))});
    if(url.includes("diagnosis-candidates")) return Response.json({findings:[{...candidate("OD"),...(options.historyReference ? {observationReference:"Observation/fact-OD"} : {})},...(options.twoCandidates ? [candidate("OS")] : [])]});
    if(url.includes("diagnosis-catalog")) return Response.json({canWrite:true,canWriteDiagnosis:true,diagnoses:[]});
    if(url.includes("/findings")) return Response.json(method === "GET" ? {encounterEditable:true,canWrite:true,canWriteDiagnosis:true,findings:rows,searchIndex:rows,catalog:[],unassigned:[rows[1]],bySection:{lens:rows},auditDebt:[],visitDiagnoses:options.proposed ? [{conditionReference:"Condition/c1",diagnosisKey:"synthetic-diagnosis",display:"Synthetic diagnosis",laterality:"OD"}] : []} : {result:"command",commandId:body.commandId,complete:true,executionOrder:[0],outcomes:[{status:"applied",target:"lens:OD",clinicalWrite:"confirmed"}]});
    if(url.includes("diagnosis-picks")) return Response.json({result:"pick",conditionStep:"applied",link:"pending",condition:condition()});
    if(url.includes("/fhir/R4/BodyStructure")) return Response.json({resourceType:"Bundle",entry:[{resource:{resourceType:"BodyStructure",id:"eye",patient:{reference:"Patient/p1"}}}]});
    if(url.includes("/fhir/R4/Provenance")) return Response.json({resourceType:"Provenance",id:"audit"});
    if(url.includes("/fhir/R4/Condition")) return Response.json(url.includes("?") ? {resourceType:"Bundle",type:"searchset",entry:options.proposed ? [{resource:condition()}] : []} : condition());
    if(url.includes("/fhir/R4/Encounter/")) return Response.json({resourceType:"Encounter",id:"e1",status:"in-progress",class:{code:"AMB"},subject:{reference:"Patient/p1"},diagnosis:[{condition:{reference:"Condition/c1"},rank:1}]});
    if(url.includes("diagnosis-statuses")) return Response.json({statuses:[]});
    if(url.includes("diagnosis-newness")) return Response.json({rows:[]});
    if(url.includes("procedure-charges")) return Response.json({options:[],diagnoses:[],proposals:[],attachedProcedures:[]});
    if(url.includes("protocols/applications")) return Response.json({applications:[]});
    if(url.includes("protocol")) return Response.json({protocols:[],offers:[],applications:[]});
    throw new Error(`Unexpected A3 test request: ${method} ${url}`);
  };
  try { await run(requests); }
  finally { globalThis.fetch=originalFetch;Object.defineProperty(globalThis,"window",{configurable:true,value:originalWindow}); }
}
async function ocular():Promise<ReactTestRenderer> {
  let renderer!:ReactTestRenderer;
  await act(async()=>{renderer=create(React.createElement(OcularHealthSection,{definitions:[definition],patientReference:"Patient/p1",encounterReference:"Encounter/e1",onSaved:()=>undefined}));await flush();});
  return renderer;
}

test("T15 Ocular Health picker accepts a canonical view without one observation id", async () => {
  await withTransport(async()=>{
    const renderer=await ocular();
    try { assert.equal(renderer.root.findAllByProps({"aria-label":"Propose Synthetic diagnosis OD"}).length,1,"The rendered Ocular Health section must offer canonical-view suggestions without an Observation id"); }
    finally {act(()=>renderer.unmount());}
  });
});

test("T16 DiagnosisPicker proposal evidence resolves through finding homes", async () => {
  await withTransport(async()=>{
    let renderer!:ReactTestRenderer;
    try {
      await act(async()=>{renderer=create(React.createElement(DiagnosisPicker,{encounterReference:"Encounter/e1",findingDefinitionKey:stableKey,mode:"proposal",linkMode:"facts"}));await flush();});
      const linked=renderer.root.findAllByProps({"aria-label":"Retract proposed Synthetic diagnosis OD"});
      assert.equal(linked.length,1,"OD is linked through the canonical finding home without Condition.evidence");
      assert.equal(renderer.root.findAllByProps({"aria-label":"Propose Synthetic diagnosis OS"}).length,1,"An unrelated OS fact must remain unproposed despite sharing the diagnosis catalog key");
    } finally {act(()=>renderer?.unmount());}
  },{twoCandidates:true,proposed:true});
});

test("T17 Ocular Health picks link fact targets", async () => {
  await withTransport(async(requests)=>{
    const renderer=await ocular();
    try {
      const choices=renderer.root.findAllByProps({"aria-label":"Propose Synthetic diagnosis OD"});
      assert.equal(choices.length,1,"Canonical Ocular Health candidates must remain actionable through the section's picker");
      await act(async()=>{await choices[0].props.onClick();await flush();});
      const pick=requests.find(request=>request.url.includes("diagnosis-picks"));
      assert.ok(pick,"A proposal performs the Condition step");
      assert.deepEqual(pick.body.supportingFacts,[{key:key("OD"),baseline:support("OD").baseline}]);
      const link=requests.find(request=>request.url.includes("/findings") && request.method === "PUT");
      assert.ok(link,"The Ocular Health pick must link its canonical fact after the Condition step");
      assert.equal(link.body.operation,"link");assert.equal(link.body.commandId,pick.body.commandId);
      assert.deepEqual(link.body.targets[0].key,key("OD"));assert.deepEqual(link.body.targets[0].state.homes,["Condition/c1"]);
    } finally {act(()=>renderer.unmount());}
  },{historyReference:true});
});

test("T18 Assessment origin uses finding home sources", async () => {
  await withTransport(async()=>{
    let renderer!:ReactTestRenderer;
    try {
      await act(async()=>{renderer=create(React.createElement(RoleProvider,{initialRole:"provider"},React.createElement(AssessmentSection,{patientReference:"Patient/p1",encounterReference:"Encounter/e1",onSaved:()=>undefined})));await flush();});
      const text=(node:any):string=>typeof node === "string" ? node : (Array.isArray(node) ? node : node?.children ?? []).map(text).join("");
      const rendered=text(renderer.toJSON());
      assert.match(rendered,/Synthetic diagnosis/,"Assessment must load the synthetic encounter diagnosis");
      assert.match(rendered,/← from .*Synthetic opacity/,"Assessment must display canonical origin from finding homeSources even when Condition.evidence is absent");
    } finally {act(()=>renderer?.unmount());}
  },{proposed:true});
});

import { memoryFhir, canonicalFact } from "../../mcp/tests/fixtures/r10/writer-harness";
import { buildFindingDefinitionSeeds } from "../../mcp/src/clinical-graph/finding-definition-store";
import { customFieldEntries } from "../../mcp/src/clinical-graph/custom-fields";
import { handleCustomSectionCaptureRequest, handleCustomSectionHistoryRequest } from "../../mcp/src/clinical-graph/custom-section-endpoint";

async function canonicalEditor(initial: any[] = [], status = "in-progress") {
  const definitions = buildFindingDefinitionSeeds();
  const source = definitions.find(row => row.stableKey === stableKey)!;
  const view = { ...source, perEye: true, customFields: customFieldEntries(source, true), allowDeferred: true };
  const memory = memoryFhir([{resourceType:"Encounter",id:"e1",status,class:{code:"synthetic"},subject:{reference:"Patient/p1"}}, ...initial] as any);
  const deps = {findingDefinitions:()=>definitions,authenticate:async()=>({staffReference:"Practitioner/synthetic",actorRole:"provider" as const,fhir:{...memory.fhir,create:async(resource:any,headers:any)=>(await memory.fhir.createWithOutcome(resource,headers)).resource}})};
  const requests: any[] = [];
  const transport: typeof fetch = async(input,init)=>{
    const url = new URL(String(input));
    if(init?.method === "POST") {
      const body = JSON.parse(String(init.body));requests.push(body);
      const result = await handleCustomSectionCaptureRequest(deps,{params:{stableKey},body,authHeader:undefined});
      return Response.json(result.body,{status:result.status});
    }
    const result = await handleCustomSectionHistoryRequest(deps,{params:{stableKey},query:Object.fromEntries(url.searchParams),authHeader:undefined});
    return Response.json(result.body,{status:result.status});
  };
  const originalFetch = globalThis.fetch, originalWindow = globalThis.window;
  Object.defineProperty(globalThis,"window",{configurable:true,value:new EventTarget()});
  globalThis.fetch=async input=>Response.json(String(input).includes("diagnosis-candidates")?{findings:[]}:String(input).includes("/findings")?{encounterEditable:true,canWrite:true,canWriteDiagnosis:true,findings:[],searchIndex:[],visitDiagnoses:[]}:{diagnoses:[],resourceType:"Bundle",entry:[]});
  let renderer!:ReactTestRenderer;
  await act(async()=>{renderer=create(React.createElement(OcularHealthSection,{definitions:[view],patientReference:"Patient/p1",encounterReference:"Encounter/e1",onSaved:()=>undefined,apiBase:"http://synthetic",fetchImpl:transport}));await flush();});
  const panel=(eye="OD")=>renderer.root.findByProps({"data-eye-panel":eye});
  const button=(label:string,eye?:string)=>(eye?panel(eye):renderer.root).findAllByType("button").find(node=>node.children.flat(Infinity).join("")===label);
  return {memory,renderer,requests,panel,button,save:async()=>{await act(async()=>{await button("Save Ocular Health")!.props.onClick();await flush();});},close:()=>{act(()=>renderer.unmount());globalThis.fetch=originalFetch;Object.defineProperty(globalThis,"window",{configurable:true,value:originalWindow});}};
}

test("T4 Ocular Health hydrates current canonical facts and leaves cleared facts unchecked",async()=>{
  const live=canonicalFact("live","OD"),cleared={...canonicalFact("cleared","OS"),status:"entered-in-error"};
  const h=await canonicalEditor([live,cleared]);
  try {
    const selected=(eye:string)=>h.panel(eye).findAllByProps({"aria-pressed":true}).map(node=>node.children.join(""));
    assert.ok(selected("OD").some(label=>label.includes("Nuclear")));
    assert.equal(selected("OS").some(label=>label.includes("Nuclear")),false);
    assert.equal(h.memory.writes.length,0);
  }finally{h.close();}
});

test("T5 Ocular Health deselection writes the loaded canonical owner and preserves the other eye",async()=>{
  const h=await canonicalEditor([canonicalFact("od","OD"),canonicalFact("os","OS")]);
  try {
    const before=structuredClone(h.memory.resources.get("Observation/os"));
    const selected=h.panel().findAllByType("button").find(node=>node.props["aria-pressed"]===true && node.children.join("").includes("Nuclear"));
    assert.ok(selected);await act(async()=>selected.props.onClick());await h.save();
    assert.equal(h.requests[0].eyes.OD.loaded.length,1);assert.deepEqual(h.requests[0].eyes.OD.selected,[]);
    assert.equal((h.memory.resources.get("Observation/od") as any).status,"entered-in-error");
    assert.deepEqual(h.memory.resources.get("Observation/os"),before);
  }finally{h.close();}
});

test("T6 Ocular Health All Normal skips an eye with a canonical positive",async()=>{
  const h=await canonicalEditor([canonicalFact("od","OD")]);
  try {
    const before=structuredClone(h.memory.resources.get("Observation/od"));
    await act(async()=>h.button("Anterior All Normal")!.props.onClick());await h.save();
    assert.equal(h.requests[0].eyes.OD,undefined,"V22 supersedes the old retirement expectation: a touched eye is preserved");
    assert.ok(h.requests[0].eyes.OS.negativeAct.scope.length);
    assert.deepEqual(h.memory.resources.get("Observation/od"),before);
  }finally{h.close();}
});

test("T21 pre-rebuild Ocular Health is labelled and has no save control",async()=>{
  const legacy={...canonicalFact("legacy"),identifier:undefined,component:[],code:{coding:[{code:stableKey}]}};
  const h=await canonicalEditor([legacy]);
  try {
    assert.match(JSON.stringify(h.renderer.toJSON()),/Test data from before the rebuild/);
    assert.equal(h.button("Save Ocular Health"),undefined);assert.equal(h.memory.writes.length,0);
  }finally{h.close();}
});

test("T22 Ocular Health UI writes only canonical fact and panel identities",async()=>{
  const h=await canonicalEditor();
  try {
    const offered=h.panel().findAllByType("button").find(node=>node.props["aria-pressed"]===false && node.children.join("").includes("Nuclear"));
    assert.ok(offered);await act(async()=>offered.props.onClick());await h.save();
    const observations=h.memory.all("Observation");assert.ok(observations.length>0);
    for(const observation of observations) assert.ok(observation.identifier?.some(id=>["urn:odos:current-finding:v1","urn:odos:finding-panel:v1"].includes(id.system??"")),JSON.stringify(observation.identifier));
    assert.equal(h.requests[0].eyes.OD.selected.length,1);assert.equal("customFields" in h.requests[0].eyes.OD,false);
  }finally{h.close();}
});
