import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const targetRoot = resolve(process.argv[2] ?? '');
const action = process.argv[3];
if (!['dry-run', 'apply'].includes(action)) throw new Error('Use dry-run or apply');
const baseUrl = process.env.MEDPLUM_BASE_URL?.replace(/\/$/, '');
const projectId = process.env.MEDPLUM_PROJECT_ID;
if (baseUrl !== 'http://localhost:18103' || !projectId || projectId !== process.env.ODOS_OPERATOR_PROJECT_ID) {
  throw new Error('Refusing policy sync: synthetic localhost/project mismatch');
}
const targetModule = await import(pathToFileURL(join(targetRoot, 'scripts/sync-practice-role-policy-rules.ts')).href);
const { createOperatorScriptFhirClient } = await import(pathToFileURL(join(targetRoot, 'mcp/src/fhir-client.ts')).href);
const { loginForLocalRepair } = await import(pathToFileURL(join(targetRoot, 'scripts/repair-practice-roles.ts')).href);
const { exchangeOperatorCredential } = await import(pathToFileURL(join(targetRoot, 'data/medplum-adapters/operator-bootstrap-adapter.ts')).href);
let adminToken;
for (let attempt = 1; attempt <= 15; attempt += 1) {
  try {
    adminToken = await loginForLocalRepair({
      baseUrl,
      email: process.env.MEDPLUM_ADMIN_EMAIL,
      password: process.env.MEDPLUM_ADMIN_PASSWORD,
      projectId,
    });
    break;
  } catch (error) {
    if (!String(error).includes('Medplum login failed: 429') || attempt === 15) throw error;
    await new Promise(resolve => setTimeout(resolve, 5000));
  }
}
const seederToken = await exchangeOperatorCredential(baseUrl, {
  projectId,
  clientId: process.env.ODOS_OPERATOR_CLIENT_ID,
  clientSecret: process.env.ODOS_OPERATOR_CLIENT_SECRET,
});
for (const [name, token] of [['admin reader', adminToken], ['operator writer', seederToken]]) {
  const response = await fetch(`${baseUrl}/auth/me`, { headers: { Authorization: `Bearer ${token}` } });
  if (!response.ok) throw new Error(`${name} session HTTP ${response.status}`);
  const session = await response.json();
  if (session.project?.id !== projectId || !session.membership?.id) throw new Error(`${name} project mismatch`);
}
const adminFhir = createOperatorScriptFhirClient({baseUrl, accessToken: adminToken, reason:'Synthetic policy proof read', extendedMode:true});
const seederFhir = createOperatorScriptFhirClient({baseUrl, accessToken: seederToken, reason:'Synthetic policy proof write', extendedMode:true});
const admin = new targetModule.LivePracticeRolePolicyRuleSyncAdapter(adminFhir);
const seeder = new targetModule.LivePracticeRolePolicyRuleSyncAdapter(seederFhir);
const readOnly = {
  readPolicies: (id) => admin.readPolicies(id),
  readMemberships: (id) => admin.readMemberships(id),
  createPolicy: () => { throw new Error('Task-only adapter refuses policy creation'); },
  patchPolicy: () => { throw new Error('Task-only dry run refuses policy write'); },
  patchMembership: () => { throw new Error('Task-only adapter refuses membership write'); },
};
const options = {projectId, bootstrapServiceIdentity:true, assertProjectScope:async()=>{throw new Error('Unexpected scope check');}};
const preview = await targetModule.syncPracticeRolePolicyRules(readOnly, {...options, apply:false});
console.log(targetModule.formatPracticeRolePolicyRuleSync(preview));
if (action === 'dry-run') process.exit(0);
if (preview.compositesRequired !== 0 || preview.membershipsDrifted !== 0) throw new Error('Task-only adapter refuses composite creation or membership drift');
const drift = preview.policies.filter(item => item.status === 'drift');
if (drift.some(item => !['staff','provider+staff'].includes(item.roles.join('+')))) {
  throw new Error('Task-only adapter refuses unexpected policy drift');
}
const allowed = new Set(drift.map(item => item.policyReference.split('/')[1]));
const writer = {
  ...readOnly,
  patchPolicy: (id, operations, versionId) => {
    if (!allowed.has(id) || operations.length !== 1 || operations[0].path !== '/resource') {
      throw new Error('Task-only adapter refuses out-of-scope policy patch');
    }
    return seeder.patchPolicy(id, operations, versionId);
  },
};
const applied = await targetModule.syncPracticeRolePolicyRules(writer, {...options, apply:true});
console.log(targetModule.formatPracticeRolePolicyRuleSync(applied));
