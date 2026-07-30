import assert from "node:assert/strict";
import { test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { act, create } from "react-test-renderer";
import {
  CATALOG_COLOR_PALETTE,
  CatalogFieldKit,
  CurrencyInput,
  WeeklyHoursEditor,
  type CatalogFieldDescriptor,
} from "../src/components/settings/CatalogFields";
import { packageDescriptor } from "../src/components/commercial/PackageDefinitionsSettings";
import {
  CatalogFieldValidationError,
  buildCatalogFields,
  parseCatalogFields,
} from "../src/lib/catalog-field-kernel";
import { SCHEDULER_PALETTE } from "../src/lib/scheduling";
import {
  coatingOptionDescriptor,
  modifierOptionDescriptor,
} from "../src/scenes/settings/LensCatalogSettings";
import {
  contactLensPricingDescriptor,
  framePricingDescriptor,
} from "../src/scenes/settings/OpticalPricingSettings";
import { planProfileDescriptor } from "../src/scenes/settings/PlanProfilesSettings";

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
  { type: "currency", key: "priceCents", label: "Price", min: 0 },
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
    type: "multi-select",
    key: "tags",
    label: "Tags",
    options: [
      { value: "routine", label: "Routine" },
      { value: "urgent", label: "Urgent" },
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
  priceCents: 42_500,
  kind: "house",
  tags: ["routine"],
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
  assert.match(html, /aria-label="Tags"/);
  assert.match(html, /aria-pressed="true"[^>]*>Routine/);
  assert.match(html, /Stored reference: InsurancePlan\/fixture/);
  assert.match(html, /type="checkbox"/);
  assert.match(html, /Add Window/);
  assert.match(html, /All Day/);
  assert.match(html, /Tue/);
  assert.match(html, /Label must be unique within this catalog/);
});

test("dynamic multi-select fields preserve values while toggling through OdosChips", () => {
  let nextValue: unknown;
  const field = FIELDS.find((candidate) => candidate.key === "tags");
  assert.ok(field);
  const renderer = create(
    <CatalogFieldKit
      fields={[field]}
      values={{ tags: ["routine"] }}
      onChange={(_key, value) => { nextValue = value; }}
    />,
  );
  const routine = renderer.root.findAllByType("button").find((button) => button.children.join("") === "Routine");
  const urgent = renderer.root.findAllByType("button").find((button) => button.children.join("") === "Urgent");
  assert.ok(routine);
  assert.ok(urgent);
  assert.equal(routine.props["aria-pressed"], true);
  assert.equal(urgent.props["aria-pressed"], false);
  act(() => urgent.props.onClick());
  assert.deepEqual(nextValue, ["routine", "urgent"]);
  act(() => renderer.unmount());
});

test("currency control displays dollars, emits integer cents, and formats two decimals on blur", () => {
  const changes: Array<number | undefined> = [];
  const renderer = create(<CurrencyInput value={42_500} ariaLabel="Package price" onChange={(value) => changes.push(value)} />);
  const input = renderer.root.findByType("input");
  assert.equal(input.props.value, "425.00");
  act(() => input.props.onFocus());
  act(() => input.props.onChange({ target: { value: "425.00" } }));
  assert.equal(changes.at(-1), 42_500);
  act(() => input.props.onBlur());
  assert.equal(renderer.root.findByType("input").props.value, "425.00");
  assert.match(JSON.stringify(renderer.toJSON()), /\$/);
  act(() => renderer.unmount());
});

test("weekly hours uses positive Open semantics and checking a closed day adds working hours", () => {
  let nextHours: Record<string, Array<{ start: string; end: string }>> | undefined;
  const renderer = create(<WeeklyHoursEditor hours={{}} onChange={(hours) => { nextHours = hours; }} />);
  const monday = renderer.root.findAllByType("input")[0];
  assert.equal(monday.props.type, "checkbox");
  assert.equal(monday.props.checked, false);
  assert.match(JSON.stringify(renderer.toJSON()), /Open/);
  act(() => monday.props.onChange({ target: { checked: true } }));
  assert.deepEqual(nextHours?.mon, [{ start: "09:00", end: "17:00" }]);
});

test("every settings cents field accepts $425.00 through the currency kernel and stores 42500 cents", () => {
  const adapter = {} as never;
  const descriptors = [
    packageDescriptor(adapter, []),
    framePricingDescriptor(adapter),
    contactLensPricingDescriptor(adapter),
    coatingOptionDescriptor(adapter),
    modifierOptionDescriptor(adapter),
    planProfileDescriptor(adapter),
  ];
  const centsFields = descriptors.flatMap((descriptor) =>
    descriptor.fields.filter((field) => field.key.endsWith("Cents")),
  );
  assert.equal(centsFields.length, 11);
  for (const field of centsFields) {
    assert.equal(field.type, "currency", field.key);
    assert.doesNotMatch(field.label, /cents/i, field.key);
    assert.equal(buildCatalogFields({ [field.key]: 42_500 }, [field])[field.key], 42_500, field.key);
  }
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
