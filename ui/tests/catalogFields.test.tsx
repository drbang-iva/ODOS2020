import assert from "node:assert/strict";
import { test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  CATALOG_COLOR_PALETTE,
  CatalogFieldKit,
  type CatalogFieldDescriptor,
} from "../src/components/settings/CatalogFields";
import {
  CatalogFieldValidationError,
  buildCatalogFields,
  parseCatalogFields,
} from "../src/lib/catalog-field-kernel";
import { SCHEDULER_PALETTE } from "../src/lib/scheduling";

const FIELDS: readonly CatalogFieldDescriptor[] = [
  { type: "text", key: "label", label: "Label", required: true, unique: true },
  {
    type: "color",
    key: "color",
    label: "Color",
    palette: [SCHEDULER_PALETTE.newExamBlue, SCHEDULER_PALETTE.establishedTeal],
  },
  { type: "duration", key: "duration", label: "Duration", min: 5, max: 120 },
  { type: "number", key: "threshold", label: "Threshold", min: 1, max: 60, integer: true },
  {
    type: "select",
    key: "kind",
    label: "Kind",
    options: [
      { value: "house", label: "House" },
      { value: "vision", label: "Vision" },
    ],
  },
  {
    type: "reference-picker",
    key: "plan",
    label: "Plan",
    search: async () => [{ reference: "InsurancePlan/fixture", display: "Fixture Plan" }],
  },
  { type: "toggle", key: "active", label: "Active" },
  { type: "weekly-hours", key: "hours", label: "Hours" },
  { type: "time-window-weekdays", key: "window", label: "Window" },
];

const VALUES = {
  label: "Comprehensive",
  color: SCHEDULER_PALETTE.newExamBlue,
  duration: 30,
  threshold: 10,
  kind: "house",
  plan: "InsurancePlan/fixture",
  active: true,
  hours: { mon: [{ start: "09:00", end: "17:00" }] },
  window: { weekdays: ["tue", "thu"], start: "10:00", end: "12:00" },
};

test("CatalogFieldKit renders every S1 field type including extracted scheduler time controls", () => {
  const html = renderToStaticMarkup(
    <CatalogFieldKit
      fields={FIELDS}
      values={VALUES}
      errors={{ label: "Label must be unique within this catalog." }}
      onChange={() => undefined}
    />,
  );

  assert.ok(CATALOG_COLOR_PALETTE.includes(SCHEDULER_PALETTE.newExamBlue));
  assert.match(html, /Comprehensive/);
  assert.match(html, /role="radiogroup"/);
  assert.match(html, /type="number"/);
  assert.match(html, /House/);
  assert.match(html, /Stored reference: InsurancePlan\/fixture/);
  assert.match(html, /type="checkbox"/);
  assert.match(html, /Add Window/);
  assert.match(html, /All Day/);
  assert.match(html, /Tue/);
  assert.match(html, /Label must be unique within this catalog/);
});

test("catalog field build/parse validates uniqueness, bounds, palette, references, and time windows verbatim", () => {
  const parsed = parseCatalogFields(VALUES, FIELDS);
  assert.deepEqual(buildCatalogFields(parsed, FIELDS, [], "fixture-1"), VALUES);

  assert.throws(
    () => buildCatalogFields(VALUES, FIELDS, [{ id: "fixture-2", label: "comprehensive" }], "fixture-1"),
    (error) =>
      error instanceof CatalogFieldValidationError &&
      error.fieldKey === "label" &&
      error.message === "Label must be unique within this catalog.",
  );
  assert.throws(
    () => buildCatalogFields({ ...VALUES, duration: 121 }, FIELDS),
    { message: "Duration must be at most 120." },
  );
  assert.throws(
    () => buildCatalogFields({ ...VALUES, threshold: 1.5 }, FIELDS),
    { message: "Threshold must be a whole number." },
  );
  assert.throws(
    () => buildCatalogFields({ ...VALUES, color: "#ffffff" }, FIELDS),
    { message: "Color must use the constrained catalog palette." },
  );
  assert.throws(
    () => buildCatalogFields({ ...VALUES, plan: "fixture" }, FIELDS),
    { message: "Plan must be a FHIR reference." },
  );
  assert.throws(
    () =>
      buildCatalogFields(
        { ...VALUES, window: { weekdays: ["mon"], start: "12:00", end: "11:00" } },
        FIELDS,
      ),
    { message: "Window time window must end after it starts (12:00–11:00)." },
  );
});
