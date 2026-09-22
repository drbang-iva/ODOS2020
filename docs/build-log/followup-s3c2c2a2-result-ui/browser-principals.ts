import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {createLiveAuthorizationClients} from '../../../mcp/tests/integration-helpers.js';
import {createRoleClient,clientCredentialsToken} from '../../../mcp/tests/liveRoleClient.js';
const baseUrl=process.env.MEDPLUM_BASE_URL!;
const {seederFhir:admin,callerAccessToken}=await createLiveAuthorizationClients({baseUrl,email:process.env.MEDPLUM_ADMIN_EMAIL!,password:process.env.MEDPLUM_ADMIN_PASSWORD!});
const session=JSON.parse(readFileSync('.odos/s3c2c2a2/browser-session.json','utf8'));
const policies=await admin.search('AccessPolicy',{_count:'1000'});
const policy=policies.entry!.map(e=>e.resource as any).find(p=>p.name==='ODOS Provider'&&p.meta?.tag?.filter((t:any)=>t.system==='https://odos2020.com/fhir/NamingSystem/practice-role').length===1&&p.meta.tag.some((t:any)=>t.code==='provider'));
assert.ok(policy, 'Synced canonical ODOS Provider policy required.');
const uploadPolicy=await admin.create({resourceType:'AccessPolicy',name:'Synthetic project-admin upload proof',meta:{tag:[{system:'https://odos2020.com/fhir/NamingSystem/practice-role',code:'provider'}]},resource:[{resourceType:'*'}]});
for(const kind of ['provider','upload']) {
 const practitioner=await admin.create({resourceType:'Practitioner',name:[{text:`Synthetic browser ${kind}`} ]});
 let client:any;
 const {token}=await createRoleClient({baseUrl,roleId:'provider',policyReference:`AccessPolicy/${kind==='upload'?uploadPolicy.id:policy.id}`,patientReference:session.patientReference,practitionerReference:`Practitioner/${practitioner.id}`,projectId:process.env.MEDPLUM_PROJECT_ID!,runId:`browser-${kind}-${session.encounterId}`,adminToken:callerAccessToken,track:r=>{if(r.resourceType==='ClientApplication')client=r;return r;}});
 const me=await (await fetch(`${baseUrl}auth/me`,{headers:{Authorization:`Bearer ${token}`}})).json();
 const url=`${baseUrl}admin/projects/${process.env.MEDPLUM_PROJECT_ID}/members/${me.membership.id}`;
 const headers={Authorization:`Bearer ${callerAccessToken}`,'Content-Type':'application/fhir+json'};
 const membership=await (await fetch(url,{headers})).json();
 const update=await fetch(url,{method:'POST',headers,body:JSON.stringify({...membership,profile:{reference:`Practitioner/${practitioner.id}`},...(kind==='upload'?{admin:true}:{})})});
 assert.equal(update.status,200);
 const fresh=await clientCredentialsToken(baseUrl,client.id,client.secret,'provider');
 const identity=await (await fetch(`${baseUrl}auth/me`,{headers:{Authorization:`Bearer ${fresh}`}})).json();
 assert.equal(identity.profile.resourceType,'Practitioner');
 session[kind==='upload'?'uploadToken':'providerToken']=fresh;
 console.log(kind==='upload'?'upload: disposable project-admin with dedicated unrestricted upload-proof policy; clinical role tag permits chart.write':'provider: canonical synced provider policy');
}
writeFileSync('.odos/s3c2c2a2/browser-session.json',JSON.stringify(session),{mode:0o600});
