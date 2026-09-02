import type { Bundle, Observation, ObservationComponent } from "@medplum/fhirtypes";
import { z } from "zod";
import { assertBusinessActionAllowed, staffHasBusinessAction, type PracticeRoleId } from "../authz/roles.js";
import { CONTACT_LENS_PARAMETER_CODE_SYSTEM } from "../fhir/contactLens.js";
import { ODOS_OPHTHALMOLOGY_CODE_SYSTEM } from "../fhir/ophthalmology/codeBindings.js";
import {
  customFieldEntries,
  observationCustomValue,
  pickerFieldOptions,
} from "./custom-fields.js";
import type { ClinicalFindingDefinition } from "./glaucoma-suspect.js";
import { isLiveObservation } from "./observation-liveness.js";

type Eye = "OD" | "OS";

export interface RefractionHistoryFhirClient {
  search<T extends Observation>(
    resourceType: T["resourceType"],
    params?: Record<string, string>,
  ): Promise<Bundle<T>>;
}

export interface RefractionHistoryEndpointDeps {
  authenticate(authHeader: string | undefined): Promise<{
    staffReference: string;
    actorRole: PracticeRoleId;
    fhir: RefractionHistoryFhirClient;
  } | null>;
  findingDefinitions?: () => ClinicalFindingDefinition[];
}

export interface RefractionHistoryExtra {
  code: string;
  label: string;
  value: number | string;
  unit?: string;
}

export interface GlassesHistoryRow {
  type: string;
  typeCode?: string;
  groupId?: string;
  date: string;
  encounterReference?: string;
  eye: Eye;
  sphere?: number;
  cylinder?: number;
  axis?: number;
  add?: number;
  distVA?: string;
  nearVA?: string;
  purpose?: string;
  extras?: RefractionHistoryExtra[];
}

export interface SoftContactLensHistoryRow {
  date: string;
  groupId?: string;
  encounterReference?: string;
  eye: Eye;
  manufacturer?: string;
  product?: string;
  baseCurve?: number;
  diameter?: number;
  sphere?: number;
  cylinder?: number;
  axis?: number;
  add?: number;
  colorMfPower?: string;
  distVA?: string;
  nearVA?: string;
  status?: string;
  extras?: RefractionHistoryExtra[];
}

export interface SpecialtyContactLensHistoryRow {
  date: string;
  encounterReference?: string;
  eye: Eye;
  product?: string;
  lensType?: string;
  material?: string;
  baseCurve?: number;
  diameter?: number;
  sphere?: number;
  cylinder?: number;
  axis?: number;
  add?: number;
  distVA?: string;
  nearVA?: string;
  extras?: RefractionHistoryExtra[];
}

export interface RefractionHistoryResponse {
  glasses: GlassesHistoryRow[];
  softCl: SoftContactLensHistoryRow[];
  specialtyCl: SpecialtyContactLensHistoryRow[];
}

const historyQuerySchema = z.object({
  patient: z.string().regex(/^Patient\/[^/]+$/),
}).strict();

const SEARCH_CODES = {
  refraction: `${ODOS_OPHTHALMOLOGY_CODE_SYSTEM}|REFRACTION`,
  wearing: `${ODOS_OPHTHALMOLOGY_CODE_SYSTEM}|wearing_rx`,
  autoRefraction: `${ODOS_OPHTHALMOLOGY_CODE_SYSTEM}|auto_refraction`,
  softCl: `${ODOS_OPHTHALMOLOGY_CODE_SYSTEM}|soft_contact_lens`,
  specialtyCl: `${ODOS_OPHTHALMOLOGY_CODE_SYSTEM}|specialty_contact_lens`,
} as const;

