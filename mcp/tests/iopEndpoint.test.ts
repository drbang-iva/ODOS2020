import assert from "node:assert/strict";
import { test } from "node:test";
import type { Observation, Provenance } from "@medplum/fhirtypes";
import type { PracticeRoleId } from "../src/authz/roles.js";
import {
  addGlaucomaIopMethodOption,
  buildGlaucomaFindingDefinitionStubs,
  type ClinicalGraphProvenance,
} from "../src/clinical-graph/glaucoma-suspect.js";
import {
  handleIopCaptureRequest,
  handleIopDefinitionRequest,
  type IopEndpointDeps,
} from "../src/clinical-graph/iop-endpoint.js";

const AUTH = "Bearer good";
const BODY = {
  patientReference: "Patient/p1",
  encounterReference: "Encounter/e1",
};
const provenance: ClinicalGraphProvenance = {
  source: "manual",
  recordedAt: "2026-07-09T12:00:00.000Z",
  actorReference: "Practitioner/dr-bang",
  ledgerRefs: ["data/code-bindings/glaucoma-suspect-phase0-ledger.json"],
};

function deps(
  role: PracticeRoleId = "clinician",
  findingDefinitions?: IopEndpointDeps["findingDefinitions"],
) {
  const created: Array<{ resource: Observation | Provenance; headers?: Record<string, string> }> = [];
  const d: IopEndpointDeps = {
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
    now: () => "2026-07-09T12:00:00.000Z",
  };
  return { created, deps: d };
}

test("IOP definition endpoint serves editable method data and CH field data", async () => {
  const { deps: d } = deps();

  const res = await handleIopDefinitionRequest(d, { authHeader: AUTH });

  assert.equal(res.status, 200);
  const body = res.body as {
    definitions: {
      intraocularPressure: { fields: Record<string, { options?: Array<{ code: string }> }> };
      cornealHysteresis: { fields: Record<string, { minimum?: number; maximum?: number; step?: number; unit?: string }> };
    };
  };
  assert.deepEqual(
    body.definitions.intraocularPressure.fields.method.options?.map((option) => option.code),
    ["GAT", "NCT", "ICARE", "TONOPEN", "PALPATION", "IOPCC", "IOPG"],
  );
  assert.equal(body.definitions.cornealHysteresis.fields.value.minimum, 0);
  assert.equal(body.definitions.cornealHysteresis.fields.value.maximum, 15);
  assert.equal(body.definitions.cornealHysteresis.fields.value.step, 0.1);
  assert.equal(body.definitions.cornealHysteresis.fields.value.unit, "corneobiomechanics score");
});

test("IOP endpoint persists neutral Observation and returns normal without an ICD code", async () => {
  const { created, deps: d } = deps();

  const res = await handleIopCaptureRequest(d, {
    authHeader: AUTH,
    body: {
      ...BODY,
      eyes: {
        OD: { value: 21, method: "GAT", date: "2026-07-09", timeOfDay: "09:15" },
      },
    },
  });

  assert.equal(res.status, 200);
  const body = res.body as { eyes: { OD: { riskTier: string; icd10Code?: string; signals: string[] } } };
  assert.equal(body.eyes.OD.riskTier, "normal");
  assert.equal(body.eyes.OD.icd10Code, undefined);
  assert.deepEqual(body.eyes.OD.signals, []);
  assert.deepEqual(created.map((entry) => entry.resource.resourceType), ["Observation", "Provenance"]);
  assert.equal(created.every((entry) => entry.headers?.["X-OSOD-Source"] === "mcp/save_section_observations"), true);
  const observation = created[0]?.resource as Observation;
  assert.equal(observation.valueQuantity?.value, 21);
  assert.equal(observation.valueQuantity?.unit, "mmHg");
  assert.equal(observation.method?.coding?.some((coding) => coding.code === "GAT"), true);
});

