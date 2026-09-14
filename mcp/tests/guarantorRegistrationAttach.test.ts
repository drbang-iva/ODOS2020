import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import test from "node:test";
import type { Account, Bundle, Patient, Person, RelatedPerson, Resource } from "@medplum/fhirtypes";
import express from "express";
import { registerClinicRoutes } from "../src/clinic/clinic-routes.js";
import { CONSENT_AUTHORITY_EXTENSION_URL } from "../src/clinic/patient-registration-endpoint.js";

const existingParty = {
  localId: "guardian-existing",
  kind: "existing",
  personId: "guarantor-existing",
  relationship: "parent",
  financialResponsible: true,
  consentAuthority: true,
  primary: true,
  courtOrderNotes: "",
  effectiveDate: "2026-09-14",
  endDate: "",
} as const;

const registrationBody = {
  demographics: {
    firstName: "Synthetic", middleName: "", lastName: "Child", preferredName: "",
    birthDate: "2015-04-03", gender: "female",
    phones: [{ value: "864-555-0100", use: "home" }, { value: "", use: "mobile" }], textable: "",
    email: "", address: "1 Synthetic Way", city: "Greenville", state: "SC", postalCode: "29601",
  },
  responsibleParties: [existingParty],
  confirmDuplicate: false,
} as const;

class RegistrationAttachFhir {
  readonly baseUrl = "http://synthetic.fhir.test";
  readonly resources = new Map<string, Resource>();
  readonly events: string[] = [];
  reservationWrites = 0;
  transaction?: Bundle;
  person: Person;
  dropRegistrationReply = false;
  duplicateRecoveredRelatedPerson = false;

  constructor() {
    this.person = {
      resourceType: "Person", id: "guarantor-existing", active: true,
      meta: { versionId: "7", project: "practice-1" },
      name: [{ given: ["Existing"], family: "Guardian" }],
      telecom: [{ system: "phone", value: "864-555-0199" }],
      address: [{ line: ["9 Existing Lane"], city: "Greenville", state: "SC", postalCode: "29601" }],
      link: [{ target: { reference: "RelatedPerson/older-child" }, assurance: "level2" }],
    };
    this.resources.set("Person/guarantor-existing", structuredClone(this.person));
  }

  async search<T extends Resource>(): Promise<Bundle<T>> {
    return { resourceType: "Bundle", type: "searchset", entry: [] };
  }

  async searchProject<T extends Resource>(resourceType: T["resourceType"], _projectId?: string, params?: Record<string, string>): Promise<Bundle<T>> {
    if (resourceType === "Patient") return { resourceType: "Bundle", type: "searchset", entry: [] };
    if (resourceType === "RelatedPerson") {
      const resources = [...this.resources.values()].filter((resource): resource is RelatedPerson => resource.resourceType === "RelatedPerson"
        && resource.patient.reference === params?.patient);
      return { resourceType: "Bundle", type: "searchset", entry: resources.map(resource => ({ resource: structuredClone(resource) as T })) };
    }
    throw new Error(`unexpected project search ${resourceType}`);
  }

  async searchProjectUrl<T extends Resource>(): Promise<Bundle<T>> {
    return { resourceType: "Bundle", type: "searchset", entry: [] };
  }

  async create<T extends Resource>(resource: T): Promise<T> {
    assert.equal(resource.resourceType, "Account");
    this.reservationWrites++;
    return { ...resource, id: "reservation-1", meta: { ...resource.meta, versionId: "1" } } as T;
  }

  async readExtended<T extends Resource>(resourceType: T["resourceType"], id: string): Promise<T> {
    const resource = this.resources.get(`${resourceType}/${id}`);
    if (!resource) throw Object.assign(new Error(`FHIR 404 ${resourceType}/${id}`), { status: 404 });
    return structuredClone(resource) as T;
  }

  async read<T extends Resource>(resourceType: T["resourceType"], id: string): Promise<T> {
    return this.readExtended<T>(resourceType, id);
  }

