import assert from "node:assert/strict";
import test from "node:test";
import { saveGuarantor } from "../../ui/src/lib/guarantor-editor.js";
import { world, withEditor, snapshot, wire, store, get, PROJECT, SERVICE } from "./helpers/guarantor-phone-fixture.js";
import { CensusFixtureFhir } from "./helpers/guarantor-census-writer-fixture.js";
import { collectGuarantorCensus, createReadOnlyGuarantorCensusFhir } from "../../scripts/guarantor-census.js";

test("D3 writer-derived DOB edit preserves both child insurance fingerprints and census", async () => {
 const f = await world();
 const before = ["r1","r2"].map((id,i) => wire({...get(f,`RelatedPerson/${id}`),birthDate:`197${i}-01-02`,meta:{...get(f,`RelatedPerson/${id}`).meta,author:{reference:SERVICE}}}));
 before.forEach(r=>store(f,r));
 await withEditor(f,async()=>{
  const loaded = await snapshot();
  assert.equal(loaded.person.birthDate,"1980-01-02","fixture comes from actual registration Person writer");
  const result = await saveGuarantor(loaded,wire({...loaded.person,birthDate:"1981-03-04"}));
  assert.equal(result.status,"saved");
 });
 assert.equal(get(f,"Person/S").birthDate,"1981-03-04");
 const after = before.map(r=>wire({...get(f,`RelatedPerson/${r.id}`),meta:{...get(f,`RelatedPerson/${r.id}`).meta,author:{reference:"Practitioner/editor"}}}));
 assert.deepEqual(after.map(r=>r.birthDate),before.map(r=>r.birthDate));
 const coverage = before.map((r,i)=>({resourceType:"Coverage",id:`coverage-${i}`,meta:{project:PROJECT},status:"active",beneficiary:r.patient,subscriber:{reference:`RelatedPerson/${r.id}`},payor:[{reference:"Organization/payer"}]}));
 const transport = new CensusFixtureFhir(wire({resources:[...f.data.values()].filter((r:any)=>!before.some(b=>b.id===r.id)),histories:before.map((r,i)=>[`RelatedPerson/${r.id}`,[after[i],r]])}) as never);
 after.forEach(r=>transport.resources.push(r));
 coverage.forEach(r=>transport.resources.push(r as never));
 const census = await collectGuarantorCensus(createReadOnlyGuarantorCensusFhir(transport as never),{today:"2026-09-15",serviceReference:SERVICE});
 assert.equal(census.summary.projects.reduce((sum,r)=>sum+r.insuranceDamage.coverageCount,0),2);
 assert.equal(census.summary.projects.reduce((sum,r)=>sum+r.insuranceDamage.suspectedOverwrites,0),0);
});
