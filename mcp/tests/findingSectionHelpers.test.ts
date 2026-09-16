import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { handleCustomSectionHistoryRequest } from "../src/clinical-graph/custom-section-endpoint.js";
import { baseline } from "./fixtures/r10/baseline.js";

test("six original suites remain byte-identical to their captured baseline", () => {
  for (const [file,hash] of Object.entries(baseline.suiteHashes)) {
    assert.equal(createHash("sha256").update(readFileSync(new URL(`./${file}`,import.meta.url))).digest("base64"), hash, file);
  }
  assert.deepEqual([...new Set(baseline.captures.map(c=>c.suite))].sort(),Object.keys(baseline.suiteHashes).sort());
});
for (const [index,capture] of baseline.captures.filter(c=>c.kind==="history").entries()) {
  test(`history bytes unchanged ${index+1}: ${capture.suite}`,async()=>{
    const [definition,bundle,input]=capture.args;
    const response=await handleCustomSectionHistoryRequest({ findingDefinitions:()=>[definition],
      authenticate:async()=>({actorRole:"provider",staffReference:"Practitioner/synthetic",fhir:{search:async()=>structuredClone(bundle),create:async(r:any)=>r}}),
    },input);
    assert.equal(JSON.stringify(response),JSON.stringify(capture.result));
  });
}
