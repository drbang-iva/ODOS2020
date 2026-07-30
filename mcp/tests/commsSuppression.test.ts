import assert from "node:assert/strict";
import { test } from "node:test";
import type { Bundle, Communication, Patient, Resource } from "@medplum/fhirtypes";
import type {
  CommsProvider,
  SendEmailRequest,
} from "../src/comms/comms-provider.js";
import {
  ODOS_COMMS_OPT_OUT_EXTENSION_URL,
  createSuppressedCommsProvider,
} from "../src/comms/suppression-gate.js";

function baseRequest(overrides: Partial<SendEmailRequest> = {}): SendEmailRequest {
  return {
    patientReference: "Patient/synthetic-1",
    subject: "Appointment reminder",
    body: "Your appointment is tomorrow at 10:00 AM at Main Office.",
    campaignType: "appointment-reminder",
    suppression: {},
    ...overrides,
  };
}

function patient(overrides: Partial<Patient> = {}): Patient {
  return {
    resourceType: "Patient",
    id: "synthetic-1",
    telecom: [{ system: "email", value: "patient@example.test" }],
    ...overrides,
  };
}

function fakeProvider(sent: SendEmailRequest[]): CommsProvider {
  return {
    name: "fake",
    capabilities: {
      sms: false,
      calls: false,
      email: true,
      contacts: false,
      conversations: false,
      reviews: false,
    },
    async sendEmail(request) {
      sent.push(request);
      return { outcome: "sent", providerMessageId: `sent-${sent.length}` };
    },
  };
}

function fhirFor(subject: Patient, communications: Communication[] = []) {
  return {
    read: async <T extends Resource>(): Promise<T> => structuredClone(subject) as T,
    search: async <T extends Resource>(): Promise<Bundle<T>> => ({
      resourceType: "Bundle",
      type: "searchset",
      entry: communications.map((resource) => ({ resource: structuredClone(resource) as T })),
    }),
  };
}

test("PMS-side patient/channel opt-out suppresses before the provider call", async () => {
  const sent: SendEmailRequest[] = [];
  const optedOut = patient({
    extension: [{
      url: ODOS_COMMS_OPT_OUT_EXTENSION_URL,
      extension: [{ url: "channel", valueCode: "email" }],
    }],
  });
  const provider = createSuppressedCommsProvider(fakeProvider(sent), {
    fhir: fhirFor(optedOut),
    practiceTimeZone: "America/New_York",
    now: () => new Date("2026-07-30T14:00:00.000Z"),
  });

  const result = await provider.sendEmail(baseRequest());
  assert.deepEqual(result, { outcome: "suppressed", reason: "patient-opt-out" });
  assert.equal(sent.length, 0);
});

test("outside quiet hours reschedules to the next patient-local 8 AM rather than sending or dropping", async () => {
  const sent: SendEmailRequest[] = [];
  const provider = createSuppressedCommsProvider(fakeProvider(sent), {
    fhir: fhirFor(patient()),
    practiceTimeZone: "America/New_York",
    now: () => new Date("2026-07-30T06:00:00.000Z"),
  });

  const result = await provider.sendEmail(baseRequest());
  assert.deepEqual(result, {
    outcome: "rescheduled",
    reason: "quiet-hours",
    rescheduledAt: "2026-07-30T12:00:00.000Z",
  });
  assert.equal(sent.length, 0);
});

test("a configured campaign frequency cap suppresses a repeat inside the lookback window", async () => {
  const sent: SendEmailRequest[] = [];
  const prior: Communication = {
    resourceType: "Communication",
    status: "completed",
    sent: "2026-07-01T14:00:00.000Z",
    subject: { reference: "Patient/synthetic-1" },
    category: [{
      coding: [{
        system: "https://odos2020.com/fhir/CodeSystem/comms-campaign-type",
        code: "review-request",
      }],
    }],
  };
  const provider = createSuppressedCommsProvider(fakeProvider(sent), {
    fhir: fhirFor(patient(), [prior]),
    practiceTimeZone: "America/New_York",
    now: () => new Date("2026-07-30T14:00:00.000Z"),
  });

  const result = await provider.sendEmail(baseRequest({
    campaignType: "review-request",
    suppression: { frequencyCapDays: 90 },
  }));
  assert.deepEqual(result, { outcome: "suppressed", reason: "frequency-cap" });
  assert.equal(sent.length, 0);
});

test("an allowed send resolves Patient.telecom email and reaches the provider", async () => {
  const sent: SendEmailRequest[] = [];
  const provider = createSuppressedCommsProvider(fakeProvider(sent), {
    fhir: fhirFor(patient()),
    practiceTimeZone: "America/New_York",
    now: () => new Date("2026-07-30T14:00:00.000Z"),
  });

  const result = await provider.sendEmail(baseRequest());
  assert.equal(result.outcome, "sent");
  assert.equal(sent.length, 1);
  assert.equal(sent[0].toAddress, "patient@example.test");
});
