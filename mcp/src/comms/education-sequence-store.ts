import { randomUUID } from "node:crypto";
import type { Basic } from "@medplum/fhirtypes";
import { parseEnrollment, replaceEnrollmentState, updateEnrollmentResource, type EducationEnrollment, type EducationEnrollmentFhir } from "./education-enrollment.js";
import { EducationSequenceAdmissionError, type EducationScheduledSend } from "./education-sequence.js";

export interface ScheduledEnrollmentSnapshot { resource: Basic; enrollment: EducationEnrollment; }
export function scheduledEnrollmentSnapshot(resource: Basic): ScheduledEnrollmentSnapshot {
  return {resource, enrollment: parseEnrollment(resource)};
}
export async function readScheduledEnrollment(fhir: EducationEnrollmentFhir, id: string): Promise<ScheduledEnrollmentSnapshot> {
  return scheduledEnrollmentSnapshot(await fhir.read<Basic>("Basic",id));
}
export async function writeScheduledEnrollment(fhir: EducationEnrollmentFhir, snapshot: ScheduledEnrollmentSnapshot): Promise<ScheduledEnrollmentSnapshot> {
  replaceEnrollmentState(snapshot.resource,snapshot.enrollment);
  return scheduledEnrollmentSnapshot(await updateEnrollmentResource(fhir,snapshot.resource));
}
function eligible(snapshot: ScheduledEnrollmentSnapshot, rowId: string, at: string): EducationScheduledSend {
  if (!snapshot.resource.meta?.versionId) throw new Error("EducationEnrollment version is required.");
  const enrollment=snapshot.enrollment;
  const row=enrollment.scheduledSends?.find(r=>r.id===rowId);
  const activation=enrollment.activations?.find(a=>a.id===row?.activationId);
  if(!row || enrollment.status!=="active" || activation?.status!=="active" || activation.stageHistorySequence!==enrollment.stageHistory.length || !["scheduled","waiting"].includes(row.disposition)) throw new EducationSequenceAdmissionError("scheduled-row-not-authorized");
  if(Date.parse(at)<Date.parse(row.runtime?.effectiveAt ?? row.notBefore) || Date.parse(at)>Date.parse(row.latestUsefulTime)) throw new EducationSequenceAdmissionError("scheduled-row-not-due");
  if(row.blockedBySendIndices.some(i=>!["resolved","indeterminate"].includes(enrollment.immediateSends[i]?.state??""))) throw new EducationSequenceAdmissionError("scheduled-row-needs-acknowledgement");
  return row;
}
export async function admitScheduledAttempt(fhir: EducationEnrollmentFhir, original: ScheduledEnrollmentSnapshot, rowId: string, at: string): Promise<ScheduledEnrollmentSnapshot> {
 const snapshot=structuredClone(original); const row=eligible(snapshot,rowId,at);
 if(row.channel === "print") throw new EducationSequenceAdmissionError("print-sequence-electronic-dispatch-refused");
 if(row.attempts.length) return snapshot;
 const key=`education-sequence-${randomUUID()}`;
 row.attempts.push({sendIndex:snapshot.enrollment.immediateSends.length,attemptKey:key});
 snapshot.enrollment.immediateSends.push({content:row.content,channel:row.channel,lane:row.lane,idempotencyKey:key,state:"pending"});
 return writeScheduledEnrollment(fhir,snapshot);
}
export async function claimScheduledAttempt(fhir: EducationEnrollmentFhir, original: ScheduledEnrollmentSnapshot, rowId: string, at: string): Promise<ScheduledEnrollmentSnapshot & {claimed:boolean}> {
 const snapshot=structuredClone(original); const row=eligible(snapshot,rowId,at);
 const attempt=row.attempts.at(-1); const send=attempt && snapshot.enrollment.immediateSends[attempt.sendIndex];
 if(!send || send.state!=="pending") return {...snapshot,claimed:false};
 if(snapshot.enrollment.immediateSends.some(s=>s.state==="in-flight")) return {...snapshot,claimed:false};
 send.state="in-flight";
 return {...await writeScheduledEnrollment(fhir,snapshot),claimed:true};
}

export async function rearmScheduledAttempt(fhir: EducationEnrollmentFhir, original: ScheduledEnrollmentSnapshot, rowId: string, evidence: {providerInvoked:boolean; outcome:{outcome:string;rescheduledAt?:string}}, at: string): Promise<ScheduledEnrollmentSnapshot> {
 const snapshot=structuredClone(original); const row=snapshot.enrollment.scheduledSends!.find(r=>r.id===rowId)!;
 const last=row.attempts.at(-1); const send=last && snapshot.enrollment.immediateSends[last.sendIndex];
 if(!last || !send || send.state!=="resolved" || send.outcome?.outcome!=="rescheduled") return snapshot;
 if(evidence.providerInvoked || evidence.outcome.outcome!=="rescheduled" || evidence.outcome.rescheduledAt!==send.outcome.rescheduledAt) throw new EducationSequenceAdmissionError("successor-no-provider-proof-required");
 if(!["waiting","scheduled"].includes(row.disposition) || snapshot.enrollment.status!=="active" || snapshot.enrollment.activations?.find(a=>a.id===row.activationId)?.status!=="active") return snapshot;
 if(row.attempts.some(a=>a.predecessorAttemptKey===last.attemptKey)) return snapshot;
 if(row.attempts.length>=3) {
   row.disposition="held";row.holdReason="needs-acknowledgement";
   row.events.push({kind:"held",actor:row.senderReference,at,reason:"attempt-limit"});
 } else {
   last.providerNeverInvoked=true;
   const key=`education-sequence-${randomUUID()}`;
   row.attempts.push({sendIndex:snapshot.enrollment.immediateSends.length,attemptKey:key,predecessorAttemptKey:last.attemptKey});
   snapshot.enrollment.immediateSends.push({content:row.content,channel:row.channel,lane:row.lane,idempotencyKey:key,state:"pending"});
   row.runtime={...row.runtime,effectiveAt:send.outcome.rescheduledAt};
   row.events.push({kind:"rescheduled",actor:row.senderReference,at,reason:"quiet-hours-successor"});
 }
 return writeScheduledEnrollment(fhir,snapshot);
}
