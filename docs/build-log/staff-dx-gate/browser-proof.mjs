import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { fixture as helper, sourceRoot } from './fixture.mjs';
import { authenticateStaffRoute, resolveStaffRoles } from '../../../mcp/src/payments/payment-endpoint.ts';
import { registerDeskRoutes } from '../../../mcp/src/desk/desk-routes.ts';
import { handleDiagnosisQuickListRequest } from '../../../mcp/src/clinical-graph/diagnosis-quick-list-endpoint.ts';
import { handleDiagnosisCatalogListRequest } from '../../../mcp/src/clinical-graph/diagnosis-catalog-endpoint.ts';
import { handleDiagnosisFindingsReadRequest } from '../../../mcp/src/clinical-graph/diagnosis-findings-endpoint.ts';
import { handleDiagnosisCandidatesRequest } from '../../../mcp/src/clinical-graph/diagnosis-candidates-endpoint.ts';
import { registerDiagnosisCarryForwardRoutes } from '../../../mcp/src/clinical-graph/diagnosis-carry-forward-endpoint.ts';
import { handleDiagnosisVisitStatusListRequest } from '../../../mcp/src/clinical-graph/diagnosis-visit-status-endpoint.ts';
import { handleDiagnosisNewnessReadRequest } from '../../../mcp/src/clinical-graph/diagnosis-newness-endpoint.ts';
import { handleFindingDefinitionCatalogRequest } from '../../../mcp/src/clinical-graph/finding-definition-endpoint.ts';
import { handleEncounterUndoLedgerRequest } from '../../../mcp/src/clinical-graph/encounter-undo-endpoint.ts';
import { handleExamOverviewRequest } from '../../../mcp/src/clinical-graph/exam-overview-endpoint.ts';
import { FhirFindingDefinitionStore } from '../../../mcp/src/clinical-graph/finding-definition-store.ts';
import { PgDiagnosisVisitStatusStore } from '../../../mcp/src/clinical-graph/diagnosis-visit-status-store.ts';

