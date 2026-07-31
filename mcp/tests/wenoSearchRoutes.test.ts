import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import express from "express";
import type { MedicationRequest, Patient, Practitioner, Resource } from "@medplum/fhirtypes";
import {
  buildMedicationRequest,
  ODOS_TRANSMISSION_METHOD_EXTENSION_URL,
  WENO_MESSAGE_ID_IDENTIFIER_SYSTEM,
  type MedicationOrderPharmacy,
} from "../src/fhir/medicationOrder.js";
import { resetWenoSwitchProcessStateForTests } from "../src/integrations/weno/wenoSwitchNewRx.js";
import type { WenoDrugRow } from "../src/jobs/syncWenoDrugDatabase.js";
import type { PharmacyDirectoryRow, PharmacySearchInput } from "../src/jobs/syncWenoPharmacyDirectory.js";
import { registerWenoSearchRoutes, WENO_SEARCH_RESULT_LIMIT } from "../src/weno/weno-search-routes.js";

test("WENO search routes require staff authentication before querying storage", async () => {
  let drugCalls = 0;
  let pharmacyCalls = 0;
  const server = await startServer({
    authenticate: async () => null,
    drugs: { search: async () => { drugCalls += 1; return []; } },
    pharmacies: { search: async () => { pharmacyCalls += 1; return []; } },
  });
  try {
    assert.equal((await fetch(`${server.baseUrl}/weno/drugs/search?q=latanoprost`)).status, 401);
    assert.equal((await fetch(`${server.baseUrl}/weno/pharmacies/search?state=SC&zip=29646&searchType=local-retail&all=true`)).status, 401);
    assert.equal(drugCalls, 0);
    assert.equal(pharmacyCalls, 0);
  } finally {
    await server.close();
  }
});

test("WENO search routes surface required-query validation as 400 responses", async () => {
  const server = await startServer();
  try {
    const blankDrug = await fetch(`${server.baseUrl}/weno/drugs/search?q=%20`, auth());
    assert.equal(blankDrug.status, 400);
    assert.deepEqual(await blankDrug.json(), { error: "Drug search requires a non-blank query." });

    const missingState = await fetch(
      `${server.baseUrl}/weno/pharmacies/search?city=Greenwood&searchType=local-retail&all=true`,
      auth(),
    );
    assert.equal(missingState.status, 400);
    assert.deepEqual(await missingState.json(), { error: "Pharmacy search requires a state." });
  } finally {
    await server.close();
  }
});

test("WENO search routes return capped, client-shaped results and preserve Directory order", async () => {
  let pharmacyInput: PharmacySearchInput | undefined;
  const drugs = Array.from({ length: WENO_SEARCH_RESULT_LIMIT + 4 }, (_, index) => drug(index));
  const pharmacies = Array.from({ length: WENO_SEARCH_RESULT_LIMIT + 4 }, (_, index) => pharmacy(index));
  const server = await startServer({
    drugs: { search: async (query) => { assert.equal(query, "lata"); return drugs; } },
    pharmacies: { search: async (input) => { pharmacyInput = input; return pharmacies; } },
  });
  try {
    const drugResponse = await fetch(`${server.baseUrl}/weno/drugs/search?q=lata`, auth());
    assert.equal(drugResponse.status, 200);
    const drugBody = await drugResponse.json() as { results: Array<Record<string, unknown>> };
    assert.equal(drugBody.results.length, WENO_SEARCH_RESULT_LIMIT);
    assert.deepEqual(Object.keys(drugBody.results[0] ?? {}), [
      "drugDbCode",
      "drugDbCodeQualifier",
      "quantityUnitOfMeasureCode",
      "psnDescription",
      "route",
      "strength",
    ]);

    const pharmacyResponse = await fetch(
      `${server.baseUrl}/weno/pharmacies/search?state=SC&zip=29646&searchType=local-retail&all=true`,
      auth(),
    );
    assert.equal(pharmacyResponse.status, 200);
    const pharmacyBody = await pharmacyResponse.json() as { results: Array<Record<string, unknown>> };
    assert.equal(pharmacyBody.results.length, WENO_SEARCH_RESULT_LIMIT);
    assert.equal(pharmacyBody.results[0]?.businessName, "Pharmacy 0");
    assert.equal(pharmacyBody.results[24]?.businessName, "Pharmacy 24");
    assert.deepEqual(pharmacyInput, {
      state: "SC",
      zip: "29646",
      city: undefined,
      county: undefined,
      searchType: "local-retail",
      onWeno: undefined,
      name: undefined,
      street: undefined,
      open24hr: undefined,
      all: true,
      includeTestPharmacies: undefined,
    });
  } finally {
    await server.close();
  }
});

