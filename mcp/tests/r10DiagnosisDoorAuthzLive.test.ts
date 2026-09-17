import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import type { AccessPolicy, Condition, Encounter, Observation, Patient, Resource } from '@medplum/fhirtypes';
import { ODOS_PRACTICE_ROLE_SYSTEM, buildMedplumAccessPolicy, buildMedplumCompositeAccessPolicy, getRoleDeclaration } from '../src/authz/roles.js';
import { createMedplumClient } from '../src/fhir-client.js';
import { buildEncounterDiagnosisCondition } from '../src/fhir/condition.js';
import { searchAll } from '../src/fhir-search.js';
import { handleDiagnosisFindingsMutationRequest, type DiagnosisFindingsEndpointDeps } from '../src/clinical-graph/diagnosis-findings-endpoint.js';
import { handleDiagnosisPickRequest, DIAGNOSIS_KEY_IDENTIFIER_SYSTEM } from '../src/clinical-graph/diagnosis-pick-endpoint.js';
import { loadEncounterFindingState, projectCurrentFindings } from '../src/clinical-graph/current-finding-reader.js';
import { SUPPORTS_DIAGNOSIS_URL, type CurrentFindingKey } from '../src/clinical-graph/current-finding-identity.js';
import { createLiveAuthorizationClients, requireMedplumAdmin } from './integration-helpers.js';
import { createRoleClient, cleanupReferences } from './liveRoleClient.js';
import { TEST_FHIR_AUDIT_CONTEXT, TEST_FHIR_AUDIT_RECORDER } from './fhirAuditTestStub.js';
import { atomic, definitions, catalog, nuclear } from './fixtures/r10/factories.js';

function canonicalRolePolicies(policies: AccessPolicy[], role: 'staff' | 'provider'): AccessPolicy[] {
  return policies.filter(policy => {
    const roleTags = policy.meta?.tag?.filter(tag => tag.system === ODOS_PRACTICE_ROLE_SYSTEM) ?? [];
    return roleTags.length === 1 && roleTags[0]?.code === role;
  });
}

test('W7 live policy selection excludes composite role policies', () => {
  const staff = buildMedplumAccessPolicy(getRoleDeclaration('staff'));
  const provider = buildMedplumAccessPolicy(getRoleDeclaration('provider'));
  const composite = buildMedplumCompositeAccessPolicy(['staff', 'provider']);
  const policies = [composite, staff, provider];
  assert.deepEqual(canonicalRolePolicies(policies, 'staff').map(policy => policy.name), [staff.name]);
  assert.deepEqual(canonicalRolePolicies(policies, 'provider').map(policy => policy.name), [provider.name]);
});

