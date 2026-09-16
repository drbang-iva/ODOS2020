import assert from 'node:assert/strict';
import { test } from 'node:test';
import { collectAllFhirSearchPages } from '../src/fhir-search.js';
import { FhirFindingDefinitionStore, buildFindingDefinitionResource, buildFindingDefinitionSeeds } from '../src/clinical-graph/finding-definition-store.js';
import { FhirDiagnosisCatalogStore, buildDiagnosisCatalogResource, buildDiagnosisCatalogSeeds } from '../src/clinical-graph/diagnosis-catalog-store.js';
const baseUrl='http://localhost:29123/';
const page=(rows: unknown[],next?:string)=>({resourceType:'Bundle',type:'searchset',entry:rows.map(resource=>({resource})),...(next?{link:[{relation:'next',url:next}]}:{})});
const basic={resourceType:'Basic',id:'one'};
for(const [name,bad] of [
  ['non-bundle',{resourceType:'OperationOutcome'}],['wrong bundle type',{resourceType:'Bundle',type:'collection'}],
  ['missing resource',{resourceType:'Bundle',type:'searchset',entry:[{}]}],['missing id',page([{resourceType:'Basic'}])],
  ['missing next url',{...page([basic]),link:[{relation:'next'}]}],
  ['foreign next',page([basic],'http://foreign.invalid/fhir/R4/Basic?_page=2')],
] as const)test(`V8 pagination rejects ${name} as typed upstream`,async()=>{
  await assert.rejects(collectAllFhirSearchPages({baseUrl,search:async()=>bad} as any,'Basic',bad as any,baseUrl),
    (error:any)=>error.kind==='upstream'&&error.status===502);
});
test('V8 pagination validates every page and refuses cycles',async()=>{
  const next='/fhir/R4/Basic?_page=2';let calls=0;
  await assert.rejects(collectAllFhirSearchPages({baseUrl,search:async()=>page([]),searchUrl:async()=>{calls++;return page([basic],next);}} as any,'Basic',page([basic],next) as any,baseUrl),(e:any)=>e.kind==='upstream');
  assert.equal(calls,1);
  await assert.rejects(collectAllFhirSearchPages({baseUrl,search:async()=>page([]),searchUrl:async()=>page([{resourceType:'Basic'}])} as any,'Basic',page([basic],next) as any,baseUrl),(e:any)=>e.kind==='upstream');
});
for(const kind of ['finding','diagnosis'] as const)test(`V8 ${kind} store reads every page and skips invalid stored payload only`,async()=>{
  const seed=kind==='finding'?buildFindingDefinitionSeeds()[0]:buildDiagnosisCatalogSeeds()[0];
  const changed={...seed,sourceStatus:'local-practice',display:'Second page override'};
  const make=kind==='finding'?buildFindingDefinitionResource:buildDiagnosisCatalogResource;
  const good={...make(changed as any),id:'override'};
  const fhir={baseUrl,search:async()=>page([{resourceType:'Basic',id:'bad-payload'}],'/fhir/R4/Basic?_page=2'),searchUrl:async()=>page([good])};
  const store=kind==='finding'?new FhirFindingDefinitionStore(fhir as any,[seed as any]):new FhirDiagnosisCatalogStore(fhir as any,[seed as any]);
  const rows=await store.list();assert.equal(rows.length,1);assert.equal(rows[0].display,'Second page override');
  const invalid={baseUrl,search:async()=>page([{resourceType:'Basic'}])};
  const malformed=kind==='finding'?new FhirFindingDefinitionStore(invalid as any,[]):new FhirDiagnosisCatalogStore(invalid as any,[]);
  await assert.rejects(malformed.list(),(e:any)=>e.kind==='upstream');
});
