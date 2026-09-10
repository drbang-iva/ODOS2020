import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import type { Basic, Bundle, Communication, Encounter, Patient, Provenance, Resource } from "@medplum/fhirtypes";
import express from "express";
import {
  registerCommsApiRoutes,
  type CommsApiRouteDeps,
} from "../src/comms/comms-api.js";
import type { CommsProvider, SendEmailRequest, SendSmsRequest } from "../src/comms/comms-provider.js";
import { createFhirEducationEnrollmentStore, type EducationEnrollmentStore, createInMemoryEducationEnrollmentStore } from "../src/comms/education-enrollment.js";
import {
  ODOS_COMMS_OPT_OUT_EXTENSION_URL,
  createSuppressedCommsProvider,
} from "../src/comms/suppression-gate.js";

const PATIENT_REFERENCE = "Patient/synthetic-enrollment-1";
const ENCOUNTER_REFERENCE = "Encounter/synthetic-enrollment-encounter-1";

test("EducationEnrollment creates stage 1, refuses a version-shifted duplicate, and persists opt-out suppression with zero provider sends", async () => {
  const fixture = await startEnrollmentServer({ optedOut: true });
  try {
    const response = await request(fixture.base, "/communications/education/enrollments", "POST", enrollmentBody());
    assert.equal(response.status, 201);
    const body = await response.json() as { enrollment: {
      id: string;
      currentStageId: string;
      journey: { id: string; version: number };
      immediateSends: Array<Record<string, unknown>>;
    } };
    assert.equal(body.enrollment.id, "enrollment-api-synthetic-1");
    assert.equal(body.enrollment.currentStageId, "welcome");
    assert.deepEqual(body.enrollment.journey, { id: "dry-eye-foundations", version: 1 });
    assert.deepEqual(body.enrollment.immediateSends, [{
      content: { id: "dry-eye-basics", version: 2 },
      channel: "sms",
      lane: "clinical",
      idempotencyKey: "enrollment:enrollment-api-synthetic-1:stage1:1",
      state: "resolved",
      outcome: { outcome: "suppressed", reason: "patient-opt-out" },
    }]);
    assert.equal(fixture.underlyingSends.length, 0);
    assert.equal(fixture.trackedLinks.length, 1);

    const duplicate = await request(fixture.base, "/communications/education/enrollments", "POST", {
      ...enrollmentBody(),
      journey: { id: "dry-eye-foundations", version: 2 },
    });
    assert.equal(duplicate.status, 409);
    assert.deepEqual(await duplicate.json(), {
      outcome: "refused",
      reason: "duplicate-active-enrollment",
    });

    const fetched = await request(
      fixture.base,
      "/communications/education/enrollments/enrollment-api-synthetic-1",
      "GET",
    );
    assert.equal(fetched.status, 200);
    assert.deepEqual((await fetched.json() as { enrollment: unknown }).enrollment, body.enrollment);

    const listed = await request(
      fixture.base,
      `/communications/education/enrollments?patient=${PATIENT_REFERENCE}`,
      "GET",
    );
    assert.equal(listed.status, 200);
    assert.deepEqual((await listed.json() as { enrollments: unknown[] }).enrollments, [body.enrollment]);

    assert.equal(fixture.provenances.length, 1);
    const targets = fixture.provenances[0]?.target.map(({ reference }) => reference);
    assert.deepEqual(targets, [
      PATIENT_REFERENCE,
      ENCOUNTER_REFERENCE,
      "Basic/enrollment-api-synthetic-1",
    ]);
    assert.equal(fixture.auditReasons.includes("communications-education-enrollment-create"), true);
    assert.equal(fixture.auditReasons.includes("communications-education-enrollment-read"), true);
    assert.equal(fixture.auditReasons.includes("communications-education-enrollment-list"), true);
  } finally {
    await fixture.close();
  }
});

test("EducationEnrollment rejects a cross-patient encounter before persistence, dispatch, or Provenance", async () => {
  const fixture = await startEnrollmentServer();
  try {
    const response = await request(fixture.base, "/communications/education/enrollments", "POST", {
      ...enrollmentBody(),
      encounterReference: "Encounter/synthetic-enrollment-encounter-other",
    });
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), {
      error: `encounterReference must belong to ${PATIENT_REFERENCE}.`,
    });
    assert.deepEqual(await fixture.enrollmentStore.listActiveForPatient(PATIENT_REFERENCE), []);
    assert.equal(fixture.underlyingSends.length, 0);
    assert.equal(fixture.provenances.length, 0);
  } finally {
    await fixture.close();
  }
});

test("EducationEnrollment transition appends history and actually dispatches a stage-2 send with an honest unique key", async () => {
  const fixture = await startEnrollmentServer();
  try {
    await createEnrollment(fixture.base);
    assert.equal(fixture.underlyingSends.length, 1);

    const response = await request(
      fixture.base,
      "/communications/education/enrollments/enrollment-api-synthetic-1/transitions",
      "POST",
      transitionBody(),
    );
    assert.equal(response.status, 200);
    const enrollment = (await response.json() as { enrollment: {
      currentStageId: string;
      status: string;
      stageHistory: Array<Record<string, unknown>>;
      immediateSends: Array<{
        idempotencyKey: string;
        state: string;
        outcome?: Record<string, unknown>;
      }>;
    } }).enrollment;
    assert.equal(enrollment.currentStageId, "consult");
    assert.equal(enrollment.status, "active");
    assert.deepEqual(enrollment.stageHistory, [{
      stageId: "welcome",
      enteredAt: "2026-09-01T14:00:00.000Z",
      enteredBy: "Practitioner/provider",
      reason: "enrollment-recorded",
    }, {
      stageId: "consult",
      enteredAt: "2026-09-01T14:00:00.000Z",
      enteredBy: "Practitioner/provider",
      reason: "consult-completed",
    }]);
    assert.deepEqual(enrollment.immediateSends.map((send) => send.outcome), [{
      outcome: "sent",
      providerMessageId: "SM-enrollment-synthetic-1",
    }, {
      outcome: "sent",
      providerMessageId: "SM-enrollment-synthetic-2",
    }]);
    assert.deepEqual(enrollment.immediateSends.map((send) => ({
      idempotencyKey: send.idempotencyKey,
      state: send.state,
    })), [{
      idempotencyKey: "enrollment:enrollment-api-synthetic-1:stage1:1",
      state: "resolved",
    }, {
      idempotencyKey: "enrollment:enrollment-api-synthetic-1:stage:consult:2",
      state: "resolved",
    }]);
    assert.equal(fixture.underlyingSends.length, 2);
    assert.deepEqual(
      fixture.communications.map((communication) => communication.identifier?.find((identifier) =>
        identifier.system === "https://odos2020.com/fhir/NamingSystem/comms-staff-send")?.value),
      [
        "enrollment:enrollment-api-synthetic-1:stage1:1",
        "enrollment:enrollment-api-synthetic-1:stage:consult:2",
      ],
    );
    assert.equal(fixture.provenances.length, 4);
    assert.deepEqual(fixture.provenances[2]?.target.map(({ reference }) => reference), [
      PATIENT_REFERENCE,
      ENCOUNTER_REFERENCE,
      "Basic/enrollment-api-synthetic-1",
    ]);
    assert.equal(fixture.auditReasons.includes("communications-education-enrollment-transition"), true);
  } finally {
    await fixture.close();
  }
});

