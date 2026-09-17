import { findingPanelIdentifier } from "../src/clinical-graph/current-finding-identity.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Condition, Observation } from "@medplum/fhirtypes";
import { materializeAtomicFindingCatalog } from "../src/clinical-graph/diagnosis-findings-endpoint.js";
import { currentFindingIdentifier, SUPPORTS_DIAGNOSIS_URL } from "../src/clinical-graph/current-finding-identity.js";
import { loadEncounterFindingState, projectCurrentFindings } from "../src/clinical-graph/current-finding-reader.js";
import { odosConcept } from "../src/fhir/ophthalmology/extensions.js";
import { definitions, catalog, nuclear, lens, lensField, atomic, snapshot, comp, negative, state } from "./fixtures/r10/factories.js";
const key = { v: 1 as const, patientId: "p1", encounterId: "e1", stableKey: lens.stableKey, fieldCode: lensField, optionCode: nuclear.optionCode, eye: "OD" as const };
const canonical = (status: Observation["status"] = "preliminary") => ({ ...atomic("canonical"), status, identifier: [currentFindingIdentifier(key)], component: [comp("R10_CURRENT_META", JSON.stringify(key))] });
const project = (obs: Observation[], extra = {}) => projectCurrentFindings(state(obs, extra));

test("canonical fact dominates legacy, including its retired clear marker", () => {
  const p = project([snapshot(), atomic(), canonical("entered-in-error")]);
  assert.equal(p.currentFacts.length, 1);
  assert.equal(p.currentFacts[0].status, "retired");
  assert.deepEqual(p.currentFacts[0].contributors.map(c => c.reference), ["Observation/canonical"]);
  assert.equal(p.definitionViews.flatMap(v => v.component ?? []).some(c => c.valueBoolean === true), false);
});
test("duplicate canonical owners conflict even when assertions agree", () => {
  const p = project([canonical(), { ...canonical(), id: "duplicate" }]);
  assert.equal(p.currentFacts.length, 0);
  assert.equal(p.conflicts.length, 1);
  assert.equal(p.conflicts[0].sources.length, 2);
});
test("retired legacy atomic cannot suppress a live section positive; cancelled is retained but never live", () => {
  for (const status of ["entered-in-error", "cancelled"] as const) {
    const retired = { ...atomic(), status };
    assert.equal(project([retired, snapshot()]).currentFacts[0].status, "live");
    assert.deepEqual(project([retired, snapshot()]).currentFacts[0].contributors.map(c => c.reference), ["Observation/snapshot"]);
    assert.equal(project([retired]).currentFacts[0].status, "retired");
  }
});
test("legacy OU expands to two facts, sharing its real source", () => {
  const p = project([atomic("both", "OU")]);
  assert.deepEqual(p.currentFacts.map(f => f.eye), ["OD", "OS"]);
  assert.deepEqual(p.currentFacts.map(f => f.contributors[0].reference), ["Observation/both", "Observation/both"]);
});
test("OD absent versus OU present conflicts only OD; agreeing overlap coalesces", () => {
  const p = project([atomic("both", "OU"), atomic("right", "OD", false)]);
  assert.deepEqual(p.conflicts.map(f => f.eye), ["OD"]);
  assert.deepEqual(p.currentFacts.map(f => f.eye), ["OS"]);
  assert.equal(project([atomic("both", "OU"), atomic("right")]).currentFacts.find(f => f.eye === "OD")?.contributors.length, 2);
  assert.equal(project([atomic(), atomic("other", "OD", false)]).conflicts.length, 1);
});
test("latest snapshot omission stays unanswered; older snapshot never revives it", () => {
  const later = { ...snapshot("latest", []), effectiveDateTime: "2026-09-15T13:00:00.000Z" };
  assert.equal(project([snapshot(), later]).currentFacts.length, 0);
  assert.equal(project([later, snapshot()]).currentFacts.length, 0);
});
test("equal-time different snapshots conflict independent of input order", () => {
  const pair = [snapshot(), snapshot("empty", [])];
  assert.equal(project(pair).conflicts.length, 1);
  assert.deepEqual(project(pair), project([...pair].reverse()));
});
test("atomic plus section agree only with equal typed qualifier maps", () => {
  const a = { ...atomic(), component: [comp("GRADE", "2+")] };
  const s = { ...snapshot(), component: [...snapshot().component!, comp(`OD_${lensField}::nuclear-sclerosis::grade`, "2+")] };
  assert.equal(project([a, s]).currentFacts[0].contributors.length, 2);
  assert.equal(project([atomic(), s]).conflicts.length, 1);
  assert.equal(project([atomic("a", "OD", false), snapshot()]).conflicts.length, 1);
  const withColour = { ...a, component: [...a.component, comp(`${lensField}::nuclear-sclerosis::colour`, "2+ (yellow/brown)")] };
  const s2 = { ...s, component: [...s.component, comp(`OD_${lensField}::nuclear-sclerosis::colour`, "2+ (yellow/brown)")] };
  assert.equal(project([withColour, s2]).conflicts.length, 0);
  assert.deepEqual(project([withColour, s2]), project([s2, { ...withColour, component: [...withColour.component].reverse() }]));
});
for (const shape of ["extension-only", "evidence-only", "both", "disagreeing"] as const) {
  test(`homes union: ${shape}`, () => {
    const o = atomic();
    if (shape !== "evidence-only") o.extension!.push({ url: SUPPORTS_DIAGNOSIS_URL, valueReference: { reference: "Condition/a" } });
    const home = shape === "disagreeing" ? "b" : "a";
    const conditions: Condition[] = shape === "extension-only" ? [] : [{ resourceType: "Condition", id: home, subject: o.subject!, encounter: o.encounter,
      evidence: [{ detail: [{ reference: "Observation/atomic" }, { reference: "Observation/atomic" }] }] }];
    assert.deepEqual(project([o], { conditions }).currentFacts[0].homes, shape === "disagreeing" ? ["Condition/a", "Condition/b"] : ["Condition/a"]);
  });
}
test("coalesced and conflicting sources union homes, canonical homes use only the canonical contributor", () => {
  const a = { ...atomic(), extension: [...atomic().extension!, { url: SUPPORTS_DIAGNOSIS_URL, valueReference: { reference: "Condition/a" } }] };
  const s = { ...snapshot(), extension: [...snapshot().extension!, { url: SUPPORTS_DIAGNOSIS_URL, valueReference: { reference: "Condition/b" } }] };
  assert.deepEqual(project([a,s]).currentFacts[0].homes, ["Condition/a","Condition/b"]);
  assert.deepEqual(project([{ ...a, valueBoolean: false },s]).conflicts[0].homes, ["Condition/a","Condition/b"]);
  assert.deepEqual(project([a,s,canonical()]).currentFacts[0].homes, []);
});
test("negative act remains raw and never wins latest snapshot", () => {
  const n = negative(); const p = project([snapshot(),n]);
  assert.equal(p.currentFacts.length, 0);
  assert.equal(p.panels[0].negativeActs[0].captureInput, "frozen-input");
  assert.deepEqual(p.panels[0].negativeActs[0].scope, JSON.parse(n.component![0].valueString!));
  assert.equal(p.panels[0].negativeActs[0].source.reference, "Observation/negative");
  assert.deepEqual(p.panels[0].negativeActs[0].identifier, n.identifier![0]);
});
test("UNKNOWN, invalid, missing definition and unknown options remain unresolved with real references", () => {
  const p = project([atomic("unknown", "UNKNOWN"), { ...canonical(), id: "invalid", identifier: [{system:"urn:odos:current-finding:v1", value:"wrong"}] },
    { ...atomic("missing"), code: odosConcept("ocular-health:anterior:missing::f::o") }, snapshot("unrecognized", ["unknown"])]);
  assert.deepEqual(p.unresolved.map(r => r.reference).sort(), ["Observation/invalid","Observation/missing","Observation/unknown","Observation/unrecognized"]);
  assert.equal(p.currentFacts.length, 0);
});
test("raw sources are immutable, a single untranslated view retains bytes and its actual id", () => {
  const s = snapshot(); const before = structuredClone(s); const p = project([s]);
  assert.deepEqual(s,before);
  assert.equal(p.definitionViews[0].id, s.id);
  assert.equal(JSON.stringify(p.definitionViews[0].component), JSON.stringify(s.component));
  assert.notEqual(p.definitionViews[0].projectionKey, s.id);
  assert.equal(project([s,atomic()]).definitionViews[0].id, undefined);
});
test("retired option translation retains typed replacement semantics without an aggregate id", () => {
  const p = project([snapshot("old", ["brunescent"])]);
  assert.equal(p.currentFacts[0].key.optionCode,"nuclear-sclerosis");
  assert.deepEqual(p.currentFacts[0].qualifiers,{colour:"4+ (dark brown/black; brunescent)"});
  assert.equal(p.definitionViews[0].id, undefined);
  assert.equal(p.definitionViews[0].component?.find(c => c.code.coding?.some(v => v.code === `OD_${lensField}::nuclear-sclerosis`))?.valueBoolean, true);
});
test("mixed carried/current contributors retain attribution and newest clinical date", () => {
  const s = { ...snapshot(), effectiveDateTime: "2026-09-15T13:00:00.000Z" };
  const f = project([atomic(),s], { observationCarried: {"Observation/atomic":true,"Observation/snapshot":false} }).currentFacts[0];
  assert.deepEqual(f.contributors.map(c => c.carried), [true,false]);
  assert.equal(f.effectiveDateTime, s.effectiveDateTime);
  assert.equal(project([atomic()]).currentFacts[0].contributors[0].carried, undefined);
});
test("loader traverses pages, retains retired and refuses failed, foreign or unscoped pages", async () => {
  const bundle = (rows: unknown[], next?:string) => ({resourceType:"Bundle", type:"searchset", entry:rows.map(resource=>({resource})), ...(next?{link:[{relation:"next",url:next}]}:{})});
  const fhir = { baseUrl:"http://localhost:8103/", search:async(type:string,params:Record<string,string>)=>{
    assert.equal(params.encounter,"Encounter/e1"); assert.equal(params.status,undefined);
    return type === "Condition" ? bundle([]) : bundle([atomic()],"/fhir/R4/Observation?_page=2");
  }, searchUrl:async()=>bundle([{...atomic("retired"),status:"cancelled"}]) };
  const args = {patientReference:"Patient/p1",encounterReference:"Encounter/e1",definitions,catalog};
  const loaded = await loadEncounterFindingState(fhir as any,args);
  assert.equal(loaded.incomplete,false);
  if (!loaded.incomplete) assert.equal(loaded.observations.length,2);
  for (const failure of [async()=>{throw new Error("page failed")},async()=>bundle([{...atomic(),subject:{reference:"Patient/other"}}])]) {
    const failed = await loadEncounterFindingState({...fhir,searchUrl:failure} as any,args);
    assert.equal(failed.incomplete,true); assert.throws(()=>projectCurrentFindings(failed),/incomplete/i);
  }
  const malformed = await loadEncounterFindingState({...fhir, search:async()=>({...bundle([]),link:[{relation:"next"}]})} as any,args);
  assert.equal(malformed.incomplete,true);
});

