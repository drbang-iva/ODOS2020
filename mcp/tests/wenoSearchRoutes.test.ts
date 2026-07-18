import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import express from "express";
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
