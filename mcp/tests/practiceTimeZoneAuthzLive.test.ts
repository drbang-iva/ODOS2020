import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import type { Basic, Bundle } from "@medplum/fhirtypes";
import { createLiveAuthorizationClients } from "./integration-helpers.js";
import { fhirRequest, cleanupReferences } from "./liveRoleClient.js";
import { authenticateStaffRoute } from "../src/payments/payment-endpoint.js";
import { TEST_FHIR_AUDIT_RECORDER } from "./fhirAuditTestStub.js";
import { buildPracticeTimeZoneConfigResource, parsePracticeTimeZoneConfig, ODOS_PRACTICE_TIME_ZONE_CONFIG_SYSTEM, ODOS_PRACTICE_TIME_ZONE_CONFIG_CODE } from "../src/clinic/practice-time-zone-config.js";

const fixturePath = process.env.ODOS_SA_FIXTURE;
test("O21 O23 live single-role humans enforce admin-only practice time-zone read and writes", { skip: !fixturePath }, async()=>{
 const baseUrl=process.env.MEDPLUM_BASE_URL!;assert.equal(baseUrl,"http://localhost:18103/");
 const fixture=JSON.parse(readFileSync(fixturePath!,"utf8"));
 const {seederAccessToken,callerFhir}=await createLiveAuthorizationClients({baseUrl,email:process.env.MEDPLUM_ADMIN_EMAIL!,password:process.env.MEDPLUM_ADMIN_PASSWORD!});
 const cleanup:string[]=[];
 try {
  for(const role of ["admin","provider","staff"]){
   const token=fixture.identities[role].token;
   const identity=await authenticateStaffRoute({baseUrl,authHeader:`Bearer ${token}`,serviceClient:callerFhir,audit:TEST_FHIR_AUDIT_RECORDER});
   assert.deepEqual(identity?.roles,[role]);assert.equal(identity?.staffReference,fixture.identities[role].profile);assert.match(identity!.staffReference,/^Practitioner\//);
  }
  const adminToken=fixture.identities.admin.token;
  const created=await fhirRequest<Basic>(baseUrl,adminToken,"POST","Basic",buildPracticeTimeZoneConfigResource({timeZone:"America/Chicago"}));
  assert.equal(created.status,201,"admin-only creates setting");assert.ok(created.body?.id);cleanup.push(`Basic/${created.body.id}`);
  const reference=`Basic/${created.body.id}`;
  const read=await fhirRequest<Basic>(baseUrl,adminToken,"GET",reference);
  assert.equal(read.status,200,"admin-only reads setting");
  const updated=await fhirRequest<Basic>(baseUrl,adminToken,"PUT",reference,buildPracticeTimeZoneConfigResource({timeZone:"America/Denver"},read.body));
  assert.equal(updated.status,200,"admin-only updates setting");
  const baseline=await fhirRequest<Basic>(baseUrl,seederAccessToken,"GET",reference);
  assert.equal(baseline.status,200);assert.ok(baseline.body?.meta?.versionId);
  assert.equal(parsePracticeTimeZoneConfig(baseline.body).timeZone,"America/Denver");
  async function assertUnchanged(role:string,action:string){
   const after=await fhirRequest<Basic>(baseUrl,seederAccessToken,"GET",reference);
   assert.equal(after.status,200,`${role} ${action}: seeder readback`);
   assert.equal(after.body?.meta?.versionId,baseline.body?.meta?.versionId,`${role} ${action}: setting version unchanged`);
   assert.equal(parsePracticeTimeZoneConfig(after.body!).timeZone,"America/Denver",`${role} ${action}: setting zone unchanged`);
  }
  for(const role of ["staff","provider"]){
   const token=fixture.identities[role].token;
   const create=await fhirRequest<Basic>(baseUrl,token,"POST","Basic",buildPracticeTimeZoneConfigResource({timeZone:"America/Chicago"}));
   if(create.status===201&&create.body?.id)cleanup.push(`Basic/${create.body.id}`);
   await assertUnchanged(role,"create");
   assert.ok(create.status===403||create.status===404,`${role}-only cannot create setting (${create.status})`);
   const write=await fhirRequest<Basic>(baseUrl,token,"PUT",reference,buildPracticeTimeZoneConfigResource({timeZone:"America/Chicago"},updated.body));
   await assertUnchanged(role,"update");
   assert.ok(write.status===403||write.status===404,`${role}-only cannot update setting (${write.status})`);
   const search=await fhirRequest<Bundle<Basic>>(baseUrl,token,"GET",`Basic?${new URLSearchParams({code:`${ODOS_PRACTICE_TIME_ZONE_CONFIG_SYSTEM}|${ODOS_PRACTICE_TIME_ZONE_CONFIG_CODE}`})}`);
   assert.equal(search.status,200);assert.equal(search.body?.entry?.length??0,0,`${role}-only setting search must be empty`);
  }
 } finally {await cleanupReferences(baseUrl,seederAccessToken,cleanup);}
});
