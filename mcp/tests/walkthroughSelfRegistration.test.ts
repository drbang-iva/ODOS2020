import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import test from "node:test";
import type { Account, Bundle, Patient, Resource } from "@medplum/fhirtypes";
import express from "express";
import { registerClinicRoutes } from "../src/clinic/clinic-routes.js";
import { buildAgeOfMajorityConfigResource } from "../src/clinic/age-of-majority-config.js";

const home = { address: "1 Synthetic Way", city: "Greenville", state: "SC", postalCode: "29601" };
const blank = { address: "", city: "", state: "", postalCode: "" };
const registration = {
  demographics: {
    firstName: "Synthetic", middleName: "", lastName: "Adult", preferredName: "",
    birthDate: "1980-01-02", gender: "female",
    phones: [{ value: "864-555-0100", use: "home" }, { value: "", use: "mobile" }],
    textable: "", email: "", ...home,
  },
  responsibleParties: [{
    localId: "self", kind: "self", relationship: "other", financialResponsible: true,
    consentAuthority: false, primary: false, courtOrderNotes: "", effectiveDate: "", endDate: "",
    firstName: "", middleName: "", lastName: "", phone: "", ...blank,
  }],
  confirmDuplicate: false,
};

class RegistrationFhir {
  readonly baseUrl = "http://synthetic.fhir.test";
  writes = 0;
  transaction?: Bundle;
  patient?: Patient;

  async search<T extends Resource>(): Promise<Bundle<T>> {
    return { resourceType: "Bundle", type: "searchset", entry: [] };
  }

  async searchProject<T extends Resource>(resourceType: T["resourceType"]): Promise<Bundle<T>> {
    if (resourceType === "Basic") return {
      resourceType: "Bundle", type: "searchset",
      entry: [{ resource: { ...buildAgeOfMajorityConfigResource({ ageOfMajorityYears: 18 }), meta: { project: "practice-1" } } as T }],
    };
    return { resourceType: "Bundle", type: "searchset", entry: [] };
  }

  async searchProjectUrl<T extends Resource>(): Promise<Bundle<T>> {
    return { resourceType: "Bundle", type: "searchset", entry: [] };
  }

  async create<T extends Resource>(resource: T): Promise<T> {
    assert.equal(resource.resourceType, "Account");
    this.writes++;
    return { ...resource, id: "reservation-1", meta: { ...resource.meta, versionId: "1" } } as T;
  }

  async executeTransactionAsActor(bundle: Bundle): Promise<Bundle> {
    this.writes++;
    this.transaction = structuredClone(bundle);
    this.patient = { ...(bundle.entry?.[0]?.resource as Patient), id: "patient-1", meta: { project: "practice-1", versionId: "1" } };
    return {
      resourceType: "Bundle", type: "transaction-response",
      entry: bundle.entry?.map(entry => ({ response: {
        status: entry.request?.method === "PUT" ? "200 OK" : "201 Created",
        location: entry.resource?.resourceType === "Patient" ? "Patient/patient-1/_history/1" : "Account/reservation-1/_history/2",
      } })),
    };
  }

  async read<T extends Resource>(resourceType: T["resourceType"]): Promise<T> {
    assert.equal(resourceType, "Patient");
    return structuredClone(this.patient) as T;
  }
}

async function post(body: unknown) {
  const fhir = new RegistrationFhir();
  const app = express();
  app.use(express.json());
  registerClinicRoutes(app, {
    authenticateService: async () => undefined,
    authenticate: async () => ({ staffReference: "Practitioner/synthetic", actorRole: "staff", roles: ["staff"],
      businessActions: ["patients.register"], project: { reference: "Project/practice-1" }, fhir: {} }),
    serviceFhir: fhir,
    now: () => "2026-09-25T12:00:00.000Z",
    grantRegistrationAccess: async () => undefined,
  } as never);
  const listener = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve, reject) => { listener.once("listening", resolve); listener.once("error", reject); });
  try {
    const { port } = listener.address() as AddressInfo;
    const response = await fetch(`http://127.0.0.1:${port}/clinic/patients`, {
      method: "POST", headers: { Authorization: "Bearer synthetic", "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return { fhir, status: response.status, body: await response.json() as { error?: string } };
  } finally {
    await new Promise<void>((resolve, reject) => listener.close(error => error ? reject(error) : resolve()));
  }
}

test("blank self-party mailing address uses the patient's home address", async () => {
  const result = await post(registration);
  assert.equal(result.status, 201);
  const patient = result.fhir.patient!;
  const account = result.fhir.transaction?.entry?.find(entry => entry.resource?.resourceType === "Account")?.resource as Account;
  assert.deepEqual(patient.address, [{ use: "home", line: [home.address], city: home.city, state: home.state, postalCode: home.postalCode }]);
  assert.equal(account.guarantor?.[0]?.party.reference, result.fhir.transaction?.entry?.[0]?.fullUrl);
});

test("self-pay registration without a home mailing address refuses before writes", async () => {
  const result = await post({ ...registration, demographics: { ...registration.demographics, ...blank } });
  assert.equal(result.status, 400);
  assert.equal(result.body.error, "A guarantor mailing address is required.");
  assert.equal(result.fhir.writes, 0);
});
