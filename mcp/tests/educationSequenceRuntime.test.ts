import assert from "node:assert/strict";
import { test } from "node:test";
import { educationSequenceRuntimeConfig, educationSequenceDispatchBody } from "../src/comms/education-sequence-runtime.js";
test("disabled sequence runtime needs no configuration; enabled runtime requires a real Device reference", () => {
    assert.equal(educationSequenceRuntimeConfig({}), undefined);
    assert.throws(() => educationSequenceRuntimeConfig({ ODOS_EDUCATION_SEQUENCE_WORKER_ENABLED: "true" }), /Device/);
    assert.throws(() => educationSequenceRuntimeConfig({ ODOS_EDUCATION_SEQUENCE_WORKER_ENABLED: "true", ODOS_EDUCATION_SEQUENCE_ACTOR_REFERENCE: "Practitioner/human" }), /Device/);
});
test("runtime defaults spacing on and resolves only explicitly pinned calendars", () => {
    const config = educationSequenceRuntimeConfig({ ODOS_EDUCATION_SEQUENCE_WORKER_ENABLED: "true", ODOS_EDUCATION_SEQUENCE_ACTOR_REFERENCE: "Device/synthetic-worker", ODOS_EDUCATION_SEQUENCE_CALENDARS: JSON.stringify([{ id: "office", version: 2, workingWeekdays: [1, 2, 3, 4], holidays: ["2026-09-10"] }]) })!;
    assert.equal(config.spacingEnabled, true);
    assert.equal(config.resolveCalendar({ id: "office", version: 1 }), undefined);
    assert.deepEqual(config.resolveCalendar({ id: "office", version: 2 })?.workingWeekdays, [1, 2, 3, 4]);
    assert.equal(config.intervalMs, 60000);
});
test("dispatch request carries recipient reference and preserves row content without chart mutation", () => {
    const body = educationSequenceDispatchBody({ patientReference: "Patient/test" } as any, { content: { id: "content", version: 4 }, channel: "sms", lane: "clinical", recipientReference: "RelatedPerson/recipient" } as any, "education-sequence-stable");
    assert.deepEqual(body.recipientOverride, { reference: "RelatedPerson/recipient" });
    assert.equal(body.alsoUpdateChart, false);
    assert.equal(body.version, 4);
    assert.equal(body.idempotencyKey, "education-sequence-stable");
});
