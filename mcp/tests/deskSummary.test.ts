import assert from "node:assert/strict";
import { test } from "node:test";
import type { Appointment, Bundle, Claim, Invoice, PaymentReconciliation, Resource, Task } from "@medplum/fhirtypes";
import { loadDeskSummary, projectDeskSummary, safeLatestStatementRun, type DeskSummaryInput } from "../src/desk/desk-summary.js";
import { appointmentConfirmationExtension } from "../src/fhir/appointmentConfirmation.js";
import { opticalOrderStatusConcept } from "../src/fhir/opticalOrderStatus.js";
import { opticalOrderTypeConcept } from "../src/fhir/opticalOrderType.js";
import { buildOpticalInvoice } from "../src/fhir/opticalInvoice.js";
import {
  buildClaimRejectedWorklistTask,
  buildEraWorklistTask,
} from "../src/claims/era-worklist.js";
import { buildPaymentReconciliation } from "../src/payments/payment-reconciliation.js";
import { STATEMENT_OUTPUT_CODE_SYSTEM, STATEMENT_RUN_CODE, STATEMENT_TASK_CODE_SYSTEM } from "../src/statements/statements.js";

const NOW = "2026-07-11T14:00:00.000Z";

test("desk summary projects every card stat from seeded resources with truthful unavailable fields", () => {
  const appointment: Appointment = {
    resourceType: "Appointment",
    id: "appointment-1",
    status: "pending",
    start: "2026-07-11T15:00:00.000Z",
    end: "2026-07-11T15:30:00.000Z",
    created: "2026-07-11T12:00:00.000Z",
    participant: [{ actor: { reference: "Patient/patient-1" }, status: "accepted" }],
    serviceType: [{ text: "Annual exam" }],
    extension: [appointmentConfirmationExtension("confirmed")],
  };
  const optical: Task = {
    resourceType: "Task",
    status: "in-progress",
    intent: "order",
    authoredOn: "2026-07-08T14:00:00.000Z",
    code: opticalOrderTypeConcept("rx"),
    businessStatus: opticalOrderStatusConcept("at-lab"),
  };
  const claim = claimFixture("claim-failed", 125);
  const rejected = buildClaimRejectedWorklistTask({
    claimReference: "Claim/claim-failed",
    patientReference: "Patient/patient-1",
    claimMdMessage: "Rejected",
    authoredOn: "2026-07-11T13:00:00.000Z",
  });
  rejected.id = "task-rejected";
  const era = buildEraWorklistTask({
    code: "era-underpayment",
    era: { eraid: "era-1" },
    eraClaim: { pcn: "pcn-1", total_charge: "100.00", total_paid: "60.00", charge: [{ charge: "100.00", allowed: "100.00", paid: "60.00", adjustment: [] }] },
    claimResponseReference: "ClaimResponse/response-1",
    patientReference: "Patient/patient-1",
    authoredOn: "2026-07-11T13:30:00.000Z",
  });
  const payment = buildPaymentReconciliation({
    outcome: "success",
    processorTransactionId: "payment-1",
    processorTransactionSystem: "https://odos2020.com/test/payment",
    subjectReference: "Patient/patient-1",
    amountCents: 5000,
    tender: { code: "CASH", display: "Cash" },
    paymentDate: "2026-07-11",
    createdIso: "2026-07-11T13:00:00.000Z",
    surface: "in-clinic",
  });
  payment.id = "payment-1";
  const invoice: Invoice = { resourceType: "Invoice", status: "issued", subject: { reference: "Patient/patient-1" }, date: "2026-07-11T13:00:00.000Z", participant: [], issuer: { reference: "Organization/practice" }, lineItem: [], totalNet: { value: 80, currency: "USD" } };
  const summary = projectDeskSummary({
    ...emptyInput(),
    appointments: [appointment],
    patients: [{ resourceType: "Patient", id: "patient-1", name: [{ given: ["Alex"], family: "Rivera" }] }],
    tasks: [optical, rejected, era, statementRunTask("2026-07-10T16:00:00.000Z", 2)],
    claims: [claim],
    paymentReconciliations: [payment],
    invoices: [invoice],
    terminalMode: "TEST MODE",
  });

  assert.deepEqual(summary.cards.schedule.agenda, [{ time: "11:00 AM", patient: "Alex Rivera", visitType: "Annual exam" }]);
  assert.equal(summary.cards.schedule.webRequests.value, 1);
  assert.equal(summary.cards.schedule.webRequests.tone, "warn");
  assert.equal(summary.cards.pendingRx.spectacle.value, 1);
  assert.equal(summary.cards.pendingRx.contactLens.value, null);
  assert.equal(summary.cards.pendingRx.labOrdersUnsent.value, null);
  assert.equal(summary.cards.pendingRx.oldestWaiting.tone, "warn");
  assert.equal(summary.cards.productPickup.atLab.value, 1);
  assert.equal(summary.cards.productPickup.readyNotNotified.value, null);
  assert.equal(summary.cards.claims.failed.value, 1);
  assert.equal(summary.cards.claims.failed.tone, "alert");
  assert.equal(summary.cards.claims.heldCents.value, 12_500);
  assert.equal(summary.cards.claims.paperQueue.value, null);
  assert.equal(summary.cards.payments.unappliedCount.value, 1);
  assert.equal(summary.cards.payments.unappliedCents.value, 5_000);
  assert.equal(summary.cards.payments.patientCreditsOpen.value, 1);
  assert.equal(summary.cards.payments.patientOpenBalanceCents.value, 8_000);
  assert.equal(summary.cards.payments.terminalMode.tone, "warn");
  assert.equal(summary.day.collectedCents.value, 0);
  assert.equal(summary.cards.remits.waitingToPost.value, 1);
  assert.equal(summary.cards.remits.unpostedCents.value, 4_000);
  assert.equal(summary.cards.statements.available, true);
  assert.equal(summary.cards.statements.lastStatement.value, "2026-07-10T16:00:00.000Z");
  assert.equal(summary.cards.statements.invalidRejects.value, 2);
  assert.equal(summary.cards.statements.invalidRejects.tone, "alert");
  assert.ok(summary.cards.attention.items.some((item) => item.label === "1 failed claim"));
  assert.ok(summary.cards.attention.items.some((item) => item.label === "1 web appointment waiting"));
});

