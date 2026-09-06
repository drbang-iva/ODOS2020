import assert from "node:assert/strict";
import { test } from "node:test";
import type { Bundle, Observation, Provenance } from "@medplum/fhirtypes";
import type { PracticeRoleId } from "../src/authz/roles.js";
import { ODOS_OPHTHALMOLOGY_CODE_SYSTEM } from "../src/fhir/ophthalmology/codeBindings.js";
import {
  AUTO_KERATOMETRY_SEARCH_CODE,
  buildPretestFindingDefinitionStubs,
  handleAutoRefractionCaptureRequest,
  handleAutoRefractionDefinitionRequest,
  handleAutoRefractionHistoryRequest,
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
  role: PracticeRoleId = "provider",
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
            search: async <T extends Observation>(): Promise<Bundle<T>> => ({
              resourceType: "Bundle",
              type: "searchset",
              entry: created.flatMap(({ resource }) =>
                resource.resourceType === "Observation" ? [{ resource: resource as T }] : []),
            }),
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
    definitions: Record<string, {
      stableKey: string;
      fields: Record<string, {
        options?: Array<{ code: string }>;
        minimum?: number;
        maximum?: number;
        precision?: number;
        unit?: string;
      }>;
    }>;
  };
  assert.equal(autoBody.definitions.autoRefraction?.stableKey, "auto_refraction");
  assert.equal(autoBody.definitions.autoKeratometry?.stableKey, "auto_keratometry");
  assert.deepEqual(
    autoBody.definitions.autoRefraction?.fields.sourceType.options?.map((option) => option.code),
    ["manual", "device"],
  );
  assert.deepEqual(autoBody.definitions.autoRefraction?.fields.binocularPdDistance, {
    display: "Binocular PD Dist",
    type: "decimal-input",
    minimum: 35,
    maximum: 90,
    precision: 2,
    unit: "mm",
  });
  assert.deepEqual(autoBody.definitions.autoRefraction?.fields.binocularPdNear, {
    display: "Binocular PD Near",
    type: "decimal-input",
    minimum: 35,
    maximum: 90,
    precision: 2,
    unit: "mm",
  });
  assert.equal(autoBody.definitions.autoKeratometry?.fields.flatK.precision, 2);
});

test("auto-refraction history returns the current encounter values needed to hydrate the editor", async () => {
  const { created, deps: d } = deps();
  const saved = await handleAutoRefractionCaptureRequest(d, {
    authHeader: AUTH,
    body: {
      ...autoBody("device"),
      binocularPdDistance: 63.5,
      binocularPdNear: 60.25,
    },
  });
  assert.equal(saved.status, 200);
  for (const { resource } of created) {
    if (resource.resourceType !== "Observation") continue;
    const identity = `${codingCode(resource)}:${lateralityCode(resource)}`;
    resource.id = {
      "auto_refraction:OD": "ar-od",
      "auto_keratometry:OD": "ak-od",
      "auto_refraction:OS": "ar-os",
      "auto_keratometry:OS": "ak-os",
      "auto_refraction:OU": "pd-ou",
    }[identity] ?? resource.id;
  }

  const module = await import("../src/clinical-graph/pretest-endpoint.js") as typeof import("../src/clinical-graph/pretest-endpoint.js") & {
    handleAutoRefractionHistoryRequest?: (
      deps: PretestEndpointDeps,
      input: { authHeader: string | undefined; query: unknown },
    ) => Promise<{ status: number; body: unknown }>;
  };
  assert.equal(
    typeof module.handleAutoRefractionHistoryRequest,
    "function",
    "the editor needs a real read path, not values inferred from the void-preview fake",
  );
  if (!module.handleAutoRefractionHistoryRequest) return;

  const result = await module.handleAutoRefractionHistoryRequest(d, {
    authHeader: AUTH,
    query: BODY,
  });
  assert.equal(result.status, 200);
  assert.deepEqual(result.body, {
    eyes: {
      OD: {
        sphere: -1.25,
        cylinder: -0.5,
        axis: 90,
        flatK: 42.5,
        flatAxis: 180,
        steepK: 43.25,
        steepAxis: 90,
        observationReferences: ["Observation/ar-od", "Observation/ak-od"],
      },
      OS: {
        sphere: -1,
        cylinder: -0.25,
        axis: 85,
        flatK: 42.75,
        flatAxis: 5,
        steepK: 43.5,
        steepAxis: 95,
        observationReferences: ["Observation/ar-os", "Observation/ak-os"],
      },
    },
    binocularPdDistance: 63.5,
    binocularPdNear: 60.25,
    binocularPdObservationReferences: ["Observation/pd-ou"],
    remarks: "Reliable fixation.",
  });
});

