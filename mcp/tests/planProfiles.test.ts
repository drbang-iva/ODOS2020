import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { test } from "node:test";
import type { Basic, Bundle, Resource, StructureDefinition } from "@medplum/fhirtypes";
import {
  BUSINESS_ACTIONS,
  PRACTICE_ROLE_IDS,
  ROLE_REGISTRY,
  assertBusinessActionAllowed,
} from "../src/authz/roles.js";
import {
  PLAN_PROFILE_EXTENSION_URL,
  buildPlanProfileResource,
  handlePlanProfilesRequest,
  loadPlanProfiles,
  parsePlanProfileResource,
  type PlanProfile,
} from "../src/reporting/plan-profiles.js";

const COMPLETE: PlanProfile = {
  id: "vsp-choice",
  planKey: "payer:VSP:choice",
  displayName: "VSP Choice",
  dispensingFeeCents: 1800,
  frameAllowanceCents: 15000,
  lensBaseReimbursementCents: 4200,
  contactLensPerBoxCents: 2800,
  active: true,
};

test("plan profile Basic round-trips every field through USD Money boundaries", () => {
  const resource = buildPlanProfileResource(COMPLETE);
  assert.deepEqual(parsePlanProfileResource({ ...resource, id: "basic-1" }), {
    ...COMPLETE,
    id: "basic-1",
  });
  const profile = resource.extension?.find(
    (extension) => extension.url === PLAN_PROFILE_EXTENSION_URL,
  );
  assert.equal(
    profile?.extension?.find((extension) => extension.url === "frame-allowance")
      ?.valueMoney?.value,
    150,
  );
});

test("identity-only plan profiles preserve absent money instead of fabricating zero", () => {
  const partial: PlanProfile = {
    id: "vsp",
    planKey: "payer:VSP",
    displayName: "VSP",
    active: true,
  };
  const parsed = parsePlanProfileResource(buildPlanProfileResource(partial, {
    resourceType: "Basic",
    id: partial.id,
    code: { text: "existing" },
  }));
  assert.deepEqual(parsed, partial);
  for (const field of [
    "dispensingFeeCents",
    "frameAllowanceCents",
    "lensBaseReimbursementCents",
    "contactLensPerBoxCents",
  ] as const) {
    assert.equal(Object.hasOwn(parsed, field), false, field);
  }
});

test("plan profiles reject fractional and negative cents at the store boundary", () => {
  assert.throws(
    () => buildPlanProfileResource({ ...COMPLETE, frameAllowanceCents: 1200.5 }),
    /whole number of cents/,
  );
  assert.throws(
    () => buildPlanProfileResource({ ...COMPLETE, contactLensPerBoxCents: -1 }),
    /whole number of cents/,
  );
  assert.throws(
    () => buildPlanProfileResource(
      { ...COMPLETE, planKey: "payer:changed" },
      buildPlanProfileResource(COMPLETE),
    ),
    /cannot change after creation/,
  );
});

test("active plan-profile reads follow every FHIR next link and exclude deactivated rows", async () => {
  const first = buildPlanProfileResource(COMPLETE);
  const second = buildPlanProfileResource({
    id: "eyemed",
    planKey: "payer:EyeMed",
    displayName: "EyeMed",
    active: true,
  });
  const inactive = buildPlanProfileResource({
    id: "inactive",
    planKey: "payer:Legacy",
    displayName: "Legacy Plan",
    active: false,
  });
  const seen: string[] = [];
  const client = {
    async search<T extends Resource>(): Promise<Bundle<T>> {
      return {
        resourceType: "Bundle",
        type: "searchset",
        entry: [{ resource: first as T }],
        link: [{ relation: "next", url: "https://fhir.test/Basic?_page=2" }],
      };
    },
    async searchUrl<T extends Resource>(url: string): Promise<Bundle<T>> {
      seen.push(url);
      return {
        resourceType: "Bundle",
        type: "searchset",
        entry: [{ resource: second as T }, { resource: inactive as T }],
      };
    },
  };
  const rows = await loadPlanProfiles(client, { activeOnly: true });
  assert.deepEqual(rows.map((row) => row.planKey), ["payer:EyeMed", "payer:VSP:choice"]);
  assert.deepEqual(seen, ["https://fhir.test/Basic?_page=2"]);
});

test("margin.read is registered and granted only to practice-admin", () => {
  assert.ok(BUSINESS_ACTIONS.includes("margin.read"));
  assertBusinessActionAllowed("practice-admin", "margin.read");
  assert.deepEqual(
    PRACTICE_ROLE_IDS.filter((role) => ROLE_REGISTRY[role].businessActions.includes("margin.read")),
    ["practice-admin"],
  );
});

test("plan-profile reads return honest unavailable instead of partial or zero data", async () => {
  const result = await handlePlanProfilesRequest({
    authenticate: async () => ({
      roles: ["practice-admin"],
      fhir: {
        async search<T extends Resource>(): Promise<Bundle<T>> {
          return {
            resourceType: "Bundle",
            type: "searchset",
            entry: [{
              resource: {
                resourceType: "Basic",
                code: {
                  coding: [{
                    system: "https://odos2020.com/fhir/CodeSystem/plan-profile",
                    code: "plan-profile",
                  }],
                  text: "Malformed",
                },
              } as T,
            }],
          };
        },
      },
    }),
  }, { authHeader: "Bearer admin" });
  assert.deepEqual(result, {
    status: 409,
    body: {
      status: "unavailable",
      reason: "Plan profiles are unavailable because one or more stored rows could not be read safely.",
    },
  });
});

test("odos-plan-profile is a registered R4 complex extension on Basic", async () => {
  const definition = JSON.parse(await readFile(resolve(
    import.meta.dirname,
    "../../data/canonical-extensions/odos-plan-profile.json",
  ), "utf8")) as StructureDefinition;
  assert.equal(definition.url, PLAN_PROFILE_EXTENSION_URL);
  assert.equal(definition.fhirVersion, "4.0.1");
  assert.equal(definition.type, "Extension");
  assert.deepEqual(definition.context, [{ type: "element", expression: "Basic" }]);
  assert.equal(
    definition.differential?.element?.find((element) => element.id === "Extension.url")
      ?.fixedUri,
    PLAN_PROFILE_EXTENSION_URL,
  );
  const sliceNames = definition.differential?.element
    ?.map((element) => element.sliceName)
    .filter(Boolean);
  assert.deepEqual(sliceNames, [
    "active",
    "dispensing-fee",
    "frame-allowance",
    "lens-base-reimbursement",
    "contact-lens-per-box",
  ]);
});