test("nested child selections are options, never mistaken for a parent's missing qualifier", () => {
  const parent = catalog.find(r=>r.optionCode==="anterior-blepharitis")!;
  const child = catalog.find(r=>r.optionCode==="anterior-blepharitis::ulcerative")!;
  const s = { ...snapshot(), code:odosConcept(parent.findingDefinitionKey), component:[comp(`OD_${parent.fieldCode}::${parent.optionCode}`,true),comp(`OD_${child.fieldCode}::${child.optionCode}`,true)] };
  const p=project([s]);
  assert.equal(p.currentFacts.length,2);
  assert.equal(p.definitionViews[0].id,s.id);
  assert.equal(JSON.stringify(p.definitionViews[0].component),JSON.stringify(s.component));
});
test("active option plus its retired subtype still requires a translated view", () => {
  const s=snapshot("combined",["nuclear-sclerosis","brunescent"]);
  const p=project([s]);
  assert.equal(p.currentFacts.length,1);
  assert.equal(p.definitionViews[0].id,undefined);
  assert.ok(p.definitionViews[0].component?.some(c=>c.code.coding?.some(v=>v.code===`OD_${lensField}::nuclear-sclerosis::colour`)));
  assert.ok(!p.definitionViews[0].component?.some(c=>c.code.coding?.some(v=>v.code?.endsWith("::brunescent"))));
});

