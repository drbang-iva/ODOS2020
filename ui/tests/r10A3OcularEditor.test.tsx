import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { OcularHealthSection } from "../src/components/charting/OcularHealthSection";
import { handleFindingOutcome } from "../src/lib/diagnosis-findings";
import { OdosSelect } from "../src/components/inputs/OdosSelect";
import type { CustomFindingDefinition } from "../src/components/charting/CustomFindingSection";
Object.assign(globalThis, { window: new EventTarget() });
const stableKey = "ocular-health:anterior:cornea";
const definition: CustomFindingDefinition = { stableKey, display:"Cornea", active:true, perEye:true, allowDeferred:true, customFields:[{localCode:"F", display:"Findings", valueType:"multi-select", active:true, order:0, options:[{code:"scar",display:"Scar",active:true,priority:true},{code:"staining",display:"Staining",active:true,priority:true}]},{localCode:"TBUT",display:"TBUT",valueType:"number",active:true,order:1},{localCode:"SELECT",display:"Select value",valueType:"select",active:true,order:2,options:[{code:"a",display:"A",active:true},{code:"b",display:"B",active:true}]}] };
const key = (eye:string, optionCode:string) => ({v:1,patientId:"p",encounterId:"e",stableKey,fieldCode:"F",optionCode,eye});
const fact = (eye:string, optionCode:string, presence="present", editable=true) => ({rowKey:optionCode,key:key(eye,optionCode),kind:"fact",status:"live",presence,qualifiers:{},homes:[],editable,baseline:{kind:"canonical",reference:`Observation/${eye}-${optionCode}`,versionId:"1"},...(!editable?{readOnlyReason:"signed-or-cancelled"}:{})});
const history = (facts:any[] = [], reason?:string) => ({encounterReference:"Encounter/e",recordedAt:"2026-09-17",eyes:Object.fromEntries(["OD","OS"].map(eye=>[eye,{encounterEditable:!reason,readOnlyReason:reason,facts:facts.filter(f=>f.key.eye===eye),panel:{deferred:false,values:{},editable:true,baseline:{kind:"absent",key:{v:1,patientId:"p",encounterId:"e",stableKey,eye}}},negativeActs:[]}]))});
function text(n:ReactTestInstance|string):string { return typeof n==="string"?n:n.children.map(text).join(""); }
async function mount(current:any, replies:Array<{status:number;body:any}>=[], unscopedCount=0) {
 const posts:string[]=[]; let reads=0; let saved=0; let renderer!:ReactTestRenderer;
 const fetchImpl=(async(input,init)=>{
   if(init?.method==="POST") {
     posts.push(String(init.body));
     const r=replies.shift()??{status:200,body:{result:"command",complete:true,executionOrder:[],outcomes:[]}};
     if(r.body.complete) {
       for(const [eye,save] of Object.entries(JSON.parse(String(init.body)).eyes) as Array<[string,any]>) {
         if(save.panel) current.eyes[eye].panel={...current.eyes[eye].panel,...save.panel.state};
       }
     }
     return Response.json(r.body,{status:r.status});
   }
   reads++;
   return Response.json(String(input).includes("encounter=")?current:{rows:[],encounters:[],unscopedCount});
 }) as typeof fetch;
 await act(async()=>{renderer=create(<OcularHealthSection definitions={[definition]} patientReference="Patient/p" encounterReference="Encounter/e" encounterRecordedAt="2026-09-17" onSaved={()=>{saved++;}} fetchImpl={fetchImpl}/>);});
 const panel=(eye="OD")=>renderer.root.findByProps({"data-eye-panel":eye});
 const button=(label:string,eye?:string)=>(eye?panel(eye):renderer.root).findAllByType("button").find(n=>text(n)===label)!;
 const remarks=async(value:string,eye="OD")=>{await act(async()=>panel(eye).findByProps({"aria-label":`${eye} Remarks`}).props.onChange({target:{value}}));};
 const save=async()=>{await act(async()=>button("Save Ocular Health").props.onClick());};
 return {renderer,posts,panel,button,remarks,save,setCurrent:(value:any)=>{current=value;},setUnscopedCount:(value:number)=>{unscopedCount=value;},reads:()=>reads,saved:()=>saved,close:()=>act(()=>renderer.unmount())};
}
test("W130/W147 signed present witness is checked and locked; absent is outside loaded",async()=>{const h=await mount(history([fact("OD","scar","present",false),fact("OD","staining","absent")]));try{assert.equal(h.button("Scar","OD").props["aria-pressed"],true);assert.equal(h.button("Scar","OD").props.disabled,true);await h.remarks("Reviewed");await h.save();const e=JSON.parse(h.posts[0]!).eyes.OD;assert.deepEqual(e.loaded.map((f:any)=>f.key.optionCode),["scar"]);assert.deepEqual(e.selected,e.loaded);assert.equal(e.panel.state.remarks,"Reviewed");}finally{h.close();}});
test("W137 recorded absent requires explicit selection and fromPresence",async()=>{const h=await mount(history([fact("OD","staining","absent")]));try{assert.match(text(h.panel()),/Recorded absent/);await act(async()=>h.button("Staining · Recorded absent","OD").props.onClick());await h.save();const e=JSON.parse(h.posts[0]!).eyes.OD;assert.deepEqual(e.loaded,[]);assert.equal(e.selected[0].fromPresence,"absent");}finally{h.close();}});
test("W131 unconfirmed Retry resends byte-identical request",async()=>{const h=await mount(history(),[{status:502,body:{result:"command",complete:false,executionOrder:[0],outcomes:[{target:"panel",status:"unconfirmed",clinicalWrite:"unknown"}]}}]);try{await h.remarks("Pending");await h.save();await act(async()=>h.button("Retry").props.onClick());assert.equal(h.posts.length,2);assert.equal(h.posts[0],h.posts[1]);}finally{h.close();}});
test("W132 stale reload keeps choice and next save uses new command",async()=>{const h=await mount(history([fact("OD","scar"),fact("OD","staining","absent")]),[{status:409,body:{result:"command",complete:false,executionOrder:[0],outcomes:[{target:"panel",status:"conflict",reason:"stale-baseline",clinicalWrite:"none"}]}}]);try{await h.remarks("Keep this");await act(async()=>h.button("Staining · Recorded absent","OD").props.onClick()); const fresh=history([fact("OD","scar"),fact("OD","staining","absent")]); fresh.eyes.OD.facts[1].baseline.versionId="2"; h.setCurrent(fresh);await h.save();assert.equal(h.panel().findByProps({"aria-label":"OD Remarks"}).props.value,"Keep this");await h.save();assert.notEqual(JSON.parse(h.posts[0]!).commandId,JSON.parse(h.posts[1]!).commandId);assert.ok(h.reads()>2);assert.equal(JSON.parse(h.posts[1]!).eyes.OD.selected.find((f:any)=>f.key.optionCode==="staining").baseline.versionId,"2");}finally{h.close();}});
test("W133 negative outcome shows causal message and is never saved",async()=>{const r=await handleFindingOutcome({status:409,body:{result:"command",commandId:"c",complete:false,executionOrder:[0],outcomes:[{target:"negative:OD",status:"conflict",clinicalWrite:"none",reason:"positive-in-negative-scope"}]}},{encounterReference:"Encounter/e",refresh:()=>{}});assert.match(r.message??"",/positive-in-negative-scope/);});
for(const reason of ["encounter-closed","pre-rebuild-test-encounter"])test(`W134 ${reason} read only`,async()=>{const h=await mount(history([],reason));try{assert.match(text(h.renderer.root),reason==="encounter-closed"?/Signed or closed visit/:/Test data from before the rebuild/);assert.equal(h.button("Save Ocular Health"),undefined);}finally{h.close();}});
test("W138 Deferred disables selections without deselection and toggles preserve them",async()=>{const h=await mount(history([fact("OD","scar")]));try{await act(async()=>h.button("Not performed / deferred","OD").props.onClick());assert.equal(h.button("Scar","OD").props.disabled,true);assert.equal(h.button("Scar","OD").props["aria-pressed"],true);await h.save();const e=JSON.parse(h.posts[0]!).eyes.OD;assert.deepEqual(e.loaded,e.selected);assert.equal(e.panel.state.deferred,true);}finally{h.close();}});
test("W136 per-eye Remarks and measurements are in independent panel states",async()=>{const h=await mount(history());try{await h.remarks("Right","OD");await h.remarks("Left","OS");await act(async()=>h.panel().findByProps({type:"number"}).props.onChange({target:{value:"7"}}));await act(async()=>h.panel("OS").findByType(OdosSelect).props.onChange("b"));await h.save();const eyes=JSON.parse(h.posts[0]!).eyes;assert.equal(eyes.OD.panel.state.remarks,"Right");assert.equal(eyes.OS.panel.state.remarks,"Left");assert.equal(eyes.OD.panel.state.values.TBUT,7);assert.equal(eyes.OS.panel.state.values.SELECT,"b");assert.equal(h.panel().findByProps({"aria-label":"OD Remarks"}).props.value,"Right");assert.equal(h.panel("OS").findByProps({"aria-label":"OS Remarks"}).props.value,"Left");assert.equal(h.panel().findByProps({type:"number"}).props.value,7);assert.equal(h.panel("OS").findByType(OdosSelect).props.value,"b");assert.ok(h.reads()>2);}finally{h.close();}});
for(const count of [0,2])test(`W145 unscoped count ${count}`,async()=>{const h=await mount(history(),[],count);try{assert.equal(text(h.renderer.root).includes("Some older records could not be placed on a visit"),count>0);}finally{h.close();}});

