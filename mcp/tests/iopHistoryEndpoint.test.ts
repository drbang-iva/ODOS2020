import assert from "node:assert/strict";
import { test } from "node:test";
import type { Bundle, Goal, Observation } from "@medplum/fhirtypes";
import type { PracticeRoleId } from "../src/authz/roles.js";
import {
  buildGlaucomaFindingDefinitionStubs,
  captureGlaucomaFinding,
  type ClinicalFindingDefinition,
  type ClinicalGraphProvenance,
  type FindingValue,
} from "../src/clinical-graph/glaucoma-suspect.js";
import {
  handleIopHistoryRequest,
  handleIopTargetRequest,
  type IopHistoryEndpointDeps,
  type IopHistoryResponse,
} from "../src/clinical-graph/iop-history-endpoint.js";
import { iopMethodConcept } from "../src/fhir/ophthalmology/iop.js";
import { odosConcept } from "../src/fhir/ophthalmology/extensions.js";
import { ODOS_OPHTHALMOLOGY_CODE_SYSTEM } from "../src/fhir/ophthalmology/codeBindings.js";

const AUTH = "Bearer good";
const PATIENT = "Patient/p1";
const ENCOUNTER = "Encounter/e1";
const CONCURRENT_EDIT_MESSAGE =
  "This record was changed by someone else since you opened it. Reload and reapply your change.";
const provenance: ClinicalGraphProvenance = {
  source: "manual",
  recordedAt: "2026-07-09T12:00:00.000Z",
  actorReference: "Practitioner/doc1",
  ledgerRefs: ["data/code-bindings/glaucoma-suspect-phase0-ledger.json"],
};

test("IOP history endpoint enforces auth and chart.read", async () => {
  const normal = deps("clinician");

  const unauthorized = await handleIopHistoryRequest(normal.deps, {
    authHeader: undefined,
    query: { patient: PATIENT },
  });
  assert.equal(unauthorized.status, 401);

  const forbidden = await handleIopHistoryRequest(deps("auditor").deps, {
    authHeader: AUTH,
    query: { patient: PATIENT },
  });
  assert.equal(forbidden.status, 403);
});

test("IOP history endpoint returns empty arrays, zero counts, and definition threshold", async () => {
  const { deps: d } = deps("clinician", definitionsWithThreshold(24));

  const res = await handleIopHistoryRequest(d, {
    authHeader: AUTH,
    query: { patient: PATIENT },
  });

  assert.equal(res.status, 200);
  const body = res.body as IopHistoryResponse;
  assert.deepEqual(body.readings, []);
  assert.deepEqual(body.cornealHysteresis, []);
  assert.equal(body.perEye.OD.count, 0);
  assert.equal(body.perEye.OD.average, null);
  assert.equal(body.perEye.OD.tMax, null);
  assert.equal(body.perEye.OS.count, 0);
  assert.equal(body.threshold, 24);
});

test("IOP history endpoint separates IOP from CH and suppresses not-visualized observations", async () => {
  const fixture = deps();
  const definitions = defaultDefinitions();
  const iop = definition(definitions, "intraocular_pressure");
  const ch = definition(definitions, "corneal_hysteresis");
  fixture.observations.push(
    observation(iop, "OD", quantityValue(18, "mmHg", "http://unitsofmeasure.org", "mm[Hg]"), "2026-03-14T13:15:00.000Z", "GAT"),
    observation(iop, "OD", quantityValue(22, "mmHg", "http://unitsofmeasure.org", "mm[Hg]"), "2026-03-15T13:15:00.000Z", "ICARE"),
    observation(iop, "OS", quantityValue(25, "mmHg", "http://unitsofmeasure.org", "mm[Hg]"), "2026-03-15T13:16:00.000Z", "GAT"),
    observation(iop, "OD", { type: "json", value: { notVisualized: true } }, "2026-03-16T13:15:00.000Z", "GAT"),
    observation(ch, "OD", quantityValue(8.4, "corneobiomechanics score"), "2026-03-15T13:15:00.000Z", "GAT"),
  );

  const res = await handleIopHistoryRequest(fixture.deps, {
    authHeader: AUTH,
    query: { patient: PATIENT },
  });

  assert.equal(res.status, 200);
  const body = res.body as IopHistoryResponse;
  assert.equal(body.readings.length, 3);
  assert.deepEqual(body.readings.map((reading) => `${reading.eye}:${reading.value}:${reading.method?.code}`), [
    "OD:18:GAT",
    "OD:22:ICARE",
    "OS:25:GAT",
  ]);
  assert.equal(body.cornealHysteresis.length, 1);
  assert.equal(body.cornealHysteresis[0]?.value, 8.4);
  assert.equal(body.perEye.OD.count, 2);
  assert.equal(body.perEye.OD.average, 20);
  assert.equal(body.perEye.OD.tMax, 22);
  assert.equal(body.perEye.OS.count, 1);
  assert.equal(body.perEye.OS.average, 25);
  assert.equal(body.perEye.OS.tMax, 25);
});

