import assert from "node:assert/strict";
import { test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Basic } from "@medplum/fhirtypes";
import { createSingletonConfigDraft } from "../src/lib/catalog-adapter";
import {
  buildFloorConfigResource,
  parseFloorConfig,
  type PersistedFloorConfig,
} from "../src/lib/floor-config";
import {
  createFloorConfigAdapters,
  floorStationRows,
  housePlanLabelRows,
  payerMapRows,
  type FloorStationRow,
  type HousePlanLabelRow,
  type PayerMapRow,
} from "../src/lib/floor-config-settings";
import { DEFAULT_FLOOR_BOARD_CONFIG } from "../src/lib/floor-board";
import { floorStateExtension } from "../src/lib/floor-state";
import {
  publishFloorBoardConfig,
  useFloorBoardConfig,
} from "../src/scenes/frontdesk/useFloorBoardConfig";
import {
  CatalogScene,
  CatalogSection,
  type CatalogDescriptor,
} from "../src/scenes/settings/CatalogEditor";
import {
  FloorConfigSettingsReady,
  loadOnBoardStationIds,
} from "../src/scenes/settings/FloorConfigSettings";

const CONFIG: PersistedFloorConfig = {
  stations: [
    { id: "waiting", label: "Waiting", order: 0 },
    { id: "optical", label: "Optical", order: 1 },
  ],
  laneThresholds: { waiting: { amberMinutes: 10, redMinutes: 20 } },
  defaultThreshold: { amberMinutes: 20, redMinutes: 30 },
  payerMap: { VSP: "vision", "House Plan": "house" },
  housePlanLabel: "Our Plan",
};

function fixture() {
  const writes: Array<{ resource: Basic; sourceTag: string }> = [];
  const resource = { ...buildFloorConfigResource(CONFIG), id: "floor-config-1", meta: { versionId: "2" } };
  const client = {
    async search() {
      return { resourceType: "Bundle" as const, type: "searchset" as const };
    },
    async create<T extends Basic>(next: T, sourceTag: string) {
      writes.push({ resource: next, sourceTag });
      return { ...next, id: "created" };
    },
    async update<T extends Basic>(next: T, sourceTag: string) {
      writes.push({ resource: next, sourceTag });
      return next;
    },
  };
  const draft = createSingletonConfigDraft({
    configKey: "odos-floor-config",
    config: CONFIG,
    resource,
    buildResource: buildFloorConfigResource,
    sourceTag: "floor-config",
    fhirClient: client,
  });
  return { draft, writes, resource, client };
}

test("the real floor-config component stacks all three sections and honors read-only mode", () => {
  const { resource, client } = fixture();
  const html = renderToStaticMarkup(
    <FloorConfigSettingsReady
      resource={resource}
      config={CONFIG}
      onBoardStationIds={new Set()}
      canWrite={false}
      client={client}
    />,
  );
  assert.match(html, /Stations/);
  assert.match(html, /Payer map/);
  assert.match(html, /House-plan label/);
  assert.doesNotMatch(html, /\+ Add station|\+ Add payer mapping|Reorder/);
});

test("three projected sections share one dirty bar and one singleton commit persists edits from two sections", async () => {
  const { draft, writes } = fixture();
  const adapters = createFloorConfigAdapters(draft, new Set());
  const optical = (await adapters.stations.list()).find((row) => row.id === "optical")!;
  await adapters.stations.save({ ...optical, label: "Optical shop", amberMinutes: 15, redMinutes: 25 });
  const houseLabel = (await adapters.housePlanLabel.list())[0]!;
  await adapters.housePlanLabel.save({ ...houseLabel, label: "ODOS Select" });

  const html = renderToStaticMarkup(
    <CatalogScene title="Floor config" canWrite transaction={draft}>
      <CatalogSection descriptor={stationDescriptor(adapters.stations)} canWrite initialState={{ items: await adapters.stations.list() }} />
      <CatalogSection descriptor={payerDescriptor(adapters.payerMap)} canWrite initialState={{ items: await adapters.payerMap.list() }} />
      <CatalogSection descriptor={houseDescriptor(adapters.housePlanLabel)} canWrite initialState={{ items: await adapters.housePlanLabel.list() }} />
    </CatalogScene>,
  );
  assert.equal((html.match(/Unsaved settings changes/g) ?? []).length, 1);
  assert.equal((html.match(/>Save<\/button>/g) ?? []).length, 1);
  assert.equal((html.match(/>Discard<\/button>/g) ?? []).length, 1);

  await draft.commit();
  assert.equal(writes.length, 1);
  assert.equal(writes[0]!.sourceTag, "floor-config");
  const persisted = parseFloorConfig(writes[0]!.resource);
  assert.equal(persisted.stations.find((station) => station.id === "optical")?.label, "Optical shop");
  assert.deepEqual(persisted.laneThresholds.optical, { amberMinutes: 15, redMinutes: 25 });
  assert.equal(persisted.housePlanLabel, "ODOS Select");
});

