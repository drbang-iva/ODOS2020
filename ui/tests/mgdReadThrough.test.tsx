import assert from "node:assert/strict";
import { test } from "node:test";
import React from "react";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { OcularHealthSection } from "../src/components/charting/OcularHealthSection";
import type { CustomFindingDefinition } from "../src/components/charting/CustomFindingSection";
import { OdosChips } from "../src/components/inputs/OdosChips";
import { handleFindingDefinitionCatalogRequest } from "../../mcp/src/clinical-graph/finding-definition-endpoint";
import {
  buildFindingDefinitionSeeds,
  type FindingDefinitionFhirClient,
} from "../../mcp/src/clinical-graph/finding-definition-store";

const LIDS_KEY = "ocular-health:anterior:lids-lashes";
const MGD_OPTION = "meibomian-gland-dysfunction";
const PATIENT_REFERENCE = "Patient/mgd-reader";
const ENCOUNTER_REFERENCE = "Encounter/routine-exam";
const ENCOUNTER_RECORDED_AT = "2026-09-07T12:30:00.000Z";

interface GlandRow {
  observationReference: string;
  recordedAt: string;
  eye: "OD" | "OS";
  values: Array<{ code: string; label: string; value: number | string }>;
}

const GLAND_ROWS: GlandRow[] = [{
  observationReference: "Observation/gland-od",
  recordedAt: "2023-09-07T12:00:00.000Z",
  eye: "OD",
  values: [
    { code: "CUSTOM_EXPRESSIBILITY", label: "Expressibility", value: "reduced" },
    { code: "CUSTOM_SECRETION_QUALITY", label: "Secretion quality", value: "inspissated" },
    { code: "CUSTOM_GLANDS_YIELDING_LIQUID", label: "Glands yielding liquid", value: 7 },
  ],
}];

const CURRENT_GLAND_ROWS: GlandRow[] = [{
  observationReference: "Observation/gland-current-od",
  recordedAt: "2026-09-07T12:00:00.000Z",
  eye: "OD",
  values: [
    { code: "CUSTOM_EXPRESSIBILITY", label: "Expressibility", value: "normal" },
    { code: "CUSTOM_SECRETION_QUALITY", label: "Secretion quality", value: "clear" },
    { code: "CUSTOM_GLANDS_YIELDING_LIQUID", label: "Glands yielding liquid", value: 12 },
  ],
}];

test("current-encounter gland data renders as this visit and never as prior", async () => {
  const catalog = await catalogDefinitions();
  const { renderer } = await renderLids(catalog, [], CURRENT_GLAND_ROWS);
  try {
    const readings = relatedReadingText(renderer);
    assert.deepEqual(readings, [
      "This visit: Dry Eye · Gland Function · Expressibility: Normal · Sep 7, 2026",
      "This visit: Dry Eye · Gland Function · Secretion quality: Clear · Sep 7, 2026",
      "This visit: Dry Eye · Gland Function · Glands yielding liquid: 12 · Sep 7, 2026",
    ]);
    assert.equal(readings.some((reading) => reading.startsWith("Prior:")), false);
  } finally {
    renderer.unmount();
  }
});

test("prior-encounter gland data retains the prior label and recorded date", async () => {
  const catalog = await catalogDefinitions();
  const { renderer } = await renderLids(catalog, GLAND_ROWS);
  try {
    assert.deepEqual(relatedReadingText(renderer), [
      "Prior: Dry Eye · Gland Function · Expressibility: Reduced · Sep 7, 2023",
      "Prior: Dry Eye · Gland Function · Secretion quality: Inspissated · Sep 7, 2023",
      "Prior: Dry Eye · Gland Function · Glands yielding liquid: 7 · Sep 7, 2023",
    ]);
  } finally {
    renderer.unmount();
  }
});

