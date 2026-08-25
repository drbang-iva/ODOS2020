import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import type { Appointment, Bundle, DocumentReference, Encounter, Patient, Provenance, Resource, Task } from "@medplum/fhirtypes";
import express from "express";
import { registerClinicRoutes } from "../src/clinic/clinic-routes.js";
import { loadClinicSummary } from "../src/clinic/clinic-summary.js";
import { PATIENT_STICKY_NOTE_IDENTIFIER_SYSTEM } from "../src/clinic/patient-overview.js";

test("POST /clinic/patients is an authenticated registration route", async () => {
  const app = express();
  app.use(express.json());
  registerClinicRoutes(app, {
    authenticateService: async () => undefined,
    authenticate: async () => null,
  });
  const listener = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve, reject) => {
    listener.once("listening", resolve);
    listener.once("error", reject);
  });
  const { port } = listener.address() as AddressInfo;
  try {
    const response = await fetch(`http://127.0.0.1:${port}/clinic/patients`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    assert.equal(response.status, 401);
  } finally {
    await new Promise<void>((resolve, reject) =>
      listener.close((error) => error ? reject(error) : resolve())
    );
  }
});

test("registration uses its action-gated authenticator without replacing other clinic authentication", async () => {
  let clinicAuthCalls = 0;
  let registrationAuthCalls = 0;
  const app = express();
  app.use(express.json());
  registerClinicRoutes(app, {
    authenticateService: async () => undefined,
    authenticate: async () => {
      clinicAuthCalls += 1;
      return null;
    },
    authenticateRegistration: async () => {
      registrationAuthCalls += 1;
      return null;
    },
  } as never);
  const listener = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve, reject) => {
    listener.once("listening", resolve);
    listener.once("error", reject);
  });
  const { port } = listener.address() as AddressInfo;
  try {
    assert.equal((await fetch(`http://127.0.0.1:${port}/clinic/summary`)).status, 401);
    assert.equal((await fetch(`http://127.0.0.1:${port}/clinic/patients`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    })).status, 401);
    assert.equal(clinicAuthCalls, 1);
    assert.equal(registrationAuthCalls, 1);
  } finally {
    await new Promise<void>((resolve, reject) =>
      listener.close((error) => error ? reject(error) : resolve())
    );
  }
});

test("POST /clinic/patients strictly rejects fields outside the real registration form payload", async () => {
  const app = express();
  app.use(express.json());
  registerClinicRoutes(app, {
    authenticateService: async () => undefined,
    authenticate: async () => ({
      staffReference: "Practitioner/staff-1",
      actorRole: "staff",
      fhir: {} as never,
    }),
  });
  const listener = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve, reject) => {
    listener.once("listening", resolve);
    listener.once("error", reject);
  });
  const { port } = listener.address() as AddressInfo;
  try {
    const response = await fetch(`http://127.0.0.1:${port}/clinic/patients`, {
      method: "POST",
      headers: { Authorization: "Bearer good", "Content-Type": "application/json" },
      body: JSON.stringify({
        demographics: {
          firstName: "Synthetic",
          middleName: "",
          lastName: "Registration",
          preferredName: "",
          birthDate: "1980-01-02",
          gender: "female",
          phone: "864-555-0100",
          email: "",
          address: "1 Synthetic Way",
          city: "Greenville",
          state: "SC",
          postalCode: "29601",
        },
        responsibleParties: [{
          localId: "self",
          kind: "self",
          relationship: "other",
          firstName: "",
          middleName: "",
          lastName: "",
          phone: "",
          address: "",
          city: "",
          state: "",
          postalCode: "",
          financialResponsible: true,
          consentAuthority: false,
          primary: true,
          courtOrderNotes: "",
          effectiveDate: "",
          endDate: "",
        }],
        confirmDuplicate: false,
        source: "browser-built-fhir",
      }),
    });
    assert.equal(response.status, 400);
    assert.match(JSON.stringify(await response.json()), /unrecognized|unsupported/i);
  } finally {
    await new Promise<void>((resolve, reject) =>
      listener.close((error) => error ? reject(error) : resolve())
    );
  }
});