test("inferred homes intersect eye sets and never replace explicit homes on a coalesced fact", async () => {
  const {buildEncounterDiagnosisCondition}=await import("../src/fhir/condition.js");
  const {DIAGNOSIS_KEY_IDENTIFIER_SYSTEM}=await import("../src/clinical-graph/diagnosis-pick-endpoint.js");
  const condition={...buildEncounterDiagnosisCondition({patientReference:"Patient/p1",encounterReference:"Encounter/e1",code:{text:"Synthetic"},verificationStatus:"confirmed",
    identifiers:[{system:DIAGNOSIS_KEY_IDENTIFIER_SYSTEM,value:`e1::${nuclear.diagnosisKeys[0]}::bilateral`}]}),id:"inferred"};
  assert.deepEqual(project([snapshot(),atomic()],{conditions:[condition]}).currentFacts[0].homes,["Condition/inferred"]);
  const explicit={...snapshot(),extension:[...snapshot().extension!,{url:SUPPORTS_DIAGNOSIS_URL,valueReference:{reference:"Condition/explicit"}}]};
  assert.deepEqual(project([explicit,atomic()],{conditions:[condition]}).currentFacts[0].homes,["Condition/explicit"]);
  const unknown={...condition,identifier:[]};
  assert.deepEqual(project([snapshot()],{conditions:[unknown]}).currentFacts[0].homes,[]);
});
test("panel context and negative acts cannot replace a laterally scoped positive snapshot", () => {
  const context={...snapshot("context",[]),effectiveDateTime:"2026-09-15T14:00:00.000Z",identifier:[findingPanelIdentifier({v:1,patientId:"p1",encounterId:"e1",stableKey:lens.stableKey,eye:"OD"})],
    component:[comp("R10_PANEL_META",JSON.stringify({v:1,patientId:"p1",encounterId:"e1",stableKey:lens.stableKey,eye:"OD"})),comp("EXAM_STATE","deferred"),comp("OTHER","No view"),comp("REMARKS","Synthetic remark")]};
  const p=project([context,snapshot(),negative()]);
  assert.equal(p.currentFacts.length,0);assert.equal(p.panels[0].deferred,true);
  assert.equal(p.panels[0].other,"No view");assert.equal(p.panels[0].remarks,"Synthetic remark");
});
test("typed qualifiers resolve the addressed field when a definition has multiple option fields", () => {
  const d=structuredClone(lens);const fields=d.valueSchema.fields as any;
  fields.CUSTOM_SECOND={...fields[lensField],localCode:"CUSTOM_SECOND",order:100};
  const c=materializeAtomicFindingCatalog([d]);const row=c.find(r=>r.fieldCode==="CUSTOM_SECOND"&&r.optionCode==="nuclear-sclerosis")!;
  const s={...snapshot("multi",[]),component:[comp("OD_CUSTOM_SECOND::nuclear-sclerosis",true),comp("OD_CUSTOM_SECOND::nuclear-sclerosis::grade","3+")]};
  const p=project([s],{definitions:[d],catalog:c});
  assert.deepEqual(p.currentFacts[0].qualifiers,{grade:"3+"});
});

