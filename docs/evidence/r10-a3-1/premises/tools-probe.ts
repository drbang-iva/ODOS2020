import assert from 'node:assert/strict';
import { projectCurrentFindings } from '../../../mcp/src/clinical-graph/current-finding-reader.js';
import { diagnosisDefinitionViews } from '../../../mcp/src/clinical-graph/diagnosis-candidates-endpoint.js';
import { FINDING_PANEL_SYSTEM } from '../../../mcp/src/clinical-graph/current-finding-identity.js';
import { definitions, lens, snapshot, state, comp } from '../../../mcp/tests/fixtures/r10/factories.js';
import { handleCustomSectionCaptureRequest } from '../../../mcp/src/clinical-graph/custom-section-endpoint.js';
import { customFieldEntries } from '../../../mcp/src/clinical-graph/custom-fields.js';
import { fixture, observation, AUTH } from '../../../mcp/tests/encounterVoidFixture.js';
import { handleEncounterVoidRequest } from '../../../mcp/src/clinical-graph/encounter-void-endpoint.js';
import { handleEncounterUndoRequest } from '../../../mcp/src/clinical-graph/encounter-undo-endpoint.js';

const panel = { ...snapshot('panel-only', []), identifier: [{system:FINDING_PANEL_SYSTEM,value:'synthetic-panel'}], component: [comp('EXAM_STATE','normal'),comp('OTHER','Synthetic panel')] };
const projected = projectCurrentFindings(state([panel]));
const candidateViews = diagnosisDefinitionViews(projected, definitions);
assert.equal(projected.panels.length,1); assert.equal(projected.definitionViews.length,0); assert.equal(candidateViews.length,0);
console.log(JSON.stringify({premise:'P23',panels:projected.panels.length,definitionViews:projected.definitionViews.length,candidateViews:candidateViews.length,preRebuild:projected.preRebuild}));

const resources:any[] = [];
const writeAttempts:any[] = [];
const fhir:any = {
 baseUrl:'memory://fhir',
 async read(type:string,id:string) { const found=resources.find(r=>r.resourceType===type&&r.id===id); if(!found) throw Object.assign(new Error('missing'),{status:404}); return structuredClone(found); },
 async search(type:string,params:any={}) { const rows=resources.filter(r=>r.resourceType===type).filter(r=>!params.subject||r.subject?.reference===params.subject).filter(r=>!params.encounter||r.encounter?.reference===params.encounter).filter(r=>!params.identifier||r.identifier?.some((i:any)=>`${i.system}|${i.value}`===params.identifier)); return {resourceType:'Bundle',type:'searchset',entry:rows.map(resource=>({resource:structuredClone(resource)}))}; },
 async create(resource:any,headers:any={}) { writeAttempts.push({resourceType:resource.resourceType,headers}); const params=new URLSearchParams(headers['If-None-Exist']??''); const existing=resources.find(r=>r.resourceType===resource.resourceType&&(params.has('identifier')?r.identifier?.some((i:any)=>`${i.system}|${i.value}`===params.get('identifier')):params.has('target')?r.target?.some((t:any)=>t.reference===params.get('target')):false)); if(existing)return structuredClone(existing); const saved={...structuredClone(resource),id:resource.id??`synthetic-${resources.length+1}`};resources.push(saved);return structuredClone(saved); }
};
const optionCodes=customFieldEntries(lens).filter(f=>f.valueType==='multi-select').flatMap(f=>(f.options??[]).filter(o=>o.active).map(o=>o.code));
const negativeAct={id:'00000000-0000-4000-8000-000000000001',definitionStableKey:lens.stableKey,eye:'OD',optionCodes,exclusions:[],assertedAt:'2026-09-15T12:00:00.000Z'};
const request={authHeader:AUTH,params:{stableKey:lens.stableKey},body:{patientReference:'Patient/p1',encounterReference:'Encounter/e1',eyes:{OD:{state:'normal',customFields:[],negativeAct}}}};
const statuses=[];
for(const actor of ['Practitioner/synthetic-a','Practitioner/synthetic-b']){
const response=await handleCustomSectionCaptureRequest({authenticate:async()=>({staffReference:actor,actorRole:'provider',fhir}),findingDefinitions:()=>definitions,now:()=>negativeAct.assertedAt},request);
assert.equal(response.status,200,JSON.stringify(response.body));statuses.push(response.status);
}
const observations=resources.filter(r=>r.resourceType==='Observation');const provenances=resources.filter(r=>r.resourceType==='Provenance');
assert.equal(observations.length,2);assert.equal(provenances.length,2);assert.notEqual(observations[0].identifier[0].value,observations[1].identifier[0].value);
console.log(JSON.stringify({premise:'P24',sameActId:negativeAct.id,statuses,observations:observations.length,provenances:provenances.length,identifiers:observations.map(r=>r.identifier),writeAttempts:writeAttempts.length}));

