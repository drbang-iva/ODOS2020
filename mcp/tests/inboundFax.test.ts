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
  INBOUND_FAX_REFERRAL_IDENTIFIER_SYSTEM,
  INBOUND_FAX_TRIAGE_STATUS_EXTENSION_URL,
  InboundFaxTriageConflictError,
  InboundFaxTriageService,
  createInboundFaxPoller,
  inboundFaxTriageStatus,
  inboundFaxWorkerEnabled,
  inboundFaxWorkerIntervalMs,
  startInboundFaxWorker,
  suggestInboundFaxPatient,
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

test("a multi-file fax fails alone while neighboring faxes are recorded", async () => {
  const fhir = new InboundFaxFhir();
  const { adapter, retrieved } = threeFaxAdapterWithMultiFileFailure();

  const results = await createInboundFaxPoller({
    fhir,
    adapter,
    suggestPatient: async () => undefined,
  }).run();

  assert.deepEqual(results.map(({ faxId, outcome }) => ({ faxId, outcome })), [
    { faxId: "fax-good-1", outcome: "recorded" },
    { faxId: "fax-multi-file", outcome: "failed" },
    { faxId: "fax-good-2", outcome: "recorded" },
  ]);
  assert.match(
    results[1]?.detail ?? "",
    /fax fax-multi-file must contain exactly one PDF file; received 2/i,
  );
  assert.deepEqual(retrieved, ["fax-good-1", "fax-good-2"]);
});

