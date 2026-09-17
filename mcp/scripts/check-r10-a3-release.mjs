#!/usr/bin/env node
import { readFileSync, realpathSync, readdirSync } from 'node:fs';
import { resolve, dirname, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import ts from '../node_modules/typescript/lib/typescript.js';


export function examPdfConsumerCensus(root) {
  const matches = [];
  function visit(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a,b) => a.name.localeCompare(b.name))) {
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile()) {
        const text = readFileSync(path, 'utf8');
        if (text.includes('\0')) continue;
        for (const [index, line] of text.split(/\r?\n/).entries()) {
          if (/exam.{0,30}pdf|pdf.{0,30}exam/i.test(line)) matches.push(`${relative(root,path)}:${index+1}:${line}`);
        }
      }
    }
  }
  for (const directory of ['mcp/src','ui/src','src']) visit(resolve(root,directory));
  return matches;
}

export const FINDING_WRITE_PATH_IDS = Object.freeze(["door-put", "door-audit-repair", "pick-condition", "oh-save-fact", "oh-save-panel", "oh-negative-act", "carry-condition", "carry-plan", "carry-link", "carry-facts", "carry-lineage", "void", "undo", "protocol-commit", "protocol-unapply", "protocol-restore", "mcp-attest", "mcp-amend", "mcp-create-observation", "mcp-scribe-write", "mcp-append-context", "mcp-save-section", "mcp-smoking-status", "mcp-dry-eye-questionnaire-score", "mcp-meibography", "mcp-ortho-k-fit", "mcp-eye-growth"]);
export function findingWriteCensus(root) {
const config=ts.readConfigFile(resolve(root,'mcp/tsconfig.json'),ts.sys.readFile);
const parsed=ts.parseJsonConfigFileContent(config.config,ts.sys,resolve(root,'mcp'));
const program=ts.createProgram(parsed.fileNames,parsed.options),checker=program.getTypeChecker();
const rows=[];
function property(node,key){return ts.isObjectLiteralExpression(node)?node.properties.find(p=>p.name?.getText().replaceAll(/['"]/g,'')===key):undefined;}
function value(node,key){const p=property(node,key);return p&&(ts.isPropertyAssignment(p)?p.initializer:ts.isShorthandPropertyAssignment(p)?p.name:undefined);}
function explicitType(node){return node&&ts.isObjectLiteralExpression(node)?value(node,'resourceType')?.getText().replaceAll(/['\"]/g,''):undefined;}
function typeName(node,key){if(!node)return '';const t=checker.getTypeAtLocation(node),p=checker.getPropertyOfType(t,key);return p?checker.typeToString(checker.getTypeOfSymbolAtLocation(p,node)):'';}
for(const source of program.getSourceFiles()){
 const file=relative(root,source.fileName);if(!file.startsWith('mcp/src/'))continue;
 const counts=new Map();
 function add(node,kind){
  let owner='top-level';
  for(let p=node.parent;p;p=p.parent){
   if(ts.isCaseClause(p)&&ts.isStringLiteral(p.expression)){owner='tool:'+p.expression.text;break;}
   if(ts.isFunctionDeclaration(p)&&p.name){owner=p.name.text;break;}
   if(ts.isMethodDeclaration(p)){owner=p.name.getText(source);break;}
   if(ts.isVariableDeclaration(p)&&p.initializer&&(ts.isArrowFunction(p.initializer)||ts.isFunctionExpression(p.initializer))){owner=p.name.getText(source);break;}
  }
  const key=owner+':'+kind,ordinal=(counts.get(key)||0)+1;counts.set(key,ordinal);
  rows.push({file,function:owner,kind,ordinal,line:source.getLineAndCharacterOfPosition(node.getStart(source)).line+1,expression:node.getText(source).slice(0,160)});
 }
 function walk(node){
  if(ts.isCallExpression(node)){
   const expr=node.expression;
   if(ts.isPropertyAccessExpression(expr)){
    const method=expr.name.text,first=node.arguments[0],generic=node.typeArguments?.some(t=>t.getText(source).includes('Observation'));
    if(['executeTransaction','executeTransactionAsActor'].includes(method))add(node,'transaction-submit');
    else if(['create','createWithOutcome','update','patch'].includes(method)&&(generic||explicitType(first)==='Observation'||first?.getText(source).match(/^['"]Observation['"]$/)||typeName(first,'resourceType').includes('Observation')))add(node,'resource-write');
   } else if(ts.isIdentifier(expr)&&['updateProjected','projectionRestore'].includes(expr.text)){
    const rt=node.arguments[1]?.getText(source);if(rt?.includes('Observation')||rt==='resourceType')add(node,'known-wrapper-call');
   }
  }
  if(ts.isObjectLiteralExpression(node)){
   const resource=value(node,'resource'),request=value(node,'request');
   if(resource&&request){
    const rt=explicitType(resource)||typeName(resource,'resourceType');
    if(rt.includes('Observation'))add(node,'observation-entry');
    else if(rt.includes('Binary')&&/Observation|observationReference/.test(request.getText(source)))add(node,'observation-json-patch-entry');
   }
  }
  ts.forEachChild(node,walk);
 }
 walk(source);
}
return rows;
}
export function checkFindingWriteRegistry(root, registry, exclusions) {
  const failures=[];
  const paths=registry?.paths;
  if(!Array.isArray(paths)) return {failures:['T22: malformed finding write registry'],sites:[],mapped:0,excluded:0};
  for(const id of FINDING_WRITE_PATH_IDS) {
    const count=paths.filter(path=>path.id===id).length;
    if(count!==1) failures.push(`T22: registry ${id} expected exactly once, found ${count}`);
  }
  for(const path of paths) if(!FINDING_WRITE_PATH_IDS.includes(path.id)) failures.push(`T22: unexpected path ${path.id}`);
  const key=site=>JSON.stringify([site.file,site.function,site.kind,site.ordinal]);
  const sites=findingWriteCensus(root), known=new Set(sites.map(key)), mapped=new Set();
  for(const path of paths) {
    if(!Array.isArray(path.sites)) {failures.push(`T22: malformed sites for ${path.id}`);continue;}
    const unique=new Set();
    for(const site of path.sites) {
      const identity=key(site);
      if(unique.has(identity)) failures.push(`T22: duplicate site in ${path.id}: ${identity}`);
      unique.add(identity);mapped.add(identity);
      if(!known.has(identity)) failures.push(`T22: stale site in ${path.id}: ${identity}`);
    }
  }
  const excluded=new Set();
  if(!Array.isArray(exclusions?.sites)) failures.push('T22: malformed exclusions');
  for(const site of exclusions?.sites??[]) {
    const identity=key(site);
    if(!site.reason?.trim()) failures.push(`T22: exclusion lacks reason: ${identity}`);
    if(excluded.has(identity)||mapped.has(identity)) failures.push(`T22: duplicate or mapped exclusion: ${identity}`);
    if(!known.has(identity)) failures.push(`T22: stale exclusion: ${identity}`);
    excluded.add(identity);
  }
  for(const site of sites) if(!mapped.has(key(site))&&!excluded.has(key(site))) failures.push(`T22: unregistered call site ${key(site)} at line ${site.line}`);
  return {failures,sites,mapped: mapped.size,excluded: excluded.size};
}

export const EXPECTED = Object.freeze({
  T1:['mcp'], T2:['mcp'], T3:['mcp'], T4:['ui'], T5:['ui'], T6:['ui'], T7:['mcp'], T8:['mcp'], T9:['mcp'],
  T10:['mcp'], T11:['mcp'], T12:['mcp'], T13:['mcp'], T14:['mcp'], T15:['ui'], T16:['ui'], T17:['mcp','ui'],
  T18:['ui'], T19:['mcp'], T20:['mcp'], T21:['mcp','ui'], T22:['mcp','ui'],
});
export function parseTap(text) {
  const lines=text.replace(/\r/g,'').trimEnd().split('\n');
  if(lines[0]!=='TAP version 13')throw Error('Malformed TAP header');
  const plans=lines.filter(line=>/^1\.\./.test(line));
  const counts=lines.filter(line=>/^# tests /.test(line));
  if(plans.length!==1 || counts.length!==1 || !/^1\.\.\d+$/.test(plans[0]) || !/^# tests \d+$/.test(counts[0]))throw Error('Missing or malformed TAP completion');
  const summary={};
  for(const name of ['pass','fail','cancelled','skipped','todo']) {
    const found=lines.filter(line=>line.startsWith(`# ${name} `));
    if(found.length!==1 || !new RegExp(`^# ${name} \\d+$`).test(found[0]))throw Error('Missing or malformed TAP summary');
    summary[name]=Number(found[0].split(' ').at(-1));
  }
  if(Object.values(summary).reduce((total,count)=>total+count,0)!==Number(counts[0].slice(8)))throw Error('Inconsistent TAP summary');
  if(!/^# duration_ms \d+(?:\.\d+)?$/.test(lines.at(-1)))throw Error('Truncated TAP footer');
  const results=[];
  for(const line of lines.slice(1)) {
    if(!line || /^\s/.test(line) || /^#/.test(line) || line===plans[0])continue;
    const match=/^(not ok|ok) (\d+) - (.+?)(?: # (TODO|SKIP)(?: .*)?)?$/.exec(line);
    if(!match)throw Error(`Malformed TAP line: ${line}`);
    if(Number(match[2])!==results.length+1)throw Error('Nonsequential TAP result');
    results.push({name:match[3],passed:match[1]==='ok',directive:match[4]});
  }
  if(Number(plans[0].slice(3))!==results.length || Number(counts[0].slice(8))!==results.length)throw Error('Truncated or inconsistent TAP');
  if(lines.indexOf(plans[0])<lines.findLastIndex(line=>/^(not ok|ok) /.test(line)))throw Error('Premature TAP completion');
  return results;
}
export function checkRelease(root) {
  const failures=[];
  const fail=(id,message)=>failures.push(`${id}: ${message}`);
  let manifest;
  try {manifest=JSON.parse(readFileSync(resolve(root,'mcp/tests/fixtures/r10/a3-release-scenarios.json'),'utf8'));}
  catch {return Object.keys(EXPECTED).map(id=>`${id}: missing or malformed manifest`);}
  if(!Array.isArray(manifest.scenarios))return Object.keys(EXPECTED).map(id=>`${id}: malformed scenario list`);
  const groups=new Map();
  for(const [id,suites] of Object.entries(EXPECTED))for(const suite of suites){
    const matches=manifest.scenarios.filter(row=>row.id===id&&row.suite===suite);
    if(matches.length!==1){fail(id,`${suite} manifest expected exactly once, found ${matches.length}`);continue;}
    const row=matches[0];
    if(typeof row.file!=='string') {fail(id,`wrong ${suite} file`);continue;}
    let path=resolve(root,row.file);
    if(!row.file.startsWith(`${suite}/tests/`) || relative(root,path).startsWith('..') ||
      !path.startsWith(resolve(root,suite,'tests')+sep)) {fail(id,`wrong ${suite} file`);continue;}
    let suiteRoot;
    try { path=realpathSync(path); suiteRoot=realpathSync(resolve(root,suite,'tests')); }
    catch {fail(id,`missing ${suite} suite ${row.file}`);continue;}
    if(!path.startsWith(suiteRoot+sep)) {fail(id,`wrong ${suite} file`);continue;}
    const group=groups.get(path)??{suite,rows:[]};group.rows.push(row);groups.set(path,group);
  }
  for(const row of manifest.scenarios)if(!EXPECTED[row.id]?.includes(row.suite))fail(row.id??'unknown','unexpected id or wrong suite');
  for(const [path,{suite,rows}] of groups){
    const source=readFileSync(path,'utf8');
    const declarations=[...source.matchAll(/\btest\(\s*["'](T\d+)\s/g)].map(m=>m[1]);
    for(const row of rows)if(declarations.filter(id=>id===row.id).length!==1)fail(row.id,`${suite} code must declare exactly one named test`);
    for(const id of declarations)if(!rows.some(row=>row.id===id))fail(id,`${suite} code has undeclared or wrong-suite scenario`);
    const loader=resolve(dirname(fileURLToPath(import.meta.url)),'../node_modules/tsx/dist/loader.mjs');
    const args=[...(path.endsWith('.ts')?['--import',loader]:[]),'--test','--test-reporter=tap',path];
    const env={...process.env};delete env.NODE_TEST_CONTEXT;
    const child=spawnSync(process.execPath,args,{cwd:root,env,encoding:'utf8',timeout:120000,maxBuffer:16*1024*1024});
    if(child.status!==0 || child.error || child.signal)for(const row of rows)fail(row.id,`${suite} child process failed (${child.status??child.signal??child.error?.code})`);
    let results;
    try {results=parseTap(child.stdout??'');}catch(error){for(const row of rows)fail(row.id,`${suite} ${error.message}`);continue;}
    for(const row of rows){
      const found=results.filter(result=>new RegExp(`^${row.id}\\s`).test(result.name));
      if(found.length!==1){fail(row.id,`${suite} TAP expected exactly once, found ${found.length}`);continue;}
      if(!found[0].passed || found[0].directive)fail(row.id,`${suite} ${found[0].directive??'failure'} remains open`);
    }
    for(const result of results)if(!rows.some(row=>new RegExp(`^${row.id}\\s`).test(result.name)))fail(result.name,'unexpected suite test');
  }
  return failures;
}
if(process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const args=process.argv.slice(2);let root=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
  for(let index=0;index<args.length;index++) {
    if(args[index]==='--strict')continue;
    if(args[index]==='--root' && args[index+1]){root=resolve(args[++index]);continue;}
    console.error(`Unknown argument: ${args[index]}`);process.exit(1);
  }
  const failures=checkRelease(root);
  if(failures.length){console.error('R10 A3 release BLOCKED\n'+failures.join('\n'));process.exitCode=1;}
  else console.log('R10 A3 release PASS: '+Object.keys(EXPECTED).join(', '));
}
