import assert from "node:assert/strict";
import { test } from "node:test";
import type { Observation, Provenance } from "@medplum/fhirtypes";
import type { PracticeRoleId } from "../src/authz/roles.js";
import {
  handleCupDiscCaptureRequest,
  handleCupDiscDefinitionRequest,
  type CupDiscEndpointDeps,
} from "../src/clinical-graph/cup-disc-endpoint.js";
import {
  addGlaucomaCupDiscDescriptorOption,
  buildGlaucomaFindingDefinitionStubs,
} from "../src/clinical-graph/glaucoma-suspect.js";

const AUTH = "Bearer good";
const BODY = {
  patientReference: "Patient/p1",
  encounterReference: "Encounter/e1",
};

function deps(
  role: PracticeRoleId = "clinician",
  findingDefinitions?: CupDiscEndpointDeps["findingDefinitions"],
) {
  const created: Array<{ resource: Observation | Provenance; headers?: Record<string, string> }> = [];
  const d: CupDiscEndpointDeps = {
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

test("cup/disc definition endpoint serves practice-editable field options from the finding definition", async () => {
  const { deps: d } = deps();

  const res = await handleCupDiscDefinitionRequest(d, { authHeader: AUTH });

  assert.equal(res.status, 200);
  const body = res.body as { definition: { fields: Record<string, { options?: Array<{ code: string }> }> } };
  assert.deepEqual(
    body.definition.fields.discNerveSize.options?.map((option) => option.code),
    ["small", "average", "large"],
  );
  assert.deepEqual(
    body.definition.fields.methodSource.options?.map((option) => option.code),
    ["78d", "90d", "20d", "direct"],
  );
  assert.deepEqual(
    body.definition.fields.discAppearanceDescriptors.options?.map((option) => option.code),
    ["notching", "inferior-thinning", "splinter-heme", "ppa", "deep", "pallor"],
  );
});

test("cup/disc endpoint persists neutral Observation and returns normal without an ICD code", async () => {
  const { created, deps: d } = deps();

  const res = await handleCupDiscCaptureRequest(d, {
    authHeader: AUTH,
    body: {
      ...BODY,
      eyes: {
        OD: { verticalCupDiscRatio: 0.3 },
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
  const targets = (created[1]?.resource as Provenance).target;
  assert.equal(targets[0]?.reference?.startsWith("Observation/"), true);
  assert.equal(targets[1]?.reference, BODY.patientReference);
});

test("cup/disc endpoint returns high-risk H40.02x suggestion metadata without creating a Condition", async () => {
  const { created, deps: d } = deps();

  const res = await handleCupDiscCaptureRequest(d, {
    authHeader: AUTH,
    body: {
      ...BODY,
      eyes: {
        OS: { verticalCupDiscRatio: 0.75, methodSource: "90d" },
      },
    },
  });

  assert.equal(res.status, 200);
  const body = res.body as { eyes: { OS: { riskTier: string; icd10Code?: string; signals: string[] } } };
  assert.equal(body.eyes.OS.riskTier, "high");
  assert.match(body.eyes.OS.icd10Code ?? "", /^H40\.02/);
  assert.deepEqual(body.eyes.OS.signals, ["vertical-cup-disc-ratio"]);
  assert.equal(created.some((entry) => entry.resource.resourceType === "Condition"), false);
});

test("cup/disc endpoint relies on the evaluator for cross-eye asymmetry", async () => {
  const { deps: d } = deps();

  const res = await handleCupDiscCaptureRequest(d, {
    authHeader: AUTH,
    body: {
      ...BODY,
      eyes: {
        OD: { verticalCupDiscRatio: 0.3 },
        OS: { verticalCupDiscRatio: 0.6 },
      },
    },
  });

  assert.equal(res.status, 200);
  const body = res.body as {
    eyes: Record<"OD" | "OS", { riskTier: string; cupDiscAsymmetry?: number; signals: string[] }>;
  };
  assert.equal(body.eyes.OD.riskTier, "high");
  assert.equal(body.eyes.OS.riskTier, "high");
  assert.equal(body.eyes.OD.cupDiscAsymmetry, 0.3);
  assert.equal(body.eyes.OS.cupDiscAsymmetry, 0.3);
  assert.equal(body.eyes.OD.signals.includes("cup-disc-asymmetry"), true);
  assert.equal(body.eyes.OS.signals.includes("cup-disc-asymmetry"), true);
});

test("cup/disc capture validates against a practice-edited runtime definition", async () => {
  const seed = buildGlaucomaFindingDefinitionStubs({
    provenance: {
      source: "manual",
      recordedAt: "2026-07-10T15:00:00.000Z",
      actorReference: "Practitioner/admin-1",
    },
  }).find((definition) => definition.stableKey === "cup_disc_ratio");
  assert.ok(seed);
  const edited = addGlaucomaCupDiscDescriptorOption(seed, {
    code: "practice-custom",
    display: "Practice custom",
    active: true,
  });
  const { deps: d } = deps("clinician", () => [edited]);

  const result = await handleCupDiscCaptureRequest(d, {
    authHeader: AUTH,
    body: {
      ...BODY,
      eyes: {
        OD: {
          verticalCupDiscRatio: 0.3,
          discAppearanceDescriptors: ["practice-custom"],
        },
      },
    },
  });

  assert.equal(result.status, 200);
});

test("cup/disc endpoint rejects unauthenticated and non-chart-write saves", async () => {
  const unauth = await handleCupDiscCaptureRequest(deps().deps, {
    authHeader: undefined,
    body: { ...BODY, eyes: { OD: { verticalCupDiscRatio: 0.3 } } },
  });
  assert.equal(unauth.status, 401);

  const forbidden = await handleCupDiscCaptureRequest(deps("front-desk").deps, {
    authHeader: AUTH,
    body: { ...BODY, eyes: { OD: { verticalCupDiscRatio: 0.3 } } },
  });
  assert.equal(forbidden.status, 403);
});