test("desk tone rules fire exactly at their zero-to-one boundaries", () => {
  const clear = projectDeskSummary(emptyInput());
  assert.equal(clear.cards.schedule.webRequests.tone, "ok");
  assert.equal(clear.cards.claims.failed.tone, "ok");
  assert.equal(clear.cards.payments.unappliedCount.tone, "ok");
  assert.equal(clear.cards.remits.waitingToPost.tone, "ok");
  assert.equal(clear.cards.attention.items.length, 0);

  const web = projectDeskSummary({ ...emptyInput(), appointments: [appointmentFixture("pending")] });
  assert.equal(web.cards.schedule.webRequests.tone, "warn");

  const rejected = buildClaimRejectedWorklistTask({ claimReference: "Claim/claim-1", patientReference: "Patient/patient-1", claimMdMessage: "Rejected", authoredOn: NOW });
  const failed = projectDeskSummary({ ...emptyInput(), claims: [claimFixture("claim-1", 10)], tasks: [rejected] });
  assert.equal(failed.cards.claims.failed.tone, "alert");

  const dayOld = projectDeskSummary({ ...emptyInput(), tasks: [opticalFixture("2026-07-10T14:00:00.000Z")] });
  const twoDaysOld = projectDeskSummary({ ...emptyInput(), tasks: [opticalFixture("2026-07-09T13:59:59.000Z")] });
  assert.equal(dayOld.cards.pendingRx.oldestWaiting.tone, "ok");
  assert.equal(twoDaysOld.cards.pendingRx.oldestWaiting.tone, "warn");
});

test("needs-attention is exactly all-clear when every available target is met", () => {
  const summary = projectDeskSummary(emptyInput());
  assert.deepEqual(summary.cards.attention.items, []);
  assert.equal(summary.pulse.itemsNeedingYou, 0);
  assert.equal(summary.pulse.everythingElseAtTarget, true);
});