export async function handleRefractionHistoryRequest(
  deps: RefractionHistoryEndpointDeps,
  input: { authHeader: string | undefined; query: unknown },
): Promise<{ status: number; body: unknown }> {
  const staff = await deps.authenticate(input.authHeader);
  if (!staff) {
    return { status: 401, body: { error: "Authentication required to read refraction history." } };
  }
  if (!staffHasBusinessAction(staff, "chart.read")) {
    return { status: 403, body: { error: "chart.read role required" } };
  }

  const parsed = historyQuerySchema.safeParse(input.query);
  if (!parsed.success) {
    return { status: 400, body: { error: parsed.error.issues[0]?.message ?? "Invalid refraction history request." } };
  }

  const [refractionBundle, wearingBundle, autoRefractionBundle, softClBundle, specialtyClBundle] = await Promise.all([
    searchHistory(staff.fhir, parsed.data.patient, SEARCH_CODES.refraction),
    searchHistory(staff.fhir, parsed.data.patient, SEARCH_CODES.wearing),
    searchHistory(staff.fhir, parsed.data.patient, SEARCH_CODES.autoRefraction),
    searchHistory(staff.fhir, parsed.data.patient, SEARCH_CODES.softCl),
    searchHistory(staff.fhir, parsed.data.patient, SEARCH_CODES.specialtyCl),
  ]);
  const definitions = deps.findingDefinitions?.() ?? [];
  const refractionDefinition = definitionByKey(definitions, "refraction");
  const wearingDefinition = definitionByKey(definitions, "wearing_rx");
  const softClDefinition = definitionByKey(definitions, "soft_contact_lens");
  const specialtyClDefinition = definitionByKey(definitions, "specialty_contact_lens");

  const body: RefractionHistoryResponse = {
    glasses: [
      ...bundleResources(refractionBundle).flatMap((observation) => refractionRows(observation, refractionDefinition)),
      ...bundleResources(wearingBundle).flatMap((observation) => wearingRows(observation, wearingDefinition)),
      ...bundleResources(autoRefractionBundle).flatMap(autoRefractionRows),
    ].sort(compareRowsNewestFirst),
    softCl: bundleResources(softClBundle)
      .flatMap((observation) => softContactLensRows(observation, softClDefinition))
      .sort(compareRowsNewestFirst),
    specialtyCl: bundleResources(specialtyClBundle)
      .flatMap((observation) => specialtyContactLensRows(observation, specialtyClDefinition))
      .sort(compareRowsNewestFirst),
  };

  return { status: 200, body };
}

function searchHistory(
  fhir: RefractionHistoryFhirClient,
  patientReference: string,
  code: string,
): Promise<Bundle<Observation>> {
  return fhir.search<Observation>("Observation", {
    subject: patientReference,
    code,
    _sort: "-date",
    _count: "200",
  });
}

function refractionRows(
  observation: Observation,
  definition: ClinicalFindingDefinition | undefined,
): GlassesHistoryRow[] {
  const eye = observationEye(observation);
  const date = observation.effectiveDateTime;
  const typeComponent = component(observation, "REFRACTION_TYPE");
  const typeCode = typeComponent?.valueCodeableConcept?.coding?.find((coding) => coding.code)?.code;
  const type = typeComponent?.valueCodeableConcept?.coding?.find((coding) => coding.display)?.display
    ?? typeComponent?.valueCodeableConcept?.text
    ?? typeComponent?.valueCodeableConcept?.coding?.find((coding) => coding.code)?.code;
  if (!eye || !date || !type) return [];
  return [definedRow({
    type,
    typeCode,
    groupId: componentString(observation, "REFRACTION_BLOCK_ID"),
    date,
    encounterReference: observation.encounter?.reference,
    eye,
    sphere: componentNumber(observation, "SPHERE"),
    cylinder: componentNumber(observation, "CYLINDER"),
    axis: componentNumber(observation, "AXIS"),
    add: componentNumber(observation, "ADD"),
    distVA: componentString(observation, "DISTANCE_VA"),
    nearVA: componentString(observation, "NEAR_VA"),
    purpose: componentString(observation, "PURPOSE"),
    extras: extrasOrUndefined(customExtras(observation, definition)),
  })];
}

