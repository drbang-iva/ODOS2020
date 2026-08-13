import assert from "node:assert/strict";
import { test } from "node:test";
import type { Bundle, Observation, Provenance } from "@medplum/fhirtypes";
import type { PracticeRoleId } from "../src/authz/roles.js";
import {
  CONTACT_LENS_MATERIAL_CODE_SYSTEM,
  CONTACT_LENS_PARAMETER_CODE_SYSTEM,
  CONTACT_LENS_TYPE_CODE_SYSTEM,
  UCUM_CODE_SYSTEM,
} from "../src/fhir/contactLens.js";
import { ODOS_OPHTHALMOLOGY_CODE_SYSTEM } from "../src/fhir/ophthalmology/codeBindings.js";
import { odosConcept } from "../src/fhir/ophthalmology/extensions.js";
import { buildSpecialtyContactLensFindingDefinitionStub } from "../src/clinical-graph/contact-lens-definition.js";
import {
  handleSpecialtyContactLensCaptureRequest,
  handleSpecialtyContactLensDefinitionRequest,
  handleSpecialtyKeratometryRequest,
  type SpecialtyContactLensEndpointDeps,
} from "../src/clinical-graph/contact-lens-endpoint.js";
import { AUTO_KERATOMETRY_SEARCH_CODE } from "../src/clinical-graph/pretest-endpoint.js";
import type { ClinicalFindingDefinition } from "../src/clinical-graph/glaucoma-suspect.js";

const AUTH = "Bearer good";
const BODY = {
  patientReference: "Patient/p1",
  encounterReference: "Encounter/e1",
};

function deps(input: {
  role?: PracticeRoleId;
  findingDefinitions?: SpecialtyContactLensEndpointDeps["findingDefinitions"];
  searchBundle?: Bundle<Observation>;
} = {}) {
  const created: Array<{ resource: Observation | Provenance; headers?: Record<string, string> }> = [];
  const searches: Array<{ resourceType: string; params?: Record<string, string> }> = [];
  const d: SpecialtyContactLensEndpointDeps = {
    findingDefinitions: input.findingDefinitions,
    authenticate: async (authHeader) => authHeader === AUTH
      ? {
          staffReference: "Practitioner/doc1",
          actorRole: input.role ?? "provider",
          fhir: {
            create: async <T extends Observation | Provenance>(
              resource: T,
              headers?: Record<string, string>,
            ): Promise<T> => {
              created.push({ resource, headers });
              return { ...resource, id: resource.id ?? `${resource.resourceType.toLowerCase()}-${created.length}` };
            },
            search: async <T extends Observation>(
              resourceType: T["resourceType"],
              params?: Record<string, string>,
            ): Promise<Bundle<T>> => {
              searches.push({ resourceType, params });
              return (input.searchBundle ?? { resourceType: "Bundle", type: "searchset", entry: [] }) as Bundle<T>;
            },
          },
        }
      : null,
    now: () => "2026-07-10T14:00:00.000Z",
  };
  return { created, searches, deps: d };
}

test("specialty CL definition exposes sparse editable catalogs and the fixed additional-field pool", async () => {
  const response = await handleSpecialtyContactLensDefinitionRequest(deps().deps, { authHeader: AUTH });

  assert.equal(response.status, 200);
  const fields = definitionFields(response.body);
  assert.deepEqual(optionDisplays(fields.manufacturer), [
    "Art Optical", "Blanchard", "Paragon CRT", "Wave Contact Lens System",
  ]);
  assert.equal(optionDisplays(fields.manufacturer).includes("Boston"), false);
  assert.deepEqual(optionDisplays(fields.material), ["Boston XO2", "Boston ES", "Fluoroperm"]);
  assert.deepEqual(optionDisplays(fields.product).slice(0, 5), [
    "Ampleye", "Renovation", "CLASIKcn", "So2Clear Progressive", "Intelliwave",
  ]);
  assert.equal(fields.product?.manualEntryFeedsCatalog, true);
  assert.equal(fields.lensType?.editable, true);
  assert.equal(fields.material?.editable, true);
  assert.equal(fields.additionalFields?.editable, true);
  assert.equal(fields.additionalFields?.allowCreate, false);
  assert.equal(optionDisplays(fields.additionalFields).length, 17);
  const additional = optionRows(fields.additionalFields);
  assert.equal(additional.find((field) => field.code === "skirt")?.parameterCode, "soft-skirt-curve");
  assert.equal(additional.find((field) => field.code === "sag")?.parameterCode, "sagittal-depth-um");
  assert.equal(additional.find((field) => field.code === "segment_height")?.parameterCode, "segment-height-lower-edge-mm");
  assert.equal(additional.find((field) => field.code === "center_thickness")?.parameterCode, "center-thickness-mm");
  assert.equal(additional.find((field) => field.code === "base_curve_2")?.parameterCode, undefined);
});

