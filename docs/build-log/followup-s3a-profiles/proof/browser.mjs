import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
const before = process.argv.includes('--before');
const root = resolve('.'), runtime = join(root, before ? '.odos/s3a-before-proof' : '.odos/s3a-proof');
const read = name => JSON.parse(readFileSync(join(runtime, name), 'utf8'));
const { ports, project } = read('manifest.json'); assert.equal(project, 'odos-s3a-proof');
const credentials = read('credentials.json'), fixture = read('fixture.json');
const base = `http://127.0.0.1:${ports.frontdoor}`;
const dir = join(root, 'docs/build-log/followup-s3a-profiles');
const images = join(dir, 'screenshots'); mkdirSync(images, { recursive: true });
const { chromium } = createRequire(join(root, 'ui/package.json'))('playwright-core');
const results = [], sessions = new Map();
async function login(page, role) {
  if (sessions.has(role)) await page.addInitScript(session => sessionStorage.setItem('odos.session.v1', session), sessions.get(role));
  await page.goto(`${base}/clinic`);
  if (!sessions.has(role)) {
    await page.getByPlaceholder('Email address').fill(credentials[role].email);
    await page.getByPlaceholder('Password', { exact: true }).fill(credentials[role].password);
    await page.getByRole('button', { name: 'Enter', exact: true }).click();
    try { await page.getByPlaceholder('Password', { exact: true }).waitFor({ state: 'detached' }); }
    catch { throw new Error('Synthetic login failed; credential-bearing diagnostics withheld.'); }
    sessions.set(role, await page.evaluate(() => sessionStorage.getItem('odos.session.v1')));
  }
}
async function api(page, path, body) {
  return page.evaluate(async ({ path, body }) => {
    const session = JSON.parse(sessionStorage.getItem('odos.session.v1'));
    const response = await fetch(path, { method: body ? 'POST' : 'GET', headers: { Authorization: `Bearer ${session.accessToken}`, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, body: await response.json() };
  }, { path, body });
}
async function capture(page, width, name, locator) {
  await page.waitForLoadState('networkidle'); await page.evaluate(() => document.fonts.ready);
  await page.mouse.move(0, 0);
  if (locator) await locator.screenshot({ path: join(images, `${width}-${name}.png`), animations: 'disabled' });
  else await page.screenshot({ path: join(images, `${width}-${name}.png`), animations: 'disabled' });
}
const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  for (const width of [1440, 390]) {
    const context = await browser.newContext({ viewport: { width, height: width === 1440 ? 1100 : 1300 } });
    try {
      const page = await context.newPage(); page.setDefaultTimeout(25000);
      const errors = []; page.on('pageerror', error => errors.push(error.message));
      await login(page, 'provider');
      await page.goto(`${base}/clinic?patientId=${fixture.patientReference.slice(8)}&encounterId=${fixture.current.slice(10)}`);
      await page.getByRole('button', { name: 'By structure', exact: true }).click();
      await page.getByTestId('exam-overview-section').first().waitFor(); await page.waitForLoadState('networkidle');
      const board = await page.locator('[data-drawn-editor-id]').evaluateAll(nodes => nodes.map(node => ({ id: node.getAttribute('data-drawn-editor-id'), text: node.textContent.replace(/\s+/g, ' ').trim() })));
      assert.ok(board.length > 0);
      await capture(page, width, before ? 'chart-before' : 'chart-after');
      if (!before) {
        const baseline = JSON.parse(readFileSync(join(dir, 'browser-before.json'), 'utf8')).find(row => row.width === width);
        assert.deepEqual(board, baseline.board, 'Drawn chart lines and content must be unchanged');
      }
      results.push({ width, board, pageErrors: errors }); assert.deepEqual(errors, []);
    } finally { await context.close(); }
    if (before) continue;
    const adminContext = await browser.newContext({ viewport: { width, height: width === 1440 ? 1100 : 1300 } });
    try {
      const page = await adminContext.newPage(); page.setDefaultTimeout(25000);
      await login(page, 'admin'); await page.goto(`${base}/settings/chart-fields-sections`);
      const screen = page.getByRole('region', { name: 'Follow-up profiles', exact: true });
      await screen.getByRole('button', { name: 'Open profile Glaucoma / glaucoma suspect', exact: true }).waitFor();
      const initial = await api(page, '/follow-up-profiles'); assert.equal(initial.status, 200); assert.equal(initial.body.profiles.length, 5);
      const shipped = initial.body.shipped.find(row => row.profileKey === 'glaucoma');
      await capture(page, width, 'profiles-listed', screen);
      await screen.getByRole('button', { name: 'Open profile Glaucoma / glaucoma suspect', exact: true }).click();
      assert.equal(await screen.locator('fieldset').count(), 5);
      await capture(page, width, 'profile-five-lists', screen);
      await screen.getByLabel('Add Opens', { exact: true }).selectOption('cover-test');
      await screen.getByRole('button', { name: 'Save profile', exact: true }).click();
      await screen.getByRole('form', { name: 'Edit follow-up profile' }).waitFor({ state: 'detached' });
      await page.reload(); await screen.getByRole('button', { name: 'Open profile Glaucoma / glaucoma suspect', exact: true }).waitFor();
      const saved = await api(page, '/follow-up-profiles'); const overlay = saved.body.profiles.find(row => row.profileKey === 'glaucoma');
      assert.ok(overlay.sectionsOpen.some(row => row.key === 'cover-test')); assert.ok(overlay.versionId);
      assert.deepEqual(saved.body.shipped.find(row => row.profileKey === 'glaucoma'), shipped);
      await screen.getByRole('button', { name: 'Open profile Glaucoma / glaucoma suspect', exact: true }).click();
      await capture(page, width, 'profile-overlay', screen);
      await screen.getByRole('button', { name: 'Reset to shipped', exact: true }).click();
      await screen.getByRole('form', { name: 'Edit follow-up profile' }).waitFor({ state: 'detached' });
      const reset = await api(page, '/follow-up-profiles'); const { versionId, ...restored } = reset.body.profiles.find(row => row.profileKey === 'glaucoma');
      assert.deepEqual(restored, shipped); assert.ok(versionId);
      results.find(row => row.width === width).settings = { seedCount: initial.body.shipped.length, lists: 5, overlayPersists: true, shippedUntouched: true, resetRestored: true };
    } finally { await adminContext.close(); }
    const staffContext = await browser.newContext({ viewport: { width, height: width === 1440 ? 1100 : 1300 } });
    try {
      const page = await staffContext.newPage(); page.setDefaultTimeout(25000);
      await login(page, 'staff'); await page.goto(`${base}/settings/chart-fields-sections`);
      const screen = page.getByRole('region', { name: 'Follow-up profiles', exact: true });
      await screen.getByRole('button', { name: 'Open profile Glaucoma / glaucoma suspect', exact: true }).click();
      assert.equal(await screen.getByRole('button', { name: 'Save profile', exact: true }).count(), 0);
      assert.equal(await screen.locator('fieldset:disabled').count(), 5);
      const catalog = await api(page, '/follow-up-profiles'); assert.equal(catalog.status, 200); assert.equal(catalog.body.canWrite, false);
      const { versionId, ...profile } = catalog.body.profiles.find(row => row.profileKey === 'glaucoma');
      const update = await api(page, '/follow-up-profiles/glaucoma', { profile, expectedVersion: versionId });
      const create = await api(page, '/follow-up-profiles', { profile: { ...profile, profileKey: 'staff-denied' }, expectedVersion: null });
      assert.equal(update.status, 403); assert.equal(create.status, 403);
      await capture(page, width, 'profile-read-only', screen);
      results.find(row => row.width === width).staff = { read: catalog.status, create: create.status, update: update.status, disabledLists: 5 };
    } finally { await staffContext.close(); }
  }
  writeFileSync(join(dir, before ? 'browser-before.json' : 'browser-after.json'), JSON.stringify(results, null, 2) + '\n');
  console.log(JSON.stringify({ widths: results.map(row => row.width), phase: before ? 'before' : 'after', passed: true }));
} finally { await browser.close(); }