test("WENO send rejects a hostile controlled-substance record server-side", async () => {
  const fixture = sendFixture({
    medicationRequest: medicationRequest({
      isControlledSubstance: true,
      transmissionMethod: "electronically-sent",
    }),
  });
  let sendCalls = 0;
  const server = await startSendServer(fixture, async () => {
    sendCalls += 1;
    return { kind: "status", code: "001", description: "Accepted" };
  });
  try {
    const response = await fetch(`${server.baseUrl}/weno/medication-requests/rx-1/send`, {
      ...auth(),
      method: "POST",
    });
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), {
      error: "Controlled substances cannot be transmitted electronically through this WENO send path.",
    });
    assert.equal(sendCalls, 0);
    assert.equal(transmissionMethod(fixture.medicationRequest), "electronically-sent");
  } finally {
    await server.close();
  }
});

test("WENO send refuses free-text drug and pharmacy distinctly while preserving printable orders", async () => {
  const freeTextDrug = sendFixture({
    medicationRequest: medicationRequest({ codedDrug: false }),
  });
  const drugServer = await startSendServer(freeTextDrug, async () => {
    throw new Error("send must not run");
  });
  try {
    const response = await fetch(`${drugServer.baseUrl}/weno/medication-requests/rx-1/send`, {
      ...auth(),
      method: "POST",
    });
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), {
      error: "A free-text drug cannot be sent electronically. Select a coded WENO formulary drug, then save the prescription again.",
    });
    assert.equal(transmissionMethod(freeTextDrug.medicationRequest), "printed");
  } finally {
    await drugServer.close();
  }

  const freeTextPharmacy = sendFixture({
    medicationRequest: medicationRequest({ structuredPharmacy: false }),
  });
  const pharmacyServer = await startSendServer(freeTextPharmacy, async () => {
    throw new Error("send must not run");
  });
  try {
    const response = await fetch(`${pharmacyServer.baseUrl}/weno/medication-requests/rx-1/send`, {
      ...auth(),
      method: "POST",
    });
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), {
      error: "A free-text pharmacy cannot be sent electronically. Select a coded WENO Directory pharmacy, then save the prescription again.",
    });
    assert.equal(transmissionMethod(freeTextPharmacy.medicationRequest), "printed");
  } finally {
    await pharmacyServer.close();
  }
});

test("WENO error persistence leaves transmission unchanged and status alone marks sent", async () => {
  const fixture = sendFixture();
  const results = [
    {
      kind: "error" as const,
      code: "900",
      descriptionCode: "P001",
      description: "Synthetic certification failure",
    },
    {
      kind: "status" as const,
      code: "001",
      description: "Accepted",
    },
  ];
  const server = await startSendServer(fixture, async () => results.shift()!);
  try {
    const errorResponse = await fetch(`${server.baseUrl}/weno/medication-requests/rx-1/send`, {
      ...auth(),
      method: "POST",
    });
    assert.equal(errorResponse.status, 200);
    const errorBody = await errorResponse.json() as {
      resendable: boolean;
      medicationRequest: MedicationRequest;
    };
    assert.equal(errorBody.resendable, true);
    assert.equal(transmissionMethod(errorBody.medicationRequest), "printed");
    assert.equal(wenoMessageId(errorBody.medicationRequest), undefined);
    assert.match(
      errorBody.medicationRequest.note?.at(-1)?.text ?? "",
      /WENO Switch error 900\/P001: Synthetic certification failure/,
    );

    const statusResponse = await fetch(`${server.baseUrl}/weno/medication-requests/rx-1/send`, {
      ...auth(),
      method: "POST",
    });
    assert.equal(statusResponse.status, 200);
    const statusBody = await statusResponse.json() as {
      resendable: boolean;
      medicationRequest: MedicationRequest;
    };
    assert.equal(statusBody.resendable, false);
    assert.equal(transmissionMethod(statusBody.medicationRequest), "electronically-sent");
    assert.equal(wenoMessageId(statusBody.medicationRequest), "test-message-id");
  } finally {
    await server.close();
  }
});