test("all five pretest handlers enforce authentication, practice-wide reads, and read-only Admin", async () => {
  const definitionHandlers = [handleWearingDefinitionRequest, handleAutoRefractionDefinitionRequest];
  for (const handler of definitionHandlers) {
    assert.equal((await handler(deps().deps, { authHeader: undefined })).status, 401);
    assert.equal((await handler(deps("admin").deps, { authHeader: AUTH })).status, 200);
  }

  assert.equal((await handleWearingCaptureRequest(deps().deps, {
    authHeader: undefined,
    body: wearingBody(),
  })).status, 401);
  assert.equal((await handleWearingCaptureRequest(deps("admin").deps, {
    authHeader: AUTH,
    body: wearingBody(),
  })).status, 403);
  assert.equal((await handleAutoRefractionCaptureRequest(deps().deps, {
    authHeader: undefined,
    body: autoBody(),
  })).status, 401);
  assert.equal((await handleAutoRefractionCaptureRequest(deps("admin").deps, {
    authHeader: AUTH,
    body: autoBody(),
  })).status, 403);
  assert.equal((await handleAutoRefractionHistoryRequest(deps().deps, {
    authHeader: undefined,
    query: BODY,
  })).status, 401);
  assert.equal((await handleAutoRefractionHistoryRequest(deps("admin").deps, {
    authHeader: AUTH,
    query: BODY,
  })).status, 200);
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
  assert.equal(created.every((entry) => entry.headers?.["X-ODOS-Source"] === "mcp/save_section_observations"), true);
  for (const provenance of created
    .map((entry) => entry.resource)
    .filter((resource): resource is Provenance => resource.resourceType === "Provenance")) {
    assert.equal(provenance.target[1]?.reference, BODY.patientReference);
  }
  const observation = created[0]?.resource as Observation;
  assert.equal(observation.status, "preliminary");
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
  assert.equal(observations.every((observation) => observation.status === "preliminary"), true);
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

test("Auto-Refraction persists binocular distance and near PD in a separate OU Observation", async () => {
  const { created, deps: d } = deps();
  const res = await handleAutoRefractionCaptureRequest(d, {
    authHeader: AUTH,
    body: {
      ...BODY,
      binocularPdDistance: 63.5,
      binocularPdNear: 60.25,
      eyes: {
        OD: { sphere: -1.25 },
        OS: { sphere: -1 },
      },
    },
  });

  assert.equal(res.status, 200);
  const observations = created
    .map((entry) => entry.resource)
    .filter((resource): resource is Observation => resource.resourceType === "Observation");
  assert.equal(observations.length, 3);
  const ou = observations.find((observation) => lateralityCode(observation) === "OU");
  assert.ok(ou);
  assert.equal(codingCode(ou), "auto_refraction");
  assert.equal(componentValue(ou, "BINOCULAR_PD_DISTANCE"), 63.5);
  assert.equal(componentValue(ou, "BINOCULAR_PD_NEAR"), 60.25);
  for (const code of ["BINOCULAR_PD_DISTANCE", "BINOCULAR_PD_NEAR"]) {
    const quantity = ou.component?.find((component) => component.code.coding?.some((coding) => coding.code === code))?.valueQuantity;
    assert.equal(quantity?.unit, "mm");
    assert.equal(quantity?.system, "http://unitsofmeasure.org");
    assert.equal(quantity?.code, "mm");
  }
  const perEye = observations.filter((observation) => lateralityCode(observation) !== "OU");
  assert.deepEqual(perEye.map(lateralityCode), ["OD", "OS"]);
  assert.equal(perEye.every((observation) => componentValue(observation, "BINOCULAR_PD_DISTANCE") === undefined), true);
  assert.equal(perEye.every((observation) => componentValue(observation, "BINOCULAR_PD_NEAR") === undefined), true);
  assert.ok((res.body as { binocularPd?: { observationReference?: string } }).binocularPd?.observationReference);
});

test("Auto-Refraction rejects PD inside eyes and omits OU capture when top-level PD is empty", async () => {
  const nested = await handleAutoRefractionCaptureRequest(deps().deps, {
    authHeader: AUTH,
    body: {
      ...BODY,
      eyes: { OD: { sphere: -1, binocularPdDistance: 63.5 } },
    },
  });
  const { created, deps: d } = deps();
  const empty = await handleAutoRefractionCaptureRequest(d, {
    authHeader: AUTH,
    body: {
      ...BODY,
      binocularPdDistance: undefined,
      binocularPdNear: undefined,
      eyes: { OD: { sphere: -1 } },
    },
  });

  assert.equal(nested.status, 400);
  assert.equal(empty.status, 200);
  const observations = created
    .map((entry) => entry.resource)
    .filter((resource): resource is Observation => resource.resourceType === "Observation");
  assert.equal(observations.length, 1);
  assert.equal(lateralityCode(observations[0]), "OD");
  assert.equal((empty.body as { binocularPd?: unknown }).binocularPd, undefined);
});

test("Auto-K observations support a single latest-per-patient-and-eye FHIR search", async () => {
  const { created, deps: d } = deps();
  await handleAutoRefractionCaptureRequest(d, { authHeader: AUTH, body: autoBody() });
  const observation = created
    .map((entry) => entry.resource)
    .find((resource): resource is Observation => resource.resourceType === "Observation" && codingCode(resource) === "auto_keratometry");

  assert.ok(observation);
  assert.equal(AUTO_KERATOMETRY_SEARCH_CODE, `${ODOS_OPHTHALMOLOGY_CODE_SYSTEM}|auto_keratometry`);
  assert.equal(observation.subject?.reference, BODY.patientReference);
  assert.equal(observation.bodySite?.coding?.some((coding) =>
    coding.system === ODOS_OPHTHALMOLOGY_CODE_SYSTEM && coding.code === "OD"), true);
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
  const res = await handleWearingCaptureRequest(deps("provider", () => definitions).deps, {
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
  return observation.code.coding?.find((coding) => coding.system === ODOS_OPHTHALMOLOGY_CODE_SYSTEM)?.code;
}

function lateralityCode(observation: Observation | undefined): string | undefined {
  return observation?.bodySite?.coding?.find((coding) => coding.system === ODOS_OPHTHALMOLOGY_CODE_SYSTEM)?.code;
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

test("P2 Wearing saved snapshot round-trips every eye and blank resave cannot overwrite or duplicate it", async () => {
  const { created, deps: d } = deps();
  const pair = { eyeglassType: "single_vision_distance", remarks: "Synthetic pair", OD: { sphere: -2, cylinder: -0.5, axis: 180, add: 1, prismAmount: 0.5, prismBase: "in", distanceVisualAcuity: "20/20", nearVisualAcuity: "20/20" }, OS: { sphere: -1.75 } };
  const saved = await handleWearingCaptureRequest(d, { authHeader: AUTH, body: { ...BODY, sourceType: "device", pairs: [pair, { eyeglassType: "single_vision_near", OS: { sphere: 0 } }] } });
  assert.equal(saved.status, 200);
  const before = structuredClone(created);
  const blank = await handleWearingCaptureRequest(d, { authHeader: AUTH, body: { ...BODY, pairs: [{ eyeglassType: "single_vision_distance" }] } });
  assert.equal(blank.status, 400);
  assert.deepEqual(created, before, "the pre-fix blank save refuses before any write");
  const endpoint = await import("../src/clinical-graph/pretest-endpoint.js");
  assert.equal(typeof endpoint.handleWearingHistoryRequest, "function", "Wearing needs a saved-value read path");
  const history = await endpoint.handleWearingHistoryRequest(d, { authHeader: AUTH, query: BODY });
  assert.equal(history.status, 200);
  const body = history.body as { pairs: Array<typeof pair & { id: string }>; sourceType: string };
  assert.equal(body.pairs.length, 2);
  assert.ok(body.pairs.every((value) => value.id));
  const { id, ...rest } = body.pairs[0]!;
  assert.deepEqual(rest, pair);
  assert.equal(body.sourceType, "device");
  assert.deepEqual(created, before, "history performs no persistence writes");
});

test("P2 Wearing history selects the latest complete capture, preserves zero, and excludes foreign or voided rows", async () => {
  const { created, deps: d } = deps();
  const endpoint = await import("../src/clinical-graph/pretest-endpoint.js");
  await handleWearingCaptureRequest(d, { authHeader: AUTH, body: { ...BODY, pairs: [{ eyeglassType: "single_vision_distance", OD: { sphere: -2 } }] } });
  d.now = () => "2026-07-10T15:00:00.000Z";
  await handleWearingCaptureRequest(d, { authHeader: AUTH, body: { ...BODY, pairs: [{ eyeglassType: "single_vision_near", OS: { sphere: 0 } }] } });
  const newest = created.findLast(({ resource }) => resource.resourceType === "Observation")!.resource as Observation;
  for (const change of [
    { subject: { reference: "Patient/foreign" } },
    { encounter: { reference: "Encounter/foreign" } },
    { status: "entered-in-error" as const },
  ]) created.push({ resource: { ...structuredClone(newest), id: "synthetic-excluded", effectiveDateTime: "2026-07-10T16:00:00.000Z", ...change } });
  const history = await endpoint.handleWearingHistoryRequest(d, { authHeader: AUTH, query: BODY });
  const body = history.body as { pairs: Array<{ eyeglassType: string; OD?: unknown; OS: { sphere: number } }> };
  assert.equal(history.status, 200);
  assert.equal(body.pairs.length, 1);
  assert.equal(body.pairs[0]!.eyeglassType, "single_vision_near");
  assert.deepEqual(body.pairs[0]!.OS, { sphere: 0 });
  assert.equal(body.pairs[0]!.OD, undefined);
});

test("Wearing history refuses distinct captures that share the latest recording timestamp", async () => {
  const { created, deps: d } = deps();
  await handleWearingCaptureRequest(d, { authHeader: AUTH, body: { ...BODY, pairs: [
    { eyeglassType: "single_vision_distance", OD: { sphere: -2 } },
    { eyeglassType: "single_vision_near", OD: { sphere: -1 } },
  ] } });
  await handleWearingCaptureRequest(d, { authHeader: AUTH, body: { ...BODY, pairs: [
    { eyeglassType: "progressives", OD: { sphere: -3 } },
  ] } });

  const { handleWearingHistoryRequest } = await import("../src/clinical-graph/pretest-endpoint.js");
  const history = await handleWearingHistoryRequest(d, { authHeader: AUTH, query: BODY });
  assert.equal(history.status, 409);
  assert.match(String((history.body as { error: string }).error), /same recording time/);
});

test("Wearing history keeps a legacy multi-pair capture readable without capture identity", async () => {
  const { created, deps: d } = deps();
  await handleWearingCaptureRequest(d, { authHeader: AUTH, body: { ...BODY, pairs: [
    { eyeglassType: "single_vision_distance", OD: { sphere: -2 } },
    { eyeglassType: "progressives", OD: { sphere: -3 } },
  ] } });
  for (const entry of created) {
    if (entry.resource.resourceType !== "Observation") continue;
    entry.resource.component = entry.resource.component?.filter((component) =>
      !component.code.coding?.some((coding) => coding.code === "WEARING_CAPTURE_ID"));
  }

  const { handleWearingHistoryRequest } = await import("../src/clinical-graph/pretest-endpoint.js");
  const history = await handleWearingHistoryRequest(d, { authHeader: AUTH, query: BODY });
  assert.equal(history.status, 200);
  assert.deepEqual(
    (history.body as { pairs: Array<{ eyeglassType: string }> }).pairs.map((pair) => pair.eyeglassType),
    ["single_vision_distance", "progressives"],
  );
});

test("P2 Wearing left-at-home history stays distinct from an empty unsaved form", async () => {
  const { deps: d } = deps();
  await handleWearingCaptureRequest(d, { authHeader: AUTH, body: { ...BODY, leftGlassesAtHome: true } });
  const { handleWearingHistoryRequest } = await import("../src/clinical-graph/pretest-endpoint.js");
  const history = await handleWearingHistoryRequest(d, { authHeader: AUTH, query: BODY });
  assert.equal(history.status, 200);
  assert.equal((history.body as { leftGlassesAtHome: boolean }).leftGlassesAtHome, true);
  assert.deepEqual((history.body as { pairs: unknown[] }).pairs, []);
});

test("P2 Wearing history requires scoped references and refuses a truncated result", async () => {
  const { handleWearingHistoryRequest } = await import("../src/clinical-graph/pretest-endpoint.js");
  const { deps: d } = deps();
  assert.equal((await handleWearingHistoryRequest(d, { authHeader: undefined, query: BODY })).status, 401);
  assert.equal((await handleWearingHistoryRequest(d, { authHeader: AUTH, query: {} })).status, 400);
  const staff = (await d.authenticate(AUTH))!;
  staff.fhir.search = async () => ({ resourceType: "Bundle", type: "searchset", entry: [], link: [{ relation: "next", url: "Observation?page=2" }] });
  const result = await handleWearingHistoryRequest({ ...d, authenticate: async () => staff }, { authHeader: AUTH, query: BODY });
  assert.equal(result.status, 409);
  assert.match(String((result.body as { error: string }).error), /no partial form/);
});