test("IOP endpoint returns OHTN H40.05x suggestion metadata without creating a Condition", async () => {
  const { created, deps: d } = deps();

  const res = await handleIopCaptureRequest(d, {
    authHeader: AUTH,
    body: {
      ...BODY,
      eyes: {
        OS: { value: 22, method: "NCT", date: "2026-07-09", timeOfDay: "10:30" },
      },
    },
  });

  assert.equal(res.status, 200);
  const body = res.body as { eyes: { OS: { riskTier: string; icd10Code?: string; signals: string[] } } };
  assert.equal(body.eyes.OS.riskTier, "ohtn");
  assert.equal(body.eyes.OS.icd10Code, "H40.052");
  assert.deepEqual(body.eyes.OS.signals, ["iop-threshold"]);
  assert.equal(created.some((entry) => (entry.resource as { resourceType: string }).resourceType === "Condition"), false);
});

test("IOP endpoint suppresses not-visualized rows and rejects non-chart-write saves", async () => {
  const normal = await handleIopCaptureRequest(deps().deps, {
    authHeader: AUTH,
    body: {
      ...BODY,
      eyes: {
        OD: { notVisualized: true, date: "2026-07-09", timeOfDay: "11:00" },
      },
    },
  });
  assert.equal(normal.status, 200);
  const body = normal.body as { eyes: { OD: { riskTier: string; icd10Code?: string } } };
  assert.equal(body.eyes.OD.riskTier, "normal");
  assert.equal(body.eyes.OD.icd10Code, undefined);

  const forbidden = await handleIopCaptureRequest(deps("front-desk").deps, {
    authHeader: AUTH,
    body: {
      ...BODY,
      eyes: {
        OD: { value: 18, method: "GAT", date: "2026-07-09", timeOfDay: "11:05" },
      },
    },
  });
  assert.equal(forbidden.status, 403);
});

test("IOP endpoint uses practice-added method data instead of a runtime enum list", async () => {
  const definitions = buildGlaucomaFindingDefinitionStubs({ provenance });
  const iop = definitions.find((definition) => definition.stableKey === "intraocular_pressure");
  assert.ok(iop);
  const editedIop = addGlaucomaIopMethodOption(iop, {
    code: "ORA-CUSTOM",
    display: "ORA custom",
    active: true,
  });
  const editedDefinitions = definitions.map((definition) =>
    definition.id === iop.id ? editedIop : definition);
  const { created, deps: d } = deps("clinician", () => editedDefinitions);

  const definitionRes = await handleIopDefinitionRequest(d, { authHeader: AUTH });
  const definitionBody = definitionRes.body as {
    definitions: { intraocularPressure: { fields: Record<string, { options?: Array<{ code: string }> }> } };
  };
  assert.equal(
    definitionBody.definitions.intraocularPressure.fields.method.options?.some((option) => option.code === "ORA-CUSTOM"),
    true,
  );

  const res = await handleIopCaptureRequest(d, {
    authHeader: AUTH,
    body: {
      ...BODY,
      eyes: {
        OD: { value: 18, method: "ORA-CUSTOM", date: "2026-07-09", timeOfDay: "11:30" },
      },
    },
  });

  assert.equal(res.status, 200);
  const observation = created[0]?.resource as Observation;
  assert.equal(observation.method?.coding?.some((coding) => coding.code === "ORA-CUSTOM"), true);
});

test("IOP endpoint stores CH as a separate observation with no extra Condition side effect", async () => {
  const { created, deps: d } = deps();

  const res = await handleIopCaptureRequest(d, {
    authHeader: AUTH,
    body: {
      ...BODY,
      eyes: {
        OD: {
          value: 22,
          method: "IOPCC",
          date: "2026-07-09",
          timeOfDay: "12:15",
          cornealHysteresis: 8.7,
        },
      },
    },
  });

  assert.equal(res.status, 200);
  const body = res.body as { eyes: { OD: { cornealHysteresisObservationReference?: string } } };
  assert.match(body.eyes.OD.cornealHysteresisObservationReference ?? "", /^Observation\//);
  assert.deepEqual(created.map((entry) => entry.resource.resourceType), [
    "Observation",
    "Provenance",
    "Observation",
    "Provenance",
  ]);
  const chObservation = created[2]?.resource as Observation;
  assert.equal(chObservation.valueQuantity?.value, 8.7);
  assert.equal(chObservation.valueQuantity?.unit, "corneobiomechanics score");
  assert.equal(chObservation.valueQuantity?.code, undefined);
  assert.equal(created.some((entry) => (entry.resource as { resourceType: string }).resourceType === "Condition"), false);
});
