import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeEvidenceOutput } from './evidence-output.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const scratchRoot = resolve(root, '.odos/staff-dx-gate');
mkdirSync(scratchRoot, { recursive: true });
const scratch = mkdtempSync(resolve(scratchRoot, 'undo-review-mutation-'));
execFileSync('git', ['worktree', 'add', '--detach', scratch, 'HEAD'], { cwd: root });
const patch = execFileSync('git', ['diff', '--binary', 'HEAD', '--', '.', ':!docs/build-log'], { cwd: root });
if (patch.length) execFileSync('git', ['apply', '-'], { cwd: scratch, input: patch });
for (const directory of ['node_modules', 'mcp/node_modules', 'ui/node_modules']) symlinkSync(resolve(root, directory), resolve(scratch, directory));
const before = execFileSync('git', ['diff', '--binary', 'HEAD'], { cwd: scratch });
const results = [];
const run = (name, expectedFailures) => {
  const args = ['--import', resolve(root, 'ui/node_modules/tsx/dist/loader.mjs'), '--test', '--test-reporter=tap',
    '--test-name-pattern', 'undo ledger rejects|Undo ignores a previous', 'tests/encounterUndo.test.tsx', 'tests/examOverviewBoard.test.tsx'];
  const result = spawnSync(process.execPath, args, { cwd: resolve(scratch, 'ui'), encoding: 'utf8' });
  const output = result.stdout + result.stderr;
  writeEvidenceOutput(resolve(root, `docs/build-log/staff-dx-gate/${name}.tap`), output);
  assert.equal(result.status, expectedFailures ? 1 : 0, output);
  assert.match(output, new RegExp(`# fail ${expectedFailures}\\b`));
  results.push({ name, exitCode: result.status, cwd: 'ui',
    command: 'node --import tsx --test --test-reporter=tap --test-name-pattern "undo ledger rejects|Undo ignores a previous" tests/encounterUndo.test.tsx tests/examOverviewBoard.test.tsx',
    counts: output.split('\n').filter(line => /^# (tests|pass|fail|skipped) /.test(line)) });
};
for (const [name, path, target, replacement, failures] of [
  ['undo-review-entry-mutation-red', 'ui/src/lib/encounter-undo.ts', 'value.voided.every(isEntry)', 'true', 1],
  ['undo-review-scope-mutation-red', 'ui/src/scenes/EncounterCharting.tsx', 'const isCurrentEncounter = () => currentEncounterScope.current === encounterScope;', 'const isCurrentEncounter = () => true;', 4],
]) {
  const file = resolve(scratch, path);
  const original = readFileSync(file, 'utf8');
  assert.equal(original.split(target).length, 2);
  try {
    writeFileSync(file, original.replace(target, replacement));
    run(name, failures);
  } finally { writeFileSync(file, original); }
}
assert.deepEqual(execFileSync('git', ['diff', '--binary', 'HEAD'], { cwd: scratch }), before);
run('undo-review-restored-green', 0);
writeFileSync(resolve(root, 'docs/build-log/staff-dx-gate/undo-review-mutations.json'), JSON.stringify({ scratch: relative(root, scratch), retained: true, restoredDiffIdentical: true, results }, null, 2) + '\n');
console.log(JSON.stringify(results));