test("IOP target endpoint round-trips through history and latest write wins", async () => {
  const fixture = deps();

  const first = await handleIopTargetRequest(fixture.deps, {
    authHeader: AUTH,
    body: {
      patientReference: PATIENT,
      eye: "OD",
      percent: 20,
      value: 16,
      overridden: false,
    },
  });
  assert.equal(first.status, 200);

  const second = await handleIopTargetRequest(fixture.deps, {
    authHeader: AUTH,
    body: {
      patientReference: PATIENT,
      eye: "OD",
      value: 15,
      overridden: true,
    },
  });
  assert.equal(second.status, 200);
  assert.equal(fixture.goals.length, 1);
  assert.deepEqual(fixture.updateHeaders.map((headers) => headers["If-Match"]), ['W/"1"']);

  const history = await handleIopHistoryRequest(fixture.deps, {
    authHeader: AUTH,
    query: { patient: PATIENT },
  });
  assert.equal(history.status, 200);
  const body = history.body as IopHistoryResponse;
  assert.deepEqual(body.perEye.OD.target, {
    percent: null,
    value: 15,
    overridden: true,
  });
});

test("IOP target endpoint requires chart.write", async () => {
  const forbidden = await handleIopTargetRequest(deps("front-desk").deps, {
    authHeader: AUTH,
    body: {
      patientReference: PATIENT,
      eye: "OS",
      percent: 25,
      value: 14,
      overridden: false,
    },
  });

  assert.equal(forbidden.status, 403);
});

test("IOP target endpoint rejects a stale Goal update without overwriting the concurrent target", async () => {
  const fixture = deps();
  await handleIopTargetRequest(fixture.deps, {
    authHeader: AUTH,
    body: {
      patientReference: PATIENT,
      eye: "OD",
      percent: 20,
      value: 16,
      overridden: false,
    },
  });
  let concurrentGoal: Goal | undefined;
  fixture.controls.beforeUpdate = (id) => {
    const index = fixture.goals.findIndex((goal) => goal.id === id);
    assert.ok(index >= 0);
    fixture.goals[index] = {
      ...fixture.goals[index]!,
      description: { text: "Concurrent clinician target" },
      meta: { ...fixture.goals[index]!.meta, versionId: "2" },
    };
    concurrentGoal = structuredClone(fixture.goals[index]);
  };

  const result = await handleIopTargetRequest(fixture.deps, {
    authHeader: AUTH,
    body: {
      patientReference: PATIENT,
      eye: "OD",
      value: 15,
      overridden: true,
    },
  });

  assert.equal(result.status, 409);
  assert.deepEqual(result.body, { error: CONCURRENT_EDIT_MESSAGE, code: "concurrent-edit" });
  assert.deepEqual(fixture.updateHeaders.map((headers) => headers["If-Match"]), ['W/"1"']);
  assert.deepEqual(fixture.goals[0], concurrentGoal);
});