test("WENO durable identifier refuses a second send after simulated process restart", async () => {
  const fixture = sendFixture();
  let sendCalls = 0;
  const server = await startSendServer(fixture, async () => {
    sendCalls += 1;
    return { kind: "status", code: "001", description: "Accepted" };
  });
  try {
    const first = await fetch(`${server.baseUrl}/weno/medication-requests/rx-1/send`, {
      ...auth(),
      method: "POST",
    });
    assert.equal(first.status, 200);
    resetWenoSwitchProcessStateForTests();
    const second = await fetch(`${server.baseUrl}/weno/medication-requests/rx-1/send`, {
      ...auth(),
      method: "POST",
    });
    assert.equal(second.status, 409);
    assert.deepEqual(await second.json(), {
      error: "This prescription already has a WENO message id and will not be sent again.",
    });
    assert.equal(sendCalls, 1);
  } finally {
    await server.close();
  }
});

function auth(): RequestInit {
  return { headers: { Authorization: "Bearer good" } };
}

async function startServer(overrides: Partial<Parameters<typeof registerWenoSearchRoutes>[1]> = {}) {
  const app = express();
  registerWenoSearchRoutes(app, {
    authenticateService: async () => undefined,
    authenticate: async (header) => header === "Bearer good"
      ? { staffReference: "Practitioner/staff-1", actorRole: "clinician", fhir: {} as never }
      : null,
    drugs: { search: async () => [] },
    pharmacies: { search: async () => [] },
    switchConfig: {},
    recordAudit: async () => undefined,
    ...overrides,
  });
  const listener = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve, reject) => {
    listener.once("listening", resolve);
    listener.once("error", reject);
  });
  const { port } = listener.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve, reject) => listener.close((error) => error ? reject(error) : resolve())),
  };
}

async function startSendServer(
  fixture: ReturnType<typeof sendFixture>,
  sendNewRx: NonNullable<Parameters<typeof registerWenoSearchRoutes>[1]["sendNewRx"]>,
) {
  const resources = new Map<string, Resource>([
    ["MedicationRequest/rx-1", fixture.medicationRequest],
    ["Patient/patient-1", fixture.patient],
    ["Practitioner/prescriber-1", fixture.prescriber],
  ]);
  const fhir = {
    async read<T extends Resource>(resourceType: T["resourceType"], id: string): Promise<T> {
      const resource = resources.get(`${resourceType}/${id}`);
      if (!resource) throw new Error(`${resourceType}/${id} not found`);
      return structuredClone(resource) as T;
    },
    async update<T extends Resource>(
      resourceType: T["resourceType"],
      id: string,
      resource: T,
      headers?: Record<string, string>,
    ): Promise<T> {
      const current = resources.get(`${resourceType}/${id}`);
      if (!current) throw new Error(`${resourceType}/${id} not found`);
      const expected = current.meta?.versionId
        ? `W/"${current.meta.versionId}"`
        : undefined;
      if (expected && headers?.["If-Match"] !== expected) {
        const error = new Error("stale") as Error & { status: number };
        error.status = 412;
        throw error;
      }
      const next = {
        ...structuredClone(resource),
        meta: {
          ...(resource.meta ?? {}),
          versionId: String(Number(current.meta?.versionId ?? "0") + 1),
        },
      } as T;
      resources.set(`${resourceType}/${id}`, next);
      fixture.medicationRequest = next as MedicationRequest;
      return structuredClone(next);
    },
  };
  return startServer({
    authenticate: async (header) => header === "Bearer good"
      ? {
          staffReference: "Practitioner/staff-1",
          actorRole: "clinician",
          fhir: fhir as never,
        }
      : null,
    switchConfig: {
      partnerId: "partner",
      partnerPasswordMd5: "md5",
      routingId: "route",
      senderSoftwareDeveloper: "ODOS",
      senderSoftwareVersion: "test",
      endpoint: "https://cert.example.test",
    },
    createMessageId: () => "test-message-id",
    now: () => "2026-07-31T12:00:00.000Z",
    sendNewRx,
  });
}

