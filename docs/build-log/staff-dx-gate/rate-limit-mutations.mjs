import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeEvidenceOutput } from './evidence-output.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const scratchRoot = resolve(root, '.odos/staff-dx-gate');
mkdirSync(scratchRoot, { recursive: true });
const scratch = mkdtempSync(resolve(scratchRoot, 'rate-limit-mutation-'));
execFileSync('git', ['worktree', 'add', '--detach', scratch, 'HEAD'], { cwd: root });
const patch = execFileSync('git', ['diff', '--binary', 'HEAD', '--', '.', ':!docs/build-log'], { cwd: root });
if (patch.length) execFileSync('git', ['apply', '-'], { cwd: scratch, input: patch });
for (const directory of ['node_modules', 'mcp/node_modules']) symlinkSync(resolve(root, directory), resolve(scratch, directory));
const index = resolve(scratch, 'mcp/src/index.ts');
const original = readFileSync(index, 'utf8');
const before = execFileSync('git', ['diff', '--binary', 'HEAD'], { cwd: scratch });
const results = [];
const run = (name, expectedFailure) => {
  const args = ['--import', resolve(root, 'mcp/node_modules/tsx/dist/loader.mjs'), '--test', '--test-reporter=tap',
    '--test-name-pattern', 'registered diagnosis write routes', 'mcp/tests/diagnosisWriteGate.test.ts'];
  const result = spawnSync(process.execPath, args, { cwd: scratch, encoding: 'utf8' });
  const output = result.stdout + result.stderr;
  writeEvidenceOutput(resolve(root, `docs/build-log/staff-dx-gate/${name}.tap`), output);
  assert.equal(result.status, expectedFailure ? 1 : 0, output);
  assert.match(output, expectedFailure ? /# fail 1\b/ : /# fail 0\b/);
  if (expectedFailure) assert.match(output, /401 !== 429/);
  results.push({ name, exitCode: result.status, command: 'node --import tsx --test --test-reporter=tap --test-name-pattern "registered diagnosis write routes" mcp/tests/diagnosisWriteGate.test.ts',
    counts: output.split('\n').filter(line => /^# (tests|pass|fail|skipped) /.test(line)) });
};
try {
  for (const suffix of ['diagnosis-picks', 'diagnosis-order', 'diagnoses/:conditionId/problem-status', 'diagnoses/:conditionId/status', 'diagnoses/:conditionId/newness']) {
    const target = `"/clinical-graph/encounters/:encounterId/${suffix}", diagnosisWriteLimit,`;
    assert.equal(original.split(target).length, 2);
    writeFileSync(index, original.replace(target, target.replace(' diagnosisWriteLimit,', '')));
    run(`rate-limit-mutation-${suffix.split('/').at(-1)}-red`, true);
  }
} finally {
  writeFileSync(index, original);
}
assert.deepEqual(execFileSync('git', ['diff', '--binary', 'HEAD'], { cwd: scratch }), before);
run('rate-limit-restored-green', false);
writeFileSync(resolve(root, 'docs/build-log/staff-dx-gate/rate-limit-mutations.json'), JSON.stringify({ scratch: relative(root, scratch), retained: true, restoredDiffIdentical: true, results }, null, 2) + '\n');
console.log(JSON.stringify(results));
