import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
const before = process.argv.includes('--before');
const root = resolve('.'), runtime = join(root, before ? '.odos/639-before-proof' : '.odos/639-proof');
const read = name => JSON.parse(readFileSync(join(runtime, name), 'utf8'));
const { ports, project } = read('manifest.json'); assert.equal(project, 'odos-639-proof');
const credentials = read('credentials.json'), fixture = read('fixture.json');
const base = `http://127.0.0.1:${ports.frontdoor}`;
const dir = join(root, 'docs/build-log/issue-639-section-group-concurrency');
const images = join(dir, 'screenshots'); mkdirSync(images, { recursive: true });
const { chromium } = createRequire(join(root, 'ui/package.json'))('playwright-core');
const sessions = new Map();
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
const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const contexts = await Promise.all([1,2].map(() => browser.newContext({ viewport: { width: 1440, height: 1100 } })));
  const pages = await Promise.all(contexts.map(c => c.newPage()));
  for (const page of pages) { page.setDefaultTimeout(30000); await login(page, 'admin'); }
  const path = '/clinical-graph/finding-section-groups';
  const key = 'synthetic-concurrency';
  let catalogue = await api(pages[0], path);
  assert.equal(catalogue.status, 200);
  let group = catalogue.body.groups.find(g => g.groupKey === key);
  if (!group) {
    const created = await api(pages[0], path, { groupKey: key, label: 'Synthetic concurrency', sectionKeyPrefixes: ['synthetic:'], active: true, ...(!before ? { expectedVersion: null } : {}) });
    assert.equal(created.status, 201); group = created.body.group;
  } else {
    const reset = await api(pages[0], `${path}/${key}`, { label: 'Synthetic concurrency', ...(!before ? { expectedVersion: group.versionId } : {}) });
    assert.equal(reset.status, 200); group = reset.body.group;
  }
  const loaded = [];
  for (const page of pages) {
    const response = page.waitForResponse(r => new URL(r.url()).pathname === path && r.request().method() === 'GET');
    await page.goto(`${base}/settings/chart-fields-sections`);
    const body = await (await response).json(); loaded.push(body.groups.find(g => g.groupKey === key).versionId ?? null);
    const row = page.locator('div').filter({ has: page.getByText(key, { exact: true }) }).filter({ has: page.getByRole('button', { name: 'Edit', exact: true }) }).last();
    await row.getByRole('button', { name: 'Edit', exact: true }).click();
  }
  assert.equal(loaded[0], loaded[1]);
  const statuses = [];
  for (const [index, page] of pages.entries()) {
    await page.getByRole('dialog').getByLabel('Label', { exact: true }).fill(index === 0 ? 'First editor label' : 'Second editor label');
    const response = page.waitForResponse(r => new URL(r.url()).pathname === `${path}/${key}` && r.request().method() === 'POST');
    await page.getByRole('button', { name: 'Save group', exact: true }).click();
    statuses.push((await response).status());
  }
  assert.deepEqual(statuses, before ? [200,200] : [200,409]);
  if (!before) {
    const alert = pages[1].getByRole('dialog').getByRole('alert');
    await alert.waitFor();
    assert.equal(await alert.innerText(), 'This record was changed by someone else since you opened it. Reload and reapply your change.');
  } else await pages[1].getByRole('dialog').waitFor({ state: 'detached' });
  const saved = (await api(pages[0], path)).body.groups.find(g => g.groupKey === key);
  assert.equal(saved.label, before ? 'Second editor label' : 'First editor label');
  await pages[1].screenshot({ path: join(images, `settings-${before ? 'before' : 'after'}.png`), animations: 'disabled' });
  const result = { sameLoadedVersion: loaded[0] === loaded[1], statuses, persistedLabel: saved.label, secondDraftPreserved: !before };
  if (!before) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1100 } });
    const page = await context.newPage(); page.setDefaultTimeout(30000); await login(page, 'provider');
    const cleanup = await api(page, `/clinical-graph/encounters/${fixture.current.slice(10)}/section-groups`, { action: 'remove', groupKey: 'dry-eye-workup' });
    assert.equal(cleanup.status, 200, 'Start with an empty group');
    await page.goto(`${base}/clinic?patientId=${fixture.patientReference.slice(8)}&encounterId=${fixture.current.slice(10)}`);
    await page.getByRole('button', { name: 'By structure', exact: true }).click();
    await page.getByTestId('exam-overview-section').first().waitFor();
    const pulled = page.waitForResponse(r => new URL(r.url()).pathname.endsWith('/section-groups') && r.request().method() === 'POST');
    await page.locator('[data-testid="exam-shelf-section-group"][data-section-group-key="dry-eye-workup"]').click();
    assert.equal((await pulled).status(), 200);
    await page.locator('[data-drawn-editor-id="dry-eye:symptoms"]').waitFor();
    const catalog = await api(page, `${path}?encounterId=${fixture.current.slice(10)}`);
    assert.ok(catalog.body.overrideGroupKeys.includes('dry-eye-workup'));
    result.pullIn = true;
    const savedFinding = await api(page, '/clinical-graph/custom/dry-eye%3Asymptoms', {
      patientReference: fixture.patientReference, encounterReference: fixture.current,
      customFields: [], remarks: 'Synthetic concurrency proof symptoms',
    });
    assert.ok([200,201].includes(savedFinding.status), `saved symptoms status ${savedFinding.status}`);
    const remove = await api(page, `/clinical-graph/encounters/${fixture.current.slice(10)}/section-groups`, { action: 'remove', groupKey: 'dry-eye-workup' });
    assert.equal(remove.status, 409); assert.equal(remove.body.code, 'section-group-has-content');
    await page.reload();
    await page.getByText('Dry Eye Workup · Has findings this visit', { exact: true }).waitFor();
    const pinned = await api(page, `${path}?encounterId=${fixture.current.slice(10)}`);
    assert.ok(pinned.body.contentPinnedGroupKeys.includes('dry-eye-workup'));
    assert.ok(pinned.body.effectiveGroupKeys.includes('dry-eye-workup'));
    result.savedFindingStatus = savedFinding.status;
    result.populatedRemoval = { status: remove.status, code: remove.body.code };
    result.contentPinnedAfterReload = true;
    await page.locator('[data-shelf-group="section-groups"]').screenshot({ path: join(images, 'chart-pull-in.png'), animations: 'disabled' });
  }
  writeFileSync(join(dir, `browser-${before ? 'before' : 'after'}.json`), JSON.stringify(result,null,2)+'\n');
  console.log(JSON.stringify(result));
} finally { await browser.close(); }
