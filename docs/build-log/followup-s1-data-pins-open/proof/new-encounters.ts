import {readFileSync,writeFileSync} from 'node:fs';
import {loadVerifiedOperatorFhirClient} from '../../../../scripts/operator-identity.js';
import {buildVisitType,ODOS_VISIT_TYPE_SYSTEM} from '../../../../mcp/src/fhir/schedulingVisitType.js';
import {buildSchedulingAppointment} from '../../../../mcp/src/fhir/schedulingAppointment.js';
import {disciplineCoding} from '../../../../mcp/src/scheduling/clinic-mode.js';
const runtime='.odos/s1-proof';
const read=(n:string)=>JSON.parse(readFileSync(`${runtime}/${n}`,'utf8'));
const {ports}=read('manifest.json'),credentials=read('credentials.json'),fixture=read('fixture.json');
const {database}=read('medplum.config.json');
const {fhir}=await loadVerifiedOperatorFhirClient({baseUrl:`http://127.0.0.1:${ports.medplum}`,projectId:credentials.projectId,postgresUrl:`postgresql://${database.username}:${database.password}@127.0.0.1:${ports.postgres}/${database.dbname}`,credentialPath:`${runtime}/operator.env`,statePath:`${runtime}/operator-state.json`});
const source=await fhir.read<any>('Encounter',fixture.current.slice(10));
for(const key of ['fresh','empty']){
 if(fixture[key])continue;
 const {id,meta,...copy}=source;
 const saved=await fhir.create({...copy,period:{start:new Date().toISOString()}});
 fixture[key]=`Encounter/${saved.id}`;
}
writeFileSync(`${runtime}/fixture.json`,JSON.stringify(fixture,null,2)+'\n',{mode:0o600});
console.log('Two additional synthetic comprehensive encounters are ready.');
