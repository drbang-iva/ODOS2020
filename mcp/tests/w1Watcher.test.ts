import assert from "node:assert/strict";
import test from "node:test";
import type {
  Appointment,
  Bundle,
  Invoice,
  PaymentReconciliation,
  Patient,
  Resource,
} from "@medplum/fhirtypes";
import { collectAllPages } from "../src/watchers/fhir-pagination.js";
import { evaluateW1 } from "../src/watchers/w1-balance-watcher.js";

const appointment: Appointment = {
  resourceType: "Appointment",
  id: "appt-1",
  status: "booked",
  start: "2026-08-30T09:40:00-04:00",
  end: "2026-08-30T10:00:00-04:00",
  participant: [{
    actor: { reference: "Patient/sarah", display: "Sarah Miller" },
    status: "accepted",
  }],
};

const sarah: Patient = {
  resourceType: "Patient",
  id: "sarah",
  gender: "female",
  name: [{ given: ["Sarah"], family: "Miller" }],
};

const invoice: Invoice = {
  resourceType: "Invoice",
  id: "invoice-1",
  status: "issued",
  subject: { reference: "Patient/sarah" },
  date: "2026-03-10T14:00:00.000Z",
  totalNet: { value: 132, currency: "USD" },
};

test("W1 follows Invoice next links and returns the complete patient-level balance", async () => {
  const fhir = new PagedFhir({
    Appointment: [bundle([appointment])],
    Patient: [bundle([sarah])],
    Invoice: [bundle([], "https://fhir.test/Invoice?page=2")],
  }, {
    "https://fhir.test/Invoice?page=2": bundle([invoice]),
  });

  const matches = await evaluateW1({
    fhir,
    date: "2026-08-30",
    now: "2026-08-30T12:00:00-04:00",
    timeZone: "America/New_York",
    settings: { enabled: true, severity: "today", minimumBalanceCents: 1 },
  });

  assert.deepEqual(matches, [{
    watcherId: "W1",
    conditionKey: "W1:Appointment/appt-1",
    patientReference: "Patient/sarah",
    patientDisplay: "Sarah M.",
    appointmentReference: "Appointment/appt-1",
    appointmentAt: "2026-08-30T09:40:00-04:00",
    frontDeskMessage: "Sarah M. has a balance from March. She's on today's schedule at 9:40 AM — $132 from her last visit.",
    ownerMessage: "Sarah M. is on today's schedule at 9:40 AM with a $132 balance from March.",
    balanceCents: 13200,
    ageDays: 173,
    sourceOccurredAt: "2026-03-10T14:00:00.000Z",
    sourceInvoiceCount: 1,
  }]);
});

test("W1 aggregates multiple issued Invoices for one appointment without stacking conditions", async () => {
  const older = { ...invoice, id: "invoice-older", date: "2026-02-01T12:00:00.000Z", totalNet: { value: 20, currency: "USD" } };
  const fhir = new PagedFhir({
    Appointment: [bundle([appointment])],
    Patient: [bundle([sarah])],
    Invoice: [bundle([older, invoice])],
  });

  const [match] = await evaluateW1({
    fhir,
    date: "2026-08-30",
    now: "2026-08-30T12:00:00-04:00",
    timeZone: "America/New_York",
    settings: { enabled: true, severity: "today", minimumBalanceCents: 1 },
  });

  assert.equal(match?.conditionKey, "W1:Appointment/appt-1");
  assert.equal(match?.balanceCents, 15200);
  assert.equal(match?.sourceInvoiceCount, 2);
  assert.equal(match?.frontDeskMessage, "Sarah M. has a balance from February. She's on today's schedule at 9:40 AM — $152 across 2 visits.");
});

test("W1 reports remaining balance after allocations and rejects an unknowable issued tender", async () => {
  const partial = reconciliation("payment-partial", "Invoice/invoice-1", 5_000);
  const partialFhir = new PagedFhir({
    Appointment: [bundle([appointment])],
    Patient: [bundle([sarah])],
    Invoice: [bundle([invoice])],
    PaymentReconciliation: [bundle([], "https://fhir.test/PaymentReconciliation?page=2")],
  }, {
    "https://fhir.test/PaymentReconciliation?page=2": bundle([partial]),
  });

  const [match] = await evaluateW1({
    fhir: partialFhir,
    date: "2026-08-30",
    now: "2026-08-30T12:00:00-04:00",
    timeZone: "America/New_York",
    settings: { enabled: true, severity: "today", minimumBalanceCents: 1 },
  });

  assert.equal(match?.balanceCents, 8_200);
  assert.match(match?.frontDeskMessage ?? "", /\$82 from her last visit/);

  const paidFhir = new PagedFhir({
    Appointment: [bundle([appointment])],
    Patient: [bundle([sarah])],
    Invoice: [bundle([invoice])],
    PaymentReconciliation: [bundle([reconciliation("payment-full", "Invoice/invoice-1", 13_200)])],
  });
  assert.deepEqual(await evaluateW1({
    fhir: paidFhir,
    date: "2026-08-30",
    now: "2026-08-30T12:00:00-04:00",
    timeZone: "America/New_York",
    settings: { enabled: true, severity: "today", minimumBalanceCents: 1 },
  }), []);

  const partialManualFhir = new PagedFhir({
    Appointment: [bundle([appointment])],
    Patient: [bundle([sarah])],
    Invoice: [bundle([{
      ...invoice,
      extension: [{ url: "https://odos2020.com/fhir/StructureDefinition/odos-payment-tender" }],
    }])],
  });
  await assert.rejects(
    () => evaluateW1({
      fhir: partialManualFhir,
      date: "2026-08-30",
      now: "2026-08-30T12:00:00-04:00",
      timeZone: "America/New_York",
      settings: { enabled: true, severity: "today", minimumBalanceCents: 1 },
    }),
    /record-only tender but remains issued; W1 cannot determine its partial paid amount/,
  );
});

