import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildDiagnosisCatalogSeeds } from '../../../mcp/src/clinical-graph/diagnosis-catalog-seeds.ts';
import { ICD10_CM_CODE_SYSTEM } from '../../../mcp/src/clinical-graph/glaucoma-suspect.ts';
import { DIAGNOSIS_CODE_LEDGER_PATHS, loadDiagnosisCodeLedger } from '../../../mcp/src/clinical-graph/diagnosis-code-ledgers.ts';
import type { AccessPolicy, ChargeItemDefinition, Condition, Encounter, Patient, ProjectMembership } from '@medplum/fhirtypes';
import { createAuthenticatedFhirClient } from '../../../mcp/tests/integration-helpers.ts';
import { loadVerifiedOperatorFhirClient } from '../../../scripts/operator-identity.ts';
import { buildProjectMembershipAccess, ODOS_PRACTICE_ROLE_SYSTEM } from '../../../mcp/src/authz/roles.ts';
import { FhirEncounterExamScopeStore } from '../../../mcp/src/clinical-graph/exam-scope-store.ts';
import { DIAGNOSIS_KEY_IDENTIFIER_SYSTEM } from '../../../mcp/src/clinical-graph/diagnosis-pick-endpoint.ts';
import { buildProcedureFeeDefinition } from '../../../mcp/src/clinical-graph/procedure-fee-schedule.ts';
import { createPostgresPool } from '../../../mcp/src/postgres.ts';

const runtime = process.env.W1_RUNTIME_DIR!;
assert.ok(runtime);
const base = process.env.MEDPLUM_BASE_URL!;
assert.equal(base, 'http://localhost:18103/');
const mcpBase = 'http://127.0.0.1:3334';
const projectId = process.env.MEDPLUM_PROJECT_ID;
assert.ok(projectId);
const admin = await createAuthenticatedFhirClient({ baseUrl: base, email: process.env.MEDPLUM_ADMIN_EMAIL!, password: process.env.MEDPLUM_ADMIN_PASSWORD! });
const superCredentials = process.env;
const superUser = await createAuthenticatedFhirClient({ baseUrl: base, email: superCredentials.MEDPLUM_SUPER_EMAIL!, password: superCredentials.MEDPLUM_SUPER_PASSWORD! });
const seeder = await loadVerifiedOperatorFhirClient({ baseUrl: base, projectId, postgresUrl: process.env.W1_MEDPLUM_POSTGRES_URL });
const proofDb = createPostgresPool({ connectionString: process.env.W1_MEDPLUM_POSTGRES_URL }, 'w1 synthetic identity proof');
const headers = { Authorization: `Bearer ${admin.accessToken}`, 'Content-Type': 'application/json' };
const patient = await seeder.fhir.create<Patient>({ resourceType: 'Patient', active: true, name: [{ family: 'W1Synthetic', given: ['Patient'] }] });
assert.ok(patient.id);
const policies = (await admin.fhir.search<AccessPolicy>('AccessPolicy', { _count: '100' })).entry?.flatMap(entry => entry.resource ? [entry.resource] : []) ?? [];
const policy = (role: 'provider' | 'admin') => {
  const matches = policies.filter(row => row.meta?.tag?.filter(tag => tag.system === ODOS_PRACTICE_ROLE_SYSTEM).map(tag => tag.code).join(',') === role);
  assert.equal(matches.length, 1, `canonical ${role} policy`);
  return `AccessPolicy/${matches[0]!.id}`;
};
const providerPolicy = policy('provider');
const adminPolicy = policy('admin');
const runId = randomUUID().slice(0, 8);

async function human(role: 'provider' | 'composite') {
  const email = `w1-${role}-${runId}@example.test`;
  const password = `W1-${randomUUID()}!`;
  const invited = await fetch(`${base}admin/projects/${projectId}/invite`, { method: 'POST', headers, body: JSON.stringify({ resourceType: 'Practitioner', email, firstName: 'W1', lastName: role, sendEmail: false }) });
  assert.ok(invited.ok || invited.status === 409, `${role} invite HTTP ${invited.status}`);
  const membership = await invited.json() as ProjectMembership;
  const users = await proofDb.query<{ id: string }>('SELECT id FROM "User" WHERE email = $1 AND deleted = false', [email]);
  assert.equal(users.rows.length, 1, `${role} synthetic User`);
  const memberships = await proofDb.query<{ id: string; profile: string }>('SELECT id, profile FROM "ProjectMembership" WHERE "user" = $1 AND project = $2 AND deleted = false', [`User/${users.rows[0]!.id}`, `Project/${projectId}`]);
  assert.equal(memberships.rows.length, 1, `${role} project membership`);
  assert.equal(membership.id, memberships.rows[0]!.id, `${role} invite membership`);
  assert.equal(membership.profile?.reference, memberships.rows[0]!.profile, `${role} stored profile`);
  assert.ok(membership.id && membership.profile?.reference, `${role} profile reference`);
  const providerAccess = buildProjectMembershipAccess({ policyReference: providerPolicy, parameters: { patientCompartmentReference: `Patient/${patient.id}`, providerProfileReference: membership.profile.reference } });
  const access = role === 'provider' ? providerAccess : [...providerAccess, ...buildProjectMembershipAccess({ policyReference: adminPolicy })];
  const { accessPolicy: _legacy, ...withoutLegacy } = membership;
  const bound = await fetch(`${base}admin/projects/${projectId}/members/${membership.id}`, { method: 'POST', headers, body: JSON.stringify({ ...withoutLegacy, admin: role === 'composite', access }) });
  assert.equal(bound.status, 200, `${role} role bind`);
  const boundMembership = await bound.json() as ProjectMembership;
  assert.equal(boundMembership.admin, role === 'composite', `${role} admin membership`);
  assert.ok(boundMembership.access?.some(entry => entry.policy?.reference === providerPolicy), `${role} provider policy access`);
  if (role === 'composite') assert.ok(boundMembership.access?.some(entry => entry.policy?.reference === adminPolicy), `${role} admin policy access`);
  const setPassword = await fetch(`${base}admin/super/setpassword`, { method: 'POST', headers: { ...headers, Authorization: `Bearer ${superUser.accessToken}` }, body: JSON.stringify({ email, password }) });
  assert.equal(setPassword.status, 200, `${role} password`);
  const identity = await createAuthenticatedFhirClient({ baseUrl: base, email, password });
  assert.equal(await identity.fhir.getAuthenticatedProfileReference(), membership.profile.reference);
  console.log(`${role}: invite=${invited.status} User=1 ProjectMembership=1 profile=present binding=${bound.status} admin=${boundMembership.admin} provider-access=true`);
  return { token: identity.accessToken, profile: membership.profile.reference };
}

