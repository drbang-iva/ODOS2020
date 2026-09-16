import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from '../../../mcp/node_modules/typescript/lib/typescript.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const baseline = 'b761a8a27df29bf954c9b53ed126000f01f449dd';
const files = [
  ['mcp/tests/currentFindingReader.test.ts', 'test("canonical homes ignore Condition evidence'],
  ['mcp/tests/currentFindingIdentity.test.ts', 'test("operation marker validates audit envelope'],
  ['mcp/tests/fixtures/r10/premise-replay.ts', undefined],
];
const permitted = new Map([
  ['mcp/tests/currentFindingReader.test.ts:86', 'assert.equal(p.currentFacts.length, 0)'],
  ['mcp/tests/currentFindingReader.test.ts:87', null],
  ['mcp/tests/currentFindingReader.test.ts:172', 'assert.equal(p.currentFacts.length,0)'],
  ['mcp/tests/fixtures/r10/premise-replay.ts:146', 'assert.equal(p.currentFacts.length,0)'],
]);
const changes = [];
function assertions(text, path) {
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
  const found = [];
  const visit = node => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.expression.getText(source) === 'assert') {
      found.push({ line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1, statement: node.getText(source) });
    }
    ts.forEachChild(node, visit);
  };
  visit(source); return found;
}
for (const [path, newTests] of files) {
  const before = assertions(execFileSync('git', ['show', `${baseline}:${path}`], { cwd: root, encoding: 'utf8' }), path);
  let current = readFileSync(resolve(root, path), 'utf8');
  if (newTests) { assert.ok(current.includes(newTests)); current = current.slice(0, current.indexOf(newTests)); }
  const after = assertions(current, path); let cursor = 0;
  for (const old of before) {
    const key = `${path}:${old.line}`;
    // E8 shares its line with the unchanged negativeActs assertion.
    const authorized = permitted.has(key) && old.statement.startsWith('assert.equal(p.currentFacts');
    const expected = authorized ? permitted.get(key) : old.statement;
    if (expected !== null) { assert.equal(after[cursor]?.statement, expected, `Unauthorized assertion change at ${key}`); cursor++; }
    if (authorized) changes.push({ file: path, originalLine: old.line, before: old.statement, after: expected ?? '(removed)' });
  }
  assert.equal(cursor, after.length, `Unexpected assertion in the existing test prefix: ${path}`);
}
assert.equal(changes.length, 4);
const names = execFileSync('git', ['diff', '--name-only', '--merge-base', 'origin/main'], { cwd: root, encoding: 'utf8' }).trim().split('\n');
const untracked = execFileSync('git', ['ls-files', '--others', '--exclude-standard'], { cwd: root, encoding: 'utf8' }).trim().split('\n');
for (const path of [...names, ...untracked].filter(Boolean)) assert.match(path,
  /^(mcp\/src\/clinical-graph\/current-finding-(identity|reader|writer)\.ts|mcp\/tests\/currentFinding(Identity|Reader|Writer)\.test\.ts|mcp\/scripts\/r10-a2a-preflight\.mjs|mcp\/tests\/fixtures\/r10\/.*|docs\/evidence\/r10-a2a\/.*)$/);
writeFileSync(resolve(root, 'docs/evidence/r10-a2a/assertion-changes.json'), JSON.stringify({ baseline, count: changes.length, changes }, null, 2) + '\n');
console.log(JSON.stringify({ authorizedChangedStatements: changes.length, allOtherExistingAssertionsUnchanged: true, allowedFileScope: true }));
