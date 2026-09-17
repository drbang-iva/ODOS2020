import {buildDiagnosisCatalogSeeds} from "../../../src/clinical-graph/diagnosis-catalog-store.js";
import {overviewFixture} from './overview-harness.js';
import {ProtocolService} from '../../../src/clinical-graph/protocol-service.js';
import {DRY_EYE_EVALUATION_PROTOCOL} from '../../../src/clinical-graph/protocol-fixtures.js';
import {handleProtocolApplyRequest,handleProtocolCaptureRequest,handleProtocolUnapplyRequest} from '../../../src/clinical-graph/protocol-endpoint.js';
import type {ProtocolItem} from '../../../src/clinical-graph/protocol-types.js';
import type {Condition,Encounter} from '@medplum/fhirtypes';
import {lens} from './factories.js';
const kcsCoding=buildDiagnosisCatalogSeeds().find(d=>d.stableKey==="kcs_not_sjogren")!.icd10!;
const diagnosisCode="pattern" in kcsCoding ? kcsCoding.pattern.bilateral! : kcsCoding.code;
export const findingItem=(key=lens.stableKey,value?:unknown):ProtocolItem=>({itemKey:`finding-${key}`,itemType:'finding-seed',defaultSelected:true,lateralityMode:'inherit-dx',payload:{findingDefKey:key,mode:value===undefined?'promptOnly':'seedValue',...(value===undefined?{}:{defaultValue:value}),expand:{eyes:['OD']}}});
export async function protocolFixture(items:ProtocolItem[]=[findingItem()]) {
 const c=overviewFixture();const condition=c.resources.get('Condition/current') as Condition;c.save({...condition,code:{coding:[{code:diagnosisCode}]}});
 const service=new ProtocolService(c.fhir as any,{commitFinding:async()=>undefined,materializeAction:async()=>undefined});
 const protocol={...structuredClone(DRY_EYE_EVALUATION_PROTOCOL),id:'synthetic-r10-protocol',items};
 await service.definitions.save(protocol);c.writes.length=0;
 const deps={authenticate:c.authenticate,now:()=> '2026-09-16T12:00:00Z',catalogs:()=>({findingKeys:new Set([lens.stableKey,'ocular-health:anterior:tear-film','cup_disc_ratio']),procedureKeys:new Set<string>()})};
 const body={protocolId:protocol.id,encounterId:'e1',patientId:'p1',diagnosis:{reference:'Condition/current',code:diagnosisCode,confirmed:true as const}};
 return {...c,service,protocol,deps,body,apply:(extra={})=>handleProtocolApplyRequest(deps as any,{authHeader:'test',body:{...body,...extra}}),capture:()=>handleProtocolCaptureRequest(deps as any,{authHeader:'test',params:{encounterId:'e1'},body:{name:'Synthetic capture'}}),unapply:(id:string)=>handleProtocolUnapplyRequest(deps as any,{authHeader:'test',params:{applicationId:id}}),close(){c.save({...c.resources.get('Encounter/e1') as Encounter,status:'finished'});}};
}
export async function protocolRollbackFixture(mode:'restore'|'closed'|'pre-rebuild'|'shared'='restore', configure?: (fixture: Awaited<ReturnType<typeof protocolFixture>>) => void) {
 const c=await protocolFixture([findingItem('cup_disc_ratio',.5)]);configure?.(c);const applied=await c.apply();
 if(applied.status!==200)throw Error(JSON.stringify(applied.body));
 const applicationId=(applied.body as any).application.id;
 const original=c.all('Observation').find((o:any)=>o.encounter?.reference==='Encounter/e1')!;
 c.writes.length=0;let failed=false;
 c.hooks.beforeWrite=write=>{if(failed || write.resource.resourceType!=='Basic')return;const value=JSON.parse(write.resource.extension?.[0]?.valueString??'{}');if(value.state!=='removed'||!value.findingDefKey)return;failed=true;
  if(mode==='closed')c.close();
  if(mode==='pre-rebuild')c.save(legacySnapshot('late-legacy'));
  if(mode==='shared')c.save({...canonicalFinding(original.id),id:original.id});
  throw Error('synthetic finding-state failure after Observation removal');
 };
 return {...c,original,applicationId,run:()=>c.unapply(applicationId)};
}
import {canonicalFact as canonicalFinding} from './writer-harness.js';
import {snapshot as legacySnapshot} from './factories.js';