test("W135 diagnosis-door refresh merges fresh sibling without erasing pending choice", async()=>{
 const h=await mount(history([fact("OD","scar")]));
 try {
   await h.remarks("Keep pending");
   h.setCurrent(history([fact("OD","scar"),fact("OD","staining")]));
   await act(async()=>{const event=new Event("odos:encounter-findings-changed");Object.defineProperty(event,"detail",{value:{encounterReference:"Encounter/e"}});window.dispatchEvent(event);});
   assert.equal(h.button("Staining","OD").props["aria-pressed"],true);
   assert.equal(h.panel().findByProps({"aria-label":"OD Remarks"}).props.value,"Keep pending");
   await h.save();
   const eye=JSON.parse(h.posts[0]!).eyes.OD;
   assert.deepEqual(eye.loaded.map((f:any)=>f.key.optionCode),["scar","staining"]);
   assert.deepEqual(eye.selected.map((f:any)=>f.key.optionCode),["scar","staining"]);
 }finally{h.close();}
});
test("W133 negative-only conflict never calls onSaved",async()=>{
 const h=await mount(history(),[{status:409,body:{result:"command",complete:false,executionOrder:[0],outcomes:[{target:"negative:OD",status:"conflict",reason:"positive-in-negative-scope",clinicalWrite:"none"}]}}]);
 try{await act(async()=>h.button("Anterior All Normal").props.onClick());await h.save();assert.equal(h.saved(),0);assert.equal(JSON.parse(h.posts[0]!).eyes.OD.negativeAct.scope.length,2);}finally{h.close();}
});

