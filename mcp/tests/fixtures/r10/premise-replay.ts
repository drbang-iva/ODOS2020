import assert from 'node:assert/strict';
import { handleEncounterVoidRequest } from '../../../src/clinical-graph/encounter-void-endpoint.ts';
import { buildFindingDefinitionSeeds, FhirFindingDefinitionStore, buildFindingDefinitionResource } from '../../../src/clinical-graph/finding-definition-store.ts';
import { customFieldEntries } from '../../../src/clinical-graph/custom-fields.ts';
import { materializeAtomicFindingCatalog, handleDiagnosisFindingsReadRequest, handleDiagnosisFindingsMutationRequest } from '../../../src/clinical-graph/diagnosis-findings-endpoint.ts';
import { findingInstancesFromObservation, handleDiagnosisCandidatesRequest } from '../../../src/clinical-graph/diagnosis-candidates-endpoint.ts';
import { handleDiagnosisPickRequest, DIAGNOSIS_KEY_IDENTIFIER_SYSTEM } from '../../../src/clinical-graph/diagnosis-pick-endpoint.ts';
import { handleDiagnosisCompletenessRequest } from '../../../src/clinical-graph/diagnosis-completeness-endpoint.ts';
import { handleCustomSectionCaptureRequest, handleCustomSectionHistoryRequest } from '../../../src/clinical-graph/custom-section-endpoint.ts';
import { buildExamOverviewProjection } from '../../../src/clinical-graph/exam-overview-projection.ts';
import { FhirDiagnosisCatalogStore, buildDiagnosisCatalogResource } from '../../../src/clinical-graph/diagnosis-catalog-store.ts';
import { buildEncounterDiagnosisCondition } from '../../../src/fhir/condition.ts';
import { translateRetiredFindingRead } from '../../../src/clinical-graph/finding-read-compatibility.ts';
import { buildOcularHealthDefinitions } from '../../../src/clinical-graph/ocular-health-definition.ts';
import { odosConcept } from '../../../src/fhir/ophthalmology/extensions.ts';

