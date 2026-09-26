import assert from "node:assert/strict";
import { test } from "node:test";
import type { Task } from "@medplum/fhirtypes";
import { createVisionWebLabOrderAdapter, VISIONWEB_UPLOAD_STATE_SYSTEM, VISIONWEB_ORDER_ID_SYSTEM } from "../src/lab-orders/adapters/visionweb-lab-order-adapter.js";
import { visionWebConfigFromEnv } from "../src/integrations/visionweb/config.js";
import { createVisionWebClient } from "../src/integrations/visionweb/visionWebClient.js";
import { labTransportStateConcept } from "../src/fhir/labTransportState.js";
import { env } from "./fixtures/visionweb/support.js";
import { order } from "./fixtures/visionweb/support.js";

export function harness() {
  const tasks = new Map<string,Task>(); const audits:unknown[]=[]; const writes:Task[]=[]; const uploads:any[]=[];
  let failWrite = "";
  const fhir:any={
    read:async(_rt:string,id:string)=> structuredClone(tasks.get(id) ?? {resourceType:"Task",id,status:"requested",intent:"order"}),
    search:async()=>({resourceType:"Bundle",type:"searchset",entry:[...tasks.values()].map(resource=>({resource:structuredClone(resource)}))}),
    create:async(t:Task)=>{const saved={...structuredClone(t),id:`tx-${tasks.size+1}`};tasks.set(saved.id,saved);writes.push(saved);return structuredClone(saved);},
    update:async(_rt:string,id:string,t:Task)=>{if(t.statusReason?.coding?.[0]?.code===failWrite)throw new Error("synthetic write failure");tasks.set(id,structuredClone(t));writes.push(structuredClone(t));return structuredClone(t);},
  };
  const client:any={uploadOrder:async(_c:any,r:any)=>{uploads.push(r);return {orderId:r.subordid,supplierId:r.sloid,status:"Sent",vwebOrderId:"SP-TEST",vwebExchangeId:"EX-TEST"};}};
  const config=visionWebConfigFromEnv(env);
  const options={now:()=>"2026-09-26T12:00:00.000Z",recordAudit:async(row:unknown)=>{audits.push(row);}};
  const adapter=()=>createVisionWebLabOrderAdapter(fhir,config,client,options);
  const req=()=>({order:order(),orderTaskReference:"Task/order",staffReference:"Practitioner/test",lab:"Demo"});
  return {tasks,audits,writes,uploads,fhir,client,config,options,adapter,req,failOn:(state:string)=>{failWrite=state;}};
}
const uploadState=(t:Task)=>t.statusReason?.coding?.find(c=>c.system===VISIONWEB_UPLOAD_STATE_SYSTEM)?.code;
const transport=(t:Task)=>t.businessStatus?.coding?.[0]?.code;
test("V1 V2 V3 invalid setup and V5 invalid order cause no writes or network",async()=>{
  for(const kind of ["config","production","lab","order"]){const h=harness();const req=h.req();if(kind==="config")delete h.config.password;if(kind==="production")h.config.soapUrl="https://production.example";if(kind==="lab")req.lab="Other";if(kind==="order"){delete req.order.rx.od.distPd;delete req.order.frame!.a;delete req.order.rx.od.segHeight;}await assert.rejects(h.adapter().submit(req));assert.equal(h.writes.length,0);assert.equal(h.uploads.length,0);}
});
test("V9 write-ahead outcome states and audits",async()=>{
  for(const status of ["Sent","Review","Error","throw","http","unreadable","mismatch"]){
    const h=harness();
    h.client.uploadOrder=async(_c:any,r:any)=>{
      h.uploads.push(r);const task=[...h.tasks.values()][0];assert.equal(transport(task),"queued");assert.equal(uploadState(task),"uploading");assert.equal(h.audits.length,1);
      if(status==="throw")throw new Error("VisionWeb upload failed.");if(status==="http")throw new Error("VisionWeb upload failed with HTTP 500.");if(status==="unreadable")throw new Error("VisionWeb returned a response ODOS could not read.");
      return {orderId:status==="mismatch"?"wrong":r.subordid,supplierId:r.sloid,status:status==="mismatch"?"Sent":status,errorList:"Test rejection",vwebOrderId:"SP-TEST",vwebExchangeId:"EX-TEST"};
    };
    if(status==="Sent"||status==="Review"){const result=await h.adapter().submit(h.req());assert.equal(result.transportState,status==="Sent"?"sent":"queued");assert.equal(result.transmittedVia,"api");}
    else await assert.rejects(h.adapter().submit(h.req()));
    const t=[...h.tasks.values()][0];assert.equal(uploadState(t),status==="Sent"?"accepted":status==="Review"?"review":status==="Error"?"rejected":"unknown");
    assert.equal(transport(t),status==="Sent"?"sent":status==="Error"?"error":"queued");assert.equal(h.audits.length,2);
    assert.match(JSON.stringify(h.audits),/lab-order.submit:visionweb:Demo:pending/);
    assert.match(JSON.stringify(h.audits),status==="Sent"?/queued->sent/:status==="Review"?/visionweb:review/:status==="Error"?/queued->error/:/outcome-unknown/);
  }
});
test("V9 failed upload-state writes never remove the reservation",async()=>{
  const h=harness();h.failOn("uploading");await assert.rejects(h.adapter().submit(h.req()));assert.equal(h.uploads.length,0);assert.equal(uploadState([...h.tasks.values()][0]),"pending");
  const unknown=harness();unknown.failOn("unknown");unknown.client.uploadOrder=async()=>{throw new Error("VisionWeb upload failed.");};await assert.rejects(unknown.adapter().submit(unknown.req()));assert.equal(uploadState([...unknown.tasks.values()][0]),"uploading");
});
test("V11 existing active Task refuses resubmission and V14 distinct orders use distinct message ids",async()=>{
  const h=harness();await h.adapter().submit(h.req());const writes=h.writes.length;
  await assert.rejects(h.adapter().submit(h.req()),/already transmitted/);assert.equal(h.writes.length,writes);assert.equal(h.uploads.length,1);
  const other=h.req();other.orderTaskReference="Task/other";other.order.header.orderId="OTHER";await h.adapter().submit(other);assert.notEqual(h.uploads[0].msgguid,h.uploads[1].msgguid);
});
test("V12 cancellation and advancement enforce the upload-state lock",async()=>{
  for(const state of ["pending","uploading","accepted","review","rejected","unknown",undefined,"unrecognized"]){
    const h=harness();await h.adapter().submit(h.req());const t=[...h.tasks.values()][0];t.businessStatus=labTransportStateConcept("queued");t.status="requested";t.statusReason=state?{coding:[{system:VISIONWEB_UPLOAD_STATE_SYSTEM,code:state}]}:undefined;h.tasks.set(t.id!,t);
    const a=h.adapter();const ref=`Task/${t.id}`;const before=JSON.stringify(t);const count=h.writes.length;
    if(state==="pending"||state==="rejected"){
      await assert.rejects(a.advanceTransportState({labOrderReference:ref,staffReference:"Practitioner/test",toState:"sent"}),/nothing to advance/);
      await a.cancel(ref,"Practitioner/test");assert.equal(transport(h.tasks.get(t.id!)!),"cancelled");await a.submit(h.req());
    }else{
      await assert.rejects(a.cancel(ref,"Practitioner/test"),state==="accepted"||state==="review"?/cancel it with the lab/:/outcome is unknown/);
      if(state!=="accepted"&&state!=="review")for(const toState of ["sent","received","error"] as const)await assert.rejects(a.advanceTransportState({labOrderReference:ref,staffReference:"Practitioner/test",toState}),/outcome is unknown/);
      await assert.rejects(a.advanceTransportState({labOrderReference:ref,staffReference:"Practitioner/test",toState:"cancelled"}));
      assert.equal(JSON.stringify(h.tasks.get(t.id!)),before);assert.equal(h.writes.length,count);
      await assert.rejects(a.submit(h.req()),/already transmitted/);assert.equal(h.uploads.length,1);
    }
  }
});
test("V12 foreign transmission Task refuses reads, mutations and use as a clinical order",async()=>{
  const h=harness();await h.adapter().submit(h.req());const t=[...h.tasks.values()][0];t.identifier=[{system:"https://odos2020.com/fhir/NamingSystem/ocuco-order-id",value:"foreign"}];h.tasks.set(t.id!,t);const ref=`Task/${t.id}`;const a=h.adapter();
  await assert.rejects(a.getTransportState(ref),/not a VisionWeb/);await assert.rejects(a.cancel(ref,"Practitioner/test"),/not a VisionWeb/);await assert.rejects(a.advanceTransportState({labOrderReference:ref,staffReference:"Practitioner/test",toState:"error"}),/not a VisionWeb/);
  const req=h.req();req.orderTaskReference=ref;await assert.rejects(a.submit(req),/not a VisionWeb/);
});
test("V10 adversarial vendor errors cannot leak into Tasks, audit or thrown errors",async()=>{
  const h=harness();h.client.uploadOrder=async(_c:any,r:any)=>({orderId:r.subordid,supplierId:r.sloid,status:"Error",errorList:`bad ${env.VISIONWEB_PASSWORD} ${env.VISIONWEB_CLIENT_SECRET}`});
  let message="";try{await h.adapter().submit(h.req());}catch(e){message=(e as Error).message;}
  const output=JSON.stringify({tasks:[...h.tasks.values()],audits:h.audits,message});assert.doesNotMatch(output,/PW-SENTINEL|SECRET-SENTINEL|<VWOrder/);assert.match(output,/redacted/);
});

