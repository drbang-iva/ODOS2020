import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  Appointment,
  Bundle,
  Communication,
  Patient,
  Resource,
} from "@medplum/fhirtypes";
import type { FhirSearchParams } from "../src/fhir-client.js";
import type {
  CommsDispatch,
} from "../src/comms/comms-config.js";
import type {
  CommsProvider,
  SendEmailRequest,
  SendSmsRequest,
} from "../src/comms/comms-provider.js";
import { createSuppressedCommsProvider } from "../src/comms/suppression-gate.js";
import {
  DEFAULT_APPOINTMENT_REMINDER_CAMPAIGNS,
  appointmentReminderCampaignsFromEnv,
  createReminderEngine,
  reminderLookbackMinutes,
  scheduledAt,
  type ReminderCampaignConfig,
} from "../src/reminders/reminder-engine.js";

const NOW = "2026-07-30T14:00:00.000Z";

function appointment(id: string, start: string, end: string): Appointment {
  return {
    resourceType: "Appointment",
    id,
    status: "booked",
    start,
    end,
    participant: [
      { actor: { reference: "Patient/synthetic-1", display: "Synthetic Patient" }, status: "accepted" },
      { actor: { reference: "Practitioner/example", display: "Dr. Example" }, status: "accepted" },
      { actor: { reference: "Location/main", display: "Main Office" }, status: "accepted" },
    ],
  };
}

function fakeFhir(appointments: Appointment[]) {
  const subject: Patient = {
    resourceType: "Patient",
    id: "synthetic-1",
    telecom: [
      { system: "email", value: "patient@example.test" },
      { system: "phone", use: "mobile", value: "+18645550199" },
    ],
  };
  const communications: Communication[] = [];
  let nextId = 1;

  return {
    baseUrl: "https://odos.local/",
    communications,
    read: async <T extends Resource>(
      resourceType: T["resourceType"],
      id: string,
    ): Promise<T> => {
      if (resourceType === "Appointment") {
        const resource = appointments.find((candidate) => candidate.id === id);
        if (!resource) throw new Error(`Appointment/${id} not found.`);
        return structuredClone(resource) as T;
      }
      assert.equal(resourceType, "Patient");
      return structuredClone(subject) as T;
    },
    search: async <T extends Resource>(
      resourceType: T["resourceType"],
      params?: FhirSearchParams,
    ): Promise<Bundle<T>> => {
      if (resourceType === "Appointment") {
        return {
          resourceType: "Bundle",
          type: "searchset",
          entry: appointments.map((resource) => ({ resource: structuredClone(resource) as T })),
        };
      }
      assert.equal(resourceType, "Communication");
      const query = new URLSearchParams(params as ConstructorParameters<typeof URLSearchParams>[0]);
      const identifier = query.get("identifier");
      const matches = identifier
        ? communications.filter((resource) =>
          resource.identifier?.some((candidate) => `${candidate.system}|${candidate.value}` === identifier))
        : communications;
      return {
        resourceType: "Bundle",
        type: "searchset",
        entry: matches.map((resource) => ({ resource: structuredClone(resource) as T })),
      };
    },
    searchUrl: async <T extends Resource>(): Promise<Bundle<T>> => {
      throw new Error("Unexpected paginated FHIR search.");
    },
    create: async <T extends Resource>(
      resource: T,
      headers?: Record<string, string>,
    ): Promise<T> => {
      if (resource.resourceType !== "Communication") return resource;
      const communication = resource as Communication;
      const conditional = headers?.["If-None-Exist"]?.replace(/^identifier=/, "");
      const existing = conditional
        ? communications.find((candidate) =>
          candidate.identifier?.some((identifier) =>
            `${identifier.system}|${identifier.value}` === conditional))
        : undefined;
      if (existing) return structuredClone(existing) as T;
      const created = {
        ...structuredClone(communication),
        id: `communication-${nextId++}`,
        meta: { versionId: "1" },
      };
      communications.push(created);
      return structuredClone(created) as T;
    },
    update: async <T extends Resource>(
      resourceType: T["resourceType"],
      id: string,
      resource: T,
    ): Promise<T> => {
      assert.equal(resourceType, "Communication");
      const index = communications.findIndex((candidate) => candidate.id === id);
      assert.notEqual(index, -1);
      const updated = {
        ...(resource as Communication),
        id,
        meta: { versionId: String(Number(communications[index].meta?.versionId ?? "0") + 1) },
      };
      communications[index] = updated;
      return structuredClone(updated) as T;
    },
  };
}

