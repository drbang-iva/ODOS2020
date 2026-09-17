import assert from 'node:assert/strict';
import type { Bundle, Observation } from '@medplum/fhirtypes';
import { createMcpRuntimeTransport } from '../../../../mcp/tests/fixtures/r10/mcp-runtime-transport.js';
const original: Observation={resourceType:'Observation',id:'source',meta:{versionId:'1'},status:'preliminary',code:{text:'Synthetic unrelated'},note:[{text:'Earlier synthetic note'}]};
const patch=(operations:unknown[],ifMatch='W/"1"'):Bundle=>({resourceType:'Bundle',type:'transaction',entry:[{resource:{resourceType:'Binary',contentType:'application/json-patch+json',data:Buffer.from(JSON.stringify(operations)).toString('base64')},request:{method:'PATCH',url:'Observation/source',ifMatch}}]});
async function main(){
 let passed=0;
 for(const [name,bundle] of [
 ['stale version',patch([{op:'replace',path:'/status',value:'final'}],'W/"stale"')],
 ['failed status test',patch([{op:'test',path:'/status',value:'final'},{op:'replace',path:'/status',value:'amended'}])],
 ['unsupported patch operation',patch([{op:'remove',path:'/note'}])],
 ] as const){const h=createMcpRuntimeTransport([original],name);await assert.rejects(()=>h.fhir.executeTransaction(bundle));assert.deepEqual(h.resources.get('Observation/source'),original);assert.equal(h.recorder.persisted.length,0);passed++;}
 const h=createMcpRuntimeTransport([original],'valid patch');
 await h.fhir.executeTransaction(patch([{op:'test',path:'/status',value:'preliminary'},{op:'replace',path:'/status',value:'final'},{op:'add',path:'/note/-',value:{text:'Appended synthetic note'}}]));
 assert.equal(h.recorder.attempted.length,1);assert.equal(h.recorder.attempted[0].resource.resourceType,'Binary');assert.equal(h.patchProjections.length,1);assert.equal(h.recorder.persisted.length,1);assert.equal((h.resources.get('Observation/source') as Observation).note?.length,2);passed++;
 const atomic=createMcpRuntimeTransport([original],'staged validation');
 const bundle=patch([{op:'replace',path:'/status',value:'final'}]);bundle.entry!.push({resource:{resourceType:'Provenance',recorded:'2026-09-16T12:00:00.000Z',target:[],agent:[]},request:{method:'PUT',url:'Provenance/missing',ifMatch:'W/"missing"'}});
 await assert.rejects(()=>atomic.fhir.executeTransaction(bundle));assert.deepEqual(atomic.resources.get('Observation/source'),original);assert.equal(atomic.recorder.persisted.length,0);passed++;
 console.log(`${passed}/5 synthetic transport controls passed; not a claim of backend transaction atomicity.`);
}
main().catch(e=>{console.error(e);process.exitCode=1;});