test("current and prior gland data render together with distinct visit context", async () => {
  const catalog = await catalogDefinitions();
  const { renderer } = await renderLids(catalog, GLAND_ROWS, CURRENT_GLAND_ROWS);
  try {
    assert.deepEqual(relatedReadingText(renderer), [
      "This visit: Dry Eye · Gland Function · Expressibility: Normal · Sep 7, 2026",
      "This visit: Dry Eye · Gland Function · Secretion quality: Clear · Sep 7, 2026",
      "This visit: Dry Eye · Gland Function · Glands yielding liquid: 12 · Sep 7, 2026",
      "Prior: Dry Eye · Gland Function · Expressibility: Reduced · Sep 7, 2023",
      "Prior: Dry Eye · Gland Function · Secretion quality: Inspissated · Sep 7, 2023",
      "Prior: Dry Eye · Gland Function · Glands yielding liquid: 7 · Sep 7, 2023",
    ]);
  } finally {
    renderer.unmount();
  }
});

test("present dry-eye gland data renders beside an unchecked MGD finding with source and date", async () => {
  const catalog = await catalogDefinitions();
  const { renderer } = await renderLids(catalog, GLAND_ROWS);
  try {
    const findings = renderer.root.findAllByType(OdosChips)
      .find((chips) => chips.props.ariaLabel === "Priority ocular health findings");
    assert.ok(findings);
    assert.deepEqual(findings.props.selected, [], "the reader must not depend on MGD being checked");

    const readings = relatedReadingText(renderer);
    assert.deepEqual(readings, [
      "Prior: Dry Eye · Gland Function · Expressibility: Reduced · Sep 7, 2023",
      "Prior: Dry Eye · Gland Function · Secretion quality: Inspissated · Sep 7, 2023",
      "Prior: Dry Eye · Gland Function · Glands yielding liquid: 7 · Sep 7, 2023",
    ]);
  } finally {
    renderer.unmount();
  }
});

test("absent dry-eye gland data renders no placeholder, empty row, or reserved reader space", async () => {
  const catalog = await catalogDefinitions();
  const { renderer } = await renderLids(catalog, []);
  try {
    assert.equal(renderer.root.findAllByProps({ "data-related-finding-reading": "" }).length, 0);
    const visible = renderedText(renderer.root);
    assert.doesNotMatch(visible, /Dry Eye · Gland Function|No dry-eye|None recorded|No related|Related:/i);
  } finally {
    renderer.unmount();
  }
});

test("saving Lids with the reader displayed never creates, modifies, or duplicates a dry-eye Observation", async () => {
  const catalog = await catalogDefinitions();
  const dryEyeStore = structuredClone(GLAND_ROWS);
  const before = structuredClone(dryEyeStore);
  const { renderer, writes } = await renderLids(catalog, dryEyeStore);
  try {
    assert.equal(relatedReadingText(renderer).length, 3, "the read-through must be visible before the save");
    const findings = renderer.root.findAllByType(OdosChips)
      .find((chips) => chips.props.ariaLabel === "Priority ocular health findings");
    assert.ok(findings);
    await act(async () => findings.props.onChange([MGD_OPTION]));
    const save = renderer.root.findAllByType("button")
      .find((button) => button.children.join("") === "Save Ocular Health");
    assert.ok(save);
    await act(async () => save.props.onClick());
    await flushEffects();

    assert.deepEqual(writes.map((write) => new URL(write.url).pathname), [
      `/clinical-graph/custom/${encodeURIComponent(LIDS_KEY)}`,
    ]);
    assert.deepEqual(dryEyeStore, before);
  } finally {
    renderer.unmount();
  }
});