  async update<T extends Resource>(_resourceType: T["resourceType"], _id: string, resource: T): Promise<T> {
    return structuredClone(resource);
  }

  async patch<T extends Resource>(): Promise<T> {
    throw new Error("grant patch is replaced by the explicit test seam");
  }

  async executeTransactionAsActor(
    bundle: Bundle,
    _actor?: unknown,
    _headers?: unknown,
    options?: { reconcileError?: (error: unknown) => Promise<Bundle> },
  ): Promise<Bundle> {
    this.events.push("registration");
    this.transaction = structuredClone(bundle);
    const resolvedReferences = new Map<string, string>();
    for (const [index, entry] of (bundle.entry ?? []).entries()) {
      if (entry.fullUrl && entry.resource?.resourceType !== "Account") {
        const id = entry.resource.resourceType === "Patient" ? "patient-registered" : entry.resource.resourceType === "RelatedPerson" ? `related-${index}` : entry.resource.id ?? "existing-person-write";
        resolvedReferences.set(entry.fullUrl, `${entry.resource.resourceType}/${id}`);
      }
    }
    const responseEntries = (bundle.entry ?? []).map((entry, index) => {
      const resource = structuredClone(entry.resource!);
      let id: string;
      if (resource.resourceType === "Patient") id = "patient-registered";
      else if (resource.resourceType === "RelatedPerson") id = `related-${index}`;
      else if (resource.resourceType === "Person") id = resource.id ?? "existing-person-write";
      else if (resource.resourceType === "Account") id = "reservation-1";
      else throw new Error(`unexpected registration resource ${resource.resourceType}`);
      if (resource.resourceType === "RelatedPerson" && resource.patient.reference) {
        resource.patient.reference = resolvedReferences.get(resource.patient.reference) ?? resource.patient.reference;
      }
      if (resource.resourceType === "Account") {
        resource.subject = resource.subject?.map(subject => ({ ...subject, reference: subject.reference ? resolvedReferences.get(subject.reference) ?? subject.reference : subject.reference }));
        resource.guarantor = resource.guarantor?.map(guarantor => ({ ...guarantor, party: { ...guarantor.party, reference: guarantor.party.reference ? resolvedReferences.get(guarantor.party.reference) ?? guarantor.party.reference : guarantor.party.reference } }));
      }
      const accepted = { ...resource, id, meta: { ...resource.meta, versionId: resource.resourceType === "Account" ? "2" : "1" } } as Resource;
      this.resources.set(`${resource.resourceType}/${id}`, accepted);
      return { resource: structuredClone(accepted), response: { status: entry.request?.method === "PUT" ? "200 OK" : "201 Created", location: `${resource.resourceType}/${id}/_history/${accepted.meta?.versionId}` } };
    });
    if (this.duplicateRecoveredRelatedPerson) {
      const related = this.resources.get("RelatedPerson/related-1") as RelatedPerson;
      this.resources.set("RelatedPerson/related-duplicate", { ...structuredClone(related), id: "related-duplicate" });
    }
    if (this.dropRegistrationReply) return options!.reconcileError!(new Error("synthetic registration reply loss"));
    return { resourceType: "Bundle", type: "transaction-response", entry: responseEntries };
  }
}

type HarnessOptions = {
  businessActions?: string[];
  attachResult?: { status: number; body: unknown };
  mutatePerson?: (person: Person) => Person;
  dropRegistrationReply?: boolean;
  duplicateRecoveredRelatedPerson?: boolean;
  registrationBody?: unknown;
};

