// MIRROR of osod/mcp/src/fhir/ophthalmology/bodyStructure.ts. Source of truth lives in MCP. Sync manually until v0.5 monorepo refactor. Parity guarded by mcp/tests/builder-mirror-parity.test.ts.
import type {
  BodyStructure,
  CodeableConcept,
  Extension,
  Observation,
  Reference,
  Resource,
} from "@medplum/fhirtypes";
import type { EyeLaterality } from "./types.js";
import { SNOMED_CT_CODE_SYSTEM } from "./codeBindings.js";

export const BODY_SITE_REFERENCE_EXTENSION_URL =
  "http://hl7.org/fhir/StructureDefinition/bodySite";

const EYE_BODY_STRUCTURE: Record<Exclude<EyeLaterality, "UNKNOWN">, {
  locationCode: string;
  locationDisplay: string;
  qualifierCode: string;
  qualifierDisplay: string;
}> = {
  OD: {
    locationCode: "18944008",
    locationDisplay: "Right eye",
    qualifierCode: "24028007",
    qualifierDisplay: "Right",
  },
  OS: {
    locationCode: "8966001",
    locationDisplay: "Left eye",
    qualifierCode: "7771000",
    qualifierDisplay: "Left",
  },
  OU: {
    locationCode: "81745001",
    locationDisplay: "Eye",
    qualifierCode: "51440002",
    qualifierDisplay: "Bilateral",
  },
};

export function buildEyeBodyStructure(
  laterality: Exclude<EyeLaterality, "UNKNOWN">,
  patientReference: string,
): BodyStructure {
  const binding = EYE_BODY_STRUCTURE[laterality];

  return {
    resourceType: "BodyStructure",
    id: eyeBodyStructureId(laterality),
    active: true,
    location: snomedConcept(binding.locationCode, binding.locationDisplay),
    locationQualifier: [snomedConcept(binding.qualifierCode, binding.qualifierDisplay)],
    patient: reference(patientReference),
  };
}

export function attachBodyStructureToObservation(
  observation: Observation,
  bodyStructure: BodyStructure,
): Observation {
  const bodyStructureReference = `#${bodyStructure.id}`;

  return {
    ...observation,
    contained: [bodyStructure, ...(observation.contained ?? [])],
    bodySite: {
      ...(observation.bodySite ?? {}),
      extension: [
        ...(observation.bodySite?.extension ?? []).filter(
          (extension) => extension.url !== BODY_SITE_REFERENCE_EXTENSION_URL,
        ),
        bodyStructureReferenceExtension(bodyStructureReference),
      ],
    },
  };
}

export function rewriteObservationBodyStructureReference(
  observation: Observation,
  originalReference: string,
  bodyStructureReference: string,
): Observation {
  return {
    ...observation,
    bodySite: observation.bodySite
      ? {
          ...observation.bodySite,
          extension: observation.bodySite.extension?.map((extension) =>
            extension.url === BODY_SITE_REFERENCE_EXTENSION_URL &&
            extension.valueReference?.reference === originalReference
              ? bodyStructureReferenceExtension(bodyStructureReference)
              : extension,
          ),
        }
      : observation.bodySite,
  };
}

export function bodyStructureReferenceExtension(bodyStructureReference: string): Extension {
  return {
    url: BODY_SITE_REFERENCE_EXTENSION_URL,
    valueReference: reference(bodyStructureReference),
  };
}

function eyeBodyStructureId(laterality: Exclude<EyeLaterality, "UNKNOWN">): string {
  return `osod-eye-${laterality.toLowerCase()}`;
}

function snomedConcept(code: string, display: string): CodeableConcept {
  return {
    coding: [
      {
        system: SNOMED_CT_CODE_SYSTEM,
        code,
        display,
      },
    ],
    text: display,
  };
}

function reference<T extends Resource = Resource>(value: string): Reference<T> {
  return { reference: value } as Reference<T>;
}
