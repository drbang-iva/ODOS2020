import assert from "node:assert/strict";
import { test } from "node:test";
import type { Bundle, Communication, Patient, Resource } from "@medplum/fhirtypes";
import type {
  CommsProvider,
  SendEmailRequest,
  SendSmsRequest,
} from "../src/comms/comms-provider.js";
import type { FhirSearchParams } from "../src/fhir-client.js";
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

function sendEmail(provider: CommsProvider, request: SendEmailRequest) {
  assert.ok(provider.sendEmail);
  return provider.sendEmail(request);
}

function fhirFor(
  subject: Patient,
  communications: Communication[] = [],
  onSearch?: (params: FhirSearchParams) => void,
) {
  return {
    read: async <T extends Resource>(): Promise<T> => structuredClone(subject) as T,
    search: async <T extends Resource>(
      _resourceType: T["resourceType"],
      params: FhirSearchParams = {},
    ): Promise<Bundle<T>> => {
      onSearch?.(params);
      return {
        resourceType: "Bundle",
        type: "searchset",
        entry: communications.map((resource) => ({ resource: structuredClone(resource) as T })),
      };
    },
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

  const result = await sendEmail(provider, baseRequest());
  assert.deepEqual(result, { outcome: "suppressed", reason: "patient-opt-out" });
  assert.equal(sent.length, 0);
});

test("PMS-side SMS opt-out blocks a send before resolving or calling Twilio", async () => {
  const sent: SendSmsRequest[] = [];
  const optedOut = patient({
    telecom: [{ system: "phone", value: "+18645550199" }],
    extension: [{
      url: ODOS_COMMS_OPT_OUT_EXTENSION_URL,
      extension: [{ url: "channel", valueCode: "sms" }],
    }],
  });
  const provider = createSuppressedCommsProvider({
    name: "twilio",
    capabilities: {
      sms: true,
      calls: false,
      email: false,
      contacts: false,
      conversations: false,
      reviews: false,
    },
    async sendEmail() {
      throw new Error("Twilio does not support email.");
    },
    async sendSms(request) {
      sent.push(request);
      return { outcome: "sent", providerMessageId: "unexpected" };
    },
  }, {
    fhir: fhirFor(optedOut),
    practiceTimeZone: "America/New_York",
    now: () => new Date("2026-07-30T14:00:00.000Z"),
  });

  const result = await provider.sendSms!({
    patientReference: "Patient/synthetic-1",
    body: "Reminder: appointment tomorrow. Reply STOP to unsubscribe.",
    campaignType: "appointment-reminder",
    suppression: {},
  });

  assert.deepEqual(result, { outcome: "suppressed", reason: "patient-opt-out" });
  assert.equal(sent.length, 0);
});

test("allowed SMS resolves an active Patient.telecom phone before calling Twilio", async () => {
  const sent: SendSmsRequest[] = [];
  const subject = patient({
    telecom: [
      { system: "phone", use: "old", value: "+18645550111" },
      { system: "phone", use: "work", value: "+18645550122" },
      { system: "phone", use: "mobile", value: "+18645550199" },
    ],
  });
  const provider = createSuppressedCommsProvider({
    name: "twilio",
    capabilities: {
      sms: true,
      calls: false,
      email: false,
      contacts: false,
      conversations: false,
      reviews: false,
    },
    async sendEmail() {
      throw new Error("Twilio does not support email.");
    },
    async sendSms(request) {
      sent.push(request);
      return { outcome: "sent", providerMessageId: "sms-1" };
    },
  }, {
    fhir: fhirFor(subject),
    practiceTimeZone: "America/New_York",
    now: () => new Date("2026-07-30T14:00:00.000Z"),
  });

  const result = await provider.sendSms!({
    patientReference: "Patient/synthetic-1",
    body: "Reminder: appointment tomorrow. Reply STOP to unsubscribe.",
    campaignType: "appointment-reminder",
    suppression: {},
  });

  assert.equal(result.outcome, "sent");
  assert.equal(sent[0].toNumber, "+18645550199");
});

test("SMS-specific Patient.telecom takes precedence over mobile and other phones", async () => {
  const sent: SendSmsRequest[] = [];
  const subject = patient({
    telecom: [
      { system: "phone", use: "work", value: "+18645550122" },
      { system: "phone", use: "mobile", value: "+18645550199" },
      { system: "sms", value: "+18645550188" },
    ],
  });
  const provider = createSuppressedCommsProvider({
    name: "twilio",
    capabilities: {
      sms: true,
      calls: false,
      email: false,
      contacts: false,
      conversations: false,
      reviews: false,
    },
    async sendSms(request) {
      sent.push(request);
      return { outcome: "sent", providerMessageId: "sms-1" };
    },
  }, {
    fhir: fhirFor(subject),
    practiceTimeZone: "America/New_York",
    now: () => new Date("2026-07-30T14:00:00.000Z"),
  });

  await provider.sendSms!({
    patientReference: "Patient/synthetic-1",
    body: "Reminder: appointment tomorrow. Reply STOP to unsubscribe.",
    campaignType: "appointment-reminder",
    suppression: {},
  });

  assert.equal(sent[0].toNumber, "+18645550188");
});