test("EducationEnrollment transition refuses a stale from-stage without appending or dispatching", async () => {
  const fixture = await startEnrollmentServer();
  try {
    await createEnrollment(fixture.base);
    const response = await request(
      fixture.base,
      "/communications/education/enrollments/enrollment-api-synthetic-1/transitions",
      "POST",
      { ...transitionBody(), fromStageId: "already-advanced" },
    );
    assert.equal(response.status, 409);
    assert.deepEqual(await response.json(), { outcome: "refused", reason: "stale-from-stage" });
    assert.equal(fixture.underlyingSends.length, 1);
    const stored = await fixture.enrollmentStore.read("enrollment-api-synthetic-1");
    assert.equal(stored?.stageHistory.length, 1);
  } finally {
    await fixture.close();
  }
});

test("EducationEnrollment transition refuses a non-active enrollment", async () => {
  const fixture = await startEnrollmentServer();
  try {
    await createEnrollment(fixture.base);
    const completed = await request(
      fixture.base,
      "/communications/education/enrollments/enrollment-api-synthetic-1/transitions",
      "POST",
      terminalTransitionBody("completed", []),
    );
    assert.equal(completed.status, 200);

    const response = await request(
      fixture.base,
      "/communications/education/enrollments/enrollment-api-synthetic-1/transitions",
      "POST",
      { ...transitionBody(), fromStageId: "complete" },
    );
    assert.equal(response.status, 409);
    assert.deepEqual(await response.json(), { outcome: "refused", reason: "enrollment-not-active" });
  } finally {
    await fixture.close();
  }
});

test("EducationEnrollment transition rejects a missing or malformed target-stage shape", async () => {
  const fixture = await startEnrollmentServer();
  try {
    await createEnrollment(fixture.base);
    for (const targetStage of [undefined, { id: "", immediateSends: [] }, { id: "consult" }]) {
      const body = { ...transitionBody(), targetStage };
      const response = await request(
        fixture.base,
        "/communications/education/enrollments/enrollment-api-synthetic-1/transitions",
        "POST",
        body,
      );
      assert.equal(response.status, 400);
    }
    assert.equal(fixture.underlyingSends.length, 1);
  } finally {
    await fixture.close();
  }
});

test("EducationEnrollment transition requires a non-empty trigger", async () => {
  const fixture = await startEnrollmentServer();
  try {
    await createEnrollment(fixture.base);
    for (const trigger of [undefined, "", "   "]) {
      const response = await request(
        fixture.base,
        "/communications/education/enrollments/enrollment-api-synthetic-1/transitions",
        "POST",
        { ...transitionBody(), trigger },
      );
      assert.equal(response.status, 400);
    }
    assert.equal(fixture.underlyingSends.length, 1);
  } finally {
    await fixture.close();
  }
});

test("EducationEnrollment terminal transition with a send preserves all history and outcomes, then permits re-enrollment", async () => {
  const fixture = await startEnrollmentServer();
  try {
    const initial = await createEnrollment(fixture.base);
    const response = await request(
      fixture.base,
      "/communications/education/enrollments/enrollment-api-synthetic-1/transitions",
      "POST",
      terminalTransitionBody("completed", transitionBody().targetStage.immediateSends),
    );
    assert.equal(response.status, 200);
    const completed = (await response.json() as { enrollment: {
      status: string;
      stageHistory: unknown[];
      immediateSends: unknown[];
    } }).enrollment;
    assert.equal(completed.status, "completed");
    assert.equal(completed.stageHistory.length, 2);
    assert.equal(completed.immediateSends.length, 2);
    assert.deepEqual(completed.immediateSends[0], initial.immediateSends[0]);
    assert.equal(fixture.underlyingSends.length, 1);
    assert.equal((completed.immediateSends[1] as { outcome: { outcome: string } }).outcome.outcome, "not-sent");
    assert.deepEqual(fixture.terminalClearProviderCounts, [1]);

    const fetched = await request(
      fixture.base,
      "/communications/education/enrollments/enrollment-api-synthetic-1",
      "GET",
    );
    assert.equal(fetched.status, 200);
    assert.deepEqual((await fetched.json() as { enrollment: unknown }).enrollment, completed);

    const reEnrolled = await request(
      fixture.base,
      "/communications/education/enrollments",
      "POST",
      enrollmentBody(),
    );
    assert.equal(reEnrolled.status, 201);
    assert.equal((await reEnrolled.json() as { enrollment: { id: string } }).enrollment.id, "enrollment-api-synthetic-2");
    assert.equal(fixture.underlyingSends.length, 2);
  } finally {
    await fixture.close();
  }
});

test("EducationEnrollment terminal transition without sends completes and remains readable", async () => {
  const fixture = await startEnrollmentServer();
  try {
    await createEnrollment(fixture.base);
    const response = await request(
      fixture.base,
      "/communications/education/enrollments/enrollment-api-synthetic-1/transitions",
      "POST",
      terminalTransitionBody("cancelled", []),
    );
    assert.equal(response.status, 200);
    const enrollment = (await response.json() as { enrollment: {
      status: string;
      stageHistory: unknown[];
      immediateSends: unknown[];
    } }).enrollment;
    assert.equal(enrollment.status, "cancelled");
    assert.equal(enrollment.stageHistory.length, 2);
    assert.equal(enrollment.immediateSends.length, 1);
    assert.equal(fixture.underlyingSends.length, 1);
    assert.deepEqual(fixture.terminalClearProviderCounts, [1]);
  } finally {
    await fixture.close();
  }
});

test("EducationEnrollment transition persists opt-out suppression with zero provider sends", async () => {
  const fixture = await startEnrollmentServer({ optedOut: true });
  try {
    await createEnrollment(fixture.base);
    const response = await request(
      fixture.base,
      "/communications/education/enrollments/enrollment-api-synthetic-1/transitions",
      "POST",
      transitionBody(),
    );
    assert.equal(response.status, 200);
    const enrollment = (await response.json() as { enrollment: {
      immediateSends: Array<{ outcome?: unknown }>;
    } }).enrollment;
    assert.deepEqual(enrollment.immediateSends[1]?.outcome, {
      outcome: "suppressed",
      reason: "patient-opt-out",
    });
    assert.equal(enrollment.immediateSends[1]?.state, "resolved");
    assert.equal(fixture.underlyingSends.length, 0);
  } finally {
    await fixture.close();
  }
});

