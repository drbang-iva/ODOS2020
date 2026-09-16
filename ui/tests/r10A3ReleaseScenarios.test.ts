import assert from "node:assert/strict";
import { test } from "node:test";
import React from "react";
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
  return { resourceType: "Condition", id: "c1", subject: { reference: "Patient/p1" }, encounter: { reference: "Encounter/e1" },
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
    if(url.includes("/custom/") && url.includes("/history")) return Response.json({rows:[{eye:"OD",state:"abnormal",values:[{code:"CUSTOM_ABNORMAL",value:["opacity"]}],...(options.historyReference ? {observationReference:"Observation/fact-OD"} : {}),projectionKey:`definition:${stableKey}:OD`,contributors:rows[0].contributors}]});
    if(url.includes("diagnosis-candidates")) return Response.json({findings:[{...candidate("OD"),...(options.historyReference ? {observationReference:"Observation/fact-OD"} : {})},...(options.twoCandidates ? [candidate("OS")] : [])]});
    if(url.includes("diagnosis-catalog")) return Response.json({canWrite:true,canWriteDiagnosis:true,diagnoses:[]});
    if(url.includes("/findings")) return Response.json(method === "GET" ? {encounterEditable:true,canWrite:true,canWriteDiagnosis:true,findings:rows,searchIndex:rows,catalog:[],unassigned:[rows[1]],bySection:{lens:rows},auditDebt:[],visitDiagnoses:[{conditionReference:"Condition/c1",diagnosisKey:"synthetic-diagnosis",display:"Synthetic diagnosis",laterality:"OD"}]} : {result:"command",commandId:body.commandId,complete:true,executionOrder:[0],outcomes:[{status:"applied",target:"lens:OD",clinicalWrite:"confirmed"}]});
    if(url.includes("diagnosis-picks")) return Response.json({result:"pick",conditionStep:"applied",link:"pending",condition:condition()});
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

test("T15 Ocular Health picker accepts a canonical view without one observation id", { todo: "R10 A3" }, async () => {
  await withTransport(async()=>{
    const renderer=await ocular();
    try { assert.equal(renderer.root.findAllByProps({"aria-label":"Propose Synthetic diagnosis OD"}).length,1,"The rendered Ocular Health section must offer canonical-view suggestions without an Observation id"); }
    finally {act(()=>renderer.unmount());}
  });
});

test("T16 DiagnosisPicker proposal evidence resolves through finding homes", { todo: "R10 A3" }, async () => {
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

test("T17 Ocular Health picks link fact targets", { todo: "R10 A3" }, async () => {
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

test("T18 Assessment origin uses finding home sources", { todo: "R10 A3" }, async () => {
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
