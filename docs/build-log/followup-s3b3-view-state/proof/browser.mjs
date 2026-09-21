import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
const root = resolve('.'), runtime = join(root, '.odos/s3b3-proof');
const read = name => JSON.parse(readFileSync(join(runtime, name), 'utf8'));
const { ports, project } = read('manifest.json'); assert.equal(project, 'odos-s3b3-proof');
const credentials = read('credentials.json'), { patientId, visits } = read('view-visits.json');
const base = `http://127.0.0.1:${ports.frontdoor}`;
const dir = 'docs/build-log/followup-s3b3-view-state';
const images = join(dir, 'screenshots'); mkdirSync(images, { recursive: true });
const { chromium } = createRequire(join(root, 'ui/package.json'))('playwright-core');
const results = [];
async function login(page) {
  await page.goto(`${base}/clinic`);
  await page.getByPlaceholder('Email address').fill(credentials.provider.email);
  await page.getByPlaceholder('Password', { exact: true }).fill(credentials.provider.password);
  await page.getByRole('button', { name: 'Enter', exact: true }).click();
  try { await page.getByPlaceholder('Password', { exact: true }).waitFor({ state: 'detached' }); }
  catch { throw new Error('Synthetic login failed; credential-bearing diagnostics withheld.'); }
}
async function api(page, id, tail, method = 'GET', body) {
  return page.evaluate(async ({ path, method, body }) => {
    const session = JSON.parse(sessionStorage.getItem('odos.session.v1'));
    const response = await fetch(path, { method, headers: { Authorization: `Bearer ${session.accessToken}`, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, body: await response.json() };
  }, { path: `/clinical-graph/encounters/${id}/${tail}`, method, body });
}
async function board(page, id) {
  await page.goto(`${base}/clinic?patientId=${patientId}&encounterId=${id}`);
  await page.getByRole('button', { name: 'By structure', exact: true }).click();
  await page.getByTestId('exam-overview-section').first().waitFor(); await page.waitForLoadState('networkidle');
}
const line = (page, id) => page.locator(`[data-drawn-editor-id="${id}"]`);
const action = (page, verb, id) => page.locator(`[data-exam-view-action="${verb}"][data-editor-id="${id}"]`);
async function capture(page, width, name, id = 'wearing') {
  await line(page, id).scrollIntoViewIfNeeded();
  await page.evaluate(() => document.fonts.ready); await page.mouse.move(0, 0);
  await page.screenshot({ path: join(images, `${width}-${name}.png`), animations: 'disabled' });
}
const browserA = await chromium.launch({ channel: 'chrome', headless: true });
const browserB = await chromium.launch({ channel: 'chrome', headless: true });
try {
 for (const width of [1440, 390]) {
  const ca = await browserA.newContext({ viewport: { width, height: width === 390 ? 1700 : 1000 } });
  const cb = await browserB.newContext({ viewport: { width, height: width === 390 ? 1700 : 1000 } });
  try {
   const a = await ca.newPage(), b = await cb.newPage();
   a.setDefaultTimeout(30000); b.setDefaultTimeout(30000);
   await login(a); await login(b);
   const id = visits[String(width)];
   await api(a, id, 'exam-view-state', 'PUT', { collapsed: [], shelved: [] });
   await board(a, id);
   const errors = []; a.on('pageerror', e => errors.push(e.message)); b.on('pageerror', e => errors.push(e.message));
   const shapeBefore = (await api(a, id, 'exam-scope')).body;
   await capture(a, width, 'expanded');
   await action(a, 'collapse', 'wearing').click();
   await a.waitForTimeout(500);
   await board(b, id);
   assert.equal(await line(b, 'wearing').getByTestId('exam-collapsed-line').count(), 1);
   const shapeAfter = (await api(a, id, 'exam-scope')).body;
   assert.equal(shapeAfter.versionId, shapeBefore.versionId);
   await capture(b, width, 'shared-second-browser');
   let writes = 0;
   const count = request => { if (request.url().endsWith('/exam-view-state') && request.method() === 'PUT') writes++; };
   a.on('request', count);
   await a.evaluate(async () => {
    for (let i = 0; i < 7; i++) {
     const button = document.querySelector('[data-editor-id="wearing"][data-exam-view-action]');
     if (!button) throw Error('Missing view control');
     button.click(); await new Promise(resolve => setTimeout(resolve, 15));
    }
   });
   await a.waitForTimeout(650); a.off('request', count);
   assert.equal(writes, 1);
   const final = await api(a, id, 'exam-view-state');
   assert.equal(final.status, 200); assert.ok(!final.body.collapsed.includes('wearing'));
   const wasBlank = await action(a, 'shelve', 'iop').count();
   assert.equal(wasBlank, 1, 'new encounter has a blank IOP line');
   await action(a, 'shelve', 'iop').click(); await a.waitForTimeout(500);
   assert.equal(await line(a, 'iop').count(), 0);
   // Browser B retains the open line; failed preference writes preserve A's persisted shelf.
   await b.route('**/exam-view-state', async route => {
     if (route.request().method() === 'PUT') await route.fulfill({ status: 503, contentType: 'application/json', body: '{}' });
     else await route.continue();
   });
   await line(b, 'iop').locator('button').first().click();
   await b.getByRole('combobox', { name: 'OD IOP value', exact: true }).fill('17');
   await b.getByRole('combobox', { name: 'OD IOP value', exact: true }).press('Tab');
   const sheet = b.locator('[data-entry-sheet-section="iop"]');
   await sheet.locator('select').first().selectOption('GAT');
   await Promise.all([b.waitForResponse(r => r.url().endsWith('/clinical-graph/iop') && r.status() === 200), sheet.getByRole('button', { name: 'Save IOP', exact: true }).click()]);
   await sheet.waitFor({ state: 'detached' }); await b.waitForTimeout(500);
   const persistedShelf = await api(a, id, 'exam-view-state');
   assert.ok(persistedShelf.body.shelved.includes('iop'));
   await b.unroute('**/exam-view-state');
   await board(a, id); await board(b, id);
   for (const page of [a, b]) {
    assert.equal(await line(page, 'iop').getAttribute('data-holds-data'), 'true');
    assert.ok((await line(page, 'iop').innerText()).includes('17'));
   }
   await capture(a, width, 'data-wins-first-browser', 'iop');
   await capture(b, width, 'data-wins-second-browser', 'iop');
   const alertBefore = await a.getByRole('alert').count();
   await a.route('**/exam-view-state', route => route.fulfill({ status: 503, contentType: 'application/json', body: '{}' }));
   await board(a, id);
   assert.equal(await a.getByTestId('exam-collapsed-line').count(), 0);
   assert.equal(await a.getByRole('alert').count(), alertBefore);
   await action(a, 'collapse', 'iop').click(); await a.waitForTimeout(500);
   assert.equal(await line(a, 'iop').getByTestId('exam-collapsed-line').count(), 1);
   assert.equal(await a.getByRole('alert').count(), alertBefore);
   await capture(a, width, 'write-failed-session-toggle', 'iop');
   await board(a, id);
   assert.equal(await a.getByTestId('exam-collapsed-line').count(), 0);
   assert.equal(await a.getByRole('alert').count(), alertBefore);
   await capture(a, width, 'read-failed-open', 'iop');
   await line(a, 'iop').locator('button').first().click();
   await a.locator('[data-entry-sheet-section="iop"]').waitFor();
   assert.deepEqual(errors, []);
   results.push({ width, independentBrowsers: 2, sharedCollapse: true, shapeVersionBefore: shapeBefore.versionId, shapeVersionAfter: shapeAfter.versionId,
    rapidToggles: 7, writes, finalCollapsed: final.body.collapsed, persistedShelfWithData: true, dataDrawnInBothBrowsers: true,
    readFailureOpen: true, writeFailureSessionOnly: true, reloadLosesOfflineToggle: true, chartAlertCount: alertBefore, editorWorksDuringFailure: true, pageErrors: errors });
   writeFileSync(join(dir, 'browser-proof.json'), JSON.stringify(results, null, 2)+'\n');
   console.log(`width ${width}: shared, data wins, 7 toggles -> ${writes} write, silent failures; alerts ${alertBefore}`);
  } finally { await ca.close(); await cb.close(); }
 }
} finally { await browserA.close(); await browserB.close(); }
