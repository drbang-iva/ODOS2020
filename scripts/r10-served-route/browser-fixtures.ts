import type { Encounter } from "@medplum/fhirtypes";
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {loadVerifiedOperatorFhirClient} from '../operator-identity.js';
const runtime=resolve(process.argv[2]);
const mode=process.argv[3];
const read=(name:string)=>JSON.parse(readFileSync(join(runtime,name),'utf8'));
const manifest=read('manifest.json'),credentials=read('credentials.json'),fixture=read('fixture.json');
assert.equal(manifest.project,'odos-r10-a3-2-served');
const operator=await loadVerifiedOperatorFhirClient({baseUrl:`http://127.0.0.1:${manifest.ports.medplum}`,projectId:credentials.projectId,postgresUrl:`postgresql://medplum:medplum@127.0.0.1:${manifest.ports.postgres}/medplum`,credentialPath:join(runtime,'operator.env'),statePath:join(runtime,'operator-state.json')});
if(mode==='destination'&&!fixture.destination){
 const encounter=await operator.fhir.create<Encounter>({resourceType:'Encounter',status:'in-progress',class:{code:'AMB'},subject:{reference:fixture.patientReference},period:{start:'2026-09-18T14:00:00Z'},participant:[{individual:{reference:credentials.provider.practitionerReference}}]});
 fixture.destination=`Encounter/${encounter.id}`;
 writeFileSync(join(runtime,'fixture.json'),JSON.stringify(fixture,null,2)+'\n',{mode:0o600});
 console.log(JSON.stringify({destination:fixture.destination,version:encounter.meta?.versionId}));
}
