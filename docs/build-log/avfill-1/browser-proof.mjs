import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { realpathSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { handleCustomSectionCaptureRequest } from '../../../mcp/src/clinical-graph/custom-section-endpoint.ts';
import { chromium } from '../../../ui/node_modules/playwright-core/index.mjs';
import { createServer } from '../../../ui/node_modules/vite/dist/node/index.js';
import { buildPosteriorOcularHealthDefinitions } from '../../../mcp/src/clinical-graph/ocular-health-definition.ts';
import { customFieldEntries } from '../../../mcp/src/clinical-graph/custom-fields.ts';

const root = resolve(import.meta.dirname, '../../..');
const seeds = buildPosteriorOcularHealthDefinitions({ source: 'manual', recordedAt: '2026-09-09T12:00:00Z', actorReference: 'Practitioner/synthetic' });
const definitions = seeds.map(d => ({
  stableKey: d.stableKey, sectionKey: d.sectionKey, display: d.display, active: d.active,
  perEye: true, customFields: customFieldEntries(d, true), normalTemplate: d.normalSemantics.template,
}));
const browser = await chromium.launch({ channel: 'chrome' });
try {
  for (const state of ['before', 'after']) {
    const source = state === 'before' ? process.env.AVFILL_BASE_ROOT : root;
    assert.ok(source, 'AVFILL_BASE_ROOT must name the separate base worktree');
    process.chdir(realpathSync(resolve(source, 'ui')));
    const server = await createServer({ root: realpathSync(resolve(source, 'ui')), logLevel: 'error', server: { host: '127.0.0.1', port: state === 'before' ? 15281 : 15282, strictPort: true } });
    await server.listen();
    const address = server.httpServer.address();
    assert.equal(address.address, '127.0.0.1');
    console.log(`${state}: owned Vite listener ${address.port}, source ${source}`);
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    page.setDefaultTimeout(15000);
    const posts = [];
    const writes = [];
    const fhir = {
      async search(_type, params) {
        return { resourceType: 'Bundle', type: 'searchset', entry: writes.filter(r => r.resourceType === _type &&
          r.identifier?.some(i => `${i.system}|${i.value}` === params.identifier)).map(resource => ({ resource })) };
      },
      async create(resource) {
        const saved = { ...resource, id: resource.id ?? randomUUID() };
        writes.push(saved);
        return saved;
      },
    };
    const deps = { authenticate: async () => ({ staffReference: 'Practitioner/synthetic', actorRole: 'provider', fhir }), findingDefinitions: () => seeds };
    const ratioComponents = () => writes.filter(r => r.resourceType === 'Observation').flatMap(o =>
      o.component.filter(c => c.code.coding?.some(v => /^(OD_|OS_)?CUSTOM_GRADE_A_V_RATIO$/.test(v.code))));
    try {
      await page.addInitScript(fixture => { window.__odosNegativeFixture = fixture; }, { definitions, patientReference: 'Patient/avfill-synthetic', encounterReference: 'Encounter/avfill-synthetic' });
      await page.route('**/clinical-graph/**', async route => {
        if (route.request().method() !== 'POST') { await route.fulfill({ json: { rows: [] } }); return; }
        const body = route.request().postDataJSON();
        posts.push(body);
        const stableKey = decodeURIComponent(new URL(route.request().url()).pathname.split('/').at(-1));
        const result = await handleCustomSectionCaptureRequest(deps, { authHeader: 'synthetic-harness', params: { stableKey }, body });
        assert.equal(result.status, 200, JSON.stringify(result.body));
        await route.fulfill({ status: result.status, json: result.body });
      });
      await page.goto(`http://127.0.0.1:${address.port}/tests/fixtures/entry-sheets.html?negativeAct=1`);
      const vessel = page.locator('#structure-ocular-health-posterior-vessels');
      const ratios = vessel.getByRole('combobox', { name: 'A/V ratio', exact: true });
      await ratios.first().waitFor();
      assert.equal(await ratios.count(), 2);
      assert.equal((await ratios.first().innerText()).trim(), state === 'before' ? '2:3' : 'Select');
      await ratios.first().click();
      assert.equal(await page.getByRole('option', { name: 'Select', exact: true }).count(), state === 'before' ? 0 : 1);
      await page.keyboard.press('Escape');
      await vessel.screenshot({ path: resolve(import.meta.dirname, `${state}.png`) });
      if (state === 'after') {
        await ratios.first().click();
        await page.getByRole('option', { name: '2:3', exact: true }).click();
        await ratios.first().click();
        await page.getByRole('option', { name: 'Select', exact: true }).click();
        await page.getByRole('button', { name: 'Save Ocular Health', exact: true }).click();
        await page.getByText('Capture at least one ocular-health structure before saving.', { exact: true }).waitFor();
        assert.equal(posts.length, 0);
        assert.equal(writes.length, 0);
        console.log('after: select 2:3 then Select then Save emits zero requests and zero Observations');
      }
      await page.getByRole('button', { name: 'Fundus All Normal', exact: true }).click();
      await page.getByRole('button', { name: 'Save Ocular Health', exact: true }).click();
      await page.getByText('5/5 ocular-health structures saved', { exact: true }).waitFor();
      assert.equal(posts.length, 5);
      const values = posts.flatMap(p => Object.values(p.eyes).flatMap(e => e.customFields.filter(f => f.code === 'CUSTOM_GRADE_A_V_RATIO')));
      assert.equal(values.length, state === 'before' ? 2 : 0);
      assert.equal(ratioComponents().length, state === 'before' ? 2 : 0);
      assert.equal(writes.filter(r => r.resourceType === 'Observation').length, 10);
      console.log(`${state}: five structures / ten eyes saved; A/V components in requests = ${values.length}; untouched control = ${state === 'before' ? '2:3' : 'Select'}`);
      if (state === 'after') {
        await ratios.first().click();
        await page.getByRole('option', { name: '2:3', exact: true }).click();
        await page.getByRole('button', { name: 'Save Ocular Health', exact: true }).click();
        await page.getByText('1/5 ocular-health structures saved', { exact: true }).waitFor();
        assert.equal(posts.length, 6);
        assert.deepEqual(posts[5].eyes.OD.customFields, [{ code: 'CUSTOM_GRADE_A_V_RATIO', value: '2-3' }]);
        assert.equal(posts[5].eyes.OS, undefined);
        assert.equal(ratioComponents().length, 1);
        assert.ok(ratioComponents()[0].valueCodeableConcept.coding.some(c => c.code === '2-3' && c.display === '2:3'));
        assert.ok(ratioComponents()[0].code.coding.some(c => c.code === 'OD_CUSTOM_GRADE_A_V_RATIO'));
        console.log('after: deliberate 2:3 emitted exactly one OD component with value 2-3; OS not rewritten');
      }
    } finally { await page.close(); await server.close(); }
  }
} finally { await browser.close(); }
console.log('PASS: real OcularHealthSection and production seed definitions in Chrome; real capture endpoint and Observation serialization with in-memory FHIR writes; not live persistence, AccessPolicy, or app-route proof');