async function postRegistration(options: HarnessOptions = {}) {
  const fhir = new RegistrationAttachFhir();
  if (options.mutatePerson) {
    fhir.person = options.mutatePerson(fhir.person);
    fhir.resources.set("Person/guarantor-existing", structuredClone(fhir.person));
  }
  fhir.dropRegistrationReply = options.dropRegistrationReply ?? false;
  fhir.duplicateRecoveredRelatedPerson = options.duplicateRecoveredRelatedPerson ?? false;
  let attachedInput: unknown;
  const app = express();
  app.use(express.json());
  registerClinicRoutes(app, {
    authenticateService: async () => undefined,
    authenticate: async () => ({
      staffReference: "Practitioner/staff-1", actorRole: "staff", roles: ["staff"],
      businessActions: options.businessActions ?? ["patients.register", "guarantor.link"],
      project: { reference: "Project/practice-1" }, fhir: {} as never,
    }),
    serviceFhir: fhir,
    now: () => "2026-09-14T12:00:00.000Z",
    grantRegistrationAccess: async () => { fhir.events.push("grant"); },
    attachRegistrationGuarantor: async (_staff, input) => {
      fhir.events.push("attach");
      attachedInput = structuredClone(input);
      return options.attachResult ?? { status: 200, body: { task: { resourceType: "Task", id: "attach-task", status: "completed" }, phase: "linked" } };
    },
  } as never);
  const listener = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve, reject) => { listener.once("listening", resolve); listener.once("error", reject); });
  const { port } = listener.address() as AddressInfo;
  try {
    const response = await fetch(`http://127.0.0.1:${port}/clinic/patients`, {
      method: "POST", headers: { Authorization: "Bearer synthetic", "Content-Type": "application/json" }, body: JSON.stringify(options.registrationBody ?? registrationBody),
    });
    return { fhir, response, body: await response.json() as any, attachedInput };
  } finally {
    await new Promise<void>((resolve, reject) => listener.close(error => error ? reject(error) : resolve()));
  }
}

test("A9: registration with an existing guarantor commits no Person and attaches after access grant", async () => {
  const { fhir, response, body, attachedInput } = await postRegistration();
  assert.equal(response.status, 201);
  assert.deepEqual(fhir.events, ["registration", "grant", "attach"]);
  assert.deepEqual(fhir.transaction?.entry?.map(entry => entry.resource?.resourceType), ["Patient", "RelatedPerson", "Account"]);
  assert.equal(fhir.transaction?.entry?.some(entry => entry.request?.url === "Person" || entry.resource?.resourceType === "Person"), false);
  const related = fhir.transaction?.entry?.find(entry => entry.resource?.resourceType === "RelatedPerson")!.resource as RelatedPerson;
  assert.deepEqual(related.name, fhir.person.name);
  assert.deepEqual(related.telecom, fhir.person.telecom);
  assert.deepEqual(related.address, fhir.person.address);
  assert.deepEqual(attachedInput, {
    operationId: (attachedInput as any).operationId,
    kind: "attach", destinationPersonId: "guarantor-existing", relatedPersonIds: ["related-1"],
    expected: { "Person/guarantor-existing": "7", "RelatedPerson/related-1": "1" }, reason: "Registration attach",
  });
  assert.match((attachedInput as any).operationId, /^[0-9a-f-]{36}$/);
  assert.deepEqual(body.guarantorLinks, [{ relatedPersonId: "related-1", personId: "guarantor-existing", taskId: "attach-task", status: "linked", message: "Guarantor linked." }]);
});

test("A10: an attach claim conflict after the registration bundle preserves 201 and reports the failed Task", async () => {
  const { fhir, response, body } = await postRegistration({
    attachResult: { status: 409, body: { task: { resourceType: "Task", id: "failed-attach", status: "failed" }, phase: "claim-conflict", error: "Pending: Complete or Correct." } },
  });
  assert.equal(response.status, 201);
  assert.equal((await fhir.read<Patient>("Patient", "patient-registered")).id, "patient-registered");
  assert.deepEqual(body.guarantorLinks, [{ relatedPersonId: "related-1", personId: "guarantor-existing", taskId: "failed-attach", status: "failed", message: "Pending: Complete or Correct." }]);
});

