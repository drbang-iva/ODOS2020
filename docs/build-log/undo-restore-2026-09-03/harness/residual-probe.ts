import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import type {AccessPolicy, Encounter, Observation, Patient, Resource} from '@medplum/fhirtypes';
import {createAuthenticatedFhirClient} from '../../../../mcp/tests/integration-helpers.js';
import {createRoleClient, fhirRequest} from '../../../../mcp/tests/liveRoleClient.js';
import {createStaffRouteFhirClient} from '../../../../mcp/src/fhir-client.js';
import {TEST_FHIR_AUDIT_RECORDER} from '../../../../mcp/tests/fhirAuditTestStub.js';
import {searchAll} from '../../../../mcp/src/fhir-search.js';
import {ODOS_PRACTICE_ROLE_SYSTEM} from '../../../../mcp/src/authz/roles.js';
import {handleEncounterVoidRequest} from '../../../../mcp/src/clinical-graph/encounter-void-endpoint.js';
import {handleEncounterUndoRequest} from '../../../../mcp/src/clinical-graph/encounter-undo-endpoint.js';
import {FhirEncounterUndoLedgerStore} from '../../../../mcp/src/clinical-graph/encounter-undo-ledger-store.js';
import {ODOS_OPHTHALMOLOGY_CODE_SYSTEM} from '../../../../mcp/src/fhir/ophthalmology/codeBindings.js';

const baseUrl=process.env.MEDPLUM_BASE_URL!;
assert.equal(baseUrl,'http://localhost:18103/');
const {fhir:adminFhir,accessToken:adminToken}=await createAuthenticatedFhirClient({baseUrl,email:process.env.MEDPLUM_ADMIN_EMAIL!,password:process.env.MEDPLUM_ADMIN_PASSWORD!});
const me=await (await fetch(`${baseUrl}auth/me`,{headers:{Authorization:`Bearer ${adminToken}`}})).json() as {project:{id:string};profile:Resource};
const projectId=me.project.id;
const practitionerReference=`Practitioner/${me.profile.id}`;
const patient=(await searchAll<Patient>(adminFhir,'Patient',{_count:'1000'})).find(p=>p.name?.some(n=>n.family?.startsWith('ContractSearch')))!;
assert.ok(patient?.id);
const patientReference=`Patient/${patient.id}`;
const policies=await searchAll<AccessPolicy>(adminFhir,'AccessPolicy',{_project:projectId,_count:'1000'});
const track=<T extends Resource>(r:T):T=>r;
const tokens=new Map<string,string>();
for(const roleId of ['provider','staff'] as const){
  const policy=policies.find(p=>{const tags=p.meta?.tag?.filter(t=>t.system===ODOS_PRACTICE_ROLE_SYSTEM);return tags?.length===1&&tags[0].code===roleId;})!;
  assert.ok(policy?.id);
  const {token}=await createRoleClient({baseUrl,roleId,policyReference:`AccessPolicy/${policy.id}`,patientReference,practitionerReference,projectId,runId:randomUUID(),adminToken,track});
  tokens.set(roleId,token);
}
for(const roleId of ['provider','staff'] as const){
  const token=tokens.get(roleId)!;
  const roleFhir=createStaffRouteFhirClient({baseUrl,accessToken:token,staffReference:practitionerReference,actorRole:roleId,audit:TEST_FHIR_AUDIT_RECORDER});
  for(const scenario of ['direct-signed-restore','concurrent-observation-edit'] as const){
    const encounter=await roleFhir.create<Encounter>({resourceType:'Encounter',status:'in-progress',class:{code:'AMB',system:'http://terminology.hl7.org/CodeSystem/v3-ActCode'},subject:{reference:patientReference},participant:[{individual:{reference:practitionerReference}}]});
    const observation=await roleFhir.create<Observation>({resourceType:'Observation',status:'preliminary',code:{coding:[{system:ODOS_OPHTHALMOLOGY_CODE_SYSTEM,code:'VISUAL_ACUITY'}]},subject:{reference:patientReference},encounter:{reference:`Encounter/${encounter.id}`},valueString:'20/20'});
    const reference=`Observation/${observation.id}`;
    const authHeader=`Bearer ${token}`;
    const deps={authenticate:async()=>({staffReference:practitionerReference,actorRole:roleId,fhir:roleFhir})};
    const params={encounterId:encounter.id!};
    const clear=await handleEncounterVoidRequest(deps,{authHeader,params,body:{scope:'observation',observationReference:reference}});
    assert.equal(clear.status,200,JSON.stringify(clear.body));
    const before=await new FhirEncounterUndoLedgerStore(roleFhir).get(encounter.id!);
    assert.ok(before.sections.va);
    if(scenario==='direct-signed-restore'){
      const current=await roleFhir.read<Encounter>('Encounter',encounter.id!);
      const signed=await fhirRequest(baseUrl,tokens.get('provider')!,'PUT',`Encounter/${encounter.id}`,{...current,status:'finished'});
      assert.equal(signed.status,200);
      const endpoint=await handleEncounterUndoRequest(deps,{authHeader,params,body:{scope:'section',sectionKey:'va'}});
      assert.equal(endpoint.status,409);
      const voided=await roleFhir.read<Observation>('Observation',observation.id!);
      const direct=await fhirRequest<Observation>(baseUrl,token,'PUT',reference,{...voided,status:'preliminary'});
      const after=await roleFhir.read<Observation>('Observation',observation.id!);
      console.log(JSON.stringify({roleId,scenario,endpointStatus:endpoint.status,directFhirStatus:direct.status,storedStatus:after.status,value:after.valueString}));
      assert.equal(direct.status,200,'Characterization of the explicitly accepted policy gap, not an acceptance guard');
    }else{
      const racingFhir={...roleFhir,executeTransaction:async(...args:Parameters<typeof roleFhir.executeTransaction>)=>{
        // A real concurrent write after Undo reads its targets; no fake response or policy.
        const current=await roleFhir.read<Observation>('Observation',observation.id!);
        const concurrent=await fhirRequest(baseUrl,token,'PUT',reference,{...current,status:'preliminary',valueString:'20/25'});
        assert.equal(concurrent.status,200);
        return roleFhir.executeTransaction(...args);
      }};
      const racingDeps={authenticate:async()=>({staffReference:practitionerReference,actorRole:roleId,fhir:racingFhir})};
      let response:unknown;
      try{response=await handleEncounterUndoRequest(racingDeps,{authHeader,params,body:{scope:'section',sectionKey:'va'}});}catch(error){response=error instanceof Error?error.message:String(error);}
      const after=await new FhirEncounterUndoLedgerStore(roleFhir).get(encounter.id!);
      const stored=await roleFhir.read<Observation>('Observation',observation.id!);
      console.log(JSON.stringify({roleId,scenario,response,slotBefore:!!before.sections.va,slotAfter:!!after.sections.va,storedStatus:stored.status,value:stored.valueString}));
      assert.equal(after.sections.va,undefined,'Characterization: failed Undo consumed the slot on this non-atomic stack');
      assert.equal(stored.valueString,'20/25');
    }
  }
}
