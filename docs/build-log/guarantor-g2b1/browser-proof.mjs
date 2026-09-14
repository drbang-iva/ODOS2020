import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const proofRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const sourceRoot = resolve(process.env.G2B1_SOURCE_ROOT ?? proofRoot);
const helperPath = resolve(process.env.G2B1_FIXTURE_HELPER ?? `${proofRoot}/docs/build-log/guarantor-g2b1/live-fixture.mjs`);
const evidenceDirectory = resolve(process.env.G2B1_EVIDENCE_DIR ?? `${proofRoot}/docs/build-log/guarantor-g2b1/browser`);
const mutation = process.env.G2B1_BROWSER_MUTATION;
assert.ok(!mutation || ['complete-click', 'correct-click'].includes(mutation));
if (mutation) assert.ok(evidenceDirectory.startsWith(resolve(proofRoot, '.odos') + '/'), 'Mutation artifacts must stay ignored');
process.env.G2B1_SOURCE_ROOT = sourceRoot;
process.env.G2B1_EVIDENCE_DIR = evidenceDirectory;
const helper = await import(pathToFileURL(helperPath).href);
const fixture = await helper.refreshFixtureTokens();
assert.equal(fixture.baseUrl, 'http://127.0.0.1:28760');
const { audit, serviceFhir } = await helper.createLiveClients(fixture);
const requireMcp = createRequire(resolve(proofRoot, 'mcp/package.json'));
const express = requireMcp('express');
const [{ registerGuarantorRoutes }, { registerClinicRoutes }, { registerDeskRoutes }, { authenticateStaffRoute, resolveStaffRoles }, registration, operation] = await Promise.all([
  'mcp/src/clinic/guarantor-routes.ts', 'mcp/src/clinic/clinic-routes.ts', 'mcp/src/desk/desk-routes.ts',
  'mcp/src/payments/payment-endpoint.ts', 'mcp/src/clinic/patient-registration-endpoint.ts', 'mcp/src/clinic/guarantor-link-operation.ts',
].map(path => import(pathToFileURL(resolve(sourceRoot, path)).href)));
const { createServer } = await import(pathToFileURL(resolve(proofRoot, 'ui/node_modules/vite/dist/node/index.js')).href);
const { chromium } = await import(pathToFileURL(resolve(proofRoot, 'ui/node_modules/playwright-core/index.mjs')).href);
const { default: viteConfig } = await import(pathToFileURL(resolve(proofRoot, 'ui/vite.config.ts')).href);
const backendOrigin = 'http://127.0.0.1:28763';
const uiOrigin = 'http://127.0.0.1:28764';
const report = { createdAt: new Date().toISOString(), kind: 'author Chromium proof on the actual patient route',
  source: {}, routes: [], scenarios: [], writes: [], audits: [], browserRequests: [], browserErrors: [], screenshots: [] };
const head = root => execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
const digest = (root, path) => createHash('sha256').update(readFileSync(resolve(root, path))).digest('hex');
report.source = {
  backendHead: head(sourceRoot), uiHead: head(proofRoot), backendOrigin, uiOrigin,
  entry: 'ui/index.html -> ui/src/main.tsx -> App -> RouteSwitch -> PatientRoute -> PatientOverview -> PatientDemographicsEditor -> ResponsiblePartiesControl',
  route: '/clinic?patientId=<synthetic patient id>', serving: 'Vite development server; unchanged full App and actual route registrars; disposable proxy targets only',
  hashes: Object.fromEntries([
    'mcp/src/clinic/guarantor-routes.ts', 'mcp/src/clinic/guarantor-link-operation.ts', 'mcp/src/payments/payment-endpoint.ts',
  ].map(path => [path, digest(sourceRoot, path)]).concat([
    'ui/src/main.tsx', 'ui/src/App.tsx', 'ui/src/components/patient/PatientDemographicsEditor.tsx',
    'ui/src/components/patient/ResponsiblePartiesControl.tsx', 'ui/src/lib/guarantor-editor.ts', 'ui/src/lib/guarantor-link-operations.ts',
  ].map(path => [path, digest(proofRoot, path)]))),
};
for (const path of ['ui/src/lib/guarantor-editor.ts', 'ui/src/lib/guarantor-link-operations.ts', 'ui/src/components/patient/ResponsiblePartiesControl.tsx']) {
  assert.equal(digest(proofRoot, path), digest(sourceRoot, path), `UI must match integrated source: ${path}`);
}
mkdirSync(evidenceDirectory, { recursive: true });
let backend;
let vite;
let browser;
const cases = [];

