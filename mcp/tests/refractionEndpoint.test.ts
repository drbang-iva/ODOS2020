import assert from "node:assert/strict";
import { test } from "node:test";
import type { Observation, Provenance } from "@medplum/fhirtypes";
import type { PracticeRoleId } from "../src/authz/roles.js";
import {
  type ClinicalGraphProvenance,
  type FindingInstance,
} from "../src/clinical-graph/glaucoma-suspect.js";
import {
  handleRefractionCaptureRequest,
  handleRefractionDefinitionRequest,
  type RefractionEndpointDeps,
} from "../src/clinical-graph/refraction-endpoint.js";
import {
  addRefractionTypeOption,
  buildRefractionFindingDefinitionStub,
  evaluateRefractiveErrorSuggestions,
  loadRefractiveErrorPhase0Ledger,
} from "../src/clinical-graph/refraction-suspect.js";

const AUTH = "Bearer good";
const BODY = {
  patientReference: "Patient/p1",
  encounterReference: "Encounter/e1",
};
const provenance: ClinicalGraphProvenance = {
  source: "manual",
  recordedAt: "2026-07-09T14:00:00.000Z",
  actorReference: "Practitioner/dr-bang",
  ledgerRefs: ["data/code-bindings/refractive-error-phase0-ledger.json"],
};

function deps(
  role: PracticeRoleId = "clinician",
  findingDefinitions?: RefractionEndpointDeps["findingDefinitions"],
) {
  const created: Array<{ resource: Observation | Provenance; headers?: Record<string, string> }> = [];
  const d: RefractionEndpointDeps = {
    findingDefinitions,
    authenticate: async (authHeader) =>
      authHeader === AUTH
        ? {
            staffReference: "Practitioner/doc1",
            actorRole: role,
            fhir: {
              create: async <T extends Observation | Provenance>(
                resource: T,
                headers?: Record<string, string>,
              ): Promise<T> => {
                created.push({ resource, headers });
                return {
                  ...resource,
                  id: resource.id ?? `${resource.resourceType.toLowerCase()}-${created.length}`,
                };
              },
            },
          }
        : null,
    now: () => "2026-07-09T14:00:00.000Z",
  };
  return { created, deps: d };
}

test("refraction definition endpoint serves practice-editable types, fields, threshold, and verified options", async () => {
  const res = await handleRefractionDefinitionRequest(deps().deps, { authHeader: AUTH });

  assert.equal(res.status, 200);
  const body = res.body as {
    definition: { fields: Record<string, { options?: Array<{ code: string }>; step?: number }> };
    diagnosisOptions: Array<{ code: string }>;
    refractiveThreshold: number;
  };
  assert.deepEqual(
    body.definition.fields.type.options?.map((option) => option.code),
    ["RETINOSCOPY", "MANIFEST", "CYCLOPLEGIC", "FINAL_RX", "OVER_REFRACTION", "POST_ORTHO_K", "OTHER"],
  );
  assert.equal(body.definition.fields.sphere.step, 0.25);
  assert.equal(body.definition.fields.axis.step, 1);
  assert.equal(body.refractiveThreshold, 0.25);
  assert.equal(body.diagnosisOptions.length, 14);
});

test("refraction endpoints enforce authentication and chart permissions", async () => {
  const missingRead = await handleRefractionDefinitionRequest(deps().deps, { authHeader: undefined });
  const forbiddenRead = await handleRefractionDefinitionRequest(deps("auditor").deps, { authHeader: AUTH });
  const missingWrite = await handleRefractionCaptureRequest(deps().deps, {
    authHeader: undefined,
    body: { ...BODY, blocks: [] },
  });
  const forbiddenWrite = await handleRefractionCaptureRequest(deps("front-desk").deps, {
    authHeader: AUTH,
    body: manifestBody(),
  });

  assert.equal(missingRead.status, 401);
  assert.equal(forbiddenRead.status, 403);
  assert.equal(missingWrite.status, 401);
  assert.equal(forbiddenWrite.status, 403);
});

