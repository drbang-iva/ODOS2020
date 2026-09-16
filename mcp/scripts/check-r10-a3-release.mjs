#!/usr/bin/env node
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

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
    const path=resolve(root,row.file);
    if(!row.file.startsWith(`${suite}/tests/`) || relative(root,path).startsWith('..') ||
      !path.startsWith(resolve(root,suite,'tests')+sep)) {fail(id,`wrong ${suite} file`);continue;}
    if(!existsSync(path)){fail(id,`missing ${suite} suite ${row.file}`);continue;}
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
