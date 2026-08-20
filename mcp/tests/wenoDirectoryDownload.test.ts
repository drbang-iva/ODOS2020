import assert from "node:assert/strict";
import test from "node:test";
import {
  isWenoDirectoryDownloadConfigured,
  type WenoDirectoryDownloadConfig,
  wenoDirectoryDownloadConfigFromEnv,
} from "../src/integrations/weno/config.js";
import { decryptWenoPayload, encryptWenoPayload } from "../src/integrations/weno/wenoCrypto.js";
import {
  downloadPharmacyDirectory,
  type PharmacyDirectoryRequest,
} from "../src/integrations/weno/wenoDirectoryDownloadClient.js";

const CONFIG: Required<WenoDirectoryDownloadConfig> = {
  encryptionKey: "secret-test-key",
  baseUrl: "https://online.wenoexchange.com",
  syncAdminEmail: "admin@example.com",
  syncAdminPasswordRef: "secret/WENO_SYNC_ADMIN",
};

const REAL_SAMPLE_PAYLOAD = {
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

test("WENO directory download config is all-or-nothing across install-level fields", () => {
  assert.equal(isWenoDirectoryDownloadConfigured(CONFIG), true);
  for (const field of Object.keys(CONFIG) as Array<keyof WenoDirectoryDownloadConfig>) {
    assert.equal(isWenoDirectoryDownloadConfigured({ ...CONFIG, [field]: undefined }), false, field);
    assert.equal(isWenoDirectoryDownloadConfigured({ ...CONFIG, [field]: " " }), false, `${field} blank`);
  }
  assert.equal(isWenoDirectoryDownloadConfigured({}), false);
});

test("WENO directory download config reads admin secret references without storing the password", () => {
  assert.deepEqual(wenoDirectoryDownloadConfigFromEnv({
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

function pharmacyDirectoryRequest(): PharmacyDirectoryRequest {
  return {
    UserEmail: "admin@example.com",
    MD5Password: "resolved-admin-secret",
    Daily: "Y",
    ExcludeNonWenoTest: "Y",
  };
}