test("refraction capture persists typed per-eye graph Observations with VA, Purpose, Remarks, and Provenance", async () => {
  const { created, deps: d } = deps();
  const res = await handleRefractionCaptureRequest(d, {
    authHeader: AUTH,
    body: {
      ...BODY,
      blocks: [{
        type: "FINAL_RX",
        purpose: "General wear",
        remarks: "Reduce cylinder if adaptation is difficult.",
        OD: {
          sphere: -1.25,
          cylinder: -0.5,
          axis: 90,
          add: 2,
          distanceVisualAcuity: "20/20 +1",
          nearVisualAcuity: "J1 (20/25) 4pt 0.50M",
          distancePinholeVisualAcuity: "20/15",
        },
        OS: { sphere: -1, cylinder: -0.25, axis: 85, add: 2 },
      }],
    },
  });

  assert.equal(res.status, 200);
  assert.deepEqual(created.map((entry) => entry.resource.resourceType), [
    "Observation", "Provenance", "Observation", "Provenance",
  ]);
  assert.equal(created.every((entry) => entry.headers?.["X-OSOD-Source"] === "mcp/save_section_observations"), true);
  for (const provenance of created
    .map((entry) => entry.resource)
    .filter((resource): resource is Provenance => resource.resourceType === "Provenance")) {
    assert.equal(provenance.target[1]?.reference, BODY.patientReference);
  }
  const observations = created
    .map((entry) => entry.resource)
    .filter((resource): resource is Observation => resource.resourceType === "Observation");
  assert.equal(observations.every((observation) => observation.status === "preliminary"), true);
  const observation = observations[0]!;
  assert.equal(componentValue(observation, "REFRACTION_TYPE", "code"), "FINAL_RX");
  assert.match(String(componentValue(observation, "REFRACTION_BLOCK_ID", "string")), /^refraction-block-/);
  assert.equal(componentValue(observation, "PURPOSE", "string"), "General wear");
  assert.equal(componentValue(observation, "REMARKS", "string"), "Reduce cylinder if adaptation is difficult.");
  assert.equal(componentValue(observation, "DISTANCE_VA", "string"), "20/20 +1");
  assert.equal(componentValue(observation, "NEAR_VA", "string"), "J1 (20/25) 4pt 0.50M");
  assert.equal(componentValue(observation, "DISTANCE_PH_VA", "string"), "20/15");
  assert.equal(created.some((entry) => entry.resource.resourceType === "Condition"), false);
});

test("Manifest produces all independent refractive suggestions while identical Final/Rx values produce none", async () => {
  const manifest = await handleRefractionCaptureRequest(deps().deps, {
    authHeader: AUTH,
    body: manifestBody(),
  });
  const finalRx = await handleRefractionCaptureRequest(deps().deps, {
    authHeader: AUTH,
    body: {
      ...manifestBody(),
      blocks: manifestBody().blocks.map((block) => ({ ...block, type: "FINAL_RX" })),
    },
  });

  assert.equal(manifest.status, 200);
  const manifestCodes = (manifest.body as { suggestions: Array<{ code: string }> }).suggestions
    .map((suggestion) => suggestion.code)
    .sort();
  assert.deepEqual(manifestCodes, ["H52.11", "H52.201", "H52.202", "H52.31", "H52.4", "H52.02"].sort());
  assert.equal(finalRx.status, 200);
  assert.deepEqual((finalRx.body as { suggestions: unknown[] }).suggestions, []);
});

test("Manifest threshold is inclusive for sphere, cylinder is non-zero, and anisometropia is beyond threshold", async () => {
  const threshold = await handleRefractionCaptureRequest(deps().deps, {
    authHeader: AUTH,
    body: {
      ...BODY,
      blocks: [{
        type: "MANIFEST",
        OD: { sphere: -0.25, cylinder: -0.25, axis: 180 },
        OS: { sphere: 0.25, cylinder: 0, axis: 0 },
      }],
    },
  });
  const codes = (threshold.body as { suggestions: Array<{ code: string }> }).suggestions
    .map((suggestion) => suggestion.code)
    .sort();

  assert.equal(threshold.status, 200);
  assert.deepEqual(codes, ["H52.11", "H52.201", "H52.02", "H52.31"].sort());
});

test("refraction request validation rejects empty, unknown-type, and non-quarter-diopter blocks", async () => {
  const empty = await handleRefractionCaptureRequest(deps().deps, {
    authHeader: AUTH,
    body: { ...BODY, blocks: [{ type: "MANIFEST", OD: {} }] },
  });
  const unknown = await handleRefractionCaptureRequest(deps().deps, {
    authHeader: AUTH,
    body: { ...BODY, blocks: [{ type: "UNLISTED", OD: { sphere: 0 } }] },
  });
  const increment = await handleRefractionCaptureRequest(deps().deps, {
    authHeader: AUTH,
    body: { ...BODY, blocks: [{ type: "MANIFEST", OD: { sphere: -0.3 } }] },
  });

  assert.equal(empty.status, 400);
  assert.match(String((empty.body as { error: string }).error), /populated eye/);
  assert.equal(unknown.status, 400);
  assert.match(String((unknown.body as { error: string }).error), /unknown option/);
  assert.equal(increment.status, 400);
  assert.match(String((increment.body as { error: string }).error), /0\.25 D increments/);
});

