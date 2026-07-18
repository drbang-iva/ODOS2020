import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import type { Bundle, Communication, Patient, Practitioner, Provenance, Resource } from "@medplum/fhirtypes";
import express from "express";
import { OFFICE_ACK_CODE, OFFICE_ACK_SYSTEM, OFFICE_AUDIENCE_CODE, OFFICE_AUDIENCE_SYSTEM, OFFICE_CATEGORY_CODE, OFFICE_CATEGORY_SYSTEM } from "../src/office/office-channel.js";
import { officeActingRole, registerOfficeRoutes } from "../src/office/office-routes.js";

const LAB_CATEGORY_SYSTEM = "https://odos2020.com/fhir/CodeSystem/communication-category";
const LAB_CATEGORY_CODE = "optical-lab-order";

test("Office channel keeps Communications disjoint and counts only Office acknowledgements in mixed Provenance", async () => {
  const store = new InMemoryFhirStore();
  store.seed(
    practitioner("desk-1", "Hannah", "Desk"),
    practitioner("doctor-1", "Eric", "Bang", "Dr."),
    practitioner("doctor-2", "Nadia", "Cole", "Dr."),
    { resourceType: "Patient", id: "patient-1", name: [{ given: ["Maya"], family: "Alvarez" }] } satisfies Patient,
    communication("lab-1", LAB_CATEGORY_SYSTEM, LAB_CATEGORY_CODE),
  );
  const server = await startServer(store);
  try {
    const sent = await request(server.base, "/desk/office/messages", "desk", {
      method: "POST",
      body: { text: "Insurance question at checkout", tier: "patient-pinned", patientId: "patient-1", senderReference: "Practitioner/spoofed" },
    });
    assert.equal(sent.response.status, 201);
    assert.equal(sent.body.sender.reference, "Practitioner/desk-1");
    assert.equal(sent.body.tier, "patient-pinned");
    assert.equal(sent.body.patient.id, "patient-1");

    const clinicPoll = await request(server.base, "/clinic/office/messages", "doctor");
    assert.equal(clinicPoll.response.status, 200);
    assert.equal(clinicPoll.body.length, 1);
    assert.equal(clinicPoll.body[0].id, sent.body.id);

    store.seed({
      resourceType: "Provenance",
      id: "unrelated-provenance",
      target: [{ reference: `Communication/${sent.body.id}` }],
      recorded: "2026-07-11T14:30:00.000Z",
      activity: { coding: [{ system: OFFICE_ACK_SYSTEM, code: "unrelated" }] },
      agent: [{ who: { reference: "Practitioner/doctor-2", display: "Dr. Nadia Cole" } }],
    } satisfies Provenance);
    const mixedPoll = await request(server.base, "/clinic/office/messages", "doctor");
    assert.equal(mixedPoll.body[0].acknowledgement, undefined);

    const officeResources = await store.search<Communication>("Communication", { category: `${OFFICE_CATEGORY_SYSTEM}|${OFFICE_CATEGORY_CODE}` });
    const labResources = await store.search<Communication>("Communication", { category: `${LAB_CATEGORY_SYSTEM}|${LAB_CATEGORY_CODE}` });
    assert.deepEqual(officeResources.entry?.map((entry) => entry.resource?.id), [sent.body.id]);
    assert.deepEqual(labResources.entry?.map((entry) => entry.resource?.id), ["lab-1"]);

    const acknowledged = await request(server.base, `/clinic/office/messages/${sent.body.id}/ack`, "doctor", { method: "POST" });
    assert.equal(acknowledged.response.status, 200);
    assert.deepEqual(acknowledged.body.acknowledgement, {
      by: "Practitioner/doctor-1",
      display: "Dr. Eric Bang",
      at: "2026-07-11T15:00:00.000Z",
    });

    const secondClinicianAck = await request(server.base, `/clinic/office/messages/${sent.body.id}/ack`, "doctor-2", { method: "POST" });
    assert.equal(secondClinicianAck.response.status, 200);
    assert.deepEqual(secondClinicianAck.body.acknowledgement, acknowledged.body.acknowledgement);
    const provenances = store.resources.filter((resource): resource is Provenance => resource.resourceType === "Provenance");
    assert.equal(provenances.length, 2);
    assert.equal(provenances.filter((event) => event.activity?.coding?.some((coding) => coding.system === OFFICE_ACK_SYSTEM && coding.code === OFFICE_ACK_CODE)).length, 1);

    const deskPoll = await request(server.base, "/desk/office/messages", "desk");
    assert.equal(deskPoll.response.status, 200);
    assert.deepEqual(deskPoll.body[0].acknowledgement, acknowledged.body.acknowledgement);
  } finally {
    await server.close();
  }
});

