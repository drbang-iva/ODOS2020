import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
const before = process.argv.includes('--before');
const root = resolve('.'), runtime = join(root, '.odos/s3b2-proof');
const read = name => JSON.parse(readFileSync(join(runtime, name), 'utf8'));
const { ports, project } = read('manifest.json'); assert.equal(project, 'odos-s3b2-proof');
const credentials = read('credentials.json'), { patientId, visits, prior } = read('picker-visits.json');
const base = `http://127.0.0.1:${ports.frontdoor}`;
const dir = join(root, 'docs/build-log/followup-s3b2-picker');
const images = join(dir, 'screenshots'); mkdirSync(images, { recursive: true });
const { chromium } = createRequire(join(root, 'ui/package.json'))('playwright-core');
const results = [], sessions = new Map();
async function login(page, role) {
  if (sessions.has(role)) await page.addInitScript(session => sessionStorage.setItem('odos.session.v1', session), sessions.get(role));
  await page.goto(`${base}/clinic`);
  if (sessions.has(role)) return;
  await page.getByPlaceholder('Email address').fill(credentials[role].email);
  await page.getByPlaceholder('Password', { exact: true }).fill(credentials[role].password);
  await page.getByRole('button', { name: 'Enter', exact: true }).click();
  try { await page.getByPlaceholder('Password', { exact: true }).waitFor({ state: 'detached' }); }
  catch { throw new Error('Synthetic login failed; credential-bearing diagnostics withheld.'); }
  sessions.set(role, await page.evaluate(() => sessionStorage.getItem('odos.session.v1')));
}
async function api(page, path, method = 'GET', body) {
  return page.evaluate(async ({ path, method, body }) => {
    const session = JSON.parse(sessionStorage.getItem('odos.session.v1'));
    const response = await fetch(path, { method, headers: { Authorization: `Bearer ${session.accessToken}`, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, body: await response.json() };
  }, { path, method, body });
}
const route = (id, tail) => `/clinical-graph/encounters/${id}/${tail}`;
async function scope(page, id) { const r = await api(page, route(id, 'exam-scope')); assert.equal(r.status, 200); return r.body; }
async function capture(page, width, name) {
  await page.waitForLoadState('networkidle'); await page.evaluate(() => document.fonts.ready);
  
  await page.mouse.move(0, 0);
  await page.screenshot({ path: join(images, `${width}-${name}.png`), animations: 'disabled' });
}
async function board(page, id) {
  await page.goto(`${base}/clinic?patientId=${patientId}&encounterId=${id}`);
  await page.getByRole('button', { name: 'By structure', exact: true }).click();
  await page.getByTestId('exam-overview-section').first().waitFor(); await page.waitForLoadState('networkidle');
  return page.locator('[data-drawn-editor-id]').evaluateAll(nodes => nodes.map(node => node.getAttribute('data-drawn-editor-id')));
}

const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
 for (const width of [1440, 390]) {
  const context = await browser.newContext({ viewport: { width, height: 1100 } });
  try {
   const page = await context.newPage(); page.setDefaultTimeout(30000); await login(page, 'provider');
   const errors = []; page.on('pageerror', e => errors.push(e.message));
   const id = visits[String(width)];
   await board(page, id);
   const original = await scope(page, id);
   if (before) {
    await capture(page, width, 'before');
    assert.equal(await page.getByRole('region', { name: 'What are we following?', exact: true }).count(), 0);
    results.push({ width, scope: original, pickerAbsent: true }); continue;
   }
   assert.equal(original.source, 'derived');
   const picker = page.getByRole('region', { name: 'What are we following?', exact: true });
   await picker.getByText(prior[0].label, { exact: false }).waitFor();
   await picker.getByText(prior[1].label, { exact: false }).waitFor();
   await picker.scrollIntoViewIfNeeded(); await capture(page, width, 'picker');
   await picker.getByLabel('Follow-up template', { exact: true }).selectOption('office-visit');
   const mutationRequests = [];
   const onRequest = req => { if (['POST','PUT','PATCH','DELETE'].includes(req.method())) mutationRequests.push({ method: req.method(), path: new URL(req.url()).pathname }); };
   page.on('request', onRequest);
   await picker.getByText(prior[0].label, { exact: false }).locator('..').getByRole('button', { name: 'Follow this', exact: true }).click();
   await page.getByTestId('change-following').waitFor();
   await page.waitForLoadState('networkidle');
   page.off('request', onRequest);
   assert.deepEqual(mutationRequests, [{ method: 'PUT', path: route(id, 'exam-scope') }]);
   const picked = await scope(page, id);
   assert.equal(picked.source, 'explicit'); assert.equal(picked.chosenBy.reference, credentials.provider.practitionerReference);
   assert.ok(Number.isFinite(Date.parse(picked.chosenAt))); assert.ok(picked.sectionsOpen.includes('iop'));
   assert.ok(await page.locator('[data-drawn-editor-id="iop"]').count());
   await page.getByTestId('exam-overview-section').first().scrollIntoViewIfNeeded(); await capture(page, width, 'picked-board');
   await page.reload(); await page.getByTestId('change-following').waitFor();
   assert.deepEqual(await scope(page, id), picked);
   assert.equal((await api(page, route(id,'exam-overview'))).status, 200);
   assert.deepEqual(await scope(page, id), picked);
   await page.getByTestId('change-following').click();
   await page.getByTestId('nothing-to-follow').click();
   await page.getByTestId('change-following').waitFor(); await page.waitForLoadState('networkidle');
   const nothing = await scope(page, id);
   assert.equal(nothing.examScope, 'office-visit'); assert.equal(nothing.source, 'explicit');
   assert.deepEqual(nothing.profilesApplied, []); assert.deepEqual(nothing.sectionsOpen, []);
   await page.getByTestId('exam-overview-section').first().scrollIntoViewIfNeeded(); await capture(page, width, 'nothing-board');
   assert.deepEqual(errors, []);
   results.push({width, before: original, after: picked, afterNothing: nothing, reloadUnchanged: true, subsequentOverviewUnchanged: true, mutations: mutationRequests, pageErrors: errors});
  } finally { await context.close(); }
 }
} finally { await browser.close(); }
writeFileSync(join(dir, before ? 'browser-before.json' : 'browser-after.json'), JSON.stringify(results,null,2)+'\n');
console.log(`Browser ${before ? 'base' : 'candidate'} proof passed at 1440 and 390.`);
