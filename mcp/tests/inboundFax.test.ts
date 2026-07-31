import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  AuditEvent,
  Bundle,
  DocumentReference,
  Encounter,
  Patient,
  Resource,
  ServiceRequest,
} from "@medplum/fhirtypes";
import {
  INBOUND_FAX_IDENTIFIER_SYSTEM,
  INBOUND_FAX_TRIAGE_STATUS_EXTENSION_URL,
  InboundFaxTriageService,
  createInboundFaxPoller,
  inboundFaxTriageStatus,
  inboundFaxWorkerIntervalMs,
} from "../src/fax/inbound-fax.js";
import type {
  WestFaxAdapter,
  WestFaxFaxDescription,
  WestFaxFaxDocument,
  WestFaxFaxIdentifier,
} from "../src/fax/westfax-adapter.js";
import {
  REFERRAL_CAPTURE_SOURCE_EXTENSION_URL,
  ReferralReplyWorklist,
} from "../src/referral/reciprocal-referral.js";

const FAX_ID: WestFaxFaxIdentifier = {
  id: "fax-inbound-1",
  direction: "Inbound",
  date: "2026-07-31T14:00:00.000Z",
  tag: "None",
};
const DESCRIPTION: WestFaxFaxDescription = {
  ...FAX_ID,
  pageCount: 2,
  senderNumber: "8645550199",
  reference: "Synthetic caller metadata",
};
const DOCUMENT: WestFaxFaxDocument = {
  ...FAX_ID,
  pageCount: 2,
  contentType: "application/pdf",
  fileContents: Buffer.from("%PDF-synthetic-inbound").toString("base64"),
};

test("inbound sweep runs the five WestFax calls in order and double ingestion creates one record", async () => {
  const fhir = new InboundFaxFhir();
  const adapter = new InboundFaxAdapter();
  const poller = createInboundFaxPoller({
    fhir,
    adapter,
    now: () => new Date("2026-07-31T15:00:00.000Z"),
    suggestPatient: async () => ({ reference: "Patient/suggested", display: "Suggested only" }),
  });

  await poller.run();
  await poller.run();

  assert.deepEqual(adapter.calls.slice(0, 5), [
    "products:None",
    "identifiers:product-1:Inbound",
    "descriptions:product-1:fax-inbound-1",
    "documents:product-1:fax-inbound-1:pdf",
    "filter:product-1:fax-inbound-1:Retrieved",
  ]);
  const records = fhir.resources("DocumentReference") as DocumentReference[];
  assert.equal(records.length, 1);
  assert.equal(
    records[0]?.identifier?.find((identifier) => identifier.system === INBOUND_FAX_IDENTIFIER_SYSTEM)?.value,
    FAX_ID.id,
  );
  assert.equal(inboundFaxTriageStatus(records[0]!), "received");
  assert.equal(adapter.retrieved, 2);
});

test("a recording failure is loud, repeat-surfaced, and never marked Retrieved", async () => {
  const fhir = new InboundFaxFhir();
  fhir.failDocumentCreates = true;
  const adapter = new InboundFaxAdapter();
  const surfaced: string[] = [];
  const poller = createInboundFaxPoller({
    fhir,
    adapter,
    failureThreshold: 2,
    onRepeatedFailure: (faxId, error) => surfaced.push(`${faxId}:${error.message}`),
  });

  const first = await poller.run();
  const second = await poller.run();

  assert.equal(first[0]?.outcome, "failed");
  assert.equal(second[0]?.outcome, "failed");
  assert.equal(adapter.retrieved, 0);
  assert.equal(surfaced.length, 1);
  assert.match(surfaced[0]!, /fax-inbound-1:synthetic record failure/);
});

test("an unmatched fax is retained in the general inbox rather than dropped", async () => {
  const fhir = new InboundFaxFhir();
  await createInboundFaxPoller({
    fhir,
    adapter: new InboundFaxAdapter(),
    suggestPatient: async () => undefined,
  }).run();

  const record = fhir.resources("DocumentReference")[0] as DocumentReference;
  assert.equal(inboundFaxTriageStatus(record), "inbox");
  assert.equal(record.subject, undefined);
  assert.equal(record.content[0]?.attachment.contentType, "application/pdf");
});