// Synthetic in-memory transport only. Clinical shapes and behavior come from production functions.
const copy = (x:any) => structuredClone(x);
class Transport {
  baseUrl = 'https://synthetic.invalid'; rows:any[]=[]; n=0;
  async search(type:string, q:any={}) {
    let rows=this.rows.filter(r=>r.resourceType===type);
    for(const key of ['subject','encounter']) if(q[key]) rows=rows.filter(r=>r[key]?.reference===q[key]);
    if(q.code) {const [system, code]=q.code.split('|');rows=rows.filter(r=>r.code?.coding?.some((c:any)=>code?c.system===system&&c.code===code:c.code===system));}
    if(q.identifier) {const [system,value]=q.identifier.split('|');rows=rows.filter(r=>r.identifier?.some((i:any)=>i.system===system&&i.value===value));}
    if(q._sort==='-date')rows.sort((a,b)=>(b.effectiveDateTime??'').localeCompare(a.effectiveDateTime??''));
    return {resourceType:'Bundle',type:'searchset',entry:copy(rows.map(resource=>({resource})))};
  }
  async read(type:string,id:string) {const r=this.rows.find(r=>r.resourceType===type&&r.id===id);if(!r)throw Error('missing synthetic '+type+'/'+id);return copy(r);}
  async create(r:any) {const row={...copy(r),id:r.id??'synthetic-'+ ++this.n};this.rows.push(row);return copy(row);}
  async update(type:string,id:string,r:any) {const i=this.rows.findIndex(r=>r.resourceType===type&&r.id===id);assert.ok(i>=0);this.rows[i]=copy(r);return copy(r);}
}
const defs=buildFindingDefinitionSeeds();
const catalog=materializeAtomicFindingCatalog(defs);
const lens=defs.find(d=>d.stableKey==='ocular-health:anterior:lens')!;
const cornea=defs.find(d=>d.stableKey==='ocular-health:anterior:cornea')!;
const field=(d:any)=>customFieldEntries(d).find(f=>f.valueType==='multi-select')!;
const lensOption='nuclear-sclerosis';
const atomicId=(d:any,option:string)=>`${d.stableKey}::${field(d).localCode}::${option}`;
const diagnoses=await new FhirDiagnosisCatalogStore(new Transport() as any).list();
const dx=diagnoses.find(d=>d.stableKey==='cataract_nuclear_sclerosis')!;
const context={patientReference:'Patient/p1',encounterReference:'Encounter/e1'};
let now='2026-09-15T10:00:00.000Z';
const deps=(f:any,definitions=defs)=>({fhirBaseUrl:f.baseUrl,authenticate:async()=>({staffReference:'Practitioner/synthetic',actorRole:'provider' as const,fhir:f}),findingDefinitions:()=>definitions,diagnosisCatalog:()=>diagnoses,now:()=>now});
const request={authHeader:'synthetic',params:{encounterId:'e1'}};
function env() {const f=new Transport();f.rows.push({resourceType:'Encounter',id:'e1',status:'in-progress',class:{code:'synthetic'},subject:{reference:'Patient/p1'}});f.rows.push({...buildEncounterDiagnosisCondition({...context,code:{text:dx.display},verificationStatus:'confirmed',identifiers:[{system:DIAGNOSIS_KEY_IDENTIFIER_SYSTEM,value:`e1::${dx.stableKey}::right`}]}),id:'c1'});return f;}
async function capture(f:any,d:any,options:string[],extra:any={}) {
 const r=await handleCustomSectionCaptureRequest(deps(f),{authHeader:'synthetic',params:{stableKey:d.stableKey},body:{...context,eyes:{OD:{state:'abnormal',customFields:options.length?[{code:field(d).localCode,value:options}]:[],...extra}}}});
 assert.equal(r.status,200,JSON.stringify(r.body));return f.read('Observation',(r.body as any).eyes.OD.observationReference.split('/')[1]);
}
async function history(f:any,d:any,definitions=defs) {const r=await handleCustomSectionHistoryRequest(deps(f,definitions),{authHeader:'synthetic',params:{stableKey:d.stableKey},query:{patient:'Patient/p1',encounter:'Encounter/e1'}});assert.equal(r.status,200);return (r.body as any).rows;}
async function mutate(f:any,body:any) {return handleDiagnosisFindingsMutationRequest(deps(f),{...request,body:{patientReference:'Patient/p1',...body}});}
async function atom(f:any,eye='OD',presence='present') {const r=await mutate(f,{action:'assert',conditionReference:'Condition/c1',atomicFindingId:atomicId(lens,lensOption),presence,laterality:eye});assert.equal(r.status,200,JSON.stringify(r.body));return f.read('Observation',(r.body as any).observationReference.split('/')[1]);}
async function get(f:any) {const r=await handleDiagnosisFindingsReadRequest(deps(f),{...request,query:{}});assert.equal(r.status,200);return (r.body as any).bySection[lens.stableKey]??[];}
function overview(rows:any[]) {return buildExamOverviewProjection({...context,definitions:defs,currentObservations:rows,priorObservationCandidates:[],assessmentRows:[]});}
let count=0;function record(name:string,result:any) {count++;console.log(JSON.stringify({probe:count,name,result}));}

const nested=catalog.find(r=>r.optionCode.includes('::'))!;
assert.ok(nested);assert.notEqual(nested.atomicFindingId.split('::')[2],nested.optionCode);
assert.equal(catalog.find(r=>r.atomicFindingId===nested.atomicFindingId)?.optionCode,nested.optionCode);
record('nested catalog identity',{option:nested.optionCode,naiveSplit:nested.atomicFindingId.split('::')[2]});

