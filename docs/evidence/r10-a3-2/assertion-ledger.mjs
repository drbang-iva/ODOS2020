import ts from '../../../ui/node_modules/typescript/lib/typescript.js';
import {execFileSync} from 'node:child_process';
import {readFileSync,writeFileSync} from 'node:fs';
const files=['ui/tests/examOverviewBoard.test.tsx','ui/tests/ocularSweepValueOnly.test.tsx'];
function assertions(text,file){const source=ts.createSourceFile(file,text,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX),rows=[];function walk(node,test='helper'){if(ts.isCallExpression(node)&&node.expression.getText(source)==='test'&&node.arguments[0])test=node.arguments[0].getText(source);if(ts.isCallExpression(node)&&node.expression.getText(source).startsWith('assert.'))rows.push({test,line:source.getLineAndCharacterOfPosition(node.getStart(source)).line+1,text:node.getText(source)});ts.forEachChild(node,child=>walk(child,test));}walk(source);return rows;}
const ledger=[];
for(const file of files){const before=assertions(execFileSync('git',['show',`a211b368:${file}`],{encoding:'utf8'}),file),after=assertions(readFileSync(file,'utf8'),file);for(const test of new Set([...before,...after].map(a=>a.test))){const old=before.filter(a=>a.test===test),next=after.filter(a=>a.test===test);const removed=old.filter(a=>!next.some(b=>a.text===b.text)),added=next.filter(a=>!old.some(b=>a.text===b.text));if(!removed.length&&!added.length)continue;ledger.push({file,test,row:file.includes('ocularSweep')?'V21 / V22 / W-k':/undo|Undo|STAFF-DX|fixback P2/.test(test)?'V36 / W144':'V21 / W-k',before:removed,after:added});}}
writeFileSync('docs/evidence/r10-a3-2/root-assertion-ledger.json',JSON.stringify(ledger,null,2)+'\n');
console.log(`${ledger.length} changed assertion groups; exact source and line numbers recorded`);
