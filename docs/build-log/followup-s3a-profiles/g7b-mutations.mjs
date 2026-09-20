import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const file = 'ui/src/lib/follow-up-profiles.ts';
const original = readFileSync(file, 'utf8');
const command = ['--import', 'tsx', '--test', '--test-name-pattern=clinical-graph requests share', 'tests/clinicalGraphRouting.test.tsx'];
const hash = value => createHash('sha256').update(value).digest('hex');
const local = original.replace('authHeaders, clinicalGraphApiBase, clinicalGraphResponseError', 'authHeaders, clinicalGraphResponseError');
assert.notEqual(local, original);
const variants = [
  { id: 'G7b-loop', source: local + '\nfunction clinicalGraphApiBase(): string { return ""; }\n', expected: 'doesNotMatch' },
  { id: 'G7b-count', source: local.replaceAll('clinicalGraphApiBase()', 'clinicalGraphApiBase("")') + '\nfunction clinicalGraphApiBase(base: string): string { return base; }\n', expected: '56 !== 57' },
];
function run() {
  const result = spawnSync(process.execPath, command, { cwd: 'ui', encoding: 'utf8', timeout: 30000 });
  const output = result.stdout + result.stderr;
  return { exit: result.status, output, summary: output.split('\n').filter(line => /^not ok|^ok |^# (tests|pass|fail|skipped)|operator:|56 !== 57/.test(line.trim())) };
}
const results = [];
for (const variant of variants) {
  let red;
  try { writeFileSync(file, variant.source); red = run(); }
  finally { writeFileSync(file, original); }
  assert.equal(hash(readFileSync(file, 'utf8')), hash(original));
  const green = run();
  assert.equal(red.exit, 1); assert.ok(red.output.includes(variant.expected), variant.id);
  assert.equal(green.exit, 0);
  results.push({ id: variant.id, file, command: "cd ui && node --import tsx --test --test-name-pattern='clinical-graph requests share' tests/clinicalGraphRouting.test.tsx", originalHash: hash(original), mutantHash: hash(variant.source), red: { exit: red.exit, summary: red.summary }, green: { exit: green.exit, summary: green.summary } });
  console.log(`${variant.id}: red exit ${red.exit}, restored exit ${green.exit}`);
}
writeFileSync('docs/build-log/followup-s3a-profiles/g7b-mutations.json', JSON.stringify(results, null, 2) + '\n');
