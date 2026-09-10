import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import type { Basic, Bundle, Resource } from "@medplum/fhirtypes";
import { createFhirEducationEnrollmentStore, type NewEducationEnrollment } from "../src/comms/education-enrollment.js";
import { admitScheduledAttempt, claimScheduledAttempt, readScheduledEnrollment, rearmScheduledAttempt } from "../src/comms/education-sequence-store.js";
const at = "2026-09-10T14:00:00.000Z";
const actor = "Practitioner/synthetic";
function fixture() {
  let persisted: Basic;
  const fhir = {
    async search<T extends Resource>(): Promise<Bundle<T>> { return { resourceType: "Bundle", type: "searchset", entry: [] }; },
    async create<T extends Resource>(resource: T): Promise<T> { persisted = {...structuredClone(resource) as Basic, meta: {versionId: randomUUID()}}; return structuredClone(persisted) as T; },
    async read<T extends Resource>(): Promise<T> { return structuredClone(persisted) as T; },
    async update<T extends Resource>(_type: string, _id: string, resource: T, headers?: Record<string,string>): Promise<T> {
      if (headers?.["If-Match"] !== `W/"${persisted.meta!.versionId}"`) throw Object.assign(new Error("stale"), {status:412});
      persisted = {...structuredClone(resource) as Basic, meta:{versionId:randomUUID()}}; return structuredClone(persisted) as T;
    },
  };
  const input: NewEducationEnrollment = { patientReference:"Patient/synthetic", journey:{id:"journey",version:1}, currentStageId:"start", stageEnteredAt:at, enteredFromEncounterReference:"Encounter/synthetic", enrolledBy:actor, status:"active", stageHistory:[{stageId:"start",enteredAt:at,enteredBy:actor,reason:"enrollment-recorded"}], immediateSends:[], requestId:"initial", sequence:{id:"sequence",version:1,steps:[{stepIndex:0,channel:"sms",lane:"clinical",content:{id:"content",version:1},recipientReference:"Patient/synthetic",plannedAt:at,notBefore:at,latestUsefulTime:"2026-09-15T14:00:00.000Z",anchor:"stage-entry",offsetDays:1,dayInterpretation:"calendar",timezone:"America/New_York"}]}};
  return { fhir, store:createFhirEducationEnrollmentStore(fhir), input, removeVersion() {delete persisted.meta;}};
}
test("scheduled admission binds one stable attempt and claim is version checked", async () => {
 const db=fixture(); const initial=await db.store.create(db.input); const snapshot=await readScheduledEnrollment(db.fhir,initial.id); const id=initial.scheduledSends![0].id;
 const admitted=await admitScheduledAttempt(db.fhir,snapshot,id,at);
 assert.equal(admitted.enrollment.immediateSends.length,1); assert.equal(admitted.enrollment.scheduledSends![0].attempts.length,1);
 const key=admitted.enrollment.scheduledSends![0].attempts[0].attemptKey;
 assert.ok(key.startsWith("education-sequence-")); assert.equal(admitted.enrollment.immediateSends[0].idempotencyKey,key);
 const replay=await admitScheduledAttempt(db.fhir,admitted,id,at); assert.equal(replay.enrollment.immediateSends.length,1);
 const claimed=await claimScheduledAttempt(db.fhir,replay,id,at); assert.equal(claimed.claimed,true); assert.equal(claimed.enrollment.immediateSends[0].state,"in-flight");
 await assert.rejects(claimScheduledAttempt(db.fhir,replay,id,at),/stale-enrollment-version/);
});
for(const stop of ["stop","stage-change","same-stage-reentry"] as const) test(`scheduled admission cannot overwrite ${stop} committed after its read`, async()=>{
 const db=fixture(); const initial=await db.store.create(db.input); const snapshot=await readScheduledEnrollment(db.fhir,initial.id);
 if(stop==="stop") await db.store.stopSequence(initial.id,{activationId:initial.activations![0].id,actor,at,reason:"clinician-stop"});
 else await db.store.transition(initial.id,{fromStageId:"start",targetStageId:stop==="stage-change"?"next":"start",enteredAt:at,enteredBy:actor,trigger:"clinician-action",status:"active",immediateSends:[]});
 await assert.rejects(admitScheduledAttempt(db.fhir,snapshot,initial.scheduledSends![0].id,at),/stale-enrollment-version/);
 const final=(await db.store.read(initial.id))!; assert.equal(final.scheduledSends![0].disposition,"cancelled"); assert.equal(final.immediateSends.length,0);
});
test("missing enrollment version fails closed before admission",async()=>{const db=fixture();const initial=await db.store.create(db.input);db.removeVersion();await assert.rejects(async()=>admitScheduledAttempt(db.fhir,await readScheduledEnrollment(db.fhir,initial.id),initial.scheduledSends![0].id,at),/version is required/);});

test("one quiet-hours successor preserves terminal attempt and survives repeated reconciliation",async()=>{
 const db=fixture();const initial=await db.store.create(db.input);const id=initial.scheduledSends![0].id;
 let snapshot=await admitScheduledAttempt(db.fhir,await readScheduledEnrollment(db.fhir,initial.id),id,at);
 snapshot=await claimScheduledAttempt(db.fhir,snapshot,id,at);
 const outcome={outcome:"rescheduled" as const,reason:"quiet-hours" as const,rescheduledAt:"2026-09-11T12:00:00.000Z"};
 await db.store.recordImmediateSendOutcome(initial.id,0,outcome);
 const original=(await db.store.read(initial.id))!.immediateSends[0];
 snapshot=await rearmScheduledAttempt(db.fhir,await readScheduledEnrollment(db.fhir,initial.id),id,{providerInvoked:false,outcome},at);
 for(let i=0;i<4;i++) snapshot=await rearmScheduledAttempt(db.fhir,await readScheduledEnrollment(db.fhir,initial.id),id,{providerInvoked:false,outcome},at);
 assert.equal(snapshot.enrollment.scheduledSends![0].attempts.length,2);assert.equal(snapshot.enrollment.immediateSends.length,2);
 assert.deepEqual(snapshot.enrollment.immediateSends[0],original);
 const attempts=snapshot.enrollment.scheduledSends![0].attempts;assert.equal(attempts[1].predecessorAttemptKey,attempts[0].attemptKey);assert.notEqual(attempts[1].attemptKey,attempts[0].attemptKey);
});
test("a deferral without proof of no provider invocation cannot mint a successor",async()=>{
 const db=fixture();const initial=await db.store.create(db.input);const id=initial.scheduledSends![0].id;
 let snapshot=await admitScheduledAttempt(db.fhir,await readScheduledEnrollment(db.fhir,initial.id),id,at);
 snapshot=await claimScheduledAttempt(db.fhir,snapshot,id,at);
 const outcome={outcome:"rescheduled" as const,reason:"quiet-hours" as const,rescheduledAt:"2026-09-11T12:00:00.000Z"};
 await db.store.recordImmediateSendOutcome(initial.id,0,outcome);
 await assert.rejects(rearmScheduledAttempt(db.fhir,await readScheduledEnrollment(db.fhir,initial.id),id,{providerInvoked:true,outcome},at),/successor-no-provider-proof-required/);
 assert.equal((await db.store.read(initial.id))!.immediateSends.length,1);
});
