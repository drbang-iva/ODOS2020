import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
const dir = 'docs/build-log/issue-639-section-group-concurrency';
const store = 'mcp/src/clinical-graph/finding-section-group-store.ts';
const endpoint = 'mcp/src/clinical-graph/finding-section-group-endpoint.ts';
const tests = 'mcp/tests/findingSectionGroupConcurrency.test.ts';
const oldTests = 'mcp/tests/findingSectionGroup.test.ts';
const catalogueHeader = '"If-None-Exist": `identifier=${encodeURIComponent(`${FINDING_SECTION_GROUP_IDENTIFIER_SYSTEM}|${validated.groupKey}`)}`';
const settings = 'ui/src/components/settings/FindingSectionGroupsSettings.tsx';
const uiTests = 'ui/tests/findingSectionGroups.test.tsx';
const cases = [
 ['UI-new-edit-error', settings, 'function edit(group: FindingSectionGroup) {\n    setError(null);', 'function edit(group: FindingSectionGroup) {', uiTests, 'G1 Settings deactivate'],
 ['UI-new-create-error', settings, 'function create() {\n    setError(null);', 'function create() {', uiTests, 'G1 Settings edit'],
 ['UI-create-version', settings, '              expectedVersion: null,\n', '', uiTests, 'S1b G6 settings'],
 ['UI-edit-version', settings, 'expectedVersion: editing.original?.versionId ?? null', 'expectedVersion: null', uiTests, 'G1 Settings edit'],
 ['UI-active-version', settings, 'expectedVersion: group.versionId', 'expectedVersion: null', uiTests, 'G1 Settings deactivate'],
 ['UI-conflict-message', settings, 'throw clinicalGraphResponseError(response, result, `Section-group save failed: ${response.status}`)', 'throw new Error(result.error)', uiTests, 'G1 Settings edit'],
 ['G1', store, 'const writeVersion = expectedVersion;', 'const writeVersion = existing?.meta?.versionId ?? null;', tests, 'G1'],
 ['G2', store, catalogueHeader, '"X-Disabled-Condition": "fault-injection"', tests, 'G2'],
 ['G3', store, catalogueHeader, '"X-Disabled-Condition": "fault-injection"', tests, 'G3'],
 ['G4', store, 'if (!json || (JSON.parse(json) as { writeToken?: string }).writeToken !== writeToken) throw new FindingSectionGroupConcurrentEditError();', '', tests, 'G2'],
 ['G5', store, '"If-None-Exist": new URLSearchParams({', '"X-Disabled-Condition": new URLSearchParams({', tests, 'G5'],
 ['G6', store, 'if ((error as { status?: number }).status === 412) throw new FindingSectionGroupConcurrentEditError();', 'if ((error as { status?: number }).status === 412) return { ...validated, versionId: expectedVersion };', oldTests, 'stale group and encounter-override writes'],
 ['G7', endpoint, 'if (sectionKeys.length) return', 'if (false) return', oldTests, 'S1 G1 removal'],
];
function run(file, pattern) {
 const args = ['--import','tsx','--test',`--test-name-pattern=${pattern}`,file];
 const result = spawnSync(process.execPath,args,{encoding:'utf8'});
 const out = result.stdout + result.stderr;
 return { command: `node ${args.join(' ')}`, exit: result.status, summary: out.split('\n').filter(line => /^(# (tests|pass|fail|skipped)|not ok |ok )/.test(line)) };
}
const results = [];
for (const [guard, file, from, to, test, pattern] of cases) {
 const original = readFileSync(file,'utf8');
 assert.equal(original.split(from).length,2,`${guard} unique mutation anchor`);
 let red;
 try { writeFileSync(file,original.replace(from,to)); red=run(test,pattern); assert.notEqual(red.exit,0,`${guard} must fail`); }
 finally { writeFileSync(file,original); }
 const green=run(test,pattern); assert.equal(green.exit,0,`${guard} restored must pass`);
 results.push({guard,red,green}); console.log(`${guard}: red ${red.exit}; restored green ${green.exit}`);
}
writeFileSync(`${dir}/mutations.json`,JSON.stringify(results,null,2)+'\n');
