import assert from 'node:assert/strict';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { sourceRoot, refreshFixtureTokens, successfulHttp, http, grantPatients, createLiveClients, resourceEvidence, writeEvidence } from './live-fixture.mjs';

const appOrigin = 'http://127.0.0.1:28765';
const fixture = await refreshFixtureTokens();
const startedAt = new Date().toISOString();
const paths = ['mcp/src/clinic/guarantor-link-operation.ts', 'mcp/src/clinic/guarantor-routes.ts', 'mcp/src/fhir-client.ts', 'ui/src/lib/guarantor-editor.ts', 'ui/src/lib/guarantor-link-operations.ts', 'mcp/src/authz/role-grants.ts'];
const provenance = () => ({ head: spawnSync('git', ['rev-parse', 'HEAD'], { cwd: sourceRoot, encoding: 'utf8' }).stdout.trim(), files: Object.fromEntries(paths.map(path => [path, createHash('sha256').update(readFileSync(resolve(sourceRoot, path))).digest('hex')])) });
const beforeSource = provenance();
const fromSource = path => import(pathToFileURL(resolve(sourceRoot, path)).href);
const { default: express } = await fromSource('mcp/node_modules/express/index.js');
const { registerGuarantorRoutes } = await fromSource(paths[1]);
const { authenticateStaffRoute } = await fromSource('mcp/src/payments/payment-endpoint.ts');
const { GUARANTOR_CLAIM_URL: CLAIM } = await fromSource(paths[0]);
const { fhir: browserFhir, SESSION_STORAGE_KEY } = await fromSource('ui/src/lib/fhir.ts');
const editor = await fromSource(paths[3]);
const { audit, serviceFhir } = await createLiveClients(fixture);
const context = new AsyncLocalStorage();
const events = [], transactions = [], checks = [], cases = [];
const patients = [];
let scenario = 'setup', failed = 0, fatal;
let beforeTransaction, afterTransaction, afterResponse;
function responseEvidence(value, path) {
  if (path !== '/auth/me') return resourceEvidence(value);
  return { evidenceProjection: 'Authentication identity, membership and Person/Task policy rules only; full response digest retained',
    fullResponseSha256: createHash('sha256').update(JSON.stringify(value)).digest('hex'),
    project: resourceEvidence(value.project), profile: resourceEvidence(value.profile),
    membership: resourceEvidence(value.membership), accessPolicy: resourceEvidence(value.accessPolicy),
  };
}
function transactionEvidence(transaction) {
  const { request, response, ...metadata } = transaction;
  return { ...metadata,
    ...(request ? { requestSha256: createHash('sha256').update(JSON.stringify(request)).digest('hex') } : {}),
    ...(response ? { responseSha256: createHash('sha256').update(JSON.stringify(response)).digest('hex') } : {}),
  };
}
const originalFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const value = input instanceof Request ? input.url : String(input);
  const url = new URL(value, value.startsWith('/guarantors/') ? appOrigin : fixture.baseUrl);
  assert.ok([fixture.baseUrl, appOrigin].includes(url.origin), 'Live proof stays on its two loopback origins.');
  const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
  const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
  const principal = headers.get('authorization') === `Bearer ${fixture.principals.composite.token}` ? 'composite' : headers.get('authorization') === `Bearer ${fixture.serviceToken}` ? 'service' : 'other';
  const frame = context.getStore();
  const event = { sequence: events.length + 1, scenario, runner: frame?.runner, phase: frame?.transaction?.phase, principal, method, path: url.pathname + url.search, origin: url.origin };
  events.push(event);
  if (headers.has('if-match')) event.ifMatch = headers.get('if-match');
  if (typeof init?.body === 'string') event.request = resourceEvidence(JSON.parse(init.body), url.pathname);
  const response = await originalFetch(input instanceof Request ? new Request(url, input) : url, init);
  event.status = response.status;
  try { event.response = responseEvidence(await response.clone().json(), url.pathname); } catch { event.response = '<non-JSON>'; }
  if (afterResponse) await afterResponse(event, frame?.transaction);
  return response;
};
const instrumentedFhir = {
  ...serviceFhir,
  executeTransactionAsActor: async (...args) => {
    const entry = args[0].entry[0], frame = context.getStore();
    const transaction = { sequence: transactions.length + 1, scenario, runner: frame?.runner, phase: args[1].actionReason.split(' ')[1], method: entry.request.method, target: entry.request.url, ifMatch: entry.request.ifMatch, request: resourceEvidence(entry.resource) };
    transactions.push(transaction);
    return context.run({ ...frame, transaction }, async () => {
      try {
        if (beforeTransaction) await beforeTransaction(transaction);
        const result = await serviceFhir.executeTransactionAsActor(...args);
        transaction.status = Number.parseInt(result.entry?.[0]?.response?.status ?? '', 10);
        transaction.response = resourceEvidence(result.entry?.[0]?.resource);
        if (afterTransaction) await afterTransaction(transaction);
        return result;
      } catch (error) {
        transaction.error = { name: error.name, message: error.message };
        throw error;
      }
    });
  },
};
const app = express();
app.use(express.json());
app.use((req, _res, next) => context.run({ runner: req.header('x-g2b1-proof-runner') ?? 'editor' }, next));
registerGuarantorRoutes(app, {
  authenticateService: async () => { assert.equal(await serviceFhir.getAuthenticatedProfileReference(), fixture.serviceReference); },
  authenticate: header => authenticateStaffRoute({ baseUrl: fixture.baseUrl, authHeader: header, serviceClient: serviceFhir, audit }),
  serviceFhir: instrumentedFhir,
  recordAudit: row => audit.record(row, () => undefined),
});
const server = await new Promise((accept, reject) => { const server = app.listen(28765, '127.0.0.1', () => accept(server)); server.once('error', reject); });
const session = JSON.stringify({ accessToken: fixture.principals.composite.token, expiresAt: Date.now() + 3_600_000 });
browserFhir.rehydrateSession({ getItem: key => key === SESSION_STORAGE_KEY ? session : null, setItem() {}, removeItem() {} });

