import React from 'react';
import {createRoot} from 'react-dom/client';
import {DiagnosisFindingsTable} from './src/components/charting/DiagnosisFindingsTable';
import {DiagnosisWorkspace} from './src/components/charting/DiagnosisWorkspace';
import {EncounterFindingOverlay} from './src/components/charting/EncounterFindingOverlay';
import {fhir} from './src/lib/fhir';
import './src/styles/globals.css';
import './src/styles/charting.css';
const state=new URLSearchParams(location.search).get('state') ?? 'partial';
const base={atomicFindingId:'synthetic:field:option',findingDefinitionId:'synthetic',findingDefinitionKey:'synthetic',fieldCode:'field',optionCode:'option',display:'Synthetic lens finding',sectionKey:'Ocular Health',gradeScale:['1','2','3','4'],diagnosisKeys:['synthetic-diagnosis'],origin:'custom',source:'atomic',lateralitySource:'explicit',kind:'fact',presence:'present',grade:'2',qualifiers:{grade:'2'},status:'live',editable:true,homes:['Condition/c1'],homeSources:[],contributors:[]};
const rows=['OD','OS'].map(eye=>({...base,rowKey:`fact-${eye}`,eye,laterality:eye,observationReference:`Observation/fact-${eye}`,key:{v:1,patientId:'p1',encounterId:'e1',stableKey:'synthetic',fieldCode:'field',optionCode:'option',eye},baseline:{kind:'canonical',reference:`Observation/fact-${eye}`,versionId:'1'}}));
if(state==='conflict') Object.assign(rows[0],{kind:'conflict',editable:false,readOnlyReason:'conflict'});
if(state==='partial') rows.forEach(row=>Object.assign(row,{homes:[]}));
if(state==='audit') Object.assign(rows[0],{auditPending:true});
let saved=state!=='partial';
const condition={resourceType:'Condition',id:'c1',subject:{reference:'Patient/p1'},encounter:{reference:'Encounter/e1'},category:[{coding:[{system:'http://terminology.hl7.org/CodeSystem/condition-category',code:'encounter-diagnosis'}]}],identifier:[{system:'https://odos2020.com/fhir/NamingSystem/diagnosis-catalog-stable-key',value:'e1::synthetic-diagnosis::none'}],code:{text:'Synthetic diagnosis'}};
const payload=()=>({encounterEditable:state!=='prebuild',...(state==='prebuild'?{readOnlyReason:'pre-rebuild-test-encounter'}:{}),canWrite:true,canWriteDiagnosis:true,findings:rows,catalog:[base],searchIndex:rows,unassigned:state==='partial'?rows:[],bySection:{'Ocular Health':rows},auditDebt:state==='audit'?[rows[0]]:[],visitDiagnoses:saved?[{conditionReference:'Condition/c1',diagnosisKey:'synthetic-diagnosis',display:'Synthetic diagnosis',laterality:'OU'}]:[]});
fhir.read=async ()=>({resourceType:'Encounter',id:'e1',status:'in-progress',class:{},subject:{reference:'Patient/p1'},diagnosis:saved?[{condition:{reference:'Condition/c1'},rank:1}]:[]}) as any;
fhir.search=async (kind:string)=>({resourceType:'Bundle',type:'searchset',entry:kind==='Condition'&&saved?[{resource:condition}]:[]}) as any;
fhir.authHeader=()=>undefined;
window.fetch=async(input,init)=>{
 const url=String(input);
 if(url.includes('/diagnosis-picks')) {saved=true;return Response.json({result:'pick',conditionStep:'applied',link:'pending',condition});}
 if(url.includes('/findings')&&init?.method==='PUT'){const command=JSON.parse(String(init.body));return Response.json({result:'command',commandId:command.commandId,complete:false,executionOrder:[0],outcomes:[{status:'unconfirmed',clinicalWrite:'unknown',target:'fact-OD',reason:'Synthetic interrupted link'}]},{status:502});}
 if(url.includes('/findings'))return Response.json(payload());
 if(url.includes('diagnosis-quick-list'))return Response.json({canWrite:true,canWriteDiagnosis:true,diagnoses:[],catalog:[{stableKey:"synthetic-diagnosis",display:"Synthetic diagnosis",lateralityRequired:true,pinned:false,tallyCount:0}],pinnedDiagnosisKeys:[]});
 if(url.includes('diagnosis-candidates'))return Response.json({findings:rows.map(row=>({findingInstanceId:`definition:[synthetic,${row.eye}]`,contributors:row.contributors,candidates:[{diagnosisKey:'synthetic-diagnosis',display:'Synthetic diagnosis',codingStatus:'provisional',priority:true,source:'mapping',supportingFacts:[{rowKey:row.rowKey,key:row.key,baseline:row.baseline}]}]}))});
 if(url.includes('previous-exams'))return Response.json({pageSize:4,encounters:[]});
 if(url.includes('procedure'))return Response.json({attachedProcedures:[]});
 return Response.json({rows:[],encounters:[]});
};
const labels={ou:'Grouped bilateral findings',conflict:'Conflicting records',prebuild:'Pre-rebuild test data',unavailable:'Unavailable finding load',partial:'Both-eye suggested diagnosis',audit:'Pending audit record'};
createRoot(document.getElementById('root')!).render(<main style={{padding:28,maxWidth:1440,margin:'0 auto',color:'#e2e8f0'}}><header style={{marginBottom:24}}><div style={{fontSize:12,color:'#94a3b8',letterSpacing:2}}>SYNTHETIC COMPONENT EVIDENCE · R10 A2b.2</div><h1 style={{fontSize:26,marginTop:10}}>{labels[state as keyof typeof labels]}</h1></header><div id="proof" style={{minHeight:420}}>{['ou','conflict','prebuild'].includes(state)?<DiagnosisFindingsTable payload={payload() as any} patientReference="Patient/p1" conditionReference="Condition/c1" disabled={false} onMutate={()=>undefined}/>:state==='unavailable'?<EncounterFindingOverlay encounterReference="Encounter/e1" sectionKey="Ocular Health" loadPayload={async()=>{throw new Error('Synthetic unavailable')}}/>:<DiagnosisWorkspace patientReference="Patient/p1" encounterReference="Encounter/e1" onSelectDiagnosis={()=>undefined}/>}</div></main>);