function wearingRows(
  observation: Observation,
  definition: ClinicalFindingDefinition | undefined,
): GlassesHistoryRow[] {
  const date = observation.effectiveDateTime;
  if (!date) return [];
  return (["OD", "OS"] as const).flatMap((eye) => {
    const row = definedRow({
      type: "Wearing",
      typeCode: "WEARING_RX",
      groupId: componentString(observation, "PAIR_ID"),
      date,
      encounterReference: observation.encounter?.reference,
      eye,
      sphere: componentNumber(observation, `${eye}_SPHERE`),
      cylinder: componentNumber(observation, `${eye}_CYLINDER`),
      axis: componentNumber(observation, `${eye}_AXIS`),
      add: componentNumber(observation, `${eye}_ADD`),
      distVA: componentString(observation, `${eye}_DISTANCE_VA`),
      nearVA: componentString(observation, `${eye}_NEAR_VA`),
      extras: extrasOrUndefined(customExtras(observation, definition, `${eye}_`)),
    });
    return hasMeasuredValue(row) ? [row] : [];
  });
}

function autoRefractionRows(observation: Observation): GlassesHistoryRow[] {
  const eye = observationEye(observation);
  const date = observation.effectiveDateTime;
  if (!eye || !date) return [];
  const row = definedRow({
    type: "Auto-refraction",
    typeCode: "AUTO_REFRACTION",
    groupId: componentString(observation, "AUTO_REFRACTION_CAPTURE_ID"),
    date,
    encounterReference: observation.encounter?.reference,
    eye,
    sphere: componentNumber(observation, "SPHERE"),
    cylinder: componentNumber(observation, "CYLINDER"),
    axis: componentNumber(observation, "AXIS"),
  });
  return hasMeasuredValue(row) ? [row] : [];
}

function softContactLensRows(
  observation: Observation,
  definition: ClinicalFindingDefinition | undefined,
): SoftContactLensHistoryRow[] {
  const eye = observationEye(observation);
  const date = observation.effectiveDateTime;
  if (!eye || !date) return [];
  return [definedRow({
    date,
    groupId: componentString(observation, "SOFT_CONTACT_LENS_PRESCRIPTION_ID"),
    encounterReference: observation.encounter?.reference,
    eye,
    manufacturer: componentString(observation, "MANUFACTURER"),
    product: componentString(observation, "PRODUCT"),
    baseCurve: contactLensParameterNumber(observation, "base-curve-mm"),
    diameter: contactLensParameterNumber(observation, "diameter-mm"),
    sphere: contactLensParameterNumber(observation, "sphere-power"),
    cylinder: contactLensParameterNumber(observation, "cylinder-power"),
    axis: contactLensParameterNumber(observation, "axis-degree"),
    add: contactLensParameterNumber(observation, "add-power"),
    colorMfPower: componentString(observation, "COLOR_MF_POWER"),
    distVA: componentString(observation, "DISTANCE_VA"),
    nearVA: componentString(observation, "NEAR_VA"),
    status: componentString(observation, "STATUS"),
    extras: extrasOrUndefined(customExtras(observation, definition)),
  })];
}

function specialtyContactLensRows(
  observation: Observation,
  definition: ClinicalFindingDefinition | undefined,
): SpecialtyContactLensHistoryRow[] {
  const eye = observationEye(observation);
  const date = observation.effectiveDateTime;
  if (!eye || !date) return [];
  return [definedRow({
    date,
    encounterReference: observation.encounter?.reference,
    eye,
    product: componentString(observation, "PRODUCT"),
    lensType: componentConceptCode(observation, "LENS_TYPE"),
    material: componentConceptCode(observation, "MATERIAL"),
    baseCurve: contactLensParameterNumber(observation, "base-curve-mm"),
    diameter: contactLensParameterNumber(observation, "diameter-mm"),
    sphere: contactLensParameterNumber(observation, "sphere-power"),
    cylinder: contactLensParameterNumber(observation, "cylinder-power"),
    axis: contactLensParameterNumber(observation, "axis-degree"),
    add: contactLensParameterNumber(observation, "add-power"),
    distVA: componentString(observation, "DISTANCE_VA"),
    nearVA: componentString(observation, "NEAR_VA"),
    extras: extrasOrUndefined(specialtyExtras(observation, definition)),
  })];
}

function observationEye(observation: Observation): Eye | undefined {
  const code = observation.bodySite?.coding?.find((coding) => coding.code === "OD" || coding.code === "OS")?.code
    ?? observation.extension?.flatMap((extension) => extension.valueCodeableConcept?.coding ?? [])
      .find((coding) => coding.code === "OD" || coding.code === "OS")?.code;
  return code === "OD" || code === "OS" ? code : undefined;
}

