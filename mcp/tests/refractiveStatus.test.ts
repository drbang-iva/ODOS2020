import assert from "node:assert/strict";
import { test } from "node:test";
import type { Observation } from "@medplum/fhirtypes";
import {
  classifySphericalEquivalent,
  LEGACY_ODOS_OPHTHALMOLOGY_CODE_SYSTEM,
  resolveRefractiveStatus,
  sphericalEquivalent,
} from "../src/clinical-graph/refractive-status.js";
import { ODOS_OPHTHALMOLOGY_CODE_SYSTEM } from "../src/fhir/ophthalmology/codeBindings.js";

test("spherical-equivalent classification covers all statuses and pins both boundaries", () => {
  assert.equal(sphericalEquivalent({ sphere: -0.25, cylinder: -0.5 }), -0.5);
  assert.equal(sphericalEquivalent({ sphere: 1, cylinder: -0.5 }), 0.75);
  assert.equal(sphericalEquivalent({}), undefined);

  for (const [value, expected] of [
    [-1.5, "MYOPIC"],
    [-0.5, "MYOPIC"],
    [-0.5 + 5e-10, "MYOPIC"],
    [-0.49, "PRE_MYOPIA"],
    [0.75, "PRE_MYOPIA"],
    [0.75 + 5e-10, "PRE_MYOPIA"],
    [0.751, "NOT_MYOPIC"],
  ] as const) {
    assert.equal(classifySphericalEquivalent(value), expected);
  }

  assert.deepEqual(
    resolveRefractiveStatus([], "OD", "2026-03-14T12:00:00Z"),
    {
      status: "UNKNOWN",
      sphericalEquivalent: null,
      refractionType: null,
      refractionDate: null,
      observationReference: null,
      candidates: [],
    },
  );
});

test("cycloplegic is the resolved default while both candidates remain independently classified", () => {
  const status = resolveRefractiveStatus([
    refraction("manifest", "MANIFEST", "2026-03-14T10:00:00Z", "OD", -1.5),
    refraction("cycloplegic", "CYCLOPLEGIC", "2026-03-14T11:00:00Z", "OD", -0.25),
  ], "OD", "2026-03-14T12:00:00Z");

  assert.deepEqual(status, {
    status: "PRE_MYOPIA",
    sphericalEquivalent: -0.25,
    refractionType: "CYCLOPLEGIC",
    refractionDate: "2026-03-14T11:00:00Z",
    observationReference: "Observation/cycloplegic",
    candidates: [
      {
        refractionType: "CYCLOPLEGIC",
        sphericalEquivalent: -0.25,
        status: "PRE_MYOPIA",
        refractionDate: "2026-03-14T11:00:00Z",
        observationReference: "Observation/cycloplegic",
      },
      {
        refractionType: "MANIFEST",
        sphericalEquivalent: -1.5,
        status: "MYOPIC",
        refractionDate: "2026-03-14T10:00:00Z",
        observationReference: "Observation/manifest",
      },
    ],
  });
});

test("pairing is per eye and type and prefers the same encounter regardless of intra-visit ordering", () => {
  const status = resolveRefractiveStatus([
    refraction(
      "other-eye",
      "CYCLOPLEGIC",
      "2026-03-14T11:30:00Z",
      "OS",
      -3,
      undefined,
      ODOS_OPHTHALMOLOGY_CODE_SYSTEM,
      "Encounter/current",
    ),
    refraction(
      "same-encounter-after",
      "CYCLOPLEGIC",
      "2026-03-14T12:00:01Z",
      "OD",
      -4,
      undefined,
      ODOS_OPHTHALMOLOGY_CODE_SYSTEM,
      "Encounter/current",
    ),
    refraction("older", "CYCLOPLEGIC", "2018-01-01T10:00:00Z", "OD", -0.75),
    refraction("latest", "CYCLOPLEGIC", "2020-01-01T10:00:00Z", "OD", -1),
    refraction("manifest-old", "MANIFEST", "2017-01-01T10:00:00Z", "OD", 1),
  ], "OD", "2026-03-14T12:00:00Z", "Encounter/current");

  assert.equal(status.refractionType, "CYCLOPLEGIC");
  assert.equal(status.observationReference, "Observation/same-encounter-after");
  assert.deepEqual(
    status.candidates.map((candidate) => [
      candidate.refractionType,
      candidate.observationReference,
    ]),
    [
      ["CYCLOPLEGIC", "Observation/same-encounter-after"],
      ["MANIFEST", "Observation/manifest-old"],
    ],
  );
});