const f=env();const s=await capture(f,lens,[lensOption]);const a=await atom(f);
assert.equal((await get(f)).length,2);
assert.equal(findingInstancesFromObservation(a,defs).length,0);
const pick=await handleDiagnosisPickRequest({authenticate:deps(f).authenticate,diagnosisVisitStatusStore:{} as any},{...request,body:{findingInstanceId:a.id,diagnosisKey:dx.stableKey,action:'possible'}});
assert.equal(pick.status,422);record('atomic suggestion target rejected by current pick',pick);

const view={...copy(s)};delete view.id;
assert.equal(findingInstancesFromObservation(view,defs).length,0);
assert.equal(overview([view]).findings.length,0);
record('definition view with no id',{candidateInstances:0,overviewFindings:0});

const before=(await get(f)).length;const cleared=await mutate(f,{action:'clear',observationReference:`Observation/${a.id}`});assert.equal(cleared.status,200);
const after=await get(f);assert.equal(after.length,1);assert.equal(after[0].source,'section');
record('agreeing sources then clear atomic',{beforeRows:before,afterRows:after.length,remainingSource:after[0].source,remainingPresence:after[0].presence});
const denied=await mutate(f,{action:'grade',observationReference:`Observation/${s.id}`,grade:'2+'});assert.equal(denied.status,400);
record('snapshot target still rejected by mutation',denied);

const ou=env();const oa=await atom(ou,'OU');assert.equal((await get(ou))[0].laterality,'OU');
assert.equal((await mutate(ou,{action:'clear',observationReference:`Observation/${oa.id}`})).status,200);
assert.equal((await get(ou)).length,0);record('legacy OU one target clear',{resourceEye:'OU',remainingRows:0});
const dupe=env();await atom(dupe,'OU','present');await atom(dupe,'OD','absent');
assert.equal((await get(dupe)).length,2);record('writer can produce OD-OU contradiction',(await get(dupe)).map((r:any)=>({eye:r.laterality,presence:r.presence})));

const neg=env();now='2026-09-15T10:00:00.000Z';await capture(neg,lens,[lensOption]);now='2026-09-15T11:00:00.000Z';
const act={id:'00000000-0000-4000-8000-000000000001',definitionStableKey:lens.stableKey,eye:'OD',optionCodes:[lensOption],exclusions:[],assertedAt:now};
const n=await capture(neg,lens,[],{state:'normal',negativeAct:act});
assert.equal((await get(neg)).length,0);const nh=await history(neg,lens);assert.equal(nh[0].state,'normal');assert.deepEqual(nh[0].negativeAct.optionCodes,[lensOption]);
record('real negative capture hides older snapshot today',{identifier:n.identifier[0].system,falseCodes:n.component.filter((c:any)=>c.valueBoolean===false).map((c:any)=>c.code.coding[0].code),findingsRows:0,editorHistoryState:nh[0].state});

const retired=copy(s);retired.id='retired-option';retired.component=retired.component.map((c:any)=>c.valueBoolean===true?{...c,code:odosConcept(`OD_${field(lens).localCode}::brunescent`)}:c);
const tr=translateRetiredFindingRead(retired,lens.stableKey,field(lens),'OD_');assert.deepEqual(tr.value,[lensOption]);assert.ok(tr.findingDetails[lensOption].colour);
const oldAtomic={...copy(a),id:'retired-atomic-option',code:odosConcept(atomicId(lens,'brunescent'))};
assert.equal(catalog.find(r=>r.atomicFindingId===oldAtomic.code.coding[0].code),undefined);
assert.equal(translateRetiredFindingRead(oldAtomic,lens.stableKey,field(lens),'OD_').value,undefined);
record('retired option compatibility is component based',{snapshotTranslated:tr.value,translatedDetails:tr.findingDetails,atomicCatalogMatch:false,atomicHelperValue:null});

