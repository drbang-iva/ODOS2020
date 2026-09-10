import { createHash } from "node:crypto";
import type { Basic, Bundle, Communication, Encounter, Patient, Resource, Task } from "@medplum/fhirtypes";
import { collectAllFhirSearchPages } from "../fhir-search.js";
import { ODOS_COMMS_STAFF_SEND_IDENTIFIER_SYSTEM } from "./comms-persistence.js";
import type { EducationEnrollment, EducationEnrollmentFhir } from "./education-enrollment.js";
import { EducationSequenceAdmissionError, type EducationScheduledSend } from "./education-sequence.js";
import { scheduledEnrollmentSnapshot, writeScheduledEnrollment, type ScheduledEnrollmentSnapshot } from "./education-sequence-store.js";
import type { SequenceStaffItem } from "./education-sequence-worker.js";

const REVIEW_CODE = "odos-education-sequence-review";
export interface EducationSequenceOperationsFhir extends EducationEnrollmentFhir {
  baseUrl: string;
  searchProject<T extends Resource>(type: T["resourceType"], project: string, params?: Record<string, string>): Promise<Bundle<T>>;
  searchProjectUrl?<T extends Resource>(url: string, type: T["resourceType"], project: string): Promise<Bundle<T>>;
}
export interface EducationSequenceWorkItem extends SequenceStaffItem {
  id: string;
  state: "open" | "settled";
  allowedActions: ("skip" | "resume")[];
  expectedVersion?: string;
  disposition?: EducationScheduledSend["disposition"];
  holdReason?: EducationScheduledSend["holdReason"];
  channel?: EducationScheduledSend["channel"];
  encounterReference?: string;
}
export interface EducationSequenceReview {
  action: "skip" | "resume";
  reason: string;
  expectedVersion: string;
  actorReference: string;
  reviewedEncounterReference?: string;
}
export interface EducationSequenceOperations {
  staffItem(input: SequenceStaffItem): Promise<void>;
  list(): Promise<EducationSequenceWorkItem[]>;
  review(enrollmentId: string, rowId: string, input: EducationSequenceReview, callerFhir: EducationSequenceOperationsFhir): Promise<{ enrollment: EducationEnrollment; expectedVersion: string }>;
}

