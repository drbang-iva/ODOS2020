import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { AccessPolicy, Encounter, Observation, Patient, Resource } from '@medplum/fhirtypes';
import { createAuthenticatedFhirClient } from '../../../../mcp/tests/integration-helpers.js';
import { createRoleClient, fhirRequest } from '../../../../mcp/tests/liveRoleClient.js';
import { buildMedplumAccessPolicy, getRoleDeclaration } from '../../../../mcp/src/authz/roles.js';
import { searchAll } from '../../../../mcp/src/fhir-search.js';

const baseUrl = process.env.MEDPLUM_BASE_URL!;
assert.equal(baseUrl, 'http://localhost:18103/');
const health = await (await fetch(`${baseUrl}healthcheck`)).json();
console.log('HEALTH', JSON.stringify(health));
const { fhir } = await createAuthenticatedFhirClient({ baseUrl, email: 'admin@example.com', password: process.env.MEDPLUM_SUPER_ADMIN_PASSWORD! });
const { accessToken } = await createAuthenticatedFhirClient({ baseUrl, email: process.env.MEDPLUM_ADMIN_EMAIL!, password: process.env.MEDPLUM_ADMIN_PASSWORD! });
const me = await (await fetch(`${baseUrl}auth/me`, {headers: {Authorization: `Bearer ${accessToken}`}})).json() as { project: {id: string}; profile: Resource };
const projectId = process.env.MEDPLUM_PROJECT_ID!;
const patient = (await searchAll<Patient>(fhir, 'Patient', {_count:'1000',_project:projectId})).find(p => p.name?.some(n => n.family?.startsWith('ContractSearch')))!;
assert.ok(patient?.id);
const track = <T extends Resource>(r:T):T => r;
for (const roleId of ['provider','staff'] as const) {
  for (const [probe, gate] of Object.entries({
    control: 'true',
    resolvedExists: '%before.encounter.resolve().exists()',
    resolvedOpen: "%before.encounter.resolve().status = 'in-progress'",
    resolvedNotFinished: "%before.encounter.resolve().status != 'finished'",
    resolvedStatusEmpty: '%before.encounter.resolve().status.empty()',
    typedResolvedOpen: "%before.encounter.resolve().ofType(Encounter).status = 'in-progress'",
    incomingResolvedOpen: "encounter.resolve().status = 'in-progress'",
  })) {
    const declaration = buildMedplumAccessPolicy(getRoleDeclaration(roleId));
    const policy = await fhir.create<AccessPolicy>({
      ...declaration, name: `Undo resolve probe ${roleId} ${probe} ${randomUUID()}`,
      meta: {tag: [], project: projectId},
      resource: [
        {resourceType:'Encounter', interaction:['read']},
        {resourceType:'Observation', interaction:['read','update'], writeConstraint:[{
          language: 'text/fhirpath', expression: `%before.status = 'entered-in-error' and status = 'preliminary' and (${gate})`,
        }]},
      ],
    });
    const {token} = await createRoleClient({baseUrl, roleId, policyReference:`AccessPolicy/${policy.id}`, patientReference:`Patient/${patient.id}`, practitionerReference:`Practitioner/${me.profile.id}`, projectId, runId:randomUUID(), adminToken:accessToken,track});
    for (const status of ['in-progress','finished'] as const) {
      const encounter = await fhir.create<Encounter>({resourceType:'Encounter',meta:{project:projectId},status,class:{code:'AMB',system:'http://terminology.hl7.org/CodeSystem/v3-ActCode'},subject:{reference:`Patient/${patient.id}`}});
      const observation = await fhir.create<Observation>({resourceType:'Observation',meta:{project:projectId},status:'entered-in-error',code:{text:'Synthetic reference-resolution probe'},subject:{reference:`Patient/${patient.id}`},encounter:{reference:`Encounter/${encounter.id}`},valueString:'probe'});
      const read = await fhirRequest(baseUrl,token,'GET',`Encounter/${encounter.id}`);
      assert.equal(read.status,200,'The same principal can directly read the referenced Encounter');
      const result = await fhirRequest<Observation>(baseUrl,token,'PUT',`Observation/${observation.id}`,{...observation,status:'preliminary'});
      const stored = await fhir.read<Observation>('Observation',observation.id!);
      console.log(JSON.stringify({roleId,probe,encounterStatus:status,encounterRead:read.status,put:result.status,outcome:result.summary,storedStatus:stored.status}));
      if (probe === 'control') assert.equal(result.status,200);
    }
  }
}
