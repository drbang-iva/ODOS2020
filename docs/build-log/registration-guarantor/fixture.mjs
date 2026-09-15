import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'../../..');
const privateDirectory=resolve(root,'.odos/registration-majority-live');
mkdirSync(privateDirectory,{recursive:true,mode:0o700});
let source=readFileSync(resolve(root,'docs/build-log/guarantor-g2b1/live-fixture.mjs'),'utf8');
const replacements=[
  ["'g2b1-build-live'","'registration-majority-live'"],
  ["'10.249.60.0/24'","'10.249.94.0/24'"],
  ['{ medplum: 28760, postgres: 28761, redis: 28762, odos: 28763, ui: 28764, proof: 28765 }','{ medplum: 29160, postgres: 29161, redis: 29162, odos: 29163, ui: 29164, proof: 29165 }'],
  ["const fixtureRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');",`const fixtureRoot = ${JSON.stringify(root)};`],
  ['/.odos/g2b1-build-live','/.odos/registration-majority-live'],
  ['/docs/build-log/guarantor-g2b1','/docs/build-log/registration-guarantor'],
];
for(const [before,after] of replacements){assert.ok(source.includes(before));source=source.replaceAll(before,after);}
const target=resolve(privateDirectory,'fixture.mjs');
writeFileSync(target,source,{mode:0o600});
const action=process.argv[2];
assert.ok(['up','start','seed','sync','status','audit-smoke','stop'].includes(action));
const result=action==='stop'
  ? spawnSync('docker',['compose','-p','registration-majority-live','-f',resolve(privateDirectory,'compose.json'),'stop'],{cwd:root,stdio:'inherit'})
  : spawnSync(process.execPath,['--import','tsx',target,action],{cwd:root,stdio:'inherit'});
process.exitCode=result.status??1;