test("W1 resolves scheduled Patients in bounded batches", async () => {
  const appointments = Array.from({ length: 101 }, (_, index): Appointment => ({
    ...appointment,
    id: `appt-${index + 1}`,
    participant: [{
      actor: { reference: `Patient/patient-${index + 1}`, display: `Patient ${index + 1}` },
      status: "accepted",
    }],
  }));
  const patients = Array.from({ length: 101 }, (_, index): Patient => ({
    resourceType: "Patient",
    id: `patient-${index + 1}`,
  }));
  const fhir = new PagedFhir({
    Appointment: [bundle(appointments)],
    Patient: [bundle(patients.slice(0, 100)), bundle(patients.slice(100))],
    Invoice: [bundle([])],
  });

  const matches = await evaluateW1({
    fhir,
    date: "2026-08-30",
    now: "2026-08-30T12:00:00-04:00",
    settings: { enabled: true, severity: "today", minimumBalanceCents: 1 },
  });

  assert.deepEqual(matches, []);
  const patientSearches = fhir.searches.filter((search) => search.resourceType === "Patient");
  assert.equal(patientSearches.length, 2);
  assert.deepEqual(patientSearches.map((search) => String(search.params._id).split(",").length), [100, 1]);
});

test("W1 refuses a confident short list when FHIR supplies a next link without pagination support", async () => {
  const fhir = {
    async search<T extends Resource>(resourceType: T["resourceType"]): Promise<Bundle<T>> {
      if (resourceType === "Appointment") return bundle([appointment], undefined) as Bundle<T>;
      if (resourceType === "Patient") return bundle([sarah], undefined) as Bundle<T>;
      return bundle([], "https://fhir.test/Invoice?page=2") as Bundle<T>;
    },
  };

  await assert.rejects(
    () => evaluateW1({
      fhir,
      date: "2026-08-30",
      now: "2026-08-30T12:00:00-04:00",
      timeZone: "America/New_York",
      settings: { enabled: true, severity: "today", minimumBalanceCents: 1 },
    }),
    /W1 invoices are incomplete: FHIR next-link support is unavailable/,
  );
});

test("complete pagination fails loudly when a source exceeds the 100-page guard", async () => {
  let page = 1;
  const fhir = {
    async search<T extends Resource>(): Promise<Bundle<T>> {
      return bundle([], "https://fhir.test/resources?page=2") as Bundle<T>;
    },
    async searchUrl<T extends Resource>(): Promise<Bundle<T>> {
      page += 1;
      return bundle([], `https://fhir.test/resources?page=${page + 1}`) as Bundle<T>;
    },
  };

  await assert.rejects(
    () => collectAllPages(fhir, "Invoice", { _count: "1000" }, "W1 invoices"),
    /W1 invoices are incomplete: search exceeded 100 pages or 10000 resources/,
  );
  assert.equal(page, 100);
});

test("W1 rejects a scheduled patient's issued Invoice whose money cannot be computed", async () => {
  const malformed: Invoice = { ...invoice, totalNet: undefined };
  const fhir = new PagedFhir({
    Appointment: [bundle([appointment])],
    Patient: [bundle([sarah])],
    Invoice: [bundle([malformed])],
  });

  await assert.rejects(
    () => evaluateW1({
      fhir,
      date: "2026-08-30",
      now: "2026-08-30T12:00:00-04:00",
      timeZone: "America/New_York",
      settings: { enabled: true, severity: "today", minimumBalanceCents: 1 },
    }),
    /Invoice\/invoice-1 has no computable USD totalNet; W1 cannot publish a complete balance watch/,
  );
});

class PagedFhir {
  private readonly fixturePages: Partial<Record<Resource["resourceType"], Bundle<Resource>[]>>;
  readonly searches: Array<{ resourceType: Resource["resourceType"]; params: Record<string, string> }> = [];

  constructor(
    searches: Partial<Record<Resource["resourceType"], Bundle<Resource>[]>>,
    private readonly nextPages: Record<string, Bundle<Resource>> = {},
  ) {
    this.fixturePages = {
      PaymentReconciliation: [bundle([])],
      ...searches,
    };
  }

  async search<T extends Resource>(resourceType: T["resourceType"], params: Record<string, string>): Promise<Bundle<T>> {
    this.searches.push({ resourceType, params });
    const page = this.fixturePages[resourceType]?.shift();
    if (!page) throw new Error(`Unexpected ${resourceType} search.`);
    return page as Bundle<T>;
  }

  async searchUrl<T extends Resource>(url: string): Promise<Bundle<T>> {
    const page = this.nextPages[url];
    if (!page) throw new Error(`Unexpected next link ${url}.`);
    return page as Bundle<T>;
  }
}

function reconciliation(id: string, invoiceReference: string, amountCents: number): PaymentReconciliation {
  return {
    resourceType: "PaymentReconciliation",
    id,
    status: "active",
    outcome: "complete",
    paymentDate: "2026-08-30",
    paymentAmount: { value: amountCents / 100, currency: "USD" },
    detail: [{
      request: { reference: invoiceReference },
      amount: { value: amountCents / 100, currency: "USD" },
    }],
  };
}

function bundle<T extends Resource>(resources: T[], next?: string): Bundle<T> {
  return {
    resourceType: "Bundle",
    type: "searchset",
    entry: resources.map((resource) => ({ resource })),
    ...(next ? { link: [{ relation: "next", url: next }] } : {}),
  };
}
