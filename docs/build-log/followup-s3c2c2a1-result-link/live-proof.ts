import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { createLiveAuthorizationClients } from '../../../mcp/tests/integration-helpers.js';
import { createRoleClient, clientCredentialsToken } from '../../../mcp/tests/liveRoleClient.js';
import { createMedplumClient } from '../../../mcp/src/fhir-client.js';
import { TEST_FHIR_AUDIT_RECORDER, TEST_FHIR_AUDIT_CONTEXT } from '../../../mcp/tests/fhirAuditTestStub.js';
import { FhirFollowUpProfileStore } from '../../../mcp/src/clinical-graph/follow-up-profile-store.js';
import { FhirEncounterExamScopeStore } from '../../../mcp/src/clinical-graph/exam-scope-store.js';
import { resolveProfileTests } from '../../../mcp/src/clinical-graph/exam-overview-endpoint.js';
import { buildProcedureFeeDefinition } from '../../../mcp/src/clinical-graph/procedure-fee-schedule.js';
import { handleFollowUpAcceptRequest } from '../../../mcp/src/clinical-graph/protocol-endpoint.js';
import { handleFollowUpQueueRequest, handleFollowUpResultRequest } from '../../../mcp/src/clinical-graph/follow-up-queue-endpoint.js';
import { handleImagingCaptureRequest } from '../../../mcp/src/clinical-graph/imaging-endpoint.js';
import { PgBinaryAttemptStore } from '../../../mcp/src/legacy-import/binary-attempt-store.js';
const baseUrl=process.env.MEDPLUM_BASE_URL!;
const {seederFhir:admin,callerAccessToken}=await createLiveAuthorizationClients({baseUrl,email:process.env.MEDPLUM_ADMIN_EMAIL!,password:process.env.MEDPLUM_ADMIN_PASSWORD!});
const practitioner=await admin.create({resourceType:'Practitioner',name:[{text:'Synthetic result clinician'}]});
const patient=await admin.create({resourceType:'Patient',name:[{text:'Synthetic result proof'}]});
const patientReference=`Patient/${patient.id}`;
const staffReference=`Practitioner/${practitioner.id}`;
const encounter=await admin.create({resourceType:'Encounter',status:'in-progress',class:{code:'AMB'},subject:{reference:patientReference},period:{start:new Date().toISOString()}});
const encounterReference=`Encounter/${encounter.id}`;
const policies=await admin.search('AccessPolicy',{_count:'1000'});
const matches=policies.entry!.map(e=>e.resource as any).filter(p=>p.meta?.tag?.some(t=>t.system==='https://odos2020.com/fhir/NamingSystem/practice-role'&&t.code==='provider')&&p.meta.tag.filter(t=>t.system==='https://odos2020.com/fhir/NamingSystem/practice-role').length===1);
assert.equal(matches.length,1); const policy=matches[0];
const {token}=await createRoleClient({baseUrl,roleId:'provider',policyReference:`AccessPolicy/${policy.id}`,patientReference,practitionerReference:staffReference,projectId:process.env.MEDPLUM_PROJECT_ID!,runId:encounter.id!,adminToken:callerAccessToken,track:r=>r});
const fhir=createMedplumClient({baseUrl,accessToken:token,audit:TEST_FHIR_AUDIT_RECORDER,auditContext:TEST_FHIR_AUDIT_CONTEXT});
const authenticate=async()=>({staffReference,actorRole:'provider' as const,fhir,binaryAuth:{baseUrl,accessToken:token}});
const deps={authenticate,serviceFhir:admin};
const input={authHeader:`Bearer ${token}`,params:{encounterId:encounter.id}};
const profiles=(await new FhirFollowUpProfileStore(admin).list()).filter(p=>['glaucoma','macula-retina'].includes(p.profileKey));
await new FhirEncounterExamScopeStore(admin).pick(encounter.id!,'office-visit',{reference:staffReference},null,profiles,resolveProfileTests(profiles));
for(const key of ['visual-field-threshold','fundus-photography']) await admin.create(buildProcedureFeeDefinition({procedureConceptKey:key,display:key,billingCode:'SYNTHETIC',priceCents:100,active:true}));
const vf={orderable:'visual-field-threshold'}, retina={orderable:'fundus-photography',focus:'retina'};
for(const body of [vf,retina]) {const r=await handleFollowUpAcceptRequest(deps,{...input,body});assert.equal(r.status,200,JSON.stringify(r));}
const orders=await fhir.search('ServiceRequest',{encounter:encounterReference});
const vfOrder=orders.entry!.map(e=>e.resource as any).find(r=>r.code?.text===vf.orderable);
assert.ok(vfOrder?.id);
const basedOnReference=`ServiceRequest/${vfOrder.id}`;
const attempts=new PgBinaryAttemptStore({postgresUrl:process.env.ODOS_POSTGRES_URL});
const jpeg='/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////2wBDAf//////////////////////////////////////////////////////////////////////////////////////wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAX/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIQAxAAAAF//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABBQJ//8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAwEBPwF//8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAgEBPwF//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQAGPwJ//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPyF//9oADAMBAAIAAwAAABD/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oACAEDAQE/EH//xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oACAECAQE/EH//xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAE/EH//2Q==';
const clientResponse=await fetch(`${baseUrl}admin/projects/${process.env.MEDPLUM_PROJECT_ID}/client`,{method:'POST',headers:{Authorization:`Bearer ${callerAccessToken}`,'Content-Type':'application/json'},body:JSON.stringify({name:'Synthetic project-admin upload proof'})});
assert.equal(clientResponse.status,201);const uploadClient=await clientResponse.json();
let uploadToken=await clientCredentialsToken(baseUrl,uploadClient.id,uploadClient.secret,'admin');
const uploadMe=await (await fetch(`${baseUrl}auth/me`,{headers:{Authorization:`Bearer ${uploadToken}`}})).json();
const membershipUrl=`${baseUrl}admin/projects/${process.env.MEDPLUM_PROJECT_ID}/members/${uploadMe.membership.id}`;
const membership=await (await fetch(membershipUrl,{headers:{Authorization:`Bearer ${callerAccessToken}`}})).json();
const adminMembershipResponse=await fetch(membershipUrl,{method:'POST',headers:{Authorization:`Bearer ${callerAccessToken}`,'Content-Type':'application/fhir+json'},body:JSON.stringify({...membership,admin:true})});
assert.equal(adminMembershipResponse.status,200);
assert.equal((await adminMembershipResponse.json()).admin,true);
uploadToken=await clientCredentialsToken(baseUrl,uploadClient.id,uploadClient.secret,'admin');
const uploadFhir=createMedplumClient({baseUrl,accessToken:uploadToken,audit:TEST_FHIR_AUDIT_RECORDER,auditContext:TEST_FHIR_AUDIT_CONTEXT});
const uploadAuthenticate=async()=>({staffReference,actorRole:'provider' as const,fhir:uploadFhir,binaryAuth:{baseUrl,accessToken:uploadToken}});
async function capture(extra:any={},provider=false) {return handleImagingCaptureRequest({authenticate:provider?authenticate:uploadAuthenticate,binaryAttempts:attempts},{authHeader:provider?input.authHeader:`Bearer ${uploadToken}`,body:{patientReference,encounterReference,category:'visual-field',file:{name:'synthetic.jpg',contentType:'image/jpeg',data:jpeg},...extra}});}
async function queue(){const r=await handleFollowUpQueueRequest(deps,input);assert.equal(r.status,200,JSON.stringify(r));return (r.body as any).rows;}
function row(rows:any[],key:any){return rows.find(r=>r.orderable===key.orderable&&(r.focus??'')===(key.focus??''));}
function quote(step:string,body:any){console.log(JSON.stringify({step,...body}));}
try {
 const upload=await capture({basedOnReference,interpretation:'Synthetic field report interpretation.'});assert.equal(upload.status,200,JSON.stringify(upload));
 let rows=await queue();assert.equal(row(rows,vf).result.status,'interpreted');assert.equal(row(rows,vf).result.items.length,1);quote('1',{row:row(rows,vf)});
 const photo=await capture({category:'fundus-photo'});assert.equal(photo.status,200,JSON.stringify(photo));const mediaReference=(photo.body as any).mediaReference;
 const optic={orderable:'fundus-photography',focus:'optic nerve'};
 rows=await queue();assert.equal(row(rows,retina).result.candidates.length,1);assert.equal(row(rows,optic).unreviewedResult,true);quote('2 candidate',{retina:row(rows,retina),optic:row(rows,optic)});
 for(const action of ['link','unlink']){const r=await handleFollowUpResultRequest(deps,{...input,body:{...retina,mediaReference,action}});assert.equal(r.status,200,JSON.stringify(r));rows=(r.body as any).rows;assert.equal(row(rows,retina).result.status,action==='link'?'needs-interpretation':'none');assert.equal(row(rows,optic).state,'for-review');assert.equal(row(rows,optic).unreviewedResult,action==='link'?undefined:true);quote(`2 ${action}`,{retina:row(rows,retina),optic:row(rows,optic)});}
 const pdf=await capture({basedOnReference,file:{name:'synthetic-haag-streit-report.pdf',contentType:'application/pdf',data:Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF').toString('base64')}});assert.equal(pdf.status,200,JSON.stringify(pdf));const stored=await fhir.read('Media',(pdf.body as any).mediaReference.slice(6));assert.deepEqual((stored as any).basedOn,[{reference:basedOnReference}]);quote('3 PDF',{status:pdf.status,mediaReference:(pdf.body as any).mediaReference,basedOn:(stored as any).basedOn,contentType:(stored as any).content.contentType});
 async function counts(){return JSON.parse(execFileSync('docker',['exec','odos-s3c2c2a1-live-postgres-1','psql','-U','medplum','-d','medplum','-Atc',`SELECT json_build_object('Binary',(SELECT count(*) FROM "Binary"),'Media',(SELECT count(*) FROM "Media"));`],{encoding:'utf8'}));}
 const before=await counts();const refused=await capture({basedOnReference,category:'oct'},true);const after=await counts();assert.equal(refused.status,409);assert.deepEqual(after,before);quote('4 mismatch',{...refused,before,after});
 await fhir.update('Encounter',encounter.id!,{...encounter,status:'finished'});const signed=await handleFollowUpResultRequest(deps,{...input,body:{...retina,mediaReference,action:'link'}});assert.equal(signed.status,409);quote('4 signed',signed);
} finally {await attempts.close();}
