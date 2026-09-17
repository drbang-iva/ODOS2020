import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { createServer, request } from 'node:http';
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


test('W146 response proxy rejects URL authority escapes and preserves origin-form query paths', async () => {
  const upstreamTargets = [], escapedTargets = [];
  const upstream = createServer((incoming, response) => { upstreamTargets.push(incoming.url); incoming.resume(); incoming.on('end', () => response.end('upstream')); });
  const spy = createServer((incoming, response) => { escapedTargets.push(incoming.url); incoming.resume(); incoming.on('end', () => response.end('escaped')); });
  await Promise.all([upstream, spy].map(server => new Promise(resolve => server.listen(0, '127.0.0.1', resolve))));
  const proxy = await startResponseProxy({ upstream: `http://127.0.0.1:${upstream.address().port}`, port: 0, controlPort: 0 });
  const raw = target => new Promise((resolve, reject) => {
    const outgoing = request({ hostname: '127.0.0.1', port: proxy.port, method: 'GET', path: target }, response => { response.resume(); response.on('end', () => resolve(response.statusCode)); });
    outgoing.on('error', reject); outgoing.end();
  });
  try {
    const authority = `127.0.0.1:${spy.address().port}`;
    const targets = [`http://${authority}/absolute`, `//${authority}/authority`, `/\\${authority}/backslash`, `\\\\${authority}/backslash-authority`, `${authority}/authority-form`, '*'];
    const statuses = [];
    for (const target of targets) statuses.push(await raw(target));
    assert.deepEqual(escapedTargets, [], 'No request may escape to the second local server');
    assert.deepEqual(upstreamTargets, [], 'Rejected targets must not reach the configured upstream');
    assert.deepEqual(statuses, targets.map(() => 400));
    const originForm = '/clinical-graph/example?next=http%3A%2F%2Flocalhost%2Fpath&eye=OD&eye=OS';
    assert.equal(await raw(originForm), 200);
    assert.deepEqual(upstreamTargets, [originForm]);
    assert.deepEqual(escapedTargets, []);
  } finally {
    await proxy.close();
    await Promise.all([upstream, spy].map(server => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); })));
  }
});

for (const method of ['GET', 'POST']) test(`W146 ${method} MCP SSE delivers events before upstream completion`, async () => {
  const upstream = createServer((incoming, response) => {
    incoming.resume();
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    response.write('event: message\ndata: first\n\n');
    const timer = setTimeout(() => response.write('event: message\ndata: second\n\n'), 30);
    response.on('close', () => clearTimeout(timer));
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const proxy = await startResponseProxy({ upstream: `http://127.0.0.1:${upstream.address().port}`, port: 0, controlPort: 0 });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 1500);
  try {
    const response = await fetch(`http://127.0.0.1:${proxy.port}/mcp`, {method, signal:controller.signal});
    assert.equal(response.headers.get('content-type'), 'text/event-stream');
    const reader = response.body.getReader();
    let received = '';
    while (!received.includes('data: second')) {
      const chunk = await reader.read();
      assert.equal(chunk.done, false, 'SSE must remain open while delivering events');
      received += new TextDecoder().decode(chunk.value);
    }
    assert.match(received, /data: first/);
    assert.match(received, /data: second/);
    await reader.cancel();
  } finally {
    clearTimeout(timer); controller.abort(); await proxy.close(); upstream.closeAllConnections(); await new Promise(resolve => upstream.close(resolve));
  }
});

for (const script of ['browser-proof', 'readonly-proof', 'undo-superseded-proof', 'screens-proof']) test(`W146 ${script} resolves a checkout path with spaces`, async () => {
  const {fileURLToPath} = await import('node:url'); const {resolve} = await import('node:path');
  const source=readFileSync(new URL(`./${script}.mjs`,import.meta.url),'utf8');
  const expression=source.match(/const root=(.*?)(?:,runtime=|;)/)?.[1];
  assert.ok(expression, `${script}: root expression anchor missing`);
  const root=Function('resolve','fileURLToPath','URL','moduleUrl',`return ${expression.replaceAll('import.meta.url','moduleUrl')}`)(resolve,fileURLToPath,URL,`file:///tmp/task%20checkout/scripts/r10-served-route/${script}.mjs`);
  assert.equal(root,'/tmp/task checkout');
});
test('W146 screens proof honors the explicit Chrome executable', () => {
  const source=readFileSync(new URL('./screens-proof.mjs',import.meta.url),'utf8');
  const expression=source.match(/executablePath:(.*?),headless:/)?.[1];
  assert.ok(expression,'screens proof executable expression anchor missing');
  assert.equal(Function('process',`return ${expression}`)({env:{R10_CHROME:'/tmp/custom browser'}}),'/tmp/custom browser');
});