function dispatchFor(
  provider: CommsProvider,
  fhir: ReturnType<typeof fakeFhir>,
  now: () => Date = () => new Date(NOW),
): CommsDispatch {
  return {
    providers: () => ["fake"],
    getAdapter: () => createSuppressedCommsProvider(provider, {
      fhir,
      practiceTimeZone: "America/New_York",
      now,
    }),
  };
}

function campaign(
  id: string,
  fieldPath: "start" | "end",
  offsetMinutes: number,
): ReminderCampaignConfig {
  return {
    id,
    campaignType: "appointment-reminder",
    provider: "fake",
    channel: "email",
    anchor: {
      resourceType: "Appointment",
      searchParameter: "date",
      fieldPath,
      ...(fieldPath === "end" ? { searchPaddingMinutes: 24 * 60 } : {}),
    },
    offsetMinutes,
    subjectTemplate: "Appointment reminder",
    bodyTemplate: "Your appointment is {{appointmentDateTime}} with {{provider}} at {{location}}.",
  };
}

test("signed offset math supports reminders before and campaigns after independently configured anchor fields", () => {
  assert.equal(
    scheduledAt("2026-07-31T14:00:00.000Z", -24 * 60),
    "2026-07-30T14:00:00.000Z",
  );
  assert.equal(
    scheduledAt("2026-07-30T12:00:00.000Z", 2 * 60),
    "2026-07-30T14:00:00.000Z",
  );
  assert.deepEqual(
    DEFAULT_APPOINTMENT_REMINDER_CAMPAIGNS.map((row) => row.offsetMinutes),
    [-7 * 24 * 60, -24 * 60, -2 * 60],
  );
  assert.equal(reminderLookbackMinutes(undefined), 24 * 60);
});

test("practice reminder configuration supports email, SMS, or both channels", () => {
  const email = appointmentReminderCampaignsFromEnv({});
  assert.equal(email.length, 3);
  assert.ok(email.every((row) => row.channel === "email" && row.provider === "google-workspace"));

  const sms = appointmentReminderCampaignsFromEnv({
    ODOS_REMINDER_CHANNELS: "sms",
    ODOS_REMINDER_SMS_PROVIDER: "twilio",
  });
  assert.equal(sms.length, 3);
  assert.ok(sms.every((row) => row.channel === "sms" && row.provider === "twilio"));
  assert.ok(sms.every((row) => /Reply STOP to unsubscribe\.$/.test(row.bodyTemplate)));

  const both = appointmentReminderCampaignsFromEnv({
    ODOS_REMINDER_CHANNELS: "email,sms",
    ODOS_REMINDER_EMAIL_PROVIDER: "google-workspace",
    ODOS_REMINDER_SMS_PROVIDER: "twilio",
  });
  assert.deepEqual(new Set(both.map((row) => row.channel)), new Set(["email", "sms"]));
  assert.equal(new Set(both.map((row) => row.id)).size, 6);
});

test("Appointment end anchors reject the non-standard end search parameter", async () => {
  const fhir = fakeFhir([]);
  const provider: CommsProvider = {
    name: "fake",
    capabilities: {
      sms: false,
      calls: false,
      email: true,
      contacts: false,
      conversations: false,
      reviews: false,
    },
    async sendEmail() {
      return { outcome: "sent", providerMessageId: "unexpected" };
    },
  };
  const engine = createReminderEngine({
    fhir,
    dispatch: dispatchFor(provider, fhir),
    now: () => new Date(NOW),
    practiceTimeZone: "America/New_York",
  });

  await assert.rejects(
    () => engine.run([{
      ...campaign("after-end", "end", 2 * 60),
      anchor: {
        resourceType: "Appointment",
        searchParameter: "end",
        fieldPath: "end",
        searchPaddingMinutes: 24 * 60,
      },
    }]),
    /Appointment\.end.*standard.*searchParameter.*date/i,
  );
});

