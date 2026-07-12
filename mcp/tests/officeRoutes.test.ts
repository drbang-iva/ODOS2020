import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import type { Bundle, Communication, Patient, Practitioner, Provenance, Resource } from "@medplum/fhirtypes";
import express from "express";
import { registerOfficeRoutes } from "../src/office/office-routes.js";

test("Office channel closes the desk-send to clinician-ack loop with caller attribution", async () => {
  const communications: Communication[] = [];
  const provenances: Provenance[] = [];
  let nextId = 1;
  const practitioners = new Map([
    ["desk-1", { resourceType: "Practitioner", id: "desk-1", name: [{ given: ["Hannah"], family: "Desk" }] } satisfies Practitioner],
    ["doctor-1", { resourceType: "Practitioner", id: "doctor-1", name: [{ prefix: ["Dr."], given: ["Eric"], family: "Bang" }] } satisfies Practitioner],
  ]);
  const patient = { resourceType: "Patient", id: "patient-1", name: [{ given: ["Maya"], family: "Alvarez" }] } satisfies Patient;
  const fhir = {
    read: async <T extends Resource>(resourceType: T["resourceType"], id: string): Promise<T> => {
      if (resourceType === "Communication") return communications.find((message) => message.id === id) as T;
      if (resourceType === "Practitioner") return practitioners.get(id) as T;
      if (resourceType === "Patient" && id === patient.id) return patient as T;
      throw new Error(`Missing ${resourceType}/${id}`);
    },
    search: async <T extends Resource>(resourceType: T["resourceType"], params: Record<string, string> = {}): Promise<Bundle<T>> => {
      const resources = resourceType === "Communication" ? communications : resourceType === "Provenance"
        ? provenances.filter((event) => !params.target || event.target?.some((target) => params.target.split(",").includes(target.reference ?? ""))) : [];
      return { resourceType: "Bundle", type: "searchset", entry: resources.map((resource) => ({ resource: resource as T })) };
    },
    create: async <T extends Resource>(resource: T): Promise<T> => {
      const created = { ...resource, id: `${resource.resourceType.toLowerCase()}-${nextId++}` } as T;
      if (created.resourceType === "Communication") communications.push(created as Communication);
      if (created.resourceType === "Provenance") provenances.push(created as Provenance);
      return created;
    },
  };
  const app = express();
  app.use(express.json());
  registerOfficeRoutes(app, {
    authenticateService: async () => undefined,
    authenticate: async (header) => header === "Bearer desk"
      ? { staffReference: "Practitioner/desk-1", actorRole: "front-desk", fhir }
      : header === "Bearer doctor" ? { staffReference: "Practitioner/doctor-1", actorRole: "clinician", fhir } : null,
    now: () => "2026-07-11T15:00:00.000Z",
  });
  const listener = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve, reject) => { listener.once("listening", resolve); listener.once("error", reject); });
  const { port } = listener.address() as AddressInfo;
  const base = `http://127.0.0.1:${port}/office/messages`;
  try {
    assert.equal((await fetch(base)).status, 401);
    assert.equal((await fetch(`${base}?box=inbox&view=all`)).status, 401);
    assert.equal((await fetch(`${base}/communication-1/ack`, { method: "POST" })).status, 401);

    const sent = await fetch(base, {
      method: "POST",
      headers: { Authorization: "Bearer desk", "Content-Type": "application/json" },
      body: JSON.stringify({ recipientRole: "clinician", text: "Insurance question at checkout", urgent: true, patientReference: "Patient/patient-1", senderReference: "Practitioner/spoofed" }),
    });
    assert.equal(sent.status, 201);
    const created = await sent.json() as { id: string; sender: { reference: string }; urgent: boolean; patient?: { id: string } };
    assert.equal(created.sender.reference, "Practitioner/desk-1");
    assert.equal(created.urgent, true);
    assert.equal(created.patient?.id, "patient-1");

    const doctorUnread = await fetch(`${base}?box=inbox&view=unread`, { headers: { Authorization: "Bearer doctor" } });
    assert.equal(doctorUnread.status, 200);
    assert.equal((await doctorUnread.json() as unknown[]).length, 1);

    const ack = await fetch(`${base}/${created.id}/ack`, { method: "POST", headers: { Authorization: "Bearer doctor" } });
    assert.equal(ack.status, 200);
    assert.equal(provenances.length, 1);
    assert.equal(provenances[0].agent?.[0]?.who.reference, "Practitioner/doctor-1");
    assert.equal(provenances[0].recorded, "2026-07-11T15:00:00.000Z");

    const deskSent = await fetch(`${base}?box=sent&view=all`, { headers: { Authorization: "Bearer desk" } });
    const closedLoop = await deskSent.json() as Array<{ acknowledgements: Array<{ by: string; at: string }> }>;
    assert.deepEqual(closedLoop[0].acknowledgements, [{ by: "Practitioner/doctor-1", display: "Dr. Eric Bang", at: "2026-07-11T15:00:00.000Z" }]);
    assert.deepEqual(await (await fetch(`${base}?box=inbox&view=unread`, { headers: { Authorization: "Bearer doctor" } })).json(), []);
  } finally {
    await new Promise<void>((resolve, reject) => listener.close((error) => error ? reject(error) : resolve()));
  }
});
