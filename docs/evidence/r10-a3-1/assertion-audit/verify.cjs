const fs=require('fs'),cp=require('child_process'),ts=require(process.cwd()+'/mcp/node_modules/typescript');
const base='1706d7c8417b04791471d4332b4ecd712883bf11',root='docs/evidence/r10-a3-1/',printer=ts.createPrinter({removeComments:true}),cache=new Map();
function parse(text,file){const sf=ts.createSourceFile(file,text,ts.ScriptTarget.Latest,true),rows=[];function visit(n,context='helper'){if(ts.isFunctionDeclaration(n)&&n.name)context=n.name.text;if(ts.isCallExpression(n)&&n.expression.getText(sf)==='test')context=n.arguments[0].getText(sf);if(ts.isCallExpression(n)&&(n.expression.getText(sf).startsWith('assert.')||n.expression.getText(sf)==='assert'))rows.push({file,line:sf.getLineAndCharacterOfPosition(n.getStart(sf)).line+1,context,text:n.getText(sf),norm:printer.printNode(ts.EmitHint.Unspecified,n,sf)});ts.forEachChild(n,c=>visit(c,context));}visit(sf);return rows;}
function source(file,old=false){const id=(old?'base:':'now:')+file;if(!cache.has(id))cache.set(id,parse(old?cp.execFileSync('git',['show',base+':'+file],{encoding:'utf8'}):fs.readFileSync(file,'utf8'),file));return cache.get(id);}
function norm(text){return parse(text,'fragment.ts')[0]?.norm;}
const ledgerPaths=['core-assertion-migrations.json','ocular/assertion-migrations.json','carry/assertion-ledger.json','library/link-l2-assertions.json','void-undo/assertion-migrations.json','overview/assertion-migrations.json','protocol/assertion-migrations.json','release/t17-t21-assertions.json','release/carry-assertion-migration.json','release/void-assertion-migration.json','release/t22-assertion-migration.json','assertion-audit/rev26-normalized-mappings.json'];
const mappings=[],ledgerIssues=[];
for(const path of ledgerPaths){const d=JSON.parse(fs.readFileSync(root+path)),rows=Array.isArray(d)?d:d.mappings??d.assertions??[];for(const row of rows){
 if(row.before==null)continue;
 const file=row.file??(path==='carry/assertion-ledger.json'?'mcp/tests/diagnosisCarryForward.test.ts':typeof d.scope==='string'&&d.scope.startsWith('mcp/')?d.scope:undefined);
 const before=typeof row.before==='string'?row.before:row.before.text??row.before.assertion,line=row.before.line??row.line;
 const contracts=row.rows??row.row??row.contract??row.contracts??d.rows;
 const beforeNorm=norm(before??'');
 if(!file||!beforeNorm||!contracts){ledgerIssues.push({path,reason:'missing file/exact before/contract',row});continue;}
 const candidates=source(file,true).filter(a=>a.norm===beforeNorm),original=candidates.find(a=>a.line===line)??(candidates.length===1?candidates[0]:undefined);
 if(!original){ledgerIssues.push({path,file,line,reason:'base assertion not uniquely anchored',before});continue;}
 if(row.removed===true){
  if(!row.removalReason || !row.evidence || !Array.isArray(row.after) || row.after.length){ledgerIssues.push({path,file,line,reason:'explicit removal requires evidence, reason, and empty after array'});continue;}
  mappings.push({ledger:root+path,before:{file:original.file,line:original.line,context:original.context,text:original.text},after:[],contracts,removed:true,removalReason:row.removalReason,evidence:root+row.evidence});continue;
 }
 let after=row.afterAssertions??row.after;
 if(row.afterAssertionIds)after=row.afterAssertionIds.map(id=>d.afterAssertions.find(a=>a.id===id));
 after=Array.isArray(after)?after:[after];
 const resolved=[];
 for(const a of after){if(!a||typeof a==='string'){ledgerIssues.push({path,file,line,reason:'after is prose/missing'});continue;}const afterFile=a.file??file,afterText=a.text??a.assertion,afterNorm=norm(afterText??'');const current=source(afterFile).filter(x=>x.norm===afterNorm);if(!current.length)ledgerIssues.push({path,file,line,afterFile,afterText,reason:'after assertion absent from final source'});else {const chosen=current.find(x=>x.line===a.line)??(a.test?current.find(x=>x.context===a.test):undefined)??current.find(x=>x.context===a.context)??(current.length===1?current[0]:undefined);if(!chosen)ledgerIssues.push({path,file,line,afterFile,afterText,reason:'after exact assertion ambiguous'});else resolved.push({file:chosen.file,line:chosen.line,context:chosen.context,text:chosen.text});}}
 if(resolved.length)mappings.push({ledger:root+path,before:{file:original.file,line:original.line,context:original.context,text:original.text},after:resolved,contracts});
}}
const files=cp.execFileSync('git',['diff','--name-only',base,'--','mcp/tests','mcp/src/__tests__','ui/src'],{encoding:'utf8'}).trim().split('\n').filter(Boolean),result=[],gaps=[];
function alternativeContext(b){let name;try{name=JSON.parse(b.context);}catch{return b.context;}if(b.file.endsWith('customSectionEndpoint.test.ts'))return JSON.stringify(name.replace(/,?\s*(and )?(round-trip|round trip|persists|rehydrate|rehydrates|resave|resaves).*$/,'')+' — seed contract');return JSON.stringify(name.replace('empty visit slot or an unknown section returns 404','empty visit slot or an unknown section returns 409'));}
for(const file of files){const before=source(file,true),after=source(file),used=new Set();let retained=0,mapped=0;for(const b of before){const i=after.findIndex((a,i)=>!used.has(i)&&a.norm===b.norm&&(a.context===b.context||a.context===alternativeContext(b)));if(i>=0){used.add(i);retained++;continue;}const matches=mappings.filter(m=>m.before.file===file&&m.before.line===b.line&&norm(m.before.text)===b.norm);if(matches.length){mapped++;continue;}gaps.push({file,line:b.line,context:b.context,before:b.text,reason:'no retained contextual assertion and no exact mapped row'});}result.push({file,before:before.length,after:after.length,retained,mapped,gaps:before.length-retained-mapped});}
const output={base,files:result,originalAssertions:result.reduce((s,r)=>s+r.before,0),retained:result.reduce((s,r)=>s+r.retained,0),mappedChanges:result.reduce((s,r)=>s+r.mapped,0),explicitRemovals:mappings.filter(m=>m.removed).length,gaps,ledgerIssues,validatedMappings:mappings};fs.writeFileSync('docs/evidence/r10-a3-1/assertion-audit/result.json',JSON.stringify(output,null,2)+'\n');console.log(JSON.stringify({...output,validatedMappings:undefined,ledgerIssues:ledgerIssues.map(x=>({...x,row:undefined})),gaps},null,2));

const supplemental=['rev26-reader-proof/assertion-ledger.md','rev26-reader-proof/overview-expectation-delta.json','rev26-reader-proof/field-identities-delta.json','rev26-protocol-proof/assertion-ledger.json','rev26-protocol-proof/fixture-ledger.md','rev26-premise-replay/assertion-ledger.json'];
const digestPaths=[...new Set([...files,...ledgerPaths.map(p=>root+p),...supplemental.map(p=>root+p),'mcp/tests/fixtures/r10/a3-overview-expectations.json','mcp/tests/fixtures/r10/legacy-baseline.json','mcp/tests/fixtures/r10/parity-divergences.json',root+'assertion-audit/verify.cjs'])].sort();
const digests=Object.fromEntries(digestPaths.map(file=>[file,require('crypto').createHash('sha256').update(fs.readFileSync(file)).digest('hex')]));
fs.writeFileSync(root+'assertion-audit/source-digests.json',JSON.stringify(digests,null,2)+'\n');
if(gaps.length || ledgerIssues.length) process.exitCode=1;
