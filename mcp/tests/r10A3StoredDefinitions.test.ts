import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import type { Observation } from '@medplum/fhirtypes';
import { endpointWriteFixture } from './fixtures/r10/endpoint-write-path-runtime.js';
import { keyFor, command, factTarget } from './fixtures/r10/writer-harness.js';
import { lens, lensField, nuclear } from './fixtures/r10/factories.js';
import { AUTH } from './encounterVoidFixture.js';
import { buildFindingDefinitionResource } from '../src/clinical-graph/finding-definition-store.js';
import { executeFindingCommand } from '../src/clinical-graph/current-finding-writer.js';
import { materializeAtomicFindingCatalog, handleDiagnosisFindingsReadRequest, handleDiagnosisFindingsMutationRequest, handleDiagnosisFindingsAuditRepairRequest } from '../src/clinical-graph/diagnosis-findings-endpoint.js';
import { handleDiagnosisPickRequest } from '../src/clinical-graph/diagnosis-pick-endpoint.js';
import { handleDiagnosisCandidatesRequest } from '../src/clinical-graph/diagnosis-candidates-endpoint.js';

for(const path of ['read','write','repair','candidates','pick'] as const) test(`W114 ${path} resolves a practice-only option through its real store dependency`,async()=>{
  const c=await endpointWriteFixture(`W114-${path}`,true);
  const key=keyFor('OD','runtime-practice');
  const definition=c.definitions.find(d=>d.stableKey===lens.stableKey)!;
  c.fhir.replace({...buildFindingDefinitionResource({...definition,diagnosisCandidates:[{id:'practice-runtime',origin:'practice',active:true,diagnosisKey:nuclear.diagnosisKeys[0],trigger:{kind:'option',field:lensField,anyOf:[key.optionCode]}}]}),id:'runtime-definition'});
  const deps={...c.deps,findingDefinitions:undefined};
  const input={authHeader:AUTH,params:{encounterId:'e1'}};
  if(path!=='write'){
    if(path==='repair')c.fhir.beforeWrite=r=>{if(r.resourceType==='Provenance')throw Error('Synthetic audit failure');};
    const seeded=await executeFindingCommand({fhir:c.client as any,definitions:c.definitions,catalog:materializeAtomicFindingCatalog(c.definitions),staffReference:'Practitioner/doc1'},command([factTarget(key)]) as any);
    assert.equal(seeded.outcomes[0].reference?.startsWith('Observation/'),true);
    c.fhir.beforeWrite=undefined;
  }
  if(path==='read'){
    const response=await handleDiagnosisFindingsReadRequest(deps as any,{...input,query:{}});
    assert.equal(response.status,200,JSON.stringify(response.body));
    const row=(response.body as any).searchIndex.find((r:any)=>r.key?.optionCode===key.optionCode&&r.eye==='OD');
    assert.ok(row,'practice-only option must resolve in the real read catalog');assert.equal(row.kind,'fact');assert.equal(row.editable,true);
  }else if(path==='write'){
    const response=await handleDiagnosisFindingsMutationRequest(deps as any,{...input,body:{commandId:randomUUID(),patientReference:'Patient/p1',operation:'assert',targets:[factTarget(key)]}});
    assert.equal(response.status,200,JSON.stringify(response.body));assert.equal((response.body as any).complete,true);
  }else if(path==='repair'){
    const response=await handleDiagnosisFindingsAuditRepairRequest(deps as any,{...input,body:{commandId:randomUUID(),patientReference:'Patient/p1'}});
    assert.equal(response.status,200,JSON.stringify(response.body));assert.equal((response.body as any).complete,true);assert.equal(c.fhir.all('Provenance').length,1);
  }else if(path==='candidates'){
    const response=await handleDiagnosisCandidatesRequest(deps as any,input);
    assert.equal(response.status,200,JSON.stringify(response.body));
    const candidates=(response.body as any).findings.flatMap((r:any)=>r.candidates);
    assert.ok(candidates.some((r:any)=>r.supportingFacts?.some((f:any)=>f.key.optionCode===key.optionCode)),'practice-only fact must support the stored mapping');
  }else{
    const owner=c.fhir.all<Observation>('Observation')[0];
    const response=await handleDiagnosisPickRequest({...deps,diagnosisVisitStatusStore:{listByEncounter:async()=>[],upsert:async()=>{throw Error('Unexpected status mutation');}}} as any,{...input,body:{commandId:randomUUID(),diagnosisKey:nuclear.diagnosisKeys[0],action:'confirm',source:'mapping',supportingFacts:[{key,baseline:{kind:'canonical',reference:`Observation/${owner.id}`,versionId:owner.meta!.versionId}}]}});
    assert.equal(response.status,200,JSON.stringify(response.body));assert.equal((response.body as any).conditionStep,'applied');
  }
});
