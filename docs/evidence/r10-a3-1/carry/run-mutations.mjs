import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const evidence = dirname(fileURLToPath(import.meta.url));
const root = process.cwd();
const [manifestPath, ...selected] = process.argv.slice(2);
if (!manifestPath) throw Error('Usage: node run-mutations.mjs manifest.json [guard-id ...]');
const manifest = JSON.parse(readFileSync(resolve(root, manifestPath), 'utf8'));
const guards = manifest.filter(row => !selected.length || selected.includes(row.id));
for (const id of selected) assert.equal(guards.filter(row => row.id === id).length, 1, `Unknown or duplicate guard ${id}`);
assert.ok(guards.length, 'No mutation guards selected');
const out = resolve(root, 'docs/evidence/r10-a3-1/carry/mutations');
mkdirSync(out, {recursive:true});
const results = [];
for (const guard of guards) {
  const original = new Map();
  try {
    for (const edit of guard.edits) {
      const path = resolve(root, edit.file);
      assert.ok(path.startsWith(root + '/'), `Outside worktree: ${edit.file}`);
      const source = readFileSync(path, 'utf8');
      if (!original.has(path)) original.set(path, source);
      const occurrences = source.split(edit.before).length - 1;
      assert.equal(occurrences, 1, `MUTATION ANCHOR MISS ${guard.id}: ${edit.file}: expected 1, found ${occurrences}`);
      assert.notEqual(edit.before, edit.after, `No-op mutation ${guard.id}`);
      writeFileSync(path, source.replace(edit.before, edit.after));
    }
    const red = run(guard);
    writeFileSync(resolve(out, `${guard.id}-red.txt`), red.output);
    assert.equal(red.signal, null, `${guard.id}: mutation process killed`);
    assert.ok(red.status !== null && red.status !== 0, `${guard.id}: mutant survived`);
    assert.match(red.output, new RegExp(guard.failurePattern), `${guard.id}: wrong failure; expected designated behavioral assertion`);
    for (const [path, source] of original) writeFileSync(path, source);
    const green = run(guard);
    writeFileSync(resolve(out, `${guard.id}-green.txt`), green.output);
    assert.equal(green.status, 0, `${guard.id}: restored code failed`);
    for (const [path, source] of original) assert.equal(readFileSync(path, 'utf8'), source, `${guard.id}: restore mismatch`);
    const result = {id:guard.id, redExit:red.status, greenExit:green.status, command:guard.command};
    results.push(result);
    console.log(JSON.stringify(result));
  } finally {
    for (const [path, source] of original) writeFileSync(path, source);
    writeFileSync(resolve(out, 'results.json'), JSON.stringify(results, null, 2)+'\n');
  }
}
function run(guard) {
  const child = spawnSync(guard.command[0], guard.command.slice(1), {cwd:root, encoding:'utf8', timeout:180000, maxBuffer:32*1024*1024});
  if (child.error) throw child.error;
  return {status:child.status, signal:child.signal, output:(child.stdout+child.stderr).replaceAll(root,'<worktree>')};
}
