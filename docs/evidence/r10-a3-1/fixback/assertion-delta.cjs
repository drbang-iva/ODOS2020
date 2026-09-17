const fs=require('fs'),cp=require('child_process'),ts=require(process.cwd()+'/mcp/node_modules/typescript');
const base='3c14565e6e9b42241f413bb3af89fce69867bd7c',printer=ts.createPrinter({removeComments:true});
function assertions(text,file){const sf=ts.createSourceFile(file,text,ts.ScriptTarget.Latest,true),rows=[];function walk(n){if(ts.isCallExpression(n)&&n.expression.getText(sf).startsWith('assert.'))rows.push({line:sf.getLineAndCharacterOfPosition(n.getStart(sf)).line+1,text:n.getText(sf),norm:printer.printNode(ts.EmitHint.Unspecified,n,sf)});ts.forEachChild(n,walk)}walk(sf);return rows;}
const files=cp.execFileSync('git',['diff','--name-only',base,'--','mcp/tests'],{encoding:'utf8'}).trim().split('\n').filter(f=>f.endsWith('.ts'));const results=[];
for(const file of files){const before=assertions(cp.execFileSync('git',['show',base+':'+file],{encoding:'utf8'}),file),after=assertions(fs.readFileSync(file,'utf8'),file),used=new Set(),changed=[];for(const row of before){const i=after.findIndex((x,i)=>!used.has(i)&&x.norm===row.norm);if(i>=0)used.add(i);else changed.push(row)}const added=after.filter((_,i)=>!used.has(i));
const mapped=changed.map(row=>{let contracts,evidence,replacements;
if(file.endsWith('r10A3ReleaseScenarios.test.ts')&&row.text.includes('census.')){contracts=['W40','F3 explicit evaluation ruling'];evidence='F3-scratch-red.txt / F3-scratch-green.txt';replacements=added.filter(x=>x.text.includes('census,'));}
else if(file.endsWith('r10OcularHealthDoorAuthzLive.test.ts')&&(row.text.includes('session.user')||row.text.includes('serviceActor,'))){contracts=['V35','W115','F4'];evidence='authz.txt / F4 mutation proof';replacements=added.filter(x=>/session\.(profile|user)|serviceActor,/.test(x.text));}
else throw Error('UNMAPPED CHANGED ASSERTION '+file+':'+row.line+' '+row.text);
return {before:row,after:replacements,contracts,evidence};});
results.push({file,oldCount:before.length,newCount:after.length,retained:used.size,changed:mapped,added:added.length});}
fs.writeFileSync('docs/evidence/r10-a3-1/fixback/assertion-delta.json',JSON.stringify({base,results,unmapped:0},null,2)+'\n');console.log(JSON.stringify(results.map(x=>({file:x.file,retained:x.retained,changed:x.changed.length,added:x.added}))));
