import assert from "node:assert/strict";
import { test } from "node:test";
import { handleCustomSectionHistoryRequest } from "../src/clinical-graph/custom-section-endpoint.js";
import { baseline } from "./fixtures/r10/baseline.js";

test("captured suites match the suiteHashes provenance keys", () => {
  assert.deepEqual([...new Set(baseline.captures.map(c=>c.suite))].sort(),Object.keys(baseline.suiteHashes).sort());
});
for (const [index,capture] of baseline.captures.filter(c=>c.kind==="history").entries()) {
  test(`history preserves legacy rows and exposes shared read-only projection ${index+1}: ${capture.suite}`,async()=>{
    const [definition,bundle,input]=capture.args;
    const response=await handleCustomSectionHistoryRequest({ findingDefinitions:()=>[definition],
      authenticate:async()=>({actorRole:"provider",staffReference:"Practitioner/synthetic",fhir:{baseUrl:"https://synthetic.invalid",read:async(type:string,id:string)=>{assert.equal(type,"Encounter");return {resourceType:"Encounter",id,status:"in-progress",subject:{reference:input.query.patient}}},
        search:async(type:string,query:Record<string,string>)=>type==="Observation"?{...structuredClone(bundle),entry:bundle.entry?.filter((e:any)=>!query.encounter||e.resource.encounter?.reference===query.encounter)}:{resourceType:"Bundle",type:"searchset",entry:[]},create:async(r:any)=>r}}),
    },input);
    if (definition.valueSchema.type !== "ocular-health-structure") {
      assert.equal(JSON.stringify(response),JSON.stringify(capture.result));
      return;
    }
    assert.equal(response.status, 200);
    const body=response.body as any;
    const encounters=input.query.encounter?[body]:body.encounters;
    const legacy=(bundle.entry??[]).some((e:any)=>!e.resource.identifier?.some((id:any)=>id.system==="urn:odos:negative-act"));
    assert.deepEqual(body.rows, legacy?capture.result.body.rows:[]);
    assert.deepEqual(encounters.map((e:any)=>e.encounterReference),input.query.encounter?[input.query.encounter]:[...new Set((bundle.entry??[]).map((e:any)=>e.resource.encounter.reference))]);
    for(const encounter of encounters) {
      assert.equal(encounter.encounterEditable,!legacy);
      assert.equal(encounter.readOnlyReason,legacy?"pre-rebuild-test-encounter":undefined);
      for(const eye of ["OD","OS"]) {
        assert.equal(encounter.eyes[eye].encounterEditable,!legacy);
        assert.equal(encounter.eyes[eye].panel.editable,!legacy);
        assert.ok(encounter.eyes[eye].facts.every((fact:any)=>fact.editable===!legacy));
        assert.deepEqual(encounter.eyes[eye].negativeActs.map((act:any)=>act.source.reference).sort(),(bundle.entry??[]).filter((e:any)=>e.resource.identifier?.some((id:any)=>id.system==="urn:odos:negative-act")&&e.resource.extension?.some((ext:any)=>ext.valueCodeableConcept?.coding?.some((c:any)=>c.code===eye))&&e.resource.status!=="entered-in-error").map((e:any)=>`Observation/${e.resource.id}`).sort());
      }
    }
  });
}