test("specialty CL handlers enforce authentication, practice-wide reads, and read-only Admin", async () => {
  assert.equal((await handleSpecialtyContactLensDefinitionRequest(deps().deps, { authHeader: undefined })).status, 401);
  assert.equal((await handleSpecialtyContactLensDefinitionRequest(deps({ role: "admin" }).deps, { authHeader: AUTH })).status, 200);
  assert.equal((await handleSpecialtyContactLensCaptureRequest(deps().deps, {
    authHeader: undefined,
    body: specialtyBody(),
  })).status, 401);
  assert.equal((await handleSpecialtyContactLensCaptureRequest(deps({ role: "admin" }).deps, {
    authHeader: AUTH,
    body: specialtyBody(),
  })).status, 403);
  assert.equal((await handleSpecialtyKeratometryRequest(deps().deps, {
    authHeader: undefined,
    query: { patient: BODY.patientReference },
  })).status, 401);
  assert.equal((await handleSpecialtyKeratometryRequest(deps({ role: "admin" }).deps, {
    authHeader: AUTH,
    query: { patient: BODY.patientReference },
  })).status, 200);
});

test("specialty CL capture persists per eye with existing type, material, and parameter codes", async () => {
  const { created, deps: d } = deps();
  const response = await handleSpecialtyContactLensCaptureRequest(d, { authHeader: AUTH, body: specialtyBody() });

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
  const od = observations[0];
  assert.equal(od?.code.coding?.some((coding) => coding.system === ODOS_OPHTHALMOLOGY_CODE_SYSTEM && coding.code === "specialty_contact_lens"), true);
  assert.equal(od?.performer?.[0]?.reference, "Practitioner/doc1");
  assert.equal(od?.effectiveDateTime, "2026-07-10T14:00:00.000Z");
  assert.equal(componentValue(od, "base-curve-mm"), 7.8);
  assert.equal(componentValue(od, "diameter-mm"), 16.5);
  assert.equal(componentValue(od, "sphere-power"), -8);
  assert.equal(findComponent(od, "scleral-toric-haptic")?.valueCodeableConcept?.coding?.[0]?.system, CONTACT_LENS_TYPE_CODE_SYSTEM);
  assert.equal(findComponent(od, "Boston-XO2")?.valueCodeableConcept?.coding?.[0]?.system, CONTACT_LENS_MATERIAL_CODE_SYSTEM);
  assert.equal(componentValue(od, "soft-skirt-curve"), 8.4);
  assert.equal(componentValue(od, "sagittal-depth-um"), 4550);
  assert.equal(componentValue(od, "segment-height-lower-edge-mm"), 3.5);
  assert.equal(componentValue(od, "center-thickness-mm"), 0.32);
  for (const code of ["soft-skirt-curve", "sagittal-depth-um", "segment-height-lower-edge-mm", "center-thickness-mm"]) {
    const component = findComponent(od, code);
    assert.equal(component?.code.coding?.[0]?.system, CONTACT_LENS_PARAMETER_CODE_SYSTEM);
    assert.equal(component?.valueQuantity?.system, UCUM_CODE_SYSTEM);
  }
  assert.equal(componentValue(od, "SPECIALTY_HVID_MM"), 11.8);
  assert.equal(findComponent(od, "SPECIALTY_HVID_MM")?.code.coding?.[0]?.system, ODOS_OPHTHALMOLOGY_CODE_SYSTEM);
});

test("additional fields persist only while selected and populated", async () => {
  const first = deps();
  await handleSpecialtyContactLensCaptureRequest(first.deps, {
    authHeader: AUTH,
    body: {
      ...BODY,
      eyes: { OD: { sphere: -2, additionalFields: [{ code: "hvid", value: 11.7 }, { code: "sag", value: 4400 }] } },
    },
  });
  const second = deps();
  await handleSpecialtyContactLensCaptureRequest(second.deps, {
    authHeader: AUTH,
    body: {
      ...BODY,
      eyes: { OD: { sphere: -2, additionalFields: [{ code: "sag", value: 4400 }] } },
    },
  });

  assert.equal(componentValue(first.created[0]?.resource as Observation, "SPECIALTY_HVID_MM"), 11.7);
  assert.equal(componentValue(first.created[0]?.resource as Observation, "sagittal-depth-um"), 4400);
  assert.equal(findComponent(second.created[0]?.resource as Observation, "SPECIALTY_HVID_MM"), undefined);
  assert.equal(componentValue(second.created[0]?.resource as Observation, "sagittal-depth-um"), 4400);
});

