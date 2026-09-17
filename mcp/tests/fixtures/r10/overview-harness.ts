import type { Basic, Condition, Observation, Resource } from '@medplum/fhirtypes';
import { fixture as carryFixture } from './carry-harness.js';
import { definitions, lens, nuclear } from './factories.js';
import { buildFindingDefinitionResource, FhirFindingDefinitionStore } from '../../../src/clinical-graph/finding-definition-store.js';
import { buildDiagnosisCatalogResource, buildDiagnosisCatalogSeeds } from '../../../src/clinical-graph/diagnosis-catalog-store.js';
import { buildEncounterDiagnosisCondition } from '../../../src/fhir/condition.js';
import { DIAGNOSIS_KEY_IDENTIFIER_SYSTEM } from '../../../src/clinical-graph/diagnosis-pick-endpoint.js';
import { handleExamOverviewRequest } from '../../../src/clinical-graph/exam-overview-endpoint.js';
import { handleDiagnosisCompletenessRequest } from '../../../src/clinical-graph/diagnosis-completeness-endpoint.js';
export function overviewFixture(definition = lens) {
  const c = carryFixture(['OD']);
  const create = async <T extends Resource>(r:T) => (await c.fhir.createWithOutcome(r)).resource;
  const fhir = {...c.fhir, create};
  const original = fhir.search;
  fhir.search = async (type, params={}) => {
    if(type === 'Provenance' && params.patient) return {resourceType:'Bundle',type:'searchset',entry:c.all('Provenance').filter((p:any)=>p.target.some((t:any)=>t.reference===params.patient)).map(resource=>({resource}))} as any;
    return original(type,params);
  };
  const seed = buildDiagnosisCatalogSeeds().find(d=>d.stableKey===nuclear.diagnosisKeys[0])!;
  c.save(buildDiagnosisCatalogResource({...seed,keyFindings:[{findingKey:definition.stableKey,label:'Required finding',satisfiedBy:'this-encounter',active:true,origin:'practice'}]}));
  c.save(buildFindingDefinitionResource({...definition,sourceStatus:"local-practice"}));
  const current:Condition = {...buildEncounterDiagnosisCondition({patientReference:'Patient/p1',encounterReference:'Encounter/e1',code:{text:'Synthetic current diagnosis'},verificationStatus:'confirmed',identifiers:[{system:DIAGNOSIS_KEY_IDENTIFIER_SYSTEM,value:`e1::${seed.stableKey}::right`}]}),id:'current'};
  c.save(current);
  const authenticate=async()=>({staffReference:'Practitioner/synthetic',actorRole:'provider' as const,fhir});
  return {...c,deps:{...c.deps,now:()=> "2026-09-16T12:00:00Z"},fhir,authenticate,definition,async overview(){return handleExamOverviewRequest({authenticate,findingDefinitions:()=>new FhirFindingDefinitionStore(fhir).list()}, {authHeader:'test',params:{encounterId:'e1'}});},async completeness(){return handleDiagnosisCompletenessRequest({authenticate,now:()=> '2026-09-16T12:00:00Z'}, {authHeader:'test',params:{encounterId:'e1'}});}};
}
export async function missing(c:ReturnType<typeof overviewFixture>) {const r=await c.completeness();if(r.status!==200)throw Error(JSON.stringify(r.body)); return (r.body as any).diagnoses.flatMap((d:any)=>d.missing).map((m:any)=>m.findingKey);}
