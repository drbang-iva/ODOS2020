import assert from "node:assert/strict";
import { test } from "node:test";
import { signedEncounterIds } from "../src/clinic/encounter-sign-off.js";
test("O22 exact instant, not the same second, signs a finished Encounter",()=>{
 const encounters:any[]=[{resourceType:"Encounter",id:"e",status:"finished",period:{end:"2026-09-23T16:00:00Z"}}];
 const proof=(recorded:string,target="Encounter/e"):any=>({resourceType:"Provenance",recorded,target:[{reference:target}]});
 assert.deepEqual([...signedEncounterIds(encounters,[proof("2026-09-23T16:00:00.001Z")])],[]);
 assert.deepEqual([...signedEncounterIds(encounters,[proof("2026-09-23T12:00:00-04:00")])],["e"]);
 assert.equal(signedEncounterIds(encounters,[proof("invalid")]).size,0);
 assert.equal(signedEncounterIds(encounters,[proof("2026-09-23T16:00:00Z","Patient/e")]).size,0);
 assert.equal(signedEncounterIds([{...encounters[0],status:"arrived"}],[proof("2026-09-23T16:00:00Z")]).size,0);
});