test("EducationEnrollment create recovery is re-runnable after a mid-resume failure without another provider send", async () => {
  const fixture = await startEnrollmentServer({ failRecordOutcomeCalls: [1, 2] });
  try {
    const create = await request(fixture.base, "/communications/education/enrollments", "POST", enrollmentBody());
    assert.equal(create.status, 502);
    assert.equal(fixture.underlyingSends.length, 1);
    assert.deepEqual((await fixture.enrollmentStore.read("enrollment-api-synthetic-1"))?.immediateSends[0], {
      content: { id: "dry-eye-basics", version: 2 },
      channel: "sms",
      lane: "clinical",
      idempotencyKey: "enrollment:enrollment-api-synthetic-1:stage1:1",
      state: "in-flight",
    });

    const failedResume = await request(
      fixture.base,
      "/communications/education/enrollments/enrollment-api-synthetic-1/resume",
      "POST",
      {},
    );
    assert.equal(failedResume.status, 502);
    assert.equal(fixture.underlyingSends.length, 1);

    const resumed = await request(
      fixture.base,
      "/communications/education/enrollments/enrollment-api-synthetic-1/resume",
      "POST",
      {},
    );
    assert.equal(resumed.status, 200);
    assert.equal(fixture.underlyingSends.length, 1);
    assert.equal(fixture.auditReasons.includes("communications-education-enrollment-resume"), true);
    assert.deepEqual((await resumed.json() as { enrollment: { immediateSends: unknown[] } }).enrollment.immediateSends[0], {
      content: { id: "dry-eye-basics", version: 2 },
      channel: "sms",
      lane: "clinical",
      idempotencyKey: "enrollment:enrollment-api-synthetic-1:stage1:1",
      state: "resolved",
      outcome: { outcome: "sent", providerMessageId: "SM-enrollment-synthetic-1" },
    });

    const resumedAgain = await request(
      fixture.base,
      "/communications/education/enrollments/enrollment-api-synthetic-1/resume",
      "POST",
      {},
    );
    assert.equal(resumedAgain.status, 200);
    assert.equal(fixture.underlyingSends.length, 1);
  } finally {
    await fixture.close();
  }
});

test("EducationEnrollment resumes a create-Provenance failure after state commit and sends exactly once", async () => {
  const fixture = await startEnrollmentServer({ failProvenanceCreateCalls: [1] });
  try {
    const create = await request(fixture.base, "/communications/education/enrollments", "POST", enrollmentBody());
    assert.equal(create.status, 502);
    assert.equal(fixture.underlyingSends.length, 0);
    assert.equal((await fixture.enrollmentStore.read("enrollment-api-synthetic-1"))?.immediateSends[0]?.state, "pending");

    const resumed = await request(
      fixture.base,
      "/communications/education/enrollments/enrollment-api-synthetic-1/resume",
      "POST",
      {},
    );
    assert.equal(resumed.status, 200);
    assert.equal(fixture.underlyingSends.length, 1);
    assert.equal((await resumed.json() as { enrollment: { immediateSends: Array<{ state: string }> } })
      .enrollment.immediateSends[0]?.state, "resolved");

    const resumedAgain = await request(
      fixture.base,
      "/communications/education/enrollments/enrollment-api-synthetic-1/resume",
      "POST",
      {},
    );
    assert.equal(resumedAgain.status, 200);
    assert.equal(fixture.underlyingSends.length, 1);
  } finally {
    await fixture.close();
  }
});

test("EducationEnrollment transition failure is recoverable without re-dispatching its provider send", async () => {
  const fixture = await startEnrollmentServer({ failRecordOutcomeCalls: [2] });
  try {
    await createEnrollment(fixture.base);
    const transition = await request(
      fixture.base,
      "/communications/education/enrollments/enrollment-api-synthetic-1/transitions",
      "POST",
      transitionBody(),
    );
    assert.equal(transition.status, 502);
    assert.equal(fixture.underlyingSends.length, 2);
    assert.equal((await fixture.enrollmentStore.read("enrollment-api-synthetic-1"))?.immediateSends[1]?.state, "in-flight");

    const resumed = await request(
      fixture.base,
      "/communications/education/enrollments/enrollment-api-synthetic-1/resume",
      "POST",
      {},
    );
    assert.equal(resumed.status, 200);
    assert.equal(fixture.underlyingSends.length, 2);
    assert.equal((await resumed.json() as { enrollment: { immediateSends: Array<{ state: string }> } })
      .enrollment.immediateSends[1]?.state, "resolved");
  } finally {
    await fixture.close();
  }
});

test("EducationEnrollment resumes a mid-transition Provenance failure from committed pending state", async () => {
  const fixture = await startEnrollmentServer({ failProvenanceCreateCalls: [3] });
  try {
    await createEnrollment(fixture.base);
    const transition = await request(
      fixture.base,
      "/communications/education/enrollments/enrollment-api-synthetic-1/transitions",
      "POST",
      transitionBody(),
    );
    assert.equal(transition.status, 502);
    assert.equal(fixture.underlyingSends.length, 1);
    assert.equal((await fixture.enrollmentStore.read("enrollment-api-synthetic-1"))?.immediateSends[1]?.state, "pending");

    const resumed = await request(
      fixture.base,
      "/communications/education/enrollments/enrollment-api-synthetic-1/resume",
      "POST",
      {},
    );
    assert.equal(resumed.status, 200);
    assert.equal(fixture.underlyingSends.length, 2);
    assert.equal((await resumed.json() as { enrollment: { immediateSends: Array<{ state: string }> } })
      .enrollment.immediateSends[1]?.state, "resolved");
  } finally {
    await fixture.close();
  }
});

test("EducationEnrollment email uses the same durable reservation and resumes without another provider send", async () => {
  const options = { failRecordOutcomeCalls: [1], staffReference: "Practitioner/provider" };
  const fixture = await startEnrollmentServer(options);
  try {
    const create = await request(
      fixture.base,
      "/communications/education/enrollments",
      "POST",
      emailEnrollmentBody(),
    );
    assert.equal(create.status, 502);
    assert.equal(fixture.underlyingEmailSends.length, 1);
    assert.equal(fixture.communications[0]?.medium?.[0]?.text, "Email");
    assert.equal(fixture.communications[0]?.identifier?.some((identifier) =>
      identifier.system === "https://odos2020.com/fhir/NamingSystem/comms-staff-send"
      && identifier.value === "enrollment:enrollment-api-synthetic-1:stage1:1"), true);

    options.staffReference = "Practitioner/reconciling-provider";
    const resumed = await request(
      fixture.base,
      "/communications/education/enrollments/enrollment-api-synthetic-1/resume",
      "POST",
      {},
      { id: "reconciling-provider" },
    );
    assert.equal(resumed.status, 200);
    assert.equal(fixture.underlyingEmailSends.length, 1);
    assert.deepEqual((await resumed.json() as { enrollment: { immediateSends: Array<Record<string, unknown>> } })
      .enrollment.immediateSends[0], {
      content: { id: "dry-eye-basics", version: 2 },
      channel: "email",
      lane: "clinical",
      idempotencyKey: "enrollment:enrollment-api-synthetic-1:stage1:1",
      state: "resolved",
      outcome: { outcome: "sent", providerMessageId: "EMAIL-enrollment-synthetic-1" },
    });
  } finally {
    await fixture.close();
  }
});

