import assert from "node:assert/strict";
import { test } from "node:test";
import {
  assertRelativeFhirReference,
  isRelativeFhirReference,
  parseRelativeFhirReference,
} from "../src/fhir/reference.js";

test("relative FHIR reference validator accepts the FHIR id grammar", () => {
  assert.deepEqual(parseRelativeFhirReference("Practitioner/abc-123"), {
    resourceType: "Practitioner",
    id: "abc-123",
  });
  assert.equal(isRelativeFhirReference("Practitioner/a.b-9", "Practitioner"), true);
});

test("relative FHIR reference validator rejects missing, empty, whitespace, and nested ids", () => {
  for (const reference of [
    "Practitioner/",
    "Practitioner",
    "Practitioner/ ",
    "Practitioner//x",
    "",
    undefined,
  ]) {
    assert.equal(isRelativeFhirReference(reference, "Practitioner"), false);
    assert.throws(
      () => assertRelativeFhirReference(reference, "Practitioner"),
      /Practitioner\/<id>/,
    );
  }
});

test("relative FHIR reference validator enforces the expected resource type and 64-character id limit", () => {
  assert.equal(isRelativeFhirReference("Patient/abc", "Practitioner"), false);
  assert.equal(isRelativeFhirReference(`Patient/${"a".repeat(64)}`, "Patient"), true);
  assert.equal(isRelativeFhirReference(`Patient/${"a".repeat(65)}`, "Patient"), false);
});
