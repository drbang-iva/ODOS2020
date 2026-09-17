import assert from 'node:assert/strict';
import {mkdtempSync,cpSync,mkdirSync,symlinkSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
const root=process.cwd(),out=resolve('docs/evidence/r10-a3-1/fixback');const scratch=mkdtempSync(join(tmpdir(),'r10-a3-pdf-proof-'));
try {
 for(const dir of ['mcp/src','ui/src','src','mcp/scripts'])cpSync(join(root,dir),join(scratch,dir),{recursive:true});
 mkdirSync(join(scratch,'mcp/tests'),{recursive:true});
 for(const entry of ['node_modules','mcp/node_modules','policy','data'])symlinkSync(join(root,entry),join(scratch,entry));
 symlinkSync(join(root,'mcp/tests/fixtures'),join(scratch,'mcp/tests/fixtures'));
 for(const file of ['r10A3ReleaseScenarios.test.ts','encounterVoidFixture.ts','fhirAuditTestStub.ts'])cpSync(join(root,'mcp/tests',file),join(scratch,'mcp/tests',file));
 const planted=join(scratch,'src/planted-exam-consumer.ts');writeFileSync(planted,'export const renderExamPdf = true;\n');
 const run=()=>spawnSync(process.execPath,['--import',join(root,'mcp/node_modules/tsx/dist/loader.mjs'),'--test','--test-name-pattern=T20',join(scratch,'mcp/tests/r10A3ReleaseScenarios.test.ts')],{cwd:scratch,encoding:'utf8',env:{...process.env,PATH:'/no-external-tools'}});
 const red=run();writeFileSync(join(out,'F3-scratch-red.txt'),red.stdout+red.stderr);assert.equal(red.status,1);assert.match(red.stdout,/Exam PDF consumer requires.*src\/planted-exam-consumer/s);
 rmSync(planted);const green=run();writeFileSync(join(out,'F3-scratch-green.txt'),green.stdout+green.stderr);assert.equal(green.status,0,green.stdout+green.stderr);
 console.log('F3 actual T20 scratch: planted consumer red1; removed green0; PATH contains no external binaries');
} finally {rmSync(scratch,{recursive:true,force:true});}
