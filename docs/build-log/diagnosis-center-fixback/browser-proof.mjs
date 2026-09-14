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
page.setDefaultTimeout(10000);
const encounter = { resourceType: 'Encounter', id: 'e1', meta: { versionId: '1' }, status: 'in-progress', class: { code: 'AMB' }, subject: { reference: 'Patient/p1' }, diagnosis: [{ condition: { reference: 'Condition/a' }, rank: 1 }] };
const condition = { resourceType: 'Condition', id: 'a', subject: { reference: 'Patient/p1' }, encounter: { reference: 'Encounter/e1' }, code: { text: 'Synthetic refractive diagnosis' }, category: [{ coding: [{ system: 'http://terminology.hl7.org/CodeSystem/condition-category', code: 'encounter-diagnosis' }] }], verificationStatus: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/condition-ver-status', code: 'confirmed' }] } };
let status = 'new';
let newness = {conditionReference:'Condition/a', value:'new', source:'suggestion'};
let statusFailure = false;
const writes = [];
const errors = [];
page.on('pageerror', error => errors.push(error.stack));
await page.route('**/*', async route => {
  const request = route.request();
  const pathname = new URL(request.url()).pathname;
  const json = body => route.fulfill({ json: body });
  if (pathname === '/__dx-proof') return route.fulfill({ contentType: 'text/html', body: await server.transformIndexHtml('/__dx-proof', `<!doctype html><html><head><title>Diagnosis header — synthetic proof</title></head><body><div id="root"></div><script type="module">
import React from '/node_modules/.vite/deps/react.js';
import ReactDOM from '/node_modules/.vite/deps/react-dom_client.js';
import { EncounterCharting } from '/src/scenes/EncounterCharting.tsx';
import { RoleProvider } from '/src/lib/role-context.tsx';
import '/src/styles/globals.css';
ReactDOM.createRoot(document.getElementById('root')).render(React.createElement(RoleProvider, {initialRole: 'doctor'}, React.createElement(EncounterCharting, { patient: {resourceType:'Patient',id:'p1'}, encounterId:'e1' })));
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
  if (pathname.endsWith('/diagnosis-newness')) return json({rows:[newness]});
  if (pathname.endsWith('/diagnoses/a/newness')) { newness = {...newness,value:request.postDataJSON().value,source:'doctor'}; writes.push({method:request.method(),pathname,body:request.postDataJSON()}); return json({newness}); }
  if (pathname.endsWith('/diagnosis-statuses') && statusFailure) return route.fulfill({status:503,json:{error:'Synthetic status outage'}});
  if (pathname.endsWith('/diagnosis-statuses')) return json({ statuses: [{ conditionReference: 'Condition/a', status }] });
  if (pathname.endsWith('/diagnoses/a/status')) {
    status = request.postDataJSON().status;
    writes.push({ method: request.method(), pathname, body: request.postDataJSON() });
    return json({ status: { conditionReference: 'Condition/a', status } });
  }
  if (pathname.endsWith('/diagnosis-quick-list')) return json({ canWrite: true, diagnoses: [], catalog: [], pinnedDiagnosisKeys: [] });
  if (pathname.endsWith('/findings')) return json({ canWrite: true, findings: [], catalog: [], unassigned: [], bySection: {}, visitDiagnoses: [] });
  if (pathname.endsWith('/previous-exams')) return json({ pageSize: 4, encounters: [] });
  if (pathname.endsWith('/exam-overview')) return route.fulfill({status:503,json:{error:'No synthetic overview'}});
  if (pathname.endsWith('/procedure-charges')) return json({options:[],diagnoses:[],proposals:[],attachedProcedures:[]});
  if (pathname.endsWith('/visit-charge')) return json({options:[],diagnoses:[],proposal:{}});
  if (pathname.endsWith('/protocols/offers')) return json({protocols:[]});
  if (pathname.includes('/clinical-graph/')) return json({ canWrite:true, definitions:[], groups:[], visitTypeCategories:[], overrideGroupKeys:[], effectiveGroupKeys:[], rows:[], candidates: [], findings: [], encounters: [], attachedProcedures: [], charges: [], images: [] });
  if (pathname.startsWith('/communications/')) return json({optOuts:[]});
  if (pathname.includes('/fhir/R4/')) return json({ resourceType: 'Bundle', type: 'searchset', entry: [] });
  return route.continue();
});
try {
  await page.goto('http://127.0.0.1:19971/__dx-proof');
  await page.getByRole('button', {name:'By structure',exact:true}).click();
  await page.getByRole('navigation',{name:'Exam sections'}).getByRole('button',{name:/ASSESSMENT & PLAN/i}).click();
  await page.getByRole('navigation',{name:'Exam sections'}).getByRole('button').filter({hasText:/^Assessment$/}).click();
  await page.getByRole('button', {name:/Complete complexity and visit status in By diagnosis/}).click();
  assert.equal(await page.getByRole('button', {name:'By diagnosis',exact:true}).getAttribute('aria-pressed'), 'true');
  await page.getByRole('group', {name:'Diagnosis New or Established'}).getByRole('button',{name:'Established',exact:true}).click();
  await page.getByText("Doctor's choice", {exact:true}).waitFor();
  const picker = page.getByRole('combobox', { name: 'Diagnosis visit status', exact: true });
  await picker.waitFor();
  await picker.click();
  const labels = await page.getByRole('listbox').getByRole('option').allTextContents();
  assert.equal(labels.length, 9);
  assert.equal(labels.includes('New'), false);
  await page.screenshot({ path: `${output}visit-status-options.png` });
  await page.getByRole('option', { name: 'Well controlled', exact: true }).click();
  await page.getByRole('combobox', { name: 'Problem status', exact: true }).click();
  await page.getByRole('option', { name: 'Not addressed today / No MDM', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('[aria-label="Problem status"]')?.textContent?.includes('Not addressed today / No MDM'));
  await page.reload();
  await page.getByRole('button').filter({hasText:'Synthetic refractive diagnosis'}).first().click();
  await picker.waitFor();
  assert.match(await picker.textContent(), /Well controlled/);
  assert.match(await page.getByRole('combobox', { name: 'Problem status', exact: true }).textContent(), /Not addressed today \/ No MDM/);
  await page.screenshot({ path: `${output}saved-reloaded.png` });
  assert.equal(writes.length, 3);
  assert.equal(await page.getByRole('group',{name:'Diagnosis New or Established'}).getByRole('button',{name:'Established',exact:true}).getAttribute('aria-pressed'),'true');
  statusFailure=true;
  await page.reload();
  await page.getByRole('button').filter({hasText:'Synthetic refractive diagnosis'}).first().click();
  await page.getByTestId('diagnosis-status-error').waitFor();
  assert.equal(await picker.isDisabled(),true);
  assert.equal(await page.getByRole('combobox',{name:'Problem status',exact:true}).isDisabled(),false);
  await page.screenshot({path:`${output}status-degradation.png`});
  statusFailure=false; encounter.status='finished';
  await page.reload();
  await page.getByRole('button').filter({hasText:'Synthetic refractive diagnosis'}).first().click();
  await picker.waitFor();
  assert.equal(await picker.isDisabled(),true);
  for(const label of ['New','Established']) assert.equal(await page.getByRole('group',{name:'Diagnosis New or Established'}).getByRole('button',{name:label,exact:true}).isDisabled(),true);
  await page.screenshot({path:`${output}signed-locks.png`});
  assert.deepEqual(errors, []);

  await writeFile(`${output}browser-proof.json`, JSON.stringify({ scope: 'Real EncounterCharting parent in Chromium; Assessment pointer to DiagnosisWorkspace; synthetic intercepted HTTP; not authenticated app route or live Medplum', labels, writes, errors, reload: 'All three saved selections restored; signed controls locked; isolated status failure retained chart' }, null, 2) + '\n');
  console.log('PASS: actual parent Assessment pointer selects diagnosis; 9 status options without New; three controls save/reload; signed locks; isolated status failure; 0 browser errors');
} catch (error) {
  console.error(errors, await page.locator("body").innerText());
  throw error;
} finally {
  await browser.close();
  await server.close();
}
