import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { renderFrontdoor } from './frontdoor-install.mjs';

test('render preserves bytes apart from root substitution', () => assert.equal(renderFrontdoor('root * {$ODOS_UI_DIST}\n', '/tmp/dist'), 'root * /tmp/dist\n'));
test('render refuses remaining placeholder', () => assert.throws(() => renderFrontdoor('{$OTHER}', '/tmp/dist'), /placeholder/));
test('root is safely quoted when it contains spaces', () => assert.equal(renderFrontdoor('root * {$ODOS_UI_DIST}', '/tmp/my dist'), 'root * "/tmp/my dist"'));
test('root refuses Caddy placeholder injection', () => assert.throws(() => renderFrontdoor('{$ODOS_UI_DIST}', '/tmp/{env.SECRET}'), /path/));

function fixture(fn) {
 const dir = mkdtempSync(join(tmpdir(), 'frontdoor-test-'));
 try {
  const target = join(dir, 'Caddyfile'); const dist = join(dir, 'dist'); mkdirSync(dist); writeFileSync(target, 'old config\n');
  const run = (args = [], env = {}) => spawnSync(process.execPath, [resolve('scripts/frontdoor-install.mjs'), '--ui-dist', dist, '--target', target, ...args], { encoding: 'utf8', env: { ...process.env, ...env } });
  fn({ dir, target, run });
 } finally { rmSync(dir, { recursive: true, force: true }); }
}
test('missing caddy fails and does not write', () => fixture(({dir,target,run}) => {
 const result = run([], { PATH: dir }); assert.equal(result.status, 1); assert.match(result.stderr, /caddy.*required|caddy.*not found/i); assert.equal(readFileSync(target, 'utf8'), 'old config\n');
}));
test('real caddy validates dry run, unified diff printed, target unchanged', () => fixture(({dir,target,run}) => {
 const result = run(); assert.equal(result.status, 0, result.stderr); assert.match(result.stdout, /caddy validate/); assert.match(result.stdout, /@@/); assert.equal(readFileSync(target, 'utf8'), 'old config\n'); assert.deepEqual(readdirSync(dir).sort(), ['Caddyfile','dist']);
}));
test('apply backs up exact original before writing', () => fixture(({dir,target,run}) => {
 const result = run(['--apply']); assert.equal(result.status, 0, result.stderr); const backup = readdirSync(dir).find(f => f.startsWith('Caddyfile.bak-')); assert.ok(backup); assert.equal(readFileSync(join(dir,backup),'utf8'),'old config\n'); assert.match(readFileSync(target,'utf8'), /ODOS front door/);
}));
test('invalid arguments do not write', () => fixture(({target,run}) => {
 const result = run(['--unknown']); assert.equal(result.status,1); assert.match(result.stderr,/argument/); assert.equal(readFileSync(target,'utf8'),'old config\n');
}));