function sendFixture(overrides: { medicationRequest?: MedicationRequest } = {}) {
  const patient: Patient = {
    resourceType: "Patient",
    id: "patient-1",
    name: [{ family: "Patient", given: ["Synthetic"] }],
    gender: "female",
    birthDate: "1990-01-01",
    address: [{
      line: ["1 Test Way"],
      city: "Greenwood",
      state: "SC",
      postalCode: "29646",
      country: "US",
    }],
    telecom: [{ system: "phone", value: "8645550100" }],
  };
  const prescriber: Practitioner = {
    resourceType: "Practitioner",
    id: "prescriber-1",
    identifier: [{ system: "http://hl7.org/fhir/sid/us-npi", value: "1234567893" }],
    name: [{ family: "Doctor", given: ["Synthetic"] }],
    address: [{
      line: ["2 Test Way"],
      city: "Greenwood",
      state: "SC",
      postalCode: "29646",
      country: "US",
    }],
    telecom: [{ system: "phone", value: "8645550101" }],
  };
  return {
    patient,
    prescriber,
    medicationRequest: overrides.medicationRequest ?? medicationRequest(),
  };
}

function medicationRequest(options: {
  codedDrug?: boolean;
  structuredPharmacy?: boolean;
  isControlledSubstance?: boolean;
  transmissionMethod?: "printed" | "electronically-sent";
} = {}): MedicationRequest {
  const structuredPharmacy = options.structuredPharmacy !== false;
  return {
    ...buildMedicationRequest({
      patientReference: "Patient/patient-1",
      practitionerReference: "Practitioner/prescriber-1",
      medicationText: "Synthetic latanoprost",
      ...(options.codedDrug === false
        ? {}
        : {
            drugDbCode: "196502",
            drugDbCodeQualifier: "SCD",
            quantityUnitOfMeasureCode: "C48542",
          }),
      dosageText: "Instill one drop nightly.",
      quantity: "2.5 mL",
      refills: 1,
      daysSupply: 30,
      ...(structuredPharmacy
        ? { pharmacy: TEST_PHARMACY }
        : { pharmacyText: "Free Text Pharmacy" }),
      isControlledSubstance: options.isControlledSubstance ?? false,
      transmissionMethod: options.transmissionMethod ?? "printed",
      authoredOn: "2026-07-31T11:00:00.000Z",
    }),
    id: "rx-1",
    meta: { versionId: "1" },
  };
}

function transmissionMethod(request: MedicationRequest): string | undefined {
  return request.extension?.find(
    (extension) => extension.url === ODOS_TRANSMISSION_METHOD_EXTENSION_URL,
  )?.valueCode;
}

function wenoMessageId(request: MedicationRequest): string | undefined {
  return request.identifier?.find(
    (identifier) => identifier.system === WENO_MESSAGE_ID_IDENTIFIER_SYSTEM,
  )?.value;
}

const TEST_PHARMACY: MedicationOrderPharmacy = {
  ncpdpId: "4222222",
  npi: "1234567893",
  name: "Greenwood Pharmacy",
  addressLine1: "123 Main Street",
  city: "Greenwood",
  state: "SC",
  postalCode: "29646",
  phone: "8645550102",
};

function drug(index: number): WenoDrugRow {
  return {
    drugDbCode: `100${index}`,
    drugDbCodeQualifier: "SCD",
    quantityUnitOfMeasureCode: "C48542",
    quantityUnitOfMeasureDisplay: "mL",
    deaScheduleCode: "C38046",
    psnDescription: `Latanoprost ${index}`,
    nameSource: "psn",
    route: "OPHTHALMIC",
    strength: "0.005%",
  };
}

function pharmacy(index: number): PharmacyDirectoryRow {
  return {
    ncpdpId: `40000${index}`,
    mutuallyDefinedId: "",
    npi: "",
    businessName: `Pharmacy ${index}`,
    addressLine1: `${index} Main Street`,
    addressLine2: "",
    city: "Greenwood",
    state: "SC",
    zip: "29646",
    countryCode: "US",
    international: false,
    phone: "8645550100",
    testPharmacy: false,
    stateWideMailOrder: false,
    mailOrderStatesServiced: { type: "list", codes: [] },
    mailOrderTerritoriesServiced: { type: "list", codes: [] },
    onWeno: index % 2 === 0,
    open24Hours: "no",
  };
}