test("Office routes enforce Desk and Clinic roles plus unauthenticated rejection", async () => {
  const store = new InMemoryFhirStore();
  store.seed(practitioner("desk-1", "Hannah", "Desk"), practitioner("doctor-1", "Eric", "Bang", "Dr."));
  const office = communication("office-1", OFFICE_CATEGORY_SYSTEM, OFFICE_CATEGORY_CODE);
  office.recipient = [{ identifier: { system: OFFICE_AUDIENCE_SYSTEM, value: OFFICE_AUDIENCE_CODE } }];
  store.seed(office);
  const server = await startServer(store);
  try {
    for (const path of ["/desk/office/messages", "/clinic/office/messages"]) {
      assert.equal((await request(server.base, path)).response.status, 401);
    }
    assert.equal((await request(server.base, "/desk/office/messages", "doctor", { method: "POST", body: { text: "No", tier: "ambient" } })).response.status, 403);
    assert.equal((await request(server.base, "/clinic/office/messages/office-1/ack", "desk", { method: "POST" })).response.status, 403);
    assert.equal((await request(server.base, "/clinic/office/messages", "desk")).response.status, 403);
    assert.equal((await request(server.base, "/desk/office/messages", "doctor")).response.status, 403);
  } finally {
    await server.close();
  }
});

test("Office routes authorize a clinician-primary multi-role caller on both sides", async () => {
  const store = new InMemoryFhirStore();
  store.seed(practitioner("owner-1", "Eric", "Bang", "Dr."));
  const server = await startServer(store);
  try {
    const sent = await request(server.base, "/desk/office/messages", "owner", {
      method: "POST",
      body: { text: "Multi-role desk action", tier: "ambient" },
    });
    assert.equal(sent.response.status, 201);
    assert.equal((await request(server.base, "/desk/office/messages", "owner")).response.status, 200);
    assert.equal((await request(server.base, "/clinic/office/messages", "owner")).response.status, 200);
    assert.equal(officeActingRole(["clinician", "front-desk", "practice-admin"], "desk"), "front-desk");
    assert.equal(officeActingRole(["clinician", "front-desk", "practice-admin"], "clinic"), "clinician");
  } finally {
    await server.close();
  }
});

test("Office routes return typed 400 validation errors and generic 500s", async () => {
  const store = new InMemoryFhirStore();
  store.seed(practitioner("desk-1", "Hannah", "Desk"), practitioner("doctor-1", "Eric", "Bang", "Dr."));
  const server = await startServer(store);
  try {
    const invalidBodies = [
      { text: "x".repeat(1001), tier: "ambient" },
      { text: "Pinned", tier: "patient-pinned" },
      { text: "Wrong", tier: "broadcast" },
      { text: "Mixed", tier: "urgent", patientId: "patient-1" },
    ];
    for (const body of invalidBodies) {
      const result = await request(server.base, "/desk/office/messages", "desk", { method: "POST", body });
      assert.equal(result.response.status, 400);
      assert.equal(typeof result.body.error, "string");
    }
    assert.equal((await request(server.base, "/clinic/office/messages?view=all", "doctor")).response.status, 400);

    store.failSearch = new Error("postgres password leaked from internal failure");
    const failed = await request(server.base, "/clinic/office/messages", "doctor");
    assert.equal(failed.response.status, 500);
    assert.deepEqual(failed.body, { error: "Office channel route failed." });
    assert.doesNotMatch(JSON.stringify(failed.body), /postgres|password|internal/i);
  } finally {
    await server.close();
  }
});

