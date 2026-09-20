import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';

const directory = 'docs/build-log/followup-s2b2a-collapse';
const board = 'ui/src/components/charting/ExamOverviewBoard.tsx';
const scene = 'ui/src/scenes/EncounterCharting.tsx';
const map = 'ui/src/lib/exam-editor-map.ts';
const cases = [
  ['G-FB1', board, 'data === false && saved.has(editor.id) ? "unknown" : data', 'data', ['--test-name-pattern=G-FB1', 'tests/examStaleShelve.test.tsx']],
  ['G-FB2 fault injection', scene, 'savedEditorIds.includes(sectionId) || ', '', ['--test-name-pattern=G-FB2', 'tests/examOverviewBoard.test.tsx']],
  ['G-FB3', board, 'const saved = new Set(savedEditorIds);', 'const saved = new Set(editorEntries.map(editor => editor.id));', ['--test-name-pattern=G-FB3', 'tests/examStaleShelve.test.tsx']],
  ['G-FB4', board, 'if (shelved.has(editor.id)) return data !== false || editor.id === activeEditorId;', 'if (shelved.has(editor.id)) return false;', ['--test-name-pattern=G-FB4', 'tests/examStaleShelve.test.tsx']],
  ['G-FB5', map, 'if (editorSheetSection(editor) === "history" && projection.historySummary) return true;', 'return false;\n  if (editorSheetSection(editor) === "history" && projection.historySummary) return true;', ['tests/examEditorMap.test.tsx', 'tests/examViewState.test.tsx']],
  ['G-FB6', scene, 'const savedEditorIds = Object.keys(statuses);', 'const retainedSavedEditorIds = useRef(new Set<string>());\n  Object.keys(statuses).forEach(id => retainedSavedEditorIds.current.add(id));\n  const savedEditorIds = [...retainedSavedEditorIds.current];', ['--test-name-pattern=G-FB6', 'tests/examOverviewBoard.test.tsx']],
];
const hash = text => createHash('sha256').update(text).digest('hex');
function run(tests) {
  const args = ['--import', 'tsx', '--test', '--test-concurrency=1', ...tests];
  const result = spawnSync(process.execPath, args, { cwd: resolve('ui'), encoding: 'utf8', maxBuffer: 12 * 1024 * 1024 });
  const lines = (result.stdout + result.stderr).split('\n');
  return { command: `(cd ui && node ${args.join(' ')})`, exit: result.status,
    summary: lines.filter(line => /^# (tests|pass|fail|cancelled|skipped|todo) /.test(line)),
    failing: lines.filter(line => /^not ok /.test(line)) };
}
const results = [];
for (const [guard, path, from, to, tests] of cases) {
  const original = readFileSync(path, 'utf8');
  assert.equal(original.split(from).length - 1, 1, `${guard}: exactly one mutation target`);
  const mutant = original.replace(from, to);
  let red;
  try {
    writeFileSync(path, mutant);
    assert.equal(readFileSync(path, 'utf8'), mutant, `${guard}: mutant landed`);
    red = run(tests);
  } finally { writeFileSync(path, original); }
  assert.equal(hash(readFileSync(path, 'utf8')), hash(original), `${guard}: restored byte-for-byte`);
  const green = run(tests);
  results.push({ guard, path, mutation: { from, to, landedSha256: hash(mutant) }, restoredSha256: hash(original), red, green });
  writeFileSync(`${directory}/fixback1-mutations.json`, JSON.stringify(results, null, 2) + '\n');
  console.log(`${guard}: RED ${red.exit} (${red.failing.length} failures), RESTORED ${green.exit}`);
  assert.notEqual(red.exit, 0, `${guard}: mutation survived`);
  assert.ok(red.failing.length > 0, `${guard}: assertion failure required`);
  assert.equal(green.exit, 0, `${guard}: restored source must pass`);
}
