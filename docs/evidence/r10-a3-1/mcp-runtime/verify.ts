import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { runMcpWritePaths } from '../../../../mcp/tests/fixtures/r10/mcp-write-paths.js';
async function main() {
 const rows=await runMcpWritePaths();
 const expected=['mcp-create-observation','mcp-scribe-write','mcp-save-section','mcp-append-context','mcp-attest','mcp-amend','mcp-smoking-status','mcp-dry-eye-questionnaire-score','mcp-meibography','mcp-ortho-k-fit','mcp-eye-growth'];
 assert.deepEqual(rows.map(r=>r.id).sort(),expected.sort(),'Every real MCP write path must execute');
 for(const row of rows){
  assert.equal(row.responseStatus,200,row.id);
  assert.ok(row.observations.some(o=>o.stage==='attempted') || row.patchProjections.length===2,`${row.id} attempts Observation writes or real Binary patches`);
  assert.ok(row.observations.some(o=>o.stage==='persisted'),`${row.id} persists Observation writes`);
  assert.ok(row.attempted.length>0,row.id);
  assert.equal(row.rejection.attempted.length,0,`${row.id} rejection writes`);
 }
 console.log(JSON.stringify(rows.map(r=>({id:r.id,attempted:r.attempted.length,persisted:r.persisted.length,observations:r.observations.map(o=>({stage:o.stage,kind:o.kind})),rejectionStatus:r.rejection.responseStatus,refusalControls:r.controls.length,builderControls:r.builderControls.length})),null,2));
 writeFileSync(new URL('./mcp-runtime-evidence.json',import.meta.url),JSON.stringify(rows,null,2)+'\n');
 console.log('11/11 real MCP runtime paths verified');
}
main().catch(e=>{console.error(e);process.exitCode=1;});
