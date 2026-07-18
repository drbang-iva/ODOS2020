import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import type { Basic, Bundle, MedicationRequest } from "@medplum/fhirtypes";
import { zipSync } from "fflate";
import { Client } from "pg";
import { ODOS_CONTROLLED_SUBSTANCE_FLAG_EXTENSION_URL } from "../src/fhir/medicationOrder.js";
import {
  buildWenoMappingResource,
  FhirWenoMappingCatalog,
  parseWenoMappingResource,
  WENO_MAPPING_IDENTIFIER_SYSTEM,
  WENO_MAPPING_SEEDS,
  type WenoMappingRow,
} from "../src/fhir/wenoMappingCatalog.js";
import {
  isWenoConfigured,
  type WenoEzIntegrationConfig,
  wenoEzIntegrationConfigFromEnv,
} from "../src/integrations/weno/config.js";
import { decryptWenoPayload, encryptWenoPayload } from "../src/integrations/weno/wenoCrypto.js";
import {
  downloadPharmacyDirectory,
  getComposeRxIframeUrl,
  getRxLogIframeUrl,
  pullNewRxSyncReport,
  type ComposeRxIframeRequest,
  type PharmacyDirectoryRequest,
} from "../src/integrations/weno/wenoEzIntegrationClient.js";
import {
  PostgresWenoPharmacyDirectoryStorage,
  pharmacyDirectoryStorageMode,
  parsePharmacyDirectoryZip,
  searchPharmacies,
  syncWenoPharmacyDirectory,
  type PharmacyDirectoryRow,
} from "../src/jobs/syncWenoPharmacyDirectory.js";
import {
  buildWenoMedicationRequest,
  parseNewRxSyncReport,
  syncWenoRxActivity,
} from "../src/jobs/syncWenoRxActivity.js";

const CONFIG: Required<WenoEzIntegrationConfig> = {
  encryptionKey: "secret-test-key",
  baseUrl: "https://online.wenoexchange.com",
  syncAdminEmail: "admin@example.com",
  syncAdminPasswordRef: "secret/WENO_SYNC_ADMIN",
};

const REAL_SAMPLE_PAYLOAD: ComposeRxIframeRequest = {
  UserEmail: "xyz@example.com",
  MD5Password: "ExamplePassWord",
  LocationID: "L0000",
  TestPatient: "N",
  PatientType: "Human",
  OrgPatientID: "12537",
  LastName: "Satterfield",
  FirstName: "Ryan",
  MiddleName: "J",
  Prefix: "Mr",
  Suffix: "MS",
  Gender: "F",
  DateOfBirth: "1994-06-18",
  AddressLine1: "224",
  AddressLine2: "Richmond Ranch Rd",
  City: "Texarkana",
  State: "TX",
  PostalCode: "75503",
  CountryCode: "US",
  PrimaryPhone: "8776543210",
  SupportsSMS: "Y",
  PatientEmail: "qa.patient@yopmail.com",
  ResponsiblePartySameAsPatient: "N",
  ResponsiblePartyLastName: "Lname",
  ResponsiblePartyFirstName: "Fname",
  ResponsiblePartyAddressLine1: "Test1",
  ResponsiblePartyAddressLine2: "Test2",
  ResponsiblePartyCity: "TCity",
  ResponsiblePartyState: "AL",
  ResponsiblePartyPostalCode: "12345",
  ResponsiblePartyCountryCode: "US",
  ResponsiblePartyPrimaryPhone: "8775642310",
  PatientLocation: "Facility",
  FacilityName: "Fname",
  FacilityAddressLine1: "1stAddress",
  FacilityAddressLine2: "2ndAddress",
  FacilityCity: "Fcity",
  FacilityState: "AL",
  FacilityPostalCode: "89561",
  FacilityCountryCode: "US",
  FacilityPrimaryPhone: "8774512036",
  FacilityEmail: "femail@yopmail.com",
  FacilityFax: "1212121212",
  PrimaryPharmacyNCPCP: "1234567",
  AlternativePharmacyNCPCP: "1234567",
};

test("WENO config is all-or-nothing across install-level fields", () => {
  assert.equal(isWenoConfigured(CONFIG), true);
  for (const field of Object.keys(CONFIG) as Array<keyof WenoEzIntegrationConfig>) {
    assert.equal(isWenoConfigured({ ...CONFIG, [field]: undefined }), false, field);
    assert.equal(isWenoConfigured({ ...CONFIG, [field]: " " }), false, `${field} blank`);
  }
  assert.equal(isWenoConfigured({}), false);
});

test("WENO config reads admin secret references without storing the password", () => {
  assert.deepEqual(wenoEzIntegrationConfigFromEnv({
    WENO_EZ_ENCRYPTION_KEY: "secret-test-key",
    WENO_EZ_BASE_URL: "https://online.wenoexchange.com",
    WENO_EZ_SYNC_ADMIN_EMAIL: "admin@example.com",
    WENO_EZ_SYNC_ADMIN_PASSWORD_REF: "secret/WENO_SYNC_ADMIN",
  }), CONFIG);
});

