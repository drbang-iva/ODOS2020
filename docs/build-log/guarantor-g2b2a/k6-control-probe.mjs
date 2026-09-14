import assert from 'node:assert/strict';
import { refreshFixtureTokens, successfulHttp, createLiveClients, writeEvidence, saveHttpTrace } from './live-fixture.mjs';
import { authenticateStaffRoute } from '../../../mcp/src/payments/payment-endpoint.ts';
import { membershipBusinessActionExtensions } from '../../../mcp/src/authz/membership-business-actions.ts';
import { handleGuarantorOperation } from '../../../mcp/src/clinic/guarantor-link-operation.ts';
const f=await refreshFixtureTokens();
const {audit,serviceFhir}=await createLiveClients(f);
const principal=f.principals.staff;
const path=`/fhir/R4/ProjectMembership/${principal.membershipId}`;
const original=await successfulHttp(f,'GET',path);
const auth=()=>authenticateStaffRoute({baseUrl:f.baseUrl,authHeader:`Bearer ${principal.token}`,serviceClient:serviceFhir,audit});
try {
 const before=await auth();assert.ok(before.businessActions.includes('guarantor.link'));
 await successfulHttp(f,'PUT',path,{body:{...original,extension:membershipBusinessActionExtensions(original.extension,[],['guarantor.link'])},headers:{'If-Match':`W/"${original.meta.versionId}"`}});
 const revoked=await auth();assert.ok(revoked);assert.ok(!revoked.businessActions.includes('guarantor.link'));
 let io=0;
 const noIO=new Proxy(serviceFhir,{get(target,key){if(['readExtended','searchProject','searchProjectUrl','executeTransactionAsActor'].includes(key)) return ()=>{io++;throw Error('Unexpected operation I/O');};return Reflect.get(target,key);}});
 const result=await handleGuarantorOperation({serviceFhir:noIO,serviceReference:f.serviceReference,recordAudit:async()=>{throw Error('Unexpected audit');}},revoked,{action:'draft',body:{kind:'transfer',sourcePersonId:'S',destinationPersonId:'D',relatedPersonIds:['r']}});
 assert.equal(result.status,403);assert.equal(io,0);
 writeEvidence('k6-control-result.json',{baseHead:'6baea1d51666461e3de94ded1287ffe8817d2f70',genericAuthenticationSucceeded:true,guarantorLinkRevoked:true,result,operationIO:io,limitation:'Executes the shipped dispatcher constructor with action=draft; the new draft branch is not implemented. Its required insertion before start-schema parse is downstream of this constructor. Not a completed K6 route mutation proof.'});
 console.log(JSON.stringify({genericAuthenticationSucceeded:true,guarantorLinkRevoked:true,result,operationIO:io}));
} finally {
 const current=await successfulHttp(f,'GET',path);
 await successfulHttp(f,'PUT',path,{body:{...original,meta:current.meta},headers:{'If-Match':`W/"${current.meta.versionId}"`}});
 const restored=await auth();assert.ok(restored.businessActions.includes('guarantor.link'));
 saveHttpTrace('k6-control-membership-http.json');
 await audit.close();
}