export function createEducationSequenceOperations(deps: {
  fhir: EducationSequenceOperationsFhir;
  practiceProjectId: string;
  now?: () => string;
}): EducationSequenceOperations {
  const projectId = deps.practiceProjectId.replace(/^Project\//, "");
  if (!projectId.trim()) throw new Error("Education sequence operations practice is required.");
  const sameProject = (resource: Resource) => resource.meta?.project?.replace(/^Project\//, "") === projectId;

  async function searchProject<T extends Resource>(fhir: EducationSequenceOperationsFhir, type: T["resourceType"], params: Record<string, string>): Promise<T[]> {
    // search-contract: education-sequence.operations-enumeration
    const bundle = await fhir.searchProject<T>(type, projectId, params);
    const resources = await collectAllFhirSearchPages<T>({
      baseUrl: fhir.baseUrl,
      search: (resourceType, query) => fhir.searchProject(resourceType, projectId, query),
      searchUrl: fhir.searchProjectUrl ? (url, resourceType) => fhir.searchProjectUrl!(url, resourceType, projectId) : undefined,
    }, type, bundle, fhir.baseUrl);
    return resources.filter(sameProject);
  }

  async function resourceInPractice<T extends Resource>(fhir: EducationSequenceOperationsFhir, type: T["resourceType"], id: string): Promise<T | undefined> {
    const resources = (await searchProject<T>(fhir, type, { _id: id, _count: "2" })).filter(resource => resource.id === id);
    if (resources.length > 1) throw new Error("Education sequence practice resource identity is ambiguous.");
    return resources[0];
  }
  async function verifiedPatient(fhir: EducationSequenceOperationsFhir, enrollment: EducationEnrollment, expected?: string): Promise<string | undefined> {
    if (expected && expected !== enrollment.patientReference) return undefined;
    const match = /^Patient\/([A-Za-z0-9.-]{1,64})$/.exec(enrollment.patientReference);
    return match && await resourceInPractice<Patient>(fhir, "Patient", match[1]) ? enrollment.patientReference : undefined;
  }
  function taskInput(task: Task, name: string): string | undefined {
    return task.input?.find(value => value.type.text === name)?.valueString;
  }
  function itemFromTask(task: Task): EducationSequenceWorkItem | undefined {
    const enrollmentId = task.focus?.reference?.match(/^Basic\/([A-Za-z0-9.-]{1,64})$/)?.[1];
    const reason = task.reasonCode?.text;
    if (!task.id || !enrollmentId || !reason || !task.authoredOn || !task.code?.coding?.some(code => code.code === REVIEW_CODE && !code.system)) return undefined;
    return { id: task.id, enrollmentId, rowId: taskInput(task, "row-id"), reason, at: task.authoredOn, state: "open", allowedActions: [] };
  }
  async function assertReviewable(fhir: EducationSequenceOperationsFhir, enrollment: EducationEnrollment, row: EducationScheduledSend | undefined): Promise<void> {
    const activation = enrollment.activations?.find(activation => activation.id === row?.activationId);
    if (!row || enrollment.status !== "active" || activation?.status !== "active" || activation.stageHistorySequence !== enrollment.stageHistory.length || ["closed", "cancelled"].includes(row.disposition)) {
      throw new EducationSequenceAdmissionError("scheduled-row-not-authorized");
    }
    const unresolved = (index: number) => {
      const send = enrollment.immediateSends[index];
      return !send || send.state === "in-flight" || (send.state === "indeterminate" && !send.acknowledgement);
    };
    if ([...row.blockedBySendIndices, ...row.attempts.map(attempt => attempt.sendIndex)].some(unresolved)) throw new EducationSequenceAdmissionError("scheduled-row-needs-acknowledgement");
    for (const attempt of row.attempts) {
      const send = enrollment.immediateSends[attempt.sendIndex];
      if (attempt.acceptedAt || send.outcome?.outcome === "sent") throw new EducationSequenceAdmissionError("accepted-sequence-step-cannot-be-reviewed");
      const communications = (await searchProject<Communication>(fhir, "Communication", { identifier: `${ODOS_COMMS_STAFF_SEND_IDENTIFIER_SYSTEM}|${attempt.attemptKey}`, _count: "2" }))
        .filter(resource => resource.identifier?.some(identifier => identifier.system === ODOS_COMMS_STAFF_SEND_IDENTIFIER_SYSTEM && identifier.value === attempt.attemptKey));
      if (communications.length > 1 || communications.some(resource => resource.subject?.reference !== enrollment.patientReference || resource.sender?.reference !== row.senderReference))
        throw new EducationSequenceAdmissionError("sequence-reservation-identity-conflict");
      if (communications.some(resource => resource.sent)) throw new EducationSequenceAdmissionError("accepted-sequence-step-cannot-be-reviewed");
    }
  }
  async function assertResumable(fhir: EducationSequenceOperationsFhir, enrollment: EducationEnrollment, row: EducationScheduledSend, reviewedEncounterReference?: string): Promise<void> {
    if (row.disposition !== "held") throw new EducationSequenceAdmissionError("scheduled-row-not-held");
    if (row.channel === "print" || row.attempts.length >= 3 || Date.parse(deps.now?.() ?? new Date().toISOString()) > Date.parse(row.latestUsefulTime)) throw new EducationSequenceAdmissionError("scheduled-row-requires-skip");
    const last = row.attempts.at(-1);
    const send = last && enrollment.immediateSends[last.sendIndex];
    if (send && send.state !== "pending" && !(send.state === "resolved" && send.outcome?.outcome === "rescheduled")) throw new EducationSequenceAdmissionError("terminal-sequence-attempt-requires-skip");
    if (row.holdReason === "patient-seen") {
      const heldEncounter = row.events.at(-1)?.reason.match(/^patient-seen:(Encounter\/[A-Za-z0-9.-]{1,64})$/)?.[1];
      if (!reviewedEncounterReference || reviewedEncounterReference !== heldEncounter) throw new EducationSequenceAdmissionError("reviewed-encounter-required");
      const encounter = await resourceInPractice<Encounter>(fhir, "Encounter", reviewedEncounterReference.slice("Encounter/".length));
      if (encounter?.subject?.reference !== enrollment.patientReference) throw new EducationSequenceAdmissionError("reviewed-encounter-patient-mismatch");
    }
  }
  return {
    async staffItem(input) {
      if (!/^[A-Za-z0-9.-]{1,64}$/.test(input.enrollmentId) || !input.reason.trim() || !Number.isFinite(Date.parse(input.at))) throw new Error("Education sequence staff item is invalid.");
      const basic = await resourceInPractice<Basic>(deps.fhir, "Basic", input.enrollmentId);
      if (!basic) throw new Error("Education sequence staff item enrollment is outside this practice.");
      let snapshot: ScheduledEnrollmentSnapshot | undefined;
      try { snapshot = scheduledEnrollmentSnapshot(basic); } catch { /* Malformed enrollment is itself an operations item. */ }
      const patientReference = snapshot && input.patientReference ? await verifiedPatient(deps.fhir, snapshot.enrollment, input.patientReference) : undefined;
      const key = `education-sequence-${createHash("sha256").update(JSON.stringify([projectId, input.enrollmentId, input.rowId ?? null, input.reason])).digest("hex")}`;
      const task: Task = {
        resourceType: "Task", meta: { project: projectId }, status: "requested", intent: "order",
        identifier: [{ value: key }], code: { coding: [{ code: REVIEW_CODE }] },
        focus: { reference: `Basic/${input.enrollmentId}` },
        ...(patientReference ? { for: { reference: patientReference } } : {}),
        authoredOn: input.at, reasonCode: { text: input.reason },
        ...(input.rowId ? { input: [{ type: { text: "row-id" }, valueString: input.rowId }] } : {}),
      };
      const stored = await deps.fhir.create<Task>(task, { "If-None-Exist": `identifier=${key}` });
      if (!stored.id) throw new Error("Education sequence staff item returned no Task id.");
      const scopedTask = await resourceInPractice<Task>(deps.fhir, "Task", stored.id);
      if (!scopedTask) throw new Error("Education sequence staff item returned a foreign practice resource.");
      if (scopedTask.focus?.reference !== task.focus?.reference || scopedTask.for?.reference !== task.for?.reference ||
        scopedTask.reasonCode?.text !== input.reason || taskInput(scopedTask, "row-id") !== input.rowId ||
        !scopedTask.identifier?.some(identifier => identifier.value === key && !identifier.system) ||
        !scopedTask.code?.coding?.some(code => code.code === REVIEW_CODE && !code.system)) {
        throw new Error("Education sequence staff item Task identity conflict.");
      }
    },
    async list() {
      const tasks = await searchProject<Task>(deps.fhir, "Task", { code: REVIEW_CODE, _count: "100" });
      const items: EducationSequenceWorkItem[] = [];
      for (const task of tasks) {
        const item = itemFromTask(task);
        if (!item) continue;
        const basic = await resourceInPractice<Basic>(deps.fhir, "Basic", item.enrollmentId);
        if (basic) {
          item.expectedVersion = basic.meta?.versionId;
          let snapshot: ScheduledEnrollmentSnapshot | undefined;
          try { snapshot = scheduledEnrollmentSnapshot(basic); } catch { /* Keep malformed items visible without assigning a patient. */ }
          if (snapshot) {
            item.patientReference = await verifiedPatient(deps.fhir, snapshot.enrollment, task.for?.reference);
            const row = snapshot.enrollment.scheduledSends?.find(row => row.id === item.rowId);
            item.disposition = row?.disposition;
            item.holdReason = row?.holdReason;
            item.channel = row?.channel;
            item.state = row?.disposition === "held" && row.events.at(-1)?.reason === item.reason ? "open" : "settled";
            if (row?.holdReason === "patient-seen") item.encounterReference = row.events.at(-1)?.reason.match(/^patient-seen:(Encounter\/[A-Za-z0-9.-]{1,64})$/)?.[1];
            if (item.state === "open" && row && item.expectedVersion && item.patientReference) {
              try {
                await assertReviewable(deps.fhir, snapshot.enrollment, row);
                item.allowedActions = ["skip"];
                try { await assertResumable(deps.fhir, snapshot.enrollment, row, item.encounterReference); item.allowedActions.push("resume"); }
                catch (error) { if (!(error instanceof EducationSequenceAdmissionError)) throw error; }
              } catch (error) { if (!(error instanceof EducationSequenceAdmissionError)) throw error; }
            }
          }
        }
        items.push(item);
      }
      return items;
    },
    async review(enrollmentId, rowId, input, callerFhir) {
      if (!["skip", "resume"].includes(input.action) || !input.reason?.trim() || input.reason.length > 1000 || !input.expectedVersion?.trim() || !/^Practitioner\/[A-Za-z0-9.-]{1,64}$/.test(input.actorReference)) {
        throw new EducationSequenceAdmissionError("invalid-sequence-review");
      }
      const basic = await resourceInPractice<Basic>(callerFhir, "Basic", enrollmentId);
      if (!basic) throw new EducationSequenceAdmissionError("enrollment-not-in-practice");
      if (!basic.meta?.versionId || basic.meta.versionId !== input.expectedVersion) throw new EducationSequenceAdmissionError("stale-enrollment-version");
      const snapshot = scheduledEnrollmentSnapshot(basic);
      const enrollment = snapshot.enrollment;
      if (!await verifiedPatient(callerFhir, enrollment)) throw new EducationSequenceAdmissionError("patient-not-in-practice");
      const row = enrollment.scheduledSends?.find(row => row.id === rowId);
      if (!row) throw new EducationSequenceAdmissionError("scheduled-row-not-authorized");
      await assertReviewable(callerFhir, enrollment, row);
      const at = deps.now?.() ?? new Date().toISOString();
      if (input.action === "skip") {
        for (const attempt of row.attempts) {
          const send = enrollment.immediateSends[attempt.sendIndex];
          if (send.state === "pending") { send.state = "resolved"; send.outcome = { outcome: "not-sent", reason: `clinician-skip:${input.reason}` }; }
        }
        row.disposition = "closed";
        delete row.holdReason;
        row.runtime = { ...row.runtime, clinicianSkip: { at, by: input.actorReference, reason: input.reason } };
        row.events.push({ kind: "released", actor: input.actorReference, at, reason: `clinician-skip:${input.reason}` });
      } else {
        await assertResumable(callerFhir, enrollment, row, input.reviewedEncounterReference);
        if (row.holdReason === "patient-seen") {
          row.runtime = { ...row.runtime, reviewedEncounterReferences: [...new Set([...(row.runtime?.reviewedEncounterReferences ?? []), input.reviewedEncounterReference!])] };
        }
        row.disposition = row.anchor === "predecessor-acceptance" ? "waiting" : "scheduled";
        delete row.holdReason;
        row.events.push({ kind: "released", actor: input.actorReference, at, reason: `clinician-resume:${input.reason}` });
      }
      const written = await writeScheduledEnrollment(callerFhir, snapshot);
      return { enrollment: written.enrollment, expectedVersion: written.resource.meta!.versionId! };
    },
  };
}