test("EducationEnrollment terminal cancellation retains an unresolved active lock until practitioner acknowledgement", async () => {
  const fixture = await startEnrollmentServer();
  try {
    const created = await fixture.enrollmentStore.create({
      patientReference: PATIENT_REFERENCE, enteredFromEncounterReference: ENCOUNTER_REFERENCE,
      enrolledBy: "Practitioner/provider", journey: { id: "dry-eye-foundations", version: 1 },
      status: "active", currentStageId: "welcome", stageEnteredAt: "2026-09-01T14:00:00.000Z",
      stageHistory: [{ stageId: "welcome", enteredAt: "2026-09-01T14:00:00.000Z", enteredBy: "Practitioner/provider", reason: "enrollment-recorded" }],
      immediateSends: [{ content: { id: "dry-eye-basics", version: 2 }, channel: "sms", lane: "clinical" }],
    });
    // Seed the durable pre-existing attempt boundary without invoking an adapter.
    await fixture.enrollmentStore.claimImmediateSend(created.id, 0);
    const transition = await request(fixture.base, `/communications/education/enrollments/${created.id}/transitions`, "POST", terminalTransitionBody("cancelled", []));
    assert.equal(transition.status, 200);
    assert.equal((await transition.json()).enrollment.status, "cancelled");
    const duplicate = await request(fixture.base, "/communications/education/enrollments", "POST", enrollmentBody());
    assert.equal(duplicate.status, 409);
    const resume = await request(fixture.base, `/communications/education/enrollments/${created.id}/resume`, "POST", { acknowledgeIndeterminate: true, reason: "Historical outcome remains unknown after practitioner review." });
    assert.equal(resume.status, 200);
    assert.equal((await resume.json()).enrollment.immediateSends[0].state, "indeterminate");
    assert.equal(fixture.underlyingSends.length, 0);
    assert.equal(fixture.underlyingEmailSends.length, 0);
  } finally { await fixture.close(); }
});

test("EducationEnrollment resume keeps an unresolved in-flight send in-flight unless explicitly acknowledged with a reason and Provenance", async () => {
  const fixture = await startEnrollmentServer({ failCommunicationUpdateCalls: [1] });
  try {
    const create = await request(fixture.base, "/communications/education/enrollments", "POST", enrollmentBody());
    assert.equal(create.status, 502);
    assert.equal(fixture.underlyingSends.length, 1);
    assert.equal((await fixture.enrollmentStore.read("enrollment-api-synthetic-1"))?.immediateSends[0]?.state, "in-flight");

    const blockedTransition = await request(
      fixture.base,
      "/communications/education/enrollments/enrollment-api-synthetic-1/transitions",
      "POST",
      transitionBody(),
    );
    assert.equal(blockedTransition.status, 409);
    assert.deepEqual(await blockedTransition.json(), {
      outcome: "refused",
      reason: "pending-reconciliation",
    });
    assert.equal(fixture.underlyingSends.length, 1);

    const withoutAcknowledgement = await request(
      fixture.base,
      "/communications/education/enrollments/enrollment-api-synthetic-1/resume",
      "POST",
      {},
    );
    assert.equal(withoutAcknowledgement.status, 409);
    assert.deepEqual(await withoutAcknowledgement.json(), {
      outcome: "refused",
      reason: "pending-reconciliation",
    });
    assert.equal(fixture.underlyingSends.length, 1);
    assert.equal((await fixture.enrollmentStore.read("enrollment-api-synthetic-1"))?.immediateSends[0]?.state, "in-flight");

    const emptyReason = await request(
      fixture.base,
      "/communications/education/enrollments/enrollment-api-synthetic-1/resume",
      "POST",
      { acknowledgeIndeterminate: true, reason: "   " },
    );
    assert.equal(emptyReason.status, 400);
    assert.equal((await fixture.enrollmentStore.read("enrollment-api-synthetic-1"))?.immediateSends[0]?.state, "in-flight");

    const acknowledged = await request(
      fixture.base,
      "/communications/education/enrollments/enrollment-api-synthetic-1/resume",
      "POST",
      {
        acknowledgeIndeterminate: true,
        reason: "Provider accepted the request but persistence failed before its receipt was recorded.",
      },
    );
    assert.equal(acknowledged.status, 200);
    assert.equal(fixture.underlyingSends.length, 1);
    const send = (await acknowledged.json() as { enrollment: { immediateSends: Array<Record<string, unknown>> } })
      .enrollment.immediateSends[0];
    assert.deepEqual(send, {
      content: { id: "dry-eye-basics", version: 2 },
      channel: "sms",
      lane: "clinical",
      idempotencyKey: "enrollment:enrollment-api-synthetic-1:stage1:1",
      state: "indeterminate",
      acknowledgement: {
        reason: "Provider accepted the request but persistence failed before its receipt was recorded.",
        acknowledgedAt: "2026-09-01T14:00:00.000Z",
        acknowledgedBy: "Practitioner/provider",
      },
    });
    assert.equal(fixture.provenances.some((provenance) =>
      provenance.activity?.text === "Acknowledge indeterminate education send"), true);

    const acknowledgedAgain = await request(
      fixture.base,
      "/communications/education/enrollments/enrollment-api-synthetic-1/resume",
      "POST",
      {
        acknowledgeIndeterminate: true,
        reason: "Provider accepted the request but persistence failed before its receipt was recorded.",
      },
    );
    assert.equal(acknowledgedAgain.status, 200);
    assert.equal(fixture.underlyingSends.length, 1);
  } finally {
    await fixture.close();
  }
});

test("EducationEnrollment transition revalidates its Provenance encounter against the enrolled patient", async () => {
  const fixture = await startEnrollmentServer();
  try {
    await createEnrollment(fixture.base);
    fixture.encounters[0]!.subject = { reference: "Patient/synthetic-enrollment-2" };
    const response = await request(
      fixture.base,
      "/communications/education/enrollments/enrollment-api-synthetic-1/transitions",
      "POST",
      transitionBody(),
    );
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), {
      error: `encounterReference must belong to ${PATIENT_REFERENCE}.`,
    });
    assert.equal(fixture.provenances.length, 2);
    assert.equal(fixture.underlyingSends.length, 1);
  } finally {
    await fixture.close();
  }
});

