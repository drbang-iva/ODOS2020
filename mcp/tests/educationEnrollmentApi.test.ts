import assert from "node:assert/strict";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import type { Bundle, Communication, Encounter, Patient, Provenance, Resource } from "@medplum/fhirtypes";
import express from "express";
import {
  registerCommsApiRoutes,
  type CommsApiRouteDeps,
} from "../src/comms/comms-api.js";
import type { CommsProvider, SendSmsRequest } from "../src/comms/comms-provider.js";
import { createInMemoryEducationEnrollmentStore } from "../src/comms/education-enrollment.js";
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
      immediateSends: Array<{ outcome?: Record<string, unknown> }>;
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
    assert.equal(fixture.underlyingSends.length, 2);
    assert.deepEqual(fixture.terminalClearProviderCounts, [2]);

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
    assert.equal(fixture.underlyingSends.length, 3);
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
    assert.equal(fixture.underlyingSends.length, 0);
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

async function startEnrollmentServer(options: { optedOut?: boolean } = {}) {
  const patient: Patient = {
    resourceType: "Patient",
    id: "synthetic-enrollment-1",
    telecom: [{ system: "phone", value: "+18645550199", use: "mobile" }],
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
  const trackedLinks: Array<{
    token: string;
    targetUrl: string;
    campaignId: string;
    messageId: string;
    createdAt: string;
  }> = [];
  const auditReasons: string[] = [];
  let enrollmentSequence = 0;
  const storedEnrollments = createInMemoryEducationEnrollmentStore({
    generateId: () => `enrollment-api-synthetic-${++enrollmentSequence}`,
  });
  const terminalClearProviderCounts: number[] = [];
  const enrollmentStore = {
    ...storedEnrollments,
    async clearTerminalActiveIdentifier(id: string) {
      terminalClearProviderCounts.push(underlyingSends.length);
      return storedEnrollments.clearTerminalActiveIdentifier(id);
    },
  };
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
    async create<T extends Resource>(resource: T): Promise<T> {
      const persisted = {
        ...structuredClone(resource),
        id: `${resource.resourceType.toLowerCase()}-${communications.length + provenances.length + 1}`,
        meta: { versionId: "1" },
      } as T;
      if (persisted.resourceType === "Communication") {
        communications.push(structuredClone(persisted as Communication));
      }
      if (persisted.resourceType === "Provenance") {
        provenances.push(structuredClone(persisted as Provenance));
      }
      return structuredClone(persisted);
    },
    async update<T extends Resource>(resourceType: T["resourceType"], id: string, resource: T): Promise<T> {
      assert.equal(resourceType, "Communication");
      const index = communications.findIndex((entry) => entry.id === id);
      assert.notEqual(index, -1);
      const persisted = {
        ...structuredClone(resource),
        id,
        meta: { versionId: String(Number(communications[index]?.meta?.versionId ?? "0") + 1) },
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
      email: false,
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
      staffReference: "Practitioner/provider",
      actorRole: "provider",
      roles: ["provider"],
      fhir: callerFhir as never,
    } : null,
    fhir: callerFhir as never,
    dispatch: {
      initialize: async () => undefined,
      providers: () => ["synthetic-enrollment-provider"],
      providerFor: (role) => role === "clinical-sms" ? "synthetic-enrollment-provider" : undefined,
      senderNumberFor: (role) => role === "clinical-sms" ? "+18485550100" : undefined,
      getAdapter: () => suppressedProvider,
      getAdapterForRole: () => suppressedProvider,
    },
    educationCatalog: {
      list: () => [],
      get: (id, version) => id === "dry-eye-basics" && version === 2 ? {
        id,
        version,
        title: "Understanding dry eye",
        kind: "video",
        audience: "patient",
        dxCodes: [],
        channels: ["sms"],
        laneHint: "clinical",
        consentClass: "transactional",
        urls: { web: "https://education.invalid/dry-eye-basics/v2" },
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

function request(base: string, path: string, method: string, body?: unknown): Promise<Response> {
  return fetch(`${base}${path}`, {
    method,
    headers: {
      authorization: "Bearer provider",
      "x-odos-actor-id": "provider",
      "x-odos-actor-role": "provider",
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
