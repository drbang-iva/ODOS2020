import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const scratch = resolve(root, '.odos/staff-dx-gate/mutation-worktree-3');
assert.equal(existsSync(scratch), false, 'Use a fresh scratch directory; never overwrite a worktree');
execFileSync('git', ['worktree', 'add', '--detach', scratch, 'HEAD'], { cwd: root, stdio: 'pipe' });
const patch = execFileSync('git', ['diff', '--binary', 'HEAD'], { cwd: root });
if (patch.length) execFileSync('git', ['apply', '-'], { cwd: scratch, input: patch });
cpSync(resolve(root, 'mcp/tests/diagnosisWriteGate.test.ts'), resolve(scratch, 'mcp/tests/diagnosisWriteGate.test.ts'));
for (const directory of ['node_modules', 'mcp/node_modules', 'ui/node_modules']) symlinkSync(resolve(root, directory), resolve(scratch, directory));
const source = path => resolve(scratch, path);
const results = [];
function run(name, testFiles, pattern, expectedFailure) {
  const args = ['--import', resolve(root, 'mcp/node_modules/tsx/dist/loader.mjs'), '--test', '--test-concurrency=1'];
  if (pattern) args.push('--test-name-pattern', pattern);
  args.push(...testFiles.map(file => resolve(scratch, file)));
  const result = spawnSync(process.execPath, args, { cwd: scratch, env: { ...process.env, ODOS_ALLOW_UNGATED_MCP: '1' }, encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 });
  const output = result.stdout + result.stderr;
  writeFileSync(resolve(root, `docs/build-log/staff-dx-gate/${name}.tap`), output);
  assert.equal(result.status !== 0, expectedFailure, `${name} unexpected exit ${result.status}`);
  assert.match(output, expectedFailure ? /# fail [1-9]/ : /# fail 0/);
  results.push({ name, exitCode: result.status, command: `node --import tsx --test --test-concurrency=1 ${pattern ? `--test-name-pattern '${pattern}' ` : ''}${testFiles.join(' ')}`, counts: output.split('\n').filter(line => /^# (tests|pass|fail|skipped) /.test(line)) });
}
function mutate(name, path, edit, files, pattern) {
  const original = readFileSync(source(path), 'utf8');
  const changed = edit(original);
  assert.ok(changed !== original, `${name}: mutation must land`);
  try {
    writeFileSync(source(path), changed);
    run(name, files, pattern, true);
  } finally { writeFileSync(source(path), original); }
}
const before = execFileSync('git', ['diff', '--binary', 'HEAD'], { cwd: scratch });
mutate('mutation-prewrite-red', 'mcp/src/clinical-graph/diagnosis-findings-endpoint.ts', code => code.replace(
  'parsedBody.data.action !== "grade" && parsedBody.data.action !== "laterality" &&', 'false && parsedBody.data.action !== "grade" && parsedBody.data.action !== "laterality" &&'),
  ['mcp/tests/diagnosisFindings.test.ts'], 'staff diagnosis-door assertion refuses');
mutate('mutation-role-table-red', 'mcp/src/authz/roles.ts', code => {
  const start = code.indexOf('  staff: {', code.indexOf('export const ROLE_REGISTRY'));
  assert.ok(start > 0);
  return code.slice(0, start) + code.slice(start).replace('"chart.write",', '"chart.write",\n      "chart.diagnosis.write",');
}, ['mcp/tests/v05a-authz.test.ts'], 'full role table');
mutate('mutation-complexity-red', 'mcp/src/clinical-graph/diagnosis-order-endpoint.ts', code => code.replace(
  'if (!staffHasBusinessAction(staff, "chart.diagnosis.write"))', 'if (!staffHasBusinessAction(staff, "chart.write"))'),
  ['mcp/tests/diagnosisWriteGate.test.ts', 'mcp/tests/diagnosisOrder.test.ts'], 'complexity');
mutate('mutation-pick-red', 'mcp/src/clinical-graph/diagnosis-pick-endpoint.ts', code => code.replaceAll('"chart.diagnosis.write"', '"chart.write"'),
  ['mcp/tests/diagnosisLinkL2.test.ts'], 'staff.*pick');
mutate('mutation-credential-grant-red', 'mcp/src/authz/roles.ts', code => code.replace(
  'export const CREDENTIAL_BOUND_BUSINESS_ACTIONS = [\n  "chart.diagnosis.write",', 'export const CREDENTIAL_BOUND_BUSINESS_ACTIONS = ['),
  ['mcp/tests/v05a-authz.test.ts'], 'diagnosis permission cannot');
mutate('mutation-void-red', 'mcp/src/clinical-graph/encounter-void-endpoint.ts', code => code.replace(
  'if (conditions.length > 0 && !canWriteDiagnosis)', 'if (false && conditions.length > 0 && !canWriteDiagnosis)'),
  ['mcp/tests/encounterVoidEndpoint.test.ts'], 'staff may preview');
mutate('mutation-undo-red', 'mcp/src/clinical-graph/encounter-undo-endpoint.ts', code => code.replace(
  'if (!canWriteDiagnosis && slot.voided.some', 'if (false && !canWriteDiagnosis && slot.voided.some'),
  ['mcp/tests/encounterUndoEndpoint.test.ts'], 'staff cannot undo');
for (const name of ['diagnosis-catalog', 'diagnosis-quick-list', 'diagnosis-findings']) {
  mutate(`mutation-${name}-payload-red`, `mcp/src/clinical-graph/${name}-endpoint.ts`, code => name === 'diagnosis-quick-list'
    ? code.replace('    canWriteDiagnosis,', '    canWriteDiagnosis: true,')
    : code.replace('canWriteDiagnosis: staffHasBusinessAction(staff, "chart.diagnosis.write")', 'canWriteDiagnosis: true'),
  ['mcp/tests/diagnosisQuickList.test.ts', 'mcp/tests/diagnosisFindings.test.ts'], 'payload');
}
assert.deepEqual(execFileSync('git', ['diff', '--binary', 'HEAD'], { cwd: scratch }), before, 'Every scratch mutation is restored');
run('mutations-restored-green', [
  'mcp/tests/v05a-authz.test.ts', 'mcp/tests/diagnosisFindings.test.ts', 'mcp/tests/diagnosisLinkL2.test.ts',
  'mcp/tests/diagnosisOrder.test.ts', 'mcp/tests/diagnosisWriteGate.test.ts',
  'mcp/tests/diagnosisQuickList.test.ts', 'mcp/tests/encounterVoidEndpoint.test.ts', 'mcp/tests/encounterUndoEndpoint.test.ts',
], undefined, false);
writeFileSync(resolve(root, 'docs/build-log/staff-dx-gate/mutations.json'), JSON.stringify({ scratch: '.odos/staff-dx-gate/mutation-worktree-3', restoredDiffIdentical: true, results }, null, 2) + '\n');
console.log(JSON.stringify(results));
