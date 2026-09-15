import ts from 'typescript';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
const base='52c6ec4926e95e78344082add8522e74743ffb33';
const files=['mcp/src/__tests__/protocol-phase5.test.ts','mcp/tests/procedureChargeMaterialization.test.ts','mcp/src/__tests__/gonioscopy-phase5.test.ts'];
const printer=ts.createPrinter({removeComments:true});
const hash=s=>createHash('sha256').update(s).digest('hex');
function tests(source,file) {
 const sf=ts.createSourceFile(file,source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TS), found=[];
 const print=node=>printer.printNode(ts.EmitHint.Unspecified,node,sf);
 function walk(node) {
  if(ts.isCallExpression(node) && (node.expression.getText(sf)==='test' || node.expression.getText(sf).startsWith('test.'))) {
   const fn=node.arguments.find(a=>ts.isArrowFunction(a)||ts.isFunctionExpression(a));
   if(fn?.body) {
    const assertions=[];
    function collect(n) {if(ts.isCallExpression(n)&&n.expression.getText(sf).startsWith('assert.'))assertions.push(print(n));ts.forEachChild(n,collect);}
    collect(fn.body);
    found.push({name:print(node.arguments[0]),bodyHash:hash(print(fn.body)),assertionHash:hash(JSON.stringify(assertions)),assertionCount:assertions.length});
   }
  }
  ts.forEachChild(node,walk);
 }
 walk(sf);return found;
}
const reports=files.map(file=>{
 const before=tests(execFileSync('git',['show',`${base}:${file}`],{encoding:'utf8'}),file), after=tests(readFileSync(file,'utf8'),file);
 const rows=before.map((old,i)=>{const current=after[i];if(!current||current.name!==old.name)throw Error(`Missing/reordered test ${file} ${old.name}`);return {...old,bodyUnchanged:old.bodyHash===current.bodyHash,assertionsUnchanged:old.assertionHash===current.assertionHash,finalBodyHash:current.bodyHash};});
 return {file,baselineTestBodies:before.length,finalTestBodies:after.length,allAssertionsUnchanged:rows.every(r=>r.assertionsUnchanged),bodyExceptions:rows.filter(r=>!r.bodyUnchanged).map(r=>r.name),tests:rows};
});
if(reports.some(r=>!r.allAssertionsUnchanged))throw Error('Pre-existing assertion changed');
const exceptions=reports.flatMap(r=>r.bodyExceptions);
if(exceptions.length!==1||!exceptions[0].includes('shared rollback endpoint:'))throw Error(`Unexpected body changes ${exceptions}`);
const result={base,head:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),reports,exceptionReason:'Parameterized rollback route test: finding case explicitly saves staff-published legacy v1 because generated v2 no longer has finding-seeds. Assertions unchanged. EndpointFhir helper gains sidecar version metadata and If-Match enforcement; helper is not a test body. Other changes in mandatory files are import alias only.'};
writeFileSync('docs/build-log/plan-authoring-1a/test-preservation.json',JSON.stringify(result,null,2)+'\n');
console.log(JSON.stringify(reports.map(({tests,...summary})=>summary),null,2));
