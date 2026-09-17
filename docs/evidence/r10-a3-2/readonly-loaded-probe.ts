import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { Encounter, Observation, Resource } from '@medplum/fhirtypes';
import { handleCustomSectionCaptureRequest as capture, handleCustomSectionHistoryRequest as history } from '../../../mcp/src/clinical-graph/custom-section-endpoint.js';
import { canonicalFact, memoryFhir } from '../../../mcp/tests/fixtures/r10/writer-harness.js';
import { lens } from '../../../mcp/tests/fixtures/r10/factories.js';
import { buildFindingDefinitionSeeds } from '../../../mcp/src/clinical-graph/finding-definition-store.js';
const NOW='2026-09-16T12:00:00.000Z';
const encounter=(id='e1',status:Encounter['status']='in-progress'):Encounter=>({resourceType:'Encounter',id,meta:{versionId:'1'},status,class:{code:'synthetic'},subject:{reference:'Patient/p1'},period:{start:NOW}});
function fixture(initial:Resource[]=[],defs=buildFindingDefinitionSeeds()){
 const m=memoryFhir([encounter(),...initial]);const search=m.fhir.search.bind(m.fhir);
 m.fhir.search=async(type:any,params:any={})=>{
  if(type==='Basic')return {resourceType:'Bundle',type:'searchset',entry:m.all('Basic').filter((r:any)=>!params.code||r.code?.coding?.some((c:any)=>`${c.system}|${c.code}`===params.code)).map(resource=>({resource}))} as any;
  if(type==='Observation'&&params.code) { const codes=params.code.split(','); return {resourceType:'Bundle',type:'searchset',entry:m.all<Observation>('Observation').filter(o=>o.subject?.reference===params.subject && o.code.coding?.some(c=>codes.includes(c.code))).map(resource=>({resource}))} as any; }
  if(type==='Provenance'&&params.target)return {resourceType:'Bundle',type:'searchset',entry:m.all('Provenance').filter((p:any)=>p.target.some((t:any)=>t.reference===params.target)).map(resource=>({resource}))} as any;
  return search(type,params);
 };
 const conditional=m.fhir.createWithOutcome.bind(m.fhir);
 m.fhir.createWithOutcome=async(resource:any,headers:any={})=>{const target=new URLSearchParams(headers['If-None-Exist']??'').get('target');if(target){const found=m.all('Provenance').find((p:any)=>p.target.some((t:any)=>t.reference===target));if(found)return {resource:structuredClone(found),created:false} as any;}return conditional(resource,headers);};
 const fhir={...m.fhir,create:async(resource:any,headers:any)=>(await m.fhir.createWithOutcome(resource,headers)).resource};
 const deps={authenticate:async()=>({staffReference:'Practitioner/synthetic',actorRole:'provider' as const,fhir}),findingDefinitions:()=>defs,now:()=>NOW};return {m,deps};
}
const body=(eyes:any)=>({commandId:randomUUID(),patientReference:'Patient/p1',encounterReference:'Encounter/e1',eyes});
const save=(f:ReturnType<typeof fixture>,request:any,key=lens.stableKey)=>capture(f.deps,{authHeader:'synthetic',params:{stableKey:key},body:request});
const read=(f:ReturnType<typeof fixture>,key=lens.stableKey,encounterRef:string|null='Encounter/e1')=>history(f.deps,{authHeader:'synthetic',params:{stableKey:key},query:{patient:'Patient/p1',...(encounterRef?{encounter:encounterRef}:{})}});

// Real endpoint handlers with synthetic in-memory FHIR; no network or policy claim.
for (const status of ['preliminary', 'final'] as const) {
  const fact = { ...canonicalFact(), status };
  const f = fixture([fact]);
  const before = structuredClone(f.m.resources.get('Observation/canonical'));
  const h: any = await read(f);
  assert.equal(h.status, 200);
  const eye = h.body.eyes.OD;
  const loaded = eye.facts.filter((r: any) => r.status === 'live' && r.presence === 'present')
    .map((r: any) => ({ key: r.key, baseline: r.baseline, presence: 'present', qualifiers: r.qualifiers, homes: r.homes }));
  assert.equal(loaded.length, 1);
  const request = body({ OD: { loaded, selected: structuredClone(loaded), panel: {
    baseline: eye.panel.baseline, state: { deferred: false, values: {}, remarks: 'Synthetic new remark' }
  } } });
  const result: any = await save(f, request);
  const after: any = await read(f);
  console.log(JSON.stringify({case: status, encounterEditable: eye.encounterEditable,
    factEditable: eye.facts.find((r: any) => r.status === 'live').editable,
    panelEditable: eye.panel.editable, status: result.status, reason: result.body.reason,
    complete: result.body.complete, writes: f.m.writes.length,
    remark: after.body.eyes.OD.panel.remarks ?? null,
    originalFactUnchanged: JSON.stringify(before) === JSON.stringify(f.m.resources.get('Observation/canonical'))}));
  assert.equal(eye.encounterEditable, true);
  assert.equal(eye.panel.editable, true);
  assert.deepEqual(f.m.resources.get('Observation/canonical'), before);
  assert.equal(result.status, status === 'preliminary' ? 200 : 422);
  if (status === 'final') {
    assert.equal(result.body.reason, 'signed-or-cancelled');
    assert.equal(f.m.writes.length, 0);
    assert.equal(after.body.eyes.OD.panel.remarks, undefined);
  } else assert.equal(after.body.eyes.OD.panel.remarks, 'Synthetic new remark');
}