test("Desk day chip reuses loaded Invoices and totals only today's record-only tenders", () => {
  const today = buildOpticalInvoice({
    patientReference: "Patient/patient-1",
    date: "2026-07-11T13:00:00.000Z",
    staffReference: "Practitioner/front-1",
    tender: "CARD_MANUAL",
    lineItems: [{ chargeItemReference: "ChargeItem/today", amountCents: 1234 }],
  });
  const yesterday = buildOpticalInvoice({
    patientReference: "Patient/patient-1",
    date: "2026-07-10T13:00:00.000Z",
    staffReference: "Practitioner/front-1",
    tender: "CASH",
    lineItems: [{ chargeItemReference: "ChargeItem/yesterday", amountCents: 9999 }],
  });
  const summary = projectDeskSummary({ ...emptyInput(), invoices: [today, yesterday] });
  assert.deepEqual(summary.day.collectedCents, { value: 1234, tone: "info" });
});

test("a malformed latest statement run degrades without blocking any Desk card", () => {
  const baseline = projectDeskSummary(emptyInput());
  const summary = projectDeskSummary({ ...emptyInput(), tasks: [malformedStatementRunTask()] });

  assert.deepEqual(Object.keys(summary.cards), Object.keys(baseline.cards));
  assert.equal(summary.cards.statements.available, true);
  assert.equal(summary.cards.statements.lastStatement.value, null);
  assert.equal(summary.cards.statements.lastStatement.unavailableReason, "No statement run is persisted yet.");
  assert.equal(summary.cards.statements.invalidRejects.value, 0);
  assert.equal(summary.cards.statements.invalidRejects.unavailableReason, undefined);
});

test("loadDeskSummary isolates an unexpected malformed statement-run read", async () => {
  const appointment = appointmentFixture("booked");
  const malformedRun: Task = {
    resourceType: "Task",
    status: "completed",
    intent: "order",
    authoredOn: "2026-07-11T13:00:00.000Z",
    code: { coding: [{ system: STATEMENT_TASK_CODE_SYSTEM, code: STATEMENT_RUN_CODE }] },
    output: {} as Task["output"],
  };
  const fhir = {
    search: async <T extends Resource>(resourceType: T["resourceType"], params: Record<string, string>): Promise<Bundle<T>> => {
      const resources: Resource[] = resourceType === "Appointment"
        ? [appointment]
        : resourceType === "Task" && params.code === `${STATEMENT_TASK_CODE_SYSTEM}|${STATEMENT_RUN_CODE}`
          ? [malformedRun]
          : [];
      return {
        resourceType: "Bundle",
        type: "searchset",
        entry: resources.map((resource) => ({ resource })) as Bundle<T>["entry"],
      };
    },
  };

  const summary = await loadDeskSummary(fhir, { now: NOW, timeZone: "America/New_York", terminalMode: "TEST MODE" });

  assert.equal(summary.cards.schedule.today.value, 1);
  assert.equal(summary.cards.payments.unappliedCount.value, 0);
  assert.equal(summary.cards.payments.terminalMode.tone, "warn");
  assert.equal(summary.cards.statements.cadence.unavailableReason, undefined);
  assert.deepEqual(summary.cards.statements.invalidRejects, {
    value: 0,
    tone: "off",
    unavailableReason: "Latest statement run could not be read.",
  });
  assert.deepEqual(summary.cards.statements.lastStatement, {
    value: null,
    tone: "off",
    unavailableReason: "Latest statement run could not be read.",
  });
});

test("loadDeskSummary isolates an oversized Appointment page", async () => {
  const fhir = {
    search: async <T extends Resource>(resourceType: T["resourceType"]): Promise<Bundle<T>> => resourceType === "Appointment"
      ? {
          resourceType: "Bundle",
          type: "searchset",
          total: 1_001,
          link: [{ relation: "next", url: "Appointment?_page=2" }],
        } as Bundle<T>
      : { resourceType: "Bundle", type: "searchset" },
  };

  const summary = await loadDeskSummary(fhir, { now: NOW, timeZone: "America/New_York", terminalMode: "LIVE" });

  assert.deepEqual(summary.cards.schedule.today, {
    value: 0,
    tone: "off",
    unavailableReason: "Today's appointments exceed the Desk card read limit.",
  });
  assert.equal(summary.cards.schedule.agenda.length, 0);
  assert.equal(summary.cards.payments.unappliedCount.value, 0);
  assert.equal(summary.cards.statements.cadence.value, "Weekly · Wednesdays recommended");
});

test("an unexpected latest-statement error is marked unavailable", () => {
  assert.deepEqual(
    safeLatestStatementRun([], () => { throw new Error("unexpected statement reader bug"); }),
    { generatedAt: null, invalidRejects: 0, unavailableReason: "Latest statement run could not be read." },
  );
});