test("manual entry bypasses catalog validation and practice-edited catalogs are accepted", async () => {
  const manual = await handleSpecialtyContactLensCaptureRequest(deps().deps, {
    authHeader: AUTH,
    body: {
      ...BODY,
      eyes: { OD: { manualEntry: true, manufacturer: "Local Lens Lab", product: "Dr Bang Design", sphere: -4 } },
    },
  });
  assert.equal(manual.status, 200);
  assert.deepEqual((manual.body as { catalogAdditions: unknown[] }).catalogAdditions, [
    { manufacturer: "Local Lens Lab", product: "Dr Bang Design", lensType: undefined },
  ]);

  const definition = practiceEditedDefinition();
  const configured = () => [definition];
  const configuredDeps = deps({ findingDefinitions: configured });
  const saved = await handleSpecialtyContactLensCaptureRequest(configuredDeps.deps, {
    authHeader: AUTH,
    body: {
      ...BODY,
      eyes: { OD: { manufacturer: "practice_lab", product: "practice_scleral", lensType: "scleral-prolate", sphere: -5 } },
    },
  });
  assert.equal(saved.status, 200);
  assert.equal(componentValue(configuredDeps.created[0]?.resource as Observation, "PRODUCT"), "practice_scleral");
});

test("embedded over-refraction remains linked to its specialty lens entry", async () => {
  const { created, deps: d } = deps();
  const response = await handleSpecialtyContactLensCaptureRequest(d, { authHeader: AUTH, body: specialtyBody() });
  const od = created[0]?.resource as Observation;
  const lensEntryId = componentValue(od, "LENS_ENTRY_ID");

  assert.equal(response.status, 200);
  assert.match(String(lensEntryId), /^specialty-contact-lens-/);
  assert.equal(componentValue(od, "OVER_REFRACTION_LENS_ENTRY_ID"), lensEntryId);
  assert.equal(componentValue(od, "OVER_REFRACTION_SPHERE"), 0.5);
  assert.equal(componentValue(od, "OVER_REFRACTION_DISTANCE_VA"), "20/20");
});

test("keratometry read searches Slice B auto-K and returns the latest observation per eye", async () => {
  const searchBundle = bundle([
    autoK("od-old", "OD", "2026-07-09T10:00:00.000Z", 42, 180, 43, 90),
    autoK("os-latest", "OS", "2026-07-10T09:00:00.000Z", 41.75, 52, 42.5, 142),
    autoK("od-latest", "OD", "2026-07-10T10:00:00.000Z", 42.5, 115, 43.25, 25),
  ]);
  const { deps: d, searches } = deps({ searchBundle });
  const response = await handleSpecialtyKeratometryRequest(d, {
    authHeader: AUTH,
    query: { patient: BODY.patientReference },
  });

  assert.equal(response.status, 200);
  assert.deepEqual(searches, [{
    resourceType: "Observation",
    params: {
      subject: BODY.patientReference,
      code: AUTO_KERATOMETRY_SEARCH_CODE,
      _sort: "-date",
      _count: "200",
    },
  }]);
  assert.equal("body-site" in (searches[0]?.params ?? {}), false);
  const eyes = (response.body as { eyes: Record<string, Record<string, unknown> | null> }).eyes;
  assert.deepEqual(eyes.OD, {
    flatK: 42.5,
    flatAxis: 115,
    steepK: 43.25,
    steepAxis: 25,
    recordedAt: "2026-07-10T10:00:00.000Z",
    observationReference: "Observation/od-latest",
  });
  assert.deepEqual(eyes.OS, {
    flatK: 41.75,
    flatAxis: 52,
    steepK: 42.5,
    steepAxis: 142,
    recordedAt: "2026-07-10T09:00:00.000Z",
    observationReference: "Observation/os-latest",
  });
});

test("keratometry read returns null when the bounded result has no matching eye", async () => {
  const response = await handleSpecialtyKeratometryRequest(
    deps({ searchBundle: bundle([autoK("od-only", "OD", "2026-07-10T10:00:00.000Z", 42, 180, 43, 90)]) }).deps,
    { authHeader: AUTH, query: { patient: BODY.patientReference } },
  );

  assert.equal(response.status, 200);
  const eyes = (response.body as { eyes: Record<string, Record<string, unknown> | null> }).eyes;
  assert.equal(eyes.OS, null);
});

