import assert from "node:assert/strict";
import { test } from "node:test";
import type { Observation, Provenance } from "@medplum/fhirtypes";
import type { PracticeRoleId } from "../src/authz/roles.js";
import { OSOD_OPHTHALMOLOGY_CODE_SYSTEM } from "../src/fhir/ophthalmology/codeBindings.js";
import {
  AUTO_KERATOMETRY_SEARCH_CODE,
  buildPretestFindingDefinitionStubs,
  handleAutoRefractionCaptureRequest,
  handleAutoRefractionDefinitionRequest,
  handleWearingCaptureRequest,
  handleWearingDefinitionRequest,
  type PretestEndpointDeps,
} from "../src/clinical-graph/pretest-endpoint.js";

const AUTH = "Bearer good";
const BODY = {
  patientReference: "Patient/p1",
  encounterReference: "Encounter/e1",
};

function deps(
  role: PracticeRoleId = "clinician",
  findingDefinitions?: PretestEndpointDeps["findingDefinitions"],
) {
  const created: Array<{ resource: Observation | Provenance; headers?: Record<string, string> }> = [];
  const d: PretestEndpointDeps = {
    findingDefinitions,
    authenticate: async (authHeader) => authHeader === AUTH
      ? {
          staffReference: "Practitioner/doc1",
          actorRole: role,
          fhir: {
            create: async <T extends Observation | Provenance>(
              resource: T,
              headers?: Record<string, string>,
            ): Promise<T> => {
              created.push({ resource, headers });
              return { ...resource, id: resource.id ?? `${resource.resourceType.toLowerCase()}-${created.length}` };
            },
          },
        }
      : null,
    now: () => "2026-07-10T14:00:00.000Z",
  };
  return { created, deps: d };
}

test("pretest definition endpoints expose practice-editable Wearing and Auto-K option data", async () => {
  const wearing = await handleWearingDefinitionRequest(deps().deps, { authHeader: AUTH });
  const auto = await handleAutoRefractionDefinitionRequest(deps().deps, { authHeader: AUTH });

  assert.equal(wearing.status, 200);
  const wearingBody = wearing.body as {
    definition: { stableKey: string; fields: Record<string, { options?: Array<{ code: string }>; step?: number }> };
  };
  assert.equal(wearingBody.definition.stableKey, "wearing_rx");
  assert.deepEqual(
    wearingBody.definition.fields.eyeglassType.options?.map((option) => option.code),
    ["single_vision_distance", "single_vision_near", "single_vision_intermediate", "bifocal", "trifocal", "progressives"],
  );
  assert.deepEqual(
    wearingBody.definition.fields.prismBase.options?.map((option) => option.code),
    ["up", "down", "in", "out"],
  );
  assert.equal(wearingBody.definition.fields.sphere.step, 0.25);

  assert.equal(auto.status, 200);
  const autoBody = auto.body as {
    definitions: Record<string, { stableKey: string; fields: Record<string, { options?: Array<{ code: string }>; precision?: number }> }>;
  };
  assert.equal(autoBody.definitions.autoRefraction?.stableKey, "auto_refraction");
  assert.equal(autoBody.definitions.autoKeratometry?.stableKey, "auto_keratometry");
  assert.deepEqual(
    autoBody.definitions.autoRefraction?.fields.sourceType.options?.map((option) => option.code),
    ["manual", "device"],
  );
  assert.equal(autoBody.definitions.autoKeratometry?.fields.flatK.precision, 2);
});

test("all four pretest handlers enforce authentication and chart permissions", async () => {
  const definitionHandlers = [handleWearingDefinitionRequest, handleAutoRefractionDefinitionRequest];
  for (const handler of definitionHandlers) {
    assert.equal((await handler(deps().deps, { authHeader: undefined })).status, 401);
    assert.equal((await handler(deps("auditor").deps, { authHeader: AUTH })).status, 403);
  }

  assert.equal((await handleWearingCaptureRequest(deps().deps, {
    authHeader: undefined,
    body: wearingBody(),
  })).status, 401);
  assert.equal((await handleWearingCaptureRequest(deps("front-desk").deps, {
    authHeader: AUTH,
    body: wearingBody(),
  })).status, 403);
  assert.equal((await handleAutoRefractionCaptureRequest(deps().deps, {
    authHeader: undefined,
    body: autoBody(),
  })).status, 401);
  assert.equal((await handleAutoRefractionCaptureRequest(deps("front-desk").deps, {
    authHeader: AUTH,
    body: autoBody(),
  })).status, 403);
});

