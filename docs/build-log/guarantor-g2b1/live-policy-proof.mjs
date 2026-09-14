import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { sourceRoot, refreshFixtureTokens, successfulHttp, http, grantPatients, createLiveClients, resourceEvidence, writeEvidence } from './live-fixture.mjs';

const fixture = await refreshFixtureTokens();
const startedAt = new Date().toISOString();
const paths = [
  'mcp/src/clinic/guarantor-link-operation.ts', 'mcp/src/clinic/guarantor-routes.ts',
  'mcp/src/authz/roles.ts', 'mcp/src/authz/liveAudit.ts',
  'scripts/sync-practice-role-policy-rules.ts', 'ui/src/lib/guarantor-editor.ts',
];
const provenance = () => ({
  head: spawnSync('git', ['rev-parse', 'HEAD'], { cwd: sourceRoot, encoding: 'utf8' }).stdout.trim(),
  files: Object.fromEntries(paths.map((path) => [path, createHash('sha256').update(readFileSync(resolve(sourceRoot, path))).digest('hex')])),
});
const beforeSource = provenance();
const operationModule = await import(pathToFileURL(resolve(sourceRoot, paths[0])).href);
const { authenticateStaffRoute } = await import(pathToFileURL(resolve(sourceRoot, 'mcp/src/payments/payment-endpoint.ts')).href);
const { syncPracticeRolePolicyRules, LivePracticeRolePolicyRuleSyncAdapter } = await import(pathToFileURL(resolve(sourceRoot, paths[4])).href);
const { fhir: browserFhir, SESSION_STORAGE_KEY } = await import(pathToFileURL(resolve(sourceRoot, 'ui/src/lib/fhir.ts')).href);
const editor = await import(pathToFileURL(resolve(sourceRoot, paths[5])).href);
const { handleGuarantorOperation, GUARANTOR_OPERATION_SYSTEM: CODE, GUARANTOR_CLAIM_URL: CLAIM } = operationModule;
const { audit, serviceFhir } = await createLiveClients(fixture);
const events = [], checks = [], mutations = [], recoveries = [];
let scenario = 'setup';
let checksFailed = 0;
let mutationMode = false;
const originalFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const value = input instanceof Request ? input.url : String(input);
  const url = new URL(value, fixture.baseUrl);
  assert.equal(url.origin, fixture.baseUrl, 'Proof requests stay on the disposable Medplum origin.');
  const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
  const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
  const authorization = headers.get('authorization');
  const principal = Object.entries(fixture.principals).find(([, principal]) => authorization === `Bearer ${principal.token}`)?.[0]
    ?? (authorization === `Bearer ${fixture.serviceToken}` ? 'service' : 'other');
  const sequence = events.length + 1;
  const event = { sequence, scenario, principal, method, path: url.pathname + url.search };
  events.push(event);
  if (headers.has('if-match')) event.ifMatch = headers.get('if-match');
  if (url.pathname.startsWith('/fhir/')) {
    const body = init?.body;
    if (typeof body === 'string') event.request = resourceEvidence(JSON.parse(body), url.pathname);
  }
  const response = await originalFetch(input instanceof Request ? new Request(url, input) : url, init);
  event.status = response.status;
  if (url.pathname.startsWith('/fhir/')) event.response = resourceEvidence(await response.clone().json());
  return response;
};