class InMemoryFhirStore {
  resources: Resource[] = [];
  failSearch?: Error;
  private nextId = 1;

  seed(...resources: Resource[]): void { this.resources.push(...resources); }

  async read<T extends Resource>(resourceType: T["resourceType"], id: string): Promise<T> {
    const found = this.resources.find((resource) => resource.resourceType === resourceType && resource.id === id);
    if (!found) throw new Error(`Missing ${resourceType}/${id}`);
    return found as T;
  }

  async search<T extends Resource>(resourceType: T["resourceType"], params: Record<string, string> = {}): Promise<Bundle<T>> {
    if (this.failSearch) throw this.failSearch;
    let matches = this.resources.filter((resource) => resource.resourceType === resourceType) as T[];
    if (resourceType === "Communication" && params.category) {
      const [system, code] = params.category.split("|");
      matches = matches.filter((resource) => (resource as Communication).category?.some((category) => category.coding?.some((coding) => coding.system === system && coding.code === code)));
    }
    if (resourceType === "Provenance" && params.target) {
      const targets = params.target.split(",");
      matches = matches.filter((resource) => (resource as Provenance).target?.some((target) => targets.includes(target.reference ?? "")));
    }
    return { resourceType: "Bundle", type: "searchset", entry: matches.map((resource) => ({ resource })) };
  }

  async create<T extends Resource>(resource: T): Promise<T> {
    const created = { ...resource, id: `${resource.resourceType.toLowerCase()}-${this.nextId++}` } as T;
    this.resources.push(created);
    return created;
  }
}

async function startServer(store: InMemoryFhirStore) {
  const app = express();
  app.use(express.json());
  registerOfficeRoutes(app, {
    authenticateService: async () => undefined,
    authenticate: async (header) => header === "Bearer desk"
      ? { staffReference: "Practitioner/desk-1", actorRole: "front-desk", roles: ["front-desk"], fhir: store }
      : header === "Bearer doctor" ? { staffReference: "Practitioner/doctor-1", actorRole: "clinician", roles: ["clinician"], fhir: store }
        : header === "Bearer doctor-2" ? { staffReference: "Practitioner/doctor-2", actorRole: "clinician", roles: ["clinician"], fhir: store }
          : header === "Bearer owner" ? {
              staffReference: "Practitioner/owner-1",
              actorRole: "clinician",
              roles: ["clinician", "front-desk", "practice-admin"],
              fhir: store,
            } : null,
    now: () => "2026-07-11T15:00:00.000Z",
  });
  const listener = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve, reject) => { listener.once("listening", resolve); listener.once("error", reject); });
  const { port } = listener.address() as AddressInfo;
  return {
    base: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve, reject) => listener.close((error) => error ? reject(error) : resolve())),
  };
}

async function request(base: string, path: string, token?: string, options: { method?: string; body?: unknown } = {}) {
  const response = await fetch(`${base}${path}`, {
    method: options.method ?? "GET",
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(options.body ? { "Content-Type": "application/json" } : {}) },
    ...(options.body ? { body: JSON.stringify(options.body) } : {}),
  });
  return { response, body: await response.json() as any };
}

function practitioner(id: string, given: string, family: string, prefix?: string): Practitioner {
  return { resourceType: "Practitioner", id, name: [{ ...(prefix ? { prefix: [prefix] } : {}), given: [given], family }] };
}

function communication(id: string, system: string, code: string): Communication {
  return {
    resourceType: "Communication",
    id,
    status: "completed",
    sent: "2026-07-11T14:00:00.000Z",
    category: [{ coding: [{ system, code }] }],
    sender: { reference: "Practitioner/desk-1" },
    payload: [{ contentString: "Transport fixture" }],
  };
}

assert.equal(OFFICE_ACK_SYSTEM.includes("office-message-activity"), true);
assert.equal(OFFICE_ACK_CODE, "acknowledged");