const undoFixture=fixture();const params={encounterId:'e1'};const scope={scope:'section',sectionKey:'entrance:pupils'};
undoFixture.fhir.add(observation('first','entrance:pupils','OD',{status:'preliminary'}));
const void1=await handleEncounterVoidRequest(undoFixture.deps,{authHeader:AUTH,params,body:scope});assert.equal(void1.status,200,JSON.stringify(void1.body));
const undo1=await handleEncounterUndoRequest(undoFixture.deps,{authHeader:AUTH,params,body:scope});assert.equal(undo1.status,200,JSON.stringify(undo1.body));
// Change the first target outside the selected section, so V2's target set is observably different.
undoFixture.fhir.replace({...undoFixture.fhir.get<any>('Observation','first'),status:'entered-in-error'});
undoFixture.fhir.add(observation('second','entrance:pupils','OS',{status:'preliminary'}));
const void2=await handleEncounterVoidRequest(undoFixture.deps,{authHeader:AUTH,params,body:scope});assert.equal(void2.status,200,JSON.stringify(void2.body));
const before=undoFixture.fhir.transactions.length;
const delayed=await handleEncounterUndoRequest(undoFixture.deps,{authHeader:AUTH,params,body:scope});assert.equal(delayed.status,200,JSON.stringify(delayed.body));
assert.deepEqual((delayed.body as any).restored,['Observation/second']);
console.log(JSON.stringify({premise:'P25',void1:(void1.body as any).voided,undo1:(undo1.body as any).restored,void2:(void2.body as any).voided,delayedUndoStatus:delayed.status,delayedUndoRestored:(delayed.body as any).restored,transactionDelta:undoFixture.fhir.transactions.length-before,firstStatus:undoFixture.fhir.get<any>('Observation','first').status,secondStatus:undoFixture.fhir.get<any>('Observation','second').status}));

resources.length=0;writeAttempts.length=0;
resources.push({resourceType:'Encounter',id:'e1',status:'finished',class:{},subject:{reference:'Patient/p1'},meta:{versionId:'1'}});
const closedResponse=await handleCustomSectionCaptureRequest({authenticate:async()=>({staffReference:'Practitioner/synthetic-a',actorRole:'provider',fhir}),findingDefinitions:()=>definitions,now:()=>negativeAct.assertedAt},request);
assert.equal(closedResponse.status,200,JSON.stringify(closedResponse.body));
assert.equal(resources.filter(r=>r.resourceType==='Observation').length,1);
assert.equal(resources.filter(r=>r.resourceType==='Provenance').length,1);
console.log(JSON.stringify({premise:'P5',encounterStatus:resources.find(r=>r.resourceType==='Encounter').status,captureStatus:closedResponse.status,observations:resources.filter(r=>r.resourceType==='Observation').length,provenances:resources.filter(r=>r.resourceType==='Provenance').length,writeAttempts:writeAttempts.length}));
