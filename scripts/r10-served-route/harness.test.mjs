import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { generateCaddyfile, assertCaddyParity } from './caddy.mjs';
import { startResponseProxy } from './response-proxy.mjs';

const original = readFileSync(new URL('../../deploy/frontdoor/Caddyfile', import.meta.url), 'utf8');
const ports = { frontdoor: 28090, medplum: 28103, proxy: 23335 };

test('W146 Caddy parity rejects any non-port edit and names its line', () => {
  const generated = generateCaddyfile(original, ports);
  assert.doesNotThrow(() => assertCaddyParity(original, generated, ports));
  assert.match(generated, /:28090 \{/);
  assert.match(generated, /reverse_proxy 127\.0\.0\.1:28103/);
  assert.match(generated, /reverse_proxy 127\.0\.0\.1:23335/);
  const mutated = generated.replace('handle /clinical-graph*', 'handle /wrong-path*');
  const expectedLine = generated.split('\n').findIndex(line => line.includes('handle /clinical-graph*')) + 1;
  assert.throws(() => assertCaddyParity(original, mutated, ports), new RegExp(`line ${expectedLine}`));
});

test('response proxy drops exactly one matching response after upstream completion', async () => {
  let completed = 0;
  const upstream = createServer((request, response) => { request.resume(); request.on('end', () => { completed++; response.end(JSON.stringify({ completed })); }); });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const proxy = await startResponseProxy({ upstream: `http://127.0.0.1:${upstream.address().port}`, port: 0, controlPort: 0 });
  try {
    const base = `http://127.0.0.1:${proxy.port}`;
    await fetch(`http://127.0.0.1:${proxy.controlPort}/drop-next`, { method: 'POST', body: JSON.stringify({ method: 'POST', path: '/carry' }) });
    assert.equal((await fetch(`${base}/other`)).status, 200);
    await assert.rejects(fetch(`${base}/carry`, { method: 'POST', body: '{}' }));
    assert.equal(completed, 2);
    assert.deepEqual(await (await fetch(`${base}/carry`, { method: 'POST', body: '{}' })).json(), { completed: 3 });
    assert.equal(proxy.events.filter(event => event.dropped).length, 1);
  } finally { await proxy.close(); await new Promise(resolve => upstream.close(resolve)); }
});

test('readiness child completes through a live parent HTTP server without blocking it', async () => {
  const { runReadinessChild } = await import('./readiness-child.mjs');
  let requests = 0;
  const server = createServer((_request, response) => { requests++; response.end('ready'); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const url = `http://127.0.0.1:${server.address().port}`;
    await runReadinessChild(process.execPath, ['--input-type=module', '-e', `const r = await fetch(${JSON.stringify(url)}, { signal: AbortSignal.timeout(1500) }); if (await r.text() !== 'ready') process.exit(1);`], { stdio: 'ignore' });
    assert.equal(requests, 1);
    await assert.rejects(runReadinessChild(process.execPath, ['-e', 'process.exit(7)'], { stdio: 'ignore' }), /Readiness child failed \(7\)/);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});