test("a repeatedly rejected multi-file fax reaches the repeated-failure signal", async () => {
  const fhir = new InboundFaxFhir();
  const { adapter } = threeFaxAdapterWithMultiFileFailure();
  const surfaced: string[] = [];
  const poller = createInboundFaxPoller({
    fhir,
    adapter,
    suggestPatient: async () => undefined,
    failureThreshold: 2,
    onRepeatedFailure: (faxId, error) => surfaced.push(`${faxId}:${error.message}`),
  });

  const first = await poller.run();
  const second = await poller.run();

  assert.equal(first.find(({ faxId }) => faxId === "fax-multi-file")?.outcome, "failed");
  assert.equal(second.find(({ faxId }) => faxId === "fax-multi-file")?.outcome, "failed");
  assert.deepEqual(surfaced, [
    "fax-multi-file:WestFax fax fax-multi-file must contain exactly one PDF file; received 2.",
  ]);
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
    actorRole: "staff",
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
    actorRole: "staff",
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

test("re-promoting a fax to a different patient fails closed without moving the fax", async () => {
  const fhir = new InboundFaxFhir();
  await createInboundFaxPoller({
    fhir,
    adapter: new InboundFaxAdapter(),
    suggestPatient: async () => undefined,
  }).run();
  const record = fhir.resources("DocumentReference")[0] as DocumentReference;
  const triage = new InboundFaxTriageService(fhir, () => "2026-07-31T15:30:00.000Z");
  const promote = (patientReference: string) => triage.promote({
    faxDocumentReference: `DocumentReference/${record.id}`,
    patientReference,
    patientDisplay: patientReference,
    referrerDisplay: "Synthetic Referrer",
    performerReference: "Practitioner/doctor-1",
    performerDisplay: "Doctor One",
    reasonText: "Evaluate synthetic finding",
    actorReference: "Practitioner/staff-1",
    actorRole: "staff",
  });

  await promote("Patient/patient-1");
  await assert.rejects(
    promote("Patient/patient-2"),
    /already promoted to Patient\/patient-1.*cannot be reassigned to Patient\/patient-2/i,
  );

  const stored = await fhir.read<DocumentReference>("DocumentReference", record.id!);
  assert.equal(stored.subject?.reference, "Patient/patient-1");
  assert.equal((fhir.resources("ServiceRequest") as ServiceRequest[])[0]?.subject.reference, "Patient/patient-1");
});

test("a 412 during promotion leaves no orphan ServiceRequest", async () => {
  const fhir = new InboundFaxFhir();
  await createInboundFaxPoller({
    fhir,
    adapter: new InboundFaxAdapter(),
    suggestPatient: async () => undefined,
  }).run();
  const record = fhir.resources("DocumentReference")[0] as DocumentReference;
  fhir.conflictStatusOnNextUpdate = 412;
  const triage = new InboundFaxTriageService(fhir, () => "2026-07-31T15:30:00.000Z");

  await assert.rejects(
    promoteFax(triage, record, "Patient/patient-1"),
    /changed by another staff member.*Reload the Desk/i,
  );

  assert.equal(fhir.resources("ServiceRequest").length, 0);
});

test("an existing referral patient mismatch fails before any fax version mutation", async () => {
  const fhir = new InboundFaxFhir();
  await createInboundFaxPoller({
    fhir,
    adapter: new InboundFaxAdapter(),
    suggestPatient: async () => undefined,
  }).run();
  const record = fhir.resources("DocumentReference")[0] as DocumentReference;
  fhir.put(inboundReferral("referral-existing", FAX_ID.id, "Patient/patient-1"));
  fhir.failServiceRequestCreates = true;
  const before = await fhir.read<DocumentReference>("DocumentReference", record.id!);
  const triage = new InboundFaxTriageService(fhir, () => "2026-07-31T15:30:00.000Z");

  await assert.rejects(
    promoteFax(triage, record, "Patient/patient-2"),
    /already promoted to Patient\/patient-1.*cannot be reassigned to Patient\/patient-2/i,
  );

  const after = await fhir.read<DocumentReference>("DocumentReference", record.id!);
  assert.equal(after.meta?.versionId, before.meta?.versionId);
});

test("an indeterminate existing-referral search fails closed without update or create", async () => {
  const fhir = new InboundFaxFhir();
  await createInboundFaxPoller({
    fhir,
    adapter: new InboundFaxAdapter(),
    suggestPatient: async () => undefined,
  }).run();
  const record = fhir.resources("DocumentReference")[0] as DocumentReference;
  const before = await fhir.read<DocumentReference>("DocumentReference", record.id!);
  fhir.failServiceRequestSearches = true;
  const triage = new InboundFaxTriageService(fhir, () => "2026-07-31T15:30:00.000Z");

  await assert.rejects(
    promoteFax(triage, record, "Patient/patient-1"),
    /could not verify whether this fax already has a referral/i,
  );

  const after = await fhir.read<DocumentReference>("DocumentReference", record.id!);
  assert.equal(after.meta?.versionId, before.meta?.versionId);
  assert.equal(fhir.resources("ServiceRequest").length, 0);
});

test("duplicate referral identifiers fail closed as ambiguous before fax mutation", async () => {
  const fhir = new InboundFaxFhir();
  await createInboundFaxPoller({
    fhir,
    adapter: new InboundFaxAdapter(),
    suggestPatient: async () => undefined,
  }).run();
  const record = fhir.resources("DocumentReference")[0] as DocumentReference;
  fhir.put(inboundReferral("referral-one", FAX_ID.id, "Patient/patient-1"));
  fhir.put(inboundReferral("referral-two", FAX_ID.id, "Patient/patient-1"));
  const before = await fhir.read<DocumentReference>("DocumentReference", record.id!);
  const triage = new InboundFaxTriageService(fhir, () => "2026-07-31T15:30:00.000Z");

  await assert.rejects(
    promoteFax(triage, record, "Patient/patient-1"),
    /more than one referral uses this fax identifier/i,
  );

  const after = await fhir.read<DocumentReference>("DocumentReference", record.id!);
  assert.equal(after.meta?.versionId, before.meta?.versionId);
});

test("triage writes use the version read and inbox routing is audited without inventing a patient", async () => {
  const fhir = new InboundFaxFhir();
  await createInboundFaxPoller({
    fhir,
    adapter: new InboundFaxAdapter(),
    suggestPatient: async () => undefined,
  }).run();
  const record = fhir.resources("DocumentReference")[0] as DocumentReference;
  const triage = new InboundFaxTriageService(fhir, () => "2026-07-31T15:30:00.000Z");

  await triage.routeToInbox(
    `DocumentReference/${record.id}`,
    "Practitioner/staff-1",
    "staff",
  );

  assert.equal(fhir.updateHeaders[0]?.["If-Match"], 'W/"1"');
  const audit = (fhir.resources("AuditEvent") as AuditEvent[]).find(
    (event) => event.type.code === "correspondence.inbound-fax-inbox",
  );
  assert.ok(audit);
  assert.deepEqual(audit.entity?.map((entity) => entity.what.reference), [
    `DocumentReference/${record.id}`,
  ]);
});

test("stale If-Match conflicts at 409 and 412 surface the reload message without applying triage", async (t) => {
  for (const status of [409, 412] as const) {
    await t.test(String(status), async () => {
      const fhir = new InboundFaxFhir();
      await createInboundFaxPoller({
        fhir,
        adapter: new InboundFaxAdapter(),
        suggestPatient: async () => ({
          reference: "Patient/suggested",
          display: "Suggested Patient",
        }),
      }).run();
      const record = fhir.resources("DocumentReference")[0] as DocumentReference;
      fhir.conflictStatusOnNextUpdate = status;
      const triage = new InboundFaxTriageService(fhir, () => "2026-07-31T15:30:00.000Z");

      await assert.rejects(
        triage.routeToInbox(
          `DocumentReference/${record.id}`,
          "Practitioner/staff-1",
          "staff",
        ),
        (error: unknown) => {
          assert.ok(error instanceof InboundFaxTriageConflictError);
          assert.match(error.message, /changed by another staff member.*Reload the Desk/i);
          return true;
        },
      );

      const stored = await fhir.read<DocumentReference>("DocumentReference", record.id!);
      assert.equal(inboundFaxTriageStatus(stored), "received");
      assert.equal(fhir.updateHeaders[0]?.["If-Match"], 'W/"1"');
    });
  }
});

test("patient suggestions use bounded server filters and fail closed on truncated results", async () => {
  const calls: Array<{ resourceType: string; params: Record<string, string> }> = [];
  const complete = await suggestInboundFaxPatient({
    search: async <T extends Resource>(resourceType: T["resourceType"], params: Record<string, string> = {}) => {
      calls.push({ resourceType, params });
      if (resourceType === "Practitioner") {
        return bundle([{
          resourceType: "Practitioner",
          id: "referrer-1",
          telecom: [{ system: "fax", value: "8645550199" }],
        }], 1) as Bundle<T>;
      }
      if (resourceType === "ServiceRequest") {
        return bundle([{
          resourceType: "ServiceRequest",
          status: "active",
          intent: "order",
          subject: { reference: "Patient/patient-1", display: "Synthetic Patient" },
          requester: { reference: "Practitioner/referrer-1" },
          category: [{ coding: [{ system: "https://odos2020.com/fhir/CodeSystem/referral-direction", code: "inbound" }] }],
        }], 1) as Bundle<T>;
      }
      return bundle([], 0) as Bundle<T>;
    },
  }, "(864) 555-0199");

  assert.equal(complete?.reference, "Patient/patient-1");
  assert.deepEqual(calls.map(({ resourceType, params }) => [resourceType, params]), [
    ["Practitioner", { telecom: "fax|8645550199", _count: "200" }],
    ["PractitionerRole", { telecom: "fax|8645550199", _count: "200" }],
    ["ServiceRequest", {
      category: "https://odos2020.com/fhir/CodeSystem/referral-direction|inbound",
      requester: "Practitioner/referrer-1",
      _sort: "-authored",
      _count: "200",
    }],
  ]);

  const truncated = await suggestInboundFaxPatient({
    search: async <T extends Resource>(resourceType: T["resourceType"]) => {
      if (resourceType === "Practitioner") {
        return bundle([{
          resourceType: "Practitioner",
          id: "referrer-1",
          telecom: [{ system: "fax", value: "8645550199" }],
        }], 2) as Bundle<T>;
      }
      if (resourceType === "PractitionerRole") return bundle([], 0) as Bundle<T>;
      throw new Error("A truncated directory result must stop before referral search.");
    },
  }, "8645550199");
  assert.equal(truncated, undefined);
});

test("inbound worker skips interval ticks while a sweep is still running", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  let runs = 0;
  const timer = startInboundFaxWorker({
    authenticate: async () => undefined,
    poller: {
      run: async () => {
        runs += 1;
        await blocked;
        return [];
      },
    },
    intervalMs: 15_000,
  });
  await Promise.resolve();
  assert.equal(runs, 1);

  t.mock.timers.tick(30_000);
  await Promise.resolve();
  assert.equal(runs, 1);

  release();
  await new Promise<void>((resolve) => setImmediate(resolve));
  t.mock.timers.tick(15_000);
  await Promise.resolve();
  assert.equal(runs, 2);
  clearInterval(timer);
});

test("inbound worker cadence defaults to three minutes and validates operator overrides", () => {
  assert.equal(inboundFaxWorkerEnabled(undefined), false);
  assert.equal(inboundFaxWorkerEnabled("false"), false);
  assert.equal(inboundFaxWorkerEnabled("TRUE"), false);
  assert.equal(inboundFaxWorkerEnabled("true"), true);
  assert.equal(inboundFaxWorkerIntervalMs(undefined), 180_000);
  assert.equal(inboundFaxWorkerIntervalMs("240000"), 240_000);
  assert.throws(() => inboundFaxWorkerIntervalMs("14999"), /at least 15,000/);
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

function threeFaxAdapterWithMultiFileFailure(): {
  adapter: WestFaxAdapter;
  retrieved: string[];
} {
  const faxIds = ["fax-good-1", "fax-multi-file", "fax-good-2"].map((id) => ({
    id,
    direction: "Inbound" as const,
    date: "2026-07-31T14:00:00.000Z",
    tag: "None",
  }));
  const retrieved: string[] = [];
  return {
    retrieved,
    adapter: {
      async sendFax() {
        throw new Error("not used");
      },
      async getProductsWithInboundFaxes() {
        return [{ id: "product-1", inboundNumber: "8645550100" }];
      },
      async getFaxIdentifiers() {
        return faxIds;
      },
      async getFaxDescriptions(_productId, requested) {
        return requested.map((fax) => ({
          ...fax,
          pageCount: 2,
          senderNumber: "8645550199",
        }));
      },
      async getFaxDocuments(_productId, requested) {
        if (requested.some(({ id }) => id === "fax-multi-file")) {
          throw new Error(
            "WestFax fax fax-multi-file must contain exactly one PDF file; received 2.",
          );
        }
        return requested.map((fax) => ({
          ...fax,
          pageCount: 2,
          contentType: "application/pdf" as const,
          fileContents: Buffer.from(`%PDF-${fax.id}`).toString("base64"),
        }));
      },
      async changeFaxFilterValue(_productId, requested) {
        retrieved.push(...requested.map(({ id }) => id));
      },
    },
  };
}

class InboundFaxFhir {
  private readonly rows: Resource[] = [];
  failDocumentCreates = false;
  failServiceRequestCreates = false;
  failServiceRequestSearches = false;
  conflictStatusOnNextUpdate?: 409 | 412;
  readonly updateHeaders: Record<string, string>[] = [];

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
    if (type === "ServiceRequest" && this.failServiceRequestSearches) {
      throw new Error("synthetic ServiceRequest search failure");
    }
    let resources = this.rows.filter((resource): resource is T => resource.resourceType === type);
    if (type === "ServiceRequest" && params.category) {
      resources = resources.filter((resource) =>
        (resource as ServiceRequest).category?.some((category) =>
          category.coding?.some((coding) => `${coding.system}|${coding.code}` === params.category)));
    }
    if (type === "ServiceRequest" && params.identifier) {
      const [system, value] = params.identifier.split("|");
      resources = resources.filter((resource) =>
        (resource as ServiceRequest).identifier?.some(
          (identifier) => identifier.system === system && identifier.value === value,
        ));
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
      total: resources.length,
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
    if (resource.resourceType === "ServiceRequest" && this.failServiceRequestCreates) {
      throw new Error("synthetic ServiceRequest create failure");
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
      meta: { ...structuredClone(resource.meta), versionId: "1" },
    } as T;
    this.rows.push(saved);
    return structuredClone(saved);
  }

  async update<T extends Resource>(
    type: T["resourceType"],
    id: string,
    resource: T,
    headers: Record<string, string> = {},
  ): Promise<T> {
    this.updateHeaders.push(structuredClone(headers));
    const index = this.rows.findIndex((candidate) =>
      candidate.resourceType === type && candidate.id === id);
    if (index < 0) throw new Error(`${type}/${id} not found`);
    const conflictStatus = this.conflictStatusOnNextUpdate;
    if (conflictStatus) {
      const current = this.rows[index]!;
      const concurrentVersion = Number(current.meta?.versionId ?? "0") + 1;
      this.rows[index] = {
        ...current,
        meta: { ...current.meta, versionId: String(concurrentVersion) },
      };
      this.conflictStatusOnNextUpdate = undefined;
    }
    const currentVersion = this.rows[index]?.meta?.versionId;
    const ifMatch = headers["If-Match"];
    if (ifMatch && ifMatch !== `W/"${currentVersion}"`) {
      const error = new Error(`synthetic stale If-Match conflict (${conflictStatus ?? 412})`);
      (error as Error & { status?: number }).status = conflictStatus ?? 412;
      throw error;
    }
    const version = Number(this.rows[index]?.meta?.versionId ?? "0") + 1;
    const saved = { ...structuredClone(resource), id, meta: { ...resource.meta, versionId: String(version) } } as T;
    this.rows[index] = saved;
    return structuredClone(saved);
  }
}

function promoteFax(
  triage: InboundFaxTriageService,
  record: DocumentReference,
  patientReference: string,
) {
  return triage.promote({
    faxDocumentReference: `DocumentReference/${record.id}`,
    patientReference,
    patientDisplay: patientReference,
    referrerDisplay: "Synthetic Referrer",
    performerReference: "Practitioner/doctor-1",
    performerDisplay: "Doctor One",
    reasonText: "Evaluate synthetic finding",
    actorReference: "Practitioner/staff-1",
    actorRole: "staff",
  });
}

function inboundReferral(
  id: string,
  faxId: string,
  patientReference: string,
): ServiceRequest {
  return {
    resourceType: "ServiceRequest",
    id,
    status: "active",
    intent: "order",
    subject: { reference: patientReference },
    code: { text: "Synthetic inbound referral" },
    identifier: [{ system: INBOUND_FAX_REFERRAL_IDENTIFIER_SYSTEM, value: faxId }],
  };
}

function bundle<T extends Resource>(resources: T[], total: number): Bundle<T> {
  return {
    resourceType: "Bundle",
    type: "searchset",
    total,
    entry: resources.map((resource) => ({ resource })),
  };
}
