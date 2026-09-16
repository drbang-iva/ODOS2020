import ts from 'typescript';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import vm from 'node:vm';
const path = 'mcp/tests/r10DiagnosisDoorAuthzLive.test.ts';
function cleanupFunction(source) {
  const ast = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
  let block;
  function visit(node) { if (ts.isTryStatement(node) && node.finallyBlock) block = node.finallyBlock; ts.forEachChild(node, visit); }
  visit(ast);
  const js = ts.transpile(`async function run(cleanupReferences,baseUrl,callerAccessToken,seederAccessToken,cleanup) ${block.getText(ast)}`, { target: ts.ScriptTarget.ES2022 });
  return vm.runInNewContext(js + '\nrun');
}
const old = cleanupFunction(execFileSync('git', ['show', '6ddfb82a8c4f093357b1fdb23cad0ea16e04f7ee:' + path], { encoding: 'utf8' }));
const current = cleanupFunction(readFileSync(path, 'utf8'));
const selected = process.argv.includes('--before') ? [['before', old]] : [['after', current]];
const cases = [[], ['caller'], ['seeder'], ['caller','seeder']];
const output = ['W7 / section7 fixture cleanup: execute the actual TypeScript finally block, transpiled from each source version.'];
for (const [name, run] of selected) {
  let passed = 0;
  for (const rejected of cases) {
    const calls=[]; let failure;
    try { await run(async (_base, token, refs) => { calls.push({token,refs}); if(rejected.includes(token)) throw new Error(token); }, 'synthetic', 'caller', 'seeder', ['ClientApplication/a','ProjectMembership/m','Patient/p']); }
    catch(error) { failure=error; }
    const correctCalls=JSON.stringify(calls)===JSON.stringify([{token:'caller',refs:['ProjectMembership/m']},{token:'seeder',refs:['ClientApplication/a','Patient/p']}]);
    const correctFailure=rejected.length ? failure?.errors?.length===rejected.length : failure===undefined;
    const good=correctCalls&&correctFailure; passed+=Number(good);
    output.push(`${name} rejected=${rejected.join(',')||'none'}: ${good?'PASS':'FAIL'}; attempted=${calls.map(c=>c.token).join(',')}; collected=${failure?.errors?.length??(failure?1:0)}`);
  }
  output.push(`${name}: ${passed}/4 checks`);
  process.exitCode = passed === 4 ? 0 : 1;
}
console.log(output.join('\n'));
