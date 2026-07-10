import assert from "node:assert/strict";
import { test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type {
  CatalogAdapter,
  CatalogCapabilities,
  CatalogDraftTransaction,
} from "../src/lib/catalog-adapter";
import { CatalogEditor, type CatalogDescriptor } from "../src/scenes/settings/CatalogEditor";

type FixtureItem = {
  id: string;
  label: string;
  color: string;
  group: string;
  active: boolean;
  minutes: number;
};

const CAPABILITIES: CatalogCapabilities = {
  reorder: true,
  deactivate: true,
  presetSeed: true,
  groupBy: true,
};

function descriptor(
  items: FixtureItem[] = [],
  transaction?: CatalogDraftTransaction,
): CatalogDescriptor<FixtureItem> {
  const adapter: CatalogAdapter<FixtureItem> = {
    capabilities: CAPABILITIES,
    list: () => items,
    save: (item) => item,
    deactivate: (item) => ({ ...item, active: false }),
    reorder: () => undefined,
  };
  return {
    title: "Fixture catalog",
    singularLabel: "Fixture",
    adapter,
    fields: [
      { type: "text", key: "label", label: "Label", required: true, unique: true },
      { type: "number", key: "minutes", label: "Minutes", min: 1 },
    ],
    createItem: () => ({
      id: "new-fixture",
      label: "",
      color: "#4a7dff",
      group: "Live",
      active: true,
      minutes: 10,
    }),
    label: (item) => item.label,
    color: (item) => item.color,
    facts: (item) => [`${item.minutes} min`],
    groupBy: { label: "Group", value: (item) => item.group },
    presetSeedOffer: <button type="button">Use starter presets</button>,
    transaction,
  };
}

const ACTIVE: FixtureItem = {
  id: "active",
  label: "Active Fixture",
  color: "#4a7dff",
  group: "Live",
  active: true,
  minutes: 20,
};

test("CatalogEditor renders its loading skeleton", () => {
  const html = renderToStaticMarkup(
    <CatalogEditor descriptor={descriptor()} canWrite initialState={{ loading: true }} />,
  );
  assert.match(html, /aria-label="Loading catalog"/);
});

test("CatalogEditor renders empty preset-seed offer and load errors", () => {
  const empty = renderToStaticMarkup(
    <CatalogEditor descriptor={descriptor()} canWrite initialState={{ items: [] }} />,
  );
  assert.match(empty, /No fixture catalog yet/);
  assert.match(empty, /Use starter presets/);

  const error = renderToStaticMarkup(
    <CatalogEditor
      descriptor={descriptor()}
      canWrite
      initialState={{ items: [], error: "Fixture load failed" }}
    />,
  );
  assert.match(error, /role="alert"/);
  assert.match(error, /Fixture load failed/);
});

test("CatalogEditor read-only mode keeps list visible and removes editor affordances", () => {
  const html = renderToStaticMarkup(
    <CatalogEditor descriptor={descriptor([ACTIVE])} canWrite={false} initialState={{ items: [ACTIVE] }} />,
  );
  assert.match(html, /Active Fixture/);
  assert.doesNotMatch(html, /\+ Add Fixture/);
  assert.doesNotMatch(html, /Reorder Active Fixture/);
  assert.doesNotMatch(html, /role="dialog"/);
});

test("CatalogEditor groups active catalogs, collapses zero-active groups, and opens a settings drawer", () => {
  const inactive: FixtureItem = {
    ...ACTIVE,
    id: "inactive",
    label: "Archived Fixture",
    group: "Archived",
    active: false,
  };
  const html = renderToStaticMarkup(
    <CatalogEditor
      descriptor={descriptor([ACTIVE, inactive])}
      canWrite
      initialState={{ items: [ACTIVE, inactive], selectedId: ACTIVE.id }}
    />,
  );
  assert.match(html, /Active Fixture/);
  assert.doesNotMatch(html, /Archived Fixture/);
  assert.match(html, /role="dialog"/);
  assert.match(html, /aria-label="Close editor"/);
  assert.match(html, /translate-x-0/);
  assert.match(html, /Reorder Active Fixture/);
});

test("CatalogEditor exposes one Save and Discard bar for a dirty singleton transaction", () => {
  const transaction: CatalogDraftTransaction = {
    dirty: true,
    async commit() {
      return { resourceType: "Basic", code: { text: "Fixture" } };
    },
    discard() {},
  };
  const html = renderToStaticMarkup(
    <CatalogEditor
      descriptor={descriptor([ACTIVE], transaction)}
      canWrite
      initialState={{ items: [ACTIVE], selectedId: ACTIVE.id }}
    />,
  );
  assert.match(html, /Unsaved settings changes/);
  assert.match(html, />Discard</);
  assert.match(html, />Apply to draft</);
  assert.equal(html.match(/>Save</g)?.length, 1);
});
