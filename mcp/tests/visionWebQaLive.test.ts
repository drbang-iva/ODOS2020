import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync, writeFileSync } from "node:fs";
import type { Task } from "@medplum/fhirtypes";
import { visionWebConfigFromEnv, assertVisionWebTransmission } from "../src/integrations/visionweb/config.js";
import { createVisionWebClient, sanitizeVendorText, visionWebSecrets } from "../src/integrations/visionweb/visionWebClient.js";
import { parseVisionWebUploadResponse } from "../src/integrations/visionweb/uploadResponse.js";
import { escapeVisionWebXml } from "../src/integrations/visionweb/vwOrderSerializer.js";
import { createVisionWebLabOrderAdapter } from "../src/lab-orders/adapters/visionweb-lab-order-adapter.js";
import { order } from "./fixtures/visionweb/support.js";

test("L1 one synthetic VisionWeb QA upload; capture only after secret and fixture checks",{skip:process.env.VISIONWEB_QA_LIVE!=="1"},async()=>{
  const config=visionWebConfigFromEnv();assertVisionWebTransmission(config);
  assert.equal(new URL(config.soapUrl).hostname,"services.visionwebqa.com");
  const capture=new URL("./fixtures/visionweb/qa-upload-response.xml",import.meta.url);
  assert.equal(existsSync(capture),false,"A prior capture exists; do not submit twice.");
  const secrets=visionWebSecrets(config);let raw="";let uploadStatus=0;let uploads=0;
  const client=createVisionWebClient({fetchImpl:async(url,init)=>{
    const response=await fetch(url,init);
    if(String(url)===config.soapUrl){uploads++;uploadStatus=response.status;raw=await response.clone().text();}
    if(String(url)===config.tokenUrl&&response.ok){const value=await response.clone().json() as {access_token?:unknown};if(typeof value.access_token==="string")secrets.push(value.access_token);}
    return response;
  }});
  const tasks=new Map<string,Task>();
  const fhir:any={read:async()=>({resourceType:"Task",id:"synthetic-order",status:"requested",intent:"order"}),search:async()=>({resourceType:"Bundle",type:"searchset",entry:[...tasks.values()].map(resource=>({resource}))}),create:async(t:Task)=>{const saved={...t,id:"synthetic-transmission"};tasks.set(saved.id,saved);return saved;},update:async(_rt:string,id:string,t:Task)=>{tasks.set(id,t);return t;}};
  const synthetic=order();synthetic.header.orderId=`ODOS-QA-${crypto.randomUUID().replace(/\d/g,"x").slice(0,8)}`;synthetic.header.patientName="TEST LAST";synthetic.header.lab="VisionWeb QA Demo";synthetic.lensSpec={jobType:"Uncut",lensDesign:"SV",lensMaterial:"PH-67-NONE-NONE-00",treatments:[]};synthetic.rx={od:{sphere:5,distPd:30},os:{sphere:2,distPd:30}};
  let failure="";
  try{await createVisionWebLabOrderAdapter(fhir,config,client,{recordAudit:async()=>{}}).submit({order:synthetic,orderTaskReference:"Task/synthetic-order",staffReference:"Practitioner/synthetic",lab:"VisionWeb QA Demo"});}catch(error){failure=error instanceof Error?error.message:"VisionWeb upload failed.";}
  assert.equal(uploads,1);
  if(uploadStatus<200||uploadStatus>=300)throw new Error(`VisionWeb upload failed with HTTP ${uploadStatus}.`);
  const result=parseVisionWebUploadResponse(raw);
  if(failure&&result.status!=="Error")throw new Error("VisionWeb QA adapter failed.");
  function safe(value:string){
    for(const secret of secrets.flatMap(s=>[s,escapeVisionWebXml(s)]))if(secret&&value.includes(secret))throw new Error("VisionWeb QA capture contains credentials; not saved or printed.");
    if(/(?<!\d)\d{10}(?!\d)/.test(value))throw new Error("VisionWeb QA capture contains a ten-digit value; ruling required.");
  }
  safe(raw);
  writeFileSync(capture,raw,{flag:"wx",mode:0o600});
  console.log(JSON.stringify({transportReachability:{httpStatus:uploadStatus,parsed:true},vendorAcceptance:{...result,errorList:result.errorList?sanitizeVendorText(result.errorList,secrets):undefined}}));
  if(result.vwebOrderId){
    const tracking=await client.getTrackingUpdates(config,[result.vwebOrderId]);
    const statuses:Array<{path:string;value:unknown}>=[];
    function collect(value:unknown,path=""){if(!value||typeof value!=="object")return;for(const [key,entry]of Object.entries(value)){const current=`${path}.${key}`;if(/status/i.test(key)&&(typeof entry==="string"||typeof entry==="number"||typeof entry==="boolean"||entry===null))statuses.push({path:current,value:entry});collect(entry,current);}}
    collect(tracking);const report={topLevelKeys:tracking&&typeof tracking==="object"?Object.keys(tracking):[],statuses};safe(JSON.stringify(report));console.log(JSON.stringify(report));
  }
});