function references(resource) { return (resource.link ?? []).map(link => link.target.reference); }
function sentinel(resource) {
  return { id: resource.id, patient: resource.patient, relationship: resource.relationship, active: resource.active,
    period: resource.period, extension: (resource.extension ?? []).filter(e => e.url !== operation.GUARANTOR_CLAIM_URL) };
}
async function read(type, id) { return helper.successfulHttp(fixture, 'GET', `/fhir/R4/${type}/${id}`); }
async function create(resource) {
  return helper.successfulHttp(fixture, 'POST', `/fhir/R4/${resource.resourceType}`, {
    body: { ...resource, meta: { project: fixture.projectA } }, scenario: 'browser seed',
  });
}
async function seed(label) {
  const patients = [];
  const children = [];
  const details = { name: [{ given: [label, 'Source'], family: 'Guarantor' }],
    telecom: [{ system: 'phone', value: '+15555550101' }], address: [{ line: ['1 Synthetic Street'], city: 'Testville' }] };
  for (const suffix of ['One', 'Two']) {
    const patient = await create({ resourceType: 'Patient', active: true,
      name: [{ given: [label, suffix], family: 'Synthetic' }], birthDate: '2015-01-01' });
    patients.push(patient);
    children.push(await create({ resourceType: 'RelatedPerson', patient: { reference: `Patient/${patient.id}` },
      active: true, ...details, relationship: [{ text: 'Synthetic guardian' }], period: { start: '2026-01-01' }, extension: [
        { url: registration.CONSENT_AUTHORITY_EXTENSION_URL, valueBoolean: true },
        { url: registration.RESPONSIBLE_PARTY_PRIMARY_EXTENSION_URL, valueBoolean: true },
        { url: 'urn:synthetic:browser-sentinel', valueString: `${label} ${suffix}` },
      ] }));
  }
  const source = await create({ resourceType: 'Person', active: true, ...details,
    link: children.map(child => ({ target: { reference: `RelatedPerson/${child.id}` }, assurance: 'level2' })) });
  const destination = await create({ resourceType: 'Person', active: true,
    name: [{ given: [label, 'Destination'], family: 'Guarantor' }],
    telecom: [{ system: 'phone', value: '+15555550199' }], address: [{ line: ['2 Synthetic Street'], city: 'Testville' }] });
  const scenario = { label, patients, children, source, destination, competed: false };
  cases.push(scenario);
  return scenario;
}
async function routeRequest(path, body) {
  const response = await fetch(`${backendOrigin}${path}`, { method: 'POST',
    headers: { Authorization: `Bearer ${fixture.principals.staff.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const result = await response.json();
  report.routes.push({ method: 'POST', path, status: response.status, phase: result.phase, taskStatus: result.task?.status, taskId: result.task?.id });
  return { status: response.status, body: result };
}
async function pending(scenario) {
  const resources = [scenario.source, scenario.destination, ...scenario.children];
  const result = await routeRequest('/guarantors/link-operations', {
    operationId: randomUUID(), kind: 'transfer', sourcePersonId: scenario.source.id, destinationPersonId: scenario.destination.id,
    relatedPersonIds: scenario.children.map(child => child.id), reason: 'Synthetic browser recovery proof',
    expected: Object.fromEntries(resources.map(resource => [`${resource.resourceType}/${resource.id}`, resource.meta.versionId])),
  });
  assert.equal(result.body.phase, 'attach-pending', JSON.stringify(result.body));
  assert.equal(result.body.task.status, 'in-progress');
  assert.equal(result.body.active, true);
  assert.ok(scenario.competed);
  scenario.taskId = result.body.task.id;
  scenario.pending = result.body;
  const task = await read('Task', scenario.taskId);
  const journal = JSON.parse(task.extension.find(e => e.url.endsWith('/guarantor-link-journal')).valueString);
  assert.ok(journal.intents.some(intent => intent.phase === 'attaching' && intent.responseStatus === 412 && intent.disposition === 'rejected'));
  scenario.journal = journal;
  for (const child of scenario.children) {
    const owners = await helper.successfulHttp(fixture, 'GET', `/fhir/R4/Person?link=RelatedPerson%2F${child.id}`);
    assert.equal(owners.entry?.length ?? 0, 0, 'Claimed child is unlinked between detach and attach');
  }
}
async function capture(page, locator, name) {
  await locator.scrollIntoViewIfNeeded();
  await page.evaluate(() => document.fonts.ready);
  await locator.screenshot({ path: resolve(evidenceDirectory, `${name}.png`), animations: 'disabled' });
  report.screenshots.push(`${name}.png`);
}
async function openPending(page, scenario) {
  await page.goto(`${uiOrigin}/clinic?patientId=${scenario.patients[0].id}`, { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: 'Edit demographics', exact: true }).click({ timeout: 30_000 });
  const group = page.getByRole('group', { name: 'Responsible parties', exact: true });
  await group.getByRole('button', { name: 'Complete', exact: true }).waitFor({ state: 'visible', timeout: 30_000 });
  assert.ok(await group.getByRole('button', { name: 'Save guarantor', exact: true }).isDisabled());
  assert.ok(await group.getByRole('button', { name: 'Repair guarantor', exact: true }).isDisabled());
  assert.ok(await group.getByRole('button', { name: 'Correct', exact: true }).isDisabled());
  assert.ok(await group.getByRole('button', { name: 'Complete', exact: true }).isEnabled());
  await group.getByRole('button', { name: 'Save guarantor', exact: true }).click({ force: true });
  await group.getByRole('button', { name: 'Repair guarantor', exact: true }).click({ force: true });
  const text = await group.innerText();
  assert.ok(text.includes(scenario.taskId));
  for (const patient of scenario.patients) assert.ok(text.includes([...patient.name[0].given, patient.name[0].family].join(' ')));
  assert.equal(new URL(page.url()).pathname, '/clinic');
  return group;
}
async function verifyFinal(scenario, owner, originalStatus) {
  const task = await read('Task', scenario.taskId);
  assert.equal(task.status, originalStatus);
  const finalChildren = [];
  for (const child of scenario.children) {
    const fresh = await read('RelatedPerson', child.id);
    assert.deepEqual(sentinel(fresh), sentinel(child));
    assert.ok(!fresh.extension.some(e => e.url === operation.GUARANTOR_CLAIM_URL));
    assert.deepEqual(fresh.name, owner.name);
    const owners = await helper.successfulHttp(fixture, 'GET', `/fhir/R4/Person?link=RelatedPerson%2F${child.id}`);
    assert.deepEqual(owners.entry.map(e => e.resource.id), [owner.id]);
    finalChildren.push({ reference: `RelatedPerson/${fresh.id}`, version: fresh.meta.versionId, owner: `Person/${owner.id}`, sentinelPreserved: true, noClaim: true, name: fresh.name });
  }
  report.scenarios.push({ label: scenario.label, originalTaskId: scenario.taskId, pendingPhase: scenario.pending.phase,
    actualAttach412: scenario.journal.intents.filter(i => i.phase === 'attaching'), originalStatus: task.status, finalChildren });
}

try {
  const completeCase = await seed('Complete');
  const correctCase = await seed('Correct');
  await helper.grantPatients(fixture, 'staff', cases.flatMap(scenario => scenario.patients.map(patient => patient.id)));
  const authOptions = authHeader => ({ baseUrl: fixture.baseUrl, authHeader, serviceClient: serviceFhir, audit });
  const authenticate = authHeader => authenticateStaffRoute(authOptions(authHeader));
  const authenticateService = async () => { assert.equal(await serviceFhir.getAuthenticatedProfileReference(), fixture.serviceReference); };
  const hookedFhir = { ...serviceFhir, async executeTransactionAsActor(bundle, actor, headers, options) {
    const entry = bundle.entry[0];
    let response;
    try {
      response = await serviceFhir.executeTransactionAsActor(bundle, actor, headers, options);
      report.writes.push({ target: entry.request.url, ifMatch: entry.request.ifMatch, phase: actor.actionReason, status: response.entry[0].response.status });
    } catch (error) {
      report.writes.push({ target: entry.request.url, ifMatch: entry.request.ifMatch, phase: actor.actionReason, error: String(error.message).replaceAll(fixture.baseUrl, '<disposable Medplum>') });
      throw error;
    }
    const scenario = cases.find(candidate => !candidate.competed && entry.resource.resourceType === 'Person' &&
      entry.resource.id === candidate.source.id && candidate.children.every(child => !references(entry.resource).includes(`RelatedPerson/${child.id}`)));
    if (scenario) {
      scenario.competed = true;
      const fresh = await read('Person', scenario.destination.id);
      const response = await helper.http(fixture, 'PUT', `/fhir/R4/Person/${fresh.id}`, {
        body: { ...fresh, name: [{ given: [scenario.label, 'Current'], family: 'Guarantor' }] },
        token: fixture.principals.staff.token, headers: { 'If-Match': `W/"${fresh.meta.versionId}"` },
        principal: 'staff', scenario: `${scenario.label}: genuine competing destination edit after detach`,
      });
      assert.equal(response.status, 200);
      scenario.competingDestination = response.body;
    }
    return response;
  } };
  const app = express();
  app.use(express.json());
  registerGuarantorRoutes(app, { authenticateService, authenticate, serviceFhir: hookedFhir,
    recordAudit: async row => { await audit.record(row, () => undefined); report.audits.push(row); } });
  registerClinicRoutes(app, { authenticateService, authenticate, serviceFhir });
  registerDeskRoutes(app, { authenticateService, authenticate, terminalMode: 'synthetic-proof',
    resolveRoles: header => resolveStaffRoles(authOptions(header)) });
  backend = await new Promise((done, fail) => { const server = app.listen(28763, '127.0.0.1', () => done(server)); server.once('error', fail); });
  process.chdir(resolve(proofRoot, 'ui'));
  const config = viteConfig({ command: 'serve', mode: 'development' });
  const proxy = Object.fromEntries(Object.entries(config.server.proxy).map(([path, value]) => [path, {
    ...value, target: ['/fhir', '/auth', '/oauth2'].includes(path) ? fixture.baseUrl : backendOrigin,
  }]));
  const mutationPlugin = mutation ? [{ name: 'g2b1-browser-guard-mutation', enforce: 'pre', transform(code, id) {
    if (id.split('?')[0] !== resolve(proofRoot, 'ui/src/components/patient/ResponsiblePartiesControl.tsx')) return;
    const target = mutation === 'complete-click' ? 'onClick={() => recover()}' : 'onClick={() => recover(true)}';
    assert.equal(code.split(target).length, 2);
    const changed = code.replace(target, 'onClick={() => undefined}');
    report.source.servedMutation = { kind: mutation, applied: true, sourceBeforeViteSha256: createHash('sha256').update(changed).digest('hex') };
    return changed;
  } }] : [];
  vite = await createServer({ ...config, configFile: false, root: resolve(proofRoot, 'ui'),
    plugins: [...mutationPlugin, ...config.plugins],
    server: { ...config.server, host: '127.0.0.1', port: 28764, strictPort: true, proxy }, logLevel: 'error' });
  await vite.listen();
  report.source.process = { pid: process.pid, cwd: '<proof-root>/ui', backendPort: backend.address().port, uiPort: vite.httpServer.address().port };
  console.log('Disposable actual routes ready on 28763; full app on strict port 28764.');
  await pending(completeCase);
  await pending(correctCase);
  browser = await chromium.launch(process.env.CHROME_EXECUTABLE ? { executablePath: process.env.CHROME_EXECUTABLE } : { channel: 'chrome' });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1100 }, deviceScaleFactor: 1 });
  const accessToken = fixture.principals.staff.token;
  const expiry = JSON.parse(Buffer.from(accessToken.split('.')[1], 'base64url').toString()).exp * 1000;
  await context.addInitScript(({ accessToken, expiresAt }) => sessionStorage.setItem('odos.session.v1', JSON.stringify({ accessToken, expiresAt })), { accessToken, expiresAt: expiry });
  const page = await context.newPage();
  page.on('response', response => {
    const url = new URL(response.url());
    if (url.origin !== uiOrigin || !['fetch', 'xhr', 'document'].includes(response.request().resourceType())) return;
    report.browserRequests.push({ method: response.request().method(), path: url.pathname + url.search, status: response.status() });
  });
  page.on('pageerror', error => report.browserErrors.push(error.message));
  let group = await openPending(page, completeCase);
  await capture(page, group, 'pending-complete');
  await page.screenshot({ path: resolve(evidenceDirectory, 'patient-route-pending.png'), animations: 'disabled' });
  report.screenshots.push('patient-route-pending.png');
  const completeResponse = page.waitForResponse(response => response.url() === `${uiOrigin}/guarantors/link-operations/${completeCase.taskId}/complete` && response.request().method() === 'POST', { timeout: mutation ? 10_000 : 30_000 });
  await group.getByRole('button', { name: 'Complete', exact: true }).click();
  const completeResult = await completeResponse;
  assert.equal(completeResult.status(), 200);
  assert.equal(completeResult.request().postData(), null);
  assert.equal((await completeResult.json()).task.status, 'completed');
  await group.getByRole('textbox', { name: 'Given names 1', exact: true }).waitFor({ state: 'visible' });
  assert.equal(await group.getByRole('textbox', { name: 'Given names 1', exact: true }).inputValue(), 'Complete Current');
  assert.equal(await group.getByRole('button', { name: 'Complete', exact: true }).count(), 0);
  await capture(page, group, 'complete-reloaded');
  await verifyFinal(completeCase, await read('Person', completeCase.destination.id), 'completed');
  group = await openPending(page, correctCase);
  await group.getByRole('textbox', { name: 'Reason for correction', exact: true }).fill('   ');
  assert.ok(await group.getByRole('button', { name: 'Correct', exact: true }).isDisabled());
  const reason = 'Synthetic proof: retain the original guarantor';
  await group.getByRole('textbox', { name: 'Reason for correction', exact: true }).fill(reason);
  assert.ok(await group.getByRole('button', { name: 'Correct', exact: true }).isEnabled());
  await capture(page, group, 'pending-correct');
  const correctResponse = page.waitForResponse(response => response.url() === `${uiOrigin}/guarantors/link-operations/${correctCase.taskId}/correct` && response.request().method() === 'POST', { timeout: mutation ? 10_000 : 30_000 });
  await group.getByRole('button', { name: 'Correct', exact: true }).click();
  const correctResult = await correctResponse;
  assert.equal(correctResult.status(), 200);
  const correctionRequest = correctResult.request().postDataJSON();
  assert.equal(correctionRequest.reason, reason);
  assert.match(correctionRequest.operationId, /^[a-f0-9-]{36}$/);
  const correction = await correctResult.json();
  assert.equal(correction.kind, 'correct');
  assert.equal(correction.task.status, 'completed');
  report.routes.push({ action: 'browser Correct', originalTaskId: correctCase.taskId, correctionTaskId: correction.task.id, reason, operationId: correctionRequest.operationId });
  await group.getByRole('textbox', { name: 'Given names 1', exact: true }).waitFor({ state: 'visible' });
  assert.equal(await group.getByRole('textbox', { name: 'Given names 1', exact: true }).inputValue(), 'Correct Source');
  assert.equal(await group.getByRole('button', { name: 'Correct', exact: true }).count(), 0);
  await capture(page, group, 'correct-reloaded');
  await verifyFinal(correctCase, await read('Person', correctCase.source.id), 'cancelled');
  assert.equal(report.browserErrors.length, 0);
  assert.equal(report.browserRequests.filter(request => request.method === 'PUT').length, 0, 'Browser recovery must use operation endpoints, with no direct FHIR PUT');
  report.result = 'PASS';
  report.checks = {
    recoveryClicks: 2, claimedUnlinkedChildrenShownPending: 4, disabledSaveAndRepairClickAttempts: 4,
    protectedChildSentinelsPreserved: 4, directBrowserFhirPuts: 0, pageErrors: 0,
    scope: 'Author route wiring and real local FHIR state proof; independent evaluation and policy proof are separate.',
    unmountedBackgroundRoutes: report.browserRequests.filter(request => request.status === 404),
  };
  console.log('PASS: actual patient-route Complete and Correct clicks, reloads, disabled pending writes, real 412s, and four preserved child identities.');
  await context.close();
} catch (error) {
  report.result = 'FAIL';
  report.failure = error.message;
  throw error;
} finally {
  await browser?.close();
  await vite?.close();
  if (backend) await new Promise((done, fail) => backend.close(error => error ? fail(error) : done()));
  await audit.close();
  report.screenshots = report.screenshots.map(name => {
    const bytes = readFileSync(resolve(evidenceDirectory, name));
    return { name, width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20), sha256: createHash('sha256').update(bytes).digest('hex') };
  });
  report.completedAt = new Date().toISOString();
  helper.writeEvidence('browser-proof.json', report);
  helper.saveHttpTrace('browser-fhir-trace.json');
}
