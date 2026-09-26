import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// Adapt the sealed W1 runner in memory so bootstrap, identity checks and cleanup have one source.
const root = process.cwd();
const w1 = resolve(root, 'docs/build-log/walkthrough-w1');
const w2 = resolve(root, 'docs/build-log/walkthrough-w2b');
const runtime = resolve(root, '.odos/w2b-harness');
mkdirSync(runtime, { recursive: true });
const replace = (source, before, after) => {
  assert.ok(source.includes(before), `W1 harness anchor changed: ${before}`);
  return source.replace(before, after);
};
let runner = readFileSync(resolve(w1, 'w1-run.mjs'), 'utf8');
runner = replace(runner, 'const scripts = dirname(fileURLToPath(import.meta.url));', `const scripts = ${JSON.stringify(w1)};`);
runner = runner.replaceAll('odos-w1-', 'odos-w2b-');
runner = runner.replaceAll("'w1-summary.json'", "'w2b-live-summary.json'");
runner = runner.replaceAll("'w1-private-run-path'", "'w2b-private-run-path'");
const liveStart = runner.indexOf("  await startMcp('g7-baseline');");
const liveEnd = runner.indexOf('\n} catch (error) {\n  walkthroughError = error;', liveStart);
assert.ok(liveStart > 0 && liveEnd > liveStart);
runner = runner.slice(0, liveStart) + `
  const w2bLive = ${JSON.stringify(resolve(runtime, 'live.ts'))};
  await startMcp('g9-baseline');
  await command('g9-baseline', process.execPath, ['--import', 'tsx', w2bLive]);
  mutate('mcp/src/clinical-graph/protocol-endpoint.ts',
    'const selected = medical ?? refractive ?? fallback;',
    'const selected = classified.find((diagnosis) => diagnosis.rank === 1);');
  try {
    await startMcp('g9-red');
    const output = await command('g9-red', process.execPath, ['--import', 'tsx', w2bLive], { red: true });
    assert.match(output, /comprehensive-exam-new create=200 readback=200 pointer=myopia expected=glaucoma/);
    assert.match(output, /routine-vision-exam-new create=200 readback=200 pointer=myopia expected=myopia/);
  } finally { restore(); }
  await startMcp('g9-restored');
  await command('g9-restored', process.execPath, ['--import', 'tsx', w2bLive]);
` + runner.slice(liveEnd);
let live = readFileSync(resolve(w1, 'w1-live.ts'), 'utf8');
const identityEnd = live.indexOf("const provider = await human('provider');");
assert.ok(identityEnd > 0);
live = live.slice(0, identityEnd) + readFileSync(resolve(w2, 'w2b-live.ts.inc'), 'utf8');
live = live.replace(/from '(\.\.\/\.\.\/\.\.\/[^']+)'/g, (_, path) => `from '${pathToFileURL(resolve(w2, path)).href}'`);
writeFileSync(resolve(runtime, 'live.ts'), live, { mode: 0o600 });
writeFileSync(resolve(runtime, 'run.mjs'), runner, { mode: 0o600 });
try {
  const code = await new Promise((done, reject) => {
    const child = spawn(process.execPath, [resolve(runtime, 'run.mjs')], { stdio: 'inherit' });
    child.once('error', reject); child.once('exit', done);
  });
  process.exitCode = code ?? 1;
} finally { rmSync(runtime, { recursive: true, force: true }); }
