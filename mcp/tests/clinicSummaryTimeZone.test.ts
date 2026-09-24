import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import type { Basic, Bundle, Resource } from "@medplum/fhirtypes";
import express from "express";
import { registerClinicRoutes, type ClinicRouteDeps } from "../src/clinic/clinic-routes.js";
import {
  ODOS_PRACTICE_TIME_ZONE_CONFIG_CODE,
  ODOS_PRACTICE_TIME_ZONE_CONFIG_EXTENSION_URL,
  ODOS_PRACTICE_TIME_ZONE_CONFIG_SYSTEM,
  buildPracticeTimeZoneConfigResource,
} from "../src/clinic/practice-time-zone-config.js";

// Sept 24 in New York, still Sept 23 in Denver.
const NOW = "2026-09-24T05:30:00.000Z";

function staffFhir(searches: { resourceType: string; params: Record<string, string> }[]) {
  return {
    baseUrl: "http://localhost:8103/",
    search: async <T extends Resource>(resourceType: T["resourceType"], params: Record<string, string> = {}): Promise<Bundle<T>> => {
      searches.push({ resourceType: String(resourceType), params });
      return { resourceType: "Bundle", type: "searchset", entry: [] };
    },
  };
}

function settingService(rows: Basic[] | Error) {
  return {
    search: async () => {
      if (rows instanceof Error) throw rows;
      return { resourceType: "Bundle", type: "searchset", entry: rows.map((resource) => ({ resource })) } satisfies Bundle<Basic>;
    },
  } as never as ClinicRouteDeps["serviceFhir"];
}

async function getSummary(deps: Partial<ClinicRouteDeps>, searches: { resourceType: string; params: Record<string, string> }[] = []) {
  const app = express();
  registerClinicRoutes(app, {
    authenticateService: async () => undefined,
    authenticate: async (header) => header === "Bearer good"
      ? { staffReference: "Practitioner/provider-1", actorRole: "provider", fhir: staffFhir(searches) as never }
      : null,
    now: () => NOW,
    ...deps,
  });
  const listener = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve, reject) => { listener.once("listening", resolve); listener.once("error", reject); });
  const { port } = listener.address() as AddressInfo;
  try {
    const response = await fetch(`http://127.0.0.1:${port}/clinic/summary`, { headers: { Authorization: "Bearer good" } });
    return { status: response.status, body: await response.json() as Record<string, unknown> };
  } finally {
    await new Promise<void>((resolve, reject) => listener.close((error) => error ? reject(error) : resolve()));
  }
}

const invalidSetting: Basic = {
  resourceType: "Basic",
  id: "tz-invalid",
  code: { coding: [{ system: ODOS_PRACTICE_TIME_ZONE_CONFIG_SYSTEM, code: ODOS_PRACTICE_TIME_ZONE_CONFIG_CODE }] },
  extension: [{ url: ODOS_PRACTICE_TIME_ZONE_CONFIG_EXTENSION_URL, valueString: JSON.stringify({ timeZone: "Mars/Olympus_Mons" }) }],
};

test("B1 GET /clinic/summary takes today from the stored practice time zone, not the environment", async () => {
  const searches: { resourceType: string; params: Record<string, string> }[] = [];
  const { status } = await getSummary({
    timeZone: "America/New_York",
    serviceFhir: settingService([{ ...buildPracticeTimeZoneConfigResource({ timeZone: "America/Denver" }), id: "tz-1" }]),
  }, searches);
  assert.equal(status, 200);
  const dated = searches.filter((search) => search.resourceType === "Appointment" || search.resourceType === "Encounter");
  assert.deepEqual(dated.map((search) => [search.resourceType, search.params.date]), [["Appointment", "2026-09-23"], ["Encounter", "2026-09-23"]]);
});

test("B1 GET /clinic/summary falls back to the environment zone only when no setting is stored", async () => {
  const searches: { resourceType: string; params: Record<string, string> }[] = [];
  const { status } = await getSummary({ timeZone: "America/New_York", serviceFhir: settingService([]) }, searches);
  assert.equal(status, 200);
  assert.deepEqual(searches.filter((search) => search.resourceType === "Appointment").map((search) => search.params.date), ["2026-09-24"]);
});

test("B2 GET /clinic/summary maps practice time-zone failures to the open-charts codes", async () => {
  assert.deepEqual(await getSummary({ serviceFhir: settingService([]) }), { status: 409, body: { code: "practice-time-zone-unset" } });
  assert.deepEqual(await getSummary({ timeZone: "America/New_York", serviceFhir: settingService([invalidSetting]) }), { status: 409, body: { code: "practice-time-zone-invalid" } });
  assert.deepEqual(await getSummary({ timeZone: "America/New_York", serviceFhir: settingService(new Error("service read failed")) }), { status: 502, body: { code: "practice-time-zone-unreadable" } });
  assert.deepEqual(await getSummary({ timeZone: "America/New_York" }), { status: 502, body: { code: "practice-time-zone-unreadable" } });
});
