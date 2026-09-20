import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = resolve('.');
const logs = mkdtempSync(join(tmpdir(), 'odos-s2b1-guards-'));
const board = 'ui/src/components/charting/ExamOverviewBoard.tsx';
const scene = 'ui/src/scenes/EncounterCharting.tsx';
const endpoint = 'mcp/src/clinical-graph/finding-section-group-endpoint.ts';
const guards = [
  ['G1', board, 'shelfDefinitions.map(({ key, label }) => {', 'shelfDefinitions.filter(group => group.key !== "contact-lenses").map(({ key, label }) => {', 'ui', 'tests/examShelf.test.tsx'],
  ['G2', board, '<nav className="odos-exam-shelf"', '<details data-testid="chart-another-finding"><summary>Chart another finding</summary></details><nav className="odos-exam-shelf"', 'ui', 'tests/examShelf.test.tsx'],
  ['G3', scene, 'function openBoardEditor(sectionId: ChartSectionId) {', 'function openBoardEditor(sectionId: ChartSectionId) {\n    void fetch(`${clinicalGraphApiBase()}/clinical-graph/encounters/${encounterId}/exam-scope`, { method: "PUT", headers: { ...authHeaders(), "Content-Type": "application/json" }, body: JSON.stringify({ scope: "comprehensive" }) });', 'ui', 'tests/examOverviewBoard.test.tsx'],
  ['G4', board, 'availableSectionGroups.map(group => (', 'availableSectionGroups.slice(0, 0).map(group => (', 'ui', 'tests/examOverviewBoard.test.tsx'],
  ['G5', endpoint, 'if (sectionKeys.length) return { status: 409, body: { code: "section-group-has-content", sectionKeys } };', 'if (false && sectionKeys.length) return { status: 409, body: { code: "section-group-has-content", sectionKeys } };', 'mcp', 'tests/findingSectionGroup.test.ts'],
  ['G5-pin', board, 'Has findings this visit', 'Pinned', 'ui', 'tests/examShelf.test.tsx'],
  ['G6', board, 'const editor = editorForFinding(group, editorEntries);', 'const editor = editorForFinding(group, editorEntries);\n    if (!editor) continue;', 'ui', 'tests/examShelf.test.tsx'],
  ['G7', board, 'snapshotComponentCode(finding.current, "REFRACTION_TYPE") !== "FINAL_RX"', 'finding.provenance.state === "current" && snapshotComponentCode(finding.current, "REFRACTION_TYPE") !== "FINAL_RX"', 'ui', 'tests/examShelf.test.tsx'],
  ['G8', board, 'traceRows.length > 0 || (definition.optional', '(projection as ExamOverviewProjection & { visitTypeCategoryId?: string }).visitTypeCategoryId === "exams" || (definition.optional', 'ui', 'tests/examShelf.test.tsx'],
];
const selected = process.argv[2];
const outputPath = join(root, 'docs/build-log/followup-s2b1-shelf/guards.json');
const results = selected ? JSON.parse(readFileSync(outputPath, 'utf8')).results.filter(result => result.guard !== selected) : [];
function run(guard, state, pkg, file) {
  const args = ['--import', 'tsx', '--test', file];
  const result = spawnSync(process.execPath, args, { cwd: join(root, pkg), encoding: 'utf8' });
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  writeFileSync(join(logs, `${guard}-${state}.log`), output);
  const summary = output.split('\n').filter(line => /^(not ok |# (tests|pass|fail|skipped|cancelled) )/.test(line));
  assert.ok(summary.some(line => line.startsWith('# tests ')), `${guard} did not execute the test runner`);
  assert.ok(state === 'red' ? result.status !== 0 && summary.some(line => line.startsWith('not ok ')) : result.status === 0, `${guard} ${state} did not produce expected result`);
  console.log(`${guard} ${state}: ${summary.join('; ')}`);
  return { exit: result.status, output: summary };
}
for (const [guard, file, before, after, pkg, test] of guards) {
  if (selected && selected !== guard) continue;
  const path = join(root, file);
  const original = readFileSync(path, 'utf8');
  assert.equal(original.split(before).length, 2, `${guard} mutation anchor must be unique`);
  let red;
  try {
    writeFileSync(path, original.replace(before, after));
    red = run(guard, 'red', pkg, test);
  } finally { writeFileSync(path, original); }
  const green = run(guard, 'green', pkg, test);
  assert.equal(readFileSync(path, 'utf8'), original);
  results.push({ guard, file, mutation: after, command: `cd ${pkg} && node --import tsx --test ${test}`, red, green });
}
const diff = spawnSync('git', ['diff', '--stat', '--', endpoint], { cwd: root, encoding: 'utf8' });
assert.equal(diff.status, 0); assert.equal(diff.stdout, '');
writeFileSync(outputPath, JSON.stringify({ results, endpointDiffStat: '' }, null, 2) + '\n');
console.log('G1–G8 restored; endpoint git diff --stat output is empty.');