function component(observation: Observation, code: string): ObservationComponent | undefined {
  return observation.component?.find((candidate) => candidate.code.coding?.some((coding) => coding.code === code));
}

function componentNumber(observation: Observation, code: string): number | undefined {
  const value = component(observation, code)?.valueQuantity?.value;
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function contactLensParameterNumber(observation: Observation, code: string): number | undefined {
  const value = observation.component?.find((candidate) => candidate.code.coding?.some((coding) =>
    coding.system === CONTACT_LENS_PARAMETER_CODE_SYSTEM && coding.code === code))?.valueQuantity?.value;
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function componentString(observation: Observation, code: string): string | undefined {
  const value = component(observation, code)?.valueString;
  return typeof value === "string" && value !== "" ? value : undefined;
}

function componentConceptCode(observation: Observation, code: string): string | undefined {
  const matched = component(observation, code);
  return matched?.valueCodeableConcept?.coding?.find((coding) => coding.code)?.code
    ?? matched?.valueString;
}

function customExtras(
  observation: Observation,
  definition: ClinicalFindingDefinition | undefined,
  codePrefix = "",
): RefractionHistoryExtra[] {
  if (!definition) return [];
  return customFieldEntries(definition, true).flatMap((field) => {
    const value = observationCustomValue(observation, field, codePrefix);
    return value === undefined ? [] : [{
      code: field.localCode,
      label: field.display,
      value: Array.isArray(value) ? value.join(", ") : value,
      ...(field.unit ? { unit: field.unit } : {}),
    }];
  });
}

function specialtyExtras(
  observation: Observation,
  definition: ClinicalFindingDefinition | undefined,
): RefractionHistoryExtra[] {
  if (!definition) return [];
  return pickerFieldOptions(definition, true).flatMap((field) => {
    if (field.origin === "practice") {
      const custom = customFieldEntries(definition, true)
        .find((candidate) => candidate.localCode === field.localCode);
      const value = custom ? observationCustomValue(observation, custom) : undefined;
      return value === undefined ? [] : [{
        code: field.localCode,
        label: field.display,
        value: Array.isArray(value) ? value.join(", ") : value,
        ...(field.unit ? { unit: field.unit } : {}),
      }];
    }
    const localValue = componentNumber(observation, field.localCode);
    const canonicalValue = field.parameterCode
      ? contactLensParameterNumber(observation, field.parameterCode)
      : undefined;
    const value = localValue ?? canonicalValue;
    return value === undefined ? [] : [{
      code: field.localCode,
      label: field.display,
      value: Array.isArray(value) ? value.join(", ") : value,
      ...(field.unit ? { unit: field.unit } : {}),
    }];
  });
}

function extrasOrUndefined(extras: RefractionHistoryExtra[]): RefractionHistoryExtra[] | undefined {
  return extras.length ? extras : undefined;
}

function definitionByKey(
  definitions: readonly ClinicalFindingDefinition[],
  stableKey: string,
): ClinicalFindingDefinition | undefined {
  return definitions.find((definition) => definition.stableKey === stableKey);
}

function hasMeasuredValue(row: GlassesHistoryRow): boolean {
  return row.sphere !== undefined || row.cylinder !== undefined || row.axis !== undefined || row.add !== undefined
    || row.distVA !== undefined || row.nearVA !== undefined;
}

function definedRow<T extends object>(row: T): T {
  return Object.fromEntries(Object.entries(row).filter(([, value]) => value !== undefined)) as T;
}

function compareRowsNewestFirst<T extends { date: string; eye: Eye }>(a: T, b: T): number {
  return b.date.localeCompare(a.date) || a.eye.localeCompare(b.eye);
}

function bundleResources(bundle: Bundle<Observation>): Observation[] {
  return bundle.entry?.flatMap((entry) => entry.resource && isLiveObservation(entry.resource) ? [entry.resource] : []) ?? [];
}

function staffMayRead(role: PracticeRoleId): boolean {
  try {
    assertBusinessActionAllowed(role, "chart.read");
    return true;
  } catch {
    return false;
  }
}