test("a missed negative-offset reminder catches up while its Appointment is still upcoming", async () => {
  const fhir = fakeFhir([
    appointment("missed-sweep", "2026-07-30T15:00:00.000Z", "2026-07-30T15:30:00.000Z"),
  ]);
  const sent: SendEmailRequest[] = [];
  const provider: CommsProvider = {
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
      return { outcome: "sent", providerMessageId: "recovered-reminder" };
    },
  };
  const engine = createReminderEngine({
    fhir,
    dispatch: dispatchFor(provider, fhir),
    now: () => new Date(NOW),
    practiceTimeZone: "America/New_York",
    lookbackMinutes: 5,
  });

  const result = await engine.run([campaign("two-hours-before", "start", -2 * 60)]);

  assert.deepEqual(result.map((row) => row.outcome), ["sent"]);
  assert.equal(sent.length, 1);
});

test("a due-anchor sweep follows FHIR next links so later Appointment pages are reachable", async () => {
  const first = appointment("page-1", "2026-07-30T15:00:00.000Z", "2026-07-30T15:30:00.000Z");
  const second = appointment("page-2", "2026-07-30T15:30:00.000Z", "2026-07-30T16:00:00.000Z");
  const base = fakeFhir([first, second]);
  let nextReads = 0;
  const fhir = {
    ...base,
    search: async <T extends Resource>(
      resourceType: T["resourceType"],
      params?: FhirSearchParams,
    ): Promise<Bundle<T>> => {
      if (resourceType !== "Appointment") return base.search<T>(resourceType, params);
      return {
        resourceType: "Bundle",
        type: "searchset",
        entry: [{ resource: structuredClone(first) as T }],
        link: [{ relation: "next", url: "https://odos.local/fhir/R4/Appointment?page=2" }],
      };
    },
    searchUrl: async <T extends Resource>(): Promise<Bundle<T>> => {
      nextReads += 1;
      return {
        resourceType: "Bundle",
        type: "searchset",
        entry: [{ resource: structuredClone(second) as T }],
      };
    },
  };
  const sent: SendEmailRequest[] = [];
  const provider: CommsProvider = {
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
      return { outcome: "sent", providerMessageId: `paged-${sent.length}` };
    },
  };
  const engine = createReminderEngine({
    fhir,
    dispatch: dispatchFor(provider, fhir),
    now: () => new Date(NOW),
    practiceTimeZone: "America/New_York",
  });

  const result = await engine.run([campaign("two-hours-before", "start", -2 * 60)]);

  assert.equal(nextReads, 1);
  assert.deepEqual(result.map((row) => row.outcome), ["sent", "sent"]);
  assert.equal(sent.length, 2);
});

test("engine reads Appointment anchors, dispatches both signed directions through the gate, persists Communication state, and is idempotent", async () => {
  const fhir = fakeFhir([
    appointment("before", "2026-07-31T14:00:00.000Z", "2026-07-31T14:30:00.000Z"),
    appointment("after", "2026-07-30T11:30:00.000Z", "2026-07-30T12:00:00.000Z"),
  ]);
  const sent: SendEmailRequest[] = [];
  const provider: CommsProvider = {
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
      return { outcome: "sent", providerMessageId: `provider-${sent.length}` };
    },
  };
  const engine = createReminderEngine({
    fhir,
    dispatch: dispatchFor(provider, fhir),
    now: () => new Date(NOW),
    generateId: (() => {
      let id = 0;
      return () => `claim-${++id}`;
    })(),
    practiceTimeZone: "America/New_York",
    lookbackMinutes: 5,
  });

  const first = await engine.run([
    campaign("day-before", "start", -24 * 60),
    campaign("two-hours-after", "end", 2 * 60),
  ]);
  assert.deepEqual(first.map((row) => row.outcome), ["sent", "sent"]);
  assert.equal(sent.length, 2);
  assert.equal(fhir.communications.length, 2);
  assert.ok(fhir.communications.every((row) => row.status === "completed"));
  assert.ok(fhir.communications.every((row) => row.subject?.reference === "Patient/synthetic-1"));
  assert.ok(sent.every((row) => /Dr\. Example/.test(row.body) && /Main Office/.test(row.body)));

  const second = await engine.run([
    campaign("day-before", "start", -24 * 60),
    campaign("two-hours-after", "end", 2 * 60),
  ]);
  assert.deepEqual(second.map((row) => row.outcome), ["already-processed", "already-processed"]);
  assert.equal(sent.length, 2);
  assert.equal(fhir.communications.length, 2);
});