function check(name, actual, expected) {
  let passed = true;
  try { assert.deepEqual(actual, expected); } catch { passed = false; if (!mutationMode) checksFailed++; }
  checks.push({ scenario, name, actual, expected, passed, ...(mutationMode ? { expectedFailure: true } : {}) });
  return passed;
}
function recordMutation(name, firstCheck, expectedResponses) {
  const observations = checks.slice(firstCheck);
  const guard = spawnSync(process.execPath, ['--input-type=module', '-e', "import assert from 'node:assert/strict'; import {readFileSync} from 'node:fs'; const checks=JSON.parse(readFileSync(0,'utf8')); assert.deepEqual(checks.map(c=>c.actual), checks.map(c=>c.expected));"], {
    encoding: 'utf8', input: JSON.stringify(observations),
  });
  mutations.push({ name, observations, redExitCode: guard.status, redOutput: guard.stderr,
    caught: guard.status === 1 && observations.length > 0 && observations.every((item, index) => !item.passed && item.actual === expectedResponses[index]) });
}
const createdPatients = [];
const name = (given) => [{ family: 'Synthetic', given: [given] }];
async function make(resource) {
  return successfulHttp(fixture, 'POST', `/fhir/R4/${resource.resourceType}`, { body: { ...resource, meta: { ...resource.meta, project: fixture.projectA } }, scenario });
}
async function read(type, id) { return successfulHttp(fixture, 'GET', `/fhir/R4/${type}/${id}`, { scenario }); }
async function put(resource, principal = 'service') {
  return http(fixture, 'PUT', `/fhir/R4/${resource.resourceType}/${resource.id}`, {
    body: resource, token: principal === 'service' ? fixture.serviceToken : fixture.principals[principal].token,
    principal, scenario, headers: { 'If-Match': `W/"${resource.meta.versionId}"` },
  });
}
async function createFamily(label) {
  const patient = await make({ resourceType: 'Patient', name: name(`${label} patient`) });
  createdPatients.push(patient.id);
  const child = await make({ resourceType: 'RelatedPerson', patient: { reference: `Patient/${patient.id}` }, active: true,
    period: { start: '2020-01-01' }, relationship: [{ text: `${label} synthetic relationship` }],
    name: name(`${label} source`), extension: [{ url: 'https://example.invalid/g2b1-fixture-sentinel', valueString: label }] });
  const source = await make({ resourceType: 'Person', active: true, name: name(`${label} source`), link: [{ target: { reference: `RelatedPerson/${child.id}` }, assurance: 'level2' }] });
  const destination = await make({ resourceType: 'Person', active: true, name: name(`${label} destination`) });
  return { patient, child, source, destination };
}
async function authorizePatients() {
  for (const principal of ['staff', 'composite']) await grantPatients(fixture, principal, [fixture.patientId, ...createdPatients]);
}
async function inputFor(family) {
  const resources = await Promise.all([read('Person', family.source.id), read('Person', family.destination.id), read('RelatedPerson', family.child.id)]);
  return { operationId: randomUUID(), kind: 'transfer', sourcePersonId: family.source.id, destinationPersonId: family.destination.id,
    relatedPersonIds: [family.child.id], expected: Object.fromEntries(resources.map((resource) => [`${resource.resourceType}/${resource.id}`, resource.meta.versionId])), reason: `Synthetic ${scenario} proof` };
}
async function staff(principal) {
  const result = await authenticateStaffRoute({ baseUrl: fixture.baseUrl, authHeader: `Bearer ${fixture.principals[principal].token}`, serviceClient: serviceFhir, audit });
  assert.ok(result, `Real ${principal} session authenticates.`);
  return result;
}
const deps = { serviceFhir, serviceReference: fixture.serviceReference, recordAudit: (row) => audit.record(row, () => undefined) };
async function action(principal, request, overrides) {
  return handleGuarantorOperation({ ...deps, ...overrides }, await staff(principal), request);
}
async function restorePolicies() {
  const result = await syncPracticeRolePolicyRules(new LivePracticeRolePolicyRuleSyncAdapter(serviceFhir), {
    projectId: fixture.projectA, apply: true, bootstrapServiceIdentity: true,
    assertProjectScope: async () => { throw new Error('The actual sync must apply its bootstrap resource scope check.'); },
  });
  recoveries.push({ scenario, result });
  return result;
}
async function mutateConstraint(resourceType, mode, principals = ['staff', 'composite']) {
  for (const principal of principals) {
    const policy = await read('AccessPolicy', fixture.principals[principal].policyId);
    const resource = policy.resource.map((rule) => {
      if (rule.resourceType !== resourceType || !rule.interaction?.some((operation) => ['create', 'update'].includes(operation))) return rule;
      if (mode === 'remove') { const { writeConstraint, ...rest } = rule; return rest; }
      return { ...rule, writeConstraint: [{ language: 'text/fhirpath', expression: '(%before.exists() implies (%before.link = %after.link)) and (%before.empty() implies %after.link.empty())' }] };
    });
    assert.equal((await put({ ...policy, resource })).status, 200);
  }
}
function taskClone(task, status = 'in-progress') {
  const { id, meta, extension, ...body } = task;
  return { ...body, status, meta: { project: fixture.projectA }, identifier: task.identifier.map((identifier) => ({ ...identifier, value: randomUUID() })) };
}
async function taskFenceCases(task, principal) {
  const results = [];
  for (const [label, change] of [
    ['status mutation', (resource) => ({ ...resource, status: 'failed' })],
    ['input mutation', (resource) => ({ ...resource, input: [...resource.input, { type: { text: 'untrusted' }, valueString: 'Synthetic laundering attempt' }] })],
    ['code removal', (resource) => { const { code, ...body } = resource; return body; }],
  ]) {
    const target = await make(taskClone(task));
    const result = await put(change(target), principal);
    results.push({ label, status: result.status, target: target.id });
    check(`L17 ${principal} ${label}`, result.status, 403);
  }
  const result = await http(fixture, 'POST', '/fhir/R4/Task', { body: taskClone(task, 'completed'), token: fixture.principals[principal].token, principal, scenario });
  results.push({ label: 'completed creation', status: result.status });
  check(`L17 ${principal} completed creation`, result.status, 403);
  return results;
}
async function linkChangeCase(family, principal) {
  const source = await read('Person', family.source.id);
  const result = await put({ ...source, link: [] }, principal);
  check(`L18 ${principal} link change`, result.status, 403);
  return result.status;
}
async function emptyNameCase(principal) {
  const empty = await make({ resourceType: 'Person', active: true, name: name(`${principal} empty`) });
  const result = await put({ ...empty, name: name(`${principal} empty edited`) }, principal);
  check(`L18 ${principal} empty-link name edit`, result.status, 200);
  return result.status;
}
async function g2aSave(family, principal) {
  const session = JSON.stringify({ accessToken: fixture.principals[principal].token, expiresAt: Date.now() + 300_000 });
  browserFhir.rehydrateSession({ getItem: (key) => key === SESSION_STORAGE_KEY ? session : null, setItem() {}, removeItem() {} });
  const loaded = await editor.loadGuarantor(family.child.id);
  check(`L18 ${principal} G2a loaded editor`, loaded.kind, 'editable');
  if (loaded.kind !== 'editable') return;
  const saved = await editor.saveGuarantor(loaded.snapshot, { name: name(`${principal} G2a saved`), telecom: [], address: [] });
  check(`L18 ${principal} G2a save`, saved.status, 'saved');
  check(`L18 ${principal} G2a child write`, saved.children[0]?.writeStatus, 'updated');
}
async function baselinePersonCases(principal) {
  const family = await createFamily(`${principal} L18`);
  await authorizePatients();
  await linkChangeCase(family, principal);
  const linked = await read('Person', family.source.id);
  check(`L18 ${principal} linked name edit`, (await put({ ...linked, name: name(`${principal} linked edited`) }, principal)).status, 200);
  await emptyNameCase(principal);
  const withLink = await http(fixture, 'POST', '/fhir/R4/Person', { body: { resourceType: 'Person', name: name(`${principal} linked create`), link: linked.link }, token: fixture.principals[principal].token, principal, scenario });
  check(`L18 ${principal} create with link`, withLink.status, 403);
  const withoutLink = await http(fixture, 'POST', '/fhir/R4/Person', { body: { resourceType: 'Person', name: name(`${principal} empty create`) }, token: fixture.principals[principal].token, principal, scenario });
  check(`L18 ${principal} create without link`, withoutLink.status, 201);
  await g2aSave(family, principal);
}

