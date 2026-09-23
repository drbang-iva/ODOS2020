import assert from "node:assert/strict";
import { test } from "node:test";
import { buildMedplumAccessPolicy, getRoleDeclaration } from "../src/authz/roles.js";
const criteria = "Basic?code=https://odos2020.com/fhir/CodeSystem/practice-time-zone-config|odos-practice-time-zone-config";
test("O23 practice time zone is exactly one admin read and write grant and no other role grants",()=>{
 for(const role of ["admin","staff","provider"] as const){
  const policy=buildMedplumAccessPolicy(getRoleDeclaration(role));
  const rules=policy.resource?.filter(r=>r.resourceType==="Basic"&&r.criteria===criteria)??[];
  assert.equal(rules.length,role==="admin"?2:0);
  if(role==="admin") {assert.equal(rules.filter(r=>r.interaction?.includes("read")).length,1);assert.equal(rules.filter(r=>r.interaction?.includes("create")&&r.interaction?.includes("update")).length,1);}
 }
});

import { buildPracticeTimeZoneConfigResource, parsePracticeTimeZoneConfig, validatePracticeTimeZone } from "../src/clinic/practice-time-zone-config.js";
test("practice time-zone config canonicalizes and rejects malformed input",()=>{
 assert.equal(validatePracticeTimeZone("US/Eastern"),"America/New_York");
 const config=buildPracticeTimeZoneConfigResource({timeZone:"US/Eastern"});
 assert.deepEqual(parsePracticeTimeZoneConfig(config),{timeZone:"America/New_York"});
 assert.throws(()=>parsePracticeTimeZoneConfig({...config,code:{text:"wrong"}}));
 assert.throws(()=>parsePracticeTimeZoneConfig({...config,extension:[{...config.extension![0],valueString:"{"}]}));
 assert.throws(()=>validatePracticeTimeZone(undefined));assert.throws(()=>validatePracticeTimeZone("invalid"));
});
