import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync, mkdirSync, openSync } from 'node:fs';
import { spawn, execFileSync } from 'node:child_process';
import { resolve, join } from 'node:path';
import { generateCaddyfile, assertCaddyParity } from '../../../../scripts/r10-served-route/caddy.mjs';

const fixback1 = process.argv.includes('--fixback1');
const fixbackBefore = process.argv.includes('--fixback1-before');
const root = resolve('.'), runtime = join(root, fixback1 ? '.odos/s2b2a-fb1-proof' : '.odos/s2b2a-proof');
const read = name => JSON.parse(readFileSync(join(runtime, name), 'utf8'));
const { ports } = read('manifest.json'), credentials = read('credentials.json'), fixture = read('fixture.json');
const beforeRoot = resolve(process.argv[2]);
assert.equal(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: beforeRoot, encoding: 'utf8' }).trim(), fixback1 ? '32066b22b2a19ab50a765347ff71b4afd4d73fb2' : 'da799f4eb9c290cf6e6e270b0031562e2b432d8a');
assert.equal(execFileSync('git', ['diff', '--stat'], { cwd: beforeRoot, encoding: 'utf8' }).trim(), '');
const beforePorts = { ...ports, frontdoor: fixback1 ? 31492 : 31292 };
const source = readFileSync(join(beforeRoot, 'deploy/frontdoor/Caddyfile'), 'utf8');
const config = generateCaddyfile(source, beforePorts); assertCaddyParity(source, config, beforePorts);
const configPath = join(runtime, 'before.Caddyfile'); writeFileSync(configPath, config);
const log = openSync(join(runtime, 'before-caddy.log'), 'a', 0o600);
let caddy, browser;
const { chromium } = createRequire(join(root, 'ui/package.json'))('playwright-core');
const evidence = join(root, 'docs/build-log/followup-s2b2a-collapse', fixback1 ? 'fixback1-screenshots' : 'screenshots'); mkdirSync(evidence, { recursive: true });
const results = [];
let providerSession;
const baselineOnly = process.argv.includes('--baseline-refresh');
const pairsOnly = process.argv.includes('--pairs-only');
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const line = (page, id) => page.locator(`[data-drawn-editor-id="${id}"]`);
const action = (page, verb, id) => page.locator(`[data-exam-view-action="${verb}"][data-editor-id="${id}"]`);
async function login(page, base) {
  if (providerSession) {
    await page.addInitScript(({ origin, session }) => {
      if (location.origin === origin) sessionStorage.setItem('odos.session.v1', session);
    }, { origin: base, session: providerSession });
    await page.goto(base + '/clinic');
    return;
  }
  await page.goto(base + '/clinic');
  await page.getByPlaceholder('Email address').fill(credentials.provider.email);
  await page.getByPlaceholder('Password', { exact: true }).fill(credentials.provider.password);
  await page.getByRole('button', { name: 'Enter', exact: true }).click();
  try {
    await page.getByPlaceholder('Password', { exact: true }).waitFor({ state: 'detached' });
  } catch {
    throw new Error('Synthetic login did not complete; credential-bearing locator diagnostics withheld.');
  }
  providerSession = await page.evaluate(() => sessionStorage.getItem('odos.session.v1'));
}
async function open(page, base, encounter) {
  await page.goto(`${base}/clinic?patientId=${fixture.patientReference.slice(8)}&encounterId=${encounter.slice(10)}`);
  await page.getByRole('button', { name: 'By structure', exact: true }).click();
  await page.getByTestId('exam-overview-section').first().waitFor();
  await page.waitForLoadState('networkidle');
}
async function capture(page, width, name, locator) {
  await page.waitForLoadState('networkidle');
  if (locator) await locator.evaluate(node => {
    const target = getComputedStyle(node).display === 'contents' ? node.firstElementChild : node;
    target.scrollIntoView({ behavior: 'instant', block: 'center' });
  });
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await page.mouse.move(0, 0);
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: join(evidence, `${width}-${name}.png`), animations: 'disabled' });
}
async function api(page, path, method = 'GET', body) {
  return page.evaluate(async ({ path, method, body }) => {
    const session = JSON.parse(sessionStorage.getItem('odos.session.v1'));
    const response = await fetch(path, { method, headers: { Authorization: `Bearer ${session.accessToken}`, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, body: await response.json() };
  }, { path, method, body });
}
async function proveCorneaShelf(page, width, encounter, requests) {
  const cornea = 'ocular-health:anterior:cornea';
  const start = requests.length;
  await action(page, 'shelve', cornea).click(); await wait(150); assert.deepEqual(requests.slice(start), []);
  assert.equal(await line(page, cornea).count(), 0);
  const shelfCornea = page.getByTestId('exam-shelf').locator(`[data-editor-section-id="${cornea}"]`);
  assert.equal(await shelfCornea.count(), 1);
  await capture(page, width, 'after-shelved', shelfCornea);
  await shelfCornea.click();
  await page.getByTestId('return-to-exam-overview').waitFor();
  await page.getByTestId('return-to-exam-overview').click();
  assert.equal(await line(page, cornea).count(), 1);
  const stored = await page.evaluate(id => JSON.parse(localStorage.getItem(`odos:exam-view:v1:${id}`)), encounter.slice(10));
  assert.ok(!stored.shelved.includes(cornea));
}
async function captureBefore(width, encounter) {
  const context = await browser.newContext({ viewport: { width, height: width === 1440 ? 1100 : 1300 } });
  try {
    const page = await context.newPage(), base = `http://127.0.0.1:${beforePorts.frontdoor}`;
    await login(page, base); await open(page, base, encounter);
    assert.equal(await page.locator('[data-exam-view-action]').count(), 0);
    await capture(page, width, 'before-expanded', line(page, 'iop'));
  } finally { await context.close(); }
}
try {
  caddy = spawn('caddy', ['run', '--config', configPath, '--adapter', 'caddyfile'], { env: { ...process.env, ODOS_UI_DIST: join(beforeRoot, 'ui/dist') }, stdio: ['ignore', log, log] });
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  for (const port of [ports.frontdoor, beforePorts.frontdoor]) {
    let ready = false;
    for (let i = 0; i < 120; i++) {
      try { if ((await fetch(`http://127.0.0.1:${port}`)).ok) { ready = true; break; } } catch {}
      await wait(250);
    }
    assert.ok(ready, `Front door ${port} must be ready`);
  }
  for (const width of (baselineOnly ? [1440] : [1440, 390])) {
    const base = `http://127.0.0.1:${(baselineOnly || fixbackBefore) ? beforePorts.frontdoor : ports.frontdoor}`, encounter = fixture[baselineOnly ? 'baselineRefresh' : fixbackBefore ? `fb1Before${width}` : `collapse${width}`];
    const context = await browser.newContext({ viewport: { width, height: width === 1440 ? 1100 : 1300 } });
    const page = await context.newPage(); page.setDefaultTimeout(20000);
    const requests = [], errors = [];
    page.on('request', request => requests.push({ method: request.method(), path: new URL(request.url()).pathname }));
    page.on('pageerror', error => errors.push(error.message));
    let signedIn = false;
    try {
      if (fixback1) await page.addInitScript(() => {
        window.__fb1ManualRefreshClicks = 0;
        document.addEventListener('click', event => {
          if (event.target instanceof Element && event.target.closest('[data-testid="refresh-exam-overview"]')) window.__fb1ManualRefreshClicks++;
        }, true);
      });
      await login(page, base); signedIn = true;
      await open(page, base, encounter);
      assert.equal(await page.getByRole('combobox', { name: 'Exam scope', exact: true }).inputValue(), 'comprehensive');
      if (pairsOnly) {
        await capture(page, width, 'after-expanded', line(page, 'iop'));
        await captureBefore(width, encounter);
        await action(page, 'collapse', 'iop').click();
        await capture(page, width, 'after-collapsed', line(page, 'iop'));
        results.push({ width, matchedPrimaryPair: true, before: 'expanded', after: 'collapsed', sameSyntheticEncounterAndStoredValues: true });
        continue;
      }
      if (await line(page, 'iop').evaluate(node => node.tagName === 'BUTTON')) await line(page, 'iop').click();
      else await line(page, 'iop').locator('button').first().click();
      await page.getByRole('combobox', { name: 'OD IOP value', exact: true }).fill('17');
      await page.getByRole('combobox', { name: 'OD IOP value', exact: true }).press('Tab');
      const sheet = page.locator('[data-entry-sheet-section="iop"]');
      await sheet.locator('select').first().selectOption('GAT');
      await Promise.all([
        page.waitForResponse(response => response.url().endsWith('/clinical-graph/iop') && response.status() === 200),
        sheet.getByRole('button', { name: 'Save IOP', exact: true }).click(),
      ]);
      await sheet.waitFor({ state: 'detached' });
      await page.waitForLoadState('networkidle');
      if (baselineOnly) {
        const automaticReadRows = await line(page, 'iop').getByTestId('exam-finding-row').count();
        await page.getByTestId('refresh-exam-overview').click();
        await line(page, 'iop').getByTestId('exam-finding-row').waitFor();
        const manualRefreshRows = await line(page, 'iop').getByTestId('exam-finding-row').count();
        results.push({ base: 'da799f4e', automaticReadRows, manualRefreshRows, diagnosis: 'Same real IOP save and immediate overview behavior at pinned base; no server edits.' });
        continue;
      }
      if (fixback1) {
        const findingRows = await line(page, 'iop').getByTestId('exam-finding-row').count();
        const control = fixbackBefore ? 'shelve' : 'collapse';
        assert.equal(await line(page, 'iop').count(), 1);
        assert.equal(await action(page, control, 'iop').count(), 1);
        assert.equal(await action(page, fixbackBefore ? 'collapse' : 'shelve', 'iop').count(), 0);
        if (fixbackBefore) assert.equal(findingRows, 0, 'reproduce the unmodified parent save/read lag');
        const dataEvidence = await line(page, 'iop').getAttribute('data-holds-data');
        await capture(page, width, fixbackBefore ? 'before-save-lag' : 'after-save-lag', line(page, 'iop'));
        if (!fixbackBefore) {
          const start = requests.length;
          await action(page, 'collapse', 'iop').click(); await wait(150);
          assert.equal(await line(page, 'iop').count(), 1);
          assert.equal(await line(page, 'iop').getByTestId('exam-collapsed-line').count(), 1);
          await capture(page, width, 'after-collapse', line(page, 'iop'));
          await action(page, 'expand', 'iop').click(); await wait(150);
          assert.deepEqual(requests.slice(start), []);
          await proveCorneaShelf(page, width, encounter, requests);
        }
        const manualRefreshClicks = await page.evaluate(() => window.__fb1ManualRefreshClicks);
        assert.equal(manualRefreshClicks, 0);
        assert.deepEqual(errors, []);
        results.push({ width, parentComparison: fixbackBefore, chartedThroughRealIopUi: true,
          findingRowsImmediatelyAfterSave: findingRows, dataEvidence, iopDrawn: true, iopControl: control,
          manualRefreshClicks, corneaShelfRoundtrip: !fixbackBefore, viewRequests: 0, pageErrors: errors });
        continue;
      }
      const neededOverviewRefresh = await action(page, 'collapse', 'iop').count() === 0;
      if (neededOverviewRefresh) {
        await page.getByTestId('refresh-exam-overview').click();
        await action(page, 'collapse', 'iop').waitFor();
        await page.waitForLoadState('networkidle');
      }
      assert.equal(await action(page, 'collapse', 'iop').count(), 1);
      assert.equal(await action(page, 'shelve', 'iop').count(), 0);
      const order = () => page.locator('[data-section-key="pretest"] [data-drawn-editor-id]').evaluateAll(nodes => nodes.map(node => node.dataset.drawnEditorId));
      const originalOrder = await order();
      await capture(page, width, 'after-expanded', line(page, 'iop'));
      await captureBefore(width, encounter);
      let start = requests.length;
      await action(page, 'collapse', 'iop').click(); await wait(150);
      assert.deepEqual(requests.slice(start), []);
      assert.deepEqual(await order(), originalOrder);
      assert.match(await line(page, 'iop').innerText(), /collapsed[\s\S]*17/);
      assert.match(await line(page, 'iop').getByTestId('exam-collapsed-line').getAttribute('aria-label'), /collapsed.*Has findings this visit.*17/);
      assert.equal(await line(page, 'iop').getAttribute('data-holds-data'), 'true');
      await capture(page, width, 'after-collapsed', line(page, 'iop'));
      await page.reload(); await page.getByTestId('exam-collapsed-line').waitFor(); await page.waitForLoadState('networkidle');
      assert.match(await line(page, 'iop').innerText(), /collapsed[\s\S]*17/);
      await capture(page, width, 'after-reload', line(page, 'iop'));
      start = requests.length;
      await action(page, 'expand', 'iop').click(); await wait(150); assert.deepEqual(requests.slice(start), []);
      assert.equal(await line(page, 'iop').getByTestId('exam-finding-row').count(), 1);
      await proveCorneaShelf(page, width, encounter, requests);
      assert.equal(await action(page, 'collapse', 'wearing').count(), 1);
      assert.equal(await action(page, 'shelve', 'wearing').count(), 0);
      await capture(page, width, 'after-unknown', line(page, 'wearing'));
      await page.waitForLoadState('networkidle'); start = requests.length;
      await action(page, 'shelve', 'cover-test').click(); await wait(150); assert.deepEqual(requests.slice(start), []);
      const saved = await api(page, '/clinical-graph/cover-test', 'POST', { patientReference: fixture.patientReference, encounterReference: encounter, rows: [{ slot: 'distance-cc', state: 'ortho' }] });
      assert.equal(saved.status, 200, JSON.stringify(saved.body));
      await page.reload(); await line(page, 'cover-test').waitFor();
      assert.equal(await line(page, 'cover-test').getAttribute('data-holds-data'), 'true');
      assert.equal(await action(page, 'collapse', 'cover-test').count(), 1);
      await capture(page, width, 'after-data-wins', line(page, 'cover-test'));
      const overview = await api(page, `/clinical-graph/encounters/${encounter.slice(10)}/exam-overview`);
      assert.equal(overview.status, 200);
      assert.deepEqual(errors, []);
      results.push({ width, proof: '1-3', chartedThroughIopUi: true, neededOverviewRefresh, actualProjectionKeys: overview.body.findings.map(row => row.findingKey), collapseReloadExpanded: true, corneaShelfRoundtrip: true, unknownCollapseOnly: true, persistedShelfDataWins: true, viewRequests: 0, pageErrors: errors });
      const privateContext = await browser.newContext({ viewport: { width, height: width === 1440 ? 1100 : 1300 } });
      try {
        const privatePage = await privateContext.newPage();
        await login(privatePage, base); await open(privatePage, base, encounter);
        assert.equal(await privatePage.getByTestId('exam-collapsed-line').count(), 0);
        assert.equal(await privatePage.evaluate(id => localStorage.getItem(`odos:exam-view:v1:${id}`), encounter.slice(10)), null);
        await capture(privatePage, width, 'private-open', line(privatePage, 'iop'));
        await privatePage.addInitScript(() => {
          const get = Storage.prototype.getItem, set = Storage.prototype.setItem;
          Storage.prototype.getItem = function(key) { if (key.startsWith('odos:exam-view:')) throw new Error('exam storage read denied'); return get.call(this, key); };
          Storage.prototype.setItem = function(key, value) { if (key.startsWith('odos:exam-view:')) throw new Error('exam storage write denied'); return set.call(this, key, value); };
        });
        await privatePage.reload(); await line(privatePage, 'iop').waitFor();
        assert.equal(await privatePage.getByTestId('exam-collapsed-line').count(), 0);
        await action(privatePage, 'collapse', 'iop').click();
        assert.match(await line(privatePage, 'iop').innerText(), /collapsed[\s\S]*17/);
        await capture(privatePage, width, 'storage-denied-session', line(privatePage, 'iop'));
        results.push({ width, proof: 4, freshPrivateContextExpanded: true, examStateStorageReadAndWriteDeniedSessionUsable: true });
      } finally { await privateContext.close(); }
    } catch (error) {
      if (signedIn) await capture(page, width, 'debug-failure');
      throw error;
    } finally { await context.close(); }
  }
  writeFileSync(join(evidence, fixback1 ? (fixbackBefore ? '../fixback1-before-browser-results.json' : '../fixback1-browser-results.json') : baselineOnly ? '../baseline-refresh-probe.json' : pairsOnly ? '../screenshot-pairs.json' : '../browser-results.json'), JSON.stringify(results, null, 2) + '\n');
  console.log(JSON.stringify(results, null, 2));
} finally {
  try { await browser?.close(); } finally { caddy?.kill('SIGTERM'); }
}
