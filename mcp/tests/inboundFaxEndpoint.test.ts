import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import type { AuditEvent, Bundle, DocumentReference, ProjectMembership, Resource, ServiceRequest } from "@medplum/fhirtypes";
import express from "express";
import {
  handleInboundFaxActionRequest,
  handleInboundFaxDocumentRequest,
} from "../src/fax/inbound-fax-endpoint.js";
import {
  INBOUND_FAX_IDENTIFIER_SYSTEM,
  INBOUND_FAX_TRIAGE_STATUS_EXTENSION_URL,
} from "../src/fax/inbound-fax.js";
import { registerFaxRoutes } from "../src/fax/fax-routes.js";

test("front desk can view, attach, promote, and route an inbound fax through the HTTP boundary", async () => {
  const fhir = new EndpointFhir();
  fhir.put(inboundFax());
  fhir.grant("Practitioner/staff-1", "Patient/patient-1");
  const deps = {
    authenticate: async () => ({
      staffReference: "Practitioner/staff-1",
      actorRole: "staff" as const,
      roles: ["staff" as const],
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
  assert.equal(fhir.resources("AuditEvent").length, 3);

  const routed = await handleInboundFaxActionRequest(deps, {
    authHeader: "Bearer synthetic",
    faxId: "fax-1",
    action: "inbox",
    body: {},
  });
  assert.equal(routed.status, 200);
  assert.equal(fhir.resources("AuditEvent").length, 4);
});

test("inbound fax HTTP boundary rejects missing auth and patient writes outside the caller compartment", async () => {
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
      staffReference: "Practitioner/staff-1",
      actorRole: "staff",
      roles: ["staff"],
    }),
    serviceFhir: fhir,
  }, {
    authHeader: "Bearer synthetic",
    faxId: "fax-1",
    action: "attach",
    body: { patientReference: "Patient/outside" },
  });
  assert.equal(denied.status, 403);
  assert.deepEqual(denied.body, {
    error: "The requested patient is outside the staff member's patient compartment.",
  });
  assert.equal((fhir.resources("DocumentReference")[0] as DocumentReference).subject, undefined);
});

test("PDF reads are practice-wide but are audited against the fax and assigned patient", async () => {
  const fhir = new EndpointFhir();
  fhir.put({ ...inboundFax(), subject: { reference: "Patient/patient-1" } });
  const result = await handleInboundFaxDocumentRequest({
    authenticate: async () => ({
      staffReference: "Practitioner/admin-1",
      actorRole: "admin",
      roles: ["admin"],
    }),
    serviceFhir: fhir,
    now: () => "2026-08-19T12:00:00.000Z",
  }, {
    authHeader: "Bearer synthetic",
    faxId: "fax-1",
  });

  assert.equal(result.status, 200);
  const audit = fhir.resources("AuditEvent")[0] as AuditEvent;
  assert.equal(audit.action, "R");
  assert.equal(audit.type.code, "correspondence.inbound-fax-read");
  assert.deepEqual(audit.entity?.map((entity) => entity.what.reference), [
    "Patient/patient-1",
    "DocumentReference/fax-1",
  ]);
});

test("stale triage writes return an operator-legible 409", async () => {
  const fhir = new EndpointFhir();
  fhir.put(inboundFax());
  fhir.grant("Practitioner/staff-1", "Patient/patient-1");
  fhir.rejectNextUpdateStatus = 412;

  const result = await handleInboundFaxActionRequest({
    authenticate: async () => ({
      staffReference: "Practitioner/staff-1",
      actorRole: "staff",
      roles: ["staff"],
    }),
    serviceFhir: fhir,
  }, {
    authHeader: "Bearer synthetic",
    faxId: "fax-1",
    action: "attach",
    body: { patientReference: "Patient/patient-1" },
  });

  assert.equal(result.status, 409);
  assert.deepEqual(result.body, {
    error: "This inbound fax was changed by another staff member. Reload the Desk and try again.",
  });
});

test("inline fax PDFs carry restrictive browser hardening headers", async () => {
  const fhir = new EndpointFhir();
  fhir.put(inboundFax());
  const app = express();
  registerFaxRoutes(app, {
    authenticateService: async () => undefined,
    authenticate: async () => ({
      staffReference: "Practitioner/admin-1",
      actorRole: "admin",
      roles: ["admin"],
    }),
    serviceFhir: fhir,
    adapter: null,
  } as never);
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  try {
    const port = (server.address() as AddressInfo).port;
    const response = await fetch(`http://127.0.0.1:${port}/fax/inbound/fax-1/document`, {
      headers: { Authorization: "Bearer synthetic" },
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    assert.equal(
      response.headers.get("content-security-policy"),
      "default-src 'none'; object-src 'none'; sandbox",
    );
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

function inboundFax(): DocumentReference {
  return {
    resourceType: "DocumentReference",
    id: "fax-1",
    meta: { versionId: "1" },
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
  private readonly grants = new Map<string, Set<string>>();
  rejectNextUpdateStatus?: number;

  grant(staffReference: string, patientReference: string): void {
    const patients = this.grants.get(staffReference) ?? new Set<string>();
    patients.add(patientReference);
    this.grants.set(staffReference, patients);
  }

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

  async search<T extends Resource>(
    type: T["resourceType"],
    params: Record<string, string> = {},
  ): Promise<Bundle<T>> {
    if (type !== "ProjectMembership") {
      return { resourceType: "Bundle", type: "searchset", entry: [] };
    }
    const patients = this.grants.get(params.profile ?? "") ?? new Set<string>();
    const membership: ProjectMembership = {
      resourceType: "ProjectMembership",
      id: "membership-1",
      profile: { reference: params.profile },
      access: [{
        parameter: [...patients].map((patientReference) => ({
          name: "patient_compartment",
          valueString: patientReference,
        })),
      }],
    };
    return {
      resourceType: "Bundle",
      type: "searchset",
      entry: [{ resource: membership as T }],
    };
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
    if (this.rejectNextUpdateStatus !== undefined) {
      const status = this.rejectNextUpdateStatus;
      this.rejectNextUpdateStatus = undefined;
      throw Object.assign(new Error("synthetic version conflict"), { status });
    }
    const index = this.rows.findIndex((candidate) =>
      candidate.resourceType === type && candidate.id === id);
    if (index < 0) throw new Error(`${type}/${id} not found`);
    const saved = { ...structuredClone(resource), id, meta: { ...resource.meta, versionId: "2" } } as T;
    this.rows[index] = saved;
    return structuredClone(saved);
  }
}