const provider = await human('provider');
const composite = await human('composite');
const fee = await seeder.fhir.create<ChargeItemDefinition>(buildProcedureFeeDefinition({ procedureConceptKey: 'fundus-photography', display: 'Synthetic fundus photography', category: 'procedure', priceCents: 6000, billingCode: 'SYNTHETIC' }));
assert.ok(fee.id);
const diagnosis = buildDiagnosisCatalogSeeds().find(row => row.stableKey === 'glaucoma_suspect_open_angle_high')!;
const diagnosisCode = diagnosis.icd10?.pattern?.bilateral;
assert.ok(diagnosisCode);
const diagnosisDisplay = loadDiagnosisCodeLedger(DIAGNOSIS_CODE_LEDGER_PATHS.glaucomaSuspect).find(row => row.code === diagnosisCode)!.display;
async function visit(profile: string, token: string) {
  let encounter = await seeder.fhir.create<Encounter>({ resourceType: 'Encounter', status: 'in-progress', class: { code: 'AMB' }, subject: { reference: `Patient/${patient.id}` }, period: { start: '2026-09-25T12:00:00Z' }, participant: [{ individual: { reference: profile } }] });
  const condition = await seeder.fhir.create<Condition>({ resourceType: 'Condition', subject: { reference: `Patient/${patient.id}` }, encounter: { reference: `Encounter/${encounter.id}` }, identifier: [{ system: DIAGNOSIS_KEY_IDENTIFIER_SYSTEM, value: `${encounter.id}::glaucoma_suspect_open_angle_high::bilateral` }], code: { coding: [{ system: ICD10_CM_CODE_SYSTEM, code: diagnosisCode, display: diagnosisDisplay }], text: 'Glaucoma suspect' } });
  encounter = await seeder.fhir.update<Encounter>('Encounter', encounter.id!, { ...encounter, diagnosis: [{ condition: { reference: `Condition/${condition.id}` }, rank: 1 }] });
  const overview = await fetch(`${mcpBase}/clinical-graph/encounters/${encounter.id}/exam-overview`, { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(overview.status, 200, 'derive glaucoma-suspect visit shape');
  const scope = await new FhirEncounterExamScopeStore(seeder.fhir).get(encounter.id!);
  assert.ok(scope.profilesApplied?.some(row => row.profileKey === 'glaucoma'));
  assert.ok(scope.testsProposed?.some(row => row.orderable === 'fundus-photography' && row.focus === 'optic nerve'));
  return encounter.id!;
}
const providerEncounter = await visit(provider.profile, provider.token);
const compositeEncounter = await visit(composite.profile, composite.token);
const fixture = { providerEncounter, compositeEncounter, patientId: patient.id, providerProfile: provider.profile, compositeProfile: composite.profile };
writeFileSync(join(runtime, 'w1-live-fixture.json'), JSON.stringify(fixture), { mode: 0o600 });
writeFileSync(join(runtime, 'w1-provider-token'), provider.token, { mode: 0o600 });
writeFileSync(join(runtime, 'w1-composite-token'), composite.token, { mode: 0o600 });

async function queue(label: string, encounterId: string, token: string) {
  const response = await fetch(`${mcpBase}/clinical-graph/encounters/${encounterId}/follow-up-queue`, { headers: { Authorization: `Bearer ${token}` } });
  const body = await response.json() as { rows?: Array<{ state?: string; orderable?: string }>; error?: string };
  console.log(`${label} queue=${response.status} row=${body.rows?.find(row => row.orderable === 'fundus-photography')?.state ?? 'none'} error=${body.error ?? 'none'}`);
  assert.equal(response.status, 200, `${label} live request must succeed`);
  return response.status;
}
async function accept(label: string, encounterId: string, token: string) {
  const response = await fetch(`${mcpBase}/clinical-graph/encounters/${encounterId}/follow-up-queue/accept`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ orderable: 'fundus-photography', focus: 'optic nerve' }) });
  const body = await response.json() as { code?: string; error?: string; rows?: Array<{ state?: string; orderable?: string }> };
  console.log(`${label} accept=${response.status} code=${body.code ?? 'none'} error=${body.error ?? 'none'} row=${body.rows?.find(row => row.orderable === 'fundus-photography')?.state ?? 'none'}`);
  assert.equal(response.status, 200, `${label} live request must succeed`);
  return response.status;
}
try {
await queue('provider', providerEncounter, provider.token);
await accept('provider', providerEncounter, provider.token);
await queue('composite', compositeEncounter, composite.token);
await accept('composite', compositeEncounter, composite.token);
} finally { await proofDb.end(); }