const name = given => [{ family: 'Synthetic', given: [given] }];
function check(name, actual, expected) {
  let passed = true;
  try { assert.deepEqual(actual, expected); } catch { passed = false; failed++; }
  checks.push({ scenario, name, actual, expected, passed });
  return passed;
}
async function make(resource, project = fixture.projectA) {
  return successfulHttp(fixture, 'POST', `/fhir/R4/${resource.resourceType}`, { body: { ...resource, meta: { ...resource.meta, project } }, scenario });
}
async function read(type, id) { return successfulHttp(fixture, 'GET', `/fhir/R4/${type}/${id}`, { scenario }); }
async function put(resource, principal = 'service') {
  return http(fixture, 'PUT', `/fhir/R4/${resource.resourceType}/${resource.id}`, { body: resource, scenario, principal, token: principal === 'service' ? fixture.serviceToken : fixture.principals.composite.token, headers: { 'If-Match': `W/"${resource.meta.versionId}"` } });
}
async function createFamily(label, { sibling = false, foreignDestination = false, foreignPatient = false } = {}) {
  const patient = await make({ resourceType: 'Patient', name: name(`${label} patient`) }, foreignPatient ? fixture.projectB : fixture.projectA);
  if (!foreignPatient) patients.push(patient.id);
  const child = await make({ resourceType: 'RelatedPerson', active: true, patient: { reference: `Patient/${patient.id}` }, name: name(`${label} source`), relationship: [{ text: 'Synthetic related adult' }], period: { start: '2020-01-01' }, extension: [{ url: 'https://example.invalid/g2b1-fixture-sentinel', valueString: label }] });
  const family = { label, patient, child };
  if (sibling) {
    const siblingPatient = await make({ resourceType: 'Patient', name: name(`${label} sibling patient`) });
    patients.push(siblingPatient.id);
    family.sibling = await make({ resourceType: 'RelatedPerson', active: true, patient: { reference: `Patient/${siblingPatient.id}` }, name: name(`${label} source`) });
    family.siblingPatient = siblingPatient;
  }
  family.source = await make({ resourceType: 'Person', active: true, name: name(`${label} source`), link: [child, ...(family.sibling ? [family.sibling] : [])].map(child => ({ target: { reference: `RelatedPerson/${child.id}` }, assurance: 'level2' })) });
  family.destination = await make({ resourceType: 'Person', active: true, name: name(`${label} destination`), telecom: [{ system: 'phone', use: 'home', value: '202-555-0142' }] }, foreignDestination ? fixture.projectB : fixture.projectA);
  await grantPatients(fixture, 'composite', [fixture.patientId, ...patients]);
  return family;
}
async function inputFor(family, destination = family.destination) {
  const resources = await Promise.all([read('Person', family.source.id), read('Person', destination.id), read('RelatedPerson', family.child.id)]);
  return { operationId: randomUUID(), kind: 'transfer', sourcePersonId: family.source.id, destinationPersonId: destination.id, relatedPersonIds: [family.child.id], expected: Object.fromEntries(resources.map(resource => [`${resource.resourceType}/${resource.id}`, resource.meta.versionId])), reason: `Synthetic ${scenario} proof` };
}
async function route(runner, action, body, taskId) {
  const path = `/guarantors/link-operations${taskId ? `/${taskId}` : ''}${action === 'create' || action === 'status' ? '' : `/${action}`}`;
  return context.run({ runner }, async () => {
    const response = await fetch(new URL(path, appOrigin), { method: action === 'status' ? 'GET' : 'POST', headers: { Authorization: `Bearer ${fixture.principals.composite.token}`, 'Content-Type': 'application/json', 'X-G2b1-Proof-Runner': runner }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, body: await response.json() };
  });
}
function claimRefs(child) { return (child.extension ?? []).filter(extension => extension.url === CLAIM).map(extension => extension.valueReference?.reference); }
function withClaim(child, taskId) { return { ...child, extension: [...(child.extension ?? []).filter(extension => extension.url !== CLAIM), ...(taskId ? [{ url: CLAIM, valueReference: { reference: `Task/${taskId}` } }] : [])] }; }
function journal(task) { return JSON.parse(task.extension?.find(extension => extension.url.endsWith('/guarantor-link-journal'))?.valueString ?? '{"intents":[]}'); }
async function owners(child) {
  const bundle = await successfulHttp(fixture, 'GET', `/fhir/R4/Person?_project=${fixture.projectA}&link=${encodeURIComponent(`RelatedPerson/${child.id}`)}`, { scenario });
  return (bundle.entry ?? []).map(entry => entry.resource.id).sort();
}
async function snapshot(family, taskIds = []) {
  const [source, destination, child, tasks] = await Promise.all([read('Person', family.source.id), read('Person', family.destination.id), read('RelatedPerson', family.child.id), Promise.all(taskIds.map(id => read('Task', id)))]);
  return { source, destination, child, owners: await owners(child), tasks, journals: tasks.map(task => journal(task)) };
}
function logicalEntries(event) {
  if (event.origin !== fixture.baseUrl) return [];
  if (event.request?.resourceType !== 'Bundle') return [event];
  return (event.request.entry ?? []).map((entry, index) => ({ ...event,
    transportMethod: event.method, transportPath: event.path, transportStatus: event.status,
    method: entry.request.method, path: `/fhir/R4/${entry.request.url}`, ifMatch: entry.request.ifMatch,
    status: Number.parseInt(event.response?.entry?.[index]?.response?.status ?? `${event.status}`, 10),
    request: entry.resource, response: event.response?.entry?.[index]?.resource,
  }));
}
function fhirWrites(first = 0, runner) { return events.slice(first).flatMap(logicalEntries).filter(event => ['POST', 'PUT', 'PATCH', 'DELETE'].includes(event.method) && (!runner || event.runner === runner)); }
function domainWrites(first = 0, runner) { return fhirWrites(first, runner).filter(event => event.method === 'PUT' && /^\/fhir\/R4\/(Person|RelatedPerson)\//.test(event.path)); }
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
async function timeout(promise, label) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`Schedule timed out: ${label}`)), 30_000); })]); }
  finally { clearTimeout(timer); }
}
async function pendingAttach(family, runner = 'A') {
  let competed = false;
  beforeTransaction = async tx => {
    if (!competed && tx.runner === runner && tx.phase === 'attaching' && tx.target === `Person/${family.destination.id}`) {
      competed = true;
      const fresh = await read('Person', family.destination.id);
      check('Competing D demographic edit lands before phase 3 PUT', (await put({ ...fresh, name: name(`${family.label} current destination`) }, 'composite')).status, 200);
    }
  };
  const response = await route(runner, 'create', await inputFor(family));
  beforeTransaction = undefined;
  check('Original attach conflict is HTTP409', response.status, 409);
  check('Original Task is in-progress/attach-pending', [response.body.task?.status, response.body.task?.businessStatus?.text], ['in-progress', 'attach-pending']);
  assert.ok(response.body.task?.id);
  return response;
}
async function runCase(label, execute) {
  if (process.env.G2B1_CASES && !process.env.G2B1_CASES.split(',').includes(label)) return;
  scenario = label;
  const firstCheck = checks.length, firstEvent = events.length, firstTransaction = transactions.length;
  const record = { scenario, startedAt: new Date().toISOString(), firstSequence: firstEvent + 1 };
  cases.push(record);
  try { Object.assign(record, await execute()); }
  catch (error) { record.fatal = { name: error.name, message: error.message, stack: error.stack }; failed++; }
  finally { beforeTransaction = afterTransaction = afterResponse = undefined; }
  record.checks = checks.slice(firstCheck);
  record.httpCount = events.length - firstEvent;
  record.transactions = transactions.slice(firstTransaction).map(transactionEvidence);
  record.lastSequence = events.length;
  console.log(JSON.stringify({ scenario, checks: record.checks.length, failed: record.checks.filter(check => !check.passed).length, fatal: record.fatal?.message, httpCount: record.httpCount }));
}