test("one-shot education remains behaviorally intact beside EducationEnrollment", async () => {
  const fixture = await startEnrollmentServer();
  try {
    const response = await request(fixture.base, "/communications/education/dispatch", "POST", {
      patientReference: PATIENT_REFERENCE,
      educationId: "dry-eye-basics",
      version: 2,
      channel: "sms",
      lane: "clinical",
      encounterReference: ENCOUNTER_REFERENCE,
      idempotencyKey: "education-one-shot-still-works",
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      outcome: "sent",
      providerMessageId: "SM-enrollment-synthetic-1",
    });
    assert.equal(fixture.underlyingSends.length, 1);
    assert.equal(fixture.trackedLinks.length, 1);
    assert.equal(fixture.provenances.length, 1);
  } finally {
    await fixture.close();
  }
});

function enrollmentBody() {
  return {
    patientReference: PATIENT_REFERENCE,
    encounterReference: ENCOUNTER_REFERENCE,
    journey: { id: "dry-eye-foundations", version: 1 },
    initialStage: {
      id: "welcome",
      immediateSends: [{
        educationId: "dry-eye-basics",
        version: 2,
        channel: "sms",
        lane: "clinical",
      }],
    },
  };
}

function emailEnrollmentBody() {
  const body = enrollmentBody();
  return {
    ...body,
    initialStage: {
      ...body.initialStage,
      immediateSends: [{
        educationId: "dry-eye-basics",
        version: 2,
        channel: "email",
        lane: "clinical",
      }],
    },
  };
}

function transitionBody() {
  return {
    fromStageId: "welcome",
    targetStage: {
      id: "consult",
      immediateSends: [{
        educationId: "dry-eye-basics",
        version: 2,
        channel: "sms" as const,
        lane: "clinical" as const,
      }],
    },
    trigger: "consult-completed",
    status: "active" as const,
  };
}

function terminalTransitionBody(
  status: "completed" | "cancelled",
  immediateSends: ReturnType<typeof transitionBody>["targetStage"]["immediateSends"],
) {
  return {
    fromStageId: "welcome",
    targetStage: { id: status === "completed" ? "complete" : "cancelled", immediateSends },
    trigger: "clinician-action",
    status,
  };
}

async function createEnrollment(base: string) {
  const response = await request(base, "/communications/education/enrollments", "POST", enrollmentBody());
  assert.equal(response.status, 201);
  return (await response.json() as { enrollment: {
    id: string;
    immediateSends: Array<Record<string, unknown>>;
  } }).enrollment;
}