test("Discard restores edits across projected sections and payer-map none removes the stored key", async () => {
  const { draft } = fixture();
  const adapters = createFloorConfigAdapters(draft, new Set());
  const optical = (await adapters.stations.list()).find((row) => row.id === "optical")!;
  await adapters.stations.save({ ...optical, label: "Changed" });
  await adapters.housePlanLabel.save({ ...(await adapters.housePlanLabel.list())[0]!, label: "Changed plan" });
  draft.discard();
  assert.equal((await adapters.stations.list()).find((row) => row.id === "optical")?.label, "Optical");
  assert.equal((await adapters.housePlanLabel.list())[0]?.label, "Our Plan");

  const vsp = (await adapters.payerMap.list()).find((row) => row.payer === "VSP")!;
  await adapters.payerMap.save({ ...vsp, cue: "none" });
  assert.equal("VSP" in draft.current().payerMap, false);
});

test("station deactivation retains custom thresholds for reactivation while board cards remain guarded", async () => {
  const thresholdFixture = fixture();
  const thresholdAdapter = createFloorConfigAdapters(thresholdFixture.draft, new Set());
  const waiting = (await thresholdAdapter.stations.list()).find((row) => row.id === "waiting")!;
  const deactivated = await thresholdAdapter.stations.deactivate(waiting);
  assert.equal(deactivated.active, false);
  assert.deepEqual(thresholdFixture.draft.current().laneThresholds.waiting, {
    amberMinutes: 10,
    redMinutes: 20,
  });
  const reactivated = await thresholdAdapter.stations.save({ ...deactivated, active: true });
  assert.equal(reactivated.active, true);
  assert.deepEqual(thresholdFixture.draft.current().laneThresholds.waiting, {
    amberMinutes: 10,
    redMinutes: 20,
  });

  const boardGuard = createFloorConfigAdapters(fixture().draft, new Set(["optical"]));
  const optical = (await boardGuard.stations.list()).find((row) => row.id === "optical")!;
  await assert.rejects(
    async () => boardGuard.stations.deactivate(optical),
    /patients currently on the board/,
  );
});

test("board-reference loading follows every Appointment search page before enabling deactivation", async () => {
  const first = {
    resourceType: "Appointment" as const,
    id: "appt-1",
    status: "checked-in" as const,
    participant: [],
    extension: [floorStateExtension("waiting", "2026-07-10T12:00:00.000Z")],
  };
  const second = {
    resourceType: "Appointment" as const,
    id: "appt-2",
    status: "arrived" as const,
    participant: [],
    extension: [floorStateExtension("optical", "2026-07-10T12:05:00.000Z")],
  };
  const requested: string[] = [];
  const stationIds = await loadOnBoardStationIds({
    async search() {
      return {
        resourceType: "Bundle",
        type: "searchset",
        entry: [{ resource: first }],
        link: [{ relation: "next", url: "/fhir/R4/Appointment?page=2" }],
      };
    },
    async searchUrl(url) {
      requested.push(url);
      return { resourceType: "Bundle", type: "searchset", entry: [{ resource: second }] };
    },
  });
  assert.deepEqual([...stationIds].sort(), ["optical", "waiting"]);
  assert.deepEqual(requested, ["/fhir/R4/Appointment?page=2"]);
});

test("real floor singleton round-trips after projected station and payer edits", async () => {
  const { draft } = fixture();
  const adapters = createFloorConfigAdapters(draft, new Set());
  await adapters.stations.reorder?.(["optical", "waiting"]);
  await adapters.payerMap.save({ id: "EyeMed", payer: "EyeMed", cue: "vision", active: true });
  const roundTripped = parseFloorConfig(buildFloorConfigResource(draft.current()));
  assert.deepEqual(roundTripped, draft.current());
  assert.deepEqual(roundTripped.stations.map((station) => station.id), ["optical", "waiting"]);
  assert.equal(roundTripped.payerMap.EyeMed, "vision");
});

test("publishing a committed config updates the same snapshot consumed by the floor-board hook", () => {
  publishFloorBoardConfig({ ...DEFAULT_FLOOR_BOARD_CONFIG, housePlanLabel: "Fresh label" });
  function Probe() {
    return <span>{useFloorBoardConfig().housePlanLabel}</span>;
  }
  assert.match(renderToStaticMarkup(<Probe />), /Fresh label/);
  publishFloorBoardConfig(DEFAULT_FLOOR_BOARD_CONFIG);
});

function stationDescriptor(adapter: ReturnType<typeof createFloorConfigAdapters>["stations"]): CatalogDescriptor<FloorStationRow> {
  return {
    title: "Stations",
    singularLabel: "station",
    adapter,
    fields: [],
    createItem: () => floorStationRows(CONFIG)[0]!,
    label: (item) => item.label,
  };
}

function payerDescriptor(adapter: ReturnType<typeof createFloorConfigAdapters>["payerMap"]): CatalogDescriptor<PayerMapRow> {
  return {
    title: "Payer map",
    singularLabel: "payer mapping",
    adapter,
    fields: [],
    createItem: () => payerMapRows(CONFIG)[0]!,
    label: (item) => item.payer,
  };
}

function houseDescriptor(adapter: ReturnType<typeof createFloorConfigAdapters>["housePlanLabel"]): CatalogDescriptor<HousePlanLabelRow> {
  return {
    title: "House-plan label",
    singularLabel: "house-plan label",
    adapter,
    fields: [],
    createItem: () => housePlanLabelRows(CONFIG)[0]!,
    canCreate: false,
    label: (item) => item.label,
  };
}
