import assert from "node:assert/strict";
import { test } from "node:test";
import { buildEyeBodyStructure as buildMcpEyeBodyStructure } from "../src/fhir/ophthalmology/bodyStructure.js";
import { buildIopObservation as buildMcpIopObservation } from "../src/fhir/ophthalmology/iop.js";
import { buildRefractionObservation as buildMcpRefractionObservation } from "../src/fhir/ophthalmology/refraction.js";
import { buildSectionSaveBundle as buildMcpSectionSaveBundle } from "../src/fhir/ophthalmology/save-section-bundle.js";
import { buildVisualAcuityObservation as buildMcpVisualAcuityObservation } from "../src/fhir/ophthalmology/visualAcuity.js";
import { buildEyeBodyStructure as buildUiEyeBodyStructure } from "../../ui/src/lib/fhir-ophthalmology/bodyStructure.js";
import { buildIopObservation as buildUiIopObservation } from "../../ui/src/lib/fhir-ophthalmology/iop.js";
import { buildRefractionObservation as buildUiRefractionObservation } from "../../ui/src/lib/fhir-ophthalmology/refraction.js";
import { buildSectionSaveBundle as buildUiSectionSaveBundle } from "../../ui/src/lib/fhir-ophthalmology/save-section-bundle.js";
import { buildVisualAcuityObservation as buildUiVisualAcuityObservation } from "../../ui/src/lib/fhir-ophthalmology/visualAcuity.js";
import { osodConcept as mcpOsodConcept } from "../src/fhir/ophthalmology/extensions.js";
import { osodConcept as uiOsodConcept } from "../../ui/src/lib/fhir-ophthalmology/extensions.js";

const common = {
  patientReference: "Patient/p1",
  encounterReference: "Encounter/e1",
  eye: "OD" as const,
  measuredAt: "2026-04-25T12:00:00.000Z",
};

test("UI ophthalmology mirror matches MCP IOP builder output", () => {
  assertJsonEqual(
    buildMcpIopObservation({
      ...common,
      value: 14,
      method: mcpOsodConcept("GAT", "GAT"),
    }),
    buildUiIopObservation({
      ...common,
      value: 14,
      method: uiOsodConcept("GAT", "GAT"),
    }),
  );
});

test("UI ophthalmology mirror matches MCP refraction builder output", () => {
  assertJsonEqual(
    buildMcpRefractionObservation({
      ...common,
      refractionType: "MANIFEST",
      sphere: -1.25,
      cylinder: -0.5,
      axis: 90,
      add: 2,
    }),
    buildUiRefractionObservation({
      ...common,
      refractionType: "MANIFEST",
      sphere: -1.25,
      cylinder: -0.5,
      axis: 90,
      add: 2,
    }),
  );
});

test("UI ophthalmology mirror matches MCP visual acuity builder output", () => {
  assertJsonEqual(
    buildMcpVisualAcuityObservation({
      ...common,
      snellen: "20/25",
      chartType: "SNELLEN",
      correction: "SC",
    }),
    buildUiVisualAcuityObservation({
      ...common,
      snellen: "20/25",
      chartType: "SNELLEN",
      correction: "SC",
    }),
  );
});

test("UI ophthalmology mirror matches MCP BodyStructure builder output", () => {
  assertJsonEqual(
    buildMcpEyeBodyStructure("OS", "Patient/p1"),
    buildUiEyeBodyStructure("OS", "Patient/p1"),
  );
});

test("UI ophthalmology mirror matches MCP section-save composer output", () => {
  const input = {
    patientReference: "Patient/p1",
    encounterReference: "Encounter/e1",
    section: "iop" as const,
    operatorDisplay: "OSOD parity test",
    measuredAt: "2026-04-25T12:00:00.000Z",
    recordedAt: "2026-04-25T12:00:00.001Z",
    entries: [
      { laterality: "OD" as const, value: 14, method: "GAT" as const },
      { laterality: "OS" as const, value: 15, method: "GAT" as const },
    ],
  };

  assertJsonEqual(
    buildMcpSectionSaveBundle(input),
    buildUiSectionSaveBundle(input),
  );
});

function assertJsonEqual(left: unknown, right: unknown): void {
  assert.equal(JSON.stringify(left), JSON.stringify(right));
}