test("Wearing persists one complete Observation per glasses pair with both eyes, prism, VA, type, and remarks", async () => {
  const { created, deps: d } = deps();
  const res = await handleWearingCaptureRequest(d, {
    authHeader: AUTH,
    body: {
      ...BODY,
      leftGlassesAtHome: false,
      pairs: [
        {
          eyeglassType: "progressives",
          remarks: "Primary everyday pair.",
          OD: {
            sphere: -3.25,
            cylinder: -1,
            axis: 90,
            add: 2.25,
            prismAmount: 1.5,
            prismBase: "down",
            distanceVisualAcuity: "20/25 +1",
            nearVisualAcuity: "J1 (20/25) 4pt 0.50M",
          },
          OS: { sphere: -3, cylinder: -0.75, axis: 85, add: 2.25 },
        },
        { eyeglassType: "single_vision_near", OD: { sphere: 1.5 }, OS: { sphere: 1.75 } },
      ],
    },
  });

  assert.equal(res.status, 200);
  assert.deepEqual(created.map((entry) => entry.resource.resourceType), [
    "Observation", "Provenance", "Observation", "Provenance",
  ]);
  assert.equal(created.every((entry) => entry.headers?.["X-OSOD-Source"] === "mcp/save_section_observations"), true);
  const observation = created[0]?.resource as Observation;
  assert.equal(codingCode(observation), "wearing_rx");
  assert.equal(observation.bodySite?.coding?.some((coding) => coding.code === "OU"), true);
  assert.match(String(componentValue(observation, "PAIR_ID")), /^wearing-pair-/);
  assert.equal(componentValue(observation, "EYEGLASS_TYPE"), "progressives");
  assert.equal(componentValue(observation, "REMARKS"), "Primary everyday pair.");
  assert.equal(componentValue(observation, "OD_SPHERE"), -3.25);
  assert.equal(componentValue(observation, "OD_PRISM_AMOUNT"), 1.5);
  assert.equal(componentValue(observation, "OD_PRISM_BASE"), "down");
  assert.equal(componentValue(observation, "OD_DISTANCE_VA"), "20/25 +1");
  assert.equal(componentValue(observation, "OD_NEAR_VA"), "J1 (20/25) 4pt 0.50M");
  assert.equal(componentValue(observation, "OS_ADD"), 2.25);
});

test("left-glasses-at-home saves an operational flag with no pair values and rejects mixed value input", async () => {
  const { created, deps: d } = deps();
  const saved = await handleWearingCaptureRequest(d, {
    authHeader: AUTH,
    body: { ...BODY, leftGlassesAtHome: true, pairs: [] },
  });
  const rejected = await handleWearingCaptureRequest(deps().deps, {
    authHeader: AUTH,
    body: { ...BODY, leftGlassesAtHome: true, pairs: wearingBody().pairs },
  });

  assert.equal(saved.status, 200);
  assert.deepEqual((saved.body as { pairs: unknown[] }).pairs, []);
  assert.deepEqual(created.map((entry) => entry.resource.resourceType), ["Observation", "Provenance"]);
  const observation = created[0]?.resource as Observation;
  assert.equal(componentValue(observation, "LEFT_GLASSES_AT_HOME"), true);
  assert.equal(observation.component?.some((component) => component.code.coding?.some((coding) => coding.code === "SPHERE")), false);
  assert.equal(rejected.status, 400);
  assert.match(String((rejected.body as { error: string }).error), /cannot be saved/);
});

test("Auto-Refraction POST persists ARx and Auto-K per eye and round-trips device sourceType", async () => {
  const { created, deps: d } = deps();
  const res = await handleAutoRefractionCaptureRequest(d, { authHeader: AUTH, body: autoBody("device") });

  assert.equal(res.status, 200);
  assert.equal((res.body as { sourceType: string }).sourceType, "device");
  assert.deepEqual(created.map((entry) => entry.resource.resourceType), [
    "Observation", "Provenance", "Observation", "Provenance",
    "Observation", "Provenance", "Observation", "Provenance",
  ]);
  const observations = created
    .map((entry) => entry.resource)
    .filter((resource): resource is Observation => resource.resourceType === "Observation");
  assert.deepEqual(observations.map(codingCode), [
    "auto_refraction", "auto_keratometry", "auto_refraction", "auto_keratometry",
  ]);
  assert.equal(observations.every((observation) => observation.note?.[0]?.text === "sourceType=device"), true);
  const odK = observations[1];
  assert.equal(componentValue(odK, "FLAT_K"), 42.5);
  assert.equal(componentValue(odK, "FLAT_AXIS"), 180);
  assert.equal(componentValue(odK, "STEEP_K"), 43.25);
  assert.equal(componentValue(odK, "STEEP_AXIS"), 90);
  assert.equal(componentValue(odK, "REMARKS"), "Reliable fixation.");
});

test("Auto-K observations support a single latest-per-patient-and-eye FHIR search", async () => {
  const { created, deps: d } = deps();
  await handleAutoRefractionCaptureRequest(d, { authHeader: AUTH, body: autoBody() });
  const observation = created
    .map((entry) => entry.resource)
    .find((resource): resource is Observation => resource.resourceType === "Observation" && codingCode(resource) === "auto_keratometry");

  assert.ok(observation);
  assert.equal(AUTO_KERATOMETRY_SEARCH_CODE, `${OSOD_OPHTHALMOLOGY_CODE_SYSTEM}|auto_keratometry`);
  assert.equal(observation.subject?.reference, BODY.patientReference);
  assert.equal(observation.bodySite?.coding?.some((coding) =>
    coding.system === OSOD_OPHTHALMOLOGY_CODE_SYSTEM && coding.code === "OD"), true);
  assert.equal(observation.effectiveDateTime, "2026-07-10T14:00:00.000Z");
});

