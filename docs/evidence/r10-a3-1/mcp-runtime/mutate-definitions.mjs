import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
const cases=[['create_observation','mcp-create-observation'],['scribe_write_observation','mcp-scribe-write'],['save_section_observations','mcp-save-section'],['append_observation_context','mcp-append-context'],['clinician_attest_observation','mcp-attest'],['amend_observation','mcp-amend'],['create_smoking_status_observation','mcp-smoking-status'],['create_dry_eye_questionnaire_response','mcp-dry-eye-questionnaire-score'],['create_meibography_observation','mcp-meibography'],['record_ortho_k_fit_observation','mcp-ortho-k-fit'],['record_eye_growth_axial_length_measurement','mcp-eye-growth']];
const selected=process.argv.slice(2); const dir='docs/evidence/r10-a3-1/mcp-runtime/mutations';mkdirSync(dir,{recursive:true});
const path='mcp/src/index.ts';const original=readFileSync(path);const source=original.toString();
const hash=createHash('sha256').update(original).digest('hex');
for(const [tool,id] of cases.filter(([,id])=>!selected.length||selected.includes(id))){
 const needle=`case "${tool}": {`;assert.equal(source.split(needle).length-1,1);
 const start=source.indexOf(needle),end=source.indexOf('\n        case ',start+needle.length);assert.ok(end>start);
 const before=source.slice(start,end);assert.equal(source.split(before).length-1,1);
 const lookup='await findingDefinitionStore.list()';assert.equal(before.split(lookup).length-1,1,tool);
 const after=before.replace(lookup,"findingDefinitionStore['seeds']");assert.notEqual(before,after);
 const run=()=>spawnSync('mcp/node_modules/.bin/tsx',['docs/evidence/r10-a3-1/mcp-runtime/verify.ts'],{encoding:'utf8',timeout:60000,maxBuffer:8*1024*1024});
 try{
  assert.deepEqual(readFileSync(path),original,'Source changed before mutation');writeFileSync(path,source.replace(before,after));
  const red=run();const output=red.stdout+red.stderr;writeFileSync(`${dir}/W114-${id}-red.txt`,output);assert.equal(red.signal,null);assert.ok(red.status!==null&&red.status!==0,`${id} survived`);assert.match(output,/AssertionError/);assert.match(output,new RegExp(id));assert.doesNotMatch(output,/ReferenceError|SyntaxError|Unsupported synthetic/);
  writeFileSync(path,original);const green=run();writeFileSync(`${dir}/W114-${id}-green.txt`,green.stdout+green.stderr);assert.equal(green.status,0,`${id} restored baseline failed`);assert.deepEqual(readFileSync(path),original);
  const result={guard:'W114',id,tool,beforeSha256:hash,restoredSha256:createHash('sha256').update(readFileSync(path)).digest('hex'),redExit:red.status,greenExit:green.status,mutation:'Relevant tool definition lookup uses actual FhirFindingDefinitionStore compiled seeds instead of effective list'};
  writeFileSync(`${dir}/W114-${id}.json`,JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result));
 }finally{writeFileSync(path,original);assert.deepEqual(readFileSync(path),original);}
}
