import type { Observation, ObservationComponent } from "@medplum/fhirtypes";
import { ODOS_OPHTHALMOLOGY_CODE_SYSTEM } from "../fhir/ophthalmology/codeBindings.js";

export const LEGACY_ODOS_OPHTHALMOLOGY_CODE_SYSTEM =
  "https://osod.dev/fhir/CodeSystem/ophthalmology";
export const ELIGIBLE_REFRACTION_TYPES = ["CYCLOPLEGIC", "MANIFEST"] as const;

export type EligibleRefractionType = (typeof ELIGIBLE_REFRACTION_TYPES)[number];
export type RefractiveClassification = "MYOPIC" | "PRE_MYOPIA" | "NOT_MYOPIC";
export type RefractiveStatus = RefractiveClassification | "UNKNOWN";

export interface RefractivePower {
  sphere?: number;
  cylinder?: number;
}

export interface RefractiveStatusCandidate {
  refractionType: EligibleRefractionType;
  sphericalEquivalent: number;
  status: RefractiveClassification;
  refractionDate: string;
  observationReference: string;
}

export interface ResolvedRefractiveStatus {
  status: RefractiveStatus;
  sphericalEquivalent: number | null;
  refractionType: EligibleRefractionType | null;
  refractionDate: string | null;
  observationReference: string | null;
  candidates: RefractiveStatusCandidate[];
}

const MYOPIA_BOUNDARY_EPSILON = 1e-9;
const OPHTHALMOLOGY_CODE_SYSTEMS = new Set([
  ODOS_OPHTHALMOLOGY_CODE_SYSTEM,
  LEGACY_ODOS_OPHTHALMOLOGY_CODE_SYSTEM,
]);

export function sphericalEquivalent(power: RefractivePower): number | undefined {
  if (power.sphere === undefined && power.cylinder === undefined) return undefined;
  return (power.sphere ?? 0) + (power.cylinder ?? 0) / 2;
}

export function classifySphericalEquivalent(
  value: number,
): RefractiveClassification {
  if (value <= -0.5 + MYOPIA_BOUNDARY_EPSILON) return "MYOPIC";
  if (value <= 0.75 + MYOPIA_BOUNDARY_EPSILON) return "PRE_MYOPIA";
  return "NOT_MYOPIC";
}

export function resolveRefractiveStatus(
  observations: readonly Observation[],
  eye: "OD" | "OS",
  measuredAt: string,
  encounterReference?: string,
): ResolvedRefractiveStatus {
  const measuredAtMillis = Date.parse(measuredAt);
  const latestByType = new Map<
    EligibleRefractionType,
    { candidate: RefractiveStatusCandidate; sameEncounter: boolean }
  >();
  if (Number.isFinite(measuredAtMillis)) {
    for (const observation of observations) {
      const rankedCandidate = observationCandidate(
        observation,
        eye,
        measuredAtMillis,
        encounterReference,
      );
      if (!rankedCandidate) continue;
      const { candidate, sameEncounter } = rankedCandidate;
      const current = latestByType.get(candidate.refractionType);
      if (
        !current ||
        (sameEncounter && !current.sameEncounter) ||
        (
          sameEncounter === current.sameEncounter &&
          Date.parse(candidate.refractionDate) > Date.parse(current.candidate.refractionDate)
        ) ||
        (
          sameEncounter === current.sameEncounter &&
          candidate.refractionDate === current.candidate.refractionDate &&
          candidate.observationReference.localeCompare(current.candidate.observationReference) > 0
        )
      ) {
        latestByType.set(candidate.refractionType, { candidate, sameEncounter });
      }
    }
  }

  const candidates = ELIGIBLE_REFRACTION_TYPES.flatMap((type) => {
    const rankedCandidate = latestByType.get(type);
    return rankedCandidate ? [rankedCandidate.candidate] : [];
  });
  const resolved = (
    latestByType.get("CYCLOPLEGIC") ??
    latestByType.get("MANIFEST")
  )?.candidate;
  return resolved
    ? {
        status: resolved.status,
        sphericalEquivalent: resolved.sphericalEquivalent,
        refractionType: resolved.refractionType,
        refractionDate: resolved.refractionDate,
        observationReference: resolved.observationReference,
        candidates,
      }
    : {
        status: "UNKNOWN",
        sphericalEquivalent: null,
        refractionType: null,
        refractionDate: null,
        observationReference: null,
        candidates: [],
      };
}

function observationCandidate(
  observation: Observation,
  eye: "OD" | "OS",
  measuredAtMillis: number,
  encounterReference: string | undefined,
): { candidate: RefractiveStatusCandidate; sameEncounter: boolean } | null {
  const refractionDate = observation.effectiveDateTime;
  const refractionMillis = refractionDate ? Date.parse(refractionDate) : Number.NaN;
  const observationEye = eyeFromObservation(observation);
  const refractionType = componentCode(observation, "REFRACTION_TYPE");
  const sameEncounter =
    encounterReference !== undefined &&
    observation.encounter?.reference === encounterReference;
  if (
    !observation.id ||
    observation.status === "cancelled" ||
    observation.status === "entered-in-error" ||
    observationEye !== eye ||
    !refractionDate ||
    !Number.isFinite(refractionMillis) ||
    (!sameEncounter && refractionMillis > measuredAtMillis) ||
    !isEligibleRefractionType(refractionType)
  ) {
    return null;
  }
  const sphericalEquivalentValue = sphericalEquivalent({
    sphere: componentNumber(observation, "SPHERE"),
    cylinder: componentNumber(observation, "CYLINDER"),
  });
  if (sphericalEquivalentValue === undefined) return null;
  return {
    sameEncounter,
    candidate: {
      refractionType,
      sphericalEquivalent: sphericalEquivalentValue,
      status: classifySphericalEquivalent(sphericalEquivalentValue),
      refractionDate,
      observationReference: `Observation/${observation.id}`,
    },
  };
}

function isEligibleRefractionType(value: string | undefined): value is EligibleRefractionType {
  return value === "CYCLOPLEGIC" || value === "MANIFEST";
}

function isOphthalmologyCoding(coding: { system?: string }): boolean {
  return coding.system !== undefined && OPHTHALMOLOGY_CODE_SYSTEMS.has(coding.system);
}

function componentCode(observation: Observation, code: string): string | undefined {
  return component(observation, code)?.valueCodeableConcept?.coding?.find((coding) =>
    isOphthalmologyCoding(coding) && coding.code)?.code;
}

function componentNumber(observation: Observation, code: string): number | undefined {
  const value = component(observation, code)?.valueQuantity?.value;
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function component(observation: Observation, code: string): ObservationComponent | undefined {
  return observation.component?.find((candidate) =>
    candidate.code.coding?.some((coding) =>
      isOphthalmologyCoding(coding) && coding.code === code));
}

function eyeFromObservation(observation: Observation): "OD" | "OS" | null {
  const codes = [
    ...(observation.bodySite?.coding ?? []),
    ...(observation.extension ?? []).flatMap((extension) =>
      extension.valueCodeableConcept?.coding ?? []),
    ...(observation.contained ?? []).flatMap((resource) =>
      resource.resourceType === "BodyStructure"
        ? resource.location?.coding ?? []
        : []),
  ].flatMap((coding) =>
    isOphthalmologyCoding(coding) && coding.code
      ? [coding.code]
      : []);
  return codes.some((code) => code === "OD" || code === "right") ? "OD"
    : codes.some((code) => code === "OS" || code === "left") ? "OS"
      : null;
}