test("reminder engine dispatches an SMS campaign without duplicating its anchor and offset path", async () => {
  const fhir = fakeFhir([
    appointment("sms-before", "2026-07-31T14:00:00.000Z", "2026-07-31T14:30:00.000Z"),
  ]);
  const sent: SendSmsRequest[] = [];
  const provider: CommsProvider = {
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
      return { outcome: "sent", providerMessageId: "sms-reminder-1" };
    },
  };
  const engine = createReminderEngine({
    fhir,
    dispatch: dispatchFor(provider, fhir),
    now: () => new Date(NOW),
    practiceTimeZone: "America/New_York",
  });

  const smsCampaign: ReminderCampaignConfig = {
    ...campaign("day-before-sms", "start", -24 * 60),
    channel: "sms",
    bodyTemplate:
      "Reminder: appointment with {{provider}} at {{appointmentDateTime}}. Reply STOP to unsubscribe.",
  };
  const result = await engine.run([smsCampaign]);

  assert.deepEqual(result.map((row) => row.outcome), ["sent"]);
  assert.equal(sent.length, 1);
  assert.match(sent[0].body, /Reply STOP to unsubscribe\.$/);
  assert.equal(fhir.communications[0].medium?.[0].coding?.[0].code, "sms");
});

test("an outside-hours Communication held by the gate is claimed and sent at the persisted next-window opening", async () => {
  let current = new Date("2026-07-30T06:00:00.000Z");
  const fhir = fakeFhir([
    appointment("quiet-hours", "2026-07-31T06:00:00.000Z", "2026-07-31T06:30:00.000Z"),
  ]);
  const sent: SendEmailRequest[] = [];
  const provider: CommsProvider = {
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
      return { outcome: "sent", providerMessageId: "provider-quiet-hours" };
    },
  };
  const now = () => new Date(current);
  const engine = createReminderEngine({
    fhir,
    dispatch: dispatchFor(provider, fhir, now),
    now,
    generateId: (() => {
      let id = 0;
      return () => `quiet-claim-${++id}`;
    })(),
    practiceTimeZone: "America/New_York",
    lookbackMinutes: 5,
  });
  const config = campaign("day-before-quiet", "start", -24 * 60);

  const held = await engine.run([config]);
  assert.deepEqual(held.map((row) => row.outcome), ["rescheduled"]);
  assert.equal(fhir.communications[0].status, "on-hold");
  assert.equal(sent.length, 0);

  current = new Date("2026-07-30T12:00:00.000Z");
  const released = await engine.run([config]);
  assert.deepEqual(released.map((row) => row.outcome), ["sent"]);
  assert.equal(fhir.communications[0].status, "completed");
  assert.equal(sent.length, 1);
});