let fatal;
try {
  scenario = 'policy restore before baseline';
  await restorePolicies();
  scenario = 'L17 genuine operation';
  const original = await createFamily('L17 genuine');
  const copied = await createFamily('L17 copied claim');
  await authorizePatients();
  let competed = false;
  const competingFhir = {
    ...serviceFhir,
    executeTransactionAsActor: async (...args) => {
      const resource = args[0].entry?.[0]?.resource;
      if (!competed && resource?.resourceType === 'Person' && resource.id === original.source.id) {
        competed = true;
        const source = await read('Person', original.source.id);
        assert.equal((await put({ ...source, name: name('L17 competing source edit') }, 'staff')).status, 200);
      }
      return serviceFhir.executeTransactionAsActor(...args);
    },
  };
  const result = await action('staff', { action: 'create', body: await inputFor(original) }, { serviceFhir: competingFhir });
  check('Original run stops at a real conditional conflict', result.status, 409);
  const task = result.body.task;
  assert.ok(task?.id, 'Actual service returned the recorded operation Task.');
  check('Genuine Task remains active', task.status, 'in-progress');
  check('Genuine Task is service authored', (await read('Task', task.id)).meta.author.reference, fixture.serviceReference);
  for (const principal of ['staff', 'composite']) {
    scenario = `L17 ${principal} Task fence baseline`;
    await taskFenceCases(task, principal);
    const ordinary = await successfulHttp(fixture, 'POST', '/fhir/R4/Task', { body: { resourceType: 'Task', intent: 'order', status: 'requested', code: { text: 'Synthetic ordinary task' } }, token: fixture.principals[principal].token, principal, scenario });
    check(`Ordinary ${principal} Task remains writable`, (await put({ ...ordinary, description: 'Synthetic ordinary update' }, principal)).status, 200);
  }
  scenario = 'L17 staff-authored legacy fake fixture';
  let fake;
  try {
    await mutateConstraint('Task', 'remove', ['staff']);
    fake = await successfulHttp(fixture, 'POST', '/fhir/R4/Task', { body: taskClone(task), token: fixture.principals.staff.token, principal: 'staff', scenario });
    check('Legacy fake is actually staff authored', fake.meta.author.reference, fixture.principals.staff.profileReference);
  } finally { await restorePolicies(); }
  scenario = 'L17(i) staff fake is inert';
  const claimed = await read('RelatedPerson', original.child.id);
  assert.equal((await put({ ...claimed, extension: [...(claimed.extension ?? []).filter((extension) => extension.url !== CLAIM), { url: CLAIM, valueReference: { reference: `Task/${fake.id}` } }] }, 'staff')).status, 200);
  check('Actual S4 preview ignores a staff-authored fake', (await action('staff', { action: 'preview', body: await inputFor(original) })).status, 200);
  scenario = 'L17(vii) Correct refuses staff-authored Task';
  const beforeWrites = events.length;
  const correction = await action('staff', { action: 'correct', taskId: fake.id, body: { operationId: randomUUID(), reason: 'Synthetic fake correction refusal' } });
  check('Actual Correct refuses non-service author', correction.status, 403);
  check('Refused Correct writes no operation resources', events.slice(beforeWrites).filter((event) => ['POST','PUT','PATCH','DELETE'].includes(event.method) && /^\/fhir\/R4\/(Task|Person|RelatedPerson)(\/|$)/.test(event.path)).length, 0);
  scenario = 'L17(ii) copied genuine claim is inert';
  const extra = await read('RelatedPerson', copied.child.id);
  assert.equal((await put({ ...extra, extension: [...(extra.extension ?? []), { url: CLAIM, valueReference: { reference: `Task/${task.id}` } }] }, 'staff')).status, 200);
  check('Actual S4 preview ignores genuine claim on an unlisted child', (await action('staff', { action: 'preview', body: await inputFor(copied) })).status, 200);
  scenario = 'L17 Task fence mutation';
  const beforeMutation = checks.length;
  try {
    await mutateConstraint('Task', 'remove');
    mutationMode = true;
    for (const principal of ['staff', 'composite']) await taskFenceCases(task, principal);
    recordMutation('Task constraint removed', beforeMutation, [200,200,200,201,200,200,200,201]);
  } finally { mutationMode = false; await restorePolicies(); }
  scenario = 'L17 restored Task fence';
  for (const principal of ['staff', 'composite']) await taskFenceCases(task, principal);
  for (const principal of ['staff', 'composite']) {
    scenario = `L18 ${principal} baseline`;
    await baselinePersonCases(principal);
  }
  scenario = 'L18 Person fence removed';
  const linkMutationStart = checks.length;
  try {
    await mutateConstraint('Person', 'remove');
    mutationMode = true;
    for (const principal of ['staff', 'composite']) await linkChangeCase(await createFamily(`L18 mutant ${principal}`), principal);
    recordMutation('Person constraint removed', linkMutationStart, [200,200]);
  } finally { mutationMode = false; await restorePolicies(); }
  scenario = 'L18 revision 1 empty-link expression';
  const emptyMutationStart = checks.length;
  try {
    await mutateConstraint('Person', 'revision1');
    mutationMode = true;
    for (const principal of ['staff', 'composite']) await emptyNameCase(principal);
    recordMutation('Revision 1 Person expression', emptyMutationStart, [403,403]);
  } finally { mutationMode = false; await restorePolicies(); }
  for (const principal of ['staff', 'composite']) {
    scenario = `L18 ${principal} restored`;
    await baselinePersonCases(principal);
  }
} catch (error) {
  fatal = { name: error.name, message: error.message, stack: error.stack };
} finally {
  scenario = 'final canonical policy restore';
  try { await restorePolicies(); } catch (error) { fatal ??= { name: error.name, message: `Final policy restore failed: ${error.message}` }; }
  const auditRows = await audit.queryRows({ from: startedAt, limit: 1000 });
  writeEvidence('live-policy-proof.json', { mode: 'author development capture; not final-head evaluation', startedAt, beforeSource, afterSource: provenance(), checks, mutations, checksFailed, fatal, auditRows, restoreRuns: recoveries });
  writeEvidence('live-policy-http.json', { mode: 'Real Medplum HTTP; relative browser FHIR URLs forwarded to the disposable origin', events }, 0);
  await audit.close();
  globalThis.fetch = originalFetch;
}
console.log(JSON.stringify({ positiveChecks: checks.filter((check) => !check.expectedFailure).length, checksFailed, expectedRedAssertions: checks.filter((check) => check.expectedFailure && !check.passed).length, mutations: mutations.map(({ name, caught, redExitCode }) => ({ name, caught, redExitCode })), fatal, httpEvents: events.length }));
if (fatal || checksFailed || mutations.some((mutation) => !mutation.caught)) process.exitCode = 1;
