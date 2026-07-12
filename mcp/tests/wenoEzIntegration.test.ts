import assert from "node:assert/strict";
import test from "node:test";
import type { Basic, Bundle, MedicationRequest } from "@medplum/fhirtypes";
import { OSOD_CONTROLLED_SUBSTANCE_FLAG_EXTENSION_URL } from "../src/fhir/medicationOrder.js";
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
  getComposeRxIframeUrl,
  getRxLogIframeUrl,
  pullNewRxSyncReport,
  type ComposeRxIframeRequest,
} from "../src/integrations/weno/wenoEzIntegrationClient.js";
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
    "X-OSOD-Source": "weno-mapping-catalog",
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
      extension.url === OSOD_CONTROLLED_SUBSTANCE_FLAG_EXTENSION_URL
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