test("canonical homes ignore Condition evidence, while legacy homeSources identify each asserting resource", () => {
  const o={...atomic(),extension:[...atomic().extension!,{url:SUPPORTS_DIAGNOSIS_URL,valueReference:{reference:"Condition/ext"}}]};
  const conditions:Condition[]=[{resourceType:"Condition",id:"ev",meta:{versionId:"c2"},subject:o.subject!,encounter:o.encounter,
    evidence:[{detail:[{reference:"Observation/atomic"}]}]}];
  const legacy=project([o],{conditions}).currentFacts[0];
  assert.deepEqual(legacy.homeSources,[
    {condition:"Condition/ev",sources:[{kind:"condition-evidence",contributor:{reference:"Condition/ev",versionId:"c2"}}]},
    {condition:"Condition/ext",sources:[{kind:"finding-extension",contributor:{reference:"Observation/atomic",versionId:"v1"}}]},
  ]);
  const canonicalFact=project([{...canonical(),extension:atomic().extension}],{conditions:[{...conditions[0],evidence:[{detail:[{reference:"Observation/canonical"}]}]}]}).currentFacts[0];
  assert.deepEqual(canonicalFact.homes,[]);
  assert.deepEqual(canonicalFact.homeSources,[]);
});
test("later scoped negative suppresses only older snapshot positives; equal-time scope conflicts", () => {
  const old=snapshot(); const n=negative();
  assert.equal(project([old,n]).currentFacts.length,0);
  assert.equal(project([old,{...n,effectiveDateTime:old.effectiveDateTime,component:[comp("NEGATIVE_ACT",JSON.stringify({...JSON.parse(n.component![0].valueString!),assertedAt:old.effectiveDateTime})),...n.component!.slice(1)]}]).conflicts.length,1);
  const excluded={...n,component:[comp("NEGATIVE_ACT",JSON.stringify({...JSON.parse(n.component![0].valueString!),optionCodes:["cortical-cataract"],exclusions:["nuclear-sclerosis"]})),...n.component!.slice(1)]};
  assert.equal(project([old,excluded]).currentFacts[0].presence,"present");
  assert.equal(project([old,n,atomic()]).currentFacts[0].contributors[0].reference,"Observation/atomic");
  assert.equal(project([old,n,canonical()]).currentFacts[0].contributors[0].reference,"Observation/canonical");
});
test("baselines select exact-eye unique live atomic, otherwise materialize or canonical", () => {
  const unique=project([atomic()]).currentFacts[0];
  assert.deepEqual(unique.baseline,{kind:"legacy",sourceReference:"Observation/atomic",versionId:"v1",key:unique.key,mode:"adopt"});
  const fromSnapshot=project([snapshot()]).currentFacts[0];
  assert.deepEqual(fromSnapshot.baseline,{kind:"legacy",sourceReference:"Observation/snapshot",versionId:"v1",key:fromSnapshot.key,mode:"materialize"});
  assert.equal(project([atomic("both","OU")]).currentFacts.every(f=>f.baseline?.kind==="legacy" && f.baseline.mode==="materialize"),true);
  assert.equal(project([atomic("one"),atomic("two")]).currentFacts[0].baseline,undefined);
  assert.deepEqual(project([canonical()]).currentFacts[0].baseline,{kind:"canonical",reference:"Observation/canonical",versionId:"v1"});
  assert.equal(project([{...atomic(),meta:undefined}]).currentFacts[0].baseline,undefined);
});
test("UNKNOWN legacy retirement requires a live version; retired UNKNOWN is visible but not actionable", () => {
  const live=project([atomic("unknown","UNKNOWN")]).unresolved[0];
  assert.equal(live.status,"live");
  assert.deepEqual(live.baseline,{kind:"legacy-retire",sourceReference:"Observation/unknown",versionId:"v1"});
  const retired=project([{...atomic("unknown","UNKNOWN"),status:"entered-in-error"}]).unresolved[0];
  assert.equal(retired.status,"retired");
  assert.equal(retired.baseline,undefined);
});
test("loader returns sanitized typed incomplete categories", async () => {
  const input={patientReference:"Patient/p1",encounterReference:"Encounter/e1",definitions,catalog};
  const bundle=(rows:unknown[])=>({resourceType:"Bundle",type:"searchset",entry:rows.map(resource=>({resource}))});
  const search=async(type:string)=>type==="Observation"?bundle([atomic()]):bundle([]);
  assert.deepEqual(await loadEncounterFindingState({baseUrl:"http://localhost:8103",search:async()=>{throw new Error("secret token abc")}} as any,input),
    {incomplete:true,kind:"upstream",reason:"Encounter search failed."});
  for (const [bad,kind] of [[{...atomic(),subject:{reference:"Patient/else"}},"foreign-or-unscoped"],[{...atomic(),encounter:undefined},"foreign-or-unscoped"]] as const) {
    const result=await loadEncounterFindingState({baseUrl:"http://localhost:8103",search:async(type:string)=>type==="Observation"?bundle([bad]):bundle([])} as any,input);
    assert.equal(result.incomplete,true);if(result.incomplete)assert.equal(result.kind,kind);
  }
  const missing=await loadEncounterFindingState({baseUrl:"http://localhost:8103",search:async(type:string)=>type==="Observation"?bundle([{...atomic(),id:undefined}]):bundle([])} as any,input);
  assert.equal(missing.incomplete,true);if(missing.incomplete)assert.equal(missing.kind,"upstream");
  const refused=await loadEncounterFindingState({baseUrl:"http://localhost:8103",search:async()=>({...bundle([]),link:[{relation:"next"}]})} as any,input);
  assert.equal(refused.incomplete,true);if(refused.incomplete)assert.equal(refused.kind,"upstream");
  assert.equal((await loadEncounterFindingState({baseUrl:"http://localhost:8103",search} as any,input)).incomplete,false);
});
test("audit lookup is opt-in and only current marked fact without matching audit is pending", async () => {
  const marked={...canonical(),component:[...canonical().component!,comp("R10_OPERATION",JSON.stringify({commandId:"command-1",target:"finding:key",digest:"digest-1",
    audit:{kind:"mutation",actor:"Practitioner/test",recorded:"2026-09-15T13:00:00.000Z",activity:"CREATE",targetReferences:["self"]}}))]};
  const input={patientReference:"Patient/p1",encounterReference:"Encounter/e1",definitions,catalog};
  let audits=0;const bundle=(rows:unknown[])=>({resourceType:"Bundle",type:"searchset",entry:rows.map(resource=>({resource}))});
  const fhir={baseUrl:"http://localhost:8103/",search:async(type:string)=>{if(type==="Provenance")audits++;return bundle(type==="Observation"?[marked]:[])} };
  const ordinary=await loadEncounterFindingState(fhir as any,input);
  assert.equal(audits,0);assert.equal(projectCurrentFindings(ordinary).currentFacts[0].auditPending,undefined);
  const audited=await loadEncounterFindingState(fhir as any,{...input,includeAuditState:true});
  assert.equal(audits,1);assert.equal(projectCurrentFindings(audited).currentFacts[0].auditPending,true);
  const bad={...marked,component:[...canonical().component!,comp("R10_OPERATION","bad-json")]};
  const failed=await loadEncounterFindingState({...fhir,search:async(type:string)=>bundle(type==="Observation"?[bad]:[])} as any,{...input,includeAuditState:true});
  assert.equal(failed.incomplete,true);if(failed.incomplete)assert.equal(failed.kind,"upstream");
});

