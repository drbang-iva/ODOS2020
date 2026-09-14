import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { sourceRoot, refreshFixtureTokens, successfulHttp, http, saveHttpTrace, writeEvidence } from './live-fixture.mjs';
const fixture=await refreshFixtureTokens();
const head=execFileSync('git',['rev-parse','HEAD'],{cwd:sourceRoot,encoding:'utf8'}).trim();
const policyPath=sourceRoot+'/mcp/src/authz/roles.ts';
const beforeHash=createHash('sha256').update(readFileSync(policyPath)).digest('hex');
const observations=[];
const make=resource=>successfulHttp(fixture,'POST','/fhir/R4/'+resource.resourceType,{body:{...resource,meta:{project:fixture.projectA}},scenario:'collection-review-setup'});
const children=[];
for(const label of ['A','B','C']) children.push(await make({resourceType:'RelatedPerson',active:true,patient:{reference:'Patient/'+fixture.patientId},name:[{family:'Synthetic',given:['Collection '+label]}]}));
const links=children.map(child=>({target:{reference:'RelatedPerson/'+child.id},assurance:'level2'}));
for(const principal of ['staff','composite']){
 const person=await make({resourceType:'Person',active:true,name:[{family:'Synthetic',given:['Collection '+principal]}],link:links.slice(0,2)});
 const policy=await successfulHttp(fixture,'GET','/fhir/R4/AccessPolicy/'+fixture.principals[principal].policyId,{scenario:'collection-review-policy-read'});
 for(const [caseName,replacement] of [['overlap-replace',[links[0],links[2]]],['overlap-remove',[links[0]]],['overlap-add',links]]){
  const before=await successfulHttp(fixture,'GET','/fhir/R4/Person/'+person.id,{scenario:caseName});
  const result=await http(fixture,'PUT','/fhir/R4/Person/'+person.id,{principal,token:fixture.principals[principal].token,scenario:caseName,headers:{'If-Match':`W/"${before.meta.versionId}"`},body:{...before,link:replacement}});
  const after=await successfulHttp(fixture,'GET','/fhir/R4/Person/'+person.id,{scenario:caseName});
  observations.push({principal,caseName,status:result.status,expectedStatus:403,linksUnchanged:JSON.stringify(after.link)===JSON.stringify(before.link),versionUnchanged:after.meta.versionId===before.meta.versionId,personId:person.id,policyVersion:policy.meta.versionId});
 }
 const before=await successfulHttp(fixture,'GET','/fhir/R4/Person/'+person.id,{scenario:'positive-name-only'});
 const result=await http(fixture,'PUT','/fhir/R4/Person/'+person.id,{principal,token:fixture.principals[principal].token,scenario:'positive-name-only',headers:{'If-Match':`W/"${before.meta.versionId}"`},body:{...before,name:[{family:'Synthetic',given:['Collection '+principal+' name updated']}]}});
 observations.push({principal,caseName:'name-only-with-two-links',status:result.status,expectedStatus:200,linksUnchanged:JSON.stringify(result.body.link)===JSON.stringify(before.link),personId:person.id,policyVersion:policy.meta.versionId});
}
const afterHash=createHash('sha256').update(readFileSync(policyPath)).digest('hex');
const checks=observations.every(x=>x.status===x.expectedStatus&&x.linksUnchanged&&(x.expectedStatus!==403||x.versionUnchanged));
writeEvidence('person-collection-review-proof.json',{head,policySourceSha256:beforeHash,sourceUnchanged:beforeHash===afterHash,observations,passed:checks,policyMutation:false});
saveHttpTrace('person-collection-review-http.json');
console.log(JSON.stringify({head,observations:observations.map(({principal,caseName,status,expectedStatus,linksUnchanged,versionUnchanged})=>({principal,caseName,status,expectedStatus,linksUnchanged,versionUnchanged})),passed:checks,policyMutation:false}));
assert.ok(checks);assert.equal(afterHash,beforeHash);
