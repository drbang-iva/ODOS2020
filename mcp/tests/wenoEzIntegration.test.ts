import assert from "node:assert/strict";
import test from "node:test";
import type { Basic, Bundle } from "@medplum/fhirtypes";
import {
  isWenoConfigured,
  type WenoEzIntegrationConfig,
  wenoEzIntegrationConfigFromEnv,
} from "../src/integrations/weno/config.js";
import {
  decodeWenoBase64,
  encodeWenoBase64,
  getComposeRxIframeUrl,
  getRxLogIframeUrl,
  pullNewRxSyncReport,
} from "../src/integrations/weno/wenoEzIntegrationClient.js";
import {
  buildWenoMappingResource,
  FhirWenoMappingCatalog,
  parseWenoMappingResource,
  WENO_MAPPING_SEEDS,
  type WenoMappingRow,
} from "../src/fhir/wenoMappingCatalog.js";

const CONFIG: Required<WenoEzIntegrationConfig> = {
  accountId: "account-ref",
  encryptionKey: "secret-test-key",
  baseUrl: "https://weno.invalid",
  adminCredentialsRef: "secret/WENO_ADMIN",
};

test("WENO config is all-or-nothing across every field", () => {
  assert.equal(isWenoConfigured(CONFIG), true);
  for (const field of Object.keys(CONFIG) as Array<keyof WenoEzIntegrationConfig>) {
    assert.equal(isWenoConfigured({ ...CONFIG, [field]: undefined }), false, field);
    assert.equal(isWenoConfigured({ ...CONFIG, [field]: " " }), false, `${field} blank`);
  }
  assert.equal(isWenoConfigured({}), false);
});

test("WENO config reads references and secrets only from the environment input", () => {
  assert.deepEqual(wenoEzIntegrationConfigFromEnv({
    WENO_EZ_ACCOUNT_ID: "account-ref",
    WENO_EZ_ENCRYPTION_KEY: "secret-test-key",
    WENO_EZ_BASE_URL: "https://weno.invalid",
    WENO_EZ_ADMIN_CREDENTIALS_REF: "secret/WENO_ADMIN",
  }), CONFIG);
});

test("WENO mapping catalog ships empty and excludes an unmapped prescriber", async () => {
  assert.deepEqual(WENO_MAPPING_SEEDS, []);
  const catalog = new FhirWenoMappingCatalog(new MemoryFhir());
  assert.deepEqual(await catalog.list(), []);
  assert.equal(await catalog.hasPrescriberMapping("Practitioner/unmapped"), false);
});

test("a practice-created prescriber mapping enables only its referenced prescriber", async () => {
  const fhir = new MemoryFhir();
  const catalog = new FhirWenoMappingCatalog(fhir);
  await catalog.save(mapping({ syncStatus: "pending" }));
  assert.equal(await catalog.hasPrescriberMapping("Practitioner/prescriber-1"), true);
  assert.equal(await catalog.hasPrescriberMapping("Practitioner/prescriber-2"), false);
});

test("WENO mapping Basic round-trips through the coded resource-catalog shape", () => {
  const row = mapping();
  const resource = buildWenoMappingResource(row);
  assert.deepEqual(parseWenoMappingResource(resource), row);
  assert.equal(resource.code.coding?.[0]?.code, "osod-weno-prescriber-mapping");
});

test("WENO adapter functions reject instead of returning fake data", async () => {
  const payload = { unverifiedDashboardPayload: {} };
  const expected = /WENO EZ Integration not yet wired — see TODO WENO-DASHBOARD markers/;
  await assert.rejects(getComposeRxIframeUrl(CONFIG, payload), expected);
  await assert.rejects(getRxLogIframeUrl(CONFIG, payload), expected);
  await assert.rejects(pullNewRxSyncReport(CONFIG, payload), expected);
});

test("WENO adapter functions use the shared configuration gate", async () => {
  await assert.rejects(
    getComposeRxIframeUrl({}, { unverifiedDashboardPayload: {} }),
    /WENO EZ Integration is not configured/,
  );
});

test("WENO Base64 helper round-trips UTF-8 text", () => {
  const original = "Rx: 1 gtt OU — mañana";
  assert.equal(decodeWenoBase64(encodeWenoBase64(original)), original);
});

function mapping(overrides: Partial<WenoMappingRow> = {}): WenoMappingRow {
  return {
    stableKey: "prescriber-1",
    kind: "prescriber",
    localReference: "Practitioner/prescriber-1",
    wenoEntityId: "weno-prescriber-1",
    syncStatus: "synced",
    ...overrides,
  };
}

class MemoryFhir {
  private rows: Basic[] = [];

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

  async create<T extends Basic>(resource: T): Promise<T> {
    const saved = { ...resource, id: `mapping-${this.rows.length + 1}` } as T;
    this.rows.push(saved);
    return saved;
  }

  async update<T extends Basic>(_resourceType: "Basic", id: string, resource: T): Promise<T> {
    const saved = { ...resource, id };
    this.rows = this.rows.map((row) => row.id === id ? saved : row);
    return saved;
  }
}