const baseUrl=process.env.MEDPLUM_BASE_URL?.replace(/\/$/,'')??'http://localhost:8103';
test('R10 diagnosis door enforces canonical policies through real handlers for staff and provider',async t=>{
  const credentials=requireMedplumAdmin(t,'r10DiagnosisDoorAuthzLive');if(!credentials)return;
  assert.ok(['localhost','127.0.0.1'].includes(new URL(baseUrl).hostname),'Synthetic local stack only');
  const {seederFhir,seederAccessToken,callerFhir,callerAccessToken}=await createLiveAuthorizationClients({baseUrl,...credentials});
  const projectId=await callerFhir.getActiveProjectId();
  const me=await fetch(`${baseUrl}/auth/me`,{headers:{Authorization:`Bearer ${callerAccessToken}`}}).then(r=>r.json()) as {profile:Resource};
  assert.equal(me.profile.resourceType,'Practitioner');assert.ok(me.profile.id);
  const staffReference=`Practitioner/${me.profile.id}`;
  const cleanup:string[]=[];const track=<T extends Resource>(r:T):T=>{assert.ok(r.id);cleanup.push(`${r.resourceType}/${r.id}`);return r;};
  const policies=await searchAll<AccessPolicy>(callerFhir,'AccessPolicy',{_project:projectId});
  let bodyFailure: unknown;
  try {
    for(const role of ['staff','provider'] as const) await t.test(`${role}: assert clear revive move link and zero-write refusals`,async()=>{
      const matches=canonicalRolePolicies(policies,role);
      assert.equal(matches.length,1);const policy=matches[0];assert.ok(policy.id);
      assert.deepEqual(policy.resource,buildMedplumAccessPolicy(getRoleDeclaration(role)).resource,'Stored policy equals CI canonical policy');
      const policyReference=`AccessPolicy/${policy.id}`;
      const patient=track(await seederFhir.create<Patient>({resourceType:'Patient',name:[{family:'R10Synthetic'}]}));
      const patientReference=`Patient/${patient.id}`;
      const {token}=await createRoleClient({baseUrl,roleId:role,policyReference,patientReference,practitionerReference:staffReference,projectId,runId:randomUUID(),adminToken:callerAccessToken,track});
      const real=createMedplumClient({baseUrl,accessToken:token,audit:TEST_FHIR_AUDIT_RECORDER,auditContext:TEST_FHIR_AUDIT_CONTEXT});
      const writes:Array<{type:string;method:string}>=[];let loseNext=false,lost=false;
      const fhir={...real,
        search:async(...args:Parameters<typeof real.search>)=>{if(lost)throw new Error('Synthetic lost response lookup');return real.search(...args);},
        read:async(...args:Parameters<typeof real.read>)=>{if(lost)throw new Error('Synthetic lost response lookup');return real.read(...args);},
        createWithOutcome:async(resource:Resource,headers?:Record<string,string>)=>{
          writes.push({type:resource.resourceType,method:'POST'});const saved=await real.createWithOutcome(resource,headers);
          if(resource.resourceType==='Observation'&&saved.created)track(saved.resource);
          if(resource.resourceType==='Provenance'&&saved.created)track(saved.resource);
          if(loseNext&&resource.resourceType==='Observation'){loseNext=false;lost=true;throw new Error('Synthetic lost write response');}
          return saved;
        },
        create:async(resource:Resource,headers?:Record<string,string>)=>{writes.push({type:resource.resourceType,method:'POST'});return track(await real.create(resource,headers));},
        update:async(type:Resource['resourceType'],id:string,resource:Resource,headers?:Record<string,string>)=>{writes.push({type,method:'PUT'});return real.update(type,id,resource,headers);},
      } as typeof real;
      const deps:DiagnosisFindingsEndpointDeps={fhirBaseUrl:baseUrl,authenticate:async()=>({staffReference,actorRole:role,fhir}),findingDefinitions:()=>definitions};
      const encounter=async()=>track(await seederFhir.create<Encounter>({resourceType:'Encounter',status:'in-progress',class:{code:'AMB'},subject:{reference:patientReference},participant:[{individual:{reference:staffReference}}]}));
      const e=await encounter();const encounterReference=`Encounter/${e.id}`;
      const key=(eye:'OD'|'OS'='OD'):CurrentFindingKey=>({v:1,patientId:patient.id!,encounterId:e.id!,stableKey:nuclear.findingDefinitionKey,fieldCode:nuclear.fieldCode,optionCode:nuclear.optionCode,eye});
      const homes=await Promise.all(['A','B'].map(label=>seederFhir.create<Condition>(buildEncounterDiagnosisCondition({patientReference,encounterReference,code:{text:`Synthetic home ${label}`},verificationStatus:'confirmed',identifiers:[{system:DIAGNOSIS_KEY_IDENTIFIER_SYSTEM,value:`${e.id}::${nuclear.diagnosisKeys[0]}::right`}]})).then(track)));
      const refs=homes.map(c=>`Condition/${c.id}`);
      const facts=async()=>{const s=await loadEncounterFindingState(real,{patientReference,encounterReference,definitions,catalog,includeAuditState:true});assert.equal(s.incomplete,false);return projectCurrentFindings(s).currentFacts;};
      const fact=async(eye='OD')=>(await facts()).find(f=>f.eye===eye)!;
      const send=(body:unknown,encounterId=e.id)=>handleDiagnosisFindingsMutationRequest(deps,{authHeader:'synthetic',params:{encounterId},body});
      const target=(baseline:unknown,state:unknown,eye:'OD'|'OS'='OD')=>({kind:'fact',key:key(eye),baseline,state});
      const command=(operation:string,targets:unknown[],selected?:string,extra={})=>({commandId:randomUUID(),patientReference,operation,targets,...(selected?{context:{selectedConditionReference:selected}}:{}),...extra});
      const observationWrites=()=>writes.filter(w=>w.type==='Observation').length;
      const evidence=(operation:string,reference:string,before:string,after:string)=>t.diagnostic(JSON.stringify({role,project:projectId,resourceType:reference.split('/')[0],reference,operation,before,after,policyReference,policyVersion:policy.meta?.versionId,lane:'test:live-authz',blocking:true}));
      const state={status:'live',presence:'present',qualifiers:{},homes:[refs[0]]};
      let result=await send(command('assert',[target({kind:'absent',key:key()},state)],refs[0]));assert.equal(result.status,200,JSON.stringify(result.body));
      let current=await fact();assert.equal(current.baseline?.kind,'canonical');let reference=current.contributors[0].reference;
      assert.equal((await real.read<Observation>('Observation',reference.slice(12))).status,'preliminary');evidence('assert',reference,'absent','preliminary');
      result=await send(command('clear',[target(current.baseline,{...state,status:'retired'})]));assert.equal(result.status,200,JSON.stringify(result.body));
      assert.equal((await real.read<Observation>('Observation',reference.slice(12))).status,'entered-in-error');evidence('clear',reference,'preliminary','entered-in-error');
      current=await fact();result=await send(command('assert',[target(current.baseline,{...state,homes:[refs[1]]})],refs[1]));assert.equal(result.status,200,JSON.stringify(result.body));
      assert.equal((await real.read<Observation>('Observation',reference.slice(12))).status,'preliminary');evidence('revive',reference,'entered-in-error','preliminary');
      current=await fact();result=await send(command('move',[target(current.baseline,state)],refs[0]));assert.equal(result.status,200,JSON.stringify(result.body));evidence('move',reference,refs[1],refs[0]);
      current=await fact();result=await send(command('link',[target(current.baseline,{...state,homes:refs})],refs[1]));assert.equal(result.status,200,JSON.stringify(result.body));
      assert.deepEqual((await real.read<Observation>('Observation',reference.slice(12))).extension?.filter(x=>x.url===SUPPORTS_DIAGNOSIS_URL).map(x=>x.valueReference?.reference).sort(),[...refs].sort());evidence('link',reference,refs[0],refs.join(','));
      assert.equal(writes.filter(w=>w.type==='Condition').length,0);
      if(role==='staff') {
        const count=writes.length;
        const pick=await handleDiagnosisPickRequest({authenticate:deps.authenticate,diagnosisVisitStatusStore:{} as any} as any,{authHeader:'synthetic',params:{encounterId:e.id},body:{diagnosisKey:nuclear.diagnosisKeys[0],action:'confirm'}});
        assert.equal(pick.status,403);assert.equal(writes.length,count);
        await assert.rejects(real.update('Condition',homes[0].id!,{...homes[0],note:[{text:'Synthetic denied mutation'}]}),(error:any)=>error.status===403);
        t.diagnostic(JSON.stringify({role,project:projectId,resourceType:'Condition',operation:'update/pick',before:'unchanged',after:'403 unchanged',policyReference,policyVersion:policy.meta?.versionId,lane:'test:live-authz',blocking:true}));
      }
      for(const status of ['final','cancelled'] as const) {
        const stored=await seederFhir.read<Observation>('Observation',reference.slice(12));const saved=await seederFhir.update('Observation',stored.id!,{...stored,status});
        const count=writes.length;
        result=await send(command('assert',[target({kind:'canonical',reference,versionId:saved.meta!.versionId},{...state,homes:refs})],refs[0]));
        assert.equal(result.status,422,JSON.stringify(result.body));assert.equal(writes.length,count);evidence('signed-or-cancelled refusal',reference,status,status);
      }
      const legacyEncounter=await encounter();const legacy=atomic();delete legacy.id;delete legacy.meta;
      track(await seederFhir.create({...legacy,subject:{reference:patientReference},encounter:{reference:`Encounter/${legacyEncounter.id}`}}));
      const legacyKey={...key(),encounterId:legacyEncounter.id!};const count=writes.length;
      result=await send(command('assert',[{kind:'fact',key:legacyKey,baseline:{kind:'absent',key:legacyKey},state:{...state,homes:[]}}]),legacyEncounter.id);
      assert.equal(result.status,409,JSON.stringify(result.body));assert.equal(writes.length,count);evidence('pre-rebuild refusal',`Encounter/${legacyEncounter.id}`,'legacy read-only','409 unchanged');
      const race=await encounter();const rk=(eye:'OD'|'OS')=>({...key(eye),encounterId:race.id!});
      const raceTarget=(eye:'OD'|'OS',presence:string)=>({kind:'fact',key:rk(eye),baseline:{kind:'absent',key:rk(eye)},state:{status:'live',presence,qualifiers:{},homes:[]}});
      assert.equal((await send(command('assert',[raceTarget('OD','present')]),race.id)).status,200);
      const odPage=await loadEncounterFindingState(real,{patientReference,encounterReference:`Encounter/${race.id}`,definitions,catalog});const od=projectCurrentFindings(odPage).currentFacts[0];
      assert.equal((await send(command('assert',[raceTarget('OS','absent')]),race.id)).status,200);
      const beforeRace=writes.length;
      const collision=await send(command('eye-change',[raceTarget('OS','present'),{kind:'fact',key:rk('OD'),baseline:od.baseline,state:{status:'retired',presence:'present',qualifiers:{},homes:[]}}],undefined,{eyes:{from:['OD'],to:['OS']}}),race.id);
      assert.equal(collision.status,409,JSON.stringify(collision.body));assert.equal((collision.body as any).reason,'destination-differs');assert.equal(writes.length,beforeRace);
      t.diagnostic(JSON.stringify({role,project:projectId,resourceType:'Observation',operation:'two-tab eye-change',before:'OS differs',after:'409 zero writes',policyReference,policyVersion:policy.meta?.versionId,lane:'test:live-authz',blocking:true}));
      const retryEncounter=await encounter();const retryKey={...key(),encounterId:retryEncounter.id!};
      const retryBody=command('assert',[{kind:'fact',key:retryKey,baseline:{kind:'absent',key:retryKey},state:{status:'live',presence:'present',qualifiers:{},homes:[]}}]);
      const beforeRetry=observationWrites();loseNext=true;
      const uncertain=await send(retryBody,retryEncounter.id);assert.equal(uncertain.status,502,JSON.stringify(uncertain.body));lost=false;
      const retried=await send(retryBody,retryEncounter.id);assert.equal(retried.status,200,JSON.stringify(retried.body));assert.equal(observationWrites()-beforeRetry,1);
      const persisted=await searchAll<Observation>(real,'Observation',{encounter:`Encounter/${retryEncounter.id}`});assert.equal(persisted.length,1);
      t.diagnostic(JSON.stringify({role,project:projectId,resourceType:'Observation',operation:'lost response then identical Retry',before:'absent',after:'one persisted owner and one clinical write',policyReference,policyVersion:policy.meta?.versionId,lane:'test:live-authz',blocking:true}));
    });
  } catch (error) {
    bodyFailure = error;
    throw error;
  } finally {
    const failures: unknown[] = [];
    for (const [token, references] of [
      [callerAccessToken, cleanup.filter(r => r.startsWith("ProjectMembership/"))],
      [seederAccessToken, cleanup.filter(r => !r.startsWith("ProjectMembership/"))],
    ] as const) {
      try { await cleanupReferences(baseUrl, token, references); }
      catch (error) { failures.push(error); }
    }
    if (failures.length) throw new AggregateError(bodyFailure === undefined ? failures : [bodyFailure, ...failures], "Synthetic live-proof cleanup failed.");
  }
});