test("front desk attach and promote are explicit, audited actions and promotion feeds replies owed", async () => {
  const fhir = new InboundFaxFhir();
  await createInboundFaxPoller({
    fhir,
    adapter: new InboundFaxAdapter(),
    suggestPatient: async () => undefined,
  }).run();
  fhir.put({
    resourceType: "Patient",
    id: "patient-1",
    name: [{ text: "Synthetic Patient" }],
  } satisfies Patient);
  const triage = new InboundFaxTriageService(fhir, () => "2026-07-31T15:30:00.000Z");
  const record = fhir.resources("DocumentReference")[0] as DocumentReference;

  const attached = await triage.attach({
    faxDocumentReference: `DocumentReference/${record.id}`,
    patientReference: "Patient/patient-1",
    actorReference: "Practitioner/front-desk-1",
    actorRole: "front-desk",
  });
  assert.equal(attached.subject?.reference, "Patient/patient-1");
  assert.equal(inboundFaxTriageStatus(attached), "attached");
  assert.equal(
    (fhir.resources("AuditEvent") as AuditEvent[]).some(
      (event) => event.type.code === "correspondence.inbound-fax-attach",
    ),
    true,
  );

  const promoted = await triage.promote({
    faxDocumentReference: `DocumentReference/${record.id}`,
    patientReference: "Patient/patient-1",
    patientDisplay: "Synthetic Patient",
    referrerDisplay: "Synthetic Referrer",
    performerReference: "Practitioner/doctor-1",
    performerDisplay: "Doctor One",
    reasonText: "Evaluate synthetic retinal finding",
    actorReference: "Practitioner/front-desk-1",
    actorRole: "front-desk",
  });
  const captureSource = promoted.serviceRequest.extension?.find(
    (extension) => extension.url === REFERRAL_CAPTURE_SOURCE_EXTENSION_URL,
  )?.valueCode;
  assert.equal(captureSource, "fax");
  assert.equal(
    (fhir.resources("AuditEvent") as AuditEvent[]).some(
      (event) => event.type.code === "correspondence.inbound-fax-promote",
    ),
    true,
  );

  fhir.put({
    resourceType: "Encounter",
    id: "encounter-1",
    status: "finished",
    subject: { reference: "Patient/patient-1" },
    period: { end: "2026-07-31T16:00:00.000Z" },
  } satisfies Encounter);
  const rows = await new ReferralReplyWorklist(fhir).list();
  assert.equal(rows[0]?.serviceRequestReference, `ServiceRequest/${promoted.serviceRequest.id}`);
});

test("inbound worker cadence defaults to three minutes and validates operator overrides", () => {
  assert.equal(inboundFaxWorkerIntervalMs(undefined), 180_000);
  assert.equal(inboundFaxWorkerIntervalMs("240000"), 240_000);
  assert.throws(() => inboundFaxWorkerIntervalMs("14999"), /at least 15000/);
});

class InboundFaxAdapter implements WestFaxAdapter {
  readonly calls: string[] = [];
  retrieved = 0;

  async sendFax(): Promise<{ success: boolean }> {
    throw new Error("not used");
  }

  async getProductsWithInboundFaxes(filter: "None") {
    this.calls.push(`products:${filter}`);
    return [{ id: "product-1", inboundNumber: "8645550100" }];
  }

  async getFaxIdentifiers(productId: string, direction: "Inbound") {
    this.calls.push(`identifiers:${productId}:${direction}`);
    return [FAX_ID];
  }

  async getFaxDescriptions(productId: string, ids: WestFaxFaxIdentifier[]) {
    this.calls.push(`descriptions:${productId}:${ids.map((id) => id.id).join(",")}`);
    return [DESCRIPTION];
  }

  async getFaxDocuments(productId: string, ids: WestFaxFaxIdentifier[], format: "pdf") {
    this.calls.push(`documents:${productId}:${ids.map((id) => id.id).join(",")}:${format}`);
    return [DOCUMENT];
  }

  async changeFaxFilterValue(
    productId: string,
    ids: WestFaxFaxIdentifier[],
    filter: "Retrieved",
  ): Promise<void> {
    this.calls.push(`filter:${productId}:${ids.map((id) => id.id).join(",")}:${filter}`);
    this.retrieved += 1;
  }
}

class InboundFaxFhir {
  private readonly rows: Resource[] = [];
  failDocumentCreates = false;

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
    let resources = this.rows.filter((resource): resource is T => resource.resourceType === type);
    if (type === "ServiceRequest" && params.category) {
      resources = resources.filter((resource) =>
        (resource as ServiceRequest).category?.some((category) =>
          category.coding?.some((coding) => `${coding.system}|${coding.code}` === params.category)));
    }
    if (type === "Encounter" && params.patient) {
      resources = resources.filter((resource) =>
        (resource as Encounter).subject?.reference === `Patient/${params.patient}`);
    }
    if (type === "DocumentReference" && params.related) {
      resources = resources.filter((resource) =>
        (resource as DocumentReference).context?.related?.some(
          (related) => related.reference === params.related,
        ));
    }
    return {
      resourceType: "Bundle",
      type: "searchset",
      entry: resources.map((resource) => ({ resource: structuredClone(resource) })),
    };
  }

  async create<T extends Resource>(
    resource: T,
    headers: Record<string, string> = {},
  ): Promise<T> {
    if (resource.resourceType === "DocumentReference" && this.failDocumentCreates) {
      throw new Error("synthetic record failure");
    }
    const conditional = headers["If-None-Exist"]?.match(/^identifier=([^|]+)\|(.+)$/);
    if (conditional) {
      const existing = this.rows.find((candidate) =>
        candidate.resourceType === resource.resourceType
        && "identifier" in candidate
        && candidate.identifier?.some(
          (identifier) => identifier.system === conditional[1] && identifier.value === conditional[2],
        ));
      if (existing) return structuredClone(existing as T);
    }
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