test("W145 refreshed zero count removes a previous unscoped notice",async()=>{
 const h=await mount(history(),[],2);
 try {
   assert.match(text(h.renderer.root),/Some older records could not be placed on a visit/);
   h.setUnscopedCount(0);
   await act(async()=>{const event=new Event("odos:encounter-findings-changed");Object.defineProperty(event,"detail",{value:{encounterReference:"Encounter/e"}});window.dispatchEvent(event);});
   assert.equal(text(h.renderer.root).includes("Some older records could not be placed on a visit"),false);
 }finally{h.close();}
});
test("W147 UI inactive owned witness remains checked and locked",async()=>{
 const option=definition.customFields[0]!.options![0]!;
 const active=option.active;
 option.active=false;
 let h:Awaited<ReturnType<typeof mount>>|undefined;
 try {
   h=await mount(history([fact("OD","scar","present",false)]));
   assert.ok(h.button("Scar","OD"),"inactive live witness must stay visible");
   assert.equal(h.button("Scar","OD").props["aria-pressed"],true);
   assert.equal(h.button("Scar","OD").props.disabled,true);
 }finally{h?.close();option.active=active;}
});

test("W136 blank optional panel text is omitted; fresh offered option becomes a new assertion",async()=>{
 const offered:any={...fact("OD","staining"),kind:"offered",status:"absent",presence:undefined,baseline:{kind:"absent",key:key("OD","staining")}};
 const h=await mount(history([offered]));
 try {
   await act(async()=>h.button("Staining","OD").props.onClick());await h.save();
   const eye=JSON.parse(h.posts[0]!).eyes.OD;
   assert.equal("other" in eye.panel.state,false);assert.equal("remarks" in eye.panel.state,false);
   assert.deepEqual(eye.loaded,[]);assert.equal(eye.selected.length,1);assert.equal(eye.selected[0].baseline.kind,"absent");assert.deepEqual(eye.selected[0].homes,[]);
 }finally{h.close();}
});


