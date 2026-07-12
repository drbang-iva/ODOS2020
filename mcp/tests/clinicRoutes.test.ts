import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import type { Appointment, Bundle, DocumentReference, Encounter, Patient, Provenance, Resource } from "@medplum/fhirtypes";
import express from "express";
import { registerClinicRoutes } from "../src/clinic/clinic-routes.js";
import { PATIENT_STICKY_NOTE_IDENTIFIER_SYSTEM } from "../src/clinic/patient-overview.js";

test("GET /clinic/summary authenticates once and returns every section from seeded FHIR data", async () => {
  const searched: string[] = [];
  const resources: Partial<Record<Resource["resourceType"], Resource[]>> = {
    Appointment: [{ resourceType: "Appointment", id: "a1", status: "checked-in", start: "2026-07-11T14:00:00.000Z", participant: [{ actor: { reference: "Patient/p1" }, status: "accepted" }] } satisfies Appointment],
    Encounter: [{ resourceType: "Encounter", id: "e1", status: "finished", class: { code: "AMB" }, subject: { reference: "Patient/p1" }, appointment: [{ reference: "Appointment/a1" }], period: { end: "2026-07-11T14:30:00.000Z" } } satisfies Encounter],
    Provenance: [] as Provenance[],
    Patient: [{ resourceType: "Patient", id: "p1", name: [{ given: ["Alex"], family: "Rivera" }] } satisfies Patient],
  };
  const fhir = {
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
      ? { staffReference: "Practitioner/staff-1", actorRole: "clinician", fhir: fhir as never }
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
    assert.deepEqual(Object.keys(body), ["flow", "signatures", "erx", "review"]);
    assert.deepEqual(searched, ["Appointment", "Encounter", "Provenance", "Patient"]);
    assert.equal(serviceAuthCalls, 2);
  } finally {
    await new Promise<void>((resolve, reject) => listener.close((error) => error ? reject(error) : resolve()));
  }
});

test("patient overview routes issue filtered FHIR searches and expose native sticky-note versions", async () => {
  const searched: Array<{ resourceType: string; params: Record<string, string> }> = [];
  let sticky: DocumentReference | undefined;
  const versions: DocumentReference[] = [];
  const fhir = {
    read: async () => ({ resourceType: "Patient", id: "p1", name: [{ given: ["Route"], family: "Patient" }] } satisfies Patient),
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
      ? { staffReference: "Practitioner/staff-1", actorRole: "clinician", fhir: fhir as never }
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

    await fetch(`http://127.0.0.1:${port}/clinic/patients/p1/sticky-note`, { method: "POST", headers, body: JSON.stringify({ text: "First route note" }) });
    await fetch(`http://127.0.0.1:${port}/clinic/patients/p1/sticky-note`, { method: "POST", headers, body: JSON.stringify({ text: "Second route note" }) });
    const history = await fetch(`http://127.0.0.1:${port}/clinic/patients/p1/sticky-note/history`, { headers });
    assert.equal(history.status, 200);
    assert.deepEqual((await history.json() as Array<{ text: string }>).map((row) => row.text), ["Second route note", "First route note"]);
  } finally {
    await new Promise<void>((resolve, reject) => listener.close((error) => error ? reject(error) : resolve()));
  }
});
