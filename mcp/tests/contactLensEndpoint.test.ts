import assert from "node:assert/strict";
import { test } from "node:test";
import type { Observation, Provenance } from "@medplum/fhirtypes";
import type { PracticeRoleId } from "../src/authz/roles.js";
import {
  CONTACT_LENS_PARAMETER_CODE_SYSTEM,
  UCUM_CODE_SYSTEM,
} from "../src/fhir/contactLens.js";
import { ODOS_OPHTHALMOLOGY_CODE_SYSTEM } from "../src/fhir/ophthalmology/codeBindings.js";
import { buildSoftContactLensFindingDefinitionStub } from "../src/clinical-graph/contact-lens-definition.js";
import {
  handleSoftContactLensCaptureRequest,
  handleSoftContactLensDefinitionRequest,
  type ContactLensEndpointDeps,
} from "../src/clinical-graph/contact-lens-endpoint.js";
import type { ClinicalFindingDefinition } from "../src/clinical-graph/glaucoma-suspect.js";

const AUTH = "Bearer good";
const BODY = {
  patientReference: "Patient/p1",
  encounterReference: "Encounter/e1",
};

function deps(
  role: PracticeRoleId = "clinician",
  findingDefinitions?: ContactLensEndpointDeps["findingDefinitions"],
) {
  const created: Array<{ resource: Observation | Provenance; headers?: Record<string, string> }> = [];
  const d: ContactLensEndpointDeps = {
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

test("soft CL definition exposes editable manufacturer, product, usage, status, and condition catalogs", async () => {
  const response = await handleSoftContactLensDefinitionRequest(deps().deps, { authHeader: AUTH });

  assert.equal(response.status, 200);
  const fields = definitionFields(response.body);
  assert.deepEqual(optionDisplays(fields.manufacturer), [
    "Alcon Laboratories Inc",
    "Bausch & Lomb",
    "Cooper Vision",
    "Cooper Vision - Private Label",
    "Cooper-pearle Private Label",
    "Menicon America Inc",
    "Optical Connection Intl Corp",
    "Vistakon",
    "Retail Private Label",
  ]);
  assert.equal(fields.manufacturer?.editable, true);
  assert.equal(fields.product?.editable, true);
  assert.equal(fields.usage?.editable, true);
  assert.equal(fields.status?.editable, true);
  assert.equal(fields.underlyingCondition?.editable, true);
  assert.deepEqual(optionCodes(fields.underlyingCondition), ["prosthesis", "balance_lens", "not_recorded", "no_lens"]);
  assert.equal(fields.sphere?.step, 0.25);
  assert.equal(fields.overRefractionSphere?.step, 0.25);
});

test("manufacturer filters products and product metadata drives distinct parameter cascades", async () => {
  const response = await handleSoftContactLensDefinitionRequest(deps().deps, { authHeader: AUTH });
  const products = productOptions(definitionFields(response.body).product);

  const alconProducts = products.filter((product) => product.manufacturerCode === "alcon").map((product) => product.code);
  const cooperProducts = products.filter((product) => product.manufacturerCode === "cooper_vision").map((product) => product.code);
  assert.ok(alconProducts.includes("precision1"));
  assert.ok(alconProducts.includes("air_optix_colors"));
  assert.ok(!alconProducts.includes("biofinity"));
  assert.ok(cooperProducts.includes("biofinity"));
  assert.ok(cooperProducts.includes("myday"));
  assert.ok(!cooperProducts.includes("acuvue_oasys"));
  assert.equal(products.find((product) => product.code === "acuvue_oasys")?.manufacturerCode, "vistakon");

  const color = products.find((product) => product.code === "air_optix_colors");
  const multifocal = products.find((product) => product.code === "biofinity_multifocal");
  const plain = products.find((product) => product.code === "precision1");
  assert.deepEqual(color?.colorOptions?.map((option) => option.display), [
    "Amethyst", "Blue", "Brilliant Blue", "Brown", "Gemstone Green", "Gray", "Green",
  ]);
  assert.deepEqual(multifocal?.mfPowerOptions?.map((option) => option.code), ["low", "medium", "high"]);
  assert.deepEqual(plain?.baseCurveOptions?.map((option) => option.code), ["8.3"]);
  assert.deepEqual(plain?.diameterOptions?.map((option) => option.code), ["14.2"]);
  const oasys = products.find((product) => product.code === "acuvue_oasys");
  assert.deepEqual(oasys?.baseCurveOptions?.map((option) => option.code), ["8.4", "8.8"]);
  assert.deepEqual(oasys?.diameterOptions?.map((option) => option.code), ["14.0"]);
  assert.equal(plain?.colorOptions, undefined);
  assert.equal(plain?.mfPowerOptions, undefined);
});

test("both soft CL handlers enforce authentication and chart permissions", async () => {
  assert.equal((await handleSoftContactLensDefinitionRequest(deps().deps, { authHeader: undefined })).status, 401);
  assert.equal((await handleSoftContactLensDefinitionRequest(deps("auditor").deps, { authHeader: AUTH })).status, 403);
  assert.equal((await handleSoftContactLensCaptureRequest(deps().deps, {
    authHeader: undefined,
    body: softClBody(),
  })).status, 401);
  assert.equal((await handleSoftContactLensCaptureRequest(deps("front-desk").deps, {
    authHeader: AUTH,
    body: softClBody(),
  })).status, 403);
});

test("soft CL capture persists one Observation per eye using existing CL parameter codes and actor context", async () => {
  const { created, deps: d } = deps();
  const response = await handleSoftContactLensCaptureRequest(d, { authHeader: AUTH, body: softClBody() });

  assert.equal(response.status, 200);
  assert.deepEqual(created.map((entry) => entry.resource.resourceType), [
    "Observation", "Provenance", "Observation", "Provenance",
  ]);
  assert.equal(created.every((entry) => entry.headers?.["X-ODOS-Source"] === "mcp/save_section_observations"), true);
  for (const provenance of created
    .map((entry) => entry.resource)
    .filter((resource): resource is Provenance => resource.resourceType === "Provenance")) {
    assert.equal(provenance.target[1]?.reference, BODY.patientReference);
  }
  const observations = created.map((entry) => entry.resource).filter((resource): resource is Observation => resource.resourceType === "Observation");
  assert.equal(observations.every((observation) => observation.status === "preliminary"), true);
  assert.deepEqual(observations.map((observation) => observation.bodySite?.coding?.[0]?.code), ["OD", "OS"]);
  for (const observation of observations) {
    assert.equal(observation.code.coding?.some((coding) =>
      coding.system === ODOS_OPHTHALMOLOGY_CODE_SYSTEM && coding.code === "soft_contact_lens"), true);
    assert.equal(observation.subject?.reference, BODY.patientReference);
    assert.equal(observation.encounter?.reference, BODY.encounterReference);
    assert.equal(observation.performer?.[0]?.reference, "Practitioner/doc1");
    assert.equal(observation.effectiveDateTime, "2026-07-10T14:00:00.000Z");
  }
  const od = observations[0];
  assert.equal(componentValue(od, "base-curve-mm"), 8.6);
  assert.equal(componentValue(od, "diameter-mm"), 14.2);
  assert.equal(componentValue(od, "sphere-power"), -8);
  assert.equal(componentValue(od, "cylinder-power"), -1.25);
  assert.equal(componentValue(od, "axis-degree"), 90);
  assert.equal(componentValue(od, "add-power"), 2.25);
  for (const code of ["base-curve-mm", "diameter-mm", "sphere-power", "cylinder-power", "axis-degree", "add-power"]) {
    const component = findComponent(od, code);
    assert.equal(component?.code.coding?.[0]?.system, CONTACT_LENS_PARAMETER_CODE_SYSTEM);
    assert.equal(component?.valueQuantity?.system, UCUM_CODE_SYSTEM);
  }
  assert.equal(componentValue(od, "USAGE"), "multifocal");
  assert.equal(componentValue(od, "STATUS"), "dispensed_successful");
  assert.equal(componentValue(od, "BINOCULAR_PD_DISTANCE"), 62);
  assert.equal(componentValue(od, "COLOR_MF_POWER"), "high");
});

test("embedded over-refraction persists with a marker linked to the soft CL entry", async () => {
  const { created, deps: d } = deps();
  const response = await handleSoftContactLensCaptureRequest(d, { authHeader: AUTH, body: softClBody() });
  const od = created[0]?.resource as Observation;
  const lensEntryId = componentValue(od, "LENS_ENTRY_ID");

  assert.equal(response.status, 200);
  assert.match(String(lensEntryId), /^soft-contact-lens-/);
  assert.equal(componentValue(od, "OVER_REFRACTION_LENS_ENTRY_ID"), lensEntryId);
  assert.equal(componentValue(od, "OVER_REFRACTION_SPHERE"), 0.5);
  assert.equal(componentValue(od, "OVER_REFRACTION_CYLINDER"), -0.25);
  assert.equal(componentValue(od, "OVER_REFRACTION_AXIS"), 85);
  assert.equal(componentValue(od, "OVER_REFRACTION_DISTANCE_VA"), "20/20");
});

test("practice-edited manufacturer, product, and product cascade metadata are accepted end-to-end", async () => {
  const definition = practiceEditedDefinition();
  const configured = () => [definition];
  const definitionResponse = await handleSoftContactLensDefinitionRequest(deps("clinician", configured).deps, { authHeader: AUTH });
  const { created, deps: d } = deps("clinician", configured);
  const saveResponse = await handleSoftContactLensCaptureRequest(d, {
    authHeader: AUTH,
    body: {
      ...BODY,
      usage: "distance",
      status: "order_trial",
      eyes: {
        OD: {
          manufacturer: "practice_lab",
          product: "practice_aqua",
          colorMfPower: "sea_glass",
          sphere: -2.25,
        },
      },
    },
  });

  assert.equal(productOptions(definitionFields(definitionResponse.body).product).some((option) => option.code === "practice_aqua"), true);
  assert.equal(saveResponse.status, 200);
  assert.equal(componentValue(created[0]?.resource as Observation, "PRODUCT"), "practice_aqua");
  assert.equal(componentValue(created[0]?.resource as Observation, "COLOR_MF_POWER"), "sea_glass");
});

test("soft CL validation rejects cross-manufacturer and wrong product-cascade values", async () => {
  const wrongManufacturer = await handleSoftContactLensCaptureRequest(deps().deps, {
    authHeader: AUTH,
    body: { ...softClBody(), eyes: { OD: { manufacturer: "vistakon", product: "biofinity", sphere: -1 } } },
  });
  const wrongCascade = await handleSoftContactLensCaptureRequest(deps().deps, {
    authHeader: AUTH,
    body: { ...softClBody(), eyes: { OD: { manufacturer: "alcon", product: "precision1", colorMfPower: "blue", sphere: -1 } } },
  });

  assert.equal(wrongManufacturer.status, 400);
  assert.match(String((wrongManufacturer.body as { error: string }).error), /does not belong/);
  assert.equal(wrongCascade.status, 400);
  assert.match(String((wrongCascade.body as { error: string }).error), /unknown option/);
});

test("high-power soft CL capture never returns suggestion or edge payloads", async () => {
  const response = await handleSoftContactLensCaptureRequest(deps().deps, {
    authHeader: AUTH,
    body: softClBody(),
  });

  assert.equal(response.status, 200);
  assert.deepEqual(forbiddenDiagnosisKeys(response.body), []);
});

function softClBody() {
  return {
    ...BODY,
    usage: "multifocal",
    status: "dispensed_successful",
    binocularPdDistance: 62,
    binocularPdNear: 59,
    ouDistanceVisualAcuity: "20/20",
    ouNearVisualAcuity: "J1 (20/25) 4pt 0.50M",
    remarks: "Comfortable after settling.",
    assessmentRegimen: "Daily wear; replace monthly.",
    notes: "Return in one year.",
    eyes: {
      OD: {
        underlyingCondition: "not_recorded",
        manufacturer: "cooper_vision",
        product: "biofinity_multifocal",
        baseCurve: 8.6,
        diameter: 14.2,
        sphere: -8,
        cylinder: -1.25,
        axis: 90,
        add: 2.25,
        colorMfPower: "high",
        distanceVisualAcuity: "20/25",
        nearVisualAcuity: "J1 (20/25) 4pt 0.50M",
        distancePinholeVisualAcuity: "20/20",
        startDate: "2026-07-10",
        expirationDate: "2027-07-10",
        other: "Dominant eye.",
        overRefraction: {
          sphere: 0.5,
          cylinder: -0.25,
          axis: 85,
          distanceVisualAcuity: "20/20",
          nearVisualAcuity: "J1 (20/25) 4pt 0.50M",
        },
      },
      OS: {
        manufacturer: "alcon",
        product: "air_optix_colors",
        baseCurve: 8.6,
        diameter: 14.2,
        sphere: 7,
        colorMfPower: "blue",
        distanceVisualAcuity: "20/20",
      },
    },
  };
}

function practiceEditedDefinition(): ClinicalFindingDefinition {
  const definition = structuredClone(buildSoftContactLensFindingDefinitionStub({
    source: "manual",
    recordedAt: "2026-07-10T14:00:00.000Z",
    actorReference: "Practitioner/admin",
  }));
  const fields = definition.valueSchema.fields as Record<string, { options?: Array<Record<string, unknown>> }>;
  fields.manufacturer?.options?.push({ code: "practice_lab", display: "Practice Lab", active: true });
  fields.product?.options?.push({
    code: "practice_aqua",
    display: "Practice Aqua",
    active: true,
    manufacturerCode: "practice_lab",
    design: "color",
    colorOptions: [{ code: "sea_glass", display: "Sea Glass", active: true }],
  });
  definition.sourceStatus = "local-practice";
  return definition;
}

function definitionFields(body: unknown): Record<string, Record<string, unknown>> {
  return ((body as { definition: { fields: Record<string, Record<string, unknown>> } }).definition.fields);
}

function optionCodes(field: Record<string, unknown> | undefined): string[] {
  return ((field?.options ?? []) as Array<{ code: string }>).map((option) => option.code);
}

function optionDisplays(field: Record<string, unknown> | undefined): string[] {
  return ((field?.options ?? []) as Array<{ display: string }>).map((option) => option.display);
}

function productOptions(field: Record<string, unknown> | undefined): Array<{
  code: string;
  manufacturerCode: string;
  colorOptions?: Array<{ code: string; display: string }>;
  mfPowerOptions?: Array<{ code: string; display: string }>;
  baseCurveOptions?: Array<{ code: string; display: string }>;
  diameterOptions?: Array<{ code: string; display: string }>;
}> {
  return (field?.options ?? []) as Array<{
    code: string;
    manufacturerCode: string;
    colorOptions?: Array<{ code: string; display: string }>;
    mfPowerOptions?: Array<{ code: string; display: string }>;
    baseCurveOptions?: Array<{ code: string; display: string }>;
    diameterOptions?: Array<{ code: string; display: string }>;
  }>;
}

function findComponent(observation: Observation | undefined, code: string) {
  return observation?.component?.find((component) => component.code.coding?.some((coding) => coding.code === code));
}

function componentValue(observation: Observation | undefined, code: string): unknown {
  const component = findComponent(observation, code);
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