test("W134 diagnosis door names the closed-encounter refusal", async () => {
  const { findingReadOnlyLabel } = await import("../src/lib/diagnosis-findings");
  assert.equal(findingReadOnlyLabel("encounter-closed"), "Signed or closed visit");
});


for (const recorded of ["fact", "absent", "panel", "negative", "retired", "empty"]) test(`V36 canonical ${recorded} controls section Clear visibility`, async () => {
 const current = history(recorded === "fact" || recorded === "absent" || recorded === "retired" ? [fact("OD", "scar", recorded === "absent" ? "absent" : "present")] : []);
 if (recorded === "retired") current.eyes.OD.facts[0].status = "retired";
 if (recorded === "panel") current.eyes.OD.panel.baseline = { kind: "canonical", reference: "Observation/panel", versionId: "1" } as any;
 if (recorded === "negative") current.eyes.OD.negativeActs = [{ status: "live", scope: { id: "negative", eye: "OD", optionCodes: ["scar"], exclusions: [], assertedAt: "2026-09-17" } }] as any;
 const h = await mount(current);
 try {
  assert.equal(h.renderer.root.findAllByProps({ "aria-label": "Clear Ocular Health" }).length, ["retired", "empty"].includes(recorded) ? 0 : 1);
  assert.equal(h.posts.length, 0);
 } finally { h.close(); }
});

for (const edit of ["remarks", "measurement", "grade", "Other cleared"]) test(`W133 pending All Normal survives ${edit} with the same act id`, async () => {
 const h = await mount(history());
 try {
  await act(async () => h.button("Anterior All Normal").props.onClick());
  const id = h.panel().find(node => Boolean(node.props["data-negative-act"])).props["data-negative-act"];
  if (edit === "remarks") await h.remarks("Reviewed carefully");
  else if (edit === "measurement") await act(async () => h.panel().findByProps({type:"number"}).props.onChange({target:{value:"7"}}));
  else if (edit === "grade") await act(async () => h.panel().findByType(OdosSelect).props.onChange("b"));
  else await act(async () => h.panel().findAllByType("textarea").find(node => !node.props["aria-label"])!.props.onChange({target:{value:""}}));
  await h.save();
  assert.equal(JSON.parse(h.posts[0]!).eyes.OD.negativeAct?.id, id);
 } finally { h.close(); }
});
for (const edit of ["scoped positive", "Other text", "deferred"]) test(`W133 pending All Normal is dropped after ${edit}`, async () => {
 const offered = {...fact("OD","scar"),status:"absent",presence:undefined,baseline:{kind:"absent",key:key("OD","scar")}};
 const h = await mount(history([offered]), [{status:422,body:{result:"command",complete:false,executionOrder:[],outcomes:[],error:"contradictory selection refused"}}]);
 try {
  await act(async () => h.button("Anterior All Normal").props.onClick());
  assert.equal(h.panel().findAll(node => Boolean(node.props["data-negative-act"])).length,1);
  if (edit === "scoped positive") await act(async () => h.button("Scar","OD").props.onClick());
  else if (edit === "deferred") await act(async () => h.button("Not performed / deferred","OD").props.onClick());
  else await act(async () => h.panel().findAllByType("textarea").find(node => !node.props["aria-label"])!.props.onChange({target:{value:"Other observation"}}));
  assert.equal(h.panel().findAll(node => Boolean(node.props["data-negative-act"])).length,0);
  await h.save();
  assert.equal(JSON.parse(h.posts[0]!).eyes.OD.negativeAct,undefined);
  if (edit === "scoped positive") assert.equal(JSON.parse(h.posts[0]!).eyes.OD.selected[0].key.optionCode,"scar");
  assert.equal(h.saved(),0);
 } finally { h.close(); }
});
