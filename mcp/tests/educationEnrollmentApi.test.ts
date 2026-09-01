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
  const enrollmentStore = createInMemoryEducationEnrollmentStore({
    generateId: () => "enrollment-api-synthetic-1",
  });
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
    underlyingSends,
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
