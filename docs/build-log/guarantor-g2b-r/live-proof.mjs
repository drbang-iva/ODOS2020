import assert from 'node:assert/strict';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const privateDirectory = resolve(root, '.odos/g2br-live');
mkdirSync(privateDirectory, { recursive: true, mode: 0o700 });
const originalFixture = readFileSync(resolve(root, 'docs/build-log/guarantor-g2b1/live-fixture.mjs'), 'utf8');
let fixtureSource = originalFixture;
for (const [before, after] of [
  ["'g2b1-build-live'", "'g2br-live'"],
  ["'10.249.60.0/24'", "'10.249.80.0/24'"],
  ['{ medplum: 28760, postgres: 28761, redis: 28762, odos: 28763, ui: 28764, proof: 28765 }', '{ medplum: 29080, postgres: 29081, redis: 29082, odos: 29083, ui: 29084, proof: 29085 }'],
  ["const fixtureRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');", 'const fixtureRoot = resolve(process.env.G2BR_ROOT);'],
  ['`${fixtureRoot}/.odos/g2b1-build-live`', '`${fixtureRoot}/.odos/g2br-live`'],
  ['`${fixtureRoot}/docs/build-log/guarantor-g2b1`', '`${fixtureRoot}/docs/build-log/guarantor-g2b-r`'],
]) {
  assert.ok(fixtureSource.includes(before));
  fixtureSource = fixtureSource.replaceAll(before, after);
}
const fixturePath = resolve(privateDirectory, 'fixture.mjs');
writeFileSync(fixturePath, fixtureSource, { mode: 0o600 });
process.env.G2BR_ROOT = root;
process.env.G2B1_SOURCE_ROOT = root;
if (process.argv[2] === 'fixture') {
  const result = spawnSync(process.execPath, ['--import', 'tsx', fixturePath, process.argv[3]], { cwd: root, env: process.env, stdio: 'inherit' });
  process.exit(result.status ?? 1);
}
const variant = process.argv[3];
assert.ok(['before', 'after'].includes(variant));
const mode = process.argv[2];
assert.ok(['run', 'serve'].includes(mode));
const source = resolve(process.env.G2BR_PROOF_SOURCE ?? root);
const fromSource = path => import(pathToFileURL(resolve(source, path)).href);
const fixtureApi = await import(pathToFileURL(fixturePath).href);
const { refreshFixtureTokens, createLiveClients, successfulHttp, http, grantPatients, resourceEvidence, writeEvidence } = fixtureApi;
const fixture = await refreshFixtureTokens();
const appOrigin = `http://127.0.0.1:${mode === 'serve' && variant === 'after' ? 29083 : 29085}`;
const { default: express } = await fromSource('mcp/node_modules/express/index.js');
const { registerGuarantorRoutes } = await fromSource('mcp/src/clinic/guarantor-routes.ts');
const { authenticateStaffRoute } = await fromSource('mcp/src/payments/payment-endpoint.ts');
const { GUARANTOR_CLAIM_URL } = await fromSource('mcp/src/clinic/guarantor-link-operation.ts');
const { buildMedplumAccessPolicy, getRoleDeclaration } = await fromSource('mcp/src/authz/roles.ts');
const { audit, serviceFhir } = await createLiveClients(fixture);
const context = new AsyncLocalStorage();
const events = [], transactions = [], checks = [], cases = [];
const patients = [fixture.patientId];
let scenario = 'premise', afterTransaction;
const rawFetch = globalThis.fetch;
function responseEvidence(body, path) {
  if (path === '/auth/me') return { project: resourceEvidence(body.project), profile: resourceEvidence(body.profile), membership: resourceEvidence(body.membership), accessPolicy: resourceEvidence(body.accessPolicy) };
  return resourceEvidence(body, path);
}
globalThis.fetch = async (input, init) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  assert.ok([fixture.baseUrl, appOrigin].includes(url.origin), 'HTTP stays on the two owned loopback origins');
  const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
  const frame = context.getStore();
  const principal = Object.entries(fixture.principals).find(([, p]) => headers.get('authorization') === `Bearer ${p.token}`)?.[0] ?? (headers.get('authorization') === `Bearer ${fixture.serviceToken}` ? 'service' : 'none');
  const event = { sequence: events.length + 1, scenario, runner: frame?.runner, phase: frame?.phase, principal,
    origin: url.origin, method: init?.method ?? 'GET', path: url.pathname + url.search,
    ...(headers.has('if-match') ? { ifMatch: headers.get('if-match') } : {}),
    ...(typeof init?.body === 'string' ? { request: resourceEvidence(JSON.parse(init.body), url.pathname) } : {}) };
  events.push(event);
  const response = await rawFetch(input, init);
  event.status = response.status;
  try { event.response = responseEvidence(await response.clone().json(), url.pathname); } catch { event.response = '<non-JSON>'; }
  return response;
};
const instrumentedFhir = { ...serviceFhir, executeTransactionAsActor: async (...args) => {
  const entry = args[0].entry[0];
  const phase = args[1].actionReason.split(' ')[1];
  const frame = context.getStore();
  const transaction = { sequence: transactions.length + 1, scenario, runner: frame?.runner, phase, method: entry.request.method, target: entry.request.url, ifMatch: entry.request.ifMatch };
  transactions.push(transaction);
  return context.run({ ...frame, phase }, async () => {
    try {
      const result = await serviceFhir.executeTransactionAsActor(...args);
      transaction.status = Number.parseInt(result.entry?.[0]?.response?.status ?? '', 10);
      if (afterTransaction) await afterTransaction(transaction);
      return result;
    } catch (error) {
      transaction.error = { message: error.message, status: error.status ?? error.statusCode };
      throw error;
    }
  });
} };
const app = express();
app.use(express.json());
app.use((req, _res, next) => context.run({ runner: req.header('x-g2br-runner') ?? 'browser' }, next));
registerGuarantorRoutes(app, {
  authenticateService: async () => { assert.equal(await serviceFhir.getAuthenticatedProfileReference(), fixture.serviceReference); },
  authenticate: header => authenticateStaffRoute({ baseUrl: fixture.baseUrl, authHeader: header, serviceClient: serviceFhir, audit }),
  serviceFhir: instrumentedFhir, recordAudit: row => audit.record(row, () => undefined),
});
const server = await new Promise((done, fail) => {
  const instance = app.listen(Number(new URL(appOrigin).port), '127.0.0.1', () => done(instance));
  instance.once('error', fail);
});
function check(name, actual, expected) {
  checks.push({ scenario, name, actual, expected });
  assert.deepEqual(actual, expected, name);
}
const make = resource => successfulHttp(fixture, 'POST', `/fhir/R4/${resource.resourceType}`, { body: { ...resource, meta: { project: fixture.projectA } }, scenario });
const read = (type, id) => successfulHttp(fixture, 'GET', `/fhir/R4/${type}/${id}`, { scenario });
const claimRefs = child => (child.extension ?? []).filter(e => e.url === GUARANTOR_CLAIM_URL).map(e => e.valueReference?.reference);
const journal = task => JSON.parse(task.extension?.find(e => e.url.endsWith('/guarantor-link-journal'))?.valueString ?? '{"intents":[]}');
async function owners(child) {
  const bundle = await successfulHttp(fixture, 'GET', `/fhir/R4/Person?_project=${fixture.projectA}&link=${encodeURIComponent(`RelatedPerson/${child.id}`)}`, { scenario });
  return (bundle.entry ?? []).map(e => e.resource.id).sort();
}
async function family() {
  const patient = await make({ resourceType: 'Patient', name: [{ family: 'Synthetic', given: [scenario, variant] }] });
  const child = await make({ resourceType: 'RelatedPerson', active: true, patient: { reference: `Patient/${patient.id}` }, name: [{ family: 'Source' }] });
  const siblingPatient = await make({ resourceType: 'Patient', name: [{ family: 'Synthetic sibling' }] });
  const sibling = await make({ resourceType: 'RelatedPerson', patient: { reference: `Patient/${siblingPatient.id}` }, name: [{ family: 'Sibling' }] });
  const sourcePerson = await make({ resourceType: 'Person', active: true, name: [{ family: 'Source' }], link: [{ target: { reference: `RelatedPerson/${child.id}` }, assurance: 'level2' }] });
  const destination = await make({ resourceType: 'Person', active: true, name: [{ family: 'Destination' }], telecom: [{ system: 'phone', value: '202-555-0199' }], address: [{ city: 'Synthetic town' }], link: [{ target: { reference: `RelatedPerson/${sibling.id}` }, assurance: 'level2' }] });
  patients.push(patient.id, siblingPatient.id);
  for (const principal of ['staff', 'composite']) await grantPatients(fixture, principal, patients);
  return { patient, child, sibling, source: sourcePerson, destination };
}
async function inputFor(f) {
  const resources = await Promise.all([read('Person', f.source.id), read('Person', f.destination.id), read('RelatedPerson', f.child.id)]);
  return { operationId: randomUUID(), kind: 'transfer', sourcePersonId: f.source.id, destinationPersonId: f.destination.id, relatedPersonIds: [f.child.id], expected: Object.fromEntries(resources.map(r => [`${r.resourceType}/${r.id}`, r.meta.versionId])), reason: `Synthetic ${scenario}` };
}
async function route(runner, action, body, taskId) {
  return context.run({ runner }, async () => {
    const path = `/guarantors/link-operations${taskId ? `/${taskId}` : ''}${action === 'create' ? '' : `/${action}`}`;
    const response = await fetch(appOrigin + path, { method: 'POST', headers: { Authorization: `Bearer ${fixture.principals[runner === 'B' ? 'composite' : 'staff'].token}`, 'Content-Type': 'application/json', 'X-G2br-Runner': runner }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, body: await response.json() };
  });
}
async function snapshot(f, taskIds) {
  const [sourcePerson, destination, child, tasks] = await Promise.all([read('Person', f.source.id), read('Person', f.destination.id), read('RelatedPerson', f.child.id), Promise.all(taskIds.map(id => read('Task', id)))]);
  return { source: sourcePerson, destination, child, owners: await owners(child), tasks };
}
const paths = ['mcp/src/clinic/guarantor-link-operation.ts', 'mcp/src/clinic/guarantor-routes.ts', 'mcp/src/authz/roles.ts', 'mcp/src/fhir-client.ts'];
const provenance = { head: spawnSync('git', ['rev-parse', 'HEAD'], { cwd: source, encoding: 'utf8' }).stdout.trim(), files: Object.fromEntries(paths.map(path => [path, createHash('sha256').update(readFileSync(resolve(source, path))).digest('hex')])), fixtureSourceSha256: createHash('sha256').update(originalFixture).digest('hex') };
let completed = false;
try {
  if (mode === 'serve') {
    console.log(JSON.stringify({ serving: appOrigin, variant, provenance }));
    await new Promise(done => { process.once('SIGINT', done); process.once('SIGTERM', done); });
  } else {
    const health = await (await fetch(`${fixture.baseUrl}/healthcheck`)).json();
    check('pinned Medplum version', health.version, '5.1.30-9b1bd92');
    for (const id of [fixture.serviceProject, fixture.projectA, fixture.projectB]) {
      check(`transaction-bundles absent on Project/${id}`, (await read('Project', id)).features?.includes('transaction-bundles') ?? false, false);
    }
    const policy = await read('AccessPolicy', fixture.principals.staff.policyId);
    check('staff policy matches current compiler', policy.resource, buildMedplumAccessPolicy(getRoleDeclaration('staff')).resource);
    for (scenario of ['X1', 'X2']) {
      const f = await family();
      const original = await route('A', 'create', await inputFor(f));
      check('A completes', original.body.task?.status, 'completed');
      const originalId = original.body.task.id;
      const phase = scenario === 'X1' ? 'detaching' : 'releasing';
      let losses = 0;
      afterTransaction = async transaction => {
        const target = scenario === 'X1' ? `Person/${f.destination.id}` : `RelatedPerson/${f.child.id}`;
        if (transaction.runner !== 'C' || transaction.phase !== phase || transaction.target !== target || losses) return;
        check('reply loss follows committed write', transaction.status, 200);
        losses++;
        transaction.replyLost = true;
        const error = new Error('reply lost');
        check('reply loss has no status', error.status ?? error.statusCode ?? null, null);
        throw error;
      };
      const correction = await route('C', 'correct', { operationId: randomUUID(), reason: 'Synthetic Undo' }, originalId);
      afterTransaction = undefined;
      check('one reply dropped', losses, 1);
      check('C is recovery-conflict', [correction.status, correction.body.phase], [409, 'recovery-conflict']);
      const correctionId = correction.body.task.id;
      const pending = await snapshot(f, [originalId, correctionId]);
      const unresolved = journal(pending.tasks[1]).intents.filter(i => !i.disposition);
      check('one unresolved intent', unresolved.map(i => i.phase), [phase]);
      check('intent version moved', (scenario === 'X1' ? pending.destination : pending.child).meta.versionId !== unresolved[0].expectedVersion, true);
      check('post-loss owners', pending.owners, scenario === 'X1' ? [] : [f.source.id]);
      check('post-loss claims', claimRefs(pending.child), scenario === 'X1' ? [`Task/${correctionId}`] : []);
      let later;
      if (scenario === 'X1') {
        const person = await read('Person', f.destination.id);
        const edited = await http(fixture, 'PUT', `/fhir/R4/Person/${person.id}`, { principal: 'staff', token: fixture.principals.staff.token, headers: { 'If-Match': `W/"${person.meta.versionId}"` }, body: { ...person, name: [{ family: 'Staff renamed destination' }] }, scenario });
        check('staff name-only edit lands under policy', edited.status, 200);
        check('name edit preserves links', edited.body.link, person.link);
      } else {
        later = await route('B', 'create', await inputFor(f));
        check('later B completes', [later.status, later.body.task?.status], [200, 'completed']);
      }
      const afterCompetitor = await snapshot(f, [originalId, correctionId]);
      const offset = transactions.length;
      const first = await route('C', 'complete', undefined, correctionId);
      const repeated = variant === 'before' ? await route('C', 'complete', undefined, correctionId) : undefined;
      const nested = await route('C', 'correct', { operationId: randomUUID(), reason: 'Synthetic correction of correction' }, correctionId);
      const final = await snapshot(f, [originalId, correctionId]);
      check('Complete outcome', [first.status, first.body.phase], variant === 'before' ? [409, 'interfered'] : [200, 'linked']);
      if (repeated) check('repeated Complete remains stuck', [repeated.status, repeated.body.phase], [409, 'interfered']);
      check('Correct C refuses', nested.status, 422);
      check('C terminal state', final.tasks[1].status, variant === 'before' ? 'in-progress' : 'completed');
      check('final owners', final.owners, scenario === 'X1' ? (variant === 'before' ? [] : [f.source.id]) : [f.destination.id]);
      check('final claims', claimRefs(final.child), scenario === 'X1' && variant === 'before' ? [`Task/${correctionId}`] : []);
      if (scenario === 'X2') {
        check('A status', final.tasks[0].status, variant === 'before' ? 'completed' : 'cancelled');
        check('no child attempt after B completed', transactions.slice(offset).filter(t => t.target === `RelatedPerson/${f.child.id}`).length, 0);
        check('B child version preserved', final.child.meta.versionId, afterCompetitor.child.meta.versionId);
      }
      cases.push({ scenario, family: f, original, correction, pending, afterCompetitor, later, complete: first, repeated, nested, final });
      console.log(JSON.stringify({ variant, scenario, complete: first.status, phase: first.body.phase, owners: final.owners, claims: claimRefs(final.child), originalStatus: final.tasks[0].status, correctionStatus: final.tasks[1].status }));
    }
    completed = true;
  }
} finally {
  const report = { variant, mode, completed, provenance, checks, cases, transactions };
  writeEvidence(`live-${variant}${mode === 'serve' ? '-browser-server' : ''}.json`, report);
  writeEvidence(`live-${variant}${mode === 'serve' ? '-browser-server' : ''}-http.json`, { provenance, events });
  await new Promise((done, fail) => server.close(error => error ? fail(error) : done()));
  await audit.close();
  globalThis.fetch = rawFetch;
}
