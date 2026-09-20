import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';

const dir = 'docs/build-log/followup-s2b2a-collapse';
const map = 'ui/src/lib/exam-editor-map.ts', board = 'ui/src/components/charting/ExamOverviewBoard.tsx';
const rail = 'ui/src/components/charting/SpineNav.tsx', storage = 'ui/src/lib/exam-view-state.ts';
const mapTests = ['ui/tests/examEditorMap.test.tsx'];
const viewTests = ['ui/tests/examViewState.test.tsx'];
const specs = [
  ['G1', map, 'if (editorSheetSection(editor) === "history" && projection.historySummary) return true;',
    'return false;\n  if (editorSheetSection(editor) === "history" && projection.historySummary) return true;', mapTests],
  ['G2', board, 'onClick={() => handler?.(editor.id)}', 'onClick={() => { if (action === "shelve") onRefresh(); handler?.(editor.id); }}', viewTests],
  ['G2-active', board, 'disabled={!handler || (action === "shelve" && activeEditorId === editor.id)}', 'disabled={!handler}', viewTests],
  ['G3', board, 'const data = evidence.get(editor.id);', 'if (collapsed.has(editor.id)) return false;\n      const data = evidence.get(editor.id);', viewTests],
  ['G4-default', map, 'return editorDataEvidence(editor.id) === "projection" ? false : "unknown";', 'return false;', mapTests],
  ['G4-other', map, 'if (groups.some(group => !editorForFinding(group, editorEntries) &&', 'if (false && groups.some(group => !editorForFinding(group, editorEntries) &&', mapTests],
  ['G5-iop', map, '  iop: "projection",\n', '', mapTests],
  ['G5-procedure', map, '  "procedure:": "unknown",\n', '', mapTests],
  ['G5-new-entry', rail, 'const SECTIONS: ChartEditorEntry[] = [', 'const SECTIONS: ChartEditorEntry[] = [\n  { id: "synthetic-unregistered", label: "Synthetic unregistered", group: "PRETEST" },', mapTests],
  ['G6', board, 'if (shelved.has(editor.id)) return data !== false || editor.id === activeEditorId;', 'if (shelved.has(editor.id)) return false;', viewTests],
  ['G7', board, 'onClick={() => handler?.(editor.id)}', 'onClick={() => { if (action === "collapse") onRefresh(); handler?.(editor.id); }}', viewTests],
  ...[
    ['cover-test', '"entrance:cover"'], ['color-vision', '"entrance:color"'], ['stereopsis', '"entrance:stereo"'],
    ['iop', 'intraocular_pressure'], ['cup-disc', 'cup_disc_ratio'], ['manual-keratometry', 'manual_keratometry'],
    ['auto-refraction', 'auto_refraction'], ['hpi', 'hpi_ros'],
  ].map(([id, key]) => [`G8-${id}`, map, `    ${key}:`, `    "renamed-${id}":`, mapTests]),
  ['G9', rail, 'const groups = groupedSections(sections);', 'const groups = groupedSections(sections.filter(entry => entry.id !== "iop"));', mapTests],
  ['G10', storage, '} catch {\n    return empty();', '} catch {\n    throw new Error("storage escaped loader");', viewTests],
  ['G11', board, '(scopeDrawsRow && !editor.readOnly', '((projection as ExamOverviewProjection & { visitTypeCategoryId?: string }).visitTypeCategoryId === "exams" && !editor.readOnly', ['ui/tests/examShelf.test.tsx']],
  ['assertion-migration', board, 'data-drawn-editor-id={editor.id} data-holds-data', 'data-drawn-editor-id={"wrong-line-id"} data-holds-data', ['ui/tests/entrySheets.test.tsx']],
];
const select = process.argv.slice(2);
const results = [];
const hash = text => createHash('sha256').update(text).digest('hex');
function run(tests) {
  const args = ['--import', 'tsx', '--test', '--test-concurrency=1', ...tests.map(path => path.replace(/^ui\//, ''))];
  const result = spawnSync(process.execPath, args, { cwd: resolve('ui'), encoding: 'utf8', maxBuffer: 12 * 1024 * 1024 });
  const output = result.stdout + result.stderr;
  return { command: `(cd ui && node ${args.join(' ')})`, exit: result.status,
    summary: output.split('\n').filter(line => /^# (tests|pass|fail|cancelled|skipped|todo) /.test(line)),
    failing: output.split('\n').filter(line => /^not ok /.test(line)),
    assertion: output.split('\n').filter(line => /Missing registry decision:|Missing writer pin:|SpineNav missing/.test(line)).map(line => line.trim()),
  };
}
for (const [guard, path, before, after, tests] of specs.filter(spec => !select.length || select.includes(spec[0]))) {
  const original = readFileSync(path, 'utf8');
  assert.equal(original.split(before).length - 1, 1, `${guard}: mutation target must occur exactly once`);
  let red;
  try {
    writeFileSync(path, original.replace(before, after));
    red = run(tests);
  } finally { writeFileSync(path, original); }
  assert.equal(hash(readFileSync(path, 'utf8')), hash(original));
  const green = run(tests);
  const row = { guard, path, restoredSha256: hash(original), red, green };
  results.push(row);
  writeFileSync(resolve(dir, select.length ? 'mutation-selected.json' : 'mutation-results.json'), JSON.stringify(results, null, 2) + '\n');
  console.log(`${guard}: RED exit ${red.exit} (${red.failing.length} failing); RESTORED exit ${green.exit}`);
  assert.notEqual(red.exit, 0, `${guard}: mutation survived`);
  assert.ok(red.failing.length > 0, `${guard}: expected assertion failure, not infrastructure failure`);
  assert.equal(green.exit, 0, `${guard}: restored source must pass`);
}
