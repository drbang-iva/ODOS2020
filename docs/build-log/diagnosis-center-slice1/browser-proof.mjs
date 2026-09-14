import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createServer } from '../../../ui/node_modules/vite/dist/node/index.js';
import { chromium } from '../../../ui/node_modules/playwright-core/index.mjs';

const root = fileURLToPath(new URL('../../../ui/', import.meta.url));
const output = fileURLToPath(new URL('./', import.meta.url));
process.chdir(root);
const server = await createServer({ root, logLevel: 'error', server: { host: '127.0.0.1', port: 19971, strictPort: true } });
await server.listen();
const browser = await chromium.launch({ executablePath: process.env.ODOS_CHROME_BIN ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
const encounter = { resourceType: 'Encounter', id: 'e1', meta: { versionId: '1' }, status: 'in-progress', class: { code: 'AMB' }, subject: { reference: 'Patient/p1' }, diagnosis: [{ condition: { reference: 'Condition/a' }, rank: 1 }] };
const condition = { resourceType: 'Condition', id: 'a', subject: { reference: 'Patient/p1' }, encounter: { reference: 'Encounter/e1' }, code: { text: 'Synthetic refractive diagnosis' }, category: [{ coding: [{ system: 'http://terminology.hl7.org/CodeSystem/condition-category', code: 'encounter-diagnosis' }] }], verificationStatus: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/condition-ver-status', code: 'confirmed' }] } };
let status = 'new';
const writes = [];
const errors = [];
page.on('pageerror', error => errors.push(error.message));
await page.route('**/*', async route => {
  const request = route.request();
  const pathname = new URL(request.url()).pathname;
  const json = body => route.fulfill({ json: body });
  if (pathname === '/__dx-proof') return route.fulfill({ contentType: 'text/html', body: await server.transformIndexHtml('/__dx-proof', `<!doctype html><html><head><title>Diagnosis header — synthetic proof</title></head><body><div id="root"></div><script type="module">
import React from '/node_modules/.vite/deps/react.js';
import ReactDOM from '/node_modules/.vite/deps/react-dom_client.js';
import { DiagnosisWorkspace } from '/src/components/charting/DiagnosisWorkspace.tsx';
import '/src/styles/globals.css';
ReactDOM.createRoot(document.getElementById('root')).render(React.createElement(DiagnosisWorkspace, { patientReference: 'Patient/p1', encounterReference: 'Encounter/e1', selectedReference: 'Condition/a', onSelectDiagnosis: () => {} }));
</script></body></html>`) });
  if (pathname === '/fhir/R4/Encounter/e1') {
    if (request.method() === 'PATCH') {
      const patch = request.postDataJSON();
      assert.equal(patch[0].path, '/diagnosis/0/extension');
      encounter.diagnosis[0].extension = patch[0].value;
      encounter.meta.versionId = '2';
      writes.push({ method: 'PATCH', pathname, body: patch });
    }
    return json(encounter);
  }
  if (pathname === '/fhir/R4/Condition') return json({ resourceType: 'Bundle', type: 'searchset', entry: [{ resource: condition }] });
  if (pathname === '/fhir/R4/Provenance') return json({ ...request.postDataJSON(), id: 'synthetic-provenance' });
  if (pathname.endsWith('/diagnosis-statuses')) return json({ statuses: [{ conditionReference: 'Condition/a', status }] });
  if (pathname.endsWith('/diagnoses/a/status')) {
    status = request.postDataJSON().status;
    writes.push({ method: request.method(), pathname, body: request.postDataJSON() });
    return json({ status: { conditionReference: 'Condition/a', status } });
  }
  if (pathname.endsWith('/diagnosis-quick-list')) return json({ canWrite: true, diagnoses: [], catalog: [], pinnedDiagnosisKeys: [] });
  if (pathname.endsWith('/findings')) return json({ canWrite: true, findings: [], catalog: [], unassigned: [], bySection: {}, visitDiagnoses: [] });
  if (pathname.endsWith('/previous-exams')) return json({ pageSize: 4, encounters: [] });
  if (pathname.includes('/clinical-graph/')) return json({ candidates: [], findings: [], encounters: [], attachedProcedures: [], charges: [], images: [] });
  if (pathname.includes('/fhir/R4/')) return json({ resourceType: 'Bundle', type: 'searchset', entry: [] });
  return route.continue();
});
try {
  await page.goto('http://127.0.0.1:19971/__dx-proof');
  const picker = page.getByRole('combobox', { name: 'Diagnosis visit status', exact: true });
  await picker.waitFor();
  await picker.click();
  const labels = await page.getByRole('option').allTextContents();
  assert.equal(labels.length, 9);
  assert.equal(labels.includes('New'), false);
  await page.screenshot({ path: `${output}visit-status-options.png` });
  await page.getByRole('option', { name: 'Well controlled', exact: true }).click();
  await page.getByRole('combobox', { name: 'Problem status', exact: true }).click();
  await page.getByRole('option', { name: 'Not addressed today / No MDM', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('[aria-label="Problem status"]')?.textContent?.includes('Not addressed today / No MDM'));
  await page.reload();
  await picker.waitFor();
  assert.match(await picker.textContent(), /Well controlled/);
  assert.match(await page.getByRole('combobox', { name: 'Problem status', exact: true }).textContent(), /Not addressed today \/ No MDM/);
  await page.screenshot({ path: `${output}saved-reloaded.png` });
  assert.equal(writes.length, 2);
  assert.deepEqual(errors, []);
  assert.equal(await page.getByRole("alert").count(), 0);
  await writeFile(`${output}browser-proof.json`, JSON.stringify({ scope: 'Real DiagnosisWorkspace in Chromium; synthetic intercepted HTTP; not the app route or live Medplum', labels, writes, errors, reload: 'Both saved selections restored' }, null, 2) + '\n');
  console.log('PASS: 9 options; no New; visit-status PUT; Encounter complexity PATCH; both survive reload; 0 browser errors');
} catch (error) {
  console.error(errors, await page.locator("body").innerText());
  throw error;
} finally {
  await browser.close();
  await server.close();
}
