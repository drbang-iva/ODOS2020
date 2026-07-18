import assert from "node:assert/strict";
import test from "node:test";
import type { Bundle, Observation } from "@medplum/fhirtypes";
import {
  buildGonioQuadrantObservation,
  GONIO_EYES,
  GONIO_QUADRANTS,
  parseGonioQuadrantObservation,
  protocolFindingToGonioObservation,
} from "../clinical-graph/gonioscopy.js";
import { handleGonioscopyReadRequest, latestRecords } from "../clinical-graph/gonioscopy-endpoint.js";
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

test("gonioscopy read returns the latest quadrant, pigmentation, and note records", async () => {
  const angle = buildGonioQuadrantObservation({
    encounterReference: "Encounter/enc-1",
    patientReference: "Patient/patient-1",
    actorReference: "Practitioner/test",
    recordedAt: "2026-07-18T12:00:00.000Z",
    record: {
      eye: "OD",
      quadrant: "superior",
      value: "ss",
      entryMode: "propagated-uniform",
      source: "clinician-entered",
    },
  });
  const observations: Record<string, Observation[]> = {
    gonio_angle_structures: [angle],
    gonio_tm_pigmentation: [
      simpleReadObservation("gonio_tm_pigmentation", "1+", "2026-07-18T11:00:00.000Z", "OD"),
      simpleReadObservation("gonio_tm_pigmentation", "3+", "2026-07-18T12:00:00.000Z", "OD"),
      simpleReadObservation("gonio_tm_pigmentation", "2+", "2026-07-18T12:00:00.000Z", "OS"),
    ],
    gonio_note: [
      simpleReadObservation("gonio_note", "Earlier note", "2026-07-18T11:00:00.000Z"),
      simpleReadObservation("gonio_note", "Latest note", "2026-07-18T12:00:00.000Z"),
    ],
  };
  const searchedCodes: string[] = [];
  const result = await handleGonioscopyReadRequest({
    authenticate: async () => ({
      staffReference: "Practitioner/test",
      actorRole: "clinician",
      fhir: {
        async search<T extends Observation>(_type: T["resourceType"], params?: Record<string, string>): Promise<Bundle<T>> {
          const code = params?.code?.split("|")[1] ?? "";
          searchedCodes.push(code);
          return {
            resourceType: "Bundle",
            type: "searchset",
            entry: (observations[code] ?? []).map((resource) => ({ resource: resource as T })),
          };
        },
        async create<T extends Observation>(resource: T): Promise<T> {
          return resource;
        },
      },
    }),
  }, {
    authHeader: "Bearer test",
    query: { encounterReference: "Encounter/enc-1" },
  });

  assert.equal(result.status, 200);
  assert.deepEqual(new Set(searchedCodes), new Set([
    "gonio_angle_structures",
    "gonio_tm_pigmentation",
    "gonio_note",
  ]));
  const body = result.body as {
    records: Array<{ eye: string; quadrant: string; value: string }>;
    pigmentation: Record<string, string>;
    note: string;
  };
  assert.equal(body.records.length, 1);
  assert.deepEqual(body.pigmentation, { OD: "3+", OS: "2+" });
  assert.equal(body.note, "Latest note");
});

function simpleReadObservation(code: string, value: string, at: string, eye?: "OD" | "OS"): Observation {
  return {
    resourceType: "Observation",
    status: "final",
    code: { coding: [{ system: "https://odos2020.com/fhir/CodeSystem/odos", code }] },
    subject: { reference: "Patient/patient-1" },
    encounter: { reference: "Encounter/enc-1" },
    effectiveDateTime: at,
    ...(eye
      ? { bodySite: { coding: [{ system: "https://odos2020.com/fhir/CodeSystem/laterality", code: eye }] } }
      : {}),
    valueString: value,
  };
}