test("practice pulse counts only canonical attention rows", () => {
  const summary = projectDeskSummary({
    ...emptyInput(),
    appointments: [
      appointmentFixture("pending"),
      {
        ...appointmentFixture("booked"),
        start: "2026-07-11T16:00:00.000Z",
        end: "2026-07-11T16:30:00.000Z",
      },
    ],
    terminalMode: "TEST MODE",
  });

  assert.equal(summary.cards.schedule.confirmed.tone, "warn");
  assert.equal(summary.cards.payments.terminalMode.tone, "warn");
  assert.equal(summary.cards.attention.items.length, 1);
  assert.equal(summary.pulse.itemsNeedingYou, summary.cards.attention.items.length);
  assert.equal(summary.pulse.everythingElseAtTarget, false);
});

test("last claim transmission is ok for the previous business day and warns when stale", () => {
  const current = projectDeskSummary({ ...emptyInput(), claims: [claimFixture("claim-current", 10)] });
  assert.equal(current.cards.claims.lastTransmission.value, "2026-07-10T14:00:00.000Z");
  assert.equal(current.cards.claims.lastTransmission.tone, "ok");
  const staleClaim = claimFixture("claim-stale", 10);
  staleClaim.created = "2026-07-09T14:00:00.000Z";
  const stale = projectDeskSummary({ ...emptyInput(), claims: [staleClaim] });
  assert.equal(stale.cards.claims.lastTransmission.tone, "warn");
});

test("last claim transmission is unavailable when claim worklist Tasks overflow", () => {
  const summary = projectDeskSummary({
    ...emptyInput(),
    claims: [claimFixture("claim-current", 10)],
    taskAvailability: { claimRejected: false, era: true, optical: true },
  });

  assert.equal(summary.cards.claims.lastTransmission.value, null);
  assert.equal(summary.cards.claims.lastTransmission.tone, "off");
  assert.equal(summary.cards.claims.lastTransmission.unavailableReason, "Claim worklist Tasks exceed the Desk card read limit.");
  assert.equal(summary.pulse.lastClaimTransmission, null);
  assert.equal(summary.pulse.lastClaimTransmissionTone, "off");
});

function emptyInput(): DeskSummaryInput {
  return { appointments: [], patients: [], tasks: [], claims: [], claimResponses: [], paymentReconciliations: [], invoices: [], now: NOW, timeZone: "America/New_York", terminalMode: "LIVE" };
}

function appointmentFixture(status: Appointment["status"]): Appointment {
  return { resourceType: "Appointment", status, start: "2026-07-11T15:00:00.000Z", end: "2026-07-11T15:30:00.000Z", participant: [] };
}

function claimFixture(id: string, dollars: number): Claim {
  return { resourceType: "Claim", id, status: "active", type: { coding: [] }, use: "claim", patient: { reference: "Patient/patient-1" }, created: "2026-07-10T14:00:00.000Z", provider: { reference: "Practitioner/provider-1" }, priority: { coding: [] }, insurer: { reference: "Organization/payer-1" }, total: { value: dollars, currency: "USD" } };
}

function opticalFixture(authoredOn: string): Task {
  return { resourceType: "Task", status: "in-progress", intent: "order", authoredOn, code: opticalOrderTypeConcept("rx"), businessStatus: opticalOrderStatusConcept("quote") };
}

function statementRunTask(authoredOn: string, invalidRejects: number): Task {
  return {
    resourceType: "Task", status: "completed", intent: "order", authoredOn,
    code: { coding: [{ system: STATEMENT_TASK_CODE_SYSTEM, code: STATEMENT_RUN_CODE }] },
    output: [{ type: { coding: [{ system: STATEMENT_OUTPUT_CODE_SYSTEM, code: "invalid-reject-count" }] }, valueInteger: invalidRejects }],
  };
}

function malformedStatementRunTask(): Task {
  return {
    resourceType: "Task",
    status: "completed",
    intent: "order",
    authoredOn: "2026-07-11T13:00:00.000Z",
    code: { coding: [{ system: STATEMENT_TASK_CODE_SYSTEM, code: STATEMENT_RUN_CODE }] },
    output: [],
  };
}
