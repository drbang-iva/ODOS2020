import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import type { Patient } from '@medplum/fhirtypes';
import { loadVerifiedOperatorFhirClient } from '../../../../scripts/operator-identity.js';
import { replaceCommsPreferenceCells } from '../../../../mcp/src/comms/suppression-gate.js';
import { buildAgeOfMajorityConfigResource } from '../../../../mcp/src/clinic/age-of-majority-config.js';

const runtime = fileURLToPath(new URL('../../../../.odos/email-e1a-proof/', import.meta.url));
const read = (name: string) => JSON.parse(readFileSync(join(runtime, name), 'utf8'));
const manifest = read('manifest.json'), credentials = read('credentials.json'), fixture = read('fixture.json');
assert.equal(manifest.project, 'odos-email-e1a-proof');
const seeder = await loadVerifiedOperatorFhirClient({
  baseUrl: `http://127.0.0.1:${manifest.ports.medplum}`, projectId: credentials.projectId,
  postgresUrl: `postgresql://medplum:medplum@127.0.0.1:${manifest.ports.postgres}/medplum`,
  credentialPath: join(runtime, 'operator.env'), statePath: join(runtime, 'operator-state.json'),
});
const patient = await seeder.fhir.read<Patient>('Patient', fixture.patientReference.slice(8));
const { Pool } = createRequire(fileURLToPath(new URL('../../../../mcp/package.json', import.meta.url)))('pg');
const pool = new Pool({ connectionString: `postgresql://medplum:medplum@127.0.0.1:${manifest.ports.postgres}/medplum` });
let membership: any;
try {
  const result = await pool.query('SELECT content FROM "ProjectMembership" WHERE id = $1 AND deleted = false', [credentials.staff.membershipReference.split('/')[1]]);
  assert.equal(result.rows.length, 1);
  membership = JSON.parse(result.rows[0].content);
} finally { await pool.end(); }
const policy: any = await seeder.fhir.read('AccessPolicy', credentials.staff.policyReference.split('/')[1]);
assert.equal(membership.admin, false);
assert.ok(JSON.stringify(membership.access).includes(credentials.staff.policyReference));
assert.ok(policy.meta?.tag?.some((tag: any) => tag.code === 'staff'));
writeFileSync(process.env.E1A_EVIDENCE ? join(process.env.E1A_EVIDENCE, 'staff-policy.json') : fileURLToPath(new URL('../staff-policy.json', import.meta.url)), JSON.stringify({
  projectId: credentials.projectId, membershipReference: credentials.staff.membershipReference,
  practitionerReference: credentials.staff.practitionerReference, admin: membership.admin,
  policyReference: credentials.staff.policyReference, policyVersion: policy.meta.versionId,
  policyTags: policy.meta.tag, source: 'Read-only SQL of task-owned synthetic membership and seeder FHIR read of canonical Staff policy; no policy edits for browser proof.',
}, null, 2) + '\n');
const majority = buildAgeOfMajorityConfigResource({ ageOfMajorityYears: 18 });
const existing = await seeder.fhir.search('Basic', { code: `${majority.code.coding![0].system}|${majority.code.coding![0].code}` });
if (!existing.entry?.length) await seeder.fhir.create(majority);
const updated = replaceCommsPreferenceCells({ ...patient,
  name: [{ given: ['E1a'], family: 'Synthetic Patient' }],
  telecom: [{ system: 'email', value: 'synthetic-patient@example.invalid' }],
}, [{ purpose: 'education', channel: 'email', allowed: false }], {
  setBy: { reference: credentials.staff.practitionerReference }, surface: 'staff-demographics', recordedAt: new Date().toISOString(),
});
await seeder.fhir.update('Patient', patient.id!, updated, { 'If-Match': `W/"${patient.meta!.versionId}"` });
console.log('Synthetic patient seeded with explicit education/email OFF. No patient email sent.');
