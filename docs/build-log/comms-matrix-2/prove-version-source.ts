import assert from 'node:assert/strict';
import {createAuthenticatedFhirClient} from '../../../mcp/tests/integration-helpers.ts';
import {patientWriteVersion} from '../../../mcp/src/comms/patient-version.ts';
(async()=>{
 assert.ok(['127.0.0.1','localhost'].includes(new URL(process.env.ODOS_MATRIX_BASE_URL!).hostname), 'Use a disposable local synthetic stack');
 const {fhir}=await createAuthenticatedFhirClient({baseUrl:process.env.ODOS_MATRIX_BASE_URL!,email:process.env.ODOS_MATRIX_ADMIN_EMAIL!,password:process.env.ODOS_MATRIX_ADMIN_PASSWORD!});
 const p=await fhir.create({resourceType:'Patient', active:false, name:[{family:'TEST-MatrixVersion',given:['Synthetic']}]});
 const reference=`Patient/${p.id}`;
 const response=await fhir.executeTransaction({resourceType:'Bundle',type:'transaction',entry:[{resource:{...p,active:false,name:[{family:'TEST-MatrixVersion',given:['Source','Proof']}]} ,request:{method:'PUT',url:reference,ifMatch:`W/"${p.meta!.versionId}"`}}]});
 console.log(JSON.stringify({responseType:response.type,entries:response.entry?.map(e=>({response:e.response,resourceType:e.resource?.resourceType,version:e.resource?.meta?.versionId}))}));
 const report=patientWriteVersion(response,reference,p.meta!.versionId!);
 const fresh=await fhir.read('Patient',p.id!);
 assert.ok(report);assert.equal(report.writtenAgainst,p.meta!.versionId);assert.equal(report.current,fresh.meta!.versionId);assert.equal(response.entry![0].resource!.id,p.id);assert.equal(response.entry![0].resource!.meta!.versionId,fresh.meta!.versionId);assert.equal(fresh.active,false);
 console.log(JSON.stringify({proof:'Ruled parser reports embedded Patient version matching fresh read',patientVersion:report,location:response.entry?.[0].response?.location,embeddedPatientId:response.entry?.[0].resource?.id,embeddedVersion:response.entry?.[0].resource?.meta?.versionId,freshReadVersion:fresh.meta?.versionId,fixtureInactive:fresh.active===false}));
})().catch(e=>{console.error(e.message);process.exitCode=1});