test("W16 full, partial, excluded and equal-time negatives use Observation time and preserve unaffected options", () => {
  const positive = snapshot("two", ["nuclear-sclerosis", "cortical-cataract"]);
  const scope = JSON.parse(negative().component![0].valueString!);
  const act = (optionCodes: string[], exclusions: string[] = [], time = "2026-09-15T13:00:00.000Z"): Observation => ({
    ...negative(), effectiveDateTime: time,
    component: [comp("NEGATIVE_ACT", JSON.stringify({ ...scope, optionCodes, exclusions, assertedAt: "2026-09-14T12:00:00.000Z" }))],
  });
  assert.equal(project([positive, act(["nuclear-sclerosis", "cortical-cataract"])]).currentFacts.length, 0);
  const partial = project([positive, act(["nuclear-sclerosis"])]);
  assert.deepEqual(partial.currentFacts.map(f => f.key.optionCode), ["cortical-cataract"]);
  const excluded = project([positive, act(["nuclear-sclerosis"], ["cortical-cataract"])]);
  assert.deepEqual(excluded.currentFacts.map(f => f.key.optionCode), ["cortical-cataract"]);
  const equal = project([positive, act(["nuclear-sclerosis"], [], positive.effectiveDateTime)]);
  assert.deepEqual(equal.conflicts.map(f => f.key.optionCode), ["nuclear-sclerosis"]);
  assert.deepEqual(equal.currentFacts.map(f => f.key.optionCode), ["cortical-cataract"]);
  const retired = { ...act(["nuclear-sclerosis", "cortical-cataract"]), status: "entered-in-error" as const };
  assert.equal(project([positive, retired]).currentFacts.length, 2);
  const fallback = { ...act(["nuclear-sclerosis"]), effectiveDateTime: undefined, issued: "2026-09-15T13:00:00.000Z" };
  assert.deepEqual(project([positive, fallback]).currentFacts.map(f => f.key.optionCode), ["cortical-cataract"]);
});