test("Wearing and Auto-Refraction never return suggestion or edge payloads for high-power values", async () => {
  const wearing = await handleWearingCaptureRequest(deps().deps, {
    authHeader: AUTH,
    body: {
      ...BODY,
      leftGlassesAtHome: false,
      pairs: [{
        eyeglassType: "single_vision_distance",
        OD: { sphere: -8, cylinder: -2, axis: 90 },
        OS: { sphere: 7, cylinder: -1.5, axis: 85 },
      }],
    },
  });
  const auto = await handleAutoRefractionCaptureRequest(deps().deps, {
    authHeader: AUTH,
    body: {
      ...BODY,
      sourceType: "manual",
      eyes: {
        OD: { sphere: -8, cylinder: -2, axis: 90 },
        OS: { sphere: 7, cylinder: -1.5, axis: 85 },
      },
    },
  });

  assert.equal(wearing.status, 200);
  assert.equal(auto.status, 200);
  assert.deepEqual(forbiddenDiagnosisKeys(wearing.body), []);
  assert.deepEqual(forbiddenDiagnosisKeys(auto.body), []);
});

test("pretest validation rejects non-quarter powers and incomplete or over-precision Auto-K", async () => {
  const wearing = await handleWearingCaptureRequest(deps().deps, {
    authHeader: AUTH,
    body: {
      ...BODY,
      pairs: [{ eyeglassType: "bifocal", OD: { sphere: -0.3 } }],
    },
  });
  const incompleteK = await handleAutoRefractionCaptureRequest(deps().deps, {
    authHeader: AUTH,
    body: { ...BODY, eyes: { OD: { flatK: 42.5 } } },
  });
  const precisionK = await handleAutoRefractionCaptureRequest(deps().deps, {
    authHeader: AUTH,
    body: { ...BODY, eyes: { OD: { flatK: 42.501, flatAxis: 180, steepK: 43.25, steepAxis: 90 } } },
  });

  assert.equal(wearing.status, 400);
  assert.match(String((wearing.body as { error: string }).error), /0\.25 increments/);
  assert.equal(incompleteK.status, 400);
  assert.match(String((incompleteK.body as { error: string }).error), /requires flat K/);
  assert.equal(precisionK.status, 400);
  assert.match(String((precisionK.body as { error: string }).error), /two decimal places/);
});

test("Wearing accepts a practice-edited eyeglass-type definition list", async () => {
  const definitions = buildPretestFindingDefinitionStubs();
  const wearing = definitions.find((definition) => definition.stableKey === "wearing_rx");
  assert.ok(wearing);
  const fields = wearing.valueSchema.fields as Record<string, Record<string, unknown>>;
  const eyeglassType = fields.eyeglassType;
  assert.ok(eyeglassType);
  eyeglassType.options = [{ code: "sports", display: "Sports", active: true }];
  const res = await handleWearingCaptureRequest(deps("clinician", () => definitions).deps, {
    authHeader: AUTH,
    body: { ...BODY, pairs: [{ eyeglassType: "sports", OD: { sphere: 0 } }] },
  });

  assert.equal(res.status, 200);
});

function wearingBody() {
  return {
    ...BODY,
    leftGlassesAtHome: false,
    pairs: [{ eyeglassType: "single_vision_distance", OD: { sphere: -1 } }],
  };
}

function autoBody(sourceType: "manual" | "device" = "manual") {
  return {
    ...BODY,
    sourceType,
    remarks: "Reliable fixation.",
    eyes: {
      OD: { sphere: -1.25, cylinder: -0.5, axis: 90, flatK: 42.5, flatAxis: 180, steepK: 43.25, steepAxis: 90 },
      OS: { sphere: -1, cylinder: -0.25, axis: 85, flatK: 42.75, flatAxis: 5, steepK: 43.5, steepAxis: 95 },
    },
  };
}

function codingCode(observation: Observation): string | undefined {
  return observation.code.coding?.find((coding) => coding.system === OSOD_OPHTHALMOLOGY_CODE_SYSTEM)?.code;
}

function componentValue(observation: Observation | undefined, code: string): unknown {
  const component = observation?.component?.find((row) => row.code.coding?.some((coding) => coding.code === code));
  return component?.valueQuantity?.value ?? component?.valueString ?? component?.valueBoolean;
}

function forbiddenDiagnosisKeys(value: unknown, found: string[] = []): string[] {
  if (Array.isArray(value)) {
    for (const item of value) forbiddenDiagnosisKeys(item, found);
    return found;
  }
  if (typeof value !== "object" || value === null) return found;
  for (const [key, item] of Object.entries(value)) {
    if (/suggestion|edge/i.test(key)) found.push(key);
    forbiddenDiagnosisKeys(item, found);
  }
  return found;
}