test("outside quiet hours reschedules to the next patient-local 8 AM rather than sending or dropping", async () => {
  const sent: SendEmailRequest[] = [];
  const provider = createSuppressedCommsProvider(fakeProvider(sent), {
    fhir: fhirFor(patient()),
    practiceTimeZone: "America/New_York",
    now: () => new Date("2026-07-30T06:00:00.000Z"),
  });

  const result = await sendEmail(provider, baseRequest());
  assert.deepEqual(result, {
    outcome: "rescheduled",
    reason: "quiet-hours",
    rescheduledAt: "2026-07-30T12:00:00.000Z",
  });
  assert.equal(sent.length, 0);
});

test("a configured campaign frequency cap suppresses a repeat inside the lookback window", async () => {
  const sent: SendEmailRequest[] = [];
  let searchQuery: URLSearchParams | undefined;
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
    fhir: fhirFor(patient(), [prior], (params) => {
      searchQuery = new URLSearchParams(
        params as ConstructorParameters<typeof URLSearchParams>[0],
      );
    }),
    practiceTimeZone: "America/New_York",
    now: () => new Date("2026-07-30T14:00:00.000Z"),
  });

  const result = await sendEmail(provider, baseRequest({
    campaignType: "review-request",
    messageId: "current-send",
    suppression: { frequencyCapDays: 90 },
  }));
  assert.deepEqual(result, { outcome: "suppressed", reason: "frequency-cap" });
  assert.equal(sent.length, 0);
  assert.equal(searchQuery?.get("subject"), "Patient/synthetic-1");
  assert.equal(searchQuery?.get("patient"), null);
});

test("frequency-cap evaluation follows FHIR next links before allowing a send", async () => {
  const sent: SendEmailRequest[] = [];
  let nextReads = 0;
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
  const fhir = {
    ...fhirFor(patient()),
    search: async <T extends Resource>(): Promise<Bundle<T>> => ({
      resourceType: "Bundle",
      type: "searchset",
      link: [{ relation: "next", url: "https://odos.local/fhir/R4/Communication?page=2" }],
    }),
    searchUrl: async <T extends Resource>(): Promise<Bundle<T>> => {
      nextReads += 1;
      return {
        resourceType: "Bundle",
        type: "searchset",
        entry: [{ resource: structuredClone(prior) as T }],
      };
    },
  };
  const provider = createSuppressedCommsProvider(fakeProvider(sent), {
    fhir,
    practiceTimeZone: "America/New_York",
    now: () => new Date("2026-07-30T14:00:00.000Z"),
  });

  const result = await sendEmail(provider, baseRequest({
    campaignType: "review-request",
    messageId: "current-send",
    suppression: { frequencyCapDays: 90 },
  }));

  assert.deepEqual(result, { outcome: "suppressed", reason: "frequency-cap" });
  assert.equal(nextReads, 1);
  assert.equal(sent.length, 0);
});

test("concurrent in-progress claims elect exactly one deterministic frequency-cap winner", async () => {
  const sent: SendEmailRequest[] = [];
  const claims: Communication[] = ["claim-a", "claim-b"].map((value) => ({
    resourceType: "Communication",
    status: "in-progress",
    meta: { lastUpdated: "2026-07-30T13:59:00.000Z" },
    identifier: [{
      system: "https://odos2020.com/fhir/NamingSystem/comms-send",
      value,
    }],
    subject: { reference: "Patient/synthetic-1" },
    category: [{
      coding: [{
        system: "https://odos2020.com/fhir/CodeSystem/comms-campaign-type",
        code: "review-request",
      }],
    }],
  }));
  const provider = createSuppressedCommsProvider(fakeProvider(sent), {
    fhir: fhirFor(patient(), claims),
    practiceTimeZone: "America/New_York",
    now: () => new Date("2026-07-30T14:00:00.000Z"),
  });

  const winner = await sendEmail(provider, baseRequest({
    campaignType: "review-request",
    messageId: "claim-a",
    suppression: { frequencyCapDays: 90 },
  }));
  const loser = await sendEmail(provider, baseRequest({
    campaignType: "review-request",
    messageId: "claim-b",
    suppression: { frequencyCapDays: 90 },
  }));

  assert.equal(winner.outcome, "sent");
  assert.deepEqual(loser, { outcome: "suppressed", reason: "frequency-cap" });
  assert.equal(sent.length, 1);
});

test("an allowed send resolves Patient.telecom email and reaches the provider", async () => {
  const sent: SendEmailRequest[] = [];
  const provider = createSuppressedCommsProvider(fakeProvider(sent), {
    fhir: fhirFor(patient()),
    practiceTimeZone: "America/New_York",
    now: () => new Date("2026-07-30T14:00:00.000Z"),
  });

  const result = await sendEmail(provider, baseRequest());
  assert.equal(result.outcome, "sent");
  assert.equal(sent.length, 1);
  assert.equal(sent[0].toAddress, "patient@example.test");
});

test("email resolution skips a ContactPoint whose validity starts in the future", async () => {
  const sent: SendEmailRequest[] = [];
  const provider = createSuppressedCommsProvider(fakeProvider(sent), {
    fhir: fhirFor(patient({
      telecom: [
        {
          system: "email",
          value: "future@example.test",
          period: { start: "2026-08-01T00:00:00.000Z" },
        },
        { system: "email", value: "active@example.test" },
      ],
    })),
    practiceTimeZone: "America/New_York",
    now: () => new Date("2026-07-30T14:00:00.000Z"),
  });

  await sendEmail(provider, baseRequest());

  assert.equal(sent[0].toAddress, "active@example.test");
});
