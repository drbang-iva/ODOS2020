import ts from '../../../../../mcp/node_modules/typescript/lib/typescript.js';
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';
const root=resolve(import.meta.dirname,'../../../../..');
const source=file=>readFileSync(resolve(root,file),'utf8');
test('W40 review preflight usage names service-gate',()=>{
 const usage=source('mcp/scripts/r10-a3-preflight.mjs').match(/Usage: ([^']+)/)?.[1];
 assert.ok(usage?.split('|').includes('service-gate'));
});
test('W40 review T20 root expression decodes spaces',()=>{
 const text=source('mcp/tests/r10A3ReleaseScenarios.test.ts');
 const expression=text.slice(text.indexOf('test("T20 ')).match(/const root=([^;]+);/)?.[1];
 assert.ok(expression);
 const rootValue=new Function('fileURLToPath','moduleUrl',`return ${expression.replaceAll('import.meta.url','moduleUrl')}`)(fileURLToPath,'file:///tmp/review%20space/mcp/tests/scenarios.ts');
 assert.equal(rootValue,'/tmp/review space/');
});
test('V21 review legacy staining exclusion names canonical write coverage',()=>{
 assert.match(source('mcp/tests/customSectionEndpoint.test.ts'),/Conjunctival staining is shared Ocular Health; canonical save coverage lives in r10A3OcularDoor\.test\.ts \(W96\)/);
});
for(const file of ['r10OcularHealthDoorAuthzLive.test.ts','r10DiagnosisDoorAuthzLive.test.ts'])test(`V35 review ${file} preserves body failure alongside cleanup`,async()=>{
 const text=source(`mcp/tests/${file}`);
 const offset=text.indexOf('  } catch (error) {\n    bodyFailure = error;');
 assert.ok(offset>=0,'body-failure catch anchor');
 const tail=ts.transpileModule(`async function probe(){try{${text.slice(offset,text.lastIndexOf('\n});'))}}`,{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
 const compiledTail=tail.slice(tail.indexOf('catch (error)'),tail.lastIndexOf('}'));
 const cleanup=file.includes('Ocular')?'new Set()':'[]';
 const run=new (Object.getPrototypeOf(async()=>{}).constructor)('bodyError','cleanupReferences',`const baseUrl='synthetic',callerAccessToken='caller',seederAccessToken='seeder',cleanup=${cleanup};let bodyFailure;try{if(bodyError)throw bodyError;} ${compiledTail}`);
 const bodyError=Error('body assertion failed'),cleanupError=Error('cleanup refused');
 await assert.rejects(run(bodyError,async()=>{throw cleanupError;}),error=>error instanceof AggregateError&&error.errors[0]===bodyError&&error.errors.slice(1).every(item=>item===cleanupError)&&error.errors.length===3);
 await assert.rejects(run(bodyError,async()=>{}),error=>error===bodyError);
 await assert.rejects(run(undefined,async()=>{throw cleanupError;}),error=>error instanceof AggregateError&&error.errors.length===2&&error.errors.every(item=>item===cleanupError));
});