const fixture = await helper.refreshFixtureTokens();
const scenario = JSON.parse(readFileSync(resolve(sourceRoot, '.odos/staff-dx-gate/browser-case.json'), 'utf8'));
const { audit, serviceFhir } = await helper.createLiveClients(fixture);
const store = new PgDiagnosisVisitStatusStore({ postgresUrl: fixture.postgresUrl });
const require = createRequire(resolve(sourceRoot, 'mcp/package.json'));
const express = require('express');
const { createServer } = await import(pathToFileURL(resolve(sourceRoot, 'ui/node_modules/vite/dist/node/index.js')).href);
const { chromium } = await import(pathToFileURL(resolve(sourceRoot, 'ui/node_modules/playwright-core/index.mjs')).href);
const beforeRoot = resolve(sourceRoot, '.odos/staff-dx-gate/before-worktree');
if (!existsSync(beforeRoot)) {
  execFileSync('git', ['worktree', 'add', '--detach', beforeRoot, '40c19a9e442015e1d32396958b661394318713d2'], { cwd: sourceRoot, stdio: 'pipe' });
  for (const directory of ['node_modules', 'ui/node_modules']) symlinkSync(resolve(sourceRoot, directory), resolve(beforeRoot, directory));
}
const report = {
  kind: 'Author Chromium proof on the unchanged App -> RouteSwitch -> PatientRoute -> EncounterCharting route',
  route: `/clinic?patientId=${scenario.patientId}&encounterId=${scenario.encounterId}`,
  beforeHead: '40c19a9e442015e1d32396958b661394318713d2',
  afterHead: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: sourceRoot, encoding: 'utf8' }).trim(),
  limits: ['Selected real read handlers registered by proof harness; both UI revisions use proposed read handlers.', 'Unrelated backend routes are not registered; their failed requests are recorded. No browser responses are mocked.'],
  captures: [], requests: [],
};
const authOptions = header => ({ baseUrl: fixture.baseUrl, authHeader: header, serviceClient: serviceFhir, audit });
const authenticate = header => authenticateStaffRoute(authOptions(header));
const definitions = await new FhirFindingDefinitionStore(serviceFhir).list();
const findingDefinitions = () => definitions;
const deps = { authenticate, tallyFhir: serviceFhir, fhirBaseUrl: fixture.baseUrl, serviceFhir, store, findingDefinitions };
const app = express();
app.use(express.json());
registerDeskRoutes(app, { authenticateService: async () => {}, authenticate, resolveRoles: header => resolveStaffRoles(authOptions(header)), terminalMode: 'synthetic-proof' });
registerDiagnosisCarryForwardRoutes(app, { authenticateService: async () => {}, fhirBaseUrl: fixture.baseUrl, rollbackFhir: serviceFhir, authenticate, authenticateWrite: authenticate });
for (const [path, handler] of [
  ['/clinical-graph/diagnosis-quick-list', handleDiagnosisQuickListRequest],
  ['/clinical-graph/diagnosis-catalog', handleDiagnosisCatalogListRequest],
  ['/clinical-graph/encounters/:encounterId/findings', handleDiagnosisFindingsReadRequest],
  ['/clinical-graph/encounters/:encounterId/diagnosis-candidates', handleDiagnosisCandidatesRequest],
  ['/clinical-graph/encounters/:encounterId/diagnosis-statuses', handleDiagnosisVisitStatusListRequest],
  ['/clinical-graph/encounters/:encounterId/diagnosis-newness', handleDiagnosisNewnessReadRequest],
  ['/clinical-graph/encounters/:encounterId/void/ledger', handleEncounterUndoLedgerRequest],
  ['/clinical-graph/encounters/:encounterId/exam-overview', handleExamOverviewRequest],
  ['/clinical-graph/finding-definitions', handleFindingDefinitionCatalogRequest],
]) app.get(path, async (req, res) => {
  try {
    const result = await handler(deps, { authHeader: req.header('authorization'), params: req.params, query: req.query });
    res.status(result.status).json(result.body);
  } catch (error) { res.status(500).json({ error: error.message }); }
});
const backend = await new Promise((accept, reject) => {
  const server = app.listen(28983, '127.0.0.1', () => accept(server)); server.once('error', reject);
});
const servers = [];
let browser;
try {
  for (const [root, port] of [[beforeRoot, 28986], [sourceRoot, 28984]]) {
    process.chdir(resolve(root, 'ui'));
    const { default: viteConfig } = await import(pathToFileURL(resolve(root, 'ui/vite.config.ts')).href);
    const config = viteConfig({ command: 'serve', mode: 'development' });
    const proxy = Object.fromEntries(Object.entries(config.server.proxy).map(([path, value]) => [path, {
      ...value, target: ['/fhir', '/auth', '/oauth2'].includes(path) ? fixture.baseUrl : 'http://127.0.0.1:28983',
    }]));
    const server = await createServer({ ...config, configFile: false, root: resolve(root, 'ui'),
      cacheDir: resolve(sourceRoot, `.odos/staff-dx-gate/vite-cache-${port}`),
      resolve: { ...config.resolve, dedupe: ['react', 'react-dom'] },
      server: { ...config.server, host: '127.0.0.1', port, strictPort: true, proxy }, logLevel: 'error' });
    await server.listen();
    assert.equal(server.httpServer.address().port, port);
    servers.push(server);
  }
  report.process = { pid: process.pid, backendPort: backend.address().port, uiPorts: servers.map(server => server.httpServer.address().port) };
  browser = await chromium.launch({ channel: 'chrome' });
  for (const [state, port, principal] of [['before', 28986, 'staff'], ['after', 28984, 'staff'], ['provider', 28984, 'composite']]) {
    const context = await browser.newContext({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
    await context.addInitScript(({ token }) => {
      sessionStorage.setItem('odos.session.v1', JSON.stringify({ accessToken: token, expiresAt: Date.now() + 3600000 }));
      localStorage.setItem('odos:encounter-chart-view', 'diagnosis');
      localStorage.setItem('odos:diagnosis-imaging-open', 'false');
    }, { token: fixture.principals[principal].token });
    const page = await context.newPage();
    page.on('pageerror', error => console.error('Browser page error:', error.message));
    page.on('console', message => { if (message.type() === 'error') console.error('Browser console:', message.text()); });
    page.on('response', response => {
      const url = new URL(response.url());
      if (!url.pathname.includes('/src/') && !url.pathname.includes('/node_modules/')) report.requests.push({ state, path: url.pathname, status: response.status() });
    });
    await page.goto(`http://127.0.0.1:${port}${report.route}`, { waitUntil: 'networkidle' });
    writeFileSync(resolve(sourceRoot, `.odos/staff-dx-gate/browser-${state}.txt`), await page.locator('body').innerText());
    helper.writeEvidence('browser-progress.json', report);
    await page.getByTestId('diagnosis-workspace').waitFor({ state: 'visible', timeout: 30000 });
    await page.locator('.odos-diagnosis-visit-row').first().click();
    await page.getByText('Selected diagnosis', { exact: true }).waitFor({ state: 'visible' });
    await page.waitForLoadState('networkidle');
    await page.getByText('Loading findings…', { exact: true }).waitFor({ state: 'hidden' });
    for (const name of ['Problem status', 'Diagnosis visit status', 'Find diagnosis']) {
      const control = page.getByRole('combobox', { name, exact: true });
      assert.equal(await control.count(), 1, `${state}: ${name} is present`);
      assert.equal(await control.isDisabled(), state === 'after', `${state}: ${name} permission`);
    }
    const controls = await page.locator('input, select, button').evaluateAll(nodes => nodes.map(node => ({ text: node.getAttribute('aria-label') || node.textContent?.trim(), disabled: node.disabled })).filter(row => row.text && /diagnos|Find dx|Complex|New|Established|Confirm|Discard|Possible/i.test(row.text)));
    await page.evaluate(() => document.fonts.ready);
    const path = `docs/build-log/staff-dx-gate/browser-${state}.png`;
    await page.getByTestId('diagnosis-workspace').screenshot({ path: resolve(sourceRoot, path), animations: 'disabled' });
    writeFileSync(resolve(sourceRoot, `.odos/staff-dx-gate/browser-${state}.txt`), await page.locator('body').innerText());
    report.captures.push({ state, principal, path, controls });
    await context.close();
  }
  helper.writeEvidence('browser-proof.json', report);
  console.log(JSON.stringify({ captures: report.captures.length, process: report.process }));
} finally {
  await browser?.close();
  await Promise.all(servers.map(server => server.close()));
  await new Promise(resolve => backend.close(resolve));
  await store.close();
  await audit.close();
}