test("a held-send sweep follows FHIR next links after its positive-offset due window has passed", async () => {
  let current = new Date("2026-07-30T06:00:00.000Z");
  const base = fakeFhir([
    appointment("held-page-2", "2026-07-30T03:30:00.000Z", "2026-07-30T04:00:00.000Z"),
  ]);
  const sent: SendEmailRequest[] = [];
  const provider: CommsProvider = {
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
      return { outcome: "sent", providerMessageId: "held-page-2" };
    },
  };
  const now = () => new Date(current);
  const config = campaign("after-end-held", "end", 2 * 60);
  const firstEngine = createReminderEngine({
    fhir: base,
    dispatch: dispatchFor(provider, base, now),
    now,
    practiceTimeZone: "America/New_York",
    lookbackMinutes: 5,
  });
  assert.deepEqual((await firstEngine.run([config])).map((row) => row.outcome), ["rescheduled"]);

  current = new Date("2026-07-30T12:00:00.000Z");
  let nextReads = 0;
  const pagedFhir = {
    ...base,
    search: async <T extends Resource>(
      resourceType: T["resourceType"],
      params?: FhirSearchParams,
    ): Promise<Bundle<T>> => {
      const query = new URLSearchParams(
        params as ConstructorParameters<typeof URLSearchParams>[0],
      );
      if (resourceType === "Communication" && query.get("status") === "on-hold") {
        return {
          resourceType: "Bundle",
          type: "searchset",
          link: [{ relation: "next", url: "https://odos.local/fhir/R4/Communication?page=2" }],
        };
      }
      return base.search<T>(resourceType, params);
    },
    searchUrl: async <T extends Resource>(): Promise<Bundle<T>> => {
      nextReads += 1;
      return {
        resourceType: "Bundle",
        type: "searchset",
        entry: [{ resource: structuredClone(base.communications[0]) as T }],
      };
    },
  };
  const releaseEngine = createReminderEngine({
    fhir: pagedFhir,
    dispatch: dispatchFor(provider, pagedFhir, now),
    now,
    practiceTimeZone: "America/New_York",
    lookbackMinutes: 5,
  });

  const released = await releaseEngine.run([config]);

  assert.equal(nextReads, 1);
  assert.deepEqual(released.map((row) => row.outcome), ["sent"]);
  assert.equal(sent.length, 1);
});

test("a quiet-hours-held reminder is abandoned when its Appointment is cancelled before release", async () => {
  let current = new Date("2026-07-30T06:00:00.000Z");
  const heldAppointment = appointment(
    "cancelled-after-hold",
    "2026-07-31T06:00:00.000Z",
    "2026-07-31T06:30:00.000Z",
  );
  const fhir = fakeFhir([heldAppointment]);
  let sends = 0;
  const provider: CommsProvider = {
    name: "fake",
    capabilities: {
      sms: false,
      calls: false,
      email: true,
      contacts: false,
      conversations: false,
      reviews: false,
    },
    async sendEmail() {
      sends += 1;
      return { outcome: "sent", providerMessageId: "must-not-send" };
    },
  };
  const now = () => new Date(current);
  const engine = createReminderEngine({
    fhir,
    dispatch: dispatchFor(provider, fhir, now),
    now,
    practiceTimeZone: "America/New_York",
  });
  const config = campaign("cancelled-held", "start", -24 * 60);

  assert.deepEqual((await engine.run([config])).map((row) => row.outcome), ["rescheduled"]);
  heldAppointment.status = "cancelled";
  current = new Date("2026-07-30T12:00:00.000Z");

  const released = await engine.run([config]);

  assert.deepEqual(released.map((row) => row.outcome), ["suppressed"]);
  assert.equal(sends, 0);
  assert.equal(fhir.communications[0].status, "not-done");
});

test("a held pre-appointment reminder is abandoned when the next quiet-hours opening is after the visit", async () => {
  let current = new Date("2026-07-30T06:00:00.000Z");
  const fhir = fakeFhir([
    appointment("before-opening", "2026-07-30T11:00:00.000Z", "2026-07-30T11:30:00.000Z"),
  ]);
  let sends = 0;
  const provider: CommsProvider = {
    name: "fake",
    capabilities: {
      sms: false,
      calls: false,
      email: true,
      contacts: false,
      conversations: false,
      reviews: false,
    },
    async sendEmail() {
      sends += 1;
      return { outcome: "sent", providerMessageId: "must-not-send" };
    },
  };
  const now = () => new Date(current);
  const engine = createReminderEngine({
    fhir,
    dispatch: dispatchFor(provider, fhir, now),
    now,
    practiceTimeZone: "America/New_York",
  });
  const config = campaign("day-before-early-visit", "start", -24 * 60);

  assert.deepEqual((await engine.run([config])).map((row) => row.outcome), ["rescheduled"]);
  current = new Date("2026-07-30T12:00:00.000Z");

  const released = await engine.run([config]);

  assert.deepEqual(released.map((row) => row.outcome), ["suppressed"]);
  assert.equal(sends, 0);
  assert.equal(fhir.communications[0].status, "not-done");
});