test("typed incomplete maps transport refusal and missing status without upstream details", async () => {
  const input = { patientReference: "Patient/p1", encounterReference: "Encounter/e1", definitions, catalog };
  for (const [status, kind] of [[403, "refused"], [404, "missing"], [410, "missing"]]) {
    const result = await loadEncounterFindingState({ baseUrl: "http://localhost:8103/", search: async () => { throw Object.assign(new Error("private response"), { status }); } }, input);
    assert.equal(result.incomplete, true);
    if (result.incomplete) assert.equal(result.kind, kind);
    assert.ok(!JSON.stringify(result).includes("private response"));
  }
});

test("review regression: resource search details cannot masquerade as audit lookup failures", async () => {
  const input={patientReference:"Patient/p1",encounterReference:"Encounter/e1",definitions,catalog,includeAuditState:true};
  const empty={resourceType:"Bundle",type:"searchset",entry:[]};
  for(const type of ["Observation","Condition"]) for(const [status,kind] of [[404,"missing"],[503,"upstream"]] as const) {
    const fhir={baseUrl:"http://localhost:8103/",search:async(resourceType:string)=>{
      if(resourceType===type)throw Object.assign(new Error("private audit subsystem detail"),{status});
      return empty;
    }};
    const result=await loadEncounterFindingState(fhir as any,input);
    assert.equal(result.incomplete,true);
    if(result.incomplete)assert.equal(result.kind,kind);
    assert.ok(!JSON.stringify(result).includes("private audit subsystem detail"));
  }
  const marked={...canonical(),component:[...canonical().component!,comp("R10_OPERATION",JSON.stringify({commandId:"command-1",target:"finding:key",digest:"digest-1",
    audit:{kind:"mutation",actor:"Practitioner/test",recorded:"2026-09-15T13:00:00.000Z",activity:"CREATE",targetReferences:["self"]}}))]};
  const failed=await loadEncounterFindingState({baseUrl:"http://localhost:8103/",search:async(type:string)=>{
    if(type==="Provenance")throw new Error("transport disconnected");
    return {...empty,entry:type==="Observation"?[{resource:marked}]:[]};
  }} as any,input);
  assert.deepEqual(failed,{incomplete:true,kind:"upstream",reason:"Finding audit state could not be verified."});
});

test("preRebuild includes retired legacy, snapshots, unresolved and invalid findings", () => {
  for (const observation of [atomic(), { ...atomic(), status: "entered-in-error" as const }, snapshot(),
    atomic("unknown", "UNKNOWN"), { ...canonical(), identifier: [] }]) {
    assert.equal(project([canonical(), observation]).preRebuild, true);
  }
  assert.equal(project([]).preRebuild, false);
  assert.equal(project([canonical()]).preRebuild, false);
  assert.equal(project([negative()]).preRebuild, false);
});
