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
   const page = await context.newPage(); await login(page, 'provider');
   await board(page, visits[String(width)]);
   const baselineAlerts = await page.getByRole('alert').count();
   for (const kind of ['failed', 'unrecognized']) {
    await page.route('**/previous-exams*', route => route.fulfill({ status: kind === 'failed' ? 503 : 200, contentType: 'application/json', body: JSON.stringify(kind === 'failed' ? { error: 'Synthetic history read failed' } : { resourceType: 'Bundle', entry: [] }) }));
    await page.getByTestId('change-following').click();
    const picker = page.getByRole('region', { name: 'What are we following?', exact: true });
    await picker.getByRole('status').filter({ hasText: 'Previous exams could not be loaded.' }).waitFor();
    assert.equal(await page.getByRole('alert').count(), baselineAlerts);
    assert.equal(await picker.getByText('No previous exams.', { exact: true }).count(), 0);
    assert.ok(await picker.getByRole('status').isVisible());
    await picker.getByLabel('Follow-up template', { exact: true }).selectOption('comprehensive');
    assert.equal(await picker.getByLabel('Follow-up template', { exact: true }).inputValue(), 'comprehensive');
    assert.ok(await picker.getByTestId('nothing-to-follow').isEnabled());
    await picker.scrollIntoViewIfNeeded(); await capture(page, width, `read-${kind}`);
    await picker.getByTestId('nothing-to-follow').click(); await page.getByTestId('change-following').waitFor();
    assert.equal((await scope(page, visits[String(width)])).examScope, 'office-visit');
    await page.unroute('**/previous-exams*');
    results.push({ width, kind, baselineAlerts, failedReadAlerts: baselineAlerts, messageVisible: true, emptyCopyAbsent: true, comprehensiveSelectable: true, nothingApplied: true });
   }
  } finally { await context.close(); }
 }
} finally { await browser.close(); }
writeFileSync(join(dir, 'browser-g9.json'), JSON.stringify(results,null,2)+'\n');
console.log('G9 browser fault injection passed for failed and unrecognized reads at 1440 and 390.');
