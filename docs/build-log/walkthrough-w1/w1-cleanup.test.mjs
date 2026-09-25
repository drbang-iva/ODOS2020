import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { runInNewContext } from 'node:vm';

const source = readFileSync(new URL('./w1-run.mjs', import.meta.url), 'utf8');
const marker = '\n} finally {';
assert.ok(source.includes(marker));
const cleanup = source.slice(source.lastIndexOf(marker) + marker.length).trim().slice(0, -1);

for (const failure of [undefined, 'restore', 'stop', 'down', 'operator', 'summary', 'credential']) {
  test(`cleanup attempts every resource after ${failure ?? 'no'} failure`, async () => {
    const calls = [];
    const record = (step, fail = false) => {
      calls.push(step);
      if (fail) throw new Error(`synthetic ${step} failure`);
    };
    const context = {
      assert, join, root: '/synthetic', runtime: '/synthetic/runtime', results: [], dockerArgs: [],
      operatorNames: ['operator.env', 'operator-identity.json'], console: { log() {} },
      restore: () => record('restore', failure === 'restore'),
      stopMcp: async () => record('stop', failure === 'stop'),
      spawnSync: (command) => {
        record(command === 'docker-compose' ? 'down' : 'ps');
        return { status: command === 'docker-compose' && failure === 'down' ? 1 : 0, stdout: '' };
      },
      existsSync: () => true,
      renameSync: (from) => record(`restore:${from.split('/').at(-1)}`),
      rmSync: (path) => record(`remove:${path.split('/').at(-1)}`,
        (failure === 'operator' && path === '/synthetic/.odos/operator.env') ||
        (failure === 'credential' && path.endsWith('/medplum.json'))),
      writeFileSync: (path) => record(`write:${path.split('/').at(-1)}`, failure === 'summary' && path.endsWith('/w1-summary.json')),
    };
    const execution = runInNewContext(`(async () => {${cleanup}})()`, context);
    if (failure) await assert.rejects(execution, { name: 'AggregateError' });
    else await execution;
    for (const step of ['restore', 'stop', 'down', 'restore:original-operator.env',
      'restore:original-operator-identity.json', 'write:w1-summary.json', 'write:w1-private-run-path',
      'remove:medplum.json', 'remove:compose.json', 'remove:smart.pem', 'remove:w1-service.env',
      'remove:w1-provider-token', 'remove:w1-composite-token', 'remove:generated-operator.env',
      'remove:generated-operator-identity.json', 'ps']) assert.ok(calls.includes(step), `${step} still attempted`);
  });
}