test("WENO crypto round-trips the real ComposeRx sample payload", () => {
  const encrypted = encryptWenoPayload(REAL_SAMPLE_PAYLOAD, CONFIG.encryptionKey);
  assert.notEqual(encrypted, JSON.stringify(REAL_SAMPLE_PAYLOAD));
  assert.deepEqual(decryptWenoPayload(encrypted, CONFIG.encryptionKey), REAL_SAMPLE_PAYLOAD);
});

test("ComposeRx URL is synchronous, exact, URL-safe, and preserves the real request shape", () => {
  const url: string = getComposeRxIframeUrl(CONFIG, {
    ...REAL_SAMPLE_PAYLOAD,
    Allergy: "",
    PatientDrugAllergyRxCUI: [],
  });
  assert.equal(typeof url, "string");
  assert.match(url, /^https:\/\/online\.wenoexchange\.com\/en\/NewRx\/ComposeRx\?/);
  assert.match(url, /[?&]useremail=xyz%40example\.com(?:&|$)/);
  assert.match(url, /[?&]data=[^&]+/);
  const rawData = url.match(/[?&]data=([^&]+)/)?.[1] ?? "";
  assert.doesNotMatch(rawData, /[+/=]/);
  const decoded = decryptWenoPayload(decodeURIComponent(rawData), CONFIG.encryptionKey);
  assert.deepEqual(decoded, REAL_SAMPLE_PAYLOAD);
});

test("RxLog URL is synchronous and carries only per-prescriber credentials", () => {
  const url: string = getRxLogIframeUrl(CONFIG, {
    UserEmail: "prescriber@example.com",
    MD5Password: "md5-or-plain",
  });
  assert.equal(typeof url, "string");
  assert.match(url, /^https:\/\/online\.wenoexchange\.com\/en\/EPCS\/RxLog\?/);
  const encrypted = decodeURIComponent(url.match(/[?&]data=([^&]+)/)?.[1] ?? "");
  assert.deepEqual(decryptWenoPayload(encrypted, CONFIG.encryptionKey), {
    UserEmail: "prescriber@example.com",
    MD5Password: "md5-or-plain",
  });
});