try {
  await runCase('L1', async () => {
    const family = await createFamily('L1');
    const d2 = await make({ resourceType: 'Person', active: true, name: name('L1 second destination') });
    const inputA = await inputFor(family), inputB = await inputFor(family, d2);
    const aReady = deferred(), bReady = deferred(), aGo = deferred(), bGo = deferred();
    beforeTransaction = async tx => {
      if (tx.phase !== 'claiming' || tx.target !== `RelatedPerson/${family.child.id}`) return;
      const ready = tx.runner === 'A' ? aReady : bReady, go = tx.runner === 'A' ? aGo : bGo;
      ready.resolve();
      await timeout(go.promise, `${tx.runner} claim barrier`);
    };
    let a, b;
    const aRun = route('A', 'create', inputA);
    await timeout(aReady.promise, 'A admitted before any claim');
    const bRun = route('B', 'create', inputB);
    try {
      await timeout(bReady.promise, 'B admitted before A claims');
      aGo.resolve();
      a = await aRun;
      bGo.resolve();
      b = await bRun;
    } finally { aGo.resolve(); bGo.resolve(); }
    check('A completed', [a.status, a.body.task?.status], [200, 'completed']);
    check('B failed/claim-conflict', [b.status, b.body.task?.status, b.body.task?.businessStatus?.text], [409, 'failed', 'claim-conflict']);
    check('B attempts exactly one child claim, refused412', domainWrites(0, 'B').filter(event => event.scenario === scenario && event.phase === 'claiming' && event.path === `/fhir/R4/RelatedPerson/${family.child.id}`).map(event => event.status), [412]);
    check('Losing starter sends zero Person writes', domainWrites(0, 'B').filter(event => event.scenario === scenario && event.path.startsWith('/fhir/R4/Person/')).length, 0);
    const final = await snapshot(family, [a.body.task.id, b.body.task.id]);
    check('Child has exactly A destination owner', final.owners, [family.destination.id]);
    check('Winning child claim released', claimRefs(final.child), []);
    return { patientIds: [family.patient.id], family, competingDestination: d2, a, b, final };
  });

  await runCase('L3', async () => {
    const family = await createFamily('L3', { sibling: true });
    const original = await pendingAttach(family);
    const pending = await snapshot(family, [original.body.task.id]);
    check('Detach precedes refused attach: child is unowned', pending.owners, []);
    check('Pending child still claimed by A', claimRefs(pending.child), [`Task/${original.body.task.id}`]);
    const loaded = await context.run({ runner: 'editor-pending' }, () => editor.loadGuarantor(family.child.id));
    check('Actual editor loads pending state', loaded.kind, 'pending');
    check('Pending editor names active operation for Complete/Correct', loaded.kind === 'pending' && loaded.operation.active && loaded.operation.task.id === original.body.task.id && loaded.message.includes('Complete or correct'), true);
    const sibling = await context.run({ runner: 'editor-sibling' }, () => editor.loadGuarantor(family.sibling.id));
    check('Sibling remaining under S loads editable', sibling.kind, 'editable');
    assert.equal(sibling.kind, 'editable');
    const siblingSaved = await context.run({ runner: 'editor-sibling' }, () => editor.saveGuarantor(sibling.snapshot, { name: name('L3 sibling source saved'), telecom: [], address: [] }));
    check('Sibling G2a save remains normal', siblingSaved.status, 'saved');
    check('Sibling child write lands', siblingSaved.children.map(child => child.writeStatus), ['updated']);
    const foreignBasedOn = [];
    for (const status of ['in-progress', 'completed']) foreignBasedOn.push(await make({ resourceType: 'Task', intent: 'order', status,
      code: { coding: [{ system: 'https://odos2020.com/fhir/CodeSystem/task-type', code: 'lab-order-transmission' }] },
      basedOn: [{ reference: `Task/${original.body.task.id}` }], description: 'Synthetic foreign-code step0 guard; no lab submit path invoked' }));
    check('Foreign-code based-on fixtures are genuinely service authored', foreignBasedOn.map(task => task.meta.author.reference), [fixture.serviceReference, fixture.serviceReference]);
    const first = events.length;
    const complete = await route('A-complete', 'complete', undefined, original.body.task.id);
    check('Complete completes pending operation', [complete.status, complete.body.task?.status], [200, 'completed']);
    const personWrites = domainWrites(first, 'A-complete').filter(event => event.path.startsWith('/fhir/R4/Person/'));
    check('Complete fences S and D before attaching D', personWrites.map(event => event.phase), ['fence-source', 'fence-destination', 'attaching']);
    const final = await snapshot(family, [original.body.task.id]);
    check('Complete gives one destination owner', final.owners, [family.destination.id]);
    check('Complete projects current competitor-edited D', final.child.name, final.destination.name);
    check('Complete releases the claim', claimRefs(final.child), []);
    const siblingFinal = await read('RelatedPerson', family.sibling.id);
    check('Sibling remains under S', await owners(siblingFinal), [family.source.id]);
    return { patientIds: [family.patient.id, family.siblingPatient.id], family, original, pending, editorPending: loaded, siblingSaved, foreignBasedOn, complete, final, siblingFinal };
  });

  await runCase('L4', async () => {
    const family = await createFamily('L4');
    const child = await read('RelatedPerson', family.child.id);
    check('Divergent child fixture edit lands', (await put({ ...child, name: name('L4 divergent child') }, 'composite')).status, 200);
    const loaded = await context.run({ runner: 'editor-before-claim' }, () => editor.loadGuarantor(family.child.id));
    assert.equal(loaded.kind, 'editable');
    check('Repair fixture is actually mismatched', loaded.verification.children[0].classification, 'mismatched');
    let repair, repairEvents, seen = false;
    afterTransaction = async tx => {
      if (seen || tx.runner !== 'A' || tx.phase !== 'claiming' || tx.target !== `RelatedPerson/${family.child.id}`) return;
      seen = true;
      const first = events.length;
      repair = await context.run({ runner: 'editor-repair' }, () => editor.repairGuarantor(loaded.snapshot));
      repairEvents = events.slice(first);
    };
    const original = await route('A', 'create', await inputFor(family));
    check('Repair runs after real claim200', seen, true);
    check('Repair stops on the fresh claim', repair?.children.map(child => child.writeStatus), ['stopped']);
    check('Repair sends zero RelatedPerson PUTs', repairEvents.filter(event => event.method === 'PUT' && event.path === `/fhir/R4/RelatedPerson/${family.child.id}`).length, 0);
    check('Operation completes after blocked repair', [original.status, original.body.task?.status], [200, 'completed']);
    const final = await snapshot(family, [original.body.task.id]);
    check('Completed child has D details', final.child.name, final.destination.name);
    return { patientIds: [family.patient.id], family, original, repair, repairEvents, final };
  });

  for (const foreign of ['Destination', 'Patient']) await runCase(`L11-${foreign}`, async () => {
    const family = await createFamily(`L11 foreign ${foreign}`, { [`foreign${foreign}`]: true });
    const body = await inputFor(family), first = events.length;
    const response = await route('A', 'create', body);
    check(`Foreign ${foreign} refused422`, response.status, 422);
    check('Scope refusal sends zero operation writes', fhirWrites(first).filter(event => /^\/fhir\/R4\/(Task|Person|RelatedPerson)(\/|$)/.test(event.path)).length, 0);
    return { patientIds: [family.patient.id], family, response, final: await snapshot(family) };
  });

  await runCase('L13', async () => {
    const family = await createFamily('L13');
    let dropped = false;
    afterResponse = async (event, tx) => {
      if (!dropped && tx?.runner === 'A' && tx.phase === 'claiming' && logicalEntries(event).some(write => write.method === 'PUT' && write.path === `/fhir/R4/RelatedPerson/${family.child.id}` && write.status === 200)) {
        dropped = true; event.delivery = 'Response lost after real server200, before application receives it';
        throw new Error('Synthetic lost response');
      }
    };
    const original = await route('A', 'create', await inputFor(family));
    afterResponse = undefined;
    check('Claim200 response was dropped', dropped, true);
    check('Unconfirmed original remains pending', [original.status, original.body.task?.status], [409, 'in-progress']);
    const pending = await snapshot(family, [original.body.task.id]);
    check('Pending claim intent is unresolved', journal(pending.tasks[0]).intents.filter(intent => intent.phase === 'claiming' && !intent.disposition).length, 1);
    check('Staff removes landed claim200', (await put(withClaim(pending.child), 'composite')).status, 200);
    const first = events.length;
    const complete = await route('A-complete', 'complete', undefined, original.body.task.id);
    check('Complete classifies changed content as interfered', [complete.status, complete.body.task?.status, complete.body.task?.businessStatus?.text], [409, 'in-progress', 'interfered']);
    check('Interference allows zero further domain writes', domainWrites(first).length, 0);
    check('Interference response names the child', complete.body.target, `RelatedPerson/${family.child.id}`);
    return { patientIds: [family.patient.id], family, original, pending, complete, final: await snapshot(family, [original.body.task.id]) };
  });

  for (const delivery of ['landed', 'unsent']) await runCase(`L14-${delivery}`, async () => {
    const family = await createFamily(`L14 ${delivery}`);
    let crashed = false;
    if (delivery === 'landed') afterResponse = async (event, tx) => {
      if (!crashed && tx?.runner === 'A' && tx.phase === 'detaching' && logicalEntries(event).some(write => write.method === 'PUT' && write.path === `/fhir/R4/Person/${family.source.id}` && write.status === 200)) {
        crashed = true; event.delivery = 'Detach200 response lost before its Task checkpoint'; throw new Error('Synthetic lost detach response');
      }
    };
    else beforeTransaction = async tx => {
      if (!crashed && tx.runner === 'A' && tx.phase === 'detaching' && tx.target === `Person/${family.source.id}`) {
        crashed = true; tx.delivery = 'Intent recorded; domain PUT never sent'; throw new Error('Synthetic crash before detach send');
      }
    };
    const original = await route('A', 'create', await inputFor(family));
    beforeTransaction = afterResponse = undefined;
    check('Detach crash prefix was reached', crashed, true);
    check('Original retains pending Task', [original.status, original.body.task?.status], [409, 'in-progress']);
    const pending = await snapshot(family, [original.body.task.id]);
    const unresolved = journal(pending.tasks[0]).intents.filter(intent => intent.phase === 'detaching' && !intent.disposition);
    check('Detach intent remains unresolved before recovery', unresolved.length, 1);
    check('Prefix ownership matches delivery', pending.owners, delivery === 'landed' ? [] : [family.source.id]);
    const first = events.length;
    const complete = await route('A-complete', 'complete', undefined, original.body.task.id);
    const fences = domainWrites(first, 'A-complete').filter(event => event.phase === 'fence-source');
    check('First source fence uses original intent expectedVersion', fences[0]?.ifMatch, `W/"${unresolved[0].expectedVersion}"`);
    check('Source fence observes contract delivery statuses', fences.map(event => event.status), delivery === 'landed' ? [412, 200] : [200]);
    check('Recovery completes', [complete.status, complete.body.task?.status], [200, 'completed']);
    const final = await snapshot(family, [original.body.task.id]);
    check('Recovered child has one D owner', final.owners, [family.destination.id]);
    check('Original detach classified from fresh content', journal(final.tasks[0]).intents.find(intent => intent.id === unresolved[0].id)?.disposition, delivery === 'landed' ? 'landed' : 'not-landed');
    return { patientIds: [family.patient.id], family, original, pending, complete, final };
  });

  await runCase('L15-paused', async () => {
    const family = await createFamily('L15 paused');
    const original = await pendingAttach(family);
    const ready = deferred(), go = deferred();
    let paused = false;
    beforeTransaction = async tx => {
      if (!paused && tx.runner === 'A-complete' && tx.phase === 'attaching' && tx.target === `Person/${family.destination.id}`) {
        paused = true; tx.schedule = 'A has read claim, owners and D; paused immediately before its D PUT';
        ready.resolve(); await timeout(go.promise, 'A paused D PUT');
      }
    };
    const aRun = route('A-complete', 'complete', undefined, original.body.task.id);
    let correction, resumed;
    try {
      await timeout(ready.promise, 'A prepared D PUT');
      correction = await route('C', 'correct', { operationId: randomUUID(), reason: 'Synthetic paused-runner correction' }, original.body.task.id);
      go.resolve(); resumed = await aRun;
    } finally { go.resolve(); }
    check('Correct completes while A is paused', [correction.status, correction.body.task?.status], [200, 'completed']);
    check('Paused A stale D PUT is refused412', domainWrites(0, 'A-complete').filter(event => event.scenario === scenario && event.phase === 'attaching' && event.path === `/fhir/R4/Person/${family.destination.id}`).map(event => event.status), [412]);
    const final = await snapshot(family, [original.body.task.id, correction.body.task.id]);
    check('A cancelled and C completed', final.tasks.map(task => task.status), ['cancelled', 'completed']);
    check('Correct leaves exactly original S as owner', final.owners, [family.source.id]);
    check('Correction releases claim', claimRefs(final.child), []);
    const lastAttach = final.journals[0].intents.filter(intent => intent.phase === 'attaching').at(-1);
    check('Late definite A refusal is persisted as rejected', [lastAttach?.disposition, lastAttach?.responseStatus], ['rejected', 412]);
    return { patientIds: [family.patient.id], family, original, correction, resumed, final };
  });

  await runCase('L15-takeover-fail', async () => {
    const family = await createFamily('L15 takeover fail');
    const original = await pendingAttach(family);
    let raced = false;
    beforeTransaction = async tx => {
      if (!raced && tx.runner === 'C' && tx.phase === 'claiming' && tx.target === `RelatedPerson/${family.child.id}`) {
        raced = true;
        const child = await read('RelatedPerson', family.child.id);
        check('Staff edit after C fences and before takeover lands200', (await put({ ...child, name: name('L15 staff takeover competitor') }, 'composite')).status, 200);
      }
    };
    const correction = await route('C', 'correct', { operationId: randomUUID(), reason: 'Synthetic failed takeover' }, original.body.task.id);
    beforeTransaction = undefined;
    check('C fails only takeover-conflict', [correction.status, correction.body.task?.status, correction.body.task?.businessStatus?.text], [409, 'failed', 'takeover-conflict']);
    const pending = await snapshot(family, [original.body.task.id, correction.body.task.id]);
    check('Failed takeover leaves A in-progress', pending.tasks[0].status, 'in-progress');
    check('Failed takeover retains A claim', claimRefs(pending.child), [`Task/${original.body.task.id}`]);
    const cWrites = domainWrites().filter(event => event.scenario === scenario && event.runner === 'C' && event.principal === 'service');
    check('C fences both Persons before refused takeover', cWrites.map(event => [event.phase, event.status]), [['fence-source', 200], ['fence-destination', 200], ['claiming', 412]]);
    const complete = await route('A-complete', 'complete', undefined, original.body.task.id);
    check('A remains completable', [complete.status, complete.body.task?.status], [200, 'completed']);
    const final = await snapshot(family, [original.body.task.id, correction.body.task.id]);
    check('A completion leaves one D owner', final.owners, [family.destination.id]);
    return { patientIds: [family.patient.id], family, original, correction, pending, complete, final };
  });

  await runCase('L15-partial-correction', async () => {
    const family = await createFamily('L15 partial correction');
    const original = await pendingAttach(family);
    const aReady = deferred(), aGo = deferred(), cReady = deferred(), cGo = deferred();
    let aPaused = false, cPaused = false;
    beforeTransaction = async tx => {
      if (!aPaused && tx.runner === 'A-complete' && tx.phase === 'attaching' && tx.target === `Person/${family.destination.id}`) {
        aPaused = true; aReady.resolve(); await timeout(aGo.promise, 'A D PUT while C paused');
      }
      if (!cPaused && tx.runner === 'C' && tx.phase === 'attaching' && tx.target === `Person/${family.source.id}`) {
        cPaused = true; cReady.resolve(); await timeout(cGo.promise, 'C S attach after takeover');
      }
    };
    const aRun = route('A-complete', 'complete', undefined, original.body.task.id);
    let cRun, resumed, correction, interim;
    try {
      await timeout(aReady.promise, 'A prepared D PUT');
      cRun = route('C', 'correct', { operationId: randomUUID(), reason: 'Synthetic partial correction fence' }, original.body.task.id);
      await timeout(cReady.promise, 'C took claim and prepared S attach');
      aGo.resolve(); resumed = await aRun;
      interim = await snapshot(family, [original.body.task.id]);
      check('A yields takeover-in-progress while C is paused', [resumed.status, resumed.body.phase], [409, 'takeover-in-progress']);
      check('A sends only its fenced stale D attempt', domainWrites(0, 'A-complete').filter(event => event.scenario === scenario && event.phase === 'attaching' && event.path === `/fhir/R4/Person/${family.destination.id}` && event.principal === 'service').map(event => event.status), [412]);
      check('Paused C has not attached and A cannot create an owner', interim.owners, []);
      cGo.resolve(); correction = await cRun;
    } finally { aGo.resolve(); cGo.resolve(); }
    check('C completes after A yields', [correction.status, correction.body.task?.status], [200, 'completed']);
    const final = await snapshot(family, [original.body.task.id, correction.body.task.id]);
    check('Stronger paused correction leaves one original S owner', final.owners, [family.source.id]);
    check('Stronger paused correction cancels A and completes C', final.tasks.map(task => task.status), ['cancelled', 'completed']);
    return { patientIds: [family.patient.id], family, original, resumed, interim, correction, final };
  });

  for (const competitor of ['claim', 'demographics']) await runCase(`L16-${competitor}`, async () => {
    const family = await createFamily(`L16 ${competitor}`);
    let b;
    if (competitor === 'claim') {
      beforeTransaction = async tx => {
        if (tx.runner === 'B-setup' && tx.phase === 'claiming' && tx.target === `RelatedPerson/${family.child.id}`) { tx.delivery = 'Competing Task recorded by actual route; initial claim never sent'; throw new Error('Synthetic competitor setup crash'); }
      };
      b = await route('B-setup', 'create', await inputFor(family));
      beforeTransaction = undefined;
      check('B is genuine service-authored pending operation', [(await read('Task', b.body.task.id)).meta.author.reference, b.body.task.status], [fixture.serviceReference, 'in-progress']);
    }
    let competed = false;
    beforeTransaction = async tx => {
      if (!competed && tx.runner === 'A' && tx.phase === 'releasing' && tx.target === `RelatedPerson/${family.child.id}`) {
        competed = true;
        const child = await read('RelatedPerson', family.child.id);
        const next = competitor === 'claim' ? withClaim(child, b.body.task.id) : { ...child, name: name('L16 staff overwritten after verification') };
        check(`Competitor ${competitor} write after5a and before release lands200`, (await put(next, 'composite')).status, 200);
      }
    };
    const original = await route('A', 'create', await inputFor(family));
    beforeTransaction = undefined;
    check('Release competitor moment reached', competed, true);
    check('A release was refused412', domainWrites(0, 'A').filter(event => event.scenario === scenario && event.phase === 'releasing' && event.path === `/fhir/R4/RelatedPerson/${family.child.id}` && event.principal === 'service').map(event => event.status), [412]);
    check('A returns project-pending, not completed', [original.status, original.body.task?.status, original.body.task?.businessStatus?.text], [409, 'in-progress', 'project-pending']);
    const final = await snapshot(family, [original.body.task.id, ...(b ? [b.body.task.id] : [])]);
    check('Verification race preserves single D ownership', final.owners, [family.destination.id]);
    if (competitor === 'claim') check('B claim remains visible on pending child', claimRefs(final.child), [`Task/${b.body.task.id}`]);
    else check('Staff overwritten name remains visible with pending status', final.child.name, name('L16 staff overwritten after verification'));
    return { patientIds: [family.patient.id], family, original, b, final, competitorAdmission: competitor === 'claim' ? 'B Task is genuine and names the child; its setup claim was unsent. The fresh competitor claim is a direct authorized staff HTTP PUT, not a replay of B initial request.' : undefined };
  });
} catch (error) { fatal = { name: error.name, message: error.message, stack: error.stack }; }
finally {
  const auditRows = await audit.queryRows({ from: startedAt, limit: 10000 });
  for (const record of cases) {
    record.auditRows = auditRows.filter(row => record.patientIds?.includes(row.patientId));
    scenario = record.scenario;
    const operationRows = record.auditRows.filter(row => row.eventType.startsWith('guarantor.link.'));
    if (record.scenario.startsWith('L11-')) check('Scope refusal has zero operation audit starts', operationRows.filter(row => row.eventType === 'guarantor.link.started').length, 0);
    else check('Actual operation audit rows persisted for this patient', operationRows.length > 0, true);
    if (record.scenario === 'L13') check('Interference audit names the target child', operationRows.some(row => row.eventType === 'guarantor.link.interfered' && row.actionReason.includes(`target=RelatedPerson/${record.family.child.id}`)), true);
  }
  scenario = 'seal';
  const afterSource = provenance();
  check('Source digests unchanged during capture', afterSource.files, beforeSource.files);
  const suffix = process.env.G2B1_EVIDENCE_SUFFIX ?? '';
  writeEvidence(`live-operation-proof${suffix}.json`, { mode: 'Author development capture through actual application routes; not an independent evaluation', appOrigin, startedAt, beforeSource, afterSource, cases, checks, failed, fatal, auditRows });
  writeEvidence(`live-operation-http${suffix}.json`, { events }, 0);
  await new Promise(resolve => server.close(resolve));
  await audit.close();
  globalThis.fetch = originalFetch;
}
console.log(JSON.stringify({ cases: cases.length, checks: checks.length, failed, fatal, httpEvents: events.length, transactions: transactions.length }));
if (failed || fatal) process.exitCode = 1;