test("high-power specialty CL capture never returns suggestion or edge payloads", async () => {
  const response = await handleSpecialtyContactLensCaptureRequest(deps().deps, {
    authHeader: AUTH,
    body: specialtyBody(),
  });

  assert.equal(response.status, 200);
  assert.deepEqual(forbiddenDiagnosisKeys(response.body), []);
});

function specialtyBody() {
  return {
    ...BODY,
    usage: "distance",
    status: "order_trial",
    remarks: "Good initial alignment.",
    eyes: {
      OD: {
        underlyingCondition: "not_recorded",
        manufacturer: "blanchard",
        product: "onefit_med",
        lensType: "scleral-toric-haptic",
        material: "Boston-XO2",
        baseCurve: 7.8,
        diameter: 16.5,
        sphere: -8,
        cylinder: -1.25,
        axis: 90,
        add: 2,
        distanceVisualAcuity: "20/25",
        nearVisualAcuity: "J1 (20/25) 4pt 0.50M",
        distancePinholeVisualAcuity: "20/20",
        other: "Trial lens one.",
        additionalFields: [
          { code: "hvid", value: 11.8 },
          { code: "skirt", value: 8.4 },
          { code: "sag", value: 4550 },
          { code: "segment_height", value: 3.5 },
          { code: "center_thickness", value: 0.32 },
        ],
        overRefraction: {
          sphere: 0.5,
          cylinder: -0.25,
          axis: 85,
          distanceVisualAcuity: "20/20",
          nearVisualAcuity: "J1 (20/25) 4pt 0.50M",
        },
      },
      OS: {
        manufacturer: "paragon_crt",
        product: "paragon_crt",
        lensType: "ortho-K",
        material: "Fluoroperm",
        baseCurve: 8.1,
        diameter: 10.5,
        sphere: 0.5,
      },
    },
  };
}

function practiceEditedDefinition(): ClinicalFindingDefinition {
  const definition = structuredClone(buildSpecialtyContactLensFindingDefinitionStub({
    source: "manual",
    recordedAt: "2026-07-10T14:00:00.000Z",
    actorReference: "Practitioner/admin",
  }));
  const fields = definition.valueSchema.fields as Record<string, { options?: Array<Record<string, unknown>> }>;
  fields.manufacturer?.options?.push({ code: "practice_lab", display: "Practice Lab", active: true });
  fields.product?.options?.push({
    code: "practice_scleral",
    display: "Practice Scleral",
    active: true,
    manufacturerCode: "practice_lab",
    lensTypeCode: "scleral-prolate",
  });
  definition.sourceStatus = "local-practice";
  return definition;
}

function autoK(
  id: string,
  eye: "OD" | "OS",
  effectiveDateTime: string,
  flatK: number,
  flatAxis: number,
  steepK: number,
  steepAxis: number,
): Observation {
  return {
    resourceType: "Observation",
    id,
    status: "final",
    code: odosConcept("auto_keratometry", "Auto-keratometry"),
    subject: { reference: BODY.patientReference },
    bodySite: odosConcept(eye, eye),
    effectiveDateTime,
    component: [
      quantityComponent("FLAT_K", flatK, "D"),
      quantityComponent("FLAT_AXIS", flatAxis, "degrees"),
      quantityComponent("STEEP_K", steepK, "D"),
      quantityComponent("STEEP_AXIS", steepAxis, "degrees"),
    ],
  };
}

function quantityComponent(code: string, value: number, unit: string): NonNullable<Observation["component"]>[number] {
  return { code: odosConcept(code, code), valueQuantity: { value, unit } };
}

function bundle(resources: Observation[]): Bundle<Observation> {
  return { resourceType: "Bundle", type: "searchset", entry: resources.map((resource) => ({ resource })) };
}

function definitionFields(body: unknown): Record<string, Record<string, unknown>> {
  return (body as { definition: { fields: Record<string, Record<string, unknown>> } }).definition.fields;
}

function optionRows(field: Record<string, unknown> | undefined): Array<Record<string, unknown>> {
  return (field?.options ?? []) as Array<Record<string, unknown>>;
}

function optionDisplays(field: Record<string, unknown> | undefined): string[] {
  return optionRows(field).map((option) => String(option.display));
}

function findComponent(observation: Observation | undefined, code: string) {
  return observation?.component?.find((component) =>
    component.code.coding?.some((coding) => coding.code === code) ||
    component.valueCodeableConcept?.coding?.some((coding) => coding.code === code));
}

function componentValue(observation: Observation | undefined, code: string): unknown {
  const component = findComponent(observation, code);
  return component?.valueQuantity?.value ?? component?.valueString ?? component?.valueBoolean ?? component?.valueCodeableConcept?.coding?.[0]?.code;
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
