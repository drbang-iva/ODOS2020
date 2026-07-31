import assert from "node:assert/strict";
import { test } from "node:test";
import type { AuditEvent, DocumentReference, Resource, ServiceRequest } from "@medplum/fhirtypes";
import {
  handleInboundFaxActionRequest,
  handleInboundFaxDocumentRequest,
} from "../src/fax/inbound-fax-endpoint.js";
import {
  INBOUND_FAX_IDENTIFIER_SYSTEM,
  INBOUND_FAX_TRIAGE_STATUS_EXTENSION_URL,
} from "../src/fax/inbound-fax.js";

test("front desk can view, attach, promote, and route an inbound fax through the HTTP boundary", async () => {
  const fhir = new EndpointFhir();
  fhir.put(inboundFax());
  const deps = {
    authenticate: async () => ({
      staffReference: "Practitioner/front-desk-1",
      actorRole: "front-desk" as const,
    }),
    serviceFhir: fhir,
    now: () => "2026-07-31T15:30:00.000Z",
  };

  const viewed = await handleInboundFaxDocumentRequest(deps, {
    authHeader: "Bearer synthetic",
    faxId: "fax-1",
  });
  assert.equal(viewed.status, 200);
  assert.equal(viewed.contentType, "application/pdf");
  assert.match(viewed.dataBase64 ?? "", /^JVBER/);

  const attached = await handleInboundFaxActionRequest(deps, {
    authHeader: "Bearer synthetic",
    faxId: "fax-1",
    action: "attach",
    body: { patientReference: "Patient/patient-1" },
  });
  assert.equal(attached.status, 200);

  const promoted = await handleInboundFaxActionRequest(deps, {
    authHeader: "Bearer synthetic",
    faxId: "fax-1",
    action: "promote",
    body: {
      patientReference: "Patient/patient-1",
      patientDisplay: "Synthetic Patient",
      referrerDisplay: "Synthetic Referrer",
      performerReference: "Practitioner/doctor-1",
      performerDisplay: "Doctor One",
      reasonText: "Evaluate synthetic finding",
    },
  });
  assert.equal(promoted.status, 200);
  assert.equal(fhir.resources("ServiceRequest").length, 1);
  assert.equal(fhir.resources("AuditEvent").length, 2);

  const routed = await handleInboundFaxActionRequest(deps, {
    authHeader: "Bearer synthetic",
    faxId: "fax-1",
    action: "inbox",
    body: {},
  });
  assert.equal(routed.status, 200);
});

test("inbound fax HTTP boundary rejects missing auth and non-correspondence roles", async () => {
  const fhir = new EndpointFhir();
  fhir.put(inboundFax());
  const missing = await handleInboundFaxActionRequest({
    authenticate: async () => null,
    serviceFhir: fhir,
  }, {
    authHeader: undefined,
    faxId: "fax-1",
    action: "inbox",
    body: {},
  });
  assert.equal(missing.status, 401);

  const denied = await handleInboundFaxActionRequest({
    authenticate: async () => ({
      staffReference: "Practitioner/biller-1",
      actorRole: "biller",
    }),
    serviceFhir: fhir,
  }, {
    authHeader: "Bearer synthetic",
    faxId: "fax-1",
    action: "inbox",
    body: {},
  });
  assert.equal(denied.status, 403);
});

function inboundFax(): DocumentReference {
  return {
    resourceType: "DocumentReference",
    id: "fax-1",
    identifier: [{ system: INBOUND_FAX_IDENTIFIER_SYSTEM, value: "westfax-1" }],
    status: "current",
    docStatus: "final",
    content: [{
      attachment: {
        contentType: "application/pdf",
        data: Buffer.from("%PDF-synthetic-inbound").toString("base64"),
        title: "inbound.pdf",
      },
    }],
    extension: [{ url: INBOUND_FAX_TRIAGE_STATUS_EXTENSION_URL, valueCode: "received" }],
  };
}

class EndpointFhir {
  private readonly rows: Resource[] = [];

  resources(type: Resource["resourceType"]): Resource[] {
    return this.rows.filter((resource) => resource.resourceType === type);
  }

  put<T extends Resource>(resource: T): T {
    this.rows.push(structuredClone(resource));
    return resource;
  }

  async read<T extends Resource>(type: T["resourceType"], id: string): Promise<T> {
    const resource = this.rows.find((candidate) =>
      candidate.resourceType === type && candidate.id === id);
    if (!resource) throw new Error(`${type}/${id} not found`);
    return structuredClone(resource as T);
  }

  async search<T extends Resource>(): Promise<{
    resourceType: "Bundle";
    type: "searchset";
    entry: Array<{ resource: T }>;
  }> {
    return { resourceType: "Bundle", type: "searchset", entry: [] };
  }

  async create<T extends Resource>(resource: T): Promise<T> {
    const saved = {
      ...structuredClone(resource),
      id: resource.id ?? `${resource.resourceType.toLowerCase()}-${this.rows.length + 1}`,
    } as T;
    this.rows.push(saved);
    return structuredClone(saved);
  }

  async update<T extends Resource>(
    type: T["resourceType"],
    id: string,
    resource: T,
  ): Promise<T> {
    const index = this.rows.findIndex((candidate) =>
      candidate.resourceType === type && candidate.id === id);
    if (index < 0) throw new Error(`${type}/${id} not found`);
    const saved = { ...structuredClone(resource), id } as T;
    this.rows[index] = saved;
    return structuredClone(saved);
  }
}
