import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadVerifiedOperatorFhirClient } from '../../../../scripts/operator-identity.js';
import { createAuthenticatedFhirClient } from '../../../../scripts/r10-served-route/login.js';
import { FhirDiagnosisCatalogStore } from '../../../../mcp/src/clinical-graph/diagnosis-catalog-store.js';
import { FhirDiagnosisPickTallyStore } from '../../../../mcp/src/clinical-graph/diagnosis-pick-tally-store.js';
import { createOperatorScriptFhirClient } from '../../../../mcp/src/fhir-client.js';
import { resolveStarterDiagnosisPins } from '../../../../mcp/src/clinical-graph/diagnosis-quick-list-endpoint.js';

export async function seedUiRuntime(runtime: string) {
  const manifest = JSON.parse(readFileSync(join(runtime, 'manifest.json'), 'utf8'));
  assert.ok(['odos-s3b1-proof'].includes(manifest.project));
  const baseUrl = `http://127.0.0.1:${manifest.ports.medplum}`;
  const credentials = JSON.parse(readFileSync(join(runtime, 'credentials.json'), 'utf8'));
  const seeder = await loadVerifiedOperatorFhirClient({ baseUrl, projectId: credentials.projectId,
    postgresUrl: `postgresql://medplum:medplum@127.0.0.1:${manifest.ports.postgres}/medplum`,
    credentialPath: join(runtime, 'operator.env'), statePath: join(runtime, 'operator-state.json'),
  });
  const bootstrapIdentity = JSON.parse(readFileSync(join(runtime, 'service.json'), 'utf8'));
  const bootstrap = await createAuthenticatedFhirClient({ baseUrl, ...bootstrapIdentity });
  const project = await bootstrap.fhir.read<any>('Project', credentials.projectId);
  const quotaSettings = [{ name: 'userFhirQuota', valueInteger: 5_000_000 }, { name: 'totalFhirQuota', valueInteger: 50_000_000 }];
  const policiesBeforeQuota = await Promise.all(['provider', 'staff'].map(role => seeder.fhir.read('AccessPolicy', credentials[role].policyReference.slice('AccessPolicy/'.length))));
  if (quotaSettings.some(setting => !project.systemSetting?.some((current: any) => current.name === setting.name && current.valueInteger === setting.valueInteger))) {
    await bootstrap.fhir.update('Project', project.id, { ...project, systemSetting: [...(project.systemSetting ?? []).filter((setting: any) => !quotaSettings.some(quota => quota.name === setting.name)), ...quotaSettings] }, { 'If-Match': `W/"${project.meta.versionId}"` });
  }
  const verifiedProject = await bootstrap.fhir.read<any>('Project', credentials.projectId);
  for (const quota of quotaSettings) assert.equal(verifiedProject.systemSetting.find((setting: any) => setting.name === quota.name)?.valueInteger, quota.valueInteger);
  for (const [index, role] of ['provider', 'staff'].entries()) assert.deepEqual(await seeder.fhir.read('AccessPolicy', credentials[role].policyReference.slice('AccessPolicy/'.length)), policiesBeforeQuota[index]);
  writeFileSync(join(runtime, 'synthetic-fhir-quota.json'), JSON.stringify({ projectId: credentials.projectId, weightedUnitsPerMinute: quotaSettings, callerPoliciesUnchanged: true }, null, 2) + '\n');
  const catalog = await new FhirDiagnosisCatalogStore(seeder.fhir).list();
  const pins = resolveStarterDiagnosisPins(catalog);
  const tally = new FhirDiagnosisPickTallyStore(seeder.fhir);
  for (const role of ['provider', 'staff']) await tally.initializePinnedIfAbsent(credentials[role].practitionerReference, pins.pinnedDiagnosisKeys, new Date().toISOString());
  if (!credentials.runtimeService) {
    const admin = await createAuthenticatedFhirClient({ baseUrl, ...credentials.admin });
    const response = await fetch(`${baseUrl}/admin/projects/${credentials.projectId}/client`, {
      method: 'POST', headers: { Authorization: `Bearer ${admin.accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'R10 A3.2 synthetic runtime service', description: 'Dedicated disposable project-scoped MCP service, separate from operator seeder.' }),
    });
    assert.equal(response.status, 201, 'Create disposable runtime service');
    const client = await response.json() as { id?: string; secret?: string };
    assert.ok(client.id && client.secret);
    credentials.runtimeService = { clientId: client.id, clientSecret: client.secret };
    writeFileSync(join(runtime, 'credentials.json'), JSON.stringify(credentials, null, 2) + '\n', { mode: 0o600 });
  }
  const callerPolicies = await Promise.all(['provider', 'staff'].map(async role => {
    const reference = credentials[role].policyReference as string;
    return { role, reference, resource: await seeder.fhir.read('AccessPolicy', reference.slice('AccessPolicy/'.length)) };
  }));
  let accessToken = await runtimeToken(baseUrl, credentials.runtimeService);
  let me = await (await fetch(`${baseUrl}/auth/me`, { headers: { Authorization: `Bearer ${accessToken}` } })).json() as any;
  assert.equal(me.project.id, credentials.projectId);
  assert.equal(me.profile.id, credentials.runtimeService.clientId);
  const admin = await createAuthenticatedFhirClient({ baseUrl, ...credentials.admin });
  const readMembership = async () => {
    const response = await fetch(`${baseUrl}/admin/projects/${credentials.projectId}/members/${me.membership.id}`, { headers: { Authorization: `Bearer ${admin.accessToken}` } });
    assert.equal(response.status, 200);
    return await response.json() as any;
  };
  let membership = await readMembership();
  assert.equal(membership.project.reference, `Project/${credentials.projectId}`);
  assert.ok(!membership.accessPolicy && !membership.access?.length, 'Runtime service has no clinical role policy');
  if (membership.admin !== true) {
    const response = await fetch(`${baseUrl}/admin/projects/${credentials.projectId}/members/${me.membership.id}`, {
      method: 'POST', headers: { Authorization: `Bearer ${admin.accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...membership, admin: true }),
    });
    assert.equal(response.status, 200, 'Synthetic runtime requires project-admin membership reads for caller role resolution');
    accessToken = await runtimeToken(baseUrl, credentials.runtimeService);
    me = await (await fetch(`${baseUrl}/auth/me`, { headers: { Authorization: `Bearer ${accessToken}` } })).json() as any;
  }
  assert.equal(me.project.id, credentials.projectId);
  membership = await readMembership();
  assert.equal(membership.admin, true);
  const runtimeFhir = createOperatorScriptFhirClient({ baseUrl, accessToken, reason: 'Verify disposable project-scoped runtime service identity and caller role lookup.' });
  const clientReference = await runtimeFhir.getAuthenticatedProfileReference();
  assert.equal(clientReference, membership.profile.reference);
  await runtimeFhir.search('ProjectMembership', { profile: credentials.provider.practitionerReference });
  for (const policy of callerPolicies) assert.deepEqual(await seeder.fhir.read('AccessPolicy', policy.reference.slice('AccessPolicy/'.length)), policy.resource, `${policy.role} canonical AccessPolicy unchanged`);
  writeFileSync(join(runtime, 'runtime-service-identity.json'), JSON.stringify({ projectId: credentials.projectId, clientReference, membershipReference: `ProjectMembership/${me.membership.id}`, admin: membership.admin, separateFromSeeder: me.profile.id !== seeder.state.clientId, providerTallySeeded: true, callerPoliciesUnchanged: callerPolicies.map(policy => ({ role: policy.role, reference: policy.reference, versionId: policy.resource.meta?.versionId })) }, null, 2) + '\n');
  assert.notEqual(me.profile.id, seeder.state.clientId);
  console.log('Synthetic quicklists and separate project-scoped runtime service ready.');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await seedUiRuntime(resolve(process.argv[2]));

async function runtimeToken(baseUrl: string, service: { clientId: string; clientSecret: string }): Promise<string> {
  const response = await fetch(`${baseUrl}/oauth2/token`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'client_credentials', client_id: service.clientId, client_secret: service.clientSecret }) });
  assert.equal(response.status, 200);
  const token = await response.json() as { access_token: string };
  return token.access_token;
}
