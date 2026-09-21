import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
const before = process.argv.includes('--before');
const root = resolve('.'), runtime = join(root, before ? '.odos/s3b1-before-proof' : '.odos/s3b1-proof');
const read = name => JSON.parse(readFileSync(join(runtime, name), 'utf8'));
const { ports, project } = read('manifest.json'); assert.equal(project, 'odos-s3b1-proof');
const credentials = read('credentials.json'), { patientId, visits } = read('shape-visits.json');
const base = `http://127.0.0.1:${ports.frontdoor}`;
const dir = join(root, 'docs/build-log/followup-s3b1-shape-record');
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
  if (width === 390 && !name.startsWith('legacy')) await page.getByTestId('exam-overview-section').first().evaluate(node => node.scrollIntoView({ block: 'start' }));
  await page.mouse.move(0, 0);
  await page.screenshot({ path: join(images, `${width}-${name}.png`), animations: 'disabled' });
}
async function board(page, id) {
  await page.goto(`${base}/clinic?patientId=${patientId}&encounterId=${id}`);
  await page.getByRole('button', { name: 'By structure', exact: true }).click();
  await page.getByTestId('exam-overview-section').first().waitFor(); await page.waitForLoadState('networkidle');
  return page.locator('[data-drawn-editor-id]').evaluateAll(nodes => nodes.map(node => node.getAttribute('data-drawn-editor-id')));
}
async function openOffice(page, id) {
  const first = await api(page, route(id, 'exam-overview')); assert.equal(first.status, 200);
  assert.ok(first.body.sectionsOpen?.includes('iop'), 'profile should shape on first open');
  const saved = await scope(page, id);
  const changed = await api(page, route(id, 'exam-scope'), 'PUT', { examScope: 'office-visit', expectedVersion: saved.versionId });
  assert.equal(changed.status, 200);
  return changed.body;
}
const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
 for (const width of [1440, 390]) {
  const context = await browser.newContext({ viewport: { width, height: 1100 } });
  const adminContext = await browser.newContext({ viewport: { width, height: 1100 } });
  try {
   const page = await context.newPage(); page.setDefaultTimeout(30000); await login(page, 'provider');
   const errors = []; page.on('pageerror', e => errors.push(e.message));
   const legacyId = visits[`${width}-legacy`];
   const legacyBefore = await scope(page, legacyId);
   const legacyLines = await board(page, legacyId);
   await capture(page, width, before ? 'legacy-base' : 'legacy-current');
   assert.equal((await scope(page, legacyId)).shapedAt, undefined);
   assert.deepEqual(await scope(page, legacyId), legacyBefore);
   const record = { width, legacyLines, legacyUnchanged: true };
   if (before) { results.push(record); continue; }
   const baseline = JSON.parse(readFileSync(join(dir, 'browser-before.json'), 'utf8')).find(row => row.width === width);
   assert.deepEqual(legacyLines, baseline.legacyLines, 'legacy lines exactly match base');
   const admin = await adminContext.newPage(); admin.setDefaultTimeout(30000); await login(admin, 'admin');
   await admin.goto(`${base}/settings/chart-fields-sections`);
   const settings = admin.getByRole('region', { name: 'Follow-up profiles', exact: true });
   const open = () => settings.getByRole('button', { name: 'Open profile Glaucoma / glaucoma suspect', exact: true }).click();
   await settings.getByRole('button', { name: 'Open profile Glaucoma / glaucoma suspect', exact: true }).waitFor();
   let catalog = (await api(admin, '/follow-up-profiles')).body;
   let profile = catalog.profiles.find(p => p.profileKey === 'glaucoma');
   if (!profile.active || profile.sectionsOpen.some(s => s.key === 'pachymetry')) {
    await open(); await settings.getByRole('button', { name: 'Reset to shipped', exact: true }).click();
    await settings.getByRole('form', { name: 'Edit follow-up profile' }).waitFor({ state: 'detached' });
    profile = (await api(admin, '/follow-up-profiles')).body.profiles.find(p => p.profileKey === 'glaucoma');
   }
   const id = visits[`${width}-original`], next = visits[`${width}-new`];
   const original = await openOffice(page, id);
   assert.deepEqual(original.profilesApplied, [{ profileKey: 'glaucoma', version: profile.version, versionId: profile.versionId }]);
   const originalLines = await board(page, id);
   assert.ok(originalLines.includes('iop')); assert.ok(!originalLines.includes('pachymetry'));
   await capture(page, width, 'original-shape');
   await open(); await settings.getByLabel('Add Opens', { exact: true }).selectOption('pachymetry');
   await settings.getByRole('button', { name: 'Save profile', exact: true }).click();
   await settings.getByRole('form', { name: 'Edit follow-up profile' }).waitFor({ state: 'detached' });
   const edited = (await api(admin, '/follow-up-profiles')).body.profiles.find(p => p.profileKey === 'glaucoma');
   assert.ok(edited.sectionsOpen.some(s => s.key === 'pachymetry'));
   assert.deepEqual(await board(page, id), originalLines);
   assert.deepEqual(await scope(page, id), original);
   await capture(page, width, 'original-after-edit');
   const newScope = await openOffice(page, next);
   const newLines = await board(page, next); assert.ok(newLines.includes('pachymetry'));
   assert.deepEqual(newScope.profilesApplied, [{ profileKey: 'glaucoma', version: edited.version, versionId: edited.versionId }]);
   await capture(page, width, 'new-after-edit');
   await settings.getByRole('button', { name: 'Turn off Glaucoma / glaucoma suspect', exact: true }).click();
   await settings.getByRole('button', { name: 'Turn on Glaucoma / glaucoma suspect', exact: true }).waitFor();
   assert.deepEqual(await board(page, id), originalLines);
   assert.deepEqual(await scope(page, id), original);
   record.original = original; record.newScope = newScope; record.originalLines = originalLines; record.newLines = newLines;
   record.editAndRetireFrozen = true; record.pageErrors = errors; assert.deepEqual(errors, []);
   results.push(record);
  } finally { await context.close(); await adminContext.close(); }
 }
 writeFileSync(join(dir, before ? 'browser-before.json' : 'browser-after.json'), JSON.stringify(results, null, 2)+'\n');
 console.log(JSON.stringify({ phase: before ? 'base' : 'candidate', widths: results.map(r => r.width), passed: true }));
} finally { await browser.close(); }
