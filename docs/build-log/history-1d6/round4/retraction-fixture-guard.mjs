import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
const file='mcp/src/clinical-graph/hpi-endpoint.ts', original=readFileSync(file,'utf8');
const before='    const saved = match(existing);';
assert.equal(original.split(before).length,2);
const result={};
function run(phase){
 const r=spawnSync(process.execPath,['--import','tsx','--test','--test-name-pattern=retraction retry is immutable','mcp/tests/historyRos.test.ts'],{encoding:'utf8'});
 const output=r.stdout+r.stderr;
 writeFileSync(`docs/build-log/history-1d6/round4/retraction-fixture-${phase}.log`,output);
 return {exit:r.status,passed:Number(output.match(/^# pass (\d+)$/m)?.[1]),failed:Number(output.match(/^# fail (\d+)$/m)?.[1])};
}
try {writeFileSync(file,original.replace(before,'    const saved = {};'));result.red=run('guard-red');}
finally {writeFileSync(file,original);}
result.restored=run('guard-restored');
writeFileSync('docs/build-log/history-1d6/round4/retraction-fixture-guard.json',JSON.stringify(result,null,2)+'\n');
console.log(JSON.stringify(result));
assert.deepEqual(result.red,{exit:1,passed:0,failed:1});
assert.deepEqual(result.restored,{exit:0,passed:1,failed:0});
