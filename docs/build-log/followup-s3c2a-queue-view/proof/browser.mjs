import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
const root = resolve('.'), runtime = join(root, '.odos/s3c2a-proof');
const read = name => JSON.parse(readFileSync(join(runtime, name), 'utf8'));
const { ports, project } = read('manifest.json'); assert.equal(project, 'odos-s3c2a-proof');
const credentials = read('credentials.json'), { patientId, visits } = read('queue-visits.json');
const base = `http://127.0.0.1:${ports.frontdoor}`;
const directory = 'docs/build-log/followup-s3c2a-queue-view', images = join(directory, 'screenshots');
mkdirSync(images, { recursive: true });
const { chromium } = createRequire(join(root, 'ui/package.json'))('playwright-core');
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const results = [];
try {
  for (const width of [1440, 390]) {
    const context = await browser.newContext({ viewport: { width, height: width === 390 ? 1100 : 1000 } });
    try {
      const page = await context.newPage(); page.setDefaultTimeout(30000);
      const errors = []; page.on('pageerror', error => errors.push(error.message));
      await page.goto(`${base}/clinic`);
      await page.getByPlaceholder('Email address').fill(credentials.provider.email);
      await page.getByPlaceholder('Password', { exact: true }).fill(credentials.provider.password);
      await page.getByRole('button', { name: 'Enter', exact: true }).click();
      try { await page.getByPlaceholder('Password', { exact: true }).waitFor({ state: 'detached' }); }
      catch { throw new Error('Synthetic login failed; credential-bearing diagnostics withheld.'); }
      for (const name of ['glaucoma', 'macula']) {
        let requests = 0;
        const count = request => { if (request.url().endsWith('/follow-up-queue')) requests++; };
        page.on('request', count);
        await page.goto(`${base}/clinic?patientId=${patientId}&encounterId=${visits[name]}`);
        await page.getByRole('button', { name: 'By structure', exact: true }).click();
        await page.waitForLoadState('networkidle');
        assert.equal(requests, 0, 'hidden mounted queue must not fetch');
        if (width === 390) {
          await page.getByRole('button', { name: /^Photos(?: · \d+)?$/ }).click();
        }
        await page.getByRole('tab', { name: 'Follow-up', exact: true }).click();
        const panel = page.getByRole('tabpanel', { name: 'Follow-up', exact: true });
        await panel.locator('.odos-follow-up-queue li').first().waitFor();
        await page.waitForLoadState('networkidle');
        assert.equal(requests, 1);
        const states = await panel.locator('.odos-follow-up-queue-state').allTextContents();
        assert.deepEqual(states, name === 'glaucoma' ? ['For review', 'For review', 'Already ordered'] : ['Unavailable', 'For review', 'Unavailable']);
        assert.equal(await panel.locator('.odos-follow-up-queue li button').count(), 0);
        assert.equal(await panel.getByRole('alert').count(), 0);
        await page.evaluate(() => document.fonts.ready);
        await page.screenshot({ path: join(images, `${width}-${name}.png`), animations: 'disabled', fullPage: true });
        await panel.getByRole('tab', { name: /^Photos/ }).click();
        await page.getByRole('tab', { name: 'Follow-up', exact: true }).click();
        await page.waitForLoadState('networkidle');
        assert.equal(requests, 2);
        page.off('request', count);
        results.push({ width, visit: name, states, hiddenRequests: 0, firstSelectionRequests: 1, afterReselectionRequests: 2, rowButtons: 0, tabAlerts: 0 });
      }
      assert.deepEqual(errors, []);
    } finally { await context.close(); }
  }
  writeFileSync(join(directory, 'browser-proof.json'), JSON.stringify({ syntheticOnly: true, results, pageErrors: [] }, null, 2)+'\n');
  console.log('Real Chrome proof: both visits at 1440 and 390; lazy/re-selection requests 0/1/2, zero row buttons, zero tab alerts.');
} finally { await browser.close(); }
