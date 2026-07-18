import assert from "node:assert/strict";
import test from "node:test";
import type { Observation } from "@medplum/fhirtypes";
import {
  buildGonioQuadrantObservation,
  GONIO_EYES,
  GONIO_QUADRANTS,
  parseGonioQuadrantObservation,
  protocolFindingToGonioObservation,
} from "../clinical-graph/gonioscopy.js";
import { latestRecords } from "../clinical-graph/gonioscopy-endpoint.js";
import type { ProtocolFindingInstance } from "../clinical-graph/protocol-types.js";

test("protocol default round-trips as 8 SS quadrant records and one override preserves the other seven", () => {
  const seeded = GONIO_EYES.flatMap((laterality) => GONIO_QUADRANTS.map((componentKey, index) => {
    const finding: ProtocolFindingInstance = {
      id: `${laterality}-${componentKey}`,
      encounterId: "enc-1",
      patientId: "patient-1",
      protocolApplicationId: "application-1",
      sourceItemKey: "gonio-angle",
      findingDefKey: "gonio_angle_structures",
      laterality,
      componentKey,
      state: "committed",
      value: "ss",
      editedBeforeCommit: false,
      provenance: {
        source: "protocol-default",
        entryMode: "propagated-uniform",
        actor: "Practitioner/test",
        at: `2026-07-18T12:00:0${index}.000Z`,
        protocolId: "glaucoma-suspect-initial",
        protocolVersion: 1,
      },
    };
    return { ...protocolFindingToGonioObservation(finding), id: `seed-${laterality}-${componentKey}` };
  }));

  const initial = latestRecords(seeded);
  assert.equal(initial.length, 8);
  assert.equal(initial.every((row) =>
    row.value === "ss" &&
    row.source === "protocol-default" &&
    row.entryMode === "propagated-uniform"
  ), true);

  const override = {
    ...buildGonioQuadrantObservation({
      encounterReference: "Encounter/enc-1",
      patientReference: "Patient/patient-1",
      actorReference: "Practitioner/clinician",
      recordedAt: "2026-07-18T12:05:00.000Z",
      record: {
        eye: "OD",
        quadrant: "superior",
        value: "ptm",
        entryMode: "quadrant-specific",
        source: "clinician-entered",
      },
    }),
    id: "override-od-superior",
  } satisfies Observation;
  const after = latestRecords([...seeded, override]);
  assert.equal(after.length, 8);
  assert.deepEqual(after.find((row) => row.eye === "OD" && row.quadrant === "superior"), {
    eye: "OD",
    quadrant: "superior",
    value: "ptm",
    entryMode: "quadrant-specific",
    source: "clinician-entered",
    observationReference: "Observation/override-od-superior",
  });
  assert.equal(after.filter((row) => row.source === "protocol-default").length, 7);
  assert.equal(parseGonioQuadrantObservation(override)?.entryMode, "quadrant-specific");
});