test("relatedFindingDefinitionKeys is the live switch that selects the reader source", async () => {
  const catalog = await catalogDefinitions();
  const declared = catalog.find((definition) =>
    definition.relatedFindingDefinitionKeys?.includes(LIDS_KEY)
  );
  assert.ok(declared, "the catalog contract must expose a source related to Lids & Lashes");

  const withDeclaration = await renderLids(catalog, GLAND_ROWS);
  const withoutDeclaration = await renderLids(
    catalog.map((definition) => ({ ...definition, relatedFindingDefinitionKeys: undefined })),
    GLAND_ROWS,
  );
  try {
    assert.equal(relatedReadingText(withDeclaration.renderer).length, 3);
    assert.equal(relatedReadingText(withoutDeclaration.renderer).length, 0);
  } finally {
    withDeclaration.renderer.unmount();
    withoutDeclaration.renderer.unmount();
  }
});

async function catalogDefinitions(): Promise<CustomFindingDefinition[]> {
  const fhir = {
    search: async () => ({ resourceType: "Bundle", type: "searchset", entry: [] }),
    create: async (resource: unknown) => resource,
    update: async (_resourceType: string, _id: string, resource: unknown) => resource,
  } as FindingDefinitionFhirClient;
  const result = await handleFindingDefinitionCatalogRequest({
    authenticate: async () => ({
      staffReference: "Practitioner/mgd-reader",
      actorRole: "provider",
      fhir,
    }),
    findingDefinitions: buildFindingDefinitionSeeds,
  }, { authHeader: "Bearer test" });
  assert.equal(result.status, 200);
  return (result.body as { definitions: CustomFindingDefinition[] }).definitions;
}

async function renderLids(
  catalogDefinitions: CustomFindingDefinition[],
  glandRows: GlandRow[],
  currentGlandRows: GlandRow[] = [],
): Promise<{
  renderer: ReactTestRenderer;
  writes: Array<{ url: string; body: unknown }>;
}> {
  const lids = catalogDefinitions.find((definition) => definition.stableKey === LIDS_KEY);
  assert.ok(lids);
  const writes: Array<{ url: string; body: unknown }> = [];
  const fetchImpl = (async (input, init) => {
    const url = new URL(String(input));
    if (init?.method === "POST") {
      writes.push({ url: url.toString(), body: JSON.parse(String(init.body)) });
      if (!url.pathname.endsWith(`/${encodeURIComponent(LIDS_KEY)}`)) {
        glandRows.push({
          observationReference: "Observation/duplicated-by-lids-save",
          recordedAt: "2026-09-07T12:00:00.000Z",
          eye: "OD",
          values: [],
        });
      }
      return jsonResponse({ eyes: { OD: { observationReference: "Observation/lids-od" } } });
    }
    if (url.pathname.endsWith(`/${encodeURIComponent(LIDS_KEY)}/history`)) {
      return jsonResponse({
        rows: url.searchParams.has("encounter")
          ? [{
              observationReference: "Observation/lids-current",
              recordedAt: "2026-09-07T12:00:00.000Z",
              eye: "OD",
              state: "abnormal",
              values: [],
            }]
          : [],
      });
    }
    return jsonResponse({
      rows: url.searchParams.has("encounter")
        ? currentGlandRows
        : [...currentGlandRows, ...glandRows],
    });
  }) as typeof fetch;
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(React.createElement(
      OcularHealthSection as React.ComponentType<Record<string, unknown>>,
      {
        definitions: [lids],
        catalogDefinitions,
        patientReference: PATIENT_REFERENCE,
        encounterReference: ENCOUNTER_REFERENCE,
        encounterRecordedAt: ENCOUNTER_RECORDED_AT,
        onSaved: () => undefined,
        apiBase: "http://test",
        fetchImpl,
      },
    ));
    await flushEffects();
    await flushEffects();
  });
  return { renderer, writes };
}

function relatedReadingText(renderer: ReactTestRenderer): string[] {
  return renderer.root.findAllByProps({ "data-related-finding-reading": "" })
    .map((node) => renderedText(node));
}

function renderedText(node: ReactTestInstance): string {
  return node.children.map((child) => typeof child === "string" ? child : renderedText(child)).join("");
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

async function flushEffects(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}