async function startEnrollmentServer(options: {
  enrollmentStore?: EducationEnrollmentStore;
  optedOut?: boolean;
  marketingContent?: boolean;
  unavailableContent?: boolean;
  internalContent?: boolean;
  staffRole?: "provider" | "staff";
  staffReference?: string;
  failRecordOutcomeCalls?: number[];
  failCommunicationUpdateCalls?: number[];
  failProvenanceCreateCalls?: number[];
} = {}) {
  const patient: Patient = {
    resourceType: "Patient",
    id: "synthetic-enrollment-1",
    telecom: [
      { system: "phone", value: "+18645550199", use: "mobile" },
      { system: "email", value: "synthetic.patient@example.test", use: "home" },
    ],
    ...(options.optedOut ? {
      extension: [{
        url: ODOS_COMMS_OPT_OUT_EXTENSION_URL,
        extension: [
          { url: "channel", valueCode: "sms" },
          { url: "number", valueString: "+18485550100" },
        ],
      }],
    } : {}),
  };
  const encounters: Encounter[] = [{
    resourceType: "Encounter",
    id: "synthetic-enrollment-encounter-1",
    status: "in-progress",
    class: { code: "AMB" },
    subject: { reference: PATIENT_REFERENCE },
  }, {
    resourceType: "Encounter",
    id: "synthetic-enrollment-encounter-other",
    status: "in-progress",
    class: { code: "AMB" },
    subject: { reference: "Patient/synthetic-enrollment-2" },
  }];
  const communications: Communication[] = [];
  const provenances: Provenance[] = [];
  const underlyingSends: SendSmsRequest[] = [];
  const underlyingEmailSends: SendEmailRequest[] = [];
  const trackedLinks: Array<{
    token: string;
    targetUrl: string;
    campaignId: string;
    messageId: string;
    createdAt: string;
  }> = [];
  const auditReasons: string[] = [];
  let enrollmentSequence = 0;
  const storedEnrollments = options.enrollmentStore ?? createInMemoryEducationEnrollmentStore({
    generateId: () => `enrollment-api-synthetic-${++enrollmentSequence}`,
  });
  const terminalClearProviderCounts: number[] = [];
  let recordOutcomeCallCount = 0;
  const enrollmentStore = {
    ...storedEnrollments,
    async recordImmediateSendOutcome(
      id: string,
      sendIndex: number,
      outcome: Parameters<typeof storedEnrollments.recordImmediateSendOutcome>[2],
    ) {
      recordOutcomeCallCount += 1;
      if (options.failRecordOutcomeCalls?.includes(recordOutcomeCallCount)) {
        throw new Error("Synthetic immediate-send outcome persistence failure.");
      }
      return storedEnrollments.recordImmediateSendOutcome(id, sendIndex, outcome);
    },
    async clearTerminalActiveIdentifier(id: string) {
      terminalClearProviderCounts.push(underlyingSends.length);
      return storedEnrollments.clearTerminalActiveIdentifier(id);
    },
  };
  let communicationUpdateCallCount = 0;
  let provenanceCreateCallCount = 0;
  const callerFhir = {
    baseUrl: "https://synthetic.example/fhir/R4",
    async read<T extends Resource>(resourceType: T["resourceType"], id: string): Promise<T> {
      const resource = resourceType === "Patient" && id === patient.id
        ? patient
        : resourceType === "Encounter"
          ? encounters.find((entry) => entry.id === id)
          : undefined;
      if (!resource) throw Object.assign(new Error(`Missing ${resourceType}/${id}`), { status: 404 });
      return structuredClone(resource) as T;
    },
    async search<T extends Resource>(resourceType: T["resourceType"], params: Record<string, string> = {}): Promise<Bundle<T>> {
      assert.equal(resourceType, "Communication");
      const idempotencyKey = params.identifier?.split("|").at(-1);
      const matches = idempotencyKey
        ? communications.filter((communication) => communication.identifier?.some((identifier) =>
          identifier.value === idempotencyKey))
        : [];
      return {
        resourceType: "Bundle",
        type: "searchset",
        entry: matches.map((resource) => ({ resource: structuredClone(resource) as T })),
      };
    },
    async searchUrl<T extends Resource>(): Promise<Bundle<T>> {
      throw new Error("Unexpected enrollment API pagination.");
    },
    async create<T extends Resource>(resource: T, extraHeaders: Record<string, string> = {}): Promise<T> {
      if (resource.resourceType === "Provenance") {
        const eventTag = resource.meta?.tag?.find((tag) =>
          tag.system === "https://odos2020.com/fhir/NamingSystem/comms-education-enrollment-event");
        const existing = eventTag
          ? provenances.find((provenance) => provenance.meta?.tag?.some((tag) =>
            tag.system === eventTag.system && tag.code === eventTag.code))
          : undefined;
        if (extraHeaders["If-None-Exist"] && existing) return structuredClone(existing) as T;
        provenanceCreateCallCount += 1;
        if (options.failProvenanceCreateCalls?.includes(provenanceCreateCallCount)) {
          throw new Error("Synthetic Provenance create failure.");
        }
      }
      const persisted = {
        ...structuredClone(resource),
        id: `${resource.resourceType.toLowerCase()}-${communications.length + provenances.length + 1}`,
        meta: { versionId: randomUUID() },
      } as T;
      if (persisted.resourceType === "Communication") {
        communications.push(structuredClone(persisted as Communication));
      }
      if (persisted.resourceType === "Provenance") {
        provenances.push(structuredClone(persisted as Provenance));
      }
      return structuredClone(persisted);
    },
    async update<T extends Resource>(resourceType: T["resourceType"], id: string, resource: T, headers?: Record<string, string>): Promise<T> {
      assert.equal(resourceType, "Communication");
      communicationUpdateCallCount += 1;
      if (options.failCommunicationUpdateCalls?.includes(communicationUpdateCallCount)) {
        throw new Error("Synthetic Communication update failure.");
      }
      const index = communications.findIndex((entry) => entry.id === id);
      assert.notEqual(index, -1);
      if (headers?.["If-Match"] !== `W/"${communications[index]?.meta?.versionId}"`) {
        throw Object.assign(new Error("Stale Communication version"), { status: 412 });
      }
      const persisted = {
        ...structuredClone(resource),
        id,
        meta: { versionId: randomUUID() },
      } as T;
      communications[index] = structuredClone(persisted as Communication);
      return structuredClone(persisted);
    },
  };
  const underlyingProvider: CommsProvider = {
    name: "synthetic-enrollment-provider",
    messageIdentifierSystem: "https://odos2020.com/fhir/NamingSystem/synthetic-enrollment-message",
    capabilities: {
      sms: true,
      calls: false,
      email: true,
      contacts: false,
      conversations: false,
      reviews: false,
    },
    async sendSms(send) {
      underlyingSends.push(structuredClone(send));
      return {
        outcome: "sent",
        providerMessageId: `SM-enrollment-synthetic-${underlyingSends.length}`,
      };
    },
    async sendEmail(send) {
      underlyingEmailSends.push(structuredClone(send));
      return {
        outcome: "sent",
        providerMessageId: `EMAIL-enrollment-synthetic-${underlyingEmailSends.length}`,
      };
    },
  };
  const suppressedProvider = createSuppressedCommsProvider(underlyingProvider, {
    fhir: callerFhir,
    practiceTimeZone: "America/New_York",
    smsSenderNumber: "+18485550100",
    stopScope: "per-number",
    now: () => new Date("2026-09-01T14:00:00.000Z"),
  });
  const audit: CommsApiRouteDeps["audit"] = {
    async record(row, operation) {
      const result = await operation();
      auditReasons.push(row.actionReason);
      return result;
    },
    async recordDenied(row) {
      auditReasons.push(row.actionReason);
    },
  };
  const deps: CommsApiRouteDeps = {
    authenticateService: async () => undefined,
    authenticate: async (header) => header === "Bearer provider" ? {
      staffReference: options.staffReference ?? "Practitioner/provider",
      actorRole: options.staffRole ?? "provider",
      roles: [options.staffRole ?? "provider"],
      fhir: callerFhir as never,
    } : null,
    fhir: callerFhir as never,
    dispatch: {
      initialize: async () => undefined,
      providers: () => ["synthetic-enrollment-provider"],
      providerFor: (role) => role === "clinical-sms" || role === "email"
        ? "synthetic-enrollment-provider"
        : undefined,
      senderNumberFor: (role) => role === "clinical-sms" ? "+18485550100" : undefined,
      getAdapter: () => suppressedProvider,
      getAdapterForRole: () => suppressedProvider,
    },
    educationCatalog: {
      list: () => [],
      get: (id, version) => !options.unavailableContent && id === "dry-eye-basics" && version === 2 ? {
        id,
        version,
        title: "Understanding dry eye",
        kind: "video",
        audience: options.internalContent ? "internal" : "patient",
        dxCodes: [],
        channels: ["sms", "email", "print"],
        laneHint: "clinical",
        consentClass: options.marketingContent ? "marketing" : "transactional",
        urls: {
          web: "https://education.invalid/dry-eye-basics/v2",
          email: "https://education.invalid/dry-eye-basics/v2/email",
          print: "https://education.invalid/dry-eye-basics/v2/print",
        },
      } : undefined,
    },
    trackedLinkStore: {
      async create(link) {
        trackedLinks.push(structuredClone(link));
      },
      async find(token) {
        return trackedLinks.find((entry) => entry.token === token);
      },
      async logClick() {},
    },
    enrollmentStore,
    publicBaseUrl: "https://practice.example",
    practiceName: "Synthetic Eye Care",
    audit,
    now: () => "2026-09-01T14:00:00.000Z",
  };
  const app = express();
  app.use(express.json());
  registerCommsApiRoutes(app, deps);
  const server = app.listen(0);
  await once(server, "listening");
  const address = server.address() as AddressInfo;
  return {
    base: `http://127.0.0.1:${address.port}`,
    enrollmentStore,
    communications,
    encounters,
    underlyingSends,
    underlyingEmailSends,
    terminalClearProviderCounts,
    trackedLinks,
    provenances,
    auditReasons,
    close: async () => {
      server.close();
      await once(server, "close");
    },
  };
}

