import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DEFAULT_VISIT_TYPE_CATEGORIES,
  buildVisitTypeConfigResource,
  parseVisitTypeConfig,
  type PersistedVisitTypeConfig,
} from "../src/scheduling/visit-type-config.js";

const CONFIG: PersistedVisitTypeConfig = {
  categories: [
    { id: "comprehensive", label: "Comprehensive", order: 0 },
    { id: "dry-eye", label: "Dry Eye", order: 1, active: false },
  ],
};

test("visit-type config round-trips and preserves Basic id/meta", () => {
  const existing = {
    resourceType: "Basic" as const,
    id: "visit-config-1",
    meta: { versionId: "7" },
    code: { text: "old" },
  };
  const built = buildVisitTypeConfigResource(CONFIG, existing);
  assert.equal(built.id, existing.id);
  assert.deepEqual(built.meta, existing.meta);
  assert.deepEqual(parseVisitTypeConfig(built), CONFIG);
});

test("visit-type config strips active unless false and starter seed is exact", () => {
  const built = buildVisitTypeConfigResource({
    categories: [
      { id: "one", label: "One", order: 0, active: true },
      { id: "two", label: "Two", order: 1, active: false },
    ],
  });
  const raw = JSON.parse(built.extension?.[0]?.valueString ?? "{}") as PersistedVisitTypeConfig;
  assert.equal("active" in raw.categories[0]!, false);
  assert.equal(raw.categories[1]?.active, false);
  assert.deepEqual(
    DEFAULT_VISIT_TYPE_CATEGORIES.map(({ id, label }) => ({ id, label })),
    [
      { id: "exams", label: "Exams" },
      { id: "contact-lens", label: "Contact Lens" },
      { id: "medical", label: "Medical" },
    ],
  );
});

test("visit-type config validators enforce required unique labels and kebab ids verbatim", () => {
  assert.throws(
    () => buildVisitTypeConfigResource({ categories: [{ id: "bad id", label: "Bad", order: 0 }] }),
    { message: 'Visit-type category id "bad id" must be immutable kebab-case.' },
  );
  assert.throws(
    () => buildVisitTypeConfigResource({ categories: [{ id: "blank", label: " ", order: 0 }] }),
    { message: "Visit-type category label is required." },
  );
  assert.throws(
    () =>
      buildVisitTypeConfigResource({
        categories: [
          { id: "one", label: "Dry Eye", order: 0 },
          { id: "two", label: " dry eye ", order: 1 },
        ],
      }),
    { message: 'Visit-type category label "dry eye" must be unique.' },
  );
});
