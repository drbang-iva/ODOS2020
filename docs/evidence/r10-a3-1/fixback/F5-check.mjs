import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
test('F5 CodeRabbit excludes evidence and preserves every other setting',()=>{
const source=readFileSync('.coderabbit.yaml','utf8');
const entry='  path_filters: ["!docs/evidence/**"]\n';
assert.equal(source.split(entry).length-1,1,'Evidence exclusion must appear exactly once');
assert.ok(source.startsWith('reviews:\n'+entry));
assert.equal(source.replace(entry,''),execFileSync('git',['show','3c14565e:.coderabbit.yaml'],{encoding:'utf8'}));
});
