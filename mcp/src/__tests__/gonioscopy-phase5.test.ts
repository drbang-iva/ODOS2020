import assert from "node:assert/strict";
import test from "node:test";
import type { Bundle, Encounter, Observation } from "@medplum/fhirtypes";
import {
  buildGonioQuadrantObservation,
  GONIO_EYES,
  GONIO_QUADRANTS,
  parseGonioQuadrantObservation,
  protocolFindingToGonioObservation,
  type GonioQuadrantRecord,
} from "../clinical-graph/gonioscopy.js";
import { handleGonioscopyCaptureRequest, handleGonioscopyReadRequest, latestRecords } from "../clinical-graph/gonioscopy-endpoint.js";
import type { ProtocolFindingInstance } from "../clinical-graph/protocol-types.js";

test("gonioscopy-phase5.test.ts is included in full MCP discovery", () => {
  assert.ok(true);
});

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
        async read<T extends Encounter>(): Promise<T> {
          return { resourceType: "Encounter", subject: { reference: "Patient/patient-1" } } as T;
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

test("gonioscopy read ignores newer invalidated quadrant, pigmentation, and note records", async () => {
  const angle = (value: "ss" | "ptm", at: string, status: Observation["status"]) => ({
    ...buildGonioQuadrantObservation({
      encounterReference: "Encounter/enc-1", patientReference: "Patient/patient-1",
      actorReference: "Practitioner/test", recordedAt: at,
      record: { eye: "OD", quadrant: "superior", value, entryMode: "quadrant-specific", source: "clinician-entered" },
    }), status,
  });
  const observations: Record<string, Observation[]> = {
    gonio_angle_structures: [angle("ss", "2026-07-18T10:00:00.000Z", "final"), angle("ptm", "2026-07-18T12:00:00.000Z", "entered-in-error")],
    gonio_tm_pigmentation: [
      simpleReadObservation("gonio_tm_pigmentation", "1+", "2026-07-18T10:00:00.000Z", "OD"),
      { ...simpleReadObservation("gonio_tm_pigmentation", "4+", "2026-07-18T12:00:00.000Z", "OD"), status: "cancelled" },
    ],
    gonio_note: [
      simpleReadObservation("gonio_note", "Valid note", "2026-07-18T10:00:00.000Z"),
      { ...simpleReadObservation("gonio_note", "Invalid note", "2026-07-18T12:00:00.000Z"), status: "entered-in-error" },
    ],
  };
  const result = await handleGonioscopyReadRequest(gonioDeps(observations), {
    authHeader: "Bearer test", query: { encounterReference: "Encounter/enc-1" },
  });
  const body = result.body as { records: GonioQuadrantRecord[]; pigmentation: Record<string, string>; note: string };
  assert.equal(body.records[0]?.value, "ss");
  assert.deepEqual(body.pigmentation, { OD: "1+" });
  assert.equal(body.note, "Valid note");
});

test("gonioscopy parser rejects missing or invalid provenance extensions", () => {
  const valid = buildGonioQuadrantObservation({
    encounterReference: "Encounter/enc-1", patientReference: "Patient/patient-1",
    actorReference: "Practitioner/test", recordedAt: "2026-07-18T10:00:00.000Z",
    record: { eye: "OD", quadrant: "superior", value: "ss", entryMode: "quadrant-specific", source: "clinician-entered" },
  });
  assert.ok(parseGonioQuadrantObservation(valid));
  assert.equal(parseGonioQuadrantObservation({ ...valid, extension: [] }), undefined);
  assert.equal(parseGonioQuadrantObservation({
    ...valid,
    extension: valid.extension?.map((extension) =>
      extension.url.endsWith("gonio-entry-mode") ? { ...extension, valueCode: "invalid" } : extension),
  }), undefined);
  assert.equal(parseGonioQuadrantObservation({
    ...valid,
    extension: valid.extension?.map((extension) =>
      extension.url.endsWith("finding-source") ? { ...extension, valueCode: "invalid" } : extension),
  }), undefined);
});

test("gonioscopy capture verifies encounter ownership and codes pigmentation", async () => {
  const created: Observation[] = [];
  const matching = gonioDeps({}, created);
  const body = {
    patientReference: "Patient/patient-1", encounterReference: "Encounter/enc-1", records: [],
    pigmentation: { OD: "2+" }, note: "Open to SS",
  };
  const saved = await handleGonioscopyCaptureRequest(matching, { authHeader: "Bearer test", body });
  assert.equal(saved.status, 200);
  const pigmentation = created.find((observation) => observation.code.coding?.[0]?.code === "gonio_tm_pigmentation");
  assert.equal(pigmentation?.valueString, undefined);
  assert.deepEqual(pigmentation?.valueCodeableConcept?.coding?.[0], {
    system: "https://odos2020.com/fhir/CodeSystem/gonio-tm-pigmentation", code: "2+",
  });

  created.length = 0;
  const mismatch = gonioDeps({}, created, "Patient/other");
  const rejected = await handleGonioscopyCaptureRequest(mismatch, { authHeader: "Bearer test", body });
  assert.equal(rejected.status, 400);
  assert.equal(created.length, 0);
});

function gonioDeps(
  observations: Record<string, Observation[]>,
  created: Observation[] = [],
  encounterPatient = "Patient/patient-1",
) {
  return {
    authenticate: async () => ({
      staffReference: "Practitioner/test", actorRole: "clinician" as const,
      fhir: {
        async search<T extends Observation>(_type: T["resourceType"], params?: Record<string, string>): Promise<Bundle<T>> {
          const code = params?.code?.split("|")[1] ?? "";
          return { resourceType: "Bundle", type: "searchset", entry: (observations[code] ?? []).map((resource) => ({ resource: resource as T })) };
        },
        async create<T extends Observation>(resource: T): Promise<T> { created.push(resource); return resource; },
        async read<T extends Encounter>(): Promise<T> {
          return { resourceType: "Encounter", subject: { reference: encounterPatient } } as T;
        },
      },
    }),
  };
}

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
    ...(code === "gonio_tm_pigmentation"
      ? { valueCodeableConcept: { coding: [{ system: "https://odos2020.com/fhir/CodeSystem/gonio-tm-pigmentation", code: value }] } }
      : { valueString: value }),
  };
}