test("NewRx Sync Report defaults to CSV and returns the raw body", async () => {
  const originalFetch = globalThis.fetch;
  let requestedUrl = "";
  globalThis.fetch = (async (input: string | URL | Request) => {
    requestedUrl = String(input);
    return new Response("PatientID,RelatestoNewRxMsgID\n12537,msg-1", { status: 200 });
  }) as typeof fetch;
  try {
    const body = await pullNewRxSyncReport(CONFIG, syncRequest());
    assert.equal(body, "PatientID,RelatestoNewRxMsgID\n12537,msg-1");
    const encrypted = decodeURIComponent(requestedUrl.match(/[?&]data=([^&]+)/)?.[1] ?? "");
    assert.deepEqual(decryptWenoPayload(encrypted, CONFIG.encryptionKey), {
      ...syncRequest(),
      ResponseFormat: "CSV",
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("NewRx Sync Report rejects date spans over seven days before HTTP", async () => {
  await assert.rejects(
    pullNewRxSyncReport(CONFIG, { ...syncRequest(), ToDate: "2026-07-09" }),
    /cannot exceed 7 days/,
  );
});

test("NewRx Sync Report surfaces HTTP failures without response-body secrets", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response("vendor detail", { status: 503 })) as typeof fetch;
  try {
    await assert.rejects(pullNewRxSyncReport(CONFIG, syncRequest()), /HTTP 503/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("pharmacy directory download builds the encrypted URL and returns raw ZIP bytes", async () => {
  const originalFetch = globalThis.fetch;
  const expected = Uint8Array.from([0x50, 0x4b, 0x03, 0x04]);
  let requestedUrl = "";
  let requestedSignal: AbortSignal | null | undefined;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    requestedUrl = String(input);
    requestedSignal = init?.signal;
    return new Response(expected, { status: 200 });
  }) as typeof fetch;
  try {
    const request = pharmacyDirectoryRequest();
    const bytes = await downloadPharmacyDirectory(CONFIG, request);
    assert.deepEqual(new Uint8Array(bytes), expected);
    assert.equal(requestedSignal instanceof AbortSignal, true);
    assert.match(
      requestedUrl,
      /^https:\/\/online\.wenoexchange\.com\/en\/EPCS\/DownloadPharmacyDirectory\?/,
    );
    assert.match(requestedUrl, /[?&]useremail=admin%40example\.com(?:&|$)/);
    const encrypted = decodeURIComponent(requestedUrl.match(/[?&]data=([^&]+)/)?.[1] ?? "");
    assert.deepEqual(decryptWenoPayload(encrypted, CONFIG.encryptionKey), request);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("pharmacy directory download surfaces HTTP failures", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response("vendor detail", { status: 502 })) as typeof fetch;
  try {
    await assert.rejects(
      downloadPharmacyDirectory(CONFIG, pharmacyDirectoryRequest()),
      /WENO Pharmacy Directory request failed with HTTP 502/,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("pharmacy directory download reports a clear timeout error", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    throw new DOMException("This operation was aborted", "AbortError");
  }) as typeof fetch;
  try {
    await assert.rejects(
      downloadPharmacyDirectory(CONFIG, pharmacyDirectoryRequest()),
      /WENO Pharmacy Directory request timed out after 30 seconds/,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("pharmacy directory parser finds the LITE CSV by row-2 headers and preserves safe IDs", () => {
  const row = syntheticPharmacy({
    NCPDP_safe: "[0234567]",
    ZipCode_safe: "[00701]",
    Pharmacy_Phone_safe: "[0123456789]",
    Mail_Order_US_State_Serviced: "TX|OK",
    "Mail_Order_ US_Territories_Serviced": "All",
    "24HR": "Y",
  });
  const bytes = syntheticDirectoryZip([row], { extraLiteColumn: true, includeFull: true });

  const parsed = parsePharmacyDirectoryZip(bytes);
  const withoutTrailingColumn = parsePharmacyDirectoryZip(syntheticDirectoryZip([row]));

  assert.equal(parsed.malformedRows, 0);
  assert.equal(parsed.deduplicatedRows, 0);
  assert.equal(parsed.rows.length, 1);
  assert.deepEqual(parsed, withoutTrailingColumn);
  assert.equal(parsed.rows[0].ncpdpId, "0234567");
  assert.equal(parsed.rows[0].npi, "0123456789");
  assert.equal(parsed.rows[0].zip, "00701");
  assert.equal(parsed.rows[0].phone, "0123456789");
  assert.equal(parsed.rows[0].businessName, "Synthetic Community Pharmacy");
  assert.deepEqual(parsed.rows[0].mailOrderStatesServiced, { type: "list", codes: ["TX", "OK"] });
  assert.deepEqual(parsed.rows[0].mailOrderTerritoriesServiced, { type: "all" });
  assert.equal(parsed.rows[0].open24Hours, "yes");
});

test("pharmacy directory parser maps the LITE schema by header name instead of position", () => {
  const row = syntheticPharmacy({ NCPDP_safe: "[0765432]", Business_Name: "Reordered Pharmacy" });
  const reversedHeaders = [...SYNTHETIC_LITE_HEADERS].reverse();
  const bytes = zipToArrayBuffer(zipSync({
    "unexpected-name.csv": new TextEncoder().encode(csvFixture(reversedHeaders, [row])),
  }));

  const parsed = parsePharmacyDirectoryZip(bytes);

  assert.equal(parsed.rows[0].ncpdpId, "0765432");
  assert.equal(parsed.rows[0].businessName, "Reordered Pharmacy");
});

test("pharmacy directory parser counts malformed rows and retains deleted tombstones", () => {
  const bytes = syntheticDirectoryZip([
    syntheticPharmacy({ NCPDP_safe: "[1000001]", Deleted: "2026-07-17T01:02:03Z" }),
    syntheticPharmacy({ NCPDP_safe: "[1000002]", On_WENO: "sometimes" }),
  ]);

  const parsed = parsePharmacyDirectoryZip(bytes);

  assert.equal(parsed.malformedRows, 1);
  assert.equal(parsed.rows.length, 1);
  assert.equal(parsed.rows[0].deleted, "2026-07-17T01:02:03.000Z");
});

test("pharmacy directory parser reads WENO US dates as explicit UTC instants", () => {
  const bytes = syntheticDirectoryZip([
    syntheticPharmacy({
      NCPDP_safe: "[1000101]",
      Created: "2/26/2018",
      Modified: "2/26/2018 1:23:45 PM",
    }),
  ]);

  const parsed = parsePharmacyDirectoryZip(bytes);

  assert.equal(parsed.malformedRows, 0);
  assert.equal(parsed.rows[0].created, "2018-02-26T00:00:00.000Z");
  assert.equal(parsed.rows[0].modified, "2018-02-26T13:23:45.000Z");
});

test("pharmacy directory parser keeps bad metadata dates but rejects an unreadable tombstone", () => {
  const bytes = syntheticDirectoryZip([
    syntheticPharmacy({
      NCPDP_safe: "[1000102]",
      Created: "not-a-date",
      Modified: "also-not-a-date",
    }),
    syntheticPharmacy({ NCPDP_safe: "[1000103]", Deleted: "not-a-date" }),
  ]);

  const parsed = parsePharmacyDirectoryZip(bytes);

  assert.equal(parsed.malformedRows, 1);
  assert.equal(parsed.rows.length, 1);
  assert.equal(parsed.rows[0].ncpdpId, "1000102");
  assert.equal(parsed.rows[0].created, undefined);
  assert.equal(parsed.rows[0].modified, undefined);
});

test("pharmacy directory parser strictly maps the Local and State service models", () => {
  const bytes = syntheticDirectoryZip([
    syntheticPharmacy({ NCPDP_safe: "[1000106]", State_Wide_Mail_Order: " local " }),
    syntheticPharmacy({ NCPDP_safe: "[1000107]", State_Wide_Mail_Order: "STATE" }),
    syntheticPharmacy({ NCPDP_safe: "[1000108]", State_Wide_Mail_Order: "National" }),
  ]);

  const parsed = parsePharmacyDirectoryZip(bytes);

  assert.equal(parsed.malformedRows, 1);
  assert.equal(parsed.rows.length, 2);
  assert.equal(parsed.rows[0].stateWideMailOrder, false);
  assert.equal(parsed.rows[1].stateWideMailOrder, true);
});

test("pharmacy directory parser maps real and documented 24HR encodings", () => {
  const bytes = syntheticDirectoryZip([
    syntheticPharmacy({ NCPDP_safe: "[1000109]", "24HR": " yes " }),
    syntheticPharmacy({ NCPDP_safe: "[1000110]", "24HR": "NO" }),
    syntheticPharmacy({ NCPDP_safe: "[1000111]", "24HR": "" }),
    syntheticPharmacy({ NCPDP_safe: "[1000112]", "24HR": "Y" }),
    syntheticPharmacy({ NCPDP_safe: "[1000113]", "24HR": "n" }),
    syntheticPharmacy({ NCPDP_safe: "[1000114]", "24HR": "Unknown" }),
    syntheticPharmacy({ NCPDP_safe: "[1000115]", "24HR": "Sometimes" }),
  ]);

  const parsed = parsePharmacyDirectoryZip(bytes);

  assert.equal(parsed.malformedRows, 1);
  assert.deepEqual(parsed.rows.map((row) => row.open24Hours), [
    "yes",
    "no",
    "unknown",
    "yes",
    "no",
    "unknown",
  ]);
});

test("pharmacy directory parser accepts both territories header spellings", () => {
  const fixedHeaders = SYNTHETIC_LITE_HEADERS.map((header) =>
    header === "Mail_Order_ US_Territories_Serviced"
      ? "Mail_Order_US_Territories_Serviced"
      : header
  );
  const row = {
    ...syntheticPharmacy(),
    Mail_Order_US_Territories_Serviced: "All",
  };
  const bytes = zipToArrayBuffer(zipSync({
    "fixed-header.csv": new TextEncoder().encode(csvFixture(fixedHeaders, [row])),
  }));

  const parsed = parsePharmacyDirectoryZip(bytes);

  assert.equal(parsed.malformedRows, 0);
  assert.deepEqual(parsed.rows[0].mailOrderTerritoriesServiced, { type: "all" });
});

test("pharmacy directory parser deduplicates routing keys with the last file occurrence winning", () => {
  const bytes = syntheticDirectoryZip([
    syntheticPharmacy({ NCPDP_safe: "[1000104]", Business_Name: "Earlier Pharmacy" }),
    syntheticPharmacy({ NCPDP_safe: "[1000104]", Business_Name: "Later Pharmacy" }),
  ]);

  const parsed = parsePharmacyDirectoryZip(bytes);

  assert.equal(parsed.malformedRows, 0);
  assert.equal(parsed.deduplicatedRows, 1);
  assert.equal(parsed.rows.length, 1);
  assert.equal(parsed.rows[0].businessName, "Later Pharmacy");
});

test("pharmacy directory parser rejects an archive without a recognizable LITE row-2 header", () => {
  const bytes = zipToArrayBuffer(zipSync({
    "directory.csv": new TextEncoder().encode("Confidential synthetic fixture\nNot,A,LITE,Header\n"),
  }));
  assert.throws(() => parsePharmacyDirectoryZip(bytes), /no recognizable LITE CSV header on row 2/);
});

test("pharmacy directory cadence selects incremental and full-replace storage modes", () => {
  assert.equal(pharmacyDirectoryStorageMode("Y"), "incremental");
  assert.equal(pharmacyDirectoryStorageMode("N"), "replace");
});

test("pharmacy directory sync downloads, reports malformed rows, and stores parsed rows", async () => {
  const originalFetch = globalThis.fetch;
  const bytes = syntheticDirectoryZip([
    syntheticPharmacy({ NCPDP_safe: "[1000001]" }),
    syntheticPharmacy({ NCPDP_safe: "[1000002]", Test_Pharmacy: "not-a-boolean" }),
  ]);
  let fetchCalls = 0;
  let storageCalls = 0;
  let storedRows: PharmacyDirectoryRow[] = [];
  let storedMode = "";
  globalThis.fetch = (async () => {
    fetchCalls += 1;
    return new Response(bytes, { status: 200 });
  }) as typeof fetch;
  try {
    const result = await syncWenoPharmacyDirectory({
      trigger: "scheduled-daily",
      config: CONFIG,
      request: pharmacyDirectoryRequest(),
      storage: {
        async store(rows, mode) {
          storageCalls += 1;
          storedRows = rows;
          storedMode = mode;
          return rows.length;
        },
      },
    });
    assert.equal(fetchCalls, 1);
    assert.equal(storageCalls, 1);
    assert.equal(storedRows.length, 1);
    assert.equal(storedMode, "incremental");
    assert.deepEqual(result, {
      trigger: "scheduled-daily",
      fetchedBytes: bytes.byteLength,
      parsed: 1,
      stored: 1,
      malformedRows: 1,
      deduplicatedRows: 0,
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("pharmacy directory sync stores one last-occurrence row in both incremental and replace modes", async () => {
  const originalFetch = globalThis.fetch;
  const bytes = syntheticDirectoryZip([
    syntheticPharmacy({ NCPDP_safe: "[1000105]", Business_Name: "Earlier Pharmacy" }),
    syntheticPharmacy({ NCPDP_safe: "[1000105]", Business_Name: "Later Pharmacy" }),
  ]);
  globalThis.fetch = (async () => new Response(bytes, { status: 200 })) as typeof fetch;
  try {
    for (const [daily, expectedMode] of [["Y", "incremental"], ["N", "replace"]] as const) {
      let storedRows: PharmacyDirectoryRow[] = [];
      let storedMode = "";
      const result = await syncWenoPharmacyDirectory({
        trigger: "manual",
        config: CONFIG,
        request: { ...pharmacyDirectoryRequest(), Daily: daily },
        storage: {
          async store(rows, mode) {
            storedRows = rows;
            storedMode = mode;
            return rows.length;
          },
        },
      });

      assert.equal(storedMode, expectedMode);
      assert.equal(storedRows.length, 1);
      assert.equal(storedRows[0].businessName, "Later Pharmacy");
      assert.equal(result.stored, 1);
      assert.equal(result.deduplicatedRows, 1);
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("pharmacy search enforces place, state, type, and an explicit additional filter", () => {
  const rows = searchFixtureRows();
  assert.throws(
    () => searchPharmacies(rows, { city: "Austin", searchType: "local-retail", all: true }),
    /requires a state/,
  );
  assert.throws(
    () => searchPharmacies(rows, { state: "TX", searchType: "local-retail", all: true }),
    /requires a place/,
  );
  assert.throws(
    () => searchPharmacies(rows, { city: "Austin", state: "TX", all: true }),
    /requires a search type/,
  );
  assert.throws(
    () => searchPharmacies(rows, { city: "Austin", state: "TX", searchType: "local-retail" }),
    /requires onWeno.*explicit all/,
  );
  assert.throws(
    () => searchPharmacies(rows, {
      city: "Austin",
      state: "TX",
      searchType: "local-retail",
      name: "ab",
    }),
    /name must be at least 3 characters/,
  );
});

test("pharmacy search applies On-WENO, name, street, and 24-hour filters", () => {
  const rows = searchFixtureRows();
  const base = { city: "Austin", state: "TX", searchType: "local-retail" as const };

  assert.deepEqual(
    searchPharmacies(rows, { ...base, onWeno: true }).map((row) => row.businessName),
    ["Preferred Pharmacy"],
  );
  assert.deepEqual(
    searchPharmacies(rows, { ...base, name: "community" }).map((row) => row.businessName),
    ["Community Pharmacy"],
  );
  assert.deepEqual(
    searchPharmacies(rows, { ...base, street: "night" }).map((row) => row.businessName),
    ["Preferred Pharmacy"],
  );
  assert.deepEqual(
    searchPharmacies(rows, { ...base, open24hr: true }).map((row) => row.businessName),
    ["Preferred Pharmacy"],
  );
});

test("pharmacy search excludes test and deleted rows and sorts On-WENO pharmacies first", () => {
  const rows = searchFixtureRows();

  const patientFacing = searchPharmacies(rows, {
    city: "Austin",
    state: "TX",
    searchType: "local-retail",
    all: true,
  });
  assert.deepEqual(patientFacing.map((row) => row.businessName), [
    "Preferred Pharmacy",
    "Community Pharmacy",
  ]);

  const developerSearch = searchPharmacies(rows, {
    city: "Austin",
    state: "TX",
    searchType: "local-retail",
    all: true,
    includeTestPharmacies: true,
  });
  assert.deepEqual(developerSearch.map((row) => row.businessName), [
    "Preferred Pharmacy",
    "Community Pharmacy",
    "Test Pharmacy",
  ]);
});

test("mail-order search honors All and pipe-delimited state service areas", () => {
  const rows = searchFixtureRows();

  const texas = searchPharmacies(rows, {
    city: "Austin",
    state: "TX",
    searchType: "mail-order",
    all: true,
  });
  assert.deepEqual(texas.map((row) => row.businessName), ["Mail All", "Mail TX OK"]);

  const wisconsin = searchPharmacies(rows, {
    city: "Madison",
    state: "WI",
    searchType: "mail-order",
    all: true,
  });
  assert.deepEqual(wisconsin.map((row) => row.businessName), ["Mail All"]);
});

test("Postgres pharmacy storage replaces atomically and incrementally upserts and deletes", async (t) => {
  const adminUrl = process.env.ODOS_POSTGRES_URL;
  if (!adminUrl) {
    t.skip("ODOS_POSTGRES_URL is required for the live Postgres pharmacy directory fixture.");
    return;
  }

  const databaseName = `odos_weno_directory_${randomUUID().replaceAll("-", "")}`;
  const testUrl = new URL(adminUrl);
  testUrl.pathname = `/${databaseName}`;
  const admin = new Client({ connectionString: adminUrl });
  const storage = new PostgresWenoPharmacyDirectoryStorage({ postgresUrl: testUrl.toString() });
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE ${databaseName} TEMPLATE template0`);
    const oldRow = pharmacyRow({ ncpdpId: "1000001", businessName: "Old Pharmacy" });
    const replacement = pharmacyRow({ ncpdpId: "1000002", businessName: "Replacement Pharmacy" });
    assert.equal(await storage.store([oldRow], "replace"), 1);
    assert.equal(await storage.store([replacement], "replace"), 1);
    assert.deepEqual((await storage.list()).map((row) => row.businessName), ["Replacement Pharmacy"]);

    const updated = { ...replacement, businessName: "Updated Pharmacy" };
    assert.equal(await storage.store([updated], "incremental"), 1);
    assert.deepEqual((await storage.list()).map((row) => row.businessName), ["Updated Pharmacy"]);

    const international = pharmacyRow({
      ncpdpId: "",
      mutuallyDefinedId: "INT-1",
      businessName: "International Pharmacy",
      international: true,
    });
    const tombstone = { ...updated, deleted: "2026-07-17T00:00:00.000Z" };
    assert.equal(await storage.store([international, tombstone], "incremental"), 2);
    assert.deepEqual((await storage.list()).map((row) => row.businessName), ["International Pharmacy"]);
  } finally {
    await storage.close();
    await admin.query(`DROP DATABASE IF EXISTS ${databaseName} WITH (FORCE)`);
    await admin.end();
  }
});

test("pharmacy directory sync blocks before HTTP when WENO is unconfigured", async () => {
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = (async () => {
    fetchCalls += 1;
    return new Response();
  }) as typeof fetch;
  try {
    await assert.rejects(
      syncWenoPharmacyDirectory({
        trigger: "manual",
        config: {},
        request: pharmacyDirectoryRequest(),
        storage: { async store() { return 0; } },
      }),
      /WENO EZ Integration is not configured/,
    );
    assert.equal(fetchCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("WENO mapping catalog ships empty and excludes an unmapped prescriber", async () => {
  assert.deepEqual(WENO_MAPPING_SEEDS, []);
  const catalog = new FhirWenoMappingCatalog(new MemoryBasicFhir());
  assert.deepEqual(await catalog.list(), []);
  assert.equal(await catalog.hasPrescriberMapping("Practitioner/unmapped"), false);
});

test("prescriber credentials references round-trip through the mapping Basic", async () => {
  const fhir = new MemoryBasicFhir();
  const catalog = new FhirWenoMappingCatalog(fhir);
  const row = mapping();
  assert.deepEqual(await catalog.save(row), row);
  assert.equal(await catalog.hasPrescriberMapping("Practitioner/prescriber-1"), true);
  const resource = buildWenoMappingResource(row);
  assert.deepEqual(parseWenoMappingResource(resource), row);
  assert.equal(resource.extension?.[0]?.valueString?.includes("ExamplePassWord"), false);
});

test("mapping save updates an existing stable key without creating a duplicate", async () => {
  const fhir = new MemoryBasicFhir();
  const catalog = new FhirWenoMappingCatalog(fhir);
  const row = mapping();
  await catalog.save(row);
  const updated = { ...row, syncStatus: "pending" };

  assert.deepEqual(await catalog.save(updated), updated);
  assert.equal(fhir.rowCount, 1);
  assert.equal(fhir.updateCount, 1);
  assert.deepEqual(await catalog.list("prescriber"), [updated]);
  assert.deepEqual(fhir.createHeaders, [{
    "X-ODOS-Source": "weno-mapping-catalog",
    "If-None-Exist":
      `identifier=${WENO_MAPPING_IDENTIFIER_SYSTEM}|${row.stableKey}`,
  }]);
});

test("mapping seed deduplication scopes stable keys by kind", async () => {
  const fhir = new MemoryBasicFhir();
  const prescriber = mapping();
  const location: WenoMappingRow = {
    stableKey: prescriber.stableKey,
    kind: "location",
    localReference: "Location/location-1",
    wenoEntityId: "weno-location-1",
    syncStatus: "synced",
  };
  const catalog = new FhirWenoMappingCatalog(fhir, [location]);

  await catalog.save(prescriber);

  assert.deepEqual(await catalog.list(), [location, prescriber]);
});

test("mapping catalog follows FHIR pagination links", async () => {
  const first = { ...mapping(), stableKey: "prescriber-1" };
  const second = {
    ...mapping(),
    stableKey: "prescriber-2",
    localReference: "Practitioner/prescriber-2",
  };
  const fhir = new PaginatedBasicFhir(first, second);
  const catalog = new FhirWenoMappingCatalog(fhir);

  assert.deepEqual(await catalog.list("prescriber"), [first, second]);
  assert.equal(fhir.nextPageRequests, 1);
});

test("sync parser reads the five verified CSV columns including quoted values", () => {
  const rows = parseNewRxSyncReport(
    "DateTimeofactionUTC,PatientID,SynchType,RelatestoNewRxMsgID,DeliveryStatus\n" +
      '2026-07-11T12:00:00Z,12537,NewRx,msg-1,"Sent, accepted"',
    "CSV",
  );
  assert.deepEqual(rows, [{
    DateTimeofactionUTC: "2026-07-11T12:00:00Z",
    PatientID: "12537",
    SynchType: "NewRx",
    RelatestoNewRxMsgID: "msg-1",
    DeliveryStatus: "Sent, accepted",
  }]);
});

test("sync builds a new MedicationRequest matched to the echoed patient ID", () => {
  const resource = buildWenoMedicationRequest(syncRow());
  assert.equal(resource.subject.reference, "Patient/12537");
  assert.equal(resource.identifier?.[0]?.value, "msg-1");
  assert.equal(resource.status, "unknown");
  assert.equal(resource.extension?.[0]?.valueCode, "electronically-sent");
  assert.equal(
    resource.extension?.some((extension) =>
      extension.url === ODOS_CONTROLLED_SUBSTANCE_FLAG_EXTENSION_URL
    ),
    false,
  );
});

test("sync creates once and skips an already imported WENO message", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify([syncRow()]), { status: 200 })) as typeof fetch;
  const fhir = new MemoryMedicationFhir();
  try {
    const input = {
      trigger: "manual" as const,
      config: CONFIG,
      request: { ...syncRequest(), ResponseFormat: "JSON" as const },
      fhir,
    };
    assert.deepEqual(await syncWenoRxActivity(input), { created: 1, skipped: 0 });
    assert.deepEqual(await syncWenoRxActivity(input), { created: 0, skipped: 1 });
    assert.equal(fhir.rows.length, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

function mapping(): WenoMappingRow {
  return {
    stableKey: "prescriber-1",
    kind: "prescriber",
    localReference: "Practitioner/prescriber-1",
    wenoEntityId: "weno-prescriber-1",
    syncStatus: "synced",
    wenoUserEmail: "prescriber@example.com",
    wenoPasswordRef: "secret/WENO_PRESCRIBER_1",
  };
}

function syncRequest() {
  return {
    UserEmail: "admin@example.com",
    MD5Password: "resolved-admin-secret",
    FromDate: "2026-07-01",
    ToDate: "2026-07-08",
  };
}

function pharmacyDirectoryRequest(): PharmacyDirectoryRequest {
  return {
    UserEmail: "admin@example.com",
    MD5Password: "resolved-admin-secret",
    Daily: "Y",
    ExcludeNonWenoTest: "Y",
  };
}

const SYNTHETIC_LITE_HEADERS = [
  "Created",
  "Modified",
  "Deleted",
  "NCPDP_safe",
  "Mutually_Defined_ID_safe",
  "NPI_safe",
  "Business_Name",
  "Address_Line_1",
  "Address_Line_2",
  "City",
  "State",
  "ZipCode_safe",
  "Country_Code",
  "International",
  "Latitude",
  "Longitude",
  "Pharmacy_Phone_safe",
  "Test_Pharmacy",
  "State_Wide_Mail_Order",
  "Mail_Order_US_State_Serviced",
  "Mail_Order_ US_Territories_Serviced",
  "On_WENO",
  "24HR",
] as const;

type SyntheticPharmacy = Record<typeof SYNTHETIC_LITE_HEADERS[number], string>;

function syntheticPharmacy(overrides: Partial<SyntheticPharmacy> = {}): SyntheticPharmacy {
  return {
    Created: "2026-07-01T00:00:00Z",
    Modified: "2026-07-17T00:00:00Z",
    Deleted: "NULL",
    NCPDP_safe: "[1234567]",
    Mutually_Defined_ID_safe: "NULL",
    NPI_safe: "[0123456789]",
    Business_Name: "Synthetic Community Pharmacy",
    Address_Line_1: "100 Main Street",
    Address_Line_2: "Suite 2",
    City: "Austin",
    State: "TX",
    ZipCode_safe: "[78701]",
    Country_Code: "US",
    International: "False",
    Latitude: "30.2672",
    Longitude: "-97.7431",
    Pharmacy_Phone_safe: "[05125550100]",
    Test_Pharmacy: "False",
    State_Wide_Mail_Order: "Local",
    Mail_Order_US_State_Serviced: "NULL",
    "Mail_Order_ US_Territories_Serviced": "NULL",
    On_WENO: "True",
    "24HR": "Unknown",
    ...overrides,
  };
}

function syntheticDirectoryZip(
  rows: SyntheticPharmacy[],
  options: { extraLiteColumn?: boolean; includeFull?: boolean } = {},
): ArrayBuffer {
  const liteHeaders = options.extraLiteColumn
    ? [...SYNTHETIC_LITE_HEADERS, "Future_Column"]
    : [...SYNTHETIC_LITE_HEADERS];
  const lite = csvFixture(
    liteHeaders,
    rows.map((row) => ({ ...row, Future_Column: "ignored" })),
  );
  const files: Record<string, Uint8Array> = {
    "FULL-by-name-but-LITE-by-header.csv": new TextEncoder().encode(lite),
    "README.txt": new TextEncoder().encode("Synthetic fixture only."),
  };
  if (options.includeFull) {
    const fullHeaders = [
      ...SYNTHETIC_LITE_HEADERS,
      "Script_Msg_Accepted",
      "Connectivity_Status",
      "eRxDrugWarning",
      ...Array.from({ length: 21 }, (_, index) => `Synthetic_FULL_Column_${index + 1}`),
    ];
    files["LITE-by-name-but-FULL-by-header.csv"] = new TextEncoder().encode(
      csvFixture(fullHeaders, rows.map((row) => ({
        ...row,
        Script_Msg_Accepted: "Y",
        Connectivity_Status: "Connected",
        eRxDrugWarning: "",
      }))),
    );
  }
  return zipToArrayBuffer(zipSync(files));
}

function csvFixture(headers: readonly string[], rows: Array<Record<string, string>>): string {
  const lines = [
    "Confidential synthetic fixture. Copyright Example.",
    headers.map(csvCell).join(","),
    ...rows.map((row) => headers.map((header) => csvCell(row[header] ?? "")).join(",")),
  ];
  return `${lines.join("\n")}\n`;
}

function csvCell(value: string): string {
  return /[",\n\r]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}

function zipToArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function pharmacyRow(overrides: Partial<PharmacyDirectoryRow> = {}): PharmacyDirectoryRow {
  return {
    created: "2026-07-01T00:00:00.000Z",
    modified: "2026-07-17T00:00:00.000Z",
    ncpdpId: "1234567",
    mutuallyDefinedId: "",
    npi: "0123456789",
    businessName: "Community Pharmacy",
    addressLine1: "100 Main Street",
    addressLine2: "",
    city: "Austin",
    state: "TX",
    zip: "78701",
    countryCode: "US",
    international: false,
    latitude: 30.2672,
    longitude: -97.7431,
    phone: "05125550100",
    testPharmacy: false,
    stateWideMailOrder: false,
    mailOrderStatesServiced: { type: "list", codes: [] },
    mailOrderTerritoriesServiced: { type: "list", codes: [] },
    onWeno: false,
    open24Hours: "unknown",
    ...overrides,
  };
}

function searchFixtureRows(): PharmacyDirectoryRow[] {
  return [
    pharmacyRow({ ncpdpId: "1000001", businessName: "Community Pharmacy" }),
    pharmacyRow({
      ncpdpId: "1000002",
      businessName: "Preferred Pharmacy",
      addressLine1: "200 Night Street",
      onWeno: true,
      open24Hours: "yes",
    }),
    pharmacyRow({ ncpdpId: "1000003", businessName: "Test Pharmacy", testPharmacy: true }),
    pharmacyRow({
      ncpdpId: "1000004",
      businessName: "Deleted Pharmacy",
      deleted: "2026-07-17T00:00:00.000Z",
    }),
    pharmacyRow({
      ncpdpId: "1000005",
      businessName: "Mail All",
      city: "Denver",
      state: "CO",
      stateWideMailOrder: true,
      mailOrderStatesServiced: { type: "all" },
      onWeno: true,
    }),
    pharmacyRow({
      ncpdpId: "1000006",
      businessName: "Mail TX OK",
      city: "Dallas",
      stateWideMailOrder: true,
      mailOrderStatesServiced: { type: "list", codes: ["OK", "TX"] },
    }),
  ];
}

function syncRow() {
  return {
    PatientID: "12537",
    RelatestoNewRxMsgID: "msg-1",
    DeliveryStatus: "Sent",
    DateTimeofactionUTC: "2026-07-11T12:00:00Z",
    SynchType: "NewRx",
  };
}

class MemoryBasicFhir {
  private rows: Basic[] = [];
  readonly createHeaders: Array<Record<string, string> | undefined> = [];
  updateCount = 0;

  get rowCount(): number {
    return this.rows.length;
  }

  async search<T extends Basic>(
    _resourceType: T["resourceType"],
    params?: Record<string, string>,
  ): Promise<Bundle<T>> {
    const code = params?.code?.split("|").at(-1);
    const rows = code
      ? this.rows.filter((row) => row.code.coding?.some((coding) => coding.code === code))
      : this.rows;
    return { resourceType: "Bundle", type: "searchset", entry: rows.map((resource) => ({ resource: resource as T })) };
  }

  async create<T extends Basic>(resource: T, extraHeaders?: Record<string, string>): Promise<T> {
    this.createHeaders.push(extraHeaders);
    const saved = { ...resource, id: `mapping-${this.rows.length + 1}` } as T;
    this.rows.push(saved);
    return saved;
  }

  async update<T extends Basic>(_resourceType: "Basic", id: string, resource: T): Promise<T> {
    this.updateCount += 1;
    const saved = { ...resource, id };
    this.rows = this.rows.map((row) => row.id === id ? saved : row);
    return saved;
  }
}

class PaginatedBasicFhir extends MemoryBasicFhir {
  nextPageRequests = 0;

  constructor(
    private readonly first: WenoMappingRow,
    private readonly second: WenoMappingRow,
  ) {
    super();
  }

  override async search<T extends Basic>(): Promise<Bundle<T>> {
    return {
      resourceType: "Bundle",
      type: "searchset",
      entry: [{ resource: buildWenoMappingResource(this.first) as T }],
      link: [{ relation: "next", url: "https://example.test/fhir/R4/Basic?page=2" }],
    };
  }

  async searchUrl<T extends Basic>(): Promise<Bundle<T>> {
    this.nextPageRequests += 1;
    return {
      resourceType: "Bundle",
      type: "searchset",
      entry: [{ resource: buildWenoMappingResource(this.second) as T }],
    };
  }
}

class MemoryMedicationFhir {
  rows: MedicationRequest[] = [];

  async search<T extends MedicationRequest>(
    _resourceType: T["resourceType"],
    params?: Record<string, string>,
  ): Promise<Bundle<T>> {
    const value = params?.identifier?.split("|").at(-1);
    const rows = this.rows.filter((row) =>
      row.identifier?.some((identifier) => identifier.value === value)
    );
    return { resourceType: "Bundle", type: "searchset", entry: rows.map((resource) => ({ resource: resource as T })) };
  }

  async create<T extends MedicationRequest>(resource: T): Promise<T> {
    this.rows.push(resource);
    return resource;
  }
}
