import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { act, create } from "react-test-renderer";
import { UnusedGuarantorsSettings } from "../src/scenes/settings/UnusedGuarantorsSettings";
import { SettingsIndex } from "../src/scenes/settings/SettingsIndex";
import { RouteSwitch } from "../src/App";

test("unused guarantor Settings visibility follows business action, not admin role",async()=>{
 for(const allowed of [false,true]){let tree:any;await act(async()=>{tree=create(<SettingsIndex roles={allowed?["staff"]:["admin"]} businessActions={allowed?["guarantor.link"]:[]}/>);});assert.equal(tree.root.findAllByType("a").some((a:any)=>a.props.href==="/settings/unused-guarantors"),allowed);await act(async()=>tree.unmount());}
});
test("unused guarantor actual route denies missing business action without fetching",async()=>{
 const original=globalThis.fetch;globalThis.fetch=async()=>{throw Error("unauthorized fetch");};let tree:any;try{await act(async()=>{tree=create(<RouteSwitch view={{} as any} path="/settings/unused-guarantors" search="" roles={["admin"]}/>);});assert.match(JSON.stringify(tree.toJSON()),/do not have permission/);}finally{await act(async()=>tree?.unmount());globalThis.fetch=original;}
});
for(const refused of [false,true])test(`unused Settings required reason and ${refused?"refusal":"discard"}`,async()=>{
 const original=globalThis.fetch;const calls:any[]=[];let tree:any;
 globalThis.fetch=async(input,init)=>{calls.push({path:String(input),body:init?.body&&JSON.parse(String(init.body))});return init?.method==="POST"?Response.json(refused?{error:"No longer unused"}:{personId:"N",versionId:"2"},{status:refused?409:200}):Response.json([{personId:"N",versionId:"1",name:"Synthetic Parent",birthDate:"1980-01-02",phones:["8645550101"],city:"Town",postalCode:"00000",lastUpdated:new Date().toISOString()}]);};
 try{await act(async()=>{tree=create(<UnusedGuarantorsSettings canDiscard/>);});assert.match(JSON.stringify(tree.toJSON()),/may be mid-registration/);assert.match(JSON.stringify(tree.toJSON()),/Creation time is unavailable/);const button=()=>tree.root.findByType("button");assert.equal(button().props.disabled,true);await act(async()=>tree.root.findByType("input").props.onChange({target:{value:"   "}}));assert.equal(button().props.disabled,true);await act(async()=>tree.root.findByType("input").props.onChange({target:{value:" Abandoned registration "}}));await act(async()=>button().props.onClick());assert.deepEqual(calls[1],{path:"/guarantors/N/discard",body:{reason:"Abandoned registration",expectedVersion:"1"}});assert.equal(tree.root.findAllByType("button").length,refused?1:0);assert.match(JSON.stringify(tree.toJSON()),refused?/No longer unused/:/was deactivated/);}finally{await act(async()=>tree?.unmount());globalThis.fetch=original;}
});
