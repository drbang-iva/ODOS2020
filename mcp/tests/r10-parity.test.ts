import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { baseline } from "./fixtures/r10/baseline.js";
import { compatRows, rowContract } from "./fixtures/r10/compat-rows.js";
import { materializeAtomicFindingCatalog } from "../src/clinical-graph/diagnosis-findings-endpoint.js";
import { projectCurrentFindings } from "../src/clinical-graph/current-finding-reader.js";
import { buildExamOverviewProjection } from "../src/clinical-graph/exam-overview-projection.js";
import { findingInstancesFromObservation } from "../src/clinical-graph/diagnosis-candidates-endpoint.js";
import { classifyFindingObservation, observationLaterality } from "../src/clinical-graph/current-finding-identity.js";
import { buildFindingReadAliases } from "../src/clinical-graph/finding-read-aliases.js";
const clean=(v:unknown)=>JSON.parse(JSON.stringify(v));
const captures=baseline.captures;
const recorded: Record<string, unknown> = {};
const divergencePath=new URL("./fixtures/r10/parity-divergences.json",import.meta.url);
const expectedDivergences=process.env.R10_RECORD_DIVERGENCES ? {} : JSON.parse(readFileSync(divergencePath,"utf8"));
function compare(index:number,capture:any,actual:any,expected:any,reasons:string[],projection:any) {
  actual=clean(actual);expected=clean(expected);
  if(JSON.stringify(actual)===JSON.stringify(expected)) {assert.deepEqual(actual,expected);assert.equal(expectedDivergences[index],undefined);return;}
  assert.ok(reasons.length,`Undeclared parity difference at ${index}: ${JSON.stringify({actual,expected})}`);
  const record={suite:capture.suite,kind:capture.kind,reasons,beforeRows:Array.isArray(expected)?expected.length:expected.findings?.length,
    afterRows:Array.isArray(actual)?actual.length:actual.findings?.length,
    actualHash:createHash("sha256").update(JSON.stringify(actual)).digest("hex"),
    facts:projection.currentFacts.length,conflicts:projection.conflicts.length,unresolved:projection.unresolved.length};
  if(process.env.R10_RECORD_DIVERGENCES){recorded[index]=record;writeFileSync(divergencePath,JSON.stringify(recorded,null,2)+"\n");}
  else assert.deepEqual(record,expectedDivergences[index],`Unreviewed divergence at fixture ${index}`);
}
function project(observations:any[],definitions:any[],conditions:any[]=[],catalog=materializeAtomicFindingCatalog(definitions)) {
  return projectCurrentFindings({incomplete:false,observations,definitions,conditions,catalog,patientReference:observations[0]?.subject?.reference??"Patient/p1",encounterReference:observations[0]?.encounter?.reference??"Encounter/e1"});
}
function divergenceReasons(observations:any[],definitions:any[],projection:ReturnType<typeof project>): string[] {
  const reasons=new Set<string>();const catalog=materializeAtomicFindingCatalog(definitions);const aliases=buildFindingReadAliases(definitions,catalog);
  const sections=new Map<string,number>();
  for(const o of observations){const role=classifyFindingObservation(o,definitions,catalog,aliases);
    if(role.kind==="negative-act")reasons.add("negative act remains raw panel context");
    if(role.kind==="panel-context")reasons.add("panel identity is not a clinical finding");
    if(role.kind==="legacy-section-snapshot"){
      const key=`${role.definition!.stableKey}:${observationLaterality(o)}`;sections.set(key,(sections.get(key)??0)+1);
    }
    if(observationLaterality(o)==="OU"&&role.kind!=="unrelated")reasons.add("OU expands into eye facts");
    if(observationLaterality(o)==="UNKNOWN"&&role.kind!=="unrelated")reasons.add("UNKNOWN is unresolved");
    if(o.status==="cancelled"||o.status==="entered-in-error")reasons.add("retired representation is not live");
    if(role.translated)reasons.add("retired atomic alias translated");
  }
  if([...sections.values()].some(n=>n>1))reasons.add("latest snapshot replaces historical snapshots");
  if(projection.conflicts.length)reasons.add("conflict has no invented winner");
  if(projection.definitionViews.some(v=>!v.id))reasons.add("translated or merged view is not linkable");
  if(projection.unresolved.length)reasons.add("unresolved representation remains explicit");
  return [...reasons].sort();
}
for(const [i,c] of captures.entries()){
  if(c.kind==="history")continue;
  test(`legacy fixture ${i+1}: ${c.suite} ${c.kind}`,()=>{
    if(c.kind==="atomicFindingRows"){
      const [observations,catalog,binding]=c.args;
      const section=captures.find((other,j)=>j>i&&other.suite===c.suite&&other.kind==="sectionFindingRows"&&JSON.stringify(other.args[0])===JSON.stringify(observations));
      assert.ok(section,"Every atomic fixture has its actual section fixture/definitions");
      const definitions=section.args[1];const conditions=section.args[3].map((v:any)=>v.condition);
      const p=project(observations,definitions,conditions,catalog);
      const expected=rowContract([...c.result,...section.result]);const actual=rowContract(compatRows(p));
      const reasons=divergenceReasons(observations,definitions,p);
      compare(i+1,c,actual,expected,reasons,p);
    }else if(c.kind==="sectionFindingRows"){
      assert.ok(captures.some(o=>o.suite===c.suite&&o.kind==="atomicFindingRows"&&JSON.stringify(o.args[0])===JSON.stringify(c.args[0])));
    }else if(c.kind==="buildExamOverviewProjection"){
      const input=c.args[0];assert.deepEqual(clean(buildExamOverviewProjection(input)),c.result);
      const p=project(input.currentObservations,input.definitions);
      const next=clean(buildExamOverviewProjection({...input,currentObservations:p.definitionViews}));
      const reasons=divergenceReasons(input.currentObservations,input.definitions,p);
      compare(i+1,c,next,c.result,reasons,p);
    }else if(c.kind==="findingInstancesFromObservation"){
      const [observation,definitions]=c.args;
      assert.deepEqual(clean(findingInstancesFromObservation(observation,definitions)),c.result);
      const p=project([observation],definitions);
      const next=p.definitionViews.flatMap(v=>findingInstancesFromObservation(v,definitions));
      const reasons=divergenceReasons([observation],definitions,p);
      compare(i+1,c,next,c.result,reasons,p);
    }else if(c.kind==="keyFindingSatisfied"){
      const [entry,definition,current,historical]=c.args;
      for(const o of [...current,...historical]){
        const p=project([o],[definition]);
        assert.deepEqual(clean(p.definitionViews.map(({projectionKey,contributors,...r})=>r)),[o]);
        assert.equal(p.currentFacts.length,0);
      }
      assert.ok(["this-encounter","any-on-file"].includes(entry.satisfiedBy));
    }else assert.fail(`Unclassified fixture ${c.kind}`);
  });
}

test("E1–E17 reproduce the original writer/read behaviors and assert the A1 projections", async () => {
  const {execFileSync}=await import("node:child_process");
  const output=execFileSync(process.execPath,["--import","tsx",new URL("./fixtures/r10/premise-replay.ts",import.meta.url).pathname],{encoding:"utf8"});
  const lines=output.trim().split("\n").map(line=>JSON.parse(line));
  assert.equal(lines.filter(row=>row.probe).length,17);
  assert.equal(lines.filter(row=>row.a1Probe&&row.status==="PASS").length,17);
});