const spk=env();const cs=await capture(spk,cornea,['superficial-punctate-keratitis-spk'],{findingDetails:{'superficial-punctate-keratitis-spk':{grade:'Grade 1'}}});
const csStored=spk.rows.find(r=>r.id===cs.id);const grade=csStored.component.find((c:any)=>c.code.coding.some((c:any)=>c.code.endsWith('::grade')));grade.valueCodeableConcept=odosConcept('Grade 0');
const ch=await history(spk,cornea);assert.equal(ch[0].findingDetails?.['superficial-punctate-keratitis-spk']?.grade,undefined);
assert.equal(overview([csStored]).findings[0].sheetFindings?.[0].qualifiers[0],'Grade 0');
record('retired qualifier incompatible with universal byte equality',{historyGrade:null,rawOverviewGrade:'Grade 0',storedGrade:'Grade 0'});

const stale=env();now='2026-09-15T12:00:00.000Z';const old=await capture(stale,lens,[lensOption]);now='2026-09-15T13:00:00.000Z';await capture(stale,lens,['cortical-cataract']);
const cr=await handleDiagnosisCandidatesRequest(deps(stale),request);assert.equal(cr.status,200);const cf=(cr.body as any).findings;
assert.equal(cf.length,2);assert.ok(cf.find((r:any)=>r.findingInstanceId===old.id)?.candidates.some((c:any)=>c.diagnosisKey===dx.stableKey));
assert.equal((await get(stale)).length,1);assert.equal(overview(stale.rows.filter(r=>r.resourceType==='Observation')).findings.length,2);
record('latest-only read changes existing section consumers',{findingsGetRows:1,candidateSnapshotGroups:cf.length,overviewSnapshotRows:2,oldCandidateStillPresent:true});

const synthetic=buildOcularHealthDefinitions([{key:'probe',display:'Synthetic probe',priority:[{key:'sample',display:'Sample',qualifiers:[{kind:'numeric',key:'amount',display:'Amount',min:0,max:10,step:1},{kind:'enum',key:'kind',display:'Kind',options:[{code:'x',display:'X'}]},{kind:'extent',key:'extent',display:'Extent'}]}],additional:[],normalTemplate:'Synthetic'}] as any,'ocular-health:anterior:',{source:'manual',recordedAt:now})[0];
const qf=env();const qdefs=[...defs,synthetic];const details={sample:{amount:3,kind:'x',extent:{from:2,to:5,clockwise:true}}};
const qr=await handleCustomSectionCaptureRequest(deps(qf,qdefs),{authHeader:'synthetic',params:{stableKey:synthetic.stableKey},body:{...context,eyes:{OD:{state:'abnormal',customFields:[{code:field(synthetic).localCode,value:['sample']}],findingDetails:details}}}});
assert.equal(qr.status,200,JSON.stringify(qr.body));assert.deepEqual((await history(qf,synthetic,qdefs))[0].findingDetails,details);record('typed qualifiers round trip through real writer and history',details);

const stored=env();const override={...copy(lens),sourceStatus:'local-practice',display:'Synthetic stored lens',valueSchema:{...lens.valueSchema,fields:{}}};stored.rows.push({...buildFindingDefinitionResource(override),id:'stored-definition'});
const effective=(await new FhirFindingDefinitionStore(stored as any,defs).list()).find(d=>d.stableKey===lens.stableKey)!;assert.equal(customFieldEntries(effective).length,0);
record('stored definition replaces complete seed',{effectiveFields:0,compiledFields:customFieldEntries(lens).length});