test("GET /clinic/summary authenticates once and returns every section from seeded FHIR data", async () => {
  const searched: string[] = [];
  const resources: Partial<Record<Resource["resourceType"], Resource[]>> = {
    Appointment: [{ resourceType: "Appointment", id: "a1", status: "checked-in", start: "2026-07-11T14:00:00.000Z", participant: [{ actor: { reference: "Patient/p1" }, status: "accepted" }] } satisfies Appointment],
    Encounter: [{ resourceType: "Encounter", id: "e1", status: "finished", class: { code: "AMB" }, subject: { reference: "Patient/p1" }, appointment: [{ reference: "Appointment/a1" }], period: { end: "2026-07-11T14:30:00.000Z" } } satisfies Encounter],
    Provenance: [] as Provenance[],
    Patient: [{ resourceType: "Patient", id: "p1", name: [{ given: ["Alex"], family: "Rivera" }] } satisfies Patient],
    Task: [] as Task[],
  };
  const fhir = {
    baseUrl: "http://localhost:8103/",
    search: async <T extends Resource>(resourceType: T["resourceType"]): Promise<Bundle<T>> => {
      searched.push(String(resourceType));
      return { resourceType: "Bundle", type: "searchset", entry: (resources[resourceType] ?? []).map((resource) => ({ resource: resource as T })) };
    },
  };
  let serviceAuthCalls = 0;
  const app = express();
  registerClinicRoutes(app, {
    authenticateService: async () => { serviceAuthCalls += 1; },
    authenticate: async (header) => header === "Bearer good"
      ? { staffReference: "Practitioner/staff-1", actorRole: "provider", fhir: fhir as never }
      : null,
    now: () => "2026-07-11T15:00:00.000Z",
    timeZone: "America/New_York",
  });
  const listener = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve, reject) => { listener.once("listening", resolve); listener.once("error", reject); });
  const { port } = listener.address() as AddressInfo;
  try {
    assert.equal((await fetch(`http://127.0.0.1:${port}/clinic/summary`)).status, 401);
    const response = await fetch(`http://127.0.0.1:${port}/clinic/summary`, { headers: { Authorization: "Bearer good" } });
    assert.equal(response.status, 200);
    const body = await response.json() as Record<string, unknown>;
    assert.deepEqual(Object.keys(body), ["flow", "signatures", "orders", "erx", "review"]);
    assert.deepEqual(searched, ["Appointment", "Encounter", "Task", "Provenance", "Patient"]);
    assert.equal(serviceAuthCalls, 2);
  } finally {
    await new Promise<void>((resolve, reject) => listener.close((error) => error ? reject(error) : resolve()));
  }
});

test("Clinic summary follows multiple FHIR pages and fails loudly at the five-page cap", async () => {
  const appointment = (id: string): Appointment => ({
    resourceType: "Appointment",
    id,
    status: "booked",
    start: "2026-07-11T14:00:00.000Z",
    participant: [{ actor: { reference: `Patient/${id}` }, status: "accepted" }],
  });
  let nextCalls = 0;
  const multipage = {
    baseUrl: "http://localhost:8103/",
    search: async <T extends Resource>(resourceType: T["resourceType"]): Promise<Bundle<T>> => {
      if (resourceType === "Appointment") {
        return {
          resourceType: "Bundle",
          type: "searchset",
          entry: [{ resource: appointment("p1") as T }],
          link: [{ relation: "next", url: "/fhir/R4/Appointment?_page=2" }],
        };
      }
      if (resourceType === "Patient") {
        return {
          resourceType: "Bundle",
          type: "searchset",
          entry: ["p1", "p2"].map((id) => ({ resource: { resourceType: "Patient", id } as T })),
        };
      }
      return { resourceType: "Bundle", type: "searchset" };
    },
    searchUrl: async <T extends Resource>(url: string): Promise<Bundle<T>> => {
      nextCalls += 1;
      assert.equal(url, "/fhir/R4/Appointment?_page=2");
      return { resourceType: "Bundle", type: "searchset", entry: [{ resource: appointment("p2") as T }] };
    },
  };
  const summary = await loadClinicSummary(multipage as never, {
    now: "2026-07-11T15:00:00.000Z",
    date: "2026-07-11",
  });
  assert.deepEqual(summary.flow.map((row) => row.appointmentId), ["p1", "p2"]);
  assert.equal(nextCalls, 1);

  let cappedCalls = 0;
  const capped = {
    baseUrl: "http://localhost:8103/",
    search: async <T extends Resource>(resourceType: T["resourceType"]): Promise<Bundle<T>> => resourceType === "Appointment"
      ? { resourceType: "Bundle", type: "searchset", link: [{ relation: "next", url: "/fhir/R4/Appointment?_page=2" }] }
      : { resourceType: "Bundle", type: "searchset" },
    searchUrl: async <T extends Resource>(): Promise<Bundle<T>> => {
      cappedCalls += 1;
      return { resourceType: "Bundle", type: "searchset", link: [{ relation: "next", url: "/fhir/R4/Appointment?_page=2" }] };
    },
  };
  await assert.rejects(
    loadClinicSummary(capped as never, { now: "2026-07-11T15:00:00.000Z", date: "2026-07-11" }),
    /FHIR Appointment query exceeded 5 pages; no partial result was returned/,
  );
  assert.equal(cappedCalls, 4);
});

