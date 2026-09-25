import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createServer } from '../../../ui/node_modules/vite/dist/node/index.js';
import { chromium } from '../../../ui/node_modules/playwright-core/index.mjs';
import { buildAgeOfMajorityConfigResource } from '../../../mcp/src/clinic/age-of-majority-config.ts';

const runtime = process.env.W1_RUNTIME_DIR!;
const uiRoot = resolve('ui');
process.chdir(uiRoot);
const server = await createServer({ root: uiRoot, configFile: join(uiRoot, 'vite.config.ts'),
  server: { host: '127.0.0.1', port: 15173, strictPort: true, proxy: {
    '/fhir': { target: 'http://localhost:18103', changeOrigin: true },
    '/auth': { target: 'http://localhost:18103', changeOrigin: true },
    '/oauth2': { target: 'http://localhost:18103', changeOrigin: true },
    '/desk': { target: 'http://127.0.0.1:3334', changeOrigin: true },
  } } });
await server.listen();
const browser = await chromium.launch({ channel: 'chrome' });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 1 });
  await page.addInitScript(token => sessionStorage.setItem('odos.session.v1', JSON.stringify({ accessToken: token, expiresAt: Date.now() + 3600000 })), readFileSync(join(runtime, 'w1-provider-token'), 'utf8'));
  await page.route('**/fhir/R4/Basic?*', async route => {
    if (route.request().url().includes('age-of-majority')) {
      await route.fulfill({ json: { resourceType: 'Bundle', type: 'searchset', entry: [{ resource: buildAgeOfMajorityConfigResource({ ageOfMajorityYears: 18 }) }] } });
    } else await route.continue();
  });
  await page.route('**/communications/preferences/defaults', route => route.fulfill({ json: { version: 'synthetic', defaults: {} } }));
  let requests = 0;
  await page.route('**/clinic/patients', async route => {
    assert.equal(route.request().method(), 'POST');
    requests++;
    await route.fulfill({ status: 400, json: { error: 'A guarantor mailing address is required.' } });
  });
  await page.goto('http://127.0.0.1:15173/patient/new');
  await page.getByRole('heading', { name: 'New patient', exact: true }).waitFor();
  for (const [label, value] of Object.entries({ 'Legal first name': 'Synthetic', 'Legal last name': 'Adult', 'Date of birth': '1980-01-02', 'Phone 1': '864-555-0100' })) await (label.startsWith('Legal ') ? page.getByText(label, { exact: true }).locator('xpath=ancestor::div[contains(@class, "grid")][1]').locator('input') : label === 'Phone 1' ? page.getByRole('textbox', { name: label, exact: true }) : page.getByLabel(label, { exact: true })).fill(value);
  await page.getByText('Gender', { exact: true }).locator('xpath=ancestor::div[contains(@class, "grid")][1]').locator('select').selectOption('female');
  const button = page.getByRole('button', { name: 'Create patient', exact: true });
  await button.click();
  const bottomAlert = button.locator('..').getByRole('alert');
  await bottomAlert.waitFor();
  assert.equal(await bottomAlert.textContent(), 'A guarantor mailing address is required.');
  assert.equal(await button.evaluate(node => node.previousElementSibling?.getAttribute('role')), 'alert');
  assert.equal(requests, 1);
  await button.scrollIntoViewIfNeeded();
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: join(runtime, 'new-patient-error.png'), animations: 'disabled' });
  console.log('Browser G5: /patient/new, real NewPatient, injected 400, adjacent alert=1, registration POST=1');
} finally {
  await browser.close();
  await server.close();
}
