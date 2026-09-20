import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, openSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const dir = 'docs/build-log/followup-s3a-profiles';
const stack = `${dir}/proof/stack.mjs`;
const file = 'mcp/src/index.ts', original = readFileSync(file, 'utf8');
const hash = value => createHash('sha256').update(value).digest('hex');
const log = openSync('.odos/s3a-proof/rate-mutation.log', 'a', 0o600);
function stackCommand(command) {
  const result = spawnSync(process.execPath, [stack, command], { stdio: ['ignore', log, log], timeout: 120000 });
  assert.equal(result.status, 0, `stack ${command}`);
}
async function serve() {
  const child = spawn(process.execPath, [stack, 'serve'], { stdio: ['ignore', 'pipe', log] });
  await new Promise((resolve, reject) => {
    let output = '';
    child.stdout.on('data', value => { output += value; if (output.includes('Served synthetic app:')) resolve(); });
    child.once('exit', code => reject(new Error(`Server exited ${code}`)));
  });
}
function probe() {
  const result = spawnSync(process.execPath, [`${dir}/proof/rate-limit.mjs`], { encoding: 'utf8', timeout: 30000 });
  const output = result.stdout + result.stderr;
  return { exit: result.status, summary: output.split('\n').filter(line => /Profile requests must reach 429|All three profile routes:/.test(line)) };
}
stackCommand('stop-app');
let red;
try {
  const mutant = original.replace(/      const followUpProfileLimit = rateLimit\(\{[\s\S]*?\n      \}\);\n\n/, '').replaceAll(', followUpProfileLimit, async', ', async');
  assert.notEqual(mutant, original);
  writeFileSync(file, mutant);
  stackCommand('build'); await serve(); red = probe();
} finally {
  writeFileSync(file, original);
  stackCommand('stop-app');
}
assert.equal(hash(readFileSync(file, 'utf8')), hash(original));
stackCommand('build'); await serve();
const green = probe();
stackCommand('stop-app');
writeFileSync(`${dir}/rate-mutation.json`, JSON.stringify({ file, command: `node ${dir}/rate-mutation.mjs`, sourceHash: hash(original), red, green }, null, 2) + '\n');
assert.equal(red.exit, 1); assert.equal(green.exit, 0);
console.log(`Served rate-limit mutation: red exit ${red.exit}, restored exit ${green.exit}`);
