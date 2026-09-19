import {readFileSync,writeFileSync} from 'node:fs';
import assert from 'node:assert/strict';
import type { HealthcareService, Appointment, Encounter } from '@medplum/fhirtypes';
import {collectAllFhirSearchPages} from '../../../../mcp/src/fhir-search.js';
import {loadVerifiedOperatorFhirClient} from '../../../../scripts/operator-identity.js';
import {buildVisitType,ODOS_VISIT_TYPE_SYSTEM} from '../../../../mcp/src/fhir/schedulingVisitType.js';
import {buildSchedulingAppointment} from '../../../../mcp/src/fhir/schedulingAppointment.js';
import {disciplineCoding} from '../../../../mcp/src/scheduling/clinic-mode.js';
const runtime='.odos/s1b-proof';
const read=(n:string)=>JSON.parse(readFileSync(`${runtime}/${n}`,'utf8'));
const {ports}=read('manifest.json'),credentials=read('credentials.json'),fixture=read('fixture.json');
const {database}=read('medplum.config.json');
const {fhir}=await loadVerifiedOperatorFhirClient({baseUrl:`http://127.0.0.1:${ports.medplum}`,projectId:credentials.projectId,postgresUrl:`postgresql://${database.username}:${database.password}@127.0.0.1:${ports.postgres}/${database.dbname}`,credentialPath:`${runtime}/operator.env`,statePath:`${runtime}/operator-state.json`});
const code='s1b-comprehensive';
const saveFixture=()=>writeFileSync(`${runtime}/fixture.json`,JSON.stringify(fixture,null,2)+'\n',{mode:0o600});
const services=await collectAllFhirSearchPages(fhir,'HealthcareService',await fhir.search<HealthcareService>('HealthcareService',{_count:'200'}),fhir.baseUrl);
const existing=services.find(service=>service.type?.some(type=>type.coding?.some(c=>c.system===ODOS_VISIT_TYPE_SYSTEM&&c.code===code)));
const visitType=fixture.comprehensiveVisitType
  ? await fhir.read<HealthcareService>('HealthcareService',fixture.comprehensiveVisitType.split('/')[1])
  : existing ?? await fhir.create(buildVisitType({code,name:'S1b Synthetic Comprehensive',discipline:'eyecare',durationMinutes:30,categoryCode:'comprehensive',categoryLabel:'Comprehensive'}));
assert.ok(visitType.type?.some(type=>type.coding?.some(c=>c.system===ODOS_VISIT_TYPE_SYSTEM&&c.code===code)));
fixture.comprehensiveVisitType=`HealthcareService/${visitType.id}`;saveFixture();
const encounter=await fhir.read<Encounter>('Encounter',fixture.current.slice(10));
const existingAppointment=fixture.comprehensiveAppointment ?? encounter.appointment?.[0]?.reference;
const appointment=existingAppointment
  ? await fhir.read<Appointment>('Appointment',existingAppointment.split('/')[1])
  : await fhir.create(buildSchedulingAppointment({patient:{reference:fixture.patientReference},visitTypeCode:code,visitTypeDisplay:'S1b Synthetic Comprehensive',discipline:'eyecare',resources:[{reference:credentials.provider.practitionerReference}],start:'2026-09-19T14:00:00Z',durationMinutes:30}));
assert.ok(appointment.participant.some(p=>p.actor?.reference===fixture.patientReference));
assert.ok(appointment.serviceType?.some(type=>type.coding?.some(c=>c.system===ODOS_VISIT_TYPE_SYSTEM&&c.code===code)));
fixture.comprehensiveAppointment=`Appointment/${appointment.id}`;saveFixture();
const appointments=encounter.appointment ?? [];
await fhir.update('Encounter',encounter.id!,{...encounter,type:[{coding:[{system:ODOS_VISIT_TYPE_SYSTEM,code,display:'S1b Synthetic Comprehensive'}]}],serviceType:{coding:[disciplineCoding('eyecare')]},appointment:appointments.some(a=>a.reference===fixture.comprehensiveAppointment)?appointments:[...appointments,{reference:fixture.comprehensiveAppointment}]},{'If-Match':`W/"${encounter.meta!.versionId}"`});
console.log('Synthetic encounter now uses the comprehensive visit category.');
