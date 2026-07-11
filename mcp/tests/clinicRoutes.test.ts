import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import type { Appointment, Bundle, Encounter, Patient, Provenance, Resource } from "@medplum/fhirtypes";
import express from "express";
import { registerClinicRoutes } from "../src/clinic/clinic-routes.js";

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