test("V10 real client and adapter keep all sentinel forms out of every outcome and console",async()=>{
  const sentinel=[env.VISIONWEB_USERNAME,env.VISIONWEB_PASSWORD,env.VISIONWEB_CLIENT_ID,env.VISIONWEB_CLIENT_SECRET,"TOKEN-SENTINEL-8e6",Buffer.from(`${env.VISIONWEB_CLIENT_ID}:${env.VISIONWEB_CLIENT_SECRET}`).toString("base64")];
  const consoleRows:unknown[]=[];const old={log:console.log,error:console.error,warn:console.warn};
  console.log=(...v)=>{consoleRows.push(v);};console.error=(...v)=>{consoleRows.push(v);};console.warn=(...v)=>{consoleRows.push(v);};
  try{
    for(const status of ["Sent","Review","Error","throw","http","unreadable","mismatch"]){
      for(const detail of [...sentinel,"<VWOrder><Item>echo</Item></VWOrder>"]){
        const h=harness();const escape=(v:string)=>v.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
        const client=createVisionWebClient({fetchImpl:async(url)=>{
          if(String(url)===h.config.tokenUrl)return Response.json({access_token:"TOKEN-SENTINEL-8e6",expires_in:120});
          if(status==="throw")throw new Error(detail);if(status==="http")return new Response(detail,{status:500});if(status==="unreadable")return new Response(detail);
          return new Response(`<SingleOrder><OrderId>${status==="mismatch"?"wrong":"TEST-ORDER"}</OrderId><SupplierId>9992</SupplierId><Status>${status==="mismatch"?"Sent":status}</Status><ErrorList>${escape(detail)}</ErrorList></SingleOrder>`);
        }});
        await client.getAccessToken(h.config,"test");
        let message="";try{await createVisionWebLabOrderAdapter(h.fhir,h.config,client,h.options).submit(h.req());}catch(e){message=(e as Error).message;}
        const output=JSON.stringify({writes:h.writes,audits:h.audits,message,consoleRows});
        for(const secret of sentinel)assert.equal(output.includes(secret),false,`leak in ${status}`);assert.equal(output.includes("<VWOrder"),false);
      }
    }
  }finally{console.log=old.log;console.error=old.error;console.warn=old.warn;}
});
