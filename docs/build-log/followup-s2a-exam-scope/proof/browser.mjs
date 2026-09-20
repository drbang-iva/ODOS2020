import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
const root = resolve('.');
const require = createRequire(join(root, 'ui/package.json'));
const { chromium } = require('playwright-core');
const runtime = join(root, '.odos/s2a-proof');
const read = name => JSON.parse(readFileSync(join(runtime, name), 'utf8'));
const { ports } = read('manifest.json'), credentials = read('credentials.json'), fixture = read('fixture.json');
const base = `http://127.0.0.1:${ports.frontdoor}`;
const evidence = join(root, 'docs/build-log/followup-s2a-exam-scope');
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
const rows = () => page.locator('[data-testid="exam-overview-section"]').evaluateAll(nodes => nodes.map(n => n.getAttribute('data-section-key')));
async function open(key) {
  await page.goto(`${base}/clinic?patientId=${fixture.patientReference.slice(8)}&encounterId=${fixture[key].slice(10)}`);
  await page.getByRole('button', { name: 'By structure', exact: true }).click();
  await page.locator('[data-testid="exam-overview-section"]').first().waitFor();
  await page.waitForLoadState('networkidle');
}
try {
  await page.goto(base + '/clinic');
  await page.getByPlaceholder('Email address').fill(credentials.provider.email);
  await page.getByPlaceholder('Password', { exact: true }).fill(credentials.provider.password);
  await page.getByRole('button', { name: 'Enter', exact: true }).click();
  await page.getByPlaceholder('Password', { exact: true }).waitFor({ state: 'detached' });
  if (process.argv[2] === 'before') {
    for (const [key, name, expected] of [['current', '01-before-medical', ['contact-lenses']], ['prior', '02-before-exams', ['history','pretest','refraction','contact-lenses','ocular-health','assessment']]]) {
      await open(key);
      assert.deepEqual(await rows(), expected);
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.screenshot({ path: join(evidence, `${name}.png`) });
      console.log(`${name}: ${expected.join(', ')}`);
    }
  } else if (process.argv[2] === "after") {
    await open('current');
    assert.equal(await page.getByRole('combobox', { name: 'Exam scope', exact: true }).inputValue(), 'comprehensive');
    assert.equal((await rows()).length, 6);
    await page.evaluate(() => window.scrollTo(0, 0));
      await page.screenshot({ path: join(evidence, '03-after-medical-default.png') });
    for (const [value, name, expected] of [['office-visit', '04-office-visit', ['history','assessment']], ['comprehensive','05-comprehensive-restored',['history','pretest','refraction','contact-lenses','ocular-health','assessment']]]) {
      await page.getByRole('combobox', { name: 'Exam scope', exact: true }).selectOption(value);
      await page.waitForResponse(r => r.url().endsWith('/exam-overview') && r.status() === 200);
      await page.waitForLoadState('networkidle');
      assert.deepEqual(await rows(), expected);
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.screenshot({ path: join(evidence, `${name}.png`) });
      console.log(`${name}: ${expected.join(', ')}`);
    }
    } else {
    await open('current');
    async function api(path, method = 'GET', body) {
      return page.evaluate(async ({path, method, body}) => {
        const session = JSON.parse(sessionStorage.getItem('odos.session.v1'));
        const response = await fetch(path, {method, headers: {Authorization: `Bearer ${session.accessToken}`, 'Content-Type':'application/json'}, ...(body ? {body:JSON.stringify(body)} : {})});
        return {status: response.status, body: await response.json()};
      }, {path, method, body});
    }
    const scopeUrl = `/clinical-graph/encounters/${fixture.current.slice(10)}/exam-scope`;
    const overviewUrl = `/clinical-graph/encounters/${fixture.current.slice(10)}/exam-overview`;
    const billingUrl = `/clinical-graph/protocols/encounters/${fixture.current.slice(10)}/visit-charge`;
    const families = body => [...new Set(body.options.map(o => o.procedureConceptKey.startsWith('office-visit-') ? 'em' : o.procedureConceptKey.startsWith('routine-vision-exam-') ? 'vision-plan' : 'eye-code'))].sort();
    const billing = await api(billingUrl);
    assert.equal(billing.status, 200);
    assert.deepEqual(families(billing.body), ['em','eye-code','vision-plan']);
    const pick = billing.body.options.find(o => o.procedureConceptKey.startsWith('office-visit-'));
    assert.ok(pick);
    assert.equal((await api(billingUrl, 'POST', {procedureConceptKey:pick.procedureConceptKey})).status, 200);
    const picked = (await api(billingUrl)).body;
    await open('current');
    async function change(value) {
      if (await page.getByRole('combobox', {name:'Exam scope',exact:true}).inputValue() === value) return;
      await Promise.all([page.waitForResponse(r => r.url().endsWith('/exam-overview') && r.status() === 200), page.getByRole('combobox', { name:'Exam scope', exact:true }).selectOption(value)]);
      await page.waitForLoadState('networkidle');
    }
    await change('office-visit');
    assert.deepEqual((await api(billingUrl)).body, picked);
    const existingIop = page.locator('[data-testid="exam-finding-row"]').filter({hasText:/Intraocular pressure/i});
    if (await existingIop.count()) {
      await existingIop.first().click();
    } else {
      if (!await page.locator('[data-editor-section-id="iop"]').isVisible()) await page.locator('details').filter({has:page.locator('summary').filter({hasText:'Pretest'})}).locator('summary').click();
      await page.locator('[data-editor-section-id="iop"]').click();
    }
    await page.getByRole('combobox', {name:'OD IOP value',exact:true}).fill('18');
    await page.getByRole('combobox', {name:'OD IOP value',exact:true}).press('Tab');
    await Promise.all([page.waitForResponse(r=>r.url().endsWith('/iop') && r.request().method()==='POST'), page.getByRole('button',{name:'Save IOP',exact:true}).click()]);
    if (await page.getByRole('button',{name:'Back to exam overview',exact:true}).isVisible()) await page.getByRole('button',{name:'Back to exam overview',exact:true}).click();
    await page.locator('[data-testid="exam-finding-row"]').first().waitFor();
    const saved = (await api(overviewUrl)).body.findings;
    assert.ok(saved.some(f => f.current.value?.value === 18));
    await page.evaluate(() => window.scrollTo(0, 0));
      await page.screenshot({path:join(evidence,'06-office-finding.png')});
    for (const value of ['comprehensive','office-visit']) {
      await change(value);
      assert.deepEqual((await api(overviewUrl)).body.findings, saved);
      assert.deepEqual((await api(billingUrl)).body, picked);
      assert.ok((await rows()).includes('pretest'));
      assert.ok((await page.locator('[data-testid="exam-finding-row"]').allTextContents()).join(' ').includes('18'));
    }
    await page.getByTestId('exam-completeness-trigger').click();
    await page.getByText("This count is relative to this exam's scope and is not a billing-code check.", {exact:true}).waitFor();
    await page.evaluate(() => window.scrollTo(0, 0));
      await page.screenshot({path:join(evidence,'07-retained-and-scope-trace.png')});
    await page.getByTestId('exam-completeness-trigger').click();
    await page.getByTestId('visit-chip').click();
    const selector = page.getByRole('combobox',{name:'Visit billing code',exact:true});
    await selector.waitFor();
    const optionKeys = await selector.locator('option').evaluateAll(nodes=>nodes.map(n=>n.value));
    for(const option of picked.options) assert.ok(optionKeys.includes(option.procedureConceptKey));
    assert.equal(await selector.inputValue(),pick.procedureConceptKey);
    await page.evaluate(() => window.scrollTo(0, 0));
      await page.screenshot({path:join(evidence,'08-billing-unchanged.png')});
    const eye = picked.options.find(o=>o.procedureConceptKey.startsWith('comprehensive-exam-'));
    const scopeBefore = (await api(scopeUrl)).body;
    await Promise.all([page.waitForResponse(r=>r.url().endsWith('/visit-charge') && r.request().method()==='POST'), selector.selectOption(eye.procedureConceptKey)]);
    assert.deepEqual((await api(scopeUrl)).body,scopeBefore);
    assert.deepEqual((await api(overviewUrl)).body.findings,saved);
    assert.equal((await api(scopeUrl, 'PUT', {examScope:'office-visit',expectedVersion:'stale'})).status, 409);
    assert.equal((await api(scopeUrl, 'PUT', {examScope:'invalid',expectedVersion:scopeBefore.versionId})).status, 400);
    assert.deepEqual((await api(scopeUrl)).body,scopeBefore);
    const unauthenticated = await page.evaluate(async path => (await fetch(path)).status, scopeUrl);
    assert.equal(unauthenticated, 401);
    console.log('Live refusal checks: stale version 409; invalid scope 400; absent credentials 401; stored scope unchanged.');
    console.log('Proof 4–5: saved OD IOP 18 on Office visit; both scope switches retain identical findings and visit charge; all three code families available; changing billing code leaves scope unchanged.');
  }
} finally { await browser.close(); }
