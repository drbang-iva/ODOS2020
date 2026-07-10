import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildCatalogFields as mcpBuildCatalogFields,
  type CatalogFieldDefinition as McpCatalogFieldDefinition,
} from "../src/settings/catalog-field-kernel.js";
import {
  buildCatalogFields as uiBuildCatalogFields,
  type CatalogFieldDefinition as UiCatalogFieldDefinition,
} from "../../ui/src/lib/catalog-field-kernel.js";

test("reference-picker text mode stores a payer display string while default mode remains FHIR-only", () => {
  const mcpText: McpCatalogFieldDefinition[] = [
    { type: "reference-picker", key: "payer", label: "Payer name", required: true, valueKind: "text" },
  ];
  const uiText: UiCatalogFieldDefinition[] = [
    { type: "reference-picker", key: "payer", label: "Payer name", required: true, valueKind: "text" },
  ];
  assert.deepEqual(
    uiBuildCatalogFields({ payer: "  VSP Choice  " }, uiText),
    mcpBuildCatalogFields({ payer: "  VSP Choice  " }, mcpText),
  );
  assert.deepEqual(uiBuildCatalogFields({ payer: "  VSP Choice  " }, uiText), { payer: "VSP Choice" });

  const uiReference: UiCatalogFieldDefinition[] = [
    { type: "reference-picker", key: "payer", label: "Payer", required: true },
  ];
  assert.throws(
    () => uiBuildCatalogFields({ payer: "VSP Choice" }, uiReference),
    /must be a FHIR reference/,
  );
});