test("a refraction from a later encounter never pairs backwards", () => {
  const status = resolveRefractiveStatus([
    refraction(
      "prior",
      "MANIFEST",
      "2020-01-01T10:00:00Z",
      "OD",
      -1,
      undefined,
      ODOS_OPHTHALMOLOGY_CODE_SYSTEM,
      "Encounter/prior",
    ),
    refraction(
      "later-encounter",
      "MANIFEST",
      "2026-03-14T12:00:01Z",
      "OD",
      -4,
      undefined,
      ODOS_OPHTHALMOLOGY_CODE_SYSTEM,
      "Encounter/later",
    ),
  ], "OD", "2026-03-14T12:00:00Z", "Encounter/current");

  assert.equal(status.status, "MYOPIC");
  assert.equal(status.observationReference, "Observation/prior");
});

test("cancelled and entered-in-error refractions are excluded", () => {
  const status = resolveRefractiveStatus([
    refraction(
      "cancelled",
      "CYCLOPLEGIC",
      "2026-03-14T13:00:00Z",
      "OD",
      -6,
      undefined,
      ODOS_OPHTHALMOLOGY_CODE_SYSTEM,
      "Encounter/current",
      "cancelled",
    ),
    refraction(
      "entered-in-error",
      "MANIFEST",
      "2026-03-14T13:00:00Z",
      "OD",
      -7,
      undefined,
      ODOS_OPHTHALMOLOGY_CODE_SYSTEM,
      "Encounter/current",
      "entered-in-error",
    ),
  ], "OD", "2026-03-14T12:00:00Z", "Encounter/current");

  assert.equal(status.status, "UNKNOWN");
  assert.deepEqual(status.candidates, []);
});

test("preliminary refractions remain eligible clinical evidence", () => {
  const status = resolveRefractiveStatus([
    refraction(
      "preliminary",
      "MANIFEST",
      "2026-03-14T13:00:00Z",
      "OD",
      -1,
      undefined,
      ODOS_OPHTHALMOLOGY_CODE_SYSTEM,
      "Encounter/current",
      "preliminary",
    ),
  ], "OD", "2026-03-14T12:00:00Z", "Encounter/current");

  assert.equal(status.status, "MYOPIC");
  assert.equal(status.observationReference, "Observation/preliminary");
});

test("all permanently excluded refraction types are ignored", () => {
  const observations = [
    "FINAL_RX",
    "OVER_REFRACTION",
    "POST_ORTHO_K",
    "RETINOSCOPY",
    "OTHER",
  ].map((type, index) =>
    refraction(`excluded-${index}`, type, `2026-03-${String(index + 1).padStart(2, "0")}T10:00:00Z`, "OD", -6));

  assert.equal(
    resolveRefractiveStatus(observations, "OD", "2026-03-14T12:00:00Z").status,
    "UNKNOWN",
  );
});

test("legacy osod.dev-coded refractions remain eligible on the read path", () => {
  const status = resolveRefractiveStatus([
    refraction(
      "legacy-manifest",
      "MANIFEST",
      "2026-03-14T10:00:00Z",
      "OD",
      -0.5,
      undefined,
      LEGACY_ODOS_OPHTHALMOLOGY_CODE_SYSTEM,
    ),
  ], "OD", "2026-03-14T12:00:00Z");

  assert.equal(status.status, "MYOPIC");
  assert.equal(status.observationReference, "Observation/legacy-manifest");
});

function refraction(
  id: string,
  type: string,
  date: string,
  eye: "OD" | "OS",
  sphere?: number,
  cylinder?: number,
  system = ODOS_OPHTHALMOLOGY_CODE_SYSTEM,
  encounterReference?: string,
  status: Observation["status"] = "final",
): Observation {
  return {
    resourceType: "Observation",
    id,
    status,
    code: concept(system, "REFRACTION"),
    subject: { reference: "Patient/p1" },
    ...(encounterReference ? { encounter: { reference: encounterReference } } : {}),
    effectiveDateTime: date,
    bodySite: concept(system, eye),
    component: [
      {
        code: concept(system, "REFRACTION_TYPE"),
        valueCodeableConcept: concept(system, type),
      },
      ...(sphere === undefined
        ? []
        : [{
            code: concept(system, "SPHERE"),
            valueQuantity: { value: sphere, unit: "D", system: "http://unitsofmeasure.org", code: "[diop]" },
          }]),
      ...(cylinder === undefined
        ? []
        : [{
            code: concept(system, "CYLINDER"),
            valueQuantity: { value: cylinder, unit: "D", system: "http://unitsofmeasure.org", code: "[diop]" },
          }]),
    ],
  };
}

function concept(system: string, code: string) {
  return { coding: [{ system, code }] };
}
