import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, cpSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { spawnSync } from "node:child_process";
import * as checker from "../scripts/check-r10-a3-release.mjs";

const fixture = resolve(import.meta.dirname, "fixtures/r10/a3-checker-green");
const script = resolve(import.meta.dirname, "../scripts/check-r10-a3-release.mjs");
function withFixture(run: (root: string) => void) {
  const root=mkdtempSync(join(tmpdir(),"r10-a3-gate-"));
  try { cpSync(fixture,root,{recursive:true}); run(root); } finally { rmSync(root,{recursive:true,force:true}); }
}
const check=(root:string)=>spawnSync(process.execPath,[script,"--strict","--root",root],{encoding:"utf8"});

test("W40 complete green fixture satisfies the fixed A3 scenario set",()=>withFixture(root=>{
  const result=check(root); assert.equal(result.status,0,result.stdout+result.stderr); assert.match(result.stdout,/T1.*T22/s);
}));
for(const mode of ["delete-test","delete-test-and-manifest","skip","todo","failure","wrong-suite","duplicate","child-failure"])
  test(`W40 strict rejects ${mode} and names T1`,()=>withFixture(root=>{
    const file=join(root,"mcp/tests/scenarios.test.mjs");let text=readFileSync(file,"utf8");
    if(mode.startsWith("delete-test"))text=text.split("\n").filter(line=>!line.startsWith('test("T1 ')).join("\n");
    if(mode==="delete-test-and-manifest"){
      const manifest=join(root,"mcp/tests/fixtures/r10/a3-release-scenarios.json");const data=JSON.parse(readFileSync(manifest,"utf8"));
      data.scenarios=data.scenarios.filter((r:{id:string})=>r.id!=="T1");writeFileSync(manifest,JSON.stringify(data));
    }
    if(mode==="skip"||mode==="todo")text=text.replace('test("T1 scenario",',`test("T1 scenario", { ${mode}: "R10 A3" },`);
    if(mode==="failure")text=text.replace('test("T1 scenario",()=>assert.equal(1,1));','test("T1 scenario",()=>assert.equal(1,2));');
    if(mode==="child-failure")text+='\nprocess.exitCode=2;\n';
    if(mode==="duplicate")text+='\ntest("T1 duplicate",()=>assert.equal(1,1));\n';
    if(mode==="wrong-suite"){
      const manifest=join(root,"mcp/tests/fixtures/r10/a3-release-scenarios.json");const data=JSON.parse(readFileSync(manifest,"utf8"));
      data.scenarios.find((r:{id:string})=>r.id==="T1").suite="ui";writeFileSync(manifest,JSON.stringify(data));
    }
    writeFileSync(file,text); const result=check(root); assert.equal(result.status,1,result.stdout+result.stderr); assert.match(result.stdout+result.stderr,/T1\b/);
}));
for(const [name,tap] of Object.entries({truncated:"TAP version 13\nok 1 - T1 scenario\n",malformed:"not TAP",wrongPlan:"TAP version 13\nok 1 - T1 scenario\n1..2\n# tests 1\n# pass 1\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n# duration_ms 1\n",duplicateNumber:"TAP version 13\nok 1 - T1 scenario\nok 1 - T2 scenario\n1..2\n# tests 2\n# pass 2\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n# duration_ms 1\n"}))
  test(`W40 strict TAP parser rejects ${name}`,()=>assert.throws(()=>checker.parseTap(tap)));

test("W40 TAP completion requires every final summary and duration",()=>{
  assert.throws(()=>checker.parseTap("TAP version 13\nok 1 - T1 scenario\n1..1\n# tests 1\n"));
});
