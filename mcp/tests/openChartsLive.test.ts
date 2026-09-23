import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import express from "express";
import { registerClinicRoutes } from "../src/clinic/clinic-routes.js";
import { authenticateStaffRoute } from "../src/payments/payment-endpoint.js";
import { TEST_FHIR_AUDIT_RECORDER } from "./fhirAuditTestStub.js";
import { createLiveAuthorizationClients } from "./integration-helpers.js";
import { cleanupReferences } from "./liveRoleClient.js";
import { buildPracticeTimeZoneConfigResource } from "../src/clinic/practice-time-zone-config.js";

const fixturePath = process.env.ODOS_SA_FIXTURE;
test("O19 open-chart routes rate-limit excess requests", async()=>{
 const app=express();
 registerClinicRoutes(app,{authenticateService:async()=>{},authenticate:async()=>null} as any);
 const server=app.listen(0,"127.0.0.1");await new Promise<void>(resolve=>server.once("listening",resolve));
 const address=server.address();assert.ok(address&&typeof address!=="string");
 const url=`http://127.0.0.1:${address.port}`;
 try {
  for(let i=0;i<120;i++)assert.equal((await fetch(`${url}/clinic/open-charts`)).status,401);
  assert.equal((await fetch(`${url}/clinic/open-charts/desk`)).status,429);
 } finally {await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));}
});
test("O19 O26 live caller gates and service-owned setting resolution", { skip: !fixturePath }, async()=>{
 const baseUrl=process.env.MEDPLUM_BASE_URL!;assert.equal(baseUrl,"http://localhost:18103/");
 const fixture=JSON.parse(readFileSync(fixturePath!,"utf8"));
 const clients=await createLiveAuthorizationClients({baseUrl,email:process.env.MEDPLUM_ADMIN_EMAIL!,password:process.env.MEDPLUM_ADMIN_PASSWORD!});
 const app=express();
 registerClinicRoutes(app,{
  authenticateService:async()=>{}, serviceFhir:clients.seederFhir as any, timeZone:"America/New_York",
  authenticate:authHeader=>authenticateStaffRoute({baseUrl,authHeader,serviceClient:clients.callerFhir,audit:TEST_FHIR_AUDIT_RECORDER}) as any,
 });
 const server=app.listen(0,"127.0.0.1");await new Promise<void>(resolve=>server.once("listening",resolve));
 const address=server.address();assert.ok(address&&typeof address!=="string");
 const url=`http://127.0.0.1:${address.port}`;
 const cleanup:string[]=[];
 const get=async(path:string,role?:string)=>fetch(`${url}${path}`,{headers:role?{Authorization:`Bearer ${fixture.identities[role].token}`}:{}});
 try {
  for(const path of ["/clinic/open-charts","/clinic/open-charts/desk"])assert.equal((await get(path)).status,401);
  for(const role of ["provider","staff","admin"]){
   const doctor=await get("/clinic/open-charts",role);assert.equal(doctor.status,role==="provider"?200:403,`${role} doctor action gate`);
   const desk=await get("/clinic/open-charts/desk",role);assert.equal(desk.status,200,`${role} desk action gate`);
  }
  const absent=await Promise.all([get("/clinic/open-charts","provider"),get("/clinic/open-charts/desk","staff")]);
  for(const response of absent){assert.equal(response.status,200);const body=await response.json();assert.equal(body.timeZoneSource,"environment");assert.equal(body.timeZone,"America/New_York");}
  const setting=await clients.seederFhir.create(buildPracticeTimeZoneConfigResource({timeZone:"America/Denver"}));
  cleanup.push(`Basic/${setting.id}`);
  const responses=await Promise.all([get("/clinic/open-charts","provider"),get("/clinic/open-charts/desk","staff")]);
  const results=[];
  for(const response of responses){assert.equal(response.status,200);const body=await response.json();results.push({source:body.timeZoneSource,zone:body.timeZone});}
  assert.deepEqual(results,[{source:"setting",zone:"America/Denver"},{source:"setting",zone:"America/Denver"}],"provider doctor and staff desk must honor service-visible setting");
 } finally {await cleanupReferences(baseUrl,clients.seederAccessToken,cleanup);await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));}
});
