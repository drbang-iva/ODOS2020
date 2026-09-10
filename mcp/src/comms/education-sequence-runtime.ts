import type { Patient } from "@medplum/fhirtypes";
import type { MedplumClient } from "../fhir-client.js";
import { dispatchEducationAs, prepareEducationSequenceDispatch, readEducationDispatchEvidence, type CommsApiRouteDeps, type EducationDispatchBody, type PreparedEducationSequenceDispatch } from "./comms-api.js";
import type { EducationEnrollment } from "./education-enrollment.js";
import type { EducationScheduledSend } from "./education-sequence.js";
import type { EducationSequenceWorkerDeps } from "./education-sequence-worker.js";
import { educationSequenceWorkerIntervalMs } from "./education-sequence-worker.js";
import type { EducationBusinessCalendar, EducationBusinessCalendarResolver } from "./education-sequence-timing.js";
export function educationSequenceRuntimeConfig(env: NodeJS.ProcessEnv): {
    actorReference: string;
    intervalMs: number;
    spacingEnabled: boolean;
    resolveCalendar: EducationBusinessCalendarResolver;
} | undefined {
    // Must not enable for a live practice until ODOS can read per-patient Education communication permission.
    // Eyefinity defaults Education to Mail only; other channels require the patient's permission.
    // See performance-od/decisions/2026-09-10-eyefinity-communication-methods-matrix-is-the-consent-model.md.
    if (env.ODOS_EDUCATION_SEQUENCE_WORKER_ENABLED !== "true")
        return undefined;
    const actorReference = env.ODOS_EDUCATION_SEQUENCE_ACTOR_REFERENCE ?? "";
    if (!/^Device\/[A-Za-z0-9.-]{1,64}$/.test(actorReference))
        throw new Error("Education sequence worker requires ODOS_EDUCATION_SEQUENCE_ACTOR_REFERENCE identifying an installed Device.");
    const calendars: unknown = JSON.parse(env.ODOS_EDUCATION_SEQUENCE_CALENDARS ?? "[]");
    if (!Array.isArray(calendars))
        throw new Error("Education sequence calendars must be an array.");
    const pins = new Map<string, EducationBusinessCalendar>();
    for (const calendar of calendars) {
        if (!calendar || typeof calendar.id !== "string" || !calendar.id || !Number.isInteger(calendar.version) || calendar.version < 1 ||
            !Array.isArray(calendar.workingWeekdays) || !calendar.workingWeekdays.length || !calendar.workingWeekdays.every((day: unknown) => Number.isInteger(day) && Number(day) >= 0 && Number(day) <= 6) ||
            !Array.isArray(calendar.holidays) || !calendar.holidays.every((day: unknown) => typeof day === "string" && /^\d{4}-\d{2}-\d{2}$/.test(day) && !Number.isNaN(Date.parse(day)) && new Date(day).toISOString().slice(0, 10) === day))
            throw new Error("Education sequence calendar is invalid.");
        const key = JSON.stringify([calendar.id, calendar.version]);
        if (pins.has(key))
            throw new Error("Education sequence calendar pin is duplicated.");
        pins.set(key, calendar);
    }
    const spacing = env.ODOS_EDUCATION_SEQUENCE_SPACING_ENABLED;
    if (spacing !== undefined && spacing !== "true" && spacing !== "false")
        throw new Error("Education sequence spacing must be true or false.");
    return { actorReference, intervalMs: educationSequenceWorkerIntervalMs(env.ODOS_EDUCATION_SEQUENCE_WORKER_MS), spacingEnabled: spacing !== "false", resolveCalendar: pin => pins.get(JSON.stringify([pin.id, pin.version])) };
}
export function educationSequenceDispatchBody(enrollment: EducationEnrollment, row: EducationScheduledSend, key: string): EducationDispatchBody {
    return {
        patientReference: enrollment.patientReference,
        educationId: row.content.id,
        version: row.content.version,
        channel: row.channel,
        lane: row.lane,
        recipientOverride: { reference: row.recipientReference },
        alsoUpdateChart: false,
        encounterReference: enrollment.enteredFromEncounterReference,
        idempotencyKey: key,
    };
}
export function createEducationSequenceDispatchRuntime(deps: CommsApiRouteDeps, fhir: MedplumClient, actorReference: string, projectId: string): Pick<EducationSequenceWorkerDeps, "prepare" | "execute" | "reconcile" | "evidence"> {
    const actor = (row: EducationScheduledSend) => ({ kind: "system" as const, reference: actorReference, onBehalfOf: row.senderReference, fhir });
    return {
        async prepare(enrollment, row) {
            const resultSet = await fhir.searchProject<Patient>("Patient", projectId, { _id: enrollment.patientReference.slice("Patient/".length) });
            const patient = resultSet.entry?.find(entry => entry.resource?.resourceType === "Patient" && `Patient/${entry.resource.id}` === enrollment.patientReference && entry.resource.meta?.project?.replace(/^Project\//, "") === projectId)?.resource;
            if (!patient)
                throw new Error("Sequence patient is unavailable in this practice.");
            const result = await prepareEducationSequenceDispatch(deps, fhir, patient, educationSequenceDispatchBody(enrollment, row, "education-sequence-preflight"));
            return result.kind === "ready" ? { kind: "ready", prepared: { patient, dispatch: result.prepared } } : result;
        },
        execute(enrollment, row, key, value) {
            const prepared = value as {
                patient: Patient;
                dispatch: PreparedEducationSequenceDispatch;
            };
            return dispatchEducationAs(actor(row), deps, prepared.patient, educationSequenceDispatchBody(enrollment, row, key), { prepared: prepared.dispatch });
        },
        async reconcile(enrollment, row, key) {
            const body = educationSequenceDispatchBody(enrollment, row, key);
            if (!await readEducationDispatchEvidence(fhir, body, row.senderReference))
                return undefined;
            return dispatchEducationAs(actor(row), deps, undefined, body, { reconcileOnly: true });
        },
        evidence: (enrollment, row, key) => readEducationDispatchEvidence(fhir, educationSequenceDispatchBody(enrollment, row, key), row.senderReference),
    };
}
