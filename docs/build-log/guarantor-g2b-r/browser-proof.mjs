import assert from 'node:assert/strict';
import { createWriteStream, readFileSync, writeFileSync, unlinkSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';
import { gunzipSync } from 'node:zlib';
import { chromium } from '../../../ui/node_modules/playwright-core/index.mjs';
import { SESSION_STORAGE_KEY } from '../../../ui/src/lib/fhir.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const base = resolve(process.env.G2BR_BASE_ROOT);
assert.notEqual(root, base);
const output = resolve(root, 'docs/build-log/guarantor-g2b-r');
const privateDirectory = resolve(root, '.odos/g2br-live');
const fixture = JSON.parse(readFileSync(resolve(privateDirectory, 'fixture-private.json'), 'utf8'));
const beforePath = resolve(output, 'live-before.json');
const x2 = JSON.parse(existsSync(beforePath) ? readFileSync(beforePath, 'utf8') : gunzipSync(readFileSync(beforePath + '.gz')).toString()).cases.find(c => c.scenario === 'X2');
assert.equal(x2.final.tasks[0].status, 'completed');
assert.equal(x2.final.tasks[1].status, 'in-progress');
const children = [], temporaryFiles = [];
const checks = [];
let browser;
async function free(port) {
  await new Promise((done, fail) => { const socket = createServer(); socket.once('error', fail); socket.listen(port, '127.0.0.1', () => socket.close(done)); });
}
async function start(program, args, cwd, env, name, url) {
  const log = createWriteStream(resolve(privateDirectory, `${name}.log`));
  await new Promise((done, fail) => { log.once('open', done); log.once('error', fail); });
  const child = spawn(program, args, { cwd, env: { ...process.env, ...env }, stdio: ['ignore', log, log] });
  child.once('exit', () => log.end());
  children.push(child);
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    assert.equal(child.exitCode, null, `${name} exited during startup`);
    try { await fetch(url); return; } catch {}
    await new Promise(done => setTimeout(done, 200));
  }
  throw new Error(`${name} did not listen`);
}
try {
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  for (const [variant, source, uiPort, apiPort] of [['before', base, 29086, 29085], ['after', root, 29084, 29083]]) {
    await free(uiPort); await free(apiPort);
    const html = resolve(source, 'ui/tests/fixtures/g2br-history.html');
    const tsx = resolve(source, 'ui/tests/fixtures/g2br-history.tsx');
    assert.equal(existsSync(html) || existsSync(tsx), false, 'never overwrite another fixture');
    temporaryFiles.push(html, tsx);
    writeFileSync(html, '<!doctype html><html><head><title>Guarantor recovery history</title></head><body style="color:#e2e8f0"><div id="root"></div><script type="module" src="./g2br-history.tsx"></script></body></html>');
    writeFileSync(tsx, `import React from 'react';\nimport {createRoot} from 'react-dom/client';\nimport {GuarantorLinkScreens} from '../../src/components/patient/GuarantorLinkScreens';\nimport {fhir} from '../../src/lib/fhir';\nimport '../../src/styles/globals.css';\nfhir.rehydrateSession();\ncreateRoot(document.getElementById('root')!).render(<main className="mx-auto max-w-4xl p-8"><h1 className="mb-3 text-2xl">Guarantor changes</h1><p className="mb-6">Synthetic patient: an Undo is pending and a later move is complete.</p><GuarantorLinkScreens person={${JSON.stringify(x2.afterCompetitor.destination)}} relatedPersonId=${JSON.stringify(x2.family.child.id)} disabled={false} onReload={async()=>{}}/></main>);\n`);
    await start(process.execPath, ['--import', 'tsx', resolve(output, 'live-proof.mjs'), 'serve', variant], root, { G2BR_PROOF_SOURCE: source }, `history-${variant}-api`, `http://127.0.0.1:${apiPort}/guarantors/link-operations`);
    await start(resolve(source, 'ui/node_modules/.bin/vite'), ['--host', '127.0.0.1', '--port', String(uiPort), '--strictPort'], resolve(source, 'ui'), { ODOS_MCP_PROXY_TARGET: `http://127.0.0.1:${apiPort}` }, `history-${variant}-ui`, `http://127.0.0.1:${uiPort}/tests/fixtures/g2br-history.html`);
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 });
    await context.addInitScript(({ key, session }) => sessionStorage.setItem(key, session), { key: SESSION_STORAGE_KEY, session: JSON.stringify({ accessToken: fixture.principals.staff.token, expiresAt: Date.now() + 3_600_000 }) });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${uiPort}/tests/fixtures/g2br-history.html`, { waitUntil: 'networkidle' });
    const historyResponse = page.waitForResponse(response => response.url().includes('/guarantors/link-operations?relatedPersonId='));
    await page.getByRole('button', { name: 'Guarantor changes', exact: true }).click();
    const response = await historyResponse;
    assert.equal(response.status(), 200);
    const history = await response.json();
    await page.getByText(/correct ·/).waitFor();
    const original = history.find(op => op.task.id === x2.original.body.task.id);
    assert.equal(original.task.status, 'completed');
    assert.equal(history.find(op => op.task.id === x2.correction.body.task.id).task.status, 'in-progress');
    const originalUndoReasons = await page.getByText(`Reason to undo ${original.task.id}`, { exact: true }).count();
    const undoButtons = await page.getByRole('button', { name: 'Undo', exact: true }).count();
    const completeButtons = await page.getByRole('button', { name: 'Complete', exact: true }).count();
    assert.equal(originalUndoReasons, 0);
    assert.equal(undoButtons, 1);
    assert.equal(completeButtons, variant === 'before' ? 0 : 1);
    assert.deepEqual(errors, []);
    await page.evaluate(() => document.fonts.ready);
    await page.screenshot({ path: resolve(output, `history-${variant}.png`), animations: 'disabled' });
    checks.push({ variant, sourceHead: variant === 'before' ? '60323dacf0b555a0f1722053f6e92b9cf846e68a' : 'working tree', originalStatus: original.task.status, correctionInProgress: original.correctionInProgress, originalUndoReasons, undoButtons, completeButtons, consoleErrors: errors, history });
    await context.close();
  }
  writeFileSync(resolve(output, 'browser-proof.json'), JSON.stringify({ scope: 'Actual GuarantorLinkScreens component and history route at pre-fixback head 60323dac versus the fixback working tree, same persisted synthetic X2 state and staff token; no mocked API responses', checks }, null, 2) + '\n');
  console.log(JSON.stringify(checks.map(({ history, ...check }) => check)));
} finally {
  await browser?.close();
  for (const child of children.reverse()) {
    if (child.exitCode === null) {
      child.kill('SIGTERM');
      await new Promise(done => child.once('exit', done));
    }
  }
  for (const file of temporaryFiles) unlinkSync(file);
}
