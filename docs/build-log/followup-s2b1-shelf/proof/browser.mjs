import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync, mkdirSync, openSync } from 'node:fs';
import { spawn, execFileSync } from 'node:child_process';
import { resolve, join } from 'node:path';
import { generateCaddyfile, assertCaddyParity } from '../../../../scripts/r10-served-route/caddy.mjs';

const root = resolve('.'), runtime = join(root, '.odos/s2b1-proof');
const read = name => JSON.parse(readFileSync(join(runtime, name), 'utf8'));
const { ports } = read('manifest.json'), credentials = read('credentials.json'), fixture = read('fixture.json');
const beforeRoot = resolve(process.argv[2]);
assert.equal(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: beforeRoot, encoding: 'utf8' }).trim(), 'f2ef2c325e36d756759a525339431d70c7bcfde1');
assert.equal(execFileSync('git', ['diff', '--stat'], { cwd: beforeRoot, encoding: 'utf8' }).trim(), '');
const beforePorts = { ...ports, frontdoor: 31092 };
const source = readFileSync(join(beforeRoot, 'deploy/frontdoor/Caddyfile'), 'utf8');
const config = generateCaddyfile(source, beforePorts); assertCaddyParity(source, config, beforePorts);
const configPath = join(runtime, 'before.Caddyfile'); writeFileSync(configPath, config);
const log = openSync(join(runtime, 'before-caddy.log'), 'a', 0o600);
const caddy = spawn('caddy', ['run', '--config', configPath, '--adapter', 'caddyfile'], { env: { ...process.env, ODOS_UI_DIST: join(beforeRoot, 'ui/dist') }, stdio: ['ignore', log, log] });
const { chromium } = createRequire(join(root, 'ui/package.json'))('playwright-core');
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const evidence = join(root, 'docs/build-log/followup-s2b1-shelf/screenshots'); mkdirSync(evidence, { recursive: true });
const results = [];
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
try {
  for (const port of [ports.frontdoor, beforePorts.frontdoor]) {
    let ready = false;
    for (let i = 0; i < 120; i++) {
      try { if ((await fetch(`http://127.0.0.1:${port}`)).ok) { ready = true; break; } } catch {}
      await wait(250);
    }
    assert.ok(ready, `Front door ${port} must be ready`);
  }
  for (const width of (process.argv.includes('--clearance-only') ? [390] : [1440, 390])) {
    for (const state of (process.argv.includes('--clearance-only') ? ['after'] : ['before', 'after'])) {
      const base = `http://127.0.0.1:${state === 'before' ? beforePorts.frontdoor : ports.frontdoor}`;
      const context = await browser.newContext({ viewport: { width, height: width === 1440 ? 1100 : 1300 } });
      const page = await context.newPage();
      page.setDefaultTimeout(20000);
      const writes = [];
      page.on('request', request => { if (['POST','PUT','PATCH','DELETE'].includes(request.method()) && new URL(request.url()).pathname.startsWith('/clinical-graph/')) writes.push({ method: request.method(), path: new URL(request.url()).pathname, body: request.postDataJSON() }); });
      async function open(key) {
        await page.goto(`${base}/clinic?patientId=${fixture.patientReference.slice(8)}&encounterId=${fixture[key].slice(10)}`);
        await page.getByRole('button', { name: 'By structure', exact: true }).click();
        await page.getByTestId('exam-overview-section').first().waitFor();
        await page.waitForLoadState('networkidle');
      }
      async function capture(name, locator) {
        await page.waitForLoadState('networkidle');
        if (locator) await locator.evaluate(node => node.scrollIntoView({ behavior: 'instant', block: 'center' }));
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        await page.mouse.move(0, 0);
        await page.evaluate(() => window.scrollTo({ left: 0, top: window.scrollY }));
        await page.evaluate(() => document.fonts.ready);
        await page.screenshot({ path: join(evidence, `${width}-${state}-${name}.png`), animations: 'disabled' });
      }
      async function api(path, method = 'GET', body) {
        return page.evaluate(async ({ path, method, body }) => {
          const session = JSON.parse(sessionStorage.getItem('odos.session.v1'));
          const response = await fetch(path, { method, headers: { Authorization: `Bearer ${session.accessToken}`, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
          return { status: response.status, body: await response.json() };
        }, { path, method, body });
      }
      try {
        await page.goto(base + '/clinic');
        await page.getByPlaceholder('Email address').fill(credentials.provider.email);
        await page.getByPlaceholder('Password', { exact: true }).fill(credentials.provider.password);
        await page.getByRole('button', { name: 'Enter', exact: true }).click();
        await page.getByPlaceholder('Password', { exact: true }).waitFor({ state: 'detached' });
        await open('shelfComprehensive');
        if (state === 'after') {
          const shelf = page.getByTestId('exam-shelf');
          assert.equal(await shelf.count(), 1);
          assert.equal(await page.getByTestId('chart-another-finding').count(), 0);
          assert.deepEqual(await shelf.locator('h3').allTextContents(), ['Tests & imaging','Pretest','Refraction','Contact Lenses','Ocular Health','Section groups']);
          await capture('comprehensive', shelf);
          const lastEntry = shelf.getByTestId('exam-shelf-section-group');
          await lastEntry.scrollIntoViewIfNeeded();
          const entryBox = await lastEntry.boundingBox(), stampBox = await page.locator('#odos-build-stamp').boundingBox();
          assert.ok(entryBox && stampBox);
          if (width === 390) {
            console.log(`Shelf clearance: entry bottom ${entryBox.y + entryBox.height}; stamp top ${stampBox.y}`);
            assert.ok(entryBox.y + entryBox.height <= stampBox.y, 'The shelf last entry must clear the build stamp');
          }
          await shelf.screenshot({ path: join(evidence, `${width}-after-complete-shelf.png`) });
          if (process.argv.includes('--clearance-only')) continue;
        } else {
          assert.ok(await page.getByTestId('chart-another-finding').count() > 0);
          await capture('comprehensive', page.getByTestId('chart-another-finding').last());
        }
        await open('shelfData');
        const overview = await api(`/clinical-graph/encounters/${fixture.shelfData.slice(10)}/exam-overview`);
        assert.equal(overview.status, 200);
        assert.ok(overview.body.findings.some(f => f.provenance.state === 'carried-reasserted'));
        assert.ok(overview.body.findings.some(f => f.provenance.state === 'carried-unreasserted'));
        if (state === 'before') {
          assert.equal(await page.getByTestId('exam-finding-row').count(), 0);
          await capture('recorded-data', page.getByRole('heading', { name: 'Exam overview', exact: true }));
        } else {
          const other = page.getByTestId('exam-other-findings');
          assert.match(await other.innerText(), /Synthetic unmatched finding[\s\S]*Visible synthetic detail[\s\S]*OD[\s\S]*2026-09-19/);
          const line = page.locator('[data-drawn-editor-id="iop"]');
          assert.match(await line.innerText(), /same as 2026-09-01 · confirmed today/);
          assert.match(await line.innerText(), /carried, not reasserted/);
          const carried = page.locator('[data-provenance-state="carried-unreasserted"]');
          const colors = await carried.evaluate(node => {
            const probe = document.createElement('span'); probe.style.color = 'var(--odos-amber)'; node.append(probe);
            const colors = { color: getComputedStyle(node).color, amber: getComputedStyle(probe).color }; probe.remove(); return colors;
          });
          assert.equal(colors.color, colors.amber);
          await capture('recorded-data', line);
          await capture('other-findings', other);
          await other.screenshot({ path: join(evidence, `${width}-after-other-findings-detail.png`) });
          await page.getByTestId('exam-completeness-trigger').click();
          assert.match(await page.locator('body').innerText(), /1 carried, not reasserted/);
          await capture('carried-count', page.getByTestId('exam-completeness-trigger'));
          await page.getByTestId('exam-completeness-trigger').click();
          results.push({ width, proof: 'recorded data', findingCount: overview.body.findings.length, carriedStates: overview.body.findings.map(f => f.provenance.state), colors });
        }
        if (state === 'before') continue;
        await open('shelfOffice');
        assert.equal(await page.getByRole('combobox', { name: 'Exam scope', exact: true }).inputValue(), 'office-visit');
        const encounterPath = `/fhir/R4/${fixture.shelfOffice}`;
        const encounterBefore = await api(encounterPath);
        const startWrites = writes.length;
        const macula = page.getByTestId('exam-shelf').locator('[data-editor-section-id="ocular-health:posterior:macula"]');
        await capture('office-shelf', macula);
        await macula.click();
        await page.getByTestId('return-to-exam-overview').waitFor();
        await page.waitForLoadState('networkidle');
        const maculaEditor = page.locator('#structure-ocular-health-posterior-macula');
        await maculaEditor.waitFor();
        assert.equal(await maculaEditor.getByRole('heading', { name: 'Macula', exact: true }).count(), 1);
        assert.equal(await maculaEditor.getAttribute('data-structure-focused'), 'true');
        await maculaEditor.evaluate(element => {
          element.scrollIntoView({ behavior: 'instant', block: 'start' });
          for (let parent = element.parentElement; parent; parent = parent.parentElement) {
            if (parent.scrollHeight > parent.clientHeight && /auto|scroll/.test(getComputedStyle(parent).overflowY)) { parent.scrollTop -= 280; break; }
          }
        });
        await capture('macula-editor');
        await page.getByTestId('return-to-exam-overview').click();
        const keys = await page.getByTestId('exam-overview-section').evaluateAll(nodes => nodes.map(n => n.getAttribute('data-section-key')));
        assert.deepEqual(keys, ['history','ocular-health','assessment']);
        assert.equal(await page.locator('[data-drawn-editor-id="ocular-health:posterior:macula"]').count(), 1);
        assert.equal(await page.getByRole('combobox', { name: 'Exam scope', exact: true }).inputValue(), 'office-visit');
        const encounterAfter = await api(encounterPath);
        assert.equal(encounterBefore.status, 200); assert.equal(encounterAfter.status, 200);
        assert.deepEqual(encounterAfter.body.type, encounterBefore.body.type); assert.deepEqual(encounterAfter.body.diagnosis, encounterBefore.body.diagnosis);
        assert.deepEqual(writes.slice(startWrites).filter(r => !(r.path.endsWith('/void') && r.body?.preview)), []);
        await capture('macula-drawn', page.locator('[data-section-key="ocular-health"]'));
        await open(`shelfDry${width}`);
        const group = page.getByTestId('exam-shelf-section-group').filter({ hasText: 'Dry Eye Workup' });
        await group.click();
        await page.locator('[data-drawn-editor-id="dry-eye:symptoms"]').waitFor();
        assert.equal(await page.getByTestId('return-to-exam-overview').count(), 0);
        assert.equal(await group.count(), 0);
        await capture('dry-eye-pulled-in', page.locator('[data-drawn-editor-id="dry-eye:symptoms"]'));
        await page.locator('[data-editor-section-id="dry-eye:symptoms"]').click();
        await page.getByRole('textbox', { name: 'Other / notes' }).fill('Synthetic shelf proof symptoms');
        await page.getByRole('button', { name: /^Save / }).last().click();
        await page.getByText('Synthetic shelf proof symptoms', { exact: true }).last().waitFor();
        await page.getByTestId('return-to-exam-overview').click();
        await page.getByText('Dry Eye Workup · Has findings this visit', { exact: true }).waitFor();
        const refusal = await api(`/clinical-graph/encounters/${fixture[`shelfDry${width}`].slice(10)}/section-groups`, 'POST', { action: 'remove', groupKey: 'dry-eye-workup' });
        assert.equal(refusal.status, 409); assert.equal(refusal.body.code, 'section-group-has-content');
        await capture('dry-eye-pinned', page.getByText('Dry Eye Workup · Has findings this visit', { exact: true }));
        results.push({ width, proof: 'shelf interactions', rowsAfterMacula: keys, unchangedTypeAndDiagnoses: true, scope: 'office-visit', groupRemoval: refusal });
      } finally { await context.close(); }
      console.log(`${width} ${state}: browser proof passed`);
    }
  }
  if (!process.argv.includes('--clearance-only')) writeFileSync(join(root, 'docs/build-log/followup-s2b1-shelf/browser-proof.json'), JSON.stringify(results, null, 2) + '\n');
} finally { await browser.close(); caddy.kill('SIGTERM'); }