test("B3: a lost committed registration reply is recovered before the existing guarantor attach", async () => {
  const { fhir, response, body, attachedInput } = await postRegistration({ dropRegistrationReply: true });
  assert.equal(response.status, 201);
  assert.equal((await fhir.read<Patient>("Patient", "patient-registered")).id, "patient-registered");
  assert.deepEqual(fhir.events, ["registration", "grant", "attach"]);
  assert.deepEqual((attachedInput as any).relatedPersonIds, ["related-1"]);
  assert.deepEqual(body.guarantorLinks, [{ relatedPersonId: "related-1", personId: "guarantor-existing", taskId: "attach-task", status: "linked", message: "Guarantor linked." }]);
});

test("B3: ambiguous committed-state recovery preserves registration without guessing an attach target", async () => {
  const adultRegistration = {
    ...registrationBody,
    demographics: { ...registrationBody.demographics, birthDate: "1980-04-03" },
    responsibleParties: [
      { ...existingParty, financialResponsible: false },
      {
        localId: "self", kind: "self", relationship: "other", financialResponsible: true,
        consentAuthority: false, primary: false, courtOrderNotes: "", effectiveDate: "2026-09-14", endDate: "",
        firstName: "Synthetic", middleName: "", lastName: "Child", phone: "864-555-0100",
        address: "1 Synthetic Way", city: "Greenville", state: "SC", postalCode: "29601",
      },
    ],
  };
  const { response, body, attachedInput } = await postRegistration({
    registrationBody: adultRegistration,
    dropRegistrationReply: true,
    duplicateRecoveredRelatedPerson: true,
  });
  assert.equal(response.status, 201);
  assert.equal(attachedInput, undefined);
  assert.equal(body.kind, "created");
  assert.equal(body.patient.id, "patient-registered");
  assert.equal(body.guarantorLinks, undefined);
});

test("A11: registration with an existing party requires guarantor.link before any write or MRN reservation", async () => {
  const { fhir, response } = await postRegistration({ businessActions: ["patients.register"] });
  assert.equal(response.status, 403);
  assert.equal(fhir.reservationWrites, 0);
  assert.equal(fhir.transaction, undefined);
  assert.deepEqual(fhir.events, []);
});

for (const [label, mutate] of [
  ["foreign", (person: Person) => ({ ...person, meta: { ...person.meta, project: "other-practice" } })],
  ["inactive", (person: Person) => ({ ...person, active: false })],
  ["unsupported-link", (person: Person) => ({ ...person, link: [{ target: { reference: "Patient/not-allowed" } }] })],
] as const) test(`A12: a ${label} existing Person is rejected before every write`, async () => {
  const { fhir, response } = await postRegistration({ mutatePerson: mutate });
  assert.equal(response.status, 422);
  assert.equal(fhir.reservationWrites, 0);
  assert.equal(fhir.transaction, undefined);
});

test("A13: a financially responsible existing Person without a complete address is rejected with the established message", async () => {
  const { fhir, response, body } = await postRegistration({ mutatePerson: person => ({ ...person, address: undefined }) });
  assert.equal(response.status, 400);
  assert.equal(body.error, "A guarantor mailing address is required.");
  assert.equal(fhir.reservationWrites, 0);
});

test("A15: an existing parent keeps consent authority, active period, and projected identity in the created RelatedPerson", async () => {
  const { fhir, response } = await postRegistration();
  assert.equal(response.status, 201);
  const related = fhir.transaction?.entry?.find(entry => entry.resource?.resourceType === "RelatedPerson")!.resource as RelatedPerson;
  assert.equal(related.active, true);
  assert.deepEqual(related.period, { start: "2026-09-14" });
  assert.equal(related.extension?.find(extension => extension.url === CONSENT_AUTHORITY_EXTENSION_URL)?.valueBoolean, true);
  assert.deepEqual({ name: related.name, telecom: related.telecom, address: related.address }, { name: fhir.person.name, telecom: fhir.person.telecom, address: fhir.person.address });
});
