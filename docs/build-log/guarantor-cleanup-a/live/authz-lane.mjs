import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { existsSync,readFileSync,writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { refreshFixtureTokens,successfulHttp,privateDirectory,sourceRoot,writeEvidence } from './live-fixture.mjs';
const f=await refreshFixtureTokens();const statePath=resolve(privateDirectory,'authz-private.json');
let state;
if(existsSync(statePath))state=JSON.parse(readFileSync(statePath,'utf8'));else{
 const project=await successfulHttp(f,'POST','/fhir/R4/Project',{body:{resourceType:'Project',name:'Cleanup A independent authz lane',features:[],link:[]}});
 state={projectId:project.id,email:'cleanup-a-authz@example.invalid',password:randomBytes(30).toString('base64url')+'!Aa1'};
 const member=await successfulHttp(f,'POST',`/admin/projects/${project.id}/invite`,{body:{resourceType:'Practitioner',email:state.email,firstName:'Synthetic',lastName:'Authz',sendEmail:false}});
 await successfulHttp(f,'POST','/admin/super/setpassword',{body:{email:state.email,password:state.password}});
 await successfulHttp(f,'PUT',`/fhir/R4/ProjectMembership/${member.id}`,{body:{...member,admin:true},headers:{'If-Match':`W/"${member.meta.versionId}"`}});
 await successfulHttp(f,'POST','/fhir/R4/Patient',{body:{resourceType:'Patient',meta:{project:project.id},name:[{family:'ContractSearchCleanupA',given:['Synthetic']}]}});
 writeFileSync(statePath,JSON.stringify(state),{mode:0o600});
}
const env={...process.env,MEDPLUM_BASE_URL:f.baseUrl,MEDPLUM_ADMIN_EMAIL:state.email,MEDPLUM_ADMIN_PASSWORD:state.password,MEDPLUM_PROJECT_ID:state.projectId,MEDPLUM_CONTRACT_BOOTSTRAP:'',ODOS_POSTGRES_URL:f.postgresUrl,MEDPLUM_ACCESS_TOKEN:''};
const loader=resolve(sourceRoot,'node_modules/tsx/dist/loader.mjs');
const results=[];
function run(label,args,cwd=privateDirectory){const result=spawnSync(process.execPath,['--import',loader,...args],{cwd,env,encoding:'utf8',maxBuffer:20*1024*1024});let output=result.stdout+'\n'+result.stderr;for(const secret of [state.password,f.servicePassword,f.postgresUrl,...Object.entries(env).filter(([k])=>/SECRET|TOKEN/.test(k)).map(([,v])=>v).filter(Boolean)])output=output.replaceAll(secret,'[REDACTED]');results.push({label,args,exitCode:result.status,output});writeEvidence('authz-lane-results.json',{projectId:state.projectId,results});console.log(JSON.stringify({label,exitCode:result.status,summary:output.split('\n').filter(l=>/^# (tests|pass|fail|skip)|^not ok/.test(l))}));assert.equal(result.status,0,label);}
if(process.argv[2]==='setup'){
 run('operator seeder',[resolve(sourceRoot,'scripts/operator-identity.ts'),'--project',state.projectId]);
 run('canonical role repair',[resolve(sourceRoot,'scripts/repair-practice-roles.ts'),'--email',state.email,'--project',state.projectId]);
 run('canonical policy sync',[resolve(sourceRoot,'scripts/sync-practice-role-policy-rules.ts'),'--project',state.projectId,'--apply','--bootstrap-service-identity']);
}else{
 for(const line of readFileSync(resolve(privateDirectory,'.odos/operator.env'),'utf8').split('\n')){const m=line.match(/^([A-Z_]+)=(.*)$/);if(m)env[m[1]]=m[2].replace(/^['"]|['"]$/g,'');}
 run('full live authz',['scripts/run-tests.mjs','tests/ageOfMajorityAuthzLive.test.ts','tests/clinicalWriteAuthzLive.test.ts','tests/encounterUndoLedgerAuthzLive.test.ts','tests/v05a-authz.test.ts'],resolve(sourceRoot,'mcp'));
}
