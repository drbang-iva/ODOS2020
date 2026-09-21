import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { AccessPolicy, Encounter, Patient, ProjectMembership } from '@medplum/fhirtypes';
import { runSetupPractice } from '../../../../scripts/setup-practice.js';
import { ensureLiveOperatorIdentity, loadVerifiedOperatorFhirClient } from '../../../../scripts/operator-identity.js';
import { createAuthenticatedFhirClient } from '../../../../scripts/r10-served-route/login.js';
import { seedUiRuntime } from './seed-ui.js';
import { buildProjectMembershipAccess, ODOS_PRACTICE_ROLE_SYSTEM } from '../../../../mcp/src/authz/roles.js';
import { FhirFindingDefinitionStore } from '../../../../mcp/src/clinical-graph/finding-definition-store.js';

const originalFetch = globalThis.fetch;
globalThis.fetch = async (...args: Parameters<typeof fetch>) => {
  for (let attempt = 0; ; attempt++) {
    const response = await originalFetch(...args);
    if (response.status !== 429 || attempt >= 3) return response;
    await response.arrayBuffer();
    console.log("Synthetic bootstrap throttled; retrying after the server rate-limit window.");
    await new Promise(resolve => setTimeout(resolve, 61000));
  }
};

const runtime = resolve(process.argv[2]);
const read = (name: string): any => JSON.parse(readFileSync(join(runtime, name), 'utf8'));
const save = (name: string, value: unknown) => writeFileSync(join(runtime, name), JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
const manifest = read('manifest.json');
assert.ok(['odos-s3c2b-proof'].includes(manifest.project));
const baseUrl = `http://127.0.0.1:${manifest.ports.medplum}`;
const service = read('service.json');
const credentials: any = existsSync(join(runtime, 'credentials.json')) ? read('credentials.json') : {
  admin: { email: 'r10-a3-2-admin@example.test', password: `R10-${randomBytes(24).toString('base64url')}!` },
  provider: { email: 'r10-a3-2-provider@example.test', password: `R10-${randomBytes(24).toString('base64url')}!` },
  staff: { email: 'r10-a3-2-staff@example.test', password: `R10-${randomBytes(24).toString('base64url')}!` },
};
save('credentials.json', credentials);
const serviceAuth = await createAuthenticatedFhirClient({ baseUrl, ...service });
const setup = await runSetupPractice({ config: {
  baseUrl, practiceName: 'R10 A3.2 Synthetic Served Proof', adminEmail: credentials.admin.email,
  adminName: 'R10 Synthetic Admin', adminPassword: credentials.admin.password,
  serviceIdentityEmail: service.email, serviceIdentityPassword: service.password,
  postgresUrl: process.env.ODOS_POSTGRES_URL, statePath: join(runtime, 'setup-state.json'),
}, statePath: join(runtime, 'setup-state.json'), skipInteractiveBoundaryCheck: true });
assert.ok(setup.state.projectId);
credentials.projectId = setup.state.projectId;
save('credentials.json', credentials);
const admin = await createAuthenticatedFhirClient({ baseUrl, ...credentials.admin });
assert.equal(await admin.fhir.getActiveProjectId(), credentials.projectId);
const operatorPaths = { credentialPath: join(runtime, 'operator.env'), statePath: join(runtime, 'operator-state.json') };
await ensureLiveOperatorIdentity({ baseUrl, projectId: credentials.projectId, serviceEmail: service.email, servicePassword: service.password, postgresUrl: process.env.ODOS_POSTGRES_URL, ...operatorPaths });
const seeder = await loadVerifiedOperatorFhirClient({ baseUrl, projectId: credentials.projectId, postgresUrl: process.env.ODOS_POSTGRES_URL, ...operatorPaths });
const policies = (await admin.fhir.search<AccessPolicy>('AccessPolicy', { _count: '100' })).entry?.flatMap(entry => entry.resource ? [entry.resource] : []) ?? [];
const fixture: any = existsSync(join(runtime, 'fixture.json')) ? read('fixture.json') : {};
if (!fixture.patientReference) {
  const patient = await seeder.fhir.create<Patient>({ resourceType: 'Patient', active: true, name: [{ given: ['R10'], family: 'Synthetic Served Proof' }], birthDate: '1980-01-01' });
  fixture.patientReference = `Patient/${patient.id}`;
  save('fixture.json', fixture);
}
for (const role of ['provider', 'staff'] as const) {
  if (credentials[role].membershipReference) continue;
  const headers = { Authorization: `Bearer ${serviceAuth.accessToken}`, 'Content-Type': 'application/json' };
  const invite = await fetch(`${baseUrl}/admin/projects/${credentials.projectId}/invite`, {
    method: 'POST', headers, body: JSON.stringify({ resourceType: 'Practitioner', email: credentials[role].email, firstName: 'R10', lastName: `Synthetic ${role}`, sendEmail: false }),
  });
  assert.ok(invite.ok || invite.status === 409, `Synthetic ${role} invite HTTP ${invite.status}`);
  if (invite.ok) await invite.json();
  const users = await serviceAuth.fhir.search<any>('User', { email: credentials[role].email });
  assert.equal(users.entry?.length, 1);
  const memberships = await serviceAuth.fhir.search<ProjectMembership>('ProjectMembership', { user: `User/${users.entry![0].resource!.id}` });
  const membership = memberships.entry?.flatMap(entry => entry.resource?.project.reference === `Project/${credentials.projectId}` ? [entry.resource] : [])[0];
  assert.ok(membership?.id && membership.profile.reference);
  const policy = policies.find(policy => policy.meta?.tag?.some(tag => tag.system === ODOS_PRACTICE_ROLE_SYSTEM && tag.code === role));
  assert.ok(policy?.id);
  const bound = { ...membership, admin: false, access: buildProjectMembershipAccess({ policyReference: `AccessPolicy/${policy.id}`, parameters: {
    patientCompartmentReference: fixture.patientReference,
    ...(role === 'provider' ? { providerProfileReference: membership.profile.reference } : {}),
  } }) };
  delete bound.accessPolicy;
  const binding = await fetch(`${baseUrl}/admin/projects/${credentials.projectId}/members/${membership.id}`, { method: 'POST', headers: { ...headers, Authorization: `Bearer ${admin.accessToken}` }, body: JSON.stringify(bound) });
  assert.equal(binding.status, 200, `Synthetic ${role} policy binding`);
  const password = await fetch(`${baseUrl}/admin/super/setpassword`, { method: 'POST', headers, body: JSON.stringify({ email: credentials[role].email, password: credentials[role].password }) });
  assert.equal(password.status, 200, `Synthetic ${role} password`);
  const identity = await createAuthenticatedFhirClient({ baseUrl, ...credentials[role] });
  assert.equal(await identity.fhir.getActiveProjectId(), credentials.projectId);
  assert.equal(await identity.fhir.getAuthenticatedProfileReference(), membership.profile.reference);
  await identity.fhir.read('Patient', fixture.patientReference.slice(8));
  credentials[role].membershipReference = `ProjectMembership/${membership.id}`;
  credentials[role].practitionerReference = membership.profile.reference;
  credentials[role].policyReference = `AccessPolicy/${policy.id}`;
  save('credentials.json', credentials);
}
for (const [key, status, start] of [['current', 'in-progress', '2026-09-17T14:00:00Z'], ['prior', 'in-progress', '2026-09-16T14:00:00Z'], ['closed', 'finished', '2026-09-15T14:00:00Z'], ['preRebuild', 'in-progress', '2026-09-14T14:00:00Z']] as const) {
  if (fixture[key]) continue;
  const encounter = await seeder.fhir.create<Encounter>({ resourceType: 'Encounter', status,
    class: { code: 'AMB' }, subject: { reference: fixture.patientReference },
    period: { start }, participant: [{ individual: { reference: credentials.provider.practitionerReference } }],
  });
  fixture[key] = `Encounter/${encounter.id}`;
  save('fixture.json', fixture);
}
const definitions = await new FhirFindingDefinitionStore(seeder.fhir).list();
assert.ok(definitions.length > 0);
save('bootstrap-identity.json', { projectId: credentials.projectId, patientReference: fixture.patientReference,
  provider: { practitionerReference: credentials.provider.practitionerReference, policyReference: credentials.provider.policyReference },
  staff: { practitionerReference: credentials.staff.practitionerReference, policyReference: credentials.staff.policyReference },
  encounters: fixture, definitions: definitions.length,
});
console.log(JSON.stringify({ projectId: credentials.projectId, fixture, definitions: definitions.length, roles: ['provider', 'staff'] }));

await seedUiRuntime(runtime);