function request(base: string, path: string, method: string, body?: unknown, actor: { id?: string; role?: string } = {}): Promise<Response> {
  return fetch(`${base}${path}`, {
    method,
    headers: {
      authorization: "Bearer provider",
      "x-odos-actor-id": actor.id ?? "provider",
      "x-odos-actor-role": actor.role ?? "provider",
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}


function sequenceBody() {
  return {
    id: "synthetic-sequence", version: 1,
    steps: [{
      stepIndex: 0, channel: "sms", lane: "clinical",
      content: { id: "dry-eye-basics", version: 2 },
      recipientReference: PATIENT_REFERENCE,
      plannedAt: "2026-09-02T14:00:00.000Z", notBefore: "2026-09-02T14:00:00.000Z",
      latestUsefulTime: "2026-09-08T14:00:00.000Z", anchor: "stage-entry", offsetDays: 1,
      dayInterpretation: "calendar", timezone: "America/New_York",
    }],
  };
}

function futureEnrollmentBody() {
  return { ...enrollmentBody(), requestId: "synthetic-admission-1",
    initialStage: { id: "welcome", immediateSends: [], sequence: sequenceBody() } };
}

test("sequence API admits future-only education idempotently without attempting a message", async () => {
  const fixture = await startEnrollmentServer();
  try {
    const body = futureEnrollmentBody();
    const first = await request(fixture.base, "/communications/education/enrollments", "POST", body);
    assert.equal(first.status, 201);
    const original = (await first.json()).enrollment;
    const retry = await request(fixture.base, "/communications/education/enrollments", "POST", body);
    assert.equal(retry.status, 201);
    const repeated = (await retry.json()).enrollment;
    assert.equal(repeated.id, original.id);
    assert.equal(repeated.scheduledSends.length, 1);
    assert.deepEqual(repeated.scheduledSends, original.scheduledSends);
    assert.deepEqual(repeated.immediateSends, []);
    assert.equal(fixture.underlyingSends.length, 0);
    assert.equal(fixture.underlyingEmailSends.length, 0);
    assert.equal(fixture.trackedLinks.length, 0);
  } finally { await fixture.close(); }
});

test("sequence API refuses missing latest useful time and unpublished content before any enrollment write", async () => {
  for (const change of [
    (step: Record<string, unknown>) => { delete step.latestUsefulTime; },
    (step: Record<string, unknown>) => { step.content = { id: "missing-item", version: 1 }; },
    (step: Record<string, unknown>) => { step.recipientReference = "Patient/another-patient"; },
  ]) {
    const fixture = await startEnrollmentServer();
    try {
      const body = futureEnrollmentBody();
      change(body.initialStage.sequence.steps[0]);
      const response = await request(fixture.base, "/communications/education/enrollments", "POST", body);
      assert.ok([400, 404, 409].includes(response.status));
      assert.deepEqual(await fixture.enrollmentStore.listActiveForPatient(PATIENT_REFERENCE), []);
      assert.equal(fixture.provenances.length, 0);
      assert.equal(fixture.underlyingSends.length, 0);
    } finally { await fixture.close(); }
  }
});

test("sequence API accepts print as a staff task and resume never sends scheduled work", async () => {
  const fixture = await startEnrollmentServer();
  try {
    const body = futureEnrollmentBody();
    body.initialStage.sequence.steps[0].channel = "print";
    const response = await request(fixture.base, "/communications/education/enrollments", "POST", body);
    assert.equal(response.status, 201);
    const enrollment = (await response.json()).enrollment;
    assert.equal(enrollment.scheduledSends[0].channel, "print");
    const resume = await request(fixture.base, `/communications/education/enrollments/${enrollment.id}/resume`, "POST", {});
    assert.equal(resume.status, 200);
    assert.deepEqual((await resume.json()).enrollment.scheduledSends, enrollment.scheduledSends);
    assert.equal(fixture.underlyingSends.length, 0);
    assert.equal(fixture.underlyingEmailSends.length, 0);
  } finally { await fixture.close(); }
});

test("sequence API refuses whole 65-step activation before writes even beside an immediate send", async () => {
  const fixture = await startEnrollmentServer();
  try {
    const body = futureEnrollmentBody();
    body.initialStage.sequence.steps = Array.from({ length: 65 }, (_, stepIndex) => ({ ...sequenceBody().steps[0], stepIndex }));
    const response = await request(fixture.base, "/communications/education/enrollments", "POST", {
      ...body, initialStage: { ...body.initialStage, immediateSends: enrollmentBody().initialStage.immediateSends },
    });
    assert.equal(response.status, 409);
    assert.deepEqual(await fixture.enrollmentStore.listActiveForPatient(PATIENT_REFERENCE), []);
    assert.equal(fixture.provenances.length, 0);
    assert.equal(fixture.underlyingSends.length, 0);
  } finally { await fixture.close(); }
});


test("sequence API starts a second activation, stops only one, and atomically cancels the old stage on transition", async () => {
  const fixture = await startEnrollmentServer();
  try {
    const created = await request(fixture.base, "/communications/education/enrollments", "POST", futureEnrollmentBody());
    assert.equal(created.status, 201);
    const initial = (await created.json()).enrollment;
    const start = await request(fixture.base, `/communications/education/enrollments/${initial.id}/sequences`, "POST", { requestId: "second-activation", sequence: sequenceBody() });
    assert.equal(start.status, 200);
    const two = (await start.json()).enrollment;
    assert.equal(two.activations.length, 2);
    const stop = await request(fixture.base, `/communications/education/enrollments/${initial.id}/sequences/${two.activations[0].id}/stop`, "POST", { reason: "Clinician stopped this sequence." });
    assert.equal(stop.status, 200);
    const stopped = (await stop.json()).enrollment;
    assert.deepEqual(stopped.scheduledSends.map((row: { disposition: string }) => row.disposition), ["cancelled", "scheduled"]);
    const resumed = await request(fixture.base, `/communications/education/enrollments/${initial.id}/resume`, "POST", {});
    assert.equal(resumed.status, 200);
    assert.deepEqual((await resumed.json()).enrollment.scheduledSends, stopped.scheduledSends);
    const replayedCreate = await request(fixture.base, "/communications/education/enrollments", "POST", futureEnrollmentBody());
    assert.equal(replayedCreate.status, 201);
    assert.deepEqual((await replayedCreate.json()).enrollment.scheduledSends, stopped.scheduledSends);
    const oneShot = await request(fixture.base, "/communications/education/dispatch", "POST", {
      patientReference: PATIENT_REFERENCE, educationId: "dry-eye-basics", version: 2,
      channel: "sms", lane: "clinical", idempotencyKey: "synthetic-context-dispatch",
      enrollmentId: initial.id,
    });
    assert.equal(oneShot.status, 409);
    assert.deepEqual((await fixture.enrollmentStore.read(initial.id))?.scheduledSends, stopped.scheduledSends);
    const body = { ...transitionBody(), requestId: "new-stage-activation", targetStage: { id: "consult", immediateSends: [], sequence: sequenceBody() } };
    const transition = await request(fixture.base, `/communications/education/enrollments/${initial.id}/transitions`, "POST", body);
    assert.equal(transition.status, 200);
    const moved = (await transition.json()).enrollment;
    assert.equal(moved.currentStageId, "consult");
    assert.deepEqual(moved.scheduledSends.map((row: { disposition: string }) => row.disposition), ["cancelled", "cancelled", "scheduled"]);
    const retry = await request(fixture.base, `/communications/education/enrollments/${initial.id}/transitions`, "POST", body);
    assert.equal(retry.status, 200);
    assert.equal((await retry.json()).enrollment.scheduledSends.length, 3);
    assert.equal(fixture.underlyingSends.length, 0);
  } finally { await fixture.close(); }
});


test("sequence API refuses internal content and absent marketing consent before writes", async () => {
  for (const options of [{ internalContent: true }, { marketingContent: true }]) {
    const fixture = await startEnrollmentServer(options);
    try {
      const response = await request(fixture.base, "/communications/education/enrollments", "POST", futureEnrollmentBody());
      assert.equal(response.status, options.internalContent ? 404 : 409);
      assert.deepEqual(await fixture.enrollmentStore.listActiveForPatient(PATIENT_REFERENCE), []);
      assert.equal(fixture.provenances.length, 0);
      assert.equal(fixture.underlyingSends.length, 0);
    } finally { await fixture.close(); }
  }
});

test("sequence row identity cannot be used to bypass admission through one-shot dispatch", async () => {
  const fixture = await startEnrollmentServer();
  try {
    const created = await request(fixture.base, "/communications/education/enrollments", "POST", futureEnrollmentBody());
    assert.equal(created.status, 201);
    const enrollment = (await created.json()).enrollment;
    for (const channel of ["sms", "print"]) {
      const response = await request(fixture.base, "/communications/education/dispatch", "POST", {
        patientReference: PATIENT_REFERENCE, educationId: "dry-eye-basics", version: 2,
        channel, lane: "clinical", encounterReference: ENCOUNTER_REFERENCE,
        idempotencyKey: enrollment.scheduledSends[0].id,
      });
      assert.equal(response.status, 409);
      assert.equal((await response.json()).reason, channel === "print" ? "print-sequence-electronic-dispatch-refused" : "sequence-dispatch-not-enabled");
    }
    assert.equal(fixture.underlyingSends.length, 0);
    assert.equal(fixture.underlyingEmailSends.length, 0);
  } finally { await fixture.close(); }
});


test("sequence API records a new stage while an old attempt is unknown and only practitioner acknowledgement releases its hold", async () => {
  for (const staffRole of ["provider", "staff"] as const) {
    const fixture = await startEnrollmentServer({ staffRole, unavailableContent: true });
    try {
      const created = await fixture.enrollmentStore.create({
        patientReference: PATIENT_REFERENCE, enteredFromEncounterReference: ENCOUNTER_REFERENCE,
        enrolledBy: "Practitioner/provider", journey: { id: "dry-eye-foundations", version: 1 },
        status: "active", currentStageId: "welcome", stageEnteredAt: "2026-09-01T14:00:00.000Z",
        stageHistory: [{ stageId: "welcome", enteredAt: "2026-09-01T14:00:00.000Z", enteredBy: "Practitioner/provider", reason: "enrollment-recorded" }],
        immediateSends: [{ content: { id: "dry-eye-basics", version: 2 }, channel: "sms", lane: "clinical" }],
      });
      await fixture.enrollmentStore.claimImmediateSend(created.id, 0);
      const moved = await fixture.enrollmentStore.transition(created.id, {
        fromStageId: "welcome", targetStageId: "consult", trigger: "clinician-action", enteredAt: "2026-09-01T14:00:00.000Z", enteredBy: "Practitioner/provider", status: "active", immediateSends: [],
        requestId: "held-sequence-activation", sequence: sequenceBody() as never,
      });
      assert.equal(moved.currentStageId, "consult");
      assert.equal(moved.scheduledSends?.[0].disposition, "held");
      const resume = await request(fixture.base, `/communications/education/enrollments/${created.id}/resume`, "POST", { acknowledgeIndeterminate: true, reason: "Reviewed the unknown historical attempt." }, { role: staffRole });
      if (staffRole === "provider") {
        assert.equal(resume.status, 200);
        assert.equal((await resume.json()).enrollment.scheduledSends[0].disposition, "scheduled");
      } else {
        assert.ok([403, 409].includes(resume.status));
        assert.equal((await fixture.enrollmentStore.read(created.id))?.scheduledSends?.[0].disposition, "held");
      }
      assert.equal(fixture.underlyingSends.length, 0);
      assert.equal(fixture.underlyingEmailSends.length, 0);
    } finally { await fixture.close(); }
  }
});


test("sequence API accepts a future-only stage without a redundant empty immediateSends array", async () => {
  const fixture = await startEnrollmentServer();
  try {
    const body = futureEnrollmentBody();
    const response = await request(fixture.base, "/communications/education/enrollments", "POST", {
      ...body, initialStage: { id: body.initialStage.id, sequence: body.initialStage.sequence },
    });
    assert.equal(response.status, 201);
    assert.deepEqual((await response.json()).enrollment.immediateSends, []);
    assert.equal(fixture.underlyingSends.length, 0);
  } finally { await fixture.close(); }
});

for (const operation of ["admit", "stop"] as const) {
  for (const conflictStatus of [409, 412]) {
    test(`sequence HTTP ${operation} lost ${conflictStatus} race returns typed 409 without retry`, async () => {
      let persisted: Basic | undefined;
      let race = false;
      let attempts = 0;
      const fhir = {
        async search<T extends Resource>(): Promise<Bundle<T>> { return { resourceType: "Bundle", type: "searchset", entry: [] }; },
        async read<T extends Resource>(): Promise<T> { return structuredClone(persisted) as T; },
        async create<T extends Resource>(resource: T): Promise<T> {
          persisted = { ...structuredClone(resource) as Basic, meta: { versionId: randomUUID() } };
          return structuredClone(persisted) as T;
        },
        async update<T extends Resource>(_type: string, _id: string, resource: T, headers?: Record<string, string>): Promise<T> {
          attempts++;
          assert.equal(headers?.["If-Match"], `W/"${persisted!.meta!.versionId}"`);
          if (race) persisted!.meta!.versionId = randomUUID();
          if (headers?.["If-Match"] !== `W/"${persisted!.meta!.versionId}"`)
            throw Object.assign(new Error("Stale enrollment version"), { status: conflictStatus });
          persisted = { ...structuredClone(resource) as Basic, meta: { versionId: randomUUID() } };
          return structuredClone(persisted) as T;
        },
      };
      const store = createFhirEducationEnrollmentStore(fhir);
      const fixture = await startEnrollmentServer({ enrollmentStore: store });
      try {
        const created = await request(fixture.base, "/communications/education/enrollments", "POST", futureEnrollmentBody());
        assert.equal(created.status, 201);
        const { enrollment } = await created.json();
        const before = structuredClone(persisted);
        const beforeAttempts = attempts;
        race = true;
        const path = `/communications/education/enrollments/${enrollment.id}/sequences`;
        const response = await request(fixture.base, operation === "admit" ? path : `${path}/${enrollment.activations[0].id}/stop`, "POST",
          operation === "admit" ? { requestId: "racing-activation", sequence: sequenceBody() } : { reason: "Clinician stop" });
        assert.equal(response.status, 409);
        assert.deepEqual(await response.json(), { outcome: "refused", reason: "stale-enrollment-version" });
        assert.equal(attempts, beforeAttempts + 1);
        assert.deepEqual(persisted!.extension, before!.extension);
        assert.equal(fixture.underlyingSends.length, 0);
      } finally { await fixture.close(); }
    });
  }
}