test("refraction endpoint accepts a practice-added type and never treats it as Manifest", async () => {
  const definition = addRefractionTypeOption(buildRefractionFindingDefinitionStub(provenance), {
    code: "SUBJECTIVE_CUSTOM",
    display: "Subjective custom",
    active: true,
  });
  const { deps: d } = deps("clinician", () => [definition]);
  const res = await handleRefractionCaptureRequest(d, {
    authHeader: AUTH,
    body: {
      ...BODY,
      blocks: [{ type: "SUBJECTIVE_CUSTOM", OD: { sphere: -4, cylinder: -1, axis: 90, add: 2 } }],
    },
  });

  assert.equal(res.status, 200);
  assert.deepEqual((res.body as { suggestions: unknown[] }).suggestions, []);
});

test("refractive evaluator throws when a triggered verified code is absent from the ledger", () => {
  const definition = buildRefractionFindingDefinitionStub(provenance);
  const finding: FindingInstance = {
    id: "finding-1",
    findingDefinitionId: definition.id,
    patientReference: BODY.patientReference,
    encounterReference: BODY.encounterReference,
    observationReference: "Observation/o1",
    laterality: "OD",
    value: {
      type: "json",
      value: { blockId: "block-1", refractionType: "MANIFEST", sphere: -0.25 },
    },
    sourceType: "manual",
    recordedAt: provenance.recordedAt,
    provenance,
  };

  assert.throws(
    () => evaluateRefractiveErrorSuggestions({
      findings: [finding],
      findingDefinitions: [definition],
      encounterReference: BODY.encounterReference,
      provenance,
      ledger: { diagnosisCodes: [] },
    }),
    /H52\.11 is missing from the Phase 0 ledger/,
  );
});

test("refractive evaluator honors a practice-configured threshold", () => {
  const definition = buildRefractionFindingDefinitionStub(provenance);
  const finding: FindingInstance = {
    id: "finding-threshold",
    findingDefinitionId: definition.id,
    patientReference: BODY.patientReference,
    encounterReference: BODY.encounterReference,
    laterality: "OD",
    value: {
      type: "json",
      value: { blockId: "block-threshold", refractionType: "MANIFEST", sphere: -0.25 },
    },
    sourceType: "manual",
    recordedAt: provenance.recordedAt,
    provenance,
  };

  assert.deepEqual(evaluateRefractiveErrorSuggestions({
    findings: [finding],
    findingDefinitions: [definition],
    encounterReference: BODY.encounterReference,
    provenance,
    riskConfig: { refractiveThreshold: 0.5 },
  }), []);
});

test("refractive ledger contains only the 14 allowed Phase 0 diagnosis codes", () => {
  const codes = loadRefractiveErrorPhase0Ledger().diagnosisCodes;
  assert.deepEqual(
    codes.map((row) => row.code),
    [
      "H52.00", "H52.01", "H52.02", "H52.03",
      "H52.10", "H52.11", "H52.12", "H52.13",
      "H52.201", "H52.202", "H52.203", "H52.209",
      "H52.31", "H52.4",
    ],
  );
  const astigmatismRows = codes.filter((row) => row.family === "H52.20-");
  assert.equal(astigmatismRows.length, 4);
  assert.equal(astigmatismRows.every((row) => row.display.startsWith("Unspecified astigmatism")), true);
});

function manifestBody() {
  return {
    ...BODY,
    blocks: [{
      type: "MANIFEST",
      OD: { sphere: -1, cylinder: -0.5, axis: 90, add: 2 },
      OS: { sphere: 1, cylinder: -0.25, axis: 85, add: 2 },
    }],
  };
}

function componentValue(
  observation: Observation,
  code: string,
  kind: "code" | "string",
): string | undefined {
  const component = observation.component?.find((row) =>
    row.code.coding?.some((coding) => coding.code === code));
  return kind === "code"
    ? component?.valueCodeableConcept?.coding?.[0]?.code
    : component?.valueString;
}