const comp=env();const compDx={...copy(dx),keyFindings:[{findingKey:lens.stableKey,satisfiedBy:'this-encounter',origin:'practice',active:true}]};
comp.rows.push({...buildDiagnosisCatalogResource(compDx),id:'stored-dx'});const ca=await atom(comp);
let complete=await handleDiagnosisCompletenessRequest(deps(comp),request);assert.equal(complete.status,200);assert.equal((complete.body as any).diagnoses.length,1);
const caRow=comp.rows.find(r=>r.id===ca.id);caRow.status='entered-in-error';await capture(comp,lens,[],{state:'normal'});
complete=await handleDiagnosisCompletenessRequest(deps(comp),request);assert.equal((complete.body as any).diagnoses.length,0);
record('completeness current raw-existence semantics',{atomicOnlyMissingRows:1,retiredAtomicPlusEmptyNormalMissingRows:0});
const vf=env();const va=await atom(vf);const vp=await handleEncounterVoidRequest(deps(vf),{...request,body:{scope:'section',sectionKey:lens.stableKey,preview:true}});assert.equal(vp.status,200);assert.equal((vp.body as any).count,0);
record('ocular section void cannot see atomic source',{visibleFindingsRows:(await get(vf)).length,sectionPreviewCount:(vp.body as any).count});
const unk=env();const ua=await atom(unk);const ur=unk.rows.find(r=>r.id===ua.id);delete ur.extension;delete ur.bodySite;assert.equal((await get(unk))[0].laterality,'UNKNOWN');
record('unscoped legacy remains visible today',{eye:(await get(unk))[0].laterality});
const can=env();const canA=await atom(can);can.rows.find(r=>r.id===canA.id).status='cancelled';assert.equal((await get(can)).length,1);
record('cancelled atomic is not filtered by current findings GET',{rows:1});
console.log(JSON.stringify({summary:{probes:count,passed:count,liveServer:false,applicationEdits:0}}));

const { projectCurrentFindings } = await import('../../../src/clinical-graph/current-finding-reader.ts');
const { resolveCatalogRow } = await import('../../../src/clinical-graph/current-finding-identity.ts');
const project = (rows:any[], definitions=defs) => projectCurrentFindings({incomplete:false,...context,definitions,catalog:materializeAtomicFindingCatalog(definitions),
  observations:rows.filter(r=>r.resourceType==='Observation'),conditions:rows.filter(r=>r.resourceType==='Condition')});
const checks = [
  ['E1',()=>assert.equal(resolveCatalogRow(catalog,nested.atomicFindingId)?.optionCode,nested.optionCode)],
  ['E2',()=>assert.equal(pick.status,422)],
  ['E3',()=>assert.equal(overview(project([s,a]).definitionViews).findings.length,0)],
  ['E4',()=>assert.equal(project(f.rows).currentFacts[0].contributors[0].kind,'legacy-section-snapshot')],
  ['E5',()=>assert.equal(denied.status,400)],
  ['E6',()=>assert.deepEqual(project(ou.rows).currentFacts.map(r=>[r.eye,r.status]),[['OD','retired'],['OS','retired']])],
  ['E7',()=>assert.deepEqual(project(dupe.rows).conflicts.map(r=>r.eye),['OD'])],
  ['E8',()=>{const p=project(neg.rows);assert.equal(p.currentFacts[0].presence,'present');assert.equal(p.panels[0].negativeActs.length,1)}],
  ['E9',()=>assert.deepEqual(project([retired]).currentFacts[0].qualifiers,tr.findingDetails[lensOption])],
  ['E10',()=>assert.equal(project([csStored]).currentFacts[0].qualifiers.grade,undefined)],
  ['E11',()=>assert.deepEqual(project(stale.rows).currentFacts.map(r=>r.key.optionCode),['cortical-cataract'])],
  ['E12',()=>assert.deepEqual(project(qf.rows,qdefs).currentFacts[0].qualifiers,details.sample)],
  ['E13',()=>assert.equal(project([s],[effective]).currentFacts.length,0)],
  ['E14',()=>assert.equal(project(comp.rows).currentFacts.filter(r=>r.status==='live').length,0)],
  ['E15',()=>assert.equal((vp.body as any).count,0)],
  ['E16',()=>assert.equal(project(unk.rows).unresolved[0].reference,`Observation/${ua.id}`)],
  ['E17',()=>assert.equal(project(can.rows).currentFacts[0].status,'retired')],
] as const;
for(const [probe,check] of checks){check();console.log(JSON.stringify({a1Probe:probe,status:'PASS'}));}
console.log(JSON.stringify({a1Comparison:{passed:checks.length,publicHandlersUnchanged:true}}));