function deps(
  role: PracticeRoleId = "clinician",
  findingDefinitions: ClinicalFindingDefinition[] = defaultDefinitions(),
) {
  const observations: Observation[] = [];
  const goals: Goal[] = [];
  const updateHeaders: Array<Record<string, string>> = [];
  const controls: { beforeUpdate?: (id: string) => void } = {};
  const d: IopHistoryEndpointDeps = {
    findingDefinitions: () => findingDefinitions,
    authenticate: async (authHeader) =>
      authHeader === AUTH
        ? {
            staffReference: "Practitioner/doc1",
            actorRole: role,
            fhir: {
              search: async <T extends Goal | Observation>(
                resourceType: T["resourceType"],
                params: Record<string, string> = {},
              ): Promise<Bundle<T>> => {
                const resources = resourceType === "Observation"
                  ? observations.filter((item) => observationMatches(item, params))
                  : goals.filter((item) => goalMatches(item, params));
                return {
                  resourceType: "Bundle",
                  type: "searchset",
                  entry: resources.map((resource) => ({ resource: structuredClone(resource) as T })),
                };
              },
              create: async <T extends Goal>(resource: T): Promise<T> => {
                const created = {
                  ...resource,
                  id: resource.id ?? `goal-${goals.length + 1}`,
                  meta: {
                    ...(resource.meta ?? {}),
                    lastUpdated: `2026-07-09T12:0${goals.length}:00.000Z`,
                    versionId: "1",
                  },
                };
                goals.push(created);
                return created as T;
              },
              update: async <T extends Goal>(
                _resourceType: T["resourceType"],
                id: string,
                resource: T,
                headers: Record<string, string> = {},
              ): Promise<T> => {
                updateHeaders.push(headers);
                const beforeUpdate = controls.beforeUpdate;
                controls.beforeUpdate = undefined;
                beforeUpdate?.(id);
                const index = goals.findIndex((goal) => goal.id === id);
                assert.ok(index >= 0);
                const expectedIfMatch = `W/"${goals[index]?.meta?.versionId}"`;
                if (headers["If-Match"] !== expectedIfMatch) {
                  throw Object.assign(new Error("FHIR 412 Precondition Failed"), { status: 412 });
                }
                const updated = {
                  ...resource,
                  id,
                  meta: {
                    ...(resource.meta ?? {}),
                    lastUpdated: "2026-07-09T12:05:00.000Z",
                    versionId: "2",
                  },
                };
                goals[index] = updated;
                return updated as T;
              },
            },
          }
        : null,
    now: () => "2026-07-09T12:00:00.000Z",
  };
  return { deps: d, observations, goals, updateHeaders, controls };
}

function defaultDefinitions(): ClinicalFindingDefinition[] {
  return buildGlaucomaFindingDefinitionStubs({ provenance });
}

function definitionsWithThreshold(threshold: number): ClinicalFindingDefinition[] {
  return defaultDefinitions().map((row) => {
    if (row.stableKey !== "intraocular_pressure") return row;
    const riskPredicate = {
      ...asRecord(row.normalSemantics?.riskPredicate),
      thresholdParameters: {
        ...asRecord(asRecord(row.normalSemantics?.riskPredicate).thresholdParameters),
        ohtnThreshold: {
          ...asRecord(asRecord(asRecord(row.normalSemantics?.riskPredicate).thresholdParameters).ohtnThreshold),
          defaultValue: threshold,
        },
      },
    };
    return {
      ...row,
      normalSemantics: {
        ...row.normalSemantics,
        riskPredicate,
      },
    };
  });
}

function definition(definitions: readonly ClinicalFindingDefinition[], stableKey: string): ClinicalFindingDefinition {
  const found = definitions.find((row) => row.stableKey === stableKey);
  assert.ok(found);
  return found;
}

function observation(
  definition: ClinicalFindingDefinition,
  eye: "OD" | "OS",
  value: FindingValue,
  recordedAt: string,
  methodCode: string,
): Observation {
  const captured = captureGlaucomaFinding({
    definition,
    patientReference: PATIENT,
    encounterReference: ENCOUNTER,
    laterality: eye,
    value,
    method: iopMethodConcept(odosConcept(methodCode, methodCode === "ICARE" ? "iCare" : methodCode)),
    sourceType: "manual",
    performerReferences: ["Practitioner/doc1"],
    recordedAt,
    provenance,
  });
  return captured.observation;
}

function quantityValue(
  value: number,
  unit: string,
  system?: string,
  code?: string,
): FindingValue {
  return { type: "quantity", value, unit, system, code };
}

function observationMatches(observation: Observation, params: Record<string, string>): boolean {
  const subject = observation.subject?.reference === params.subject;
  const code = params.code ? codeableConceptMatches(observation.code, params.code) : true;
  return subject && code;
}

function goalMatches(goal: Goal, params: Record<string, string>): boolean {
  const subject = goal.subject?.reference === params.subject;
  const category = params.category
    ? goal.category?.some((concept) => codeableConceptMatches(concept, params.category)) ?? false
    : true;
  return subject && category;
}

function codeableConceptMatches(concept: { coding?: Array<{ system?: string; code?: string }> }, param: string): boolean {
  const [system, code] = param.split("|");
  return Boolean(concept.coding?.some((coding) => coding.system === system && coding.code === code));
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

assert.equal(ODOS_OPHTHALMOLOGY_CODE_SYSTEM.startsWith("https://odos2020.com/fhir/CodeSystem/"), true);