test("patient overview routes issue filtered FHIR searches and expose native sticky-note versions", async () => {
  const searched: Array<{ resourceType: string; params: Record<string, string> }> = [];
  let sticky: DocumentReference | undefined;
  const versions: DocumentReference[] = [];
  const fhir = {
    baseUrl: "http://localhost:8103/",
    read: async (resourceType: Resource["resourceType"], id: string) => {
      if (resourceType === "Encounter" && id === "missing") {
        const error = new Error("Encounter not found") as Error & { status: number };
        error.status = 404;
        throw error;
      }
      return resourceType === "Encounter"
        ? ({ resourceType: "Encounter", id: "e1", status: "finished", class: { code: "AMB" }, subject: { reference: "Patient/p1" } } satisfies Encounter)
        : ({ resourceType: "Patient", id: "p1", name: [{ given: ["Route"], family: "Patient" }] } satisfies Patient);
    },
    search: async <T extends Resource>(resourceType: T["resourceType"], params: Record<string, string> = {}): Promise<Bundle<T>> => {
      searched.push({ resourceType, params });
      const rows = resourceType === "DocumentReference" && sticky && params.identifier === `${PATIENT_STICKY_NOTE_IDENTIFIER_SYSTEM}|p1` ? [sticky as T] : [];
      return { resourceType: "Bundle", type: "searchset", entry: rows.map((resource) => ({ resource })) };
    },
    create: async (resource: DocumentReference) => {
      sticky = { ...resource, id: "sticky-1", meta: { versionId: "1", lastUpdated: "2026-07-11T14:00:00Z" } };
      versions.unshift(structuredClone(sticky));
      return sticky;
    },
    update: async (_type: string, _id: string, resource: DocumentReference) => {
      sticky = { ...resource, id: "sticky-1", meta: { versionId: "2", lastUpdated: "2026-07-11T15:00:00Z" } };
      versions.unshift(structuredClone(sticky));
      return sticky;
    },
    history: async () => ({ resourceType: "Bundle", type: "history", entry: versions.map((resource) => ({ resource })) }),
  };
  const app = express();
  app.use(express.json());
  registerClinicRoutes(app, {
    authenticateService: async () => undefined,
    authenticate: async (header) => header === "Bearer good"
      ? { staffReference: "Practitioner/staff-1", actorRole: "provider", fhir: fhir as never }
      : null,
    now: () => "2026-07-11T14:00:00Z",
  });
  const listener = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve, reject) => { listener.once("listening", resolve); listener.once("error", reject); });
  const { port } = listener.address() as AddressInfo;
  const headers = { Authorization: "Bearer good", "Content-Type": "application/json" };
  try {
    const overview = await fetch(`http://127.0.0.1:${port}/clinic/patients/p1/overview?filter=office-visits`, { headers });
    assert.equal(overview.status, 200);
    assert.match(searched.find((row) => row.resourceType === "Encounter")?.params.type ?? "", /office-visit/);
    assert.equal((await fetch(`http://127.0.0.1:${port}/clinic/patients/p1/overview?filter=all&filter=eye-exams`, { headers })).status, 400);
    assert.equal((await fetch(`http://127.0.0.1:${port}/clinic/patients/p1/overview?diagnosisSystem=&diagnosisCode=DX`, { headers })).status, 400);
    const visitDetail = await fetch(`http://127.0.0.1:${port}/clinic/patients/p1/overview/visits/e1`, { headers });
    assert.equal(visitDetail.status, 200);
    const visitDetailBody = await visitDetail.json() as Record<string, unknown>;
    for (const key of ["encounterId", "iop", "findings", "medications", "plan", "financial"]) {
      assert.ok(key in visitDetailBody, `visit detail includes ${key}`);
    }
    assert.equal((await fetch(`http://127.0.0.1:${port}/clinic/patients/p1/overview/visits/missing`, { headers })).status, 404);
    assert.equal((await fetch(`http://127.0.0.1:${port}/clinic/patients/p1/overview/visits/not!valid`, { headers })).status, 400);

    const firstSave = await fetch(`http://127.0.0.1:${port}/clinic/patients/p1/sticky-note`, { method: "POST", headers, body: JSON.stringify({ text: "First route note" }) });
    assert.equal(firstSave.status, 200);
    const secondSave = await fetch(`http://127.0.0.1:${port}/clinic/patients/p1/sticky-note`, { method: "POST", headers, body: JSON.stringify({ text: "Second route note" }) });
    assert.equal(secondSave.status, 200);
    const history = await fetch(`http://127.0.0.1:${port}/clinic/patients/p1/sticky-note/history`, { headers });
    assert.equal(history.status, 200);
    assert.deepEqual((await history.json() as Array<{ text: string }>).map((row) => row.text), ["Second route note", "First route note"]);
  } finally {
    await new Promise<void>((resolve, reject) => listener.close((error) => error ? reject(error) : resolve()));
  }
});
