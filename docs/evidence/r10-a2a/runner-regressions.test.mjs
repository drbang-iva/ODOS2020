import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'odos-r10-guard-runner-'));
  const evidence = join(root, 'docs/evidence/r10-a2a');
  mkdirSync(evidence, { recursive: true });
  mkdirSync(join(root, 'mcp/src/clinical-graph'), { recursive: true });
  copyFileSync(join(repo, 'docs/evidence/r10-a2a/run-guards.mjs'), join(evidence, 'run-guards.mjs'));
  const writer = join(root, 'mcp/src/clinical-graph/current-finding-writer.ts');
  copyFileSync(join(repo, 'mcp/src/clinical-graph/current-finding-writer.ts'), writer);
  const hook = join(root, 'child-result.mjs');
  writeFileSync(hook, `import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { homedir } from 'node:os';
const original = childProcess.spawnSync; let calls = 0;
childProcess.spawnSync = (command,args,options) => command === 'diff' ? original(command,args,options) : {
  status: ++calls === 1 ? (process.env.R10_RED_STATUS === 'null' ? null : 1) : 0,
  stdout: calls === 1 ? homedir() + '/.node/bin/node synthetic failure\\n' : 'synthetic restored success\\n', stderr: ''
};
syncBuiltinESMExports();
`);
  const run = (args, mode = '1') => spawnSync(process.execPath, ['--import', hook, join(evidence, 'run-guards.mjs'), ...args], {
    encoding: 'utf8', env: { ...process.env, R10_RED_STATUS: mode }, timeout: 10000,
  });
  return { root, evidence, writer, run, clean: () => rmSync(root, { recursive: true, force: true }) };
}

test('guard runner creates its private backup directory on a fresh checkout', () => {
  const f = fixture();
  try {
    assert.equal(f.run([]).status, 0);
    assert.ok(existsSync(join(f.root, '.odos/r10-a2a')));
  } finally { f.clean(); }
});

test('guard runner rejects an interrupted child and restores the source', () => {
  const f = fixture();
  try {
    mkdirSync(join(f.root, '.odos/r10-a2a'), { recursive: true });
    const before = readFileSync(f.writer, 'utf8');
    const result = f.run(['W6'], 'null');
    assert.equal(result.status, 1);
    assert.match(result.stderr, /mutation check did not complete/);
    assert.equal(readFileSync(f.writer, 'utf8'), before);
    assert.equal(existsSync(join(f.evidence, 'guards/W6.json')), false);
  } finally { f.clean(); }
});

test('guard runner removes home identifiers outside the checkout from retained output', () => {
  const f = fixture();
  try {
    mkdirSync(join(f.root, '.odos/r10-a2a'), { recursive: true });
    assert.equal(f.run(['W6']).status, 0);
    const output = readFileSync(join(f.evidence, 'guards/W6-red.txt'), 'utf8');
    assert.equal(output.includes(homedir()), false);
    assert.match(output, /<local-home>\/\.node\/bin\/node/);
  } finally { f.clean(); }
});
